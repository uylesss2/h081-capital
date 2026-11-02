// One-time mainnet setup after the programs are deployed, then a free smoke test:
//  1. stipend_pool initialize + grow_pool (the pool's Merkle tree and deposit guard; DEPLOYER_KEY must be the
//     program's upgrade authority, the program refuses anyone else; config.authority is read back and checked),
//  2. create_vault for USDG (Token-2022, permissionless), 3. stream_loan initialize (loan registry) and the
//     treasury's USDG account (where fund sends the 0.25% origination fee), only when LOAN_PROGRAM_ID is given;
//     DEPLOYER_KEY must also be stream_loan's upgrade authority (the program checks it). Before signing, the
//     deployed stream_loan is checked like the pool: upgradeable, upgrade authority = DEPLOYER_KEY, executable =
//     LOAN_SO (required on mainnet), and LOAN_SO carries this stipend_pool's id and LOAN_TREASURY.
//     Everything is skipped if already done.
//  4. A real disclose proof is uploaded to a buffer and checked by verify_proof through simulateTransaction
//     (no state change), a tampered copy must fail, then the buffer is closed (rent refunded).
// H081 staking (capacity_stake init_config, safety_pool init_pool) waits for the H081 mint to exist.
// Program ids are never the SDK's LOCALNET_* defaults: the mainnet build has its own id patched in.
//   POOL_PROGRAM_ID   the deployed stipend_pool id, and/or KEYS_DIR holding stipend_pool-keypair.json (both must agree)
//   POOL_SO           the deployed stipend_pool.so; its executable hash must equal the chain's (required on mainnet)
//   LOAN_PROGRAM_ID   optional; without it the loan registry step is skipped
//   LOAN_SO           the deployed stream_loan.so (required on mainnet with LOAN_PROGRAM_ID)
//   LOAN_TREASURY     stream_loan's compiled fee::TREASURY (the treasury Squads vault; required with LOAN_PROGRAM_ID)
//   STEPS             all (default) | loan: only the stream_loan steps (the pool is still checked, read-only;
//                     no initialize, no create_vault, no proof smoke test)
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
import { MAINNET_GENESIS, resolvePoolTarget, resolveProgramTarget } from '../src/solana/deploy-target.js';
import { LOAN_TREASURY, LOCALNET_LOAN_PROGRAM_ID, decodeRegistry, loanInitializeIx, loanTreasuryAccount, registryPda } from '../src/solana/lender.js';
import { createAtaIdempotentIx } from '../src/solana/token.js';
import { LOCALNET_POOL_PROGRAM_ID } from '../src/solana/program.js';

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
const STEPS = process.env.STEPS ?? 'all';
if (!['all', 'loan'].includes(STEPS)) throw new Error('STEPS must be all or loan');
// stream_loan is optional (the first mainnet release shipped stipend_pool only)
const LOAN = process.env.LOAN_PROGRAM_ID ? new PublicKey(process.env.LOAN_PROGRAM_ID) : null;
if (STEPS === 'loan' && !LOAN) throw new Error('STEPS=loan needs LOAN_PROGRAM_ID');
const loanDeployed = !!LOAN && !!(await conn.getAccountInfo(LOAN))?.executable;
if (LOAN && !loanDeployed) throw new Error(`stream_loan ${LOAN.toBase58()} is not deployed on this cluster`);
if (!LOAN) console.log('stream_loan not given (LOAN_PROGRAM_ID): skipping the loan registry');
let treasury: PublicKey | null = null;
if (LOAN) {
  if (!process.env.LOAN_TREASURY) throw new Error("set LOAN_TREASURY to stream_loan's compiled fee::TREASURY (the treasury Squads vault)");
  treasury = new PublicKey(process.env.LOAN_TREASURY);
  if (genesis === MAINNET_GENESIS && treasury.equals(LOAN_TREASURY)) throw new Error('LOAN_TREASURY is the placeholder');
  const loanTarget = await resolveProgramTarget(conn, {
    name: 'stream_loan', programId: LOAN, localnetIds: [LOCALNET_LOAN_PROGRAM_ID], genesis, payer: payer.publicKey,
    expectSo: process.env.LOAN_SO ? readFileSync(process.env.LOAN_SO) : undefined,
    soMustContain: [POOL, treasury], soMustNotContain: genesis === MAINNET_GENESIS ? [LOCALNET_POOL_PROGRAM_ID, LOCALNET_LOAN_PROGRAM_ID] : [],
  });
  console.log(`stream_loan ${LOAN.toBase58()}: upgrade authority ${loanTarget.upgradeAuthority!.toBase58()}, executable ${loanTarget.executableHash}, talks to stipend_pool ${POOL.toBase58()}, fee treasury ${treasury.toBase58()}`);
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
if (STEPS === 'all') {
// one transaction (initialize + grow_pool); a pool left short of full size is finished
await new SolanaPool(conn, POOL).initialize(payer, guard);
const config = decodeConfig((await conn.getAccountInfo(configPda(POOL), 'confirmed'))!.data);
if (!config.authority.equals(guard.authority)) throw new Error(`config.authority is ${config.authority.toBase58()}, expected ${guard.authority.toBase58()}`);
console.log(`pool initialize: done; config.authority ${config.authority.toBase58()} verified on chain`);
await step('USDG vault', vaultPda(POOL, USDG), () => send(conn, payer, [createVaultIx(POOL, payer.publicKey, USDG, TOKEN_2022)]));
}
if (LOAN && treasury) {
  await step('loan registry initialize', registryPda(LOAN), () => send(conn, payer, [loanInitializeIx(payer.publicKey, LOAN)]));
  const reg = decodeRegistry((await conn.getAccountInfo(registryPda(LOAN), 'confirmed'))!.data);
  if (reg.nextLoanRef < 1n) throw new Error('loan registry not initialized');
  console.log(`loan registry: next loan ref ${reg.nextLoanRef}`);
  // fund refuses any loan that owes a fee while the treasury's account for the asset is missing
  const treasuryAta = loanTreasuryAccount(USDG, TOKEN_2022, treasury);
  await step('treasury USDG account (loan origination fee)', treasuryAta, () => send(conn, payer, [createAtaIdempotentIx(payer.publicKey, treasury!, USDG, TOKEN_2022)]));
}
if (STEPS === 'loan') {
  console.log('deployer balance', (await conn.getBalance(payer.publicKey)) / 1e9, 'SOL');
  process.exit(0);
}

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
