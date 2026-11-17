// Private reputation, bank level (integrations/core/reputation.ts) with real proofs from the DEV reputation setup
// (build/circuits/reputation) over a mocked chain: request -> prove -> verify, and every way a verifier must refuse.
// Also the ladder, loan selection and the kind 7/8/9 codes. No validator.
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { initCrypto, loanPk, randomField, repLeaf } from '../../src/crypto.js';
import { MerkleTree } from '../../src/merkle.js';
import { Prover } from '../../src/prover.js';
import {
  LADDER, NO_REQUIREMENT, REP_LEVELS, ReputationUnreachable, audienceOf, isOnLadder, selectLoans, snapRequirement, snapRequirementUp, volumeLadder, type RepLoan,
} from '../../src/reputation.js';
import { be32, fieldOf } from '../../src/solana/field.js';
import { LOCALNET_REP_PROGRAM_ID, REP_TREE_SIZE, repTreePda, snapshotOf, type RepAttestedEvent } from '../../src/solana/reputation.js';
import {
  CODE_KIND, PREFIX_KIND, decodeRepCode, decodeRepRequest, encodeRepCode, encodeRepRequest, encodeRepSig, repPresentationMessage, type CodeContext, type RepThresholds,
} from '../../integrations/core/codes.js';
import {
  checkProbeCap, proveReputation, reputationAttest, reputationRequest, verifyReputation, type RepAttestResult, type RepEnv, REP_MAX_SETS_PER_DAY,
  REP_MAX_SETS_PER_DAY_ALL,
} from '../../integrations/core/reputation.js';
import type { H081Config } from '../../integrations/core/constants.js';
import { VerifyRepZ } from '../../integrations/core/schemas.js';

const U = 1_000_000n;
const USDG = new PublicKey(new Uint8Array(32).fill(3));
const haveArtifacts = existsSync(new Prover().paths('reputation').zkey);

/** A rep tree with `master`'s loans plus noise, its events, and a mock chain that serves the RepTree account. */
function world(master: bigint) {
  const tree = new MerkleTree(REP_LEVELS);
  const events: RepAttestedEvent[] = [];
  const add = (agentPk: bigint, loanRef: bigint, principal: bigint, lender: number, fundedDay: number, mint = USDG) => {
    const assetF = fieldOf(mint), lenderF = fieldOf(new PublicKey(new Uint8Array(32).fill(lender)));
    const leaf = repLeaf({ agentPk, loanRef, principal, assetF, lenderF, fundedDay: BigInt(fundedDay) });
    const index = tree.insert(leaf);
    events.push({ version: 0, index, loanRef, leaf, root: tree.root, agentPk, principal, assetF, lenderF, fundedDay });
  };
  add(randomField(), 1n, 50n * U, 9, 20_000);
  add(loanPk(master, 0), 2n, 10n * U, 1, 20_010);
  add(loanPk(master, 1), 3n, 25n * U, 2, 20_060);
  add(randomField(), 4n, 70n * U, 9, 20_061);
  add(loanPk(master, 2), 5n, 40n * U, 1, 20_100);
  const rootsAt = (t: MerkleTree) => {
    const data = new Uint8Array(REP_TREE_SIZE);
    const dv = new DataView(data.buffer);
    dv.setUint32(8, events.length, true);
    dv.setUint32(12, 0, true);
    data.set(be32(t.root), 8 + 16 + 32 * REP_LEVELS);
    return data;
  };
  let account = rootsAt(tree);
  const connection = {
    getAccountInfo: async (k: PublicKey) => (k.equals(repTreePda(LOCALNET_REP_PROGRAM_ID, 0)) ? { data: account, owner: LOCALNET_REP_PROGRAM_ID, lamports: 1, executable: false } : null),
  } as unknown as Connection;
  return { tree, events, connection, setRoot: (r: bigint) => { const d = rootsAt(tree); d.set(be32(r), 8 + 16 + 32 * REP_LEVELS); account = d; } };
}

