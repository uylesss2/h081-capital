// The four paid services' building blocks, in process: the loan-market reader over stub accounts, the
// relay preflight (SolanaRelayer.inspect) and the priority lane over a stub connection and transport, and
// the disclosure prover's checks (the proof itself only where the circuit artifacts are installed).
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { toRelayError } from '../../relayer/errors.js';
import { type RelayIo, SolanaRelayer } from '../../relayer/solana.js';
import { LoanMarketReader, SLOT_ACCOUNT_BYTES } from '../../relayer/x402/loans.js';
import { DiscloseProver, checkDiscloseRequest, discloseArtifacts, parseDiscloseRequest, rootOfPath } from '../../relayer/x402/prove.js';
import { loansMarket, preflight, proveDisclose, relayPriority } from '../../relayer/x402/services.js';
import { type Allowance, FIELD, allowanceCommitment, initCrypto, randomField, randomKeys } from '../../src/crypto.js';
import { LEVELS } from '../../src/inputs.js';
import { MerkleTree } from '../../src/merkle.js';
import { Prover } from '../../src/prover.js';
import { GRACE, registryPda } from '../../src/solana/lender.js';
import { poolPda } from '../../src/solana/pda.js';
import { POOL_DISCRIMINATOR, POOL_SIZE } from '../../src/solana/program.js';
import { concatBytes, encodeTransactArgs, encodeTransactExt, extDataHash, fromBe, toB64 } from '../../src/solana/index.js';
import { clockAccount, encodeRegistry, encodeSlot } from './helpers/x402.js';

const loanProgram = Keypair.generate().publicKey;
const NOW = 1_800_000_000n;

describe('loan market reader', () => {
  const lender = Keypair.generate().publicKey;
  const asset = Keypair.generate().publicKey;
  const slots = [
    encodeSlot({ loanRef: 1n, lender }), // open
    encodeSlot({ loanRef: 2n, lender, funded: true, asset, tokenProgram: TOKEN_PROGRAM_ID, principal: 1_000_000n, repaid: 250_000n, expiry: NOW - GRACE - 10n, pledgeBps: 4000n, fundedAt: NOW - 100_000n }),
    encodeSlot({ loanRef: 3n, lender, funded: true, settled: true, asset, tokenProgram: TOKEN_PROGRAM_ID, principal: 5n, repaid: 5n, expiry: NOW + 10n }),
  ];
  let rpcCalls = 0;
  const connection = {
    getAccountInfo: async (k: PublicKey) => {
      rpcCalls++;
      if (k.equals(registryPda(loanProgram))) return { data: encodeRegistry(4n), owner: loanProgram, lamports: 1, executable: false };
      if (k.equals(SYSVAR_CLOCK_PUBKEY)) return clockAccount(NOW);
      return null;
    },
    getProgramAccounts: async (p: PublicKey, cfg: { filters: Array<{ dataSize: number }> }) => {
      rpcCalls++;
      expect(p.equals(loanProgram)).toBe(true);
      expect(cfg.filters).toEqual([{ dataSize: SLOT_ACCOUNT_BYTES }]);
      return slots.map((data) => ({ pubkey: Keypair.generate().publicKey, account: { data, owner: loanProgram, lamports: 1, executable: false } }));
    },
  } as unknown as Connection;

  it('reads the registry and every slot, computes shortfalls at chain time, and caches for 30 s', async () => {
    expect(SLOT_ACCOUNT_BYTES).toBe(253);
    for (const s of slots) expect(s).toHaveLength(SLOT_ACCOUNT_BYTES);
    const clock = { t: 1_000 };
    const reader = new LoanMarketReader(connection, { programId: loanProgram, treasury: 'T', clock: () => clock.t });
    const snap = await reader.snapshot();
    expect(snap).toMatchObject({ programId: loanProgram.toBase58(), registry: { nextLoanRef: '4' }, originationFeeBps: 25, graceSeconds: Number(GRACE), treasury: 'T', counts: { open: 1, funded: 1, settled: 1 }, now: NOW.toString() });
    expect(snap.openSlots).toEqual([{ loanRef: '1', lender: lender.toBase58() }]);
    expect(snap.loans.map((l) => l.loanRef)).toEqual(['2', '3']);
    expect(snap.loans[0]).toMatchObject({ lender: lender.toBase58(), asset: asset.toBase58(), tokenProgram: TOKEN_PROGRAM_ID.toBase58(), principal: '1000000', repaid: '250000', pledgeBps: 4000, settled: false, shortfall: '750000' });
    expect(snap.loans[1]).toMatchObject({ settled: true, shortfall: '0' });
    const calls = rpcCalls;
    expect(await reader.snapshot()).toBe(snap);
    expect(rpcCalls).toBe(calls);
    clock.t += 31_000;
    await reader.snapshot();
    expect(rpcCalls).toBeGreaterThan(calls);
    // the service wraps it
    expect(await loansMarket(reader).run({ body: undefined, url: new URL('http://x/'), clientKey: 'k', log: () => undefined }, undefined)).toMatchObject({ counts: { open: 1 } });
  });

  it('answers 503 when the chain is not readable', async () => {
    const broken = { getAccountInfo: async () => { throw new Error('rpc down'); }, getProgramAccounts: async () => [] } as unknown as Connection;
    const err = await new LoanMarketReader(broken, { programId: loanProgram }).snapshot().catch((e) => toRelayError(e));
    expect(err).toMatchObject({ status: 503, code: 'rpc' });
  });
});

