// One-off: pay one real call on each remaining x402 route (prove-disclose, preflight, relay-priority) so the CDP
// Bazaar indexes them. Uses a fresh shielded account funded from the deployer (secret saved before anything is sent).
//
//   node node_modules/tsx/dist/cli.mjs scripts/x402-bazaar-list.mts            (dry run: reads only)
//   node node_modules/tsx/dist/cli.mjs scripts/x402-bazaar-list.mts --send     (real mainnet transactions + payments)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentRequired } from '@x402/core/types';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { Account } from '../src/client.js';
import { initCrypto, randomKeys } from '../src/crypto.js';
import { RelayerClient, type SolanaRelayBody } from '../src/relayer-client.js';
import { SolanaPool, SolanaWallet } from '../src/solana/index.js';

const SEND = process.argv.includes('--send');
// the site's configured RPC (full pool history); publicnode returns only part of it and the tree stalls
const RPC = process.env.RPC ?? JSON.parse(readFileSync(resolve(import.meta.dirname, '../../stipend-site/src/data/protocol.json'), 'utf8')).rpc;
const RELAYER = 'https://api.h081.xyz';
const POOL = new PublicKey('E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM');
const USDG = new PublicKey('2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH');
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEPOSIT = 600_000n, GRANT = 100_000n, WITHDRAW = 500_000n;
const root = resolve(import.meta.dirname, '..');
const KEY = resolve(root, 'solana/keys/mainnet/deployer-keypair.json');
const ACCOUNT_FILE = resolve(root, 'solana/keys/mainnet/x402-list-account.json');
const OUT = resolve(root, 'solana/target-so/x402-bazaar-list.json');