function envFor(master: bigint, w: ReturnType<typeof world>, cacheDir = mkdtempSync(join(tmpdir(), 'h081-rep-'))): RepEnv {
  const snapshot = snapshotOf(w.events, LOCALNET_REP_PROGRAM_ID);
  const keys: number[] = [];
  return {
    connection: w.connection,
    config: { cluster: 'localnet', usdgMint: USDG, decimals: 6, repProgramId: LOCALNET_REP_PROGRAM_ID, repDevSetup: true, loanProgramId: Keypair.generate().publicKey } as unknown as H081Config,
    signer: Keypair.generate(), accountSk: master, prover: new Prover(), relayerUrl: 'http://relayer.test', cacheDir, log: () => {},
    fetch: (async () => new Response(JSON.stringify(snapshot), { status: 200 })) as typeof fetch,
    loanKeys: () => keys, rememberLoanKeys: (ks) => { for (const k of ks) if (!keys.includes(k)) keys.push(k); }, legacyAgentPks: () => [],
  };
}

const CTX: CodeContext = { cluster: 'localnet', program: LOCALNET_REP_PROGRAM_ID.toBase58(), mint: USDG.toBase58() };

beforeAll(async () => { await initCrypto(); });

describe('ladder and selection', () => {
  it('snaps down when proving and up when asking; off-ladder detection', () => {
    const r = { minLoans: 4, minVolume: 70n * U, minLenders: 2, minSpanDays: 40, minMonths: 2, monthFloor: 3n * U };
    expect(snapRequirement(r)).toEqual({ minLoans: 3, minVolume: 50n * U, minLenders: 2, minSpanDays: 30, minMonths: 2, monthFloor: 25n * U / 10n });
    expect(snapRequirementUp(r)).toEqual({ minLoans: 5, minVolume: 100n * U, minLenders: 2, minSpanDays: 90, minMonths: 2, monthFloor: 5n * U });
    expect(isOnLadder(snapRequirement(r))).toBe(true);
    expect(isOnLadder(r)).toBe(false);
    expect(volumeLadder().slice(0, 4)).toEqual([0n, U, 25n * U / 10n, 5n * U]);
    expect(() => snapRequirementUp({ ...NO_REQUIREMENT, minLoans: 17 })).toThrow(/ladder/);
    expect(LADDER.loans[LADDER.loans.length - 1]).toBe(16);
  });

  it('selectLoans meets every bound with as few as needed, or says what is short', () => {
    const L = (loanRef: bigint, principal: bigint, lender: bigint, day: number): RepLoan => ({ loanRef, principal, assetF: 1n, lenderF: lender, fundedDay: BigInt(day), keyIndex: Number(loanRef), index: Number(loanRef) });
    const loans = [L(1n, 5n, 1n, 100), L(2n, 50n, 1n, 101), L(3n, 7n, 2n, 400), L(4n, 1n, 3n, 120), L(5n, 30n, 1n, 160)];
    const pick = selectLoans(loans, { ...NO_REQUIREMENT, minLoans: 2, minVolume: 80n, minLenders: 2, minSpanDays: 300 });
    expect(pick.map((l) => l.loanRef)).toEqual([...pick.map((l) => l.loanRef)].sort((a, b) => (a < b ? -1 : 1)));
    const days = pick.map((l) => Number(l.fundedDay));
    expect(Math.max(...days) - Math.min(...days)).toBeGreaterThanOrEqual(300);
    expect(new Set(pick.map((l) => l.lenderF)).size).toBeGreaterThanOrEqual(2);
    expect(pick.reduce((s, l) => s + l.principal, 0n)).toBeGreaterThanOrEqual(80n);
    expect(() => selectLoans(loans, { ...NO_REQUIREMENT, minLenders: 4 })).toThrow(ReputationUnreachable);
    expect(() => selectLoans(loans, { ...NO_REQUIREMENT, minVolume: 1000n })).toThrow(/minVolume/);
    expect(selectLoans(loans, { ...NO_REQUIREMENT, minMonths: 3, monthFloor: 6n }).length).toBeGreaterThanOrEqual(3); // 50 (day 101), 7 (day 400), 30 (day 160)
    expect(() => selectLoans(loans, { ...NO_REQUIREMENT, minMonths: 3, monthFloor: 8n })).toThrow(/minMonths/);
    // duplicates collapse
    expect(selectLoans([loans[0], loans[0]], NO_REQUIREMENT)).toHaveLength(1);
  });

  it('audiences: names and keys are domain separated and stable', () => {
    expect(audienceOf('acme-desk')).toBe(audienceOf('  acme-desk '));
    expect(audienceOf('acme-desk')).not.toBe(audienceOf('acme-desk2'));
    const key = new Uint8Array(32).fill(65); // 32 x "A": as a name it would be the same bytes
    expect(audienceOf(key)).not.toBe(audienceOf('A'.repeat(32)));
    expect(audienceOf(key) < 1n << 160n).toBe(true);
    expect(() => audienceOf('')).toThrow();
  });
});