// ---- a relayer over a stub cluster: one 6-decimal fee mint, a pool that knows root 11, no spent nullifiers

const proof = new Uint8Array(256).fill(7);
const payer = Keypair.generate();
const treasury = Keypair.generate().publicKey;
const usd = Keypair.generate().publicKey;
const treasuryAta = getAssociatedTokenAddressSync(usd, treasury, true, TOKEN_PROGRAM_ID);
const MIN = 1_000n;
const programId = Keypair.generate().publicKey;

function poolAccount(roots: bigint[]) {
  const data = Buffer.alloc(POOL_SIZE);
  Buffer.from(POOL_DISCRIMINATOR).copy(data, 0);
  roots.forEach((r, i) => Buffer.from(r.toString(16).padStart(64, '0'), 'hex').copy(data, 16 + 32 * LEVELS + 32 * i));
  return { data, owner: programId, lamports: 1, executable: false };
}
const mintData = () => { const b = Buffer.alloc(82); b[44] = 6; return b; };

function stubCluster(o: { roots?: bigint[]; lamports?: number; existing?: PublicKey[] } = {}) {
  const pool = poolAccount(o.roots ?? [11n]);
  return {
    getAccountInfo: async (k: PublicKey) => {
      if (k.equals(usd)) return { owner: TOKEN_PROGRAM_ID, data: mintData(), lamports: 1, executable: false };
      if (k.equals(poolPda(programId))) return pool;
      if (k.equals(SYSVAR_CLOCK_PUBKEY)) return clockAccount(NOW);
      if ((o.existing ?? []).some((e) => e.equals(k))) return { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(165), lamports: 1, executable: false };
      return null;
    },
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(() => null),
    getBalance: async () => o.lamports ?? 1_000_000_000,
  } as unknown as Connection;
}

const recipientOwner = Keypair.generate().publicKey;
const recipientAta = getAssociatedTokenAddressSync(usd, recipientOwner, true, TOKEN_PROGRAM_ID);

function withdrawal(o: { amount: bigint; fee: bigint; root?: bigint; nullifiers?: [bigint, bigint]; recipient?: PublicKey }) {
  const ext = encodeTransactExt({
    recipient: o.recipient ?? recipientAta, relayer: payer.publicKey, feeRecipient: treasuryAta,
    extAmount: -o.amount, fee: o.fee, encryptedOutputs: [new Uint8Array(120).fill(1), new Uint8Array(120).fill(2)],
  });
  const args = encodeTransactArgs({ root: o.root ?? 11n, publicAmount: 0n, extDataHash: extDataHash(ext), inputNullifiers: o.nullifiers ?? [21n, 22n], outputCommitments: [31n, 32n] });
  return concatBytes(proof, args, ext);
}
const body = (payload: Uint8Array, extra: Record<string, unknown> = {}) => ({ op: 'transact', payload: toB64(payload), mint: usd.toBase58(), recipientOwner: recipientOwner.toBase58(), ...extra });
const ctx = (b: unknown) => ({ body: b, url: new URL('http://x/'), clientKey: 'k', log: () => undefined });

