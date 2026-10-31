// One-time mainnet setup after the programs are deployed, then a free smoke test:
//  1. stipend_pool initialize + grow_pool (the pool's Merkle tree and deposit guard; DEPLOYER_KEY must be the
//     program's upgrade authority, the program refuses anyone else; config.authority is read back and checked),
//  2. create_vault for USDG (Token-2022), 3. stream_loan initialize (loan registry), only when stream_loan is
//     deployed. Steps 2-3 are permissionless. Everything is skipped if already done.
//  4. A real disclose proof is uploaded to a buffer and checked by verify_proof through simulateTransaction
//     (no state change), a tampered copy must fail, then the buffer is closed (rent refunded).
// H081 staking (capacity_stake init_config, safety_pool init_pool) waits for the H081 mint to exist.
// Program ids are never the SDK's LOCALNET_* defaults: the mainnet build has its own id patched in.
//   POOL_PROGRAM_ID   the deployed stipend_pool id, and/or KEYS_DIR holding stipend_pool-keypair.json (both must agree)
//   POOL_SO           the deployed stipend_pool.so; its executable hash must equal the chain's (required on mainnet)
//   LOAN_PROGRAM_ID   optional; without it the loan registry step is skipped
// Usage (Windows, Git Bash):
//   DEPLOYER_KEY=solana/keys/mainnet/deployer-keypair.json KEYS_DIR=solana/keys/mainnet \
//   POOL_SO=../h081-deploy-staging/so-mainnet/stipend_pool.so CONFIG_AUTHORITY=<pubkey> npx tsx scripts/mainnet-init.mts
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { allowanceCommitment, initCrypto, randomField, randomKeys } from '../src/crypto.js';
import { MerkleTree } from '../src/merkle.js';
import { LEVELS, discloseInput } from '../src/inputs.js';
import { Prover } from '../src/prover.js';
import {
  SolanaPool, closeBuffer, concatBytes, configPda, createVaultIx, decodeConfig, encodeFieldVec, encodeProof, fieldOf,
  send, simulate, uploadBuffer, vaultPda, verifyProofIx,
} from '../src/solana/index.js';
import { MAINNET_GENESIS, resolvePoolTarget } from '../src/solana/deploy-target.js';
import { loanInitializeIx, registryPda } from '../src/solana/lender.js';

const RPC = process.env.MAINNET_RPC ?? 'https://api.mainnet-beta.solana.com';
// USDG on Solana (Token-2022, 6 decimals). USDG_MINT may override it ONLY for a local dry run.
const USDG = new PublicKey(process.env.REHEARSE_LOCAL === '1' && process.env.USDG_MINT ? process.env.USDG_MINT : '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const conn = new Connection(RPC, 'confirmed');
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.DEPLOYER_KEY!, 'utf8'))));

const genesis = await conn.getGenesisHash();
if (genesis !== MAINNET_GENESIS && process.env.REHEARSE_LOCAL !== '1') throw new Error('not mainnet-beta');
// The deployed stipend_pool, checked before anything is signed: id given explicitly (never the localnet one on
// mainnet), upgradeable loader, upgrade authority = DEPLOYER_KEY, executable = POOL_SO.
const target = await resolvePoolTarget(conn, {
  programId: process.env.POOL_PROGRAM_ID, keysDir: process.env.KEYS_DIR, genesis, payer: payer.publicKey,
  expectSo: process.env.POOL_SO ? readFileSync(process.env.POOL_SO) : undefined,
});
const POOL = target.programId;
console.log(`stipend_pool ${POOL.toBase58()}: upgrade authority ${target.upgradeAuthority!.toBase58()}, executable ${target.executableHash}`);
// stream_loan is optional (the first mainnet release ships stipend_pool only; loans come later)
const LOAN = process.env.LOAN_PROGRAM_ID ? new PublicKey(process.env.LOAN_PROGRAM_ID) : null;
const loanDeployed = !!LOAN && !!(await conn.getAccountInfo(LOAN))?.executable;
if (!loanDeployed) console.log(`stream_loan ${LOAN ? `${LOAN.toBase58()} is not deployed` : 'not given (LOAN_PROGRAM_ID)'}: skipping the loan registry`);
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
// one transaction (initialize + grow_pool); a pool left short of full size is finished
await new SolanaPool(conn, POOL).initialize(payer, guard);
const config = decodeConfig((await conn.getAccountInfo(configPda(POOL), 'confirmed'))!.data);
if (!config.authority.equals(guard.authority)) throw new Error(`config.authority is ${config.authority.toBase58()}, expected ${guard.authority.toBase58()}`);
console.log(`pool initialize: done; config.authority ${config.authority.toBase58()} verified on chain`);
await step('USDG vault', vaultPda(POOL, USDG), () => send(conn, payer, [createVaultIx(POOL, payer.publicKey, USDG, TOKEN_2022)]));
if (LOAN && loanDeployed) await step('loan registry initialize', registryPda(LOAN), () => send(conn, payer, [loanInitializeIx(payer.publicKey, LOAN)]));

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
