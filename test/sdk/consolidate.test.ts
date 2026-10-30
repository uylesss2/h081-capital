// Note selection and the consolidation plan (pure; no chain, no proofs).
import { describe, expect, it } from 'vitest';
import { MAX_INPUTS, consolidationPlan, nextMerge, selectNotes } from '../../src/consolidate.js';

const id = (x: bigint) => x;

describe('note selection', () => {
  it('picks largest first and stops once the amount is covered', () => {
    expect(selectNotes([5n, 30n, 10n, 20n], id, 45n)).toEqual([30n, 20n]);
    expect(selectNotes([5n, 30n, 10n, 20n], id, 51n)).toEqual([30n, 20n, 10n]);
  });

  it('ignores zero notes, picks nothing for a zero amount, and refuses a short balance', () => {
    expect(selectNotes([0n, 0n, 7n], id, 7n)).toEqual([7n]);
    expect(selectNotes([3n], id, 0n)).toEqual([]);
    expect(() => selectNotes([3n, 4n], id, 8n)).toThrow('insufficient shielded balance: have 7, need 8');
  });
});

describe('consolidation plan', () => {
  it('needs no merge when two notes cover the amount', () => {
    expect(nextMerge([10n, 10n, 10n], id, 20n)).toBeUndefined();
    expect(consolidationPlan([10n, 10n, 10n], 20n)).toEqual([]);
  });

  it('merges the two smallest selected notes until two cover the amount', () => {
    // 4 notes of 10 for 35: select all four, merge 10+10, then select [20, 10, 10], merge 10+10, then [20, 20]
    expect(consolidationPlan([10n, 10n, 10n, 10n], 35n)).toEqual([[10n, 10n], [10n, 10n]]);
    // unselected notes are left alone
    expect(consolidationPlan([1n, 50n, 30n, 20n, 2n], 95n)).toEqual([[30n, 20n]]);
  });

  it('can merge down to a single note', () => {
    expect(consolidationPlan([10n, 10n, 10n], 30n, 1)).toEqual([[10n, 10n], [20n, 10n]]);
    expect(() => consolidationPlan([10n], 10n, 3)).toThrow(`maxInputs must be 1..${MAX_INPUTS}`);
  });

  it('every plan ends with at most two notes covering the amount, in at most selected - 2 merges', () => {
    let seed = 7n;
    const rnd = (n: bigint) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n); return seed % n; };
    for (let run = 0; run < 300; run++) {
      const count = Number(rnd(12n)) + 1;
      const amounts = Array.from({ length: count }, () => rnd(1000n) + 1n);
      const total = amounts.reduce((s, a) => s + a, 0n);
      const needed = rnd(total) + 1n;
      const steps = consolidationPlan(amounts, needed);
      expect(steps.length).toBeLessThanOrEqual(Math.max(0, selectNotes(amounts, id, needed).length - MAX_INPUTS));
      // replay the plan and check the end state
      const left = [...amounts];
      for (const [a, b] of steps) {
        left.splice(left.indexOf(a), 1);
        left.splice(left.indexOf(b), 1);
        left.push(a + b);
      }
      expect(left.reduce((s, a) => s + a, 0n)).toBe(total);
      expect(selectNotes(left, id, needed).length).toBeLessThanOrEqual(MAX_INPUTS);
    }
  });
});
