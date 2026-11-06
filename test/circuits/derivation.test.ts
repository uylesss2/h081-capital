// What a note already consumed survives every derivation (fixes of 2026-11-05, after an external report on
// delegate.circom). Each case shows the attack as the SDK would have built it, then the forged witness with
// every signal set, so the rejection comes from the new constraint and nothing else. Witness generation only.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Allowance, type Policy, type SpendingKey, addressKey, allowanceCommitment, availableNow, initCrypto, lenderKey, randomField, randomKeys, receiptCommitment,
} from '../../src/crypto.js';
import { LEVELS, delegateInput, minRemainingFor, spendInput, streamInput, subStreamStartFloor } from '../../src/inputs.js';
import { MerkleTree } from '../../src/merkle.js';
import { type CircuitName, Prover } from '../../src/prover.js';

const prover = new Prover();
const ASSET = 0x1111111111111111111111111111111111111111n;
const DAY = 86400n;
const LENDER = { lenderAddr: 0x00000000000000000000000000000000deadbeefn, loanRef: 7n };
const now = 1_800_000_000n;
const boundary = (now / DAY + 1n) * DAY;

let owner: SpendingKey;
let agent: SpendingKey;

function policy(over: Partial<Policy> = {}): Policy {
  return { lifetimeCap: 0n, windowCap: 0n, windowLen: DAY, maxPerTx: 0n, expiry: 0n, recipientRoot: 0n, ownerPk: owner.pk, streamRate: 0n, streamStart: 0n, lender: 0n, pledgeBps: 0n, ...over };
}
function fresh(amount: bigint, over: Partial<Policy> = {}): Allowance {
  return { asset: ASSET, remaining: amount, agentPk: agent.pk, policy: policy({ lifetimeCap: amount, ...over }), windowId: 0n, windowSpent: 0n, rho: randomField(), pledgePaid: 0n };
}
function pledged(amount: bigint, bps: bigint, over: Partial<Policy> = {}): Allowance {
  return fresh(amount, { ...over, lender: lenderKey(LENDER.lenderAddr, LENDER.loanRef), pledgeBps: bps });
}
function inTree(a: Allowance) {
  const t = new MerkleTree(LEVELS);
  const i = t.insert(allowanceCommitment(a));
  return { root: t.root, allowance: a, path: t.path(i) };
}
async function accepts(name: CircuitName, input: Record<string, unknown>) {
  await expect(prover.witness(name, input as never)).resolves.toBeUndefined();
}
async function rejects(name: CircuitName, input: Record<string, unknown>) {
  await expect(prover.witness(name, input as never)).rejects.toThrow();
}

beforeAll(async () => {
  await initCrypto();
  owner = randomKeys();
  agent = randomKeys();
});

