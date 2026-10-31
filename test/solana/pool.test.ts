// stipend_pool foundation on a local solana-test-validator (WSL, rpc 127.0.0.1:8999):
//  (a) real snarkjs proofs (spend, disclose, stream) verify ON CHAIN through the program; tampered ones fail;
//  (b) on-chain Merkle roots after N inserts equal src/merkle.ts roots;
//  (c) compute units per verify and per insert are checked against budgets and written to
//      solana/target-so/compute-units.json (gitignored output, not a tracked file).
// Run with `npm run test:solana` (restarts the private validator, then runs this suite).
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { Allowance, Policy, SpendingKey, allowanceCommitment, initCrypto, lenderKey, randomField, randomKeys } from '../../src/crypto.js';
import { MerkleTree } from '../../src/merkle.js';
import { LOCALNET_CONFIG_AUTHORITY, LOCALNET_UPGRADE_AUTHORITY } from './config-authority.js';
import { LEVELS, SPEND_PUBLIC, discloseInput, spendInput, streamInput } from '../../src/inputs.js';
import { Prover, type ProofResult } from '../../src/prover.js';
import {
  BUFFER_HEADER, LEVELS as POOL_LEVELS, POOL_INIT_LEN, POOL_SIZE, ROOT_HISTORY, SolanaPool, be32, growPoolIx, initializePoolIxs, isPoolComplete, LOCALNET_POOL_PROGRAM_ID, LOCALNET_PROBE_PROGRAM_ID, POOL_ERROR, bufferPda, bufferWriteIx, closeBuffer, concatBytes, customErrorCode,
  decodePool, encodeDiscloseArgs, encodeFieldVec, encodeProof, encodeStreamArgs, fieldOf, initializeIx, poolPda, probeInsertIx, send, simulate,
  uploadBuffer, verifyDisclosureIx, verifyProofIx, verifyStreamIx, type CircuitId, type DiscloseArgs, type StreamArgs,
} from '../../src/solana/index.js';

const RPC = process.env.SOLANA_RPC ?? 'http://127.0.0.1:8999';
const POOL = LOCALNET_POOL_PROGRAM_ID;
const PROBE = LOCALNET_PROBE_PROGRAM_ID;
const CU = 1_400_000;
const DAY = 86400n;

const connection = new Connection(RPC, 'confirmed');
const prover = new Prover();
const payer = Keypair.generate();
const cu: Record<string, number> = {};
let owner: SpendingKey;
let agent: SpendingKey;

function policy(over: Partial<Policy> = {}): Policy {
  return { lifetimeCap: 0n, windowCap: 0n, windowLen: DAY, maxPerTx: 0n, expiry: 0n, recipientRoot: 0n, ownerPk: owner.pk, streamRate: 0n, streamStart: 0n, lender: 0n, pledgeBps: 0n, ...over };
}
function fresh(asset: bigint, amount: bigint, over: Partial<Policy> = {}): Allowance {
  return { asset, remaining: amount, agentPk: agent.pk, policy: policy({ lifetimeCap: amount, ...over }), windowId: 0n, windowSpent: 0n, rho: randomField(), pledgePaid: 0n };
}

async function expectCode(p: Promise<unknown>, code: number) {
  let caught: unknown;
  try { await p; } catch (e) { caught = e; }
  expect(caught, 'transaction should fail').toBeDefined();
  expect(customErrorCode(caught)).toBe(code);
}

/** Uploads (proof, payload) to a fresh buffer, runs `mk(buffer)`, closes the buffer; returns units. */
async function viaBuffer(programId: PublicKey, payload: Uint8Array, mk: (buf: PublicKey) => TransactionInstruction): Promise<number> {
  const buf = await uploadBuffer(connection, programId, payer, payload);
  try {
    return (await send(connection, payer, [mk(buf.address)], { cuLimit: CU })).computeUnits;
  } finally {
    await closeBuffer(connection, programId, payer, buf.seed);
  }
}

const proofPayload = (r: ProofResult, inputs: bigint[] = r.publicSignals) => concatBytes(encodeProof(r.proof), encodeFieldVec(inputs));
const verifyGeneric = (r: ProofResult, circuit: CircuitId, inputs?: bigint[]) => viaBuffer(POOL, proofPayload(r, inputs), (b) => verifyProofIx(POOL, b, circuit));