describe('relay preflight (SolanaRelayer.inspect)', () => {
  const relayer = (connection = stubCluster()) => new SolanaRelayer({ connection, payer, treasury, programId, minFees: new Map([[usd.toBase58(), MIN]]) }).init();

  it('reports ok with the fee rule, chain state, accounts and plan for a relayable withdrawal', async () => {
    const r = await relayer();
    const out = await r.inspect(body(withdrawal({ amount: 5_000_000n, fee: 10_000n })));
    expect(out.ok).toBe(true);
    expect(out.refusals).toEqual([]);
    expect(out.fee).toEqual({ paid: '10000', required: '10000', min: MIN.toString(), bps: 20, publicAmount: '5000000', mint: usd.toBase58(), feeAccount: treasuryAta.toBase58() });
    expect(out.chain).toEqual({ rootKnown: true, nullifiersUnspent: [true, true], timestampFresh: null });
    expect(out.accounts).toEqual({ recipientExists: false, vaultExists: false, lenderTokenUsable: null });
    expect(out.plan).toMatchObject({ payloadBytes: expect.any(Number), setupTxs: expect.any(Number), writeTxs: expect.any(Number) });
    expect(out.capacity).toBeNull();
    // through the service
    expect(await preflight(r).run(ctx(body(withdrawal({ amount: 5_000_000n, fee: 10_000n }))), undefined)).toMatchObject({ ok: true });
  });

  it('collects refusals instead of throwing: fee too low, unknown root, underfunded; prepare still throws the first', async () => {
    const r = await relayer();
    const low = await r.inspect(body(withdrawal({ amount: 5_000_000n, fee: 9_999n })));
    expect(low.ok).toBe(false);
    expect(low.refusals).toEqual([{ status: 402, code: 'fee_too_low', message: expect.stringContaining('below 10000') }]);
    expect(low.fee.required).toBe('10000');
    const stale = await r.inspect(body(withdrawal({ amount: 5_000_000n, fee: 10_000n, root: 12n })));
    expect(stale.refusals).toEqual([{ status: 409, code: 'unknown_root', message: expect.any(String) }]);
    expect(stale.chain.rootKnown).toBe(false);
    const poor = await relayer(stubCluster({ lamports: 1 }));
    expect((await poor.inspect(body(withdrawal({ amount: 5_000_000n, fee: 10_000n })))).refusals.map((x) => x.code)).toEqual(['relayer_underfunded']);
    // the planning step's 400s are findings too
    const noOwner = await r.inspect({ ...body(withdrawal({ amount: 5_000_000n, fee: 10_000n })), recipientOwner: undefined });
    expect(noOwner.refusals.map((x) => x.code)).toEqual(['recipient_account_missing']);
    // prepare: unchanged behaviour
    await expect(r.prepare(body(withdrawal({ amount: 5_000_000n, fee: 9_999n })))).rejects.toMatchObject({ status: 402, code: 'fee_too_low' });
    await expect(r.prepare(body(withdrawal({ amount: 5_000_000n, fee: 10_000n, root: 12n })))).rejects.toMatchObject({ status: 409, code: 'unknown_root' });
    await expect(r.prepare(body(withdrawal({ amount: 5_000_000n, fee: 10_000n })))).resolves.toMatchObject({ op: 'transact', fee: 10_000n });
  });

  it('still rejects a payload that does not decode (400), never a finding', async () => {
    const r = await relayer();
    for (const b of [{ op: 'nope', payload: '' }, { op: 'transact', payload: '***' }, { op: 'transact', payload: toB64(new Uint8Array(10)) }]) {
      const err = await r.inspect(b).catch((e) => toRelayError(e));
      expect(err).toMatchObject({ status: 400 });
    }
  });
});

