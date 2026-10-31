// After H081 exists: create the capacity-staking config and the safety pool for its mint on mainnet. Both
// init instructions accept ONLY the program's upgrade authority (DEPLOYER_KEY must be it; the programs read
// their ProgramData account). They name a config authority (CONFIG_AUTHORITY, default the deployer) that can
// cap and pause deposits/staking (never withdrawals or unstaking) and is the safety pool's underwriter;
// nothing is insurable until it calls set_underwriting. Idempotent: an existing account is reported as done,
// and its mint, vault, authority and caps are read back and checked either way.
//
// Checked before anything is signed (read-only): each program is deployed with the upgradeable loader, its
// upgrade authority is DEPLOYER_KEY and its executable equals the reviewed .so (CAPACITY_SO / SAFETY_SO,
// required on mainnet); safety_pool's .so carries the stipend_pool id (POOL_PROGRAM_ID, default the mainnet
// E16DK...) and the stream_loan id (LOAN_PROGRAM_ID, required on mainnet), never their localnet ids. On mainnet
// H081_MINT must be the official H081 mint.
// Caps (base units, H081 has 6 decimals; start small):
//   STAKE_MAX_TOTAL / STAKE_MAX_PER     capacity_stake (default 1,000,000 / 100,000 H081)
//   SAFETY_MAX_TOTAL / SAFETY_MAX_PER   safety_pool deposits (default 1,000,000 / 100,000 H081)
// Program ids are given explicitly (the mainnet builds have their own ids patched in; never the LOCALNET_* ones).
// Usage (Windows, Git Bash):
//   H081_MINT=EgqxxR7zowzaLEm24oep5qqBieLVAWYX78LhgeqAJAo CAPACITY_PROGRAM_ID=<id> SAFETY_PROGRAM_ID=<id> LOAN_PROGRAM_ID=<id> \
//   CAPACITY_SO=<capacity_stake.so> SAFETY_SO=<safety_pool.so> CONFIG_AUTHORITY=<pubkey> DEPLOYER_KEY=<deployer.json> \
//   npx tsx scripts/mainnet-init-h081.mts
// REHEARSE_LOCAL=1 (with MAINNET_RPC=<local validator>) allows a non-mainnet RPC and another mint, for the rehearsal.
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { send } from '../src/solana/index.js';
import { MAINNET_GENESIS, resolveProgramTarget } from '../src/solana/deploy-target.js';
import { LOCALNET_POOL_PROGRAM_ID } from '../src/solana/program.js';
import { LOCALNET_LOAN_PROGRAM_ID } from '../src/solana/lender.js';
import {
  LOCALNET_CAPACITY_STAKE_FAST_PROGRAM_ID, LOCALNET_CAPACITY_STAKE_PROGRAM_ID, LOCALNET_SAFETY_POOL_FAST_PROGRAM_ID, LOCALNET_SAFETY_POOL_PROGRAM_ID,
  capacityConfigPda, capacityInitConfigIx, capacityVaultPda, decodeCapacityConfig, decodeSafetyConfig, safetyConfigPda, safetyInitPoolIx, safetyVaultPda,
} from '../src/solana/token.js';

