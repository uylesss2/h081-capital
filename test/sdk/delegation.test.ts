// Chained delegation plans (pure; no chain, no proofs): more than four subs
// split into delegate steps of four, each from the previous residual.
import { beforeAll, describe, expect, it } from 'vitest';
import { type Allowance, initCrypto, keysFromSk, lenderKey, randomField, shareOf } from '../../src/crypto.js';
import { LEVELS, type SubGrant } from '../../src/inputs.js';
import { MerkleTree } from '../../src/merkle.js';
import { planDelegation } from '../../src/delegation.js';

const NOW = 1_800_000_000n;
let agent: ReturnType<typeof keysFromSk>;
let path: ReturnType<MerkleTree['emptyPath']>;

function parent(over: Partial<Allowance['policy']> = {}, pledgePaid = 0n): Allowance {
  return {
    asset: 77n, remaining: 1_000n, agentPk: agent.pk, windowId: 0n, windowSpent: 0n, rho: randomField(), pledgePaid,
    policy: {
      lifetimeCap: 1_000n, windowCap: 900n, windowLen: 86400n, maxPerTx: 200n, expiry: NOW + 86400n, recipientRoot: 0n, ownerPk: 5n,
      streamRate: 0n, streamStart: 0n, lender: 0n, pledgeBps: 0n, ...over,
    },
  };
}

const subs = (n: number, s: Partial<SubGrant> = {}): SubGrant[] => Array.from({ length: n }, () => ({ agentPk: randomField(), amount: 100n, windowCap: 100n, ...s }));

beforeAll(async () => {
  await initCrypto();
  agent = keysFromSk(randomField());
  path = new MerkleTree(LEVELS).emptyPath();
});

describe('chained delegation plan', () => {
  it('four or fewer subs are one step, as before', () => {
    const plan = planDelegation(parent(), subs(3), { now: NOW, agent, path });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].subs).toHaveLength(3);
  });

  it('nine subs are three steps of 4, 4 and 1; earlier residuals keep everything not yet shared out', () => {
    const plan = planDelegation(parent(), subs(9, { amount: 50n, windowCap: 90n }), { now: NOW, agent, path });
    expect(plan.steps.map((s) => s.subs.length)).toEqual([4, 4, 1]);
    expect(plan.residuals.map((r) => r.remaining)).toEqual([800n, 600n, 550n]);
    expect(plan.residuals.map((r) => r.policy.lifetimeCap)).toEqual([800n, 600n, 550n]);
    // 900 - 4*90, then - 4*90, then - 90 and three placeholder slots of one unit each
    expect(plan.residuals.map((r) => r.policy.windowCap)).toEqual([540n, 180n, 87n]);
    // the residual is the parent's own line: same owner, window length, allow-list, expiry, per-tx cap, spent-so-far
    for (const r of plan.residuals) {
      expect(r.policy.maxPerTx).toBe(200n);
      expect(r.policy.expiry).toBe(NOW + 86400n);
      expect(r.policy.ownerPk).toBe(5n);
      expect(r.policy.lifetimeCap - r.remaining).toBe(0n);
    }
  });

  it('omitted sub fields default to the original parent, not to the shrinking residual', () => {
    const plan = planDelegation(parent({ windowCap: 0n }), subs(6, { windowCap: undefined }), { now: NOW, agent, path });
    for (const s of plan.steps.flatMap((x) => x.subs)) {
      expect(s.maxPerTx).toBe(200n);
      expect(s.expiry).toBe(NOW + 86400n);
      expect(s.windowCap).toBe(0n);
    }
  });

  it('the final residual takes the caller\'s cap and rate; window caps and stream rates over the chain sum to at most the parent\'s', () => {
    const P = parent({ streamRate: 1_000n, streamStart: NOW - 10n });
    const plan = planDelegation(P, subs(7, { windowCap: 100n, streamRate: 100n }), { now: NOW, agent, path, residualWindowCap: 150n, residualStreamRate: 200n });
    const all = plan.steps.flatMap((s) => s.subs);
    const last = plan.residuals[plan.residuals.length - 1];
    expect(last.policy.windowCap).toBe(150n);
    expect(last.policy.streamRate).toBe(200n);
    const placeholders = BigInt(4 - plan.steps[plan.steps.length - 1].subs.length);
    expect(all.reduce((s, x) => s + x.windowCap!, 0n) + placeholders + last.policy.windowCap).toBeLessThanOrEqual(P.policy.windowCap);
    expect(all.reduce((s, x) => s + x.streamRate!, 0n) + placeholders + last.policy.streamRate).toBeLessThanOrEqual(P.policy.streamRate);
    expect(last.policy.streamStart).toBe(P.policy.streamStart);
  });

  it('refuses an impossible chain before anything is sent: caps, amounts, residual needs', () => {
    expect(() => planDelegation(parent(), subs(11, { windowCap: 10n }), { now: NOW, agent, path })).toThrow('subs exceed remaining');
    expect(() => planDelegation(parent(), subs(9, { amount: 10n, windowCap: 101n }), { now: NOW, agent, path })).toThrow('window caps exceed the parent');
    expect(() => planDelegation(parent(), subs(6, { amount: 10n }), { now: NOW, agent, path, residualWindowCap: 0n })).toThrow('residual needs a window cap');
    expect(() => planDelegation(parent(), [], { now: NOW, agent, path })).toThrow('at least one sub');
  });

  it('a pledged parent passes its pledge down the chain; a chain that would shrink the lender\'s share below what it was paid is refused', () => {
    const lender = { lenderAddr: 0xabcn, loanRef: 3n };
    const P = parent({ lender: lenderKey(lender.lenderAddr, lender.loanRef), pledgeBps: 2_000n }, 100n);
    const ok = planDelegation(P, subs(5, { amount: 50n, windowCap: 10n }), { now: NOW, agent, path, lender });
    for (const r of ok.residuals) {
      expect(r.policy.pledgeBps).toBe(2_000n);
      expect(r.pledgePaid).toBe(100n);
      expect(shareOf(r.policy.lifetimeCap, 2_000n)).toBeGreaterThanOrEqual(100n);
    }
    // 1000 - 9*60 = 460, 20% of it is 92 < 100 already paid
    expect(() => planDelegation(P, subs(9, { amount: 60n, windowCap: 10n }), { now: NOW, agent, path, lender })).toThrow('shrink the lender');
  });
});