async function readPool(programId: PublicKey) {
  const info = await connection.getAccountInfo(poolPda(programId), 'confirmed');
  if (!info) throw new Error('pool not initialized');
  return decodePool(info.data);
}

beforeAll(async () => {
  await initCrypto();
  owner = randomKeys();
  agent = randomKeys();
  try {
    await connection.getVersion();
  } catch {
    throw new Error(`no validator at ${RPC}; run: node scripts/solana-localnet.mjs start`);
  }
  for (const id of [POOL, PROBE]) {
    const acc = await connection.getAccountInfo(id);
    if (!acc?.executable) throw new Error(`program ${id.toBase58()} is not loaded; run npm run solana:build and restart the validator`);
  }
  const sig = await connection.requestAirdrop(payer.publicKey, 100 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature: sig, ...(await connection.getLatestBlockhash()) }, 'confirmed');
});

describe('initialize', () => {
  const auth = LOCALNET_UPGRADE_AUTHORITY;
  const guard = { authority: LOCALNET_CONFIG_AUTHORITY.publicKey };
  let empty: MerkleTree;
  const expectEmpty = async (id: PublicKey) => {
    empty ??= new MerkleTree(LEVELS);
    const s = await readPool(id);
    expect(s.nextIndex).toBe(0);
    expect(s.currentRootIndex).toBe(0);
    expect(s.lastRoot).toBe(empty.root);
    expect(s.filledSubtrees).toEqual(empty.zeros.slice(0, LEVELS));
    expect(s.roots.filter((r) => r !== 0n)).toEqual([empty.root]);
  };
  let someone: Keypair;
  beforeAll(async () => {
    someone = Keypair.generate();
    for (const k of [auth.publicKey, someone.publicKey]) {
      await connection.confirmTransaction(await connection.requestAirdrop(k, 2 * LAMPORTS_PER_SOL), 'confirmed');
    }
  });

  it('only the upgrade authority can initialize (the probe pool is fresh: only this suite uses it)', async () => {
    expect(await connection.getAccountInfo(poolPda(PROBE))).toBeNull();
    await expectCode(send(connection, someone, initializePoolIxs(PROBE, someone.publicKey, guard), { cuLimit: CU }), POOL_ERROR.UpgradeAuthority);
    await expectCode(send(connection, someone, [initializeIx(PROBE, someone.publicKey, guard)]), POOL_ERROR.UpgradeAuthority);
    expect(await connection.getAccountInfo(poolPda(PROBE))).toBeNull();
  });

  it('initialize + grow_pool fit in one transaction (simulated on the fresh probe pool)', async () => {
    const ixs = initializePoolIxs(PROBE, auth.publicKey, guard);
    expect(ixs).toHaveLength(4); // initialize + 3 x grow_pool: 10,240 -> 20,480 -> 30,720 -> 33,424
    expect(POOL_SIZE).toBe(33_424);
    const sim = await simulate(connection, auth, ixs);
    expect(sim.err, sim.logs.join(' | ')).toBeNull();
    cu.initialize_and_grow_tx = sim.computeUnits;
  });

  it('a half-grown pool loads nowhere until grow_pool completes it; the SDK finishes it', async () => {
    await send(connection, auth, [initializeIx(PROBE, auth.publicKey, guard)]);
    const created = await connection.getAccountInfo(poolPda(PROBE), 'confirmed');
    expect(created!.owner.equals(PROBE)).toBe(true);
    expect(created!.data.length).toBe(POOL_INIT_LEN);
    expect(isPoolComplete(created!.data)).toBe(false);
    expect(() => decodePool(created!.data)).toThrow(/not complete/);
    // every AccountLoader<Pool> refuses it: no discriminator yet (anchor AccountDiscriminatorMismatch 3002)
    await expect(send(connection, payer, [probeInsertIx(PROBE, [1n])], { cuLimit: CU })).rejects.toThrow(/0xbba|3002|AccountDiscriminatorMismatch/);
    await send(connection, someone, [growPoolIx(PROBE, someone.publicKey)]); // permissionless; 20,480 bytes
    expect((await connection.getAccountInfo(poolPda(PROBE), 'confirmed'))!.data.length).toBe(POOL_INIT_LEN + 10_240);
    await expect(send(connection, payer, [probeInsertIx(PROBE, [1n])], { cuLimit: CU })).rejects.toThrow(/0xbba|3002|AccountDiscriminatorMismatch/);
    await new SolanaPool(connection, PROBE).initialize(auth, guard); // detects the half-grown pool and finishes it
    const done = await connection.getAccountInfo(poolPda(PROBE), 'confirmed');
    expect(done!.data.length).toBe(POOL_SIZE);
    expect(done!.lamports).toBeGreaterThanOrEqual(await connection.getMinimumBalanceForRentExemption(POOL_SIZE));
    await expectEmpty(PROBE);
  });

  it('grow_pool on a complete pool fails, and a second initialize fails (even by the upgrade authority)', async () => {
    await expectCode(send(connection, someone, [growPoolIx(PROBE, someone.publicKey)]), POOL_ERROR.PoolComplete);
    await expect(send(connection, auth, initializePoolIxs(PROBE, auth.publicKey, guard), { cuLimit: CU })).rejects.toThrow();
    await expect(send(connection, auth, [initializeIx(PROBE, auth.publicKey, guard)])).rejects.toThrow();
    await expectEmpty(PROBE);
  });

  it('creates the production pool in one transaction with the empty-tree root', async () => {
    // the e2e suite shares this validator and may have initialized (and used) the production pool already
    const fresh = !(await connection.getAccountInfo(poolPda(POOL)));
    if (fresh) {
      const res = await send(connection, auth, initializePoolIxs(POOL, auth.publicKey, guard), { cuLimit: CU });
      cu.initialize_and_grow_tx = res.computeUnits;
      await expectEmpty(POOL);
    }
    expect((await readPool(POOL)).roots).toHaveLength(ROOT_HISTORY);
    await expect(send(connection, someone, initializePoolIxs(POOL, someone.publicKey), { cuLimit: CU })).rejects.toThrow();
  });
});