const OFFICIAL_H081 = 'EgqxxR7zowzaLEm24oep5qqBieLVAWYX78LhgeqAJAo';
const MAINNET_POOL = 'E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM';
const RPC = process.env.MAINNET_RPC ?? 'https://api.mainnet-beta.solana.com';
const conn = new Connection(RPC, 'confirmed');
const genesis = await conn.getGenesisHash();
const onMainnet = genesis === MAINNET_GENESIS;
if (!onMainnet && process.env.REHEARSE_LOCAL !== '1') throw new Error('not mainnet-beta');
if (onMainnet && process.env.REHEARSE_LOCAL === '1') throw new Error('REHEARSE_LOCAL=1 on a mainnet RPC: refused');
const programId = (name: string, localnet: PublicKey[]) => {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name} to the deployed program id`);
  const id = new PublicKey(v);
  if (onMainnet && localnet.some((l) => l.equals(id))) throw new Error(`${name} ${v} is a localnet id`);
  return id;
};
const CAPACITY_LOCAL = [LOCALNET_CAPACITY_STAKE_PROGRAM_ID, LOCALNET_CAPACITY_STAKE_FAST_PROGRAM_ID];
const SAFETY_LOCAL = [LOCALNET_SAFETY_POOL_PROGRAM_ID, LOCALNET_SAFETY_POOL_FAST_PROGRAM_ID];
const CAPACITY = programId('CAPACITY_PROGRAM_ID', CAPACITY_LOCAL);
const SAFETY = programId('SAFETY_PROGRAM_ID', SAFETY_LOCAL);
const POOL = new PublicKey(process.env.POOL_PROGRAM_ID ?? MAINNET_POOL);
const LOAN = process.env.LOAN_PROGRAM_ID ? new PublicKey(process.env.LOAN_PROGRAM_ID) : null;
if (onMainnet && !LOAN) throw new Error('mainnet: set LOAN_PROGRAM_ID (the stream_loan id compiled into safety_pool)');
const mint = new PublicKey(process.env.H081_MINT ?? (() => { throw new Error('set H081_MINT to the H081 mint'); })());
if (onMainnet && mint.toBase58() !== OFFICIAL_H081) throw new Error(`mainnet: H081_MINT ${mint.toBase58()} is not the official H081 mint ${OFFICIAL_H081}`);
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.DEPLOYER_KEY!, 'utf8'))));
const soOf = (name: string) => (process.env[name] ? readFileSync(process.env[name]!) : undefined);

const notLocal = onMainnet ? [LOCALNET_POOL_PROGRAM_ID, LOCALNET_LOAN_PROGRAM_ID] : [];
for (const t of [
  { name: 'capacity_stake', programId: CAPACITY, localnetIds: CAPACITY_LOCAL, expectSo: soOf('CAPACITY_SO'), soMustContain: [] as PublicKey[] },
  { name: 'safety_pool', programId: SAFETY, localnetIds: SAFETY_LOCAL, expectSo: soOf('SAFETY_SO'), soMustContain: [POOL, ...(LOAN ? [LOAN] : [])] },
]) {
  const d = await resolveProgramTarget(conn, { ...t, genesis, payer: payer.publicKey, soMustNotContain: notLocal });
  console.log(`${t.name} ${t.programId.toBase58()}: upgrade authority ${d.upgradeAuthority!.toBase58()}, executable ${d.executableHash}`);
}

const info = await conn.getAccountInfo(mint);
if (!info) throw new Error(`mint ${mint.toBase58()} not found`);
const tokenProgram = info.owner;
console.log(`H081 mint ${mint.toBase58()} (token program ${tokenProgram.toBase58()})`);
const authority = process.env.CONFIG_AUTHORITY ? new PublicKey(process.env.CONFIG_AUTHORITY) : payer.publicKey;
const big = (name: string, dflt: bigint) => (process.env[name] ? BigInt(process.env[name]!) : dflt);
const H = 1_000_000n;
const stakeCaps = { authority, maxTotal: big('STAKE_MAX_TOTAL', 1_000_000n * H), maxPerStake: big('STAKE_MAX_PER', 100_000n * H) };
const safetyCaps = { authority, maxTotal: big('SAFETY_MAX_TOTAL', 1_000_000n * H), maxPerDeposit: big('SAFETY_MAX_PER', 100_000n * H) };
console.log(`config authority ${authority.toBase58()}; staking caps ${stakeCaps.maxTotal}/${stakeCaps.maxPerStake}; safety caps ${safetyCaps.maxTotal}/${safetyCaps.maxPerDeposit}`);
for (const [label, account, ixFor] of [
  ['capacity_stake config', capacityConfigPda(CAPACITY, mint), () => capacityInitConfigIx(CAPACITY, payer.publicKey, mint, stakeCaps, tokenProgram)],
  ['safety_pool pool', safetyConfigPda(SAFETY, mint), () => safetyInitPoolIx(SAFETY, payer.publicKey, mint, safetyCaps, tokenProgram)],
] as const) {
  if (await conn.getAccountInfo(account)) { console.log(`${label}: already done (${account.toBase58()})`); continue; }
  try {
    const r = await send(conn, payer, [ixFor()]);
    console.log(`${label}: done (${account.toBase58()}, tx ${r.signature}, ${r.computeUnits} CU)`);
  } catch (e) {
    console.log(`${label}: FAILED ${String((e as Error).message ?? e).slice(0, 300)}`);
    process.exitCode = 1;
  }
}
// read back what is on chain (also on a re-run): mint, vault, config authority, caps, not paused
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}: ${detail}`);
  if (!ok) process.exitCode = 1;
};
const capAcc = await conn.getAccountInfo(capacityConfigPda(CAPACITY, mint), 'confirmed');
if (capAcc) {
  const c = decodeCapacityConfig(capAcc.data);
  check('capacity_stake config', c.mint.equals(mint) && c.vault.equals(capacityVaultPda(CAPACITY, mint)) && c.authority.equals(authority)
    && c.maxTotal === stakeCaps.maxTotal && c.maxPerStake === stakeCaps.maxPerStake && !c.stakingPaused,
  `authority ${c.authority.toBase58()}, caps ${c.maxTotal}/${c.maxPerStake}, paused ${c.stakingPaused}, vault ${c.vault.toBase58()}`);
} else check('capacity_stake config', false, 'missing');
const safAcc = await conn.getAccountInfo(safetyConfigPda(SAFETY, mint), 'confirmed');
if (safAcc) {
  const c = decodeSafetyConfig(safAcc.data);
  check('safety_pool config', c.mint.equals(mint) && c.vault.equals(safetyVaultPda(SAFETY, mint)) && c.authority.equals(authority)
    && c.maxTotal === safetyCaps.maxTotal && c.maxPerDeposit === safetyCaps.maxPerDeposit && !c.depositsPaused,
  `authority ${c.authority.toBase58()}, caps ${c.maxTotal}/${c.maxPerDeposit}, paused ${c.depositsPaused}, insurable asset ${c.loanAsset.toBase58()}, vault ${c.vault.toBase58()}`);
} else check('safety_pool config', false, 'missing');
console.log('deployer balance', (await conn.getBalance(payer.publicKey)) / 1e9, 'SOL');
// web3.js keeps a socket open; give it a moment, then exit.
await new Promise((r) => setTimeout(r, 200));
process.exit(process.exitCode ?? 0);
