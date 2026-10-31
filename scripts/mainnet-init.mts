// One-time mainnet setup after the programs are deployed, then a free smoke test:
//  1. stipend_pool initialize (the pool's Merkle tree), 2. create_vault for USDG (Token-2022),
//  3. stream_loan initialize (loan registry). All permissionless; skipped if already done.
//  4. A real disclose proof is uploaded to a buffer and checked by verify_proof through simulateTransaction
//     (no state change), a tampered copy must fail, then the buffer is closed (rent refunded).
// H081 staking (capacity_stake init_config, safety_pool init_pool) waits for the H081 mint to exist.
// Usage (Windows): DEPLOYER_KEY=C:/Users/Joseph/H081-keys/h081-deployer-upgrade-authority.json npx tsx scripts/mainnet-init.mts
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { allowanceCommitment, initCrypto, randomField, randomKeys } from '../src/crypto.js';
import { MerkleTree } from '../src/merkle.js';
import { LEVELS, discloseInput } from '../src/inputs.js';
import { Prover } from '../src/prover.js';
import {
  LOCALNET_POOL_PROGRAM_ID as POOL, closeBuffer, concatBytes, createVaultIx, encodeFieldVec, encodeProof, fieldOf, initializeIx,
  poolPda, send, simulate, uploadBuffer, vaultPda, verifyProofIx,
} from '../src/solana/index.js';
import { LOCALNET_LOAN_PROGRAM_ID as LOAN, loanInitializeIx, registryPda } from '../src/solana/lender.js';

const RPC = process.env.MAINNET_RPC ?? 'https://api.mainnet-beta.solana.com';
// USDG on Solana (Token-2022, 6 decimals). USDG_MINT may override it ONLY for a local dry run.
const USDG = new PublicKey(process.env.REHEARSE_LOCAL === '1' && process.env.USDG_MINT ? process.env.USDG_MINT : '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const conn = new Connection(RPC, 'confirmed');
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.DEPLOYER_KEY!, 'utf8'))));

if ((await conn.getGenesisHash()) !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' && process.env.REHEARSE_LOCAL !== '1') throw new Error('not mainnet-beta');
for (const [n, id] of [['stipend_pool', POOL], ['stream_loan', LOAN]] as const) {
  if (!(await conn.getAccountInfo(id))?.executable) throw new Error(`${n} ${id.toBase58()} is not deployed`);
}
const step = async (label: string, exists: PublicKey, run: () => Promise<unknown>) => {
  if (await conn.getAccountInfo(exists)) return console.log(`${label}: already done (${exists.toBase58()})`);
  await run();
  console.log(`${label}: done (${exists.toBase58()})`);
};
// Deposit guard: the config authority (default: the deployer) can lower or raise per-asset caps and pause
// deposits; it can never block withdrawals. Caps are in base units (USDG: 6 decimals); start small.
const guard = {
  authority: process.env.CONFIG_AUTHORITY ? new PublicKey(process.env.CONFIG_AUTHORITY) : payer.publicKey,
  maxTotal: BigInt(process.env.MAX_TOTAL_DEPOSITS ?? 10_000_000_000), // 10,000 USDG per asset
  maxPerDeposit: BigInt(process.env.MAX_PER_DEPOSIT ?? 1_000_000_000), // 1,000 USDG
};
console.log(`deposit guard: authority ${guard.authority.toBase58()}, max total ${guard.maxTotal}, max per deposit ${guard.maxPerDeposit}`);
await step('pool initialize', poolPda(POOL), () => send(conn, payer, [initializeIx(POOL, payer.publicKey, guard)]));
await step('USDG vault', vaultPda(POOL, USDG), () => send(conn, payer, [createVaultIx(POOL, payer.publicKey, USDG, TOKEN_2022)]));
const registry = registryPda(LOAN);
await step('loan registry initialize', registry, () => send(conn, payer, [loanInitializeIx(payer.publicKey, LOAN)]));

// Smoke test: real proof checked by the live program, without changing any state.
await initCrypto();
const owner = randomKeys(), agent = randomKeys();
const a = { asset: fieldOf(USDG), remaining: 500n, agentPk: agent.pk, windowId: 0n, windowSpent: 0n, rho: randomField(), pledgePaid: 0n,
  policy: { lifetimeCap: 500n, windowCap: 0n, windowLen: 86400n, maxPerTx: 0n, expiry: 0n, recipientRoot: 0n, ownerPk: owner.pk, streamRate: 0n, streamStart: 0n, lender: 0n, pledgeBps: 0n } };
const t = new MerkleTree(LEVELS);
const idx = t.insert(allowanceCommitment(a));
const d = discloseInput({ root: t.root, allowance: a, path: t.path(idx), kind: 'remainingAtLeast', bound: 400n, audience: 0xa0d170n });
const r = await new Prover().prove('disclose', d.input);
for (const [label, inputs, wantOk] of [['real proof', r.publicSignals, true], ['tampered proof', [...r.publicSignals.slice(0, 2), 999n, ...r.publicSignals.slice(3)], false]] as const) {
  const buf = await uploadBuffer(conn, POOL, payer, concatBytes(encodeProof(r.proof), encodeFieldVec(inputs as bigint[])));
  try {
    const sim = await simulate(conn, payer, [verifyProofIx(POOL, buf.address, 'disclose')]);
    const ok = sim.err === null;
    console.log(`smoke test, ${label}: ${ok ? 'accepted' : 'rejected'} by the live program ${ok === wantOk ? '(as expected)' : '(UNEXPECTED)'}`);
    if (ok !== wantOk) process.exitCode = 1;
  } finally {
    await closeBuffer(conn, POOL, payer, buf.seed);
  }
}
console.log('deployer balance', (await conn.getBalance(payer.publicKey)) / 1e9, 'SOL');

// snarkjs leaves worker threads open; exit explicitly once everything is printed.
process.exit(process.exitCode ?? 0);