describe('buffers', () => {
  it('stages a payload across transactions, enforces bounds and authority, and closes', async () => {
    const payload = Uint8Array.from({ length: 2000 }, (_, i) => (i * 7) & 0xff);
    const buf = await uploadBuffer(connection, POOL, payer, payload);
    expect(buf.signatures.length).toBeGreaterThan(2);
    const info = await connection.getAccountInfo(buf.address, 'confirmed');
    expect(info!.data.length).toBe(BUFFER_HEADER + payload.length);
    expect(Buffer.from(info!.data.subarray(BUFFER_HEADER))).toEqual(Buffer.from(payload));
    // out-of-bounds write
    await expectCode(send(connection, payer, [bufferWriteIx(POOL, payer.publicKey, buf.seed, 1990, new Uint8Array(11))]), POOL_ERROR.BufferBounds);
    // another signer cannot write into it (its PDA does not match)
    const mallory = Keypair.generate();
    await connection.confirmTransaction(await connection.requestAirdrop(mallory.publicKey, LAMPORTS_PER_SOL), 'confirmed');
    const forged = bufferWriteIx(POOL, mallory.publicKey, buf.seed, 0, new Uint8Array(4));
    forged.keys[0].pubkey = buf.address;
    await expect(send(connection, mallory, [forged])).rejects.toThrow();
    const before = await connection.getBalance(payer.publicKey, 'confirmed');
    await closeBuffer(connection, POOL, payer, buf.seed);
    expect(await connection.getAccountInfo(buf.address, 'confirmed')).toBeNull();
    expect(await connection.getBalance(payer.publicKey, 'confirmed')).toBeGreaterThan(before);
    expect(bufferPda(POOL, payer.publicKey, buf.seed).equals(buf.address)).toBe(true);
  });
});