describe('codes 7, 8, 9', () => {
  const code = {
    treeVersion: 0, proof: new Uint8Array(256).fill(7), repRoot: 11n, presNullifier: 12n, audience: 13n, nonce: 14n, expiry: 1_900_000_000n, bindTo: 15n,
    minLoans: 3, minVolume: 50n * U, minLenders: 2, minSpanDays: 30, minMonths: 2, monthFloor: 5n * U,
  };
  it('round-trip, letters and digits only, with their own kinds', () => {
    const c = encodeRepCode(CTX, code);
    expect(c).toMatch(/^h081-rep:[1-9A-HJ-NP-Za-km-z]+$/);
    expect(decodeRepCode(CTX, c)).toEqual(code);
    const q = encodeRepRequest(CTX, { audience: 1n, nonce: 2n, expiry: 3n, bindTo: 0n, label: 'acme desk', minLoans: 1, minVolume: 0n, minLenders: 0, minSpanDays: 7, minMonths: 0, monthFloor: 0n });
    expect(q).toMatch(/^h081-rep-ask:[1-9A-HJ-NP-Za-km-z]+$/);
    expect(decodeRepRequest(CTX, q).label).toBe('acme desk');
    expect(PREFIX_KIND['h081-rep:']).toBe(CODE_KIND.reputation);
    expect(PREFIX_KIND['h081-rep-ask:']).toBe(CODE_KIND.repRequest);
    expect(PREFIX_KIND['h081-rep-sig:']).toBe(CODE_KIND.repSig);
    // pasted with noise: still reads
    expect(decodeRepCode(CTX, `  "${c.slice(0, 40)}\n${c.slice(40)}".`)).toEqual(code);
  });

  it('a changed character, another network, or the wrong kind each get their own message', () => {
    const c = encodeRepCode(CTX, code);
    const i = c.length - 10;
    const flipped = c.slice(0, i) + (c[i] === '2' ? '3' : '2') + c.slice(i + 1);
    expect(() => decodeRepCode(CTX, flipped)).toThrow(/built-in check/);
    expect(() => decodeRepCode({ ...CTX, cluster: 'mainnet-beta' }, c)).toThrow(/another network/);
    const q = encodeRepRequest(CTX, { audience: 1n, nonce: 2n, expiry: 3n, bindTo: 0n, label: '', ...NO_REQUIREMENT, minLoans: 1 });
    expect(() => decodeRepCode(CTX, q)).toThrow(/"h081-rep-ask:" code, not a reputation proof code/);
    expect(() => decodeRepRequest(CTX, c)).toThrow(/"h081-rep:" code, not a reputation request code/);
    expect(() => decodeRepCode(CTX, 'h081-rep:')).toThrow(/copy it again|nothing after its prefix/);
  });
});

