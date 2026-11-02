#!/usr/bin/env node
// Derives every address the DefiLlama adapters rely on from the documented program ids and mints
// (docs/MAINNET-RUNBOOK.md) and checks each one against mainnet with read-only JSON-RPC.
//
// Nothing is signed or sent. Needs @solana/web3.js, resolved from the repo's node_modules (or from
// WEB3_DIR, e.g. a DefiLlama-Adapters clone). Run from the repo root:
//   node integrations/defillama/scripts/derive-addresses.mjs
// Env: SOLANA_RPC (default https://api.mainnet-beta.solana.com)

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const candidates = [process.env.WEB3_DIR, repoRoot].filter(Boolean).map((d) => path.join(d, 'package.json'));
let PublicKey;
for (const c of candidates) {
  try { ({ PublicKey } = createRequire(c)('@solana/web3.js')); break; } catch { /* next */ }
}
if (!PublicKey) { console.error('cannot resolve @solana/web3.js; run npm install or set WEB3_DIR'); process.exit(2); }

// docs/MAINNET-RUNBOOK.md, section 0 and P0
export const ADDR = {
  STIPEND_POOL: 'E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM',
  STREAM_LOAN: '8JBd7epQXxdcKRMaWM1S5PC7nsQKoZq3uCetpiJ684g4',
  SAFETY_POOL: 'HmzKNPn8LaRyjmggt2uT95B7KvphtoVXQkeVc2HHARTt',
  CAPACITY_STAKE: 'CH1rrfFyJMVn158UHL2fLpKTtoLJojrz5f68toMQdQKU',
  USDG: '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH',
  H081: 'EgqxxR7zowzaLEm24oep5qqBieLVAWYX78LhgeqAJAo',
  TREASURY: 'EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq',
  TOKEN_PROGRAM: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  TOKEN_2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ATA_PROGRAM: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
};

// expected values (checked by hand with curl JSON-RPC on 2026-11-02, see VERIFY.md)
const EXPECT = {
  vaultAuthority: '9JnWo2rJ1MpB14NKNSEXCV2iMtMim6oUpHpgJFSVb2B7',
  usdgVault: 'FaRG7DV8e7XF3RyoZrBb3h1oLiFFWFFCuYDSXsDoyyzG',
  capacityConfig: '7QuqMc95ry9sjeem5gsS4SNQzoQfoHqVwSvAcSFq8uKS',
  safetyConfig: '91QLL95oPgJF8yjWeKb41yMs5Z48UPd9mTXMH7xppoQA',
  loanRegistry: '5MMWdQWZB3JWTCZXZsEGSLWegi9bk9iSitT9avdLo4Kt',
  treasuryUsdg: 'DxpmCZYAoDKpHmA5vWuopUrf3UVuGnPvditVrN9xDwDo',
};

const pk = (s) => new PublicKey(s);
const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds, pk(program))[0].toBase58();
const utf8 = (s) => Buffer.from(s, 'utf8');

export const derived = {
  // stipend_pool: ["vault_auth"] owns every vault and "owed" escrow; ["vault", mint] is the per-mint vault
  vaultAuthority: pda([utf8('vault_auth')], ADDR.STIPEND_POOL),
  usdgVault: pda([utf8('vault'), pk(ADDR.USDG).toBuffer()], ADDR.STIPEND_POOL),
  // capacity_stake: ["config", mint] (vault authority) and ["vault", mint]
  capacityConfig: pda([utf8('config'), pk(ADDR.H081).toBuffer()], ADDR.CAPACITY_STAKE),
  capacityVault: pda([utf8('vault'), pk(ADDR.H081).toBuffer()], ADDR.CAPACITY_STAKE),
  // safety_pool: ["safety", mint] (vault authority) and ["vault", mint]
  safetyConfig: pda([utf8('safety'), pk(ADDR.H081).toBuffer()], ADDR.SAFETY_POOL),
  safetyVault: pda([utf8('vault'), pk(ADDR.H081).toBuffer()], ADDR.SAFETY_POOL),
  // stream_loan: ["registry"]
  loanRegistry: pda([utf8('registry')], ADDR.STREAM_LOAN),
  // treasury's USDG associated token account (Token-2022)
  treasuryUsdg: pda([pk(ADDR.TREASURY).toBuffer(), pk(ADDR.TOKEN_2022).toBuffer(), pk(ADDR.USDG).toBuffer()], ADDR.ATA_PROGRAM),
};

const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function tokenAccountInfo(address) {
  const res = await rpc('getAccountInfo', [address, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const v = res?.value;
  if (!v) return { exists: false };
  const info = v.data?.parsed?.info;
  if (!info?.tokenAmount) return { exists: true, owner: v.owner, note: 'not a token account' };
  return { exists: true, program: v.owner, owner: info.owner, mint: info.mint, amount: info.tokenAmount.uiAmountString, slot: res.context.slot };
}

async function main() {
  let failed = 0;
  console.log(`RPC ${RPC}`);
  for (const [k, v] of Object.entries(derived)) {
    const exp = EXPECT[k];
    const ok = exp ? (exp === v ? 'OK' : `MISMATCH expected ${exp}`) : '';
    if (exp && exp !== v) failed++;
    console.log(`${k.padEnd(16)} ${v} ${ok}`);
  }
  console.log('');
  const checks = [
    ['usdgVault', derived.usdgVault, derived.vaultAuthority, ADDR.USDG],
    ['capacityVault', derived.capacityVault, derived.capacityConfig, ADDR.H081],
    ['safetyVault', derived.safetyVault, derived.safetyConfig, ADDR.H081],
    ['treasuryUsdg', derived.treasuryUsdg, ADDR.TREASURY, ADDR.USDG],
  ];
  for (const [name, addr, expOwner, expMint] of checks) {
    const i = await tokenAccountInfo(addr);
    const ok = i.exists && i.owner === expOwner && i.mint === expMint;
    if (!ok) failed++;
    console.log(`${name.padEnd(16)} ${addr} exists=${i.exists} owner=${i.owner ?? '-'} mint=${i.mint ?? '-'} amount=${i.amount ?? '-'} slot=${i.slot ?? '-'} ${ok ? 'OK' : 'FAIL'}`);
  }
  // every token account owned by vault_auth (what the TVL adapter's `owners` path sums)
  for (const program of [ADDR.TOKEN_PROGRAM, ADDR.TOKEN_2022]) {
    const res = await rpc('getTokenAccountsByOwner', [derived.vaultAuthority, { programId: program }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    for (const a of res.value) {
      const info = a.account.data.parsed.info;
      console.log(`vault_auth owns   ${a.pubkey} mint=${info.mint} amount=${info.tokenAmount.uiAmountString} (${program === ADDR.TOKEN_2022 ? 'Token-2022' : 'Token'})`);
    }
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
