// After H081 exists on the launchpad: create the capacity-staking config and the safety pool for its mint on
// mainnet (both permissionless, no admin). Idempotent: an existing account is reported as already done.
// Usage (Windows): H081_MINT=<mint> DEPLOYER_KEY=C:/Users/Joseph/H081-keys/h081-deployer-upgrade-authority.json npx tsx scripts/mainnet-init-h081.mts
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { send } from '../src/solana/index.js';
import {
  LOCALNET_CAPACITY_STAKE_PROGRAM_ID as CAPACITY, LOCALNET_SAFETY_POOL_PROGRAM_ID as SAFETY, capacityConfigPda, capacityInitConfigIx, safetyConfigPda, safetyInitPoolIx,
} from '../src/solana/token.js';

const RPC = process.env.MAINNET_RPC ?? 'https://api.mainnet-beta.solana.com';
const conn = new Connection(RPC, 'confirmed');
if ((await conn.getGenesisHash()) !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' && process.env.REHEARSE_LOCAL !== '1') throw new Error('not mainnet-beta');
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