describe.skipIf(!haveArtifacts)('prove and verify (dev setup)', () => {
  const master = 0x1234567890abcdefn;
  let w: ReturnType<typeof world>;
  let env: RepEnv;
  let ask: ReturnType<typeof reputationRequest>;
  let proved: Awaited<ReturnType<typeof proveReputation>>;

  beforeAll(async () => {
    w = world(master);
    env = envFor(master, w);
  }, 300_000);

  it('a request rounds up; the answer verifies with its request and the presenter signature', async () => {
    ask = reputationRequest(env, { audience: 'acme-desk', minLoans: 3, minVolume: '60', minLenders: 2, minSpanDays: 80 });
    await expect(proveReputation(env, { request: ask.code })).rejects.toThrow(/minVolume/);
    expect(ask.thresholds).toMatchObject({ minLoans: 3, minVolume: '100', minLenders: 2, minSpanDays: 90 });
    // the account has 75 USDG: the rounded-up request is out of reach, and the error says so
    const env2 = envFor(master, w);
    const ask2 = reputationRequest(env2, { audience: 'acme-desk', minLoans: 3, minVolume: '50', minLenders: 2, minSpanDays: 30 });
    const p2 = await proveReputation(env2, { request: ask2.code });
    expect(p2.binding).toBe('session-key');
    expect(p2.presentation).toMatch(/^h081-rep-sig:/);
    const v = await verifyReputation(env2, p2.code, { request: ask2.code, presentation: p2.presentation });
    expect(v).toMatchObject({ ok: true, presenter: 'signed-session-key', lowerBoundOnly: true, thresholds: { minLoans: 3, minVolume: '50' } });
    expect(v.statement).toMatch(/says nothing about defaults/);
    expect(v.setup).toMatch(/single-party/);
    proved = p2; ask = ask2; env = env2;
  }, 300_000);

  it('a request bound to the presenter key needs no presentation; another key is refused', async () => {
    const e = envFor(master, w);
    const presenter = Keypair.generate().publicKey.toBase58();
    const q = reputationRequest(e, { audience: 'acme-desk', minLoans: 2, bindTo: presenter });
    const p = await proveReputation(e, { request: q.code });
    expect(p.binding).toBe('request');
    expect(p.presentation).toBeUndefined();
    expect(await verifyReputation(e, p.code, { request: q.code })).toMatchObject({ ok: true, presenter: 'request-binding' });
    const q2 = encodeRepRequest(CTX, { ...decodeRepRequest(CTX, q.code), bindTo: fieldOf(Keypair.generate().publicKey) });
    expect((await verifyReputation(e, p.code, { request: q2 })).reason).toMatch(/bound to another key/);
  }, 300_000);

  it('out of reach: says what is short', async () => {
    const e = envFor(master, w);
    const q = reputationRequest(e, { audience: 'x', minLoans: 3, minVolume: '100' });
    await expect(proveReputation(e, { request: q.code })).rejects.toThrow(/minVolume needs 100000000, has 75000000/);
  });

  it('refuses: no presentation, a wrong signer, another audience or nonce, a weaker claim, a bearer code', async () => {
    expect(await verifyReputation(env, proved.code, { request: ask.code })).toMatchObject({ ok: false, reason: expect.stringMatching(/presenter must also give its signature/) });
    const other = ed25519.utils.randomPrivateKey();
    const p = decodeRepCode(CTX, proved.code);
    const forged = encodeRepSig(CTX, { pub: ed25519.getPublicKey(other), sig: ed25519.sign(repPresentationMessage(p.audience, p.nonce, p.presNullifier), other) });
    expect((await verifyReputation(env, proved.code, { request: ask.code, presentation: forged })).reason).toMatch(/another key/);
    const otherAsk = reputationRequest(env, { audience: 'someone-else', minLoans: 1 });
    expect((await verifyReputation(env, proved.code, { request: otherAsk.code, presentation: proved.presentation })).reason).toMatch(/another audience/);
    const sameAudNewNonce = reputationRequest(env, { audience: 'acme-desk', minLoans: 3, minVolume: '50', minLenders: 2, minSpanDays: 30 });
    expect((await verifyReputation(env, proved.code, { request: sameAudNewNonce.code, presentation: proved.presentation })).reason).toMatch(/another challenge/);
    const stricter = reputationRequest(env, { audience: 'acme-desk', minLoans: 5 });
    const stricterSameNonce = encodeRepRequest(CTX, { ...decodeRepRequest(CTX, stricter.code), nonce: p.nonce });
    expect((await verifyReputation(env, proved.code, { request: stricterSameNonce, presentation: proved.presentation })).reason).toMatch(/proves less than the request asks \(minLoans\)/);
    // without a request: audience and the nonce are both required
    expect((await verifyReputation(env, proved.code, { audience: 'acme-desk', presentation: proved.presentation })).reason).toMatch(/give the nonce/);
    expect(await verifyReputation(env, proved.code, { audience: 'acme-desk', nonce: '0x' + p.nonce.toString(16), presentation: proved.presentation })).toMatchObject({ ok: true });
    // a bearer code (bindTo 0) is refused unless allowBearer
    const bearer = encodeRepCode(CTX, { ...p, bindTo: 0n });
    expect((await verifyReputation(env, bearer, { request: ask.code })).reason).toMatch(/bearer/);
  });

  it('refuses: expired, too long-lived, unknown root, tampered inputs or proof', async () => {
    const p = decodeRepCode(CTX, proved.code);
    const now = Number(p.expiry);
    expect((await verifyReputation(env, proved.code, { request: ask.code, presentation: proved.presentation, now: now + 1 })).reason).toMatch(/expired/);
    expect((await verifyReputation(env, proved.code, { request: ask.code, presentation: proved.presentation, now: now - 86_401 })).reason).toMatch(/more than a day/);
    // the chain's root moved on and the old one is gone from the ring
    w.setRoot(123n);
    expect((await verifyReputation(env, proved.code, { request: ask.code, presentation: proved.presentation })).reason).toMatch(/root this chain does not know/);
    w.setRoot(w.tree.root);
    // tampered public input (the code states a bigger volume than was proven) and tampered proof bytes
    const bigger = encodeRepCode(CTX, { ...p, minVolume: p.minVolume + 1n });
    expect((await verifyReputation(env, bigger, { request: ask.code, presentation: proved.presentation })).reason).toMatch(/does not verify/);
    const bytes = Uint8Array.from(p.proof); bytes[100] ^= 1;
    expect((await verifyReputation(env, encodeRepCode(CTX, { ...p, proof: bytes }), { request: ask.code, presentation: proved.presentation })).reason).toMatch(/does not verify/);
    expect(await verifyReputation(env, proved.code, { request: ask.code, presentation: proved.presentation })).toMatchObject({ ok: true });
  });

  it(`refuses a ${REP_MAX_SETS_PER_DAY + 1}th distinct threshold set for one audience in a day`, async () => {
    const e = envFor(master, w);
    const sets = [{ minLoans: 1 }, { minLoans: 2 }, { minLoans: 3 }, { minLoans: 1, minVolume: '10' }];
    for (const s of sets) await proveReputation(e, { audience: 'probe-me', ...s });
    await proveReputation(e, { audience: 'probe-me', minLoans: 2 }); // a repeat is fine
    await expect(proveReputation(e, { audience: 'probe-me', minLoans: 1, minVolume: '25' })).rejects.toThrow(/narrow down your exact volume/);
    await proveReputation(e, { audience: 'another-audience', minLoans: 1, minVolume: '25' });
  }, 600_000);

  it('another account cannot prove from these loans', async () => {
    const e = envFor(0x999n, w);
    await expect(proveReputation(e, { audience: 'acme-desk', minLoans: 1 })).rejects.toThrow(/ReputationUnreachable/);
  });

  it(`fresh audience names do not reset the cap: after ${REP_MAX_SETS_PER_DAY_ALL} sets across audiences a 5th audience is refused before proving (no cache dir: kept in memory)`, async () => {
    const e = { ...envFor(master, w), cacheDir: undefined };
    for (let i = 0; i < REP_MAX_SETS_PER_DAY_ALL; i++) checkProbeCap(e, audienceOf(`acme-${1 + (i % 4)}`), set(i + 1));
    const prove = vi.spyOn(e.prover, 'prove');
    await expect(proveReputation(e, { audience: 'acme-5', minLoans: 1, minVolume: '25' })).rejects.toThrow(/across all audiences/);
    expect(prove).not.toHaveBeenCalled();
  }, 300_000);
});