describe('groth16 on chain (verify_proof)', () => {
  const now = 1_800_000_000n;
  let spend: ProofResult;

  it('verifies a real spend proof and rejects tampered ones', async () => {
    const asset = fieldOf(Keypair.generate().publicKey);
    const a = fresh(asset, 1000n, { windowCap: 600n, maxPerTx: 300n });
    const t = new MerkleTree(LEVELS);
    const idx = t.insert(allowanceCommitment(a));
    const s = spendInput({
      root: t.root, allowance: a, path: t.path(idx), spender: agent, amount: 200n, fee: 5n, now,
      publicTo: fieldOf(Keypair.generate().publicKey), extDataHash: randomField(),
    });
    spend = await prover.prove('spend', s.input);
    expect(spend.publicSignals).toEqual(s.publicSignals);
    expect(SPEND_PUBLIC).toHaveLength(15);
    expect(await prover.verify('spend', spend)).toBe(true);

    cu.verify_spend = await verifyGeneric(spend, 'spend');
    expect(cu.verify_spend).toBeGreaterThan(0);

    // any public input changed (the amount) -> pairing check fails
    const bumped = [...spend.publicSignals];
    bumped[4] += 1n;
    await expectCode(verifyGeneric(spend, 'spend', bumped), POOL_ERROR.InvalidProof);
    // A sent un-negated (a wrong proof element) -> fails
    const raw = encodeProof(spend.proof);
    raw.set(be32(spend.proof.a[1]), 32); // +A instead of -A
    await expectCode(viaBuffer(POOL, concatBytes(raw, encodeFieldVec(spend.publicSignals)), (b) => verifyProofIx(POOL, b, 'spend')), POOL_ERROR.InvalidProof);
    // C swapped for A: valid curve points, wrong proof
    const swapped = encodeProof(spend.proof);
    swapped.set(encodeProof(spend.proof).subarray(0, 64), 192);
    await expectCode(viaBuffer(POOL, concatBytes(swapped, encodeFieldVec(spend.publicSignals)), (b) => verifyProofIx(POOL, b, 'spend')), POOL_ERROR.InvalidProof);
    // the right proof against another circuit's key
    await expectCode(verifyGeneric(spend, 'stream', spend.publicSignals.slice(0, 13)), POOL_ERROR.InvalidProof);
    await expectCode(verifyGeneric(spend, 'disclose'), POOL_ERROR.PublicInputCount);
    // a non-canonical input (x + r) is refused before any curve arithmetic
    const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    const payload = proofPayload(spend);
    payload.set(be32(spend.publicSignals[0] + R), 256 + 4);
    await expectCode(viaBuffer(POOL, payload, (b) => verifyProofIx(POOL, b, 'spend')), POOL_ERROR.InputNotInField);
    // simulateTransaction works as a read-only check
    const buf = await uploadBuffer(connection, POOL, payer, proofPayload(spend));
    const sim = await simulate(connection, payer, [verifyProofIx(POOL, buf.address, 'spend')]);
    expect(sim.err).toBeNull();
    await closeBuffer(connection, POOL, payer, buf.seed);
  });

  it('verifies a real disclose proof and rejects a different audience', async () => {
    const a = fresh(fieldOf(Keypair.generate().publicKey), 500n);
    const t = new MerkleTree(LEVELS);
    const idx = t.insert(allowanceCommitment(a));
    const d = discloseInput({ root: t.root, allowance: a, path: t.path(idx), kind: 'remainingAtLeast', bound: 400n, audience: 0xa0d170n });
    const r = await prover.prove('disclose', d.input);
    expect(r.publicSignals).toEqual(d.publicSignals);
    cu.verify_disclose = await verifyGeneric(r, 'disclose');
    const other = [...r.publicSignals];
    other[5] = 1n;
    await expectCode(verifyGeneric(r, 'disclose', other), POOL_ERROR.InvalidProof);
  });
});

