// After H081 exists on the launchpad: create the capacity-staking config and the safety pool for its mint on
// mainnet (both permissionless, no admin). Idempotent: an existing account is reported as already done.
// Program ids are given explicitly (the mainnet builds have their own ids patched in; never the LOCALNET_* ones).
// Usage (Windows): H081_MINT=<mint> CAPACITY_PROGRAM_ID=<id> SAFETY_PROGRAM_ID=<id> DEPLOYER_KEY=<deployer.json> npx tsx scripts/mainnet-init-h081.mts
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { send } from '../src/solana/index.js';
import { MAINNET_GENESIS } from '../src/solana/deploy-target.js';
import {
  LOCALNET_CAPACITY_STAKE_PROGRAM_ID, LOCALNET_SAFETY_POOL_PROGRAM_ID, capacityConfigPda, capacityInitConfigIx, safetyConfigPda, safetyInitPoolIx,
} from '../src/solana/token.js';

const RPC = process.env.MAINNET_RPC ?? 'https://api.mainnet-beta.solana.com';
const conn = new Connection(RPC, 'confirmed');
const genesis = await conn.getGenesisHash();
if (genesis !== MAINNET_GENESIS && process.env.REHEARSE_LOCAL !== '1') throw new Error('not mainnet-beta');
const programId = (name: string, localnet: PublicKey) => {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name} to the deployed program id`);
  const id = new PublicKey(v);
  if (genesis === MAINNET_GENESIS && id.equals(localnet)) throw new Error(`${name} ${v} is the localnet id`);
  return id;
};
const CAPACITY = programId('CAPACITY_PROGRAM_ID', LOCALNET_CAPACITY_STAKE_PROGRAM_ID);
const SAFETY = programId('SAFETY_PROGRAM_ID', LOCALNET_SAFETY_POOL_PROGRAM_ID);
for (const [n, id] of [['capacity_stake', CAPACITY], ['safety_pool', SAFETY]] as const) {
  if (!(await conn.getAccountInfo(id))?.executable) throw new Error(`${n} ${id.toBase58()} is not deployed`);
}
const mint = new PublicKey(process.env.H081_MINT ?? (() => { throw new Error('set H081_MINT to the coin address from the launchpad'); })());
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.DEPLOYER_KEY!, 'utf8'))));
const info = await conn.getAccountInfo(mint);
if (!info) throw new Error(`mint ${mint.toBase58()} not found`);
const tokenProgram = info.owner;
console.log(`H081 mint ${mint.toBase58()} (token program ${tokenProgram.toBase58()})`);
for (const [label, account, ixFor] of [
  ['capacity_stake config', capacityConfigPda(CAPACITY, mint), () => capacityInitConfigIx(CAPACITY, payer.publicKey, mint, tokenProgram)],
  ['safety_pool pool', safetyConfigPda(SAFETY, mint), () => safetyInitPoolIx(SAFETY, payer.publicKey, mint, tokenProgram)],
] as const) {
  if (await conn.getAccountInfo(account)) { console.log(`${label}: already done (${account.toBase58()})`); continue; }
  try {
    const r = await send(conn, payer, [ixFor()]);
    console.log(`${label}: done (${account.toBase58()}, tx ${r.signature})`);
  } catch (e) {
    console.log(`${label}: FAILED ${String((e as Error).message ?? e).slice(0, 300)}`);
    process.exitCode = 1;
  }
}
// snarkjs-free script, but web3.js keeps a socket open; give it a moment, then exit.
await new Promise((r) => setTimeout(r, 200));
process.exit(process.exitCode ?? 0);