/** Threshold set number i (distinct for each i). */
const set = (i: number): RepThresholds => ({ minLoans: i, minVolume: 0n, minLenders: 0, minSpanDays: 0, minMonths: 0, monthFloor: 0n });

describe('the probing cap (prover side)', () => {
  const master = 0x4242n;
  const fresh = () => envFor(master, world(master));

  it(`5 different audience names on one day: ${REP_MAX_SETS_PER_DAY_ALL} distinct sets in all, then refused; a set already proven today stays free`, () => {
    const e = fresh();
    const names = ['acme-1', 'acme-2', 'acme-3', 'acme-4', 'acme-5'];
    let n = 0;
    // two sets per audience: the 9th distinct set (acme-5's second) is refused although acme-5 has had only one
    for (const name of names) {
      for (let j = 0; j < 2; j++) {
        n++;
        if (n <= REP_MAX_SETS_PER_DAY_ALL) checkProbeCap(e, audienceOf(name), set(n));
        else expect(() => checkProbeCap(e, audienceOf(name), set(n))).toThrow(new RegExp(`already proved ${REP_MAX_SETS_PER_DAY_ALL} different reputation thresholds today across all audiences`));
      }
    }
    expect(n).toBe(10);
    // repeating a set some audience already got today adds nothing new, so it is allowed for another audience too
    checkProbeCap(e, audienceOf('acme-5'), set(3));
    // the next day starts over
    checkProbeCap(e, audienceOf('acme-5'), set(9), undefined, Date.now() + 86_400_000);
  });

  it(`one bindTo key under fresh audience names gets at most ${REP_MAX_SETS_PER_DAY} distinct sets a day`, () => {
    const e = fresh();
    const key = 0xb1dn;
    for (let i = 1; i <= REP_MAX_SETS_PER_DAY; i++) checkProbeCap(e, audienceOf(`desk-${i}`), set(i), key);
    expect(() => checkProbeCap(e, audienceOf('desk-9'), set(9), key)).toThrow(/the key this proof would be bound to already received/);
    // another key (or a fresh session key, which is not passed) is not held back by it
    checkProbeCap(e, audienceOf('desk-9'), set(9), 0xc0ffeen);
  });

  it('without a cache dir the log is kept in memory for the process (never skipped); a deleted cache file does not reset it', () => {
    const e = fresh();
    const mem = { ...e, cacheDir: undefined };
    for (let i = 1; i <= REP_MAX_SETS_PER_DAY; i++) checkProbeCap(mem, audienceOf('one-desk'), set(i));
    expect(() => checkProbeCap({ ...e, cacheDir: undefined }, audienceOf('one-desk'), set(5))).toThrow(/this audience already received/);
    // the same signer with a cache dir whose file is gone still sees what this process proved
    const dir = mkdtempSync(join(tmpdir(), 'h081-probe-'));
    expect(() => checkProbeCap({ ...e, cacheDir: dir }, audienceOf('one-desk'), set(5))).toThrow(/this audience already received/);
  });
});