describe('consumed counters survive derivation', () => {
  it('spend: the window never moves backwards, so a `now` on the other side of a boundary cannot forget windowSpent', async () => {
    const a = fresh(100_000n, { windowCap: 1_000n });
    // the whole cap, just after the boundary (window W+1)
    const first = spendInput({ ...inTree(a), spender: agent, amount: 1_000n, now: boundary, publicTo: 1n, extDataHash: 1n });
    await accepts('spend', first.input);
    const q = inTree(first.next);
    // the SDK refuses a spend dated in window W
    expect(() => spendInput({ ...q, spender: agent, amount: 1_000n, now: boundary - 1n, publicTo: 1n, extDataHash: 1n })).toThrow(/before the note's window/);
    expect(availableNow(first.next, boundary - 1n)).toBe(0n);
    // a hand-made witness for it (what the old circuit accepted: "new" window, windowSpent reset to the amount)
    const fwd = spendInput({ ...q, spender: agent, amount: 1_000n, now: boundary + DAY, publicTo: 1n, extDataHash: 1n });
    await accepts('spend', fwd.input);
    const W = boundary / DAY - 1n;
    const back = { ...fwd.next, windowId: W, windowSpent: 1_000n };
    await rejects('spend', { ...fwd.input, now: boundary - 1n, newAllowanceCommitment: allowanceCommitment(back), receipt: receiptCommitment(ASSET, 1_000n, addressKey(1n), W, fwd.nullifier) });
    // the owner's reclaim obeys it too (it rewrites the note's window)
    const reclaim = spendInput({ ...q, spender: owner, amount: 10n, now: boundary + DAY, shieldedTo: { pk: owner.pk }, extDataHash: 1n });
    await accepts('spend', reclaim.input);
    const backOwner = { ...reclaim.next, windowId: W, windowSpent: 0n };
    await rejects('spend', { ...reclaim.input, now: boundary - 1n, newAllowanceCommitment: allowanceCommitment(backOwner), receipt: receiptCommitment(ASSET, 10n, owner.pk, W, reclaim.nullifier) });
    expect(() => spendInput({ ...q, spender: owner, amount: 10n, now: boundary - 1n, shieldedTo: { pk: owner.pk }, extDataHash: 1n })).toThrow(/before the note's window/);
  });

  it('spend: a lender claim dated in an earlier window is still fine, because it leaves the window untouched', async () => {
    const a = { ...pledged(100_000n, 4_000n, { windowCap: 1_000n, streamRate: 10n, streamStart: now - 10_000n }), windowId: boundary / DAY, windowSpent: 1_000n, remaining: 99_000n };
    const p = inTree(a);
    const claim = spendInput({ ...p, claim: true, lender: LENDER, amount: 100n, now: boundary - 1n, extDataHash: 1n });
    await accepts('spend', claim.input);
    expect(claim.next.windowId).toBe(boundary / DAY);
    expect(claim.next.windowSpent).toBe(1_000n);
  });

  it('delegate: subs inherit what the parent already spent this window, so self-delegation cannot reset the cap', async () => {
    // the parent spent its whole window; the residual is empty (cap 0), so the subs must carry all 500
    const parent = { ...fresh(10_000n, { windowCap: 500n }), remaining: 9_500n, windowId: now / DAY, windowSpent: 500n };
    const p = inTree(parent);
    const d = delegateInput({ ...p, agent, subs: [{ agentPk: agent.pk, amount: 9_500n, windowCap: 497n }], now, extDataHash: 1n });
    await accepts('delegate', d.input);
    expect(d.subs.map((s) => s.windowSpent)).toEqual([497n, 1n, 1n, 1n]); // 497 + three placeholders at 1 each
    // the forged version (every sub fresh) has no proof
    const forged = d.subs.map((s) => ({ ...s, windowSpent: 0n }));
    await rejects('delegate', { ...d.input, subWindowSpent: [0n, 0n, 0n, 0n], subCommitment: forged.map(allowanceCommitment) });
    // nor one that under-reports by a single unit
    const short = d.subs.map((s, i) => (i === 0 ? { ...s, windowSpent: 496n } : s));
    await rejects('delegate', { ...d.input, subWindowSpent: [496n, 1n, 1n, 1n], subCommitment: short.map(allowanceCommitment) });
    // the honest sub cannot spend this window and can next window
    const s = inTree(d.subs[0]);
    expect(availableNow(d.subs[0], now)).toBe(0n);
    const next = spendInput({ ...s, spender: agent, amount: 497n, now: now + DAY, publicTo: 1n, extDataHash: 1n });
    await accepts('spend', next.input);
    const sameWindow = { ...next.next, windowId: now / DAY, windowSpent: 497n + 497n };
    await rejects('spend', { ...next.input, now, newAllowanceCommitment: allowanceCommitment(sameWindow), receipt: receiptCommitment(ASSET, 497n, addressKey(1n), now / DAY, next.nullifier) });
    // a live residual absorbs its share: windowSpent 300 of cap 300, residual keeps cap 200, subs carry 100
    const half = { ...fresh(10_000n, { windowCap: 300n }), remaining: 9_000n, windowId: now / DAY, windowSpent: 300n };
    const d2 = delegateInput({ ...inTree(half), agent, subs: [{ agentPk: randomField(), amount: 1_000n, windowCap: 97n }], now, residualWindowCap: 200n, extDataHash: 1n });
    await accepts('delegate', d2.input);
    expect(d2.subs[0].windowSpent).toBe(97n);
    expect(d2.subs.slice(1).map((x) => x.windowSpent)).toEqual([1n, 1n, 1n]);
    expect(d2.residual.windowSpent).toBe(300n);
    // an uncapped parent's subs start at zero, and may not claim otherwise
    const open = { ...fresh(10_000n), remaining: 9_000n, windowId: now / DAY, windowSpent: 700n };
    const d3 = delegateInput({ ...inTree(open), agent, subs: [{ agentPk: randomField(), amount: 1_000n }], now, extDataHash: 1n });
    await accepts('delegate', d3.input);
    expect(d3.subs.every((x) => x.windowSpent === 0n)).toBe(true);
    const claim = d3.subs.map((x, i) => (i === 0 ? { ...x, windowSpent: 5n } : x));
    await rejects('delegate', { ...d3.input, subWindowSpent: [5n, 0n, 0n, 0n], subCommitment: claim.map(allowanceCommitment) });
  });

  it("delegate: a sub stream starts no earlier than the parent's start, than now, and than what the parent already drew", async () => {
    // rate 20/s since start; the parent drew 200,000 = exactly the 10,000 s of allotment up to now
    const start = now - 10_000n;
    const parent = { ...fresh(1_000_000n, { streamRate: 20n, streamStart: start }), remaining: 800_000n };
    expect(subStreamStartFloor(parent, now)).toBe(now);
    const p = inTree(parent);
    const d = delegateInput({ ...p, agent, subs: [{ agentPk: agent.pk, amount: 800_000n, streamRate: 17n }], now, extDataHash: 1n });
    await accepts('delegate', d.input);
    expect(d.subs[0].policy.streamStart).toBe(now);
    // back-dated by 900 s (what a `now` at the program's old look-back allowed): would re-mint 17 * 900 units
    expect(() => delegateInput({ ...p, agent, subs: [{ agentPk: agent.pk, amount: 800_000n, streamRate: 17n, streamStart: now - 900n }], now, extDataHash: 1n })).toThrow(/may not start before/);
    const early = d.subs.map((s) => ({ ...s, policy: { ...s.policy, streamStart: now - 900n } }));
    await rejects('delegate', { ...d.input, now: now - 900n, subStreamStart: early.map((s) => s.policy.streamStart), subCommitment: early.map(allowanceCommitment) });
    // a parent that drew more than its clock-time allotment (owner reclaims count): the floor is the frontier, after now
    const ahead = { ...fresh(1_000_000n, { streamRate: 20n, streamStart: now - 1_000n }), remaining: 800_000n };
    expect(subStreamStartFloor(ahead, now)).toBe(now - 1_000n + 10_000n);
    const da = delegateInput({ ...inTree(ahead), agent, subs: [{ agentPk: agent.pk, amount: 800_000n, streamRate: 17n }], now, extDataHash: 1n });
    await accepts('delegate', da.input);
    const atNow = da.subs.map((s) => ({ ...s, policy: { ...s.policy, streamStart: now } }));
    await rejects('delegate', { ...da.input, subStreamStart: atNow.map((s) => s.policy.streamStart), subCommitment: atNow.map(allowanceCommitment) });
    // a cliff: the parent's stream starts in 30 days; a sub starting today has no proof, one starting with the parent does
    const cliff = fresh(1_000n, { streamRate: 4n, streamStart: now + 30n * DAY });
    const dc = delegateInput({ ...inTree(cliff), agent, subs: [{ agentPk: agent.pk, amount: 1_000n, streamRate: 1n }], now, extDataHash: 1n });
    expect(dc.subs[0].policy.streamStart).toBe(now + 30n * DAY);
    await accepts('delegate', dc.input);
    const skip = dc.subs.map((s) => ({ ...s, policy: { ...s.policy, streamStart: now } }));
    await rejects('delegate', { ...dc.input, subStreamStart: skip.map((s) => s.policy.streamStart), subCommitment: skip.map(allowanceCommitment) });
    // the sub-agent sees only what the parent could have spent: nothing before the cliff, the rate after it
    const sub = inTree(dc.subs[0]);
    expect(availableNow(dc.subs[0], now + DAY)).toBe(0n);
    expect(availableNow(dc.subs[0], now + 31n * DAY)).toBe(1_000n > DAY ? DAY : 1_000n);
    await accepts('spend', spendInput({ ...sub, spender: agent, amount: 100n, now: now + 31n * DAY, publicTo: 1n, extDataHash: 1n }).input);
  });

  it('stream: only the agent or the owner can prove a stream; a lender holding the note cannot', async () => {
    const p = inTree(pledged(100_000n, 4_000n, { streamRate: 10n, streamStart: now - 100n }));
    const mine = streamInput({ ...p, lender: LENDER, spender: agent, minRemaining: 1n, minRate: 1n, audience: 1n });
    await accepts('stream', mine.input);
    await accepts('stream', { ...mine.input, sk: owner.sk });
    await rejects('stream', { ...mine.input, sk: randomKeys().sk });
    expect(() => streamInput({ ...p, lender: LENDER, spender: randomKeys(), minRemaining: 1n, minRate: 1n, audience: 1n })).toThrow(/only the agent or the owner/);
    expect(mine.publicSignals).toHaveLength(13); // unchanged: StreamArgs on chain stay the same
    // the bound a borrower proves for a given principal names the ask, not the balance
    expect(minRemainingFor(400n, 4_000n)).toBe(1_000n);
    expect(minRemainingFor(1n, 10_000n)).toBe(1n);
    expect(minRemainingFor(333n, 3_333n)).toBe(1_000n);
    for (const [principal, bps] of [[1n, 1n], [7n, 9_999n], [123_456_789n, 2_500n], [1n, 10_000n]] as const) {
      expect((minRemainingFor(principal, bps) * bps) / 10_000n).toBe(principal);
    }
  });
});
