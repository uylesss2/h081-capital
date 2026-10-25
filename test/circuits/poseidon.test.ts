// The pure-BigInt Poseidon (used by the browser demo) must agree with
// circomlibjs (used by the SDK and the circuits) for every width we use.
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initCrypto, poseidon, randomField, allowanceCommitment, policyHash } from '../../src/crypto.js';
import { makePoseidon } from '../../src/poseidon-pure.js';

describe('pure Poseidon', () => {
  let pure: (inputs: bigint[]) => bigint;
  beforeAll(async () => {
    await initCrypto();
    pure = makePoseidon(JSON.parse(readFileSync(resolve(import.meta.dirname, '../../src/poseidon-constants.json'), 'utf8')));
  });

  it('matches circomlibjs for 1 to 10 inputs', () => {
    for (let n = 1; n <= 10; n++) {
      for (let k = 0; k < 3; k++) {
        const inputs = Array.from({ length: n }, () => randomField());
        expect(pure(inputs)).toBe(poseidon(inputs));
      }
      expect(pure(new Array(n).fill(0n))).toBe(poseidon(new Array(n).fill(0n)));
    }
  });

  it('reproduces an allowance commitment end to end', () => {
    const a = {
      asset: 0x1111n, remaining: 500n, agentPk: randomField(), windowId: 3n, windowSpent: 7n, rho: randomField(),
      policy: { lifetimeCap: 1000n, windowCap: 300n, windowLen: 86400n, maxPerTx: 100n, expiry: 0n, recipientRoot: 0n, ownerPk: randomField(), streamRate: 0n, streamStart: 0n },
    };
    const ph = pure([5n, a.policy.lifetimeCap, a.policy.windowCap, a.policy.windowLen, a.policy.maxPerTx, a.policy.expiry, a.policy.recipientRoot, a.policy.ownerPk, a.policy.streamRate, a.policy.streamStart]);
    expect(ph).toBe(policyHash(a.policy));
    expect(pure([4n, a.asset, a.remaining, a.agentPk, ph, a.windowId, a.windowSpent, a.rho])).toBe(allowanceCommitment(a));
  });
});