describe('reputationAttest (borrower side) hands loans to the relayer queue', () => {
  it('posts each loan once, in random order; 202 = queued (attested by the sweep), a refusal is reported; an older relayer that attests at once still works', async () => {
    const posted: string[] = [];
    const e: RepEnv = {
      ...envFor(0x77n, world(0x77n)),
      fetch: (async (_u: string, init?: RequestInit) => {
        const ref = (JSON.parse(String(init!.body)) as { loanRef: string }).loanRef;
        posted.push(ref);
        if (ref === '9') return new Response(JSON.stringify({ error: { code: 'below_floor', message: 'too small' } }), { status: 402 });
        if (ref === '8') return new Response(JSON.stringify({ signature: 'sigOld', loanRef: ref }), { status: 200 });
        return new Response(JSON.stringify({ queued: true, loanRef: ref, note: 'queued' }), { status: 202 });
      }) as typeof fetch,
    };
    const refs = Array.from({ length: 12 }, (_, i) => BigInt(i + 10));
    const plan = await reputationAttest(e, { loanRefs: refs });
    expect(plan).toMatchObject({ sent: false, plan: { via: expect.stringMatching(/queue/) } });
    expect(posted).toEqual([]);
    const r = await reputationAttest(e, { loanRefs: [...refs, 8n, 9n], confirm: true }) as RepAttestResult;
    expect([...posted].sort()).toEqual([...refs, 8n, 9n].map(String).sort());
    expect(posted).not.toEqual([...refs, 8n, 9n].map(String)); // shuffled (12! orders: the given one is ~2e-9 likely)
    expect([...r.queued].sort()).toEqual(refs.map(String).sort());
    expect(r.attested).toEqual(['8']);
    expect(r.signatures).toEqual(['sigOld']);
    expect(r.failed).toEqual([{ loanRef: '9', error: 'too small' }]);
    expect(r.note).toMatch(/next sweep/);
  });
});