const keyBytes = Uint8Array.from(JSON.parse(readFileSync(KEY, 'utf8')));
const signer = Keypair.fromSecretKey(keyBytes);
const conn = new Connection(RPC, 'confirmed');
const http = new x402HTTPClient(new x402Client().register('solana:*', new ExactSvmScheme(await createKeyPairSignerFromBytes(keyBytes), { rpcUrl: RPC })));
const record: Record<string, unknown> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const save = () => writeFileSync(OUT, JSON.stringify(record, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
const sol = async () => (await conn.getBalance(signer.publicKey)) / 1e9;

/** One paid x402 call: 402 -> sign USDC payment -> retry. Returns the parsed body; throws on a non-2xx. */
async function paid(path: string, method: 'GET' | 'POST', body?: unknown): Promise<any> {
  const url = RELAYER + path;
  const init = () => ({ method, headers: body !== undefined ? { 'content-type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  const first = await fetch(url, init());
  if (first.status !== 402) throw new Error(`${path}: expected 402, got ${first.status} ${await first.text()}`);
  const req: PaymentRequired = http.getPaymentRequiredResponse((n) => first.headers.get(n), await first.json().catch(() => undefined));
  const chosen = req.accepts.find((a) => a.asset === USDC);
  if (!chosen) throw new Error(`${path}: no USDC requirement`);
  const header = http.encodePaymentSignatureHeader(await http.createPaymentPayload({ ...req, accepts: [chosen] }));
  const res = await fetch(url, { ...init(), headers: { ...(init().headers ?? {}), ...header } });
  const text = await res.text();
  const settle = res.headers.get('PAYMENT-RESPONSE') ? http.getPaymentSettleResponse((n) => res.headers.get(n)) : undefined;
  console.log(`${path}: HTTP ${res.status}, price ${chosen.amount}, settlement ${settle?.success} ${settle?.transaction ?? ''}`);
  const json = (() => { try { return JSON.parse(text); } catch { return text; } })();
  if (!res.ok) throw new Error(`${path}: ${text.slice(0, 1500)}`);
  return { body: json, settlement: settle?.transaction };
}

await initCrypto();
let sk: bigint;
if (existsSync(ACCOUNT_FILE)) sk = BigInt(JSON.parse(readFileSync(ACCOUNT_FILE, 'utf8')).sk);
else {
  sk = randomKeys().sk;
  if (SEND) writeFileSync(ACCOUNT_FILE, JSON.stringify({ note: 'x402 Bazaar listing run: shielded account secret; delete once empty', program: POOL.toBase58(), sk: sk.toString() }) + '\n', { mode: 0o600 });
}
const account = new Account(sk);
const wallet = new SolanaWallet(account, new SolanaPool(conn, POOL), signer);
await wallet.sync();
console.log(`deployer ${signer.publicKey.toBase58()}: ${await sol()} SOL; shielded ${wallet.balance(USDG)}; allowances ${wallet.agentAllowances(USDG).length}`);
const catalog: any = await (await fetch(`${RELAYER}/v1/x402/catalog`)).json();
console.log('catalog enabled', catalog.enabled, catalog.services.map((s: any) => `${s.id}=${s.enabled}`).join(' '));
// prove-disclose is settle-first: prove the statement locally (free) so a false one is never paid for
async function checkDisclose() {
  const o = wallet.agentAllowances(USDG)[0];
  if (!o) return console.log('local disclose check: no allowance yet');
  const bound = o.allowance.policy.lifetimeCap - o.allowance.remaining;
  await wallet.prove(o, 'spentAtMost', bound, 1n);
  console.log(`local disclose check: spentAtMost ${bound} proves (remaining ${o.allowance.remaining}, cap ${o.allowance.policy.lifetimeCap})`);
}
if (!record.proveDisclose) await checkDisclose();
if (!SEND) { console.log('dry run: nothing sent'); process.exit(0); }

// 1. deposit
// later runs: only what is still unpaid; with just prove-disclose left, fund only the allowance
const need = record.relayPriority ? GRANT : DEPOSIT;
if (!record.proveDisclose && wallet.balance(USDG) < need && wallet.agentAllowances(USDG).length === 0) {
  const r = await wallet.deposit(USDG, need);
  record[record.deposit ? 'deposit2' : 'deposit'] = r.tx.signature; save();
  console.log(`deposit ${need}: ${r.tx.signature}; SOL now ${await sol()}`);
}
// 2. grant an allowance to ourselves
if (!record.proveDisclose && wallet.agentAllowances(USDG).length === 0) {
  const r = await wallet.grant(USDG, [{ to: account.address, amount: GRANT }]);
  record[record.grant ? 'grant2' : 'grant'] = r.tx.signature; save();
  console.log(`grant ${GRANT}: ${r.tx.signature}; SOL now ${await sol()}`);
}
// 3. prove-disclose
if (!record.proveDisclose) {
  await wallet.sync();
  const owned = wallet.agentAllowances(USDG)[0];
  if (!owned) throw new Error('no allowance found after grant');
  const a = owned.allowance, path = wallet.tree.path(owned.index);
  const s = (x: bigint) => x.toString();
  const body = {
    root: s(wallet.tree.root), kind: 'spentAtMost', bound: s(a.policy.lifetimeCap - a.remaining), audience: '1', // bound = what it has spent: true by construction
    allowance: {
      asset: s(a.asset), remaining: s(a.remaining), agentPk: s(a.agentPk), windowId: s(a.windowId), windowSpent: s(a.windowSpent), rho: s(a.rho), pledgePaid: s(a.pledgePaid),
      policy: Object.fromEntries(Object.entries(a.policy).map(([k, v]) => [k, s(v as bigint)])),
    },
    path: { pathIndices: path.pathIndices.map(Number), pathElements: path.pathElements.map(s) },
  };
  try {
    const r = await paid('/v1/x402/prove/disclose', 'POST', body);
    record.proveDisclose = { settlement: r.settlement, publicSignals: r.body.publicSignals }; save();
  } catch (e) {
    if (!String(e).includes('service_disabled')) throw e;
    console.log('prove-disclose is off on the relayer (no circuit artifacts); skipped, nothing charged');
  }
}
// 4 + 5. preflight then relay-priority on a real withdrawal
if (!record.relayPriority) {
  const real = new RelayerClient(RELAYER);
  const terms = await real.solanaTerms(USDG.toBase58());
  const fee = terms.fee > (WITHDRAW * 20n + 9999n) / 10000n ? terms.fee : (WITHDRAW * 20n + 9999n) / 10000n;
  const via = Object.create(real) as RelayerClient;
  via.relaySolana = async (b: SolanaRelayBody) => {
    if (!record.preflight) {
      const p = await paid('/v1/x402/solana/preflight', 'POST', b);
      record.preflight = { settlement: p.settlement, ok: p.body.ok, refusals: p.body.refusals }; save();
      if (!p.body.ok) throw new Error(`preflight refused: ${JSON.stringify(p.body.refusals)}`);
    }
    const r = await paid('/v1/x402/solana/relay-priority', 'POST', b);
    record.relayPriority = { settlement: r.settlement, signature: r.body.signature }; save();
    return r.body;
  };
  await wallet.withdraw(USDG, WITHDRAW, signer.publicKey, { via, relayer: new PublicKey(terms.relayer), feeRecipient: new PublicKey(terms.feeRecipient), fee });
  console.log(`withdraw ${WITHDRAW} (fee ${fee}) relayed: ${(record.relayPriority as any).signature}; SOL now ${await sol()}`);
}
// 6. cleanup: reclaim the allowance, withdraw what is left directly
await wallet.sync();
for (const owned of wallet.agentAllowances(USDG).filter((o) => o.allowance.remaining > 0n)) {
  const r = await wallet.reclaim(owned);
  record.reclaim = r.tx.signature; save();
  console.log(`reclaim: ${r.tx.signature}`);
}
const left = wallet.balance(USDG);
if (left > 0n) {
  const r = await wallet.withdraw(USDG, left, signer.publicKey);
  record.finalWithdraw = r.tx.signature; save();
  console.log(`final withdraw ${left}: ${r.tx.signature}`);
}
console.log(`done; shielded ${wallet.balance(USDG)}; SOL ${await sol()}`);