describe('priority lane', () => {
  const defer = () => { let resolve!: () => void; const p = new Promise<void>((r) => { resolve = r; }); return { p, resolve }; };

  it('has its own in-flight count and passes the lane fee caps to the transport', async () => {
    const sends: Array<{ priority: unknown }> = [];
    const stages: Array<{ priority: unknown }> = [];
    const gate = defer();
    let free = true;
    const io: RelayIo = {
      stagePlan: async (_c, _p, _plan, priority) => { stages.push({ priority }); if (free) await gate.p; return []; },
      simulateV0: async () => ({ err: null, logs: [], computeUnits: 1 }),
      sendV0: async (_c, _p, _ixs, _t, _s, priority) => { sends.push({ priority }); return { signature: `sig${sends.length}`, computeUnits: 5, logs: [] }; },
      abandonPlan: async () => undefined,
    };
    const lane = { maxInFlight: 1, maxLamports: 4_000_000, priceCeil: 5_000_000 };
    const r = await new SolanaRelayer({ connection: stubCluster(), payer, treasury, programId, minFees: new Map([[usd.toBase58(), MIN]]), maxInFlight: 1, priority: lane, io }).init();
    const paid = (n: bigint) => body(withdrawal({ amount: 5_000_000n, fee: 10_000n, nullifiers: [n, n + 1n] }));
    // a free-lane relay blocks in staging...
    const slow = r.relay(paid(100n));
    await new Promise((res) => setTimeout(res, 20));
    expect(stages).toHaveLength(1);
    free = false;
    // ...the free lane is full, the priority lane is not
    await expect(r.relay(paid(200n))).rejects.toMatchObject({ status: 503, code: 'busy' });
    const fast = await relayPriority(r).run(ctx(undefined), await relayPriority(r).prepare!(ctx(paid(300n))));
    expect(fast).toMatchObject({ signature: 'sig1', op: 'transact', fee: '10000', lane: 'priority', priorityFee: { maxLamports: 4_000_000, priceCeil: 5_000_000 } });
    expect(stages[1].priority).toEqual({ maxLamports: 4_000_000, priceCeil: 5_000_000 });
    expect(sends[0].priority).toEqual({ maxLamports: 4_000_000, priceCeil: 5_000_000 });
    // a second priority relay while one holds the lane is busy; the slot comes back after abort
    const held = await relayPriority(r).prepare!(ctx(paid(400n)));
    await expect(relayPriority(r).prepare!(ctx(paid(500n)))).rejects.toMatchObject({ status: 503, code: 'busy' });
    relayPriority(r).abort!(held);
    await expect(relayPriority(r).prepare!(ctx(paid(500n)))).resolves.toBeTruthy();
    // a prepare refusal gives the slot back too
    await expect(relayPriority(r).prepare!(ctx(body(withdrawal({ amount: 5_000_000n, fee: 1n }))))).rejects.toMatchObject({ code: 'busy' });
    gate.resolve();
    expect(await slow).toMatchObject({ signature: 'sig2', op: 'transact' });
    expect(sends[1].priority).toBeUndefined();
    expect(stages[0].priority).toBeUndefined();
    // without a lane the paid route cannot be served
    const noLane = await new SolanaRelayer({ connection: stubCluster(), payer, treasury, programId, minFees: new Map([[usd.toBase58(), MIN]]), io }).init();
    await expect(relayPriority(noLane).prepare!(ctx(paid(600n)))).rejects.toMatchObject({ status: 503, code: 'lane_disabled' });
  });
});

// ---- disclosure proving

const circuitsDir = resolve(import.meta.dirname, '..', '..', 'build', 'circuits');
const hasCircuit = existsSync(discloseArtifacts(circuitsDir).zkey);