describe.skipIf(!haveArtifacts)('the one-call prove: { audience, minLoans, minVolume } and the verifier nonce (dev setup)', () => {
  const master = 0x5151n;
  it('returns the audience and nonce it answers; a verifier checks with { audience, nonce }; a bad nonce is refused before proving', async () => {
    const w = world(master);
    const e = envFor(master, w);
    const given = await proveReputation(e, { audience: 'acme-desk', minLoans: 3, minVolume: '50', nonce: '0xabc123' });
    expect(BigInt(given.nonce)).toBe(0xabc123n);
    expect(BigInt(given.audience)).toBe(audienceOf('acme-desk'));
    expect(await verifyReputation(e, given.code, { audience: 'acme-desk', nonce: '0xabc123', presentation: given.presentation })).toMatchObject({ ok: true });
    expect((await verifyReputation(e, given.code, { audience: 'acme-desk', nonce: '0xabc124', presentation: given.presentation })).reason).toMatch(/another challenge/);
    // without a nonce: a fresh one, returned so the prover can hand it over with the code
    const fresh = await proveReputation(e, { audience: 'acme-desk', minLoans: 3, minVolume: '50' });
    expect(fresh.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(VerifyRepZ.safeParse({ code: fresh.code, audience: 'acme-desk', nonce: fresh.nonce, presentation: fresh.presentation }).success).toBe(true);
    expect(await verifyReputation(e, fresh.code, { audience: 'acme-desk', nonce: fresh.nonce, presentation: fresh.presentation })).toMatchObject({ ok: true });
    // a request's own nonce, as reputationRequest prints it, passes the schema too
    expect(VerifyRepZ.safeParse({ code: fresh.code, audience: 'acme-desk', nonce: reputationRequest(e, { audience: 'acme-desk' }).nonce }).success).toBe(true);
    await expect(proveReputation(e, { audience: 'acme-desk', minLoans: 1, nonce: '0x0' })).rejects.toThrow(/nonce must be between 1 and 2\^248/);
    await expect(proveReputation(e, { audience: 'acme-desk', minLoans: 1, nonce: '0x' + '1'.padEnd(63, '0') })).rejects.toThrow(/nonce must be between/);
  }, 300_000);
});

describe.skipIf(!haveArtifacts)('review pass 4: who chose the nonce, the thresholds a verifier asks for, and an on-chain check that could not run (dev setup)', () => {
  const master = 0x6161n;
  let w: ReturnType<typeof world>;
  let e: RepEnv;
  let fresh: Awaited<ReturnType<typeof proveReputation>>;
  beforeAll(async () => {
    w = world(master);
    e = envFor(master, w);
    fresh = await proveReputation(e, { audience: 'acme-desk', minLoans: 3, minVolume: '50' });
  }, 300_000);

  it('the result says who chose the challenge: a prover-drawn nonce is labelled, and the next step says it proves no freshness', async () => {
    expect(fresh.challenge).toBe('prover-chosen');
    expect(fresh.next).toMatch(/proves no freshness/);
    const given = await proveReputation(e, { audience: 'acme-desk', minLoans: 3, minVolume: '50', nonce: '0x77' });
    expect(given.challenge).toBe('verifier');
    expect(given.next).not.toMatch(/proves no freshness/);
    const ask = reputationRequest(e, { audience: 'acme-desk', minLoans: 3, minVolume: '50' });
    expect((await proveReputation(e, { request: ask.code })).challenge).toBe('request');
    // the verify error without a nonce no longer claims the nonce must be one the verifier issued
    const r = await verifyReputation(e, fresh.code, { audience: 'acme-desk', presentation: fresh.presentation });
    expect(r.reason).toMatch(/give the nonce/);
    expect(r.reason).toMatch(/proves no freshness/);
  }, 300_000);

  it('a verifier without a request can state the thresholds it requires: a weaker code is refused, a matching one passes', async () => {
    const base = { audience: 'acme-desk', nonce: fresh.nonce, presentation: fresh.presentation };
    expect(await verifyReputation(e, fresh.code, base)).toMatchObject({ ok: true, thresholds: { minLoans: 3, minVolume: '50' } });
    expect((await verifyReputation(e, fresh.code, { ...base, minLoans: 4 })).reason).toMatch(/proves less than you ask \(minLoans\)/);
    expect((await verifyReputation(e, fresh.code, { ...base, minVolume: '50.000001' })).reason).toMatch(/proves less than you ask \(minVolume\)/);
    expect((await verifyReputation(e, fresh.code, { ...base, minLoans: 3, minLenders: 3, minSpanDays: 1 })).reason).toMatch(/\(minLenders, minSpanDays\)/);
    expect((await verifyReputation(e, fresh.code, { ...base, minMonths: 1, monthFloor: '1' })).reason).toMatch(/minMonths/);
    expect(await verifyReputation(e, fresh.code, { ...base, minLoans: 3, minVolume: '50' })).toMatchObject({ ok: true });
    expect(await verifyReputation(e, fresh.code, { ...base, minLoans: 2, minVolume: '25' })).toMatchObject({ ok: true });
    expect((await verifyReputation(e, fresh.code, { ...base, minVolume: 'lots' })).reason).toMatch(/minVolume must be an amount/);
    // a request carries its own thresholds: extra ones next to it are refused, not silently ignored
    expect((await verifyReputation(e, fresh.code, { request: reputationRequest(e, { audience: 'acme-desk' }).code, minLoans: 1 })).reason).toMatch(/carries the thresholds/);
  }, 300_000);

  it('onChain: a fee payer that cannot pay, a transaction the cluster rejects before the program, or an RPC failure is "could not run"; a program error is a refusal', async () => {
    const blockhash = Keypair.generate().publicKey.toBase58();
    const chain = (balance: number, sim: () => Promise<unknown>) => ({
      ...envFor(master, w),
      connection: {
        ...w.connection,
        getBalance: async () => balance,
        getFeeForMessage: async () => ({ value: 5000 }),
        getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 1 }),
        simulateTransaction: sim,
      } as unknown as Connection,
    });
    const opts = { audience: 'acme-desk', nonce: fresh.nonce, presentation: fresh.presentation, onChain: true };
    // 1 lamport: below the fee, said before simulating
    const sim = vi.fn(async () => ({ value: { err: 'InsufficientFundsForFee', logs: [], unitsConsumed: 0 } }));
    const dust = await verifyReputation(chain(1, sim), fresh.code, opts);
    expect(dust).toMatchObject({ ok: false, onChain: { ok: false, ran: false } });
    expect(dust.reason).toMatch(/could not run: .*1 lamports.*at least 5000 lamports/);
    expect(dust.reason).not.toMatch(/refused it/);
    // enough by the balance, but the cluster still rejects the transaction before the program runs
    for (const err of ['InsufficientFundsForFee', 'AccountNotFound', 'BlockhashNotFound']) {
      const r = await verifyReputation(chain(10_000, async () => ({ value: { err, logs: [], unitsConsumed: 0 } })), fresh.code, opts);
      expect(r).toMatchObject({ ok: false, onChain: { ok: false, ran: false } });
      expect(r.reason).toMatch(new RegExp(`could not run: .*${err}`));
    }
    // the RPC itself fails
    const down = await verifyReputation(chain(10_000, async () => { throw new Error('fetch failed'); }), fresh.code, opts);
    expect(down).toMatchObject({ ok: false, onChain: { ok: false, ran: false } });
    expect(down.reason).toMatch(/could not run: .*fetch failed/);
    // the program ran and refused: a refusal
    const refused = await verifyReputation(chain(10_000, async () => ({ value: { err: { InstructionError: [1, { Custom: 6000 }] }, logs: ['Program log: custom program error: 0x1770'], unitsConsumed: 1234 } })), fresh.code, opts);
    expect(refused.onChain?.ran).toBeUndefined();
    expect(refused.reason).toMatch(/^verify_reputation refused it: /);
    const passed = await verifyReputation(chain(10_000, async () => ({ value: { err: null, logs: [], unitsConsumed: 146_541 } })), fresh.code, opts);
    expect(passed).toMatchObject({ ok: true, onChain: { ok: true, computeUnits: 146_541 } });
  }, 300_000);
});
