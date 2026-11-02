// Pure-model property test for design 2.6's last invariant: over any sequence
// of spends, lender claims and delegations, the lender never receives more
// than floor(lifetimeCap * pledgeBps / 10000) across the whole tree of notes.
// No circuits, no chain: spendAllowance and delegateInput are the model.
import { beforeAll, describe, expect, it } from 'vitest';
import { Allowance, initCrypto, lenderClaimable, lenderKey, randomField, randomKeys, shareOf, spendAllowance } from '../../src/crypto.js';
import { MerkleTree } from '../../src/merkle.js';
import { LEVELS, delegateInput, type SubGrant } from '../../src/inputs.js';

const LENDER = { lenderAddr: 0xbeefn, loanRef: 1n };

describe('pure model: lender total bound (design 2.6)', () => {
  beforeAll(initCrypto);

  it('random spends, claims and delegations never route more than the lifetime share in total', () => {
    let seed = 20261026;
    const rnd = (n: bigint) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return BigInt(seed) % (n + 1n); };
    const agent = randomKeys();
    const owner = randomKeys();
    const tree = new MerkleTree(LEVELS);
    const path = tree.emptyPath(); // no witness is computed, the path is a placeholder
    let delegations = 0;
    let refusals = 0;
    let claims = 0;

    for (let run = 0; run < 300; run++) {
      const L = 1n + rnd(10_000n);
      const bps = 1n + rnd(9999n);
      const rate = rnd(2n) === 0n ? 0n : 4n + rnd(20n);
      const t0 = 1_800_000_000n;
      const notes: Allowance[] = [{
        asset: 1n, remaining: L, agentPk: agent.pk, windowId: 0n, windowSpent: 0n, rho: randomField(), pledgePaid: 0n,
        policy: {
          lifetimeCap: L, windowCap: 0n, windowLen: 86400n, maxPerTx: 0n, expiry: 0n, recipientRoot: 0n, ownerPk: owner.pk,
          streamRate: rate, streamStart: t0, lender: lenderKey(LENDER.lenderAddr, LENDER.loanRef), pledgeBps: bps,
        },
      }];
      let t = t0;
      let routed = 0n;
      for (let step = 0; step < 20; step++) {
        t += rnd(3000n);
        const live = notes.filter((n) => n.remaining > 0n);
        if (live.length === 0) break;
        const i = notes.indexOf(live[Number(rnd(BigInt(live.length - 1)))]);
        const a = notes[i];
        const action = rnd(2n);
        if (action === 0n) {
          // the lender pulls part of the vested share
          const c = lenderClaimable(a, t);
          if (c === 0n) continue;
          const amount = 1n + rnd(c - 1n);
          notes[i] = spendAllowance(a, amount, t, false, true);
          routed += amount;
          claims++;
        } else if (action === 1n) {
          // an agent or owner spend; the share is the same either way
          const amount = 1n + rnd(a.remaining - 1n);
          const next = spendAllowance(a, amount, t, true);
          routed += next.pledgePaid - a.pledgePaid;
          notes[i] = next;
        } else {
          // delegate one or two subs, keeping the rest; a pledged parent passes its pledge on
          const r = a.policy.streamRate;
          const first = 1n + rnd(a.remaining - 1n);
          const second = rnd(a.remaining - first);
          const subs: SubGrant[] = [{ agentPk: agent.pk, amount: first, streamRate: r === 0n ? undefined : 1n }];
          if (second > 0n) subs.push({ agentPk: agent.pk, amount: second, streamRate: r === 0n ? undefined : 1n });
          // the residual keeps at least one unit of rate after the subs and the three placeholders
          if (r !== 0n && r < 4n + BigInt(subs.length)) continue;
          try {
            const d = delegateInput({ root: tree.root, allowance: a, path, agent, subs, now: t, lender: LENDER, extDataHash: 1n });
            notes[i] = d.residual;
            notes.push(...d.subs.slice(0, subs.length));
            delegations++;
          } catch (e) {
            // only one rule may refuse: the residual's share must still cover what the lender was paid
            expect(String(e)).toMatch(/lender/);
            refusals++;
          }
        }
        const total = notes.reduce((s, n) => s + n.pledgePaid, 0n);
        expect(total).toBe(routed);
        expect(total).toBeLessThanOrEqual(shareOf(L, bps));
        for (const n of notes) {
          expect(n.remaining).toBeGreaterThanOrEqual(0n);
          expect(n.pledgePaid).toBeLessThanOrEqual(shareOf(n.policy.lifetimeCap, bps));
          expect(n.policy.pledgeBps).toBe(bps);
        }
      }
    }
    // every path was exercised
    expect(delegations).toBeGreaterThan(0);
    expect(refusals).toBeGreaterThan(0);
    expect(claims).toBeGreaterThan(0);
  });
});