describe('disclose prover: checks before proving', () => {
  let owner: ReturnType<typeof randomKeys>;
  let agent: ReturnType<typeof randomKeys>;
  let allowance: Allowance;
  let tree: MerkleTree;
  let index: number;
  beforeAll(async () => {
    await initCrypto();
    owner = randomKeys();
    agent = randomKeys();
    allowance = {
      asset: 0x1111n, remaining: 640n, agentPk: agent.pk, windowId: 20833n, windowSpent: 120n, rho: randomField(), pledgePaid: 0n,
      policy: { lifetimeCap: 1000n, windowCap: 0n, windowLen: 86400n, maxPerTx: 0n, expiry: 0n, recipientRoot: 0n, ownerPk: owner.pk, streamRate: 0n, streamStart: 0n, lender: 0n, pledgeBps: 0n },
    };
    tree = new MerkleTree(LEVELS);
    index = tree.insert(allowanceCommitment(allowance));
  });
  const str = (x: bigint) => x.toString();
  const request = (over: Record<string, unknown> = {}) => {
    const p = tree.path(index);
    const a = allowance;
    return {
      root: str(tree.root), kind: 'remainingAtLeast', bound: '600', audience: '77',
      allowance: {
        asset: '0x1111', remaining: str(a.remaining), agentPk: str(a.agentPk), windowId: str(a.windowId), windowSpent: str(a.windowSpent), rho: str(a.rho), pledgePaid: '0',
        policy: Object.fromEntries(Object.entries(a.policy).map(([k, v]) => [k, str(v)])),
      },
      path: { pathIndices: p.pathIndices, pathElements: p.pathElements.map(str) },
      ...over,
    };
  };
  const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => toRelayError(e).code);

  it('parses the body into field elements and recomputes the root', () => {
    const r = parseDiscloseRequest(request());
    expect(r.root).toBe(tree.root);
    expect(r.allowance).toEqual(allowance);
    expect(rootOfPath(allowanceCommitment(r.allowance), r.path)).toBe(tree.root);
    expect(() => parseDiscloseRequest(request({ bound: str(FIELD) }))).toThrow(/not in the field/);
    expect(() => parseDiscloseRequest(request({ kind: 'anything' }))).toThrow(/kind/);
    expect(() => parseDiscloseRequest(request({ path: { pathIndices: [0], pathElements: ['1'] } }))).toThrow(/20 levels/);
    expect(() => parseDiscloseRequest(request({ allowance: { ...request().allowance, rho: 'abc' } }))).toThrow(/rho/);
  });

  it('refuses bad input (400), a path that misses the root (400 bad_path) and an unknown root (409) before proving', async () => {
    const known = async () => [tree.root];
    expect(await code(checkDiscloseRequest(request({ bound: '-1' }), known))).toBe('bad_input');
    expect(await code(checkDiscloseRequest(request({ path: { ...request().path, pathIndices: new Array(LEVELS).fill(1) } }), known))).toBe('bad_path');
    expect(await code(checkDiscloseRequest(request({ allowance: { ...request().allowance, remaining: '641' } }), known))).toBe('bad_path');
    expect(await code(checkDiscloseRequest(request(), async () => [1n, 2n]))).toBe('unknown_root');
    expect(await code(checkDiscloseRequest(request(), async () => { throw new Error('rpc'); }))).toBe('pool_unreadable');
    expect(await code(checkDiscloseRequest(request({ kind: 'windowSpentAtMost', windowId: '1' }), known))).toBe('bad_input');
    expect((await checkDiscloseRequest(request(), known)).kind).toBe('remainingAtLeast');
    // the service without artifacts answers 503 service_disabled
    expect(await code(proveDisclose(undefined).prepare!(ctx(request())))).toBe('service_disabled');
  });

  describe.skipIf(!hasCircuit)('with the disclose circuit installed', () => {
    it('proves a true statement, refuses a false one after the checks, and the payload decodes to the public signals', async () => {
      const prover = new DiscloseProver({ circuitsDir, knownRoots: async () => [tree.root] });
      expect(prover.vkeySha256).toMatch(/^[0-9a-f]{64}$/);
      expect(() => new DiscloseProver({ circuitsDir, vkeySha256: 'f'.repeat(64), knownRoots: async () => [] })).toThrow(/sha256/);
      const service = proveDisclose(prover);
      const checked = await service.prepare!(ctx(request()));
      const out = (await service.run(ctx(undefined), checked)) as { proof: unknown; publicSignals: string[]; args: Record<string, string>; payload: string; policyHash: string };
      expect(out.publicSignals).toHaveLength(6);
      expect(out.args).toEqual({ root: str(tree.root), kind: '0', bound: '600', windowId: '0', agentPk: str(agent.pk), audience: '77' });
      expect(await new Prover(circuitsDir).verify('disclose', { raw: { proof: out.proof, publicSignals: out.publicSignals } } as never)).toBe(true);
      const bytes = Buffer.from(out.payload, 'base64');
      expect(bytes).toHaveLength(256 + 6 * 32);
      for (let i = 0; i < 6; i++) expect(fromBe(bytes.subarray(256 + 32 * i, 256 + 32 * (i + 1))).toString()).toBe(out.publicSignals[i]);
      // remaining is 640: "at least 641" is false, and the circuit says so (after the checks passed)
      const falseClaim = await service.prepare!(ctx(request({ bound: '641' })));
      expect(await code(service.run(ctx(undefined), falseClaim))).toBe('statement_false');
    }, 120_000);
  });
});