describe('poseidon merkle tree (probe build)', () => {
  let local: MerkleTree;
  const leaves: bigint[] = [];
  beforeAll(() => { local = new MerkleTree(LEVELS); });

  it('on-chain roots equal src/merkle.ts roots after every batch of inserts; one root per call', async () => {
    const start = await readPool(PROBE);
    expect(start.nextIndex).toBe(0); // fresh validator (npm run test:solana restarts it)
    expect(start.lastRoot).toBe(local.root);
    let rootIndex = start.currentRootIndex;
    const batches = [1, 1, 2, 3, 5, 8, 13];
    const perBatch: Record<number, number> = {};
    for (const n of batches) {
      const batch = Array.from({ length: n }, () => randomField());
      const res = await send(connection, payer, [probeInsertIx(PROBE, batch)], { cuLimit: CU });
      perBatch[n] = res.computeUnits;
      for (const l of batch) { local.insert(l); leaves.push(l); }
      const s = await readPool(PROBE);
      expect(s.nextIndex).toBe(local.size);
      expect(s.lastRoot).toBe(local.root);
      // n leaves, one committed root (as every operation does: transact 2, grant 17, delegate 5 leaves)
      expect(s.currentRootIndex).toBe((rootIndex + 1) % ROOT_HISTORY);
      rootIndex = s.currentRootIndex;
    }
    const s = await readPool(PROBE);
    // the ring holds every root since the start (fewer than ROOT_HISTORY calls so far)
    expect(s.roots.slice(0, batches.length + 1).every((x) => x !== 0n)).toBe(true);
    expect(local.size).toBe(33);
    cu.insert_1_leaf_tx = perBatch[1];
    cu.insert_13_leaves_tx = perBatch[13];
    cu.insert_marginal_per_leaf = Math.round((perBatch[13] - perBatch[5]) / 8);
  });

  it('verify_disclosure accepts a proof against a known on-chain root and refuses an unknown one', async () => {
    const a = fresh(fieldOf(Keypair.generate().publicKey), 900n);
    const c = allowanceCommitment(a);
    await send(connection, payer, [probeInsertIx(PROBE, [c])], { cuLimit: CU });
    const idx = local.insert(c);
    expect((await readPool(PROBE)).lastRoot).toBe(local.root);
    const d = discloseInput({ root: local.root, allowance: a, path: local.path(idx), kind: 'spentAtMost', bound: 0n, audience: 77n });
    const r = await prover.prove('disclose', d.input);
    const args = (s: bigint[]): DiscloseArgs => ({ root: s[0], kind: s[1], bound: s[2], windowId: s[3], agentPk: s[4], audience: s[5] });
    const payload = (x: DiscloseArgs) => concatBytes(encodeProof(r.proof), encodeDiscloseArgs(x));
    cu.verify_disclosure_with_root_check = await viaBuffer(PROBE, payload(args(r.publicSignals)), (b) => verifyDisclosureIx(PROBE, b));
    await expectCode(viaBuffer(PROBE, payload({ ...args(r.publicSignals), audience: 78n }), (b) => verifyDisclosureIx(PROBE, b)), POOL_ERROR.InvalidProof);
    // same statement over a tree the pool never had
    const solo = new MerkleTree(LEVELS);
    const j = solo.insert(c);
    const d2 = discloseInput({ root: solo.root, allowance: a, path: solo.path(j), kind: 'spentAtMost', bound: 0n, audience: 77n });
    const r2 = await prover.prove('disclose', d2.input);
    await expectCode(viaBuffer(PROBE, concatBytes(encodeProof(r2.proof), encodeDiscloseArgs(args(r2.publicSignals))), (b) => verifyDisclosureIx(PROBE, b)), POOL_ERROR.UnknownRoot);
  });

  it('verify_stream maps lender and asset pubkeys with fieldOf on chain', async () => {
    const lender = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const loanRef = 3n;
    const start = 1_800_000_000n;
    const ref = { lenderAddr: fieldOf(lender), loanRef };
    const a: Allowance = {
      ...fresh(fieldOf(mint), 100_000n, { streamRate: 10n, streamStart: start, expiry: start + 30n * DAY, lender: lenderKey(ref.lenderAddr, loanRef), pledgeBps: 4000n }),
      remaining: 90_000n, pledgePaid: 4000n,
    };
    const c = allowanceCommitment(a);
    await send(connection, payer, [probeInsertIx(PROBE, [c])], { cuLimit: CU });
    const idx = local.insert(c);
    const s = streamInput({ root: local.root, allowance: a, path: local.path(idx), lender: ref, minRemaining: 80_000n, minRate: 10n, audience: 5n });
    const r = await prover.prove('stream', s.input);
    const args: StreamArgs = {
      root: local.root, minRemaining: 80_000n, minRate: 10n, lender, loanRef, pledgeBps: 4000, expiry: start + 30n * DAY,
      lifetimeCap: 100_000n, pledgePaid: 4000n, agentPk: agent.pk, audience: 5n, streamStart: start, asset: mint,
    };
    cu.verify_stream_with_root_check = await viaBuffer(PROBE, concatBytes(encodeProof(r.proof), encodeStreamArgs(args)), (b) => verifyStreamIx(PROBE, b));
    // a different lender account maps to a different field value: the proof no longer matches
    await expectCode(
      viaBuffer(PROBE, concatBytes(encodeProof(r.proof), encodeStreamArgs({ ...args, lender: Keypair.generate().publicKey })), (b) => verifyStreamIx(PROBE, b)),
      POOL_ERROR.InvalidProof,
    );
  });

  it('the ring keeps the last 1024 committed roots: a proof 1023 operations old verifies, one more evicts it', async () => {
    expect(ROOT_HISTORY).toBe(1024);
    const info = await connection.getAccountInfo(poolPda(PROBE), 'confirmed');
    expect(info!.data.length).toBe(8 + 4 + 4 + 32 * POOL_LEVELS + 32 * ROOT_HISTORY);
    // a real disclose proof against the root committed right after this note
    const a = fresh(fieldOf(Keypair.generate().publicKey), 700n);
    const c = allowanceCommitment(a);
    await send(connection, payer, [probeInsertIx(PROBE, [c])], { cuLimit: CU });
    const idx = local.insert(c);
    const proofRoot = local.root;
    expect((await readPool(PROBE)).lastRoot).toBe(proofRoot);
    const d = discloseInput({ root: proofRoot, allowance: a, path: local.path(idx), kind: 'remainingAtLeast', bound: 1n, audience: 9n });
    const r = await prover.prove('disclose', d.input);
    const s0 = r.publicSignals;
    const payload = concatBytes(encodeProof(r.proof), encodeDiscloseArgs({ root: s0[0], kind: s0[1], bound: s0[2], windowId: s0[3], agentPk: s0[4], audience: s0[5] }));
    cu.verify_disclosure_newest_root = await viaBuffer(PROBE, payload, (b) => verifyDisclosureIx(PROBE, b));
    // ROOT_HISTORY - 1 more commits, one per leaf (commitEach), as ROOT_HISTORY - 1 single-note operations would make
    const roots = [proofRoot];
    for (let left = ROOT_HISTORY - 1; left > 0;) {
      const batch = Array.from({ length: Math.min(28, left) }, () => randomField());
      await send(connection, payer, [probeInsertIx(PROBE, batch, true)], { cuLimit: CU });
      for (const l of batch) { local.insert(l); roots.push(local.root); }
      left -= batch.length;
    }
    const full = await readPool(PROBE);
    expect(full.lastRoot).toBe(local.root);
    expect(new Set(full.roots)).toEqual(new Set(roots)); // exactly the newest ROOT_HISTORY roots
    // the proof's root is now the oldest one in the ring (worst case of the newest-first scan) and still verifies
    cu.verify_disclosure_oldest_root = await viaBuffer(PROBE, payload, (b) => verifyDisclosureIx(PROBE, b));
    // one more operation evicts it
    const last = randomField();
    await send(connection, payer, [probeInsertIx(PROBE, [last])], { cuLimit: CU });
    local.insert(last);
    const after = await readPool(PROBE);
    expect(after.roots.includes(proofRoot)).toBe(false);
    expect(after.roots.includes(roots[1])).toBe(true);
    await expectCode(viaBuffer(PROBE, payload, (b) => verifyDisclosureIx(PROBE, b)), POOL_ERROR.UnknownRoot);
  });

  it('compute units stay within budget (written to solana/target-so, not a tracked file)', () => {
    const budget: Record<string, number> = {
      verify_spend: 200_000, verify_disclose: 200_000, insert_1_leaf_tx: 60_000, insert_13_leaves_tx: 400_000, insert_marginal_per_leaf: 30_000,
      verify_disclosure_with_root_check: 200_000, verify_stream_with_root_check: 250_000,
      verify_disclosure_newest_root: 200_000, verify_disclosure_oldest_root: 250_000, initialize_and_grow_tx: 200_000,
    };
    for (const [k, max] of Object.entries(budget)) {
      expect(cu[k], k).toBeGreaterThan(0);
      expect(cu[k], k).toBeLessThan(max);
    }
    const dir = resolve(import.meta.dirname, '..', '..', 'solana', 'target-so');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'compute-units.json'), JSON.stringify({ measured: new Date().toISOString(), rpc: RPC, computeUnits: cu }, null, 2) + '\n');
    console.log('compute units', cu);
  });
});
