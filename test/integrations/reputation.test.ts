// Private reputation, bank level (integrations/core/reputation.ts) with real proofs from the DEV reputation setup
// (build/circuits/reputation) over a mocked chain: request -> prove -> verify, and every way a verifier must refuse.
// Also the ladder, loan selection and the kind 7/8/9 codes. No validator.
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
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
  CODE_KIND, PREFIX_KIND, decodeRepCode, decodeRepRequest, encodeRepCode, encodeRepRequest, encodeRepSig, repPresentationMessage, type CodeContext,
} from '../../integrations/core/codes.js';
import { proveReputation, reputationRequest, verifyReputation, type RepEnv, REP_MAX_SETS_PER_DAY } from '../../integrations/core/reputation.js';
import type { H081Config } from '../../integrations/core/constants.js';

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
});
