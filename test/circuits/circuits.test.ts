// Constraint-level tests: every circuit accepts honest inputs and rejects
// each kind of dishonest one. Witness generation only (no proving) so the
// suite runs in seconds.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  Allowance, Note, Policy, SpendingKey, addressKey, allowanceCommitment, initCrypto, noteCommitment, randomField, randomKeys,
} from '../../src/crypto.js';
import { MerkleTree, recipientListRoot } from '../../src/merkle.js';
import { GRANT_OUTPUTS, LEVELS, delegateInput, discloseInput, dummyNoteInput, grantInput, spendInput, transactInput } from '../../src/inputs.js';
import { Prover, type CircuitName } from '../../src/prover.js';

const prover = new Prover();
const ASSET = 0x1111111111111111111111111111111111111111n;
const DAY = 86400n;

let owner: SpendingKey;
let agent: SpendingKey;
let tree: MerkleTree;

function policy(over: Partial<Policy> = {}): Policy {
  return { lifetimeCap: 0n, windowCap: 0n, windowLen: DAY, maxPerTx: 0n, expiry: 0n, recipientRoot: 0n, ownerPk: owner.pk, streamRate: 0n, streamStart: 0n, ...over };
}

function fresh(amount: bigint, over: Partial<Policy> = {}): Allowance {
  return { asset: ASSET, remaining: amount, agentPk: agent.pk, policy: policy({ lifetimeCap: amount, ...over }), windowId: 0n, windowSpent: 0n, rho: randomField() };
}

function note(amount: bigint, pk = owner.pk): Note {
  return { asset: ASSET, amount, pk, blinding: randomField() };
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
  tree = new MerkleTree(LEVELS);
});

describe('transact', () => {
  it('deposits into two fresh notes', async () => {
    const t = new MerkleTree(LEVELS);
    const { input } = transactInput({
      root: t.root, asset: ASSET,
      inputs: [dummyNoteInput(ASSET, owner, t), dummyNoteInput(ASSET, owner, t)],
      outputs: [note(700n), note(300n)],
      publicAmount: 1000n, extDataHash: 1n,
    });
    await accepts('transact', input);
    expect(input.publicAsset).toBe(ASSET);
  });

  it('shielded transfer hides the asset and withdraws with a fee', async () => {
    const t = new MerkleTree(LEVELS);
    const a = note(1000n);
    const idx = t.insert(noteCommitment(a));
    const transfer = transactInput({
      root: t.root, asset: ASSET,
      inputs: [{ note: a, keys: owner, path: t.path(idx) }, dummyNoteInput(ASSET, owner, t)],
      outputs: [note(400n, agent.pk), note(600n)],
      publicAmount: 0n, extDataHash: 2n,
    });
    expect(transfer.publicAsset).toBe(0n);
    await accepts('transact', transfer.input);

    const withdraw = transactInput({
      root: t.root, asset: ASSET,
      inputs: [{ note: a, keys: owner, path: t.path(idx) }, dummyNoteInput(ASSET, owner, t)],
      outputs: [note(500n), note(0n)],
      publicAmount: -500n, extDataHash: 3n, // 490 to recipient + 10 fee
    });
    await accepts('transact', withdraw.input);
  });

  it('rejects value creation, wrong owner and absent notes', async () => {
    const t = new MerkleTree(LEVELS);
    const a = note(1000n);
    const idx = t.insert(noteCommitment(a));
    const base = () => transactInput({
      root: t.root, asset: ASSET,
      inputs: [{ note: a, keys: owner, path: t.path(idx) }, dummyNoteInput(ASSET, owner, t)],
      outputs: [note(400n), note(600n)], publicAmount: 0n, extDataHash: 1n,
    }).input;

    await rejects('transact', { ...base(), outAmount: [400n, 601n] });
    await rejects('transact', { ...base(), inSk: [agent.sk, owner.sk] });
    const notInTree = note(1000n);
    await rejects('transact', transactInput({
      root: t.root, asset: ASSET,
      inputs: [{ note: notInTree, keys: owner, path: t.path(idx) }, dummyNoteInput(ASSET, owner, t)],
      outputs: [note(1000n), note(0n)], publicAmount: 0n, extDataHash: 1n,
    }).input);
    // revealing the asset on a shielded transfer is not allowed either
    await rejects('transact', { ...base(), publicAsset: ASSET });
  });
});

describe('grant', () => {
  it('funds three agents with distinct policies and returns change', async () => {
    const t = new MerkleTree(LEVELS);
    const a = note(5000n);
    const b = note(1000n);
    const ia = t.insert(noteCommitment(a));
    const ib = t.insert(noteCommitment(b));
    const g = grantInput({
      root: t.root, asset: ASSET, owner,
      inputs: [{ note: a, keys: owner, path: t.path(ia) }, { note: b, keys: owner, path: t.path(ib) }],
      allowances: [fresh(2000n, { windowCap: 500n }), fresh(1000n, { maxPerTx: 100n }), fresh(500n, { expiry: 1_900_000_000n })],
      change: note(2500n), totalSalt: randomField(), extDataHash: 9n,
    });
    expect(g.total).toBe(3500n);
    await accepts('grant', g.input);
  });

  it('rejects wrong sums, foreign notes and zero window length', async () => {
    const t = new MerkleTree(LEVELS);
    const a = note(5000n);
    const ia = t.insert(noteCommitment(a));
    const ok = grantInput({
      root: t.root, asset: ASSET, owner,
      inputs: [{ note: a, keys: owner, path: t.path(ia) }, dummyNoteInput(ASSET, owner, t)],
      allowances: [fresh(2000n)], change: note(3000n), totalSalt: 1n, extDataHash: 1n,
    });
    await accepts('grant', ok.input);
    await rejects('grant', { ...ok.input, changeAmount: 3001n });
    await rejects('grant', { ...ok.input, sk: agent.sk });
    await rejects('grant', { ...ok.input, windowLen: (ok.input.windowLen as bigint[]).map((_, i) => (i === 0 ? 0n : DAY)) });
  });
});

describe('spend', () => {
  let a: Allowance;
  let idx: number;
  beforeAll(() => {
    a = fresh(1000n, { windowCap: 300n, maxPerTx: 250n, expiry: 2_000_000_000n });
    idx = tree.insert(allowanceCommitment(a));
  });
  const now = 1_800_000_000n;

  it('agent pays a public recipient within every limit', async () => {
    const s = spendInput({ root: tree.root, allowance: a, path: tree.path(idx), spender: agent, amount: 200n, fee: 5n, now, publicTo: 0xabcdefn, extDataHash: 4n });
    await accepts('spend', s.input);
    expect(s.next.remaining).toBe(800n);
    expect(s.next.windowSpent).toBe(200n);
    expect(s.next.windowId).toBe(now / DAY);
  });

  it('agent pays a shielded recipient', async () => {
    const s = spendInput({ root: tree.root, allowance: a, path: tree.path(idx), spender: agent, amount: 100n, now, shieldedTo: { pk: randomKeys().pk }, extDataHash: 4n });
    await accepts('spend', s.input);
    expect(s.payCommitment).not.toBe(0n);
  });

  it('has no proof for a payment over the lifetime budget', async () => {
    await rejects('spend', spendInput({ root: tree.root, allowance: a, path: tree.path(idx), spender: agent, amount: 1001n, now, publicTo: 1n, extDataHash: 1n }).input);
  });

  it('has no proof over the per-transaction cap', async () => {
    await rejects('spend', spendInput({ root: tree.root, allowance: a, path: tree.path(idx), spender: agent, amount: 251n, now, publicTo: 1n, extDataHash: 1n }).input);
  });

  it('has no proof over the window cap, and the cap resets next window', async () => {
    // 200 already spent in this window (simulate the successor note)
    const after = spendInput({ root: tree.root, allowance: a, path: tree.path(idx), spender: agent, amount: 200n, now, publicTo: 1n, extDataHash: 1n }).next;
    const t2 = new MerkleTree(LEVELS);
    const i2 = t2.insert(allowanceCommitment(after));
    await rejects('spend', spendInput({ root: t2.root, allowance: after, path: t2.path(i2), spender: agent, amount: 101n, now: now + 60n, publicTo: 1n, extDataHash: 1n }).input);
    await accepts('spend', spendInput({ root: t2.root, allowance: after, path: t2.path(i2), spender: agent, amount: 100n, now: now + 60n, publicTo: 1n, extDataHash: 1n }).input);
    const nextDay = spendInput({ root: t2.root, allowance: after, path: t2.path(i2), spender: agent, amount: 250n, now: now + DAY, publicTo: 1n, extDataHash: 1n });
    await accepts('spend', nextDay.input);
    expect(nextDay.next.windowSpent).toBe(250n);
  });

  it('has no proof after expiry, nor for a time that disagrees with the window', async () => {
    await rejects('spend', spendInput({ root: tree.root, allowance: a, path: tree.path(idx), spender: agent, amount: 10n, now: 2_000_000_001n, publicTo: 1n, extDataHash: 1n }).input);
    const s = spendInput({ root: tree.root, allowance: a, path: tree.path(idx), spender: agent, amount: 10n, now, publicTo: 1n, extDataHash: 1n });
    // tamper the successor's window id
    await rejects('spend', { ...s.input, newAllowanceCommitment: allowanceCommitment({ ...s.next, windowId: s.next.windowId + 1n }) });
  });

  it('enforces the recipient allow-list for agents and not for owners', async () => {
    const vendorA = 0xaaaan;
    const vendorB = 0xbbbbn;
    const { root, tree: list } = recipientListRoot([addressKey(vendorA), addressKey(vendorB)]);
    const listed = fresh(1000n, { recipientRoot: root });
    const t2 = new MerkleTree(LEVELS);
    const i2 = t2.insert(allowanceCommitment(listed));
    await accepts('spend', spendInput({ root: t2.root, allowance: listed, path: t2.path(i2), spender: agent, amount: 10n, now, publicTo: vendorB, recipientPath: list.path(1), extDataHash: 1n }).input);
    await rejects('spend', spendInput({ root: t2.root, allowance: listed, path: t2.path(i2), spender: agent, amount: 10n, now, publicTo: 0xccccn, recipientPath: list.path(1), extDataHash: 1n }).input);
    // owner reclaims everything to an unlisted destination: no rules apply
    const reclaim = spendInput({ root: t2.root, allowance: listed, path: t2.path(i2), spender: owner, amount: 1000n, now, shieldedTo: { pk: owner.pk }, extDataHash: 1n });
    await accepts('spend', reclaim.input);
    expect(reclaim.next.remaining).toBe(0n);
    expect(reclaim.next.windowSpent).toBe(0n);
  });

  it('rejects a stranger, a mismatched nullifier and a public/shielded mix-up', async () => {
    const stranger = randomKeys();
    await rejects('spend', spendInput({ root: tree.root, allowance: a, path: tree.path(idx), spender: stranger, amount: 10n, now, publicTo: 1n, extDataHash: 1n }).input);
    const s = spendInput({ root: tree.root, allowance: a, path: tree.path(idx), spender: agent, amount: 10n, now, publicTo: 1n, extDataHash: 1n });
    await rejects('spend', { ...s.input, nullifier: (s.nullifier + 1n) });
    await rejects('spend', { ...s.input, publicAmount: 0n });
    await rejects('spend', { ...s.input, fee: 11n });
  });
});

describe('disclose', () => {
  it('proves remaining, spent and window-spent bounds as of a root', async () => {
    const a = fresh(1000n);
    const spent = { ...a, remaining: 640n, windowId: 20833n, windowSpent: 120n };
    const t = new MerkleTree(LEVELS);
    const i = t.insert(allowanceCommitment(spent));
    const base = { root: t.root, allowance: spent, path: t.path(i), audience: 77n };
    await accepts('disclose', discloseInput({ ...base, kind: 'remainingAtLeast', bound: 600n }).input);
    await rejects('disclose', discloseInput({ ...base, kind: 'remainingAtLeast', bound: 641n }).input);
    await accepts('disclose', discloseInput({ ...base, kind: 'spentAtMost', bound: 360n }).input);
    await rejects('disclose', discloseInput({ ...base, kind: 'spentAtMost', bound: 359n }).input);
    await accepts('disclose', discloseInput({ ...base, kind: 'windowSpentAtMost', bound: 120n }).input);
    await rejects('disclose', discloseInput({ ...base, kind: 'windowSpentAtMost', bound: 120n, windowId: 20834n }).input);
    await rejects('disclose', { ...discloseInput({ ...base, kind: 'remainingAtLeast', bound: 1n }).input, agentPk: randomKeys().pk });
  });
});

describe('streaming budgets', () => {
  const start = 1_800_000_000n;
  it('releases at the policy rate and refuses anything ahead of the stream', async () => {
    const a = fresh(100_000n, { streamRate: 10n, streamStart: start }); // 10 units per second
    const t = new MerkleTree(LEVELS);
    const i = t.insert(allowanceCommitment(a));
    const at = (now: bigint, amount: bigint) => spendInput({ root: t.root, allowance: a, path: t.path(i), spender: agent, amount, now, publicTo: 1n, extDataHash: 1n }).input;
    await accepts('spend', at(start + 100n, 1000n));   // exactly the allotment
    await rejects('spend', at(start + 100n, 1001n));   // one unit ahead
    await rejects('spend', at(start - 1n, 1n));        // before the stream starts
    // after 500 units were already spent, only the balance of the allotment is available
    const later = { ...a, remaining: 99_500n };
    const t2 = new MerkleTree(LEVELS);
    const i2 = t2.insert(allowanceCommitment(later));
    await accepts('spend', spendInput({ root: t2.root, allowance: later, path: t2.path(i2), spender: agent, amount: 500n, now: start + 100n, publicTo: 1n, extDataHash: 1n }).input);
    await rejects('spend', spendInput({ root: t2.root, allowance: later, path: t2.path(i2), spender: agent, amount: 501n, now: start + 100n, publicTo: 1n, extDataHash: 1n }).input);
    // the owner is not streamed
    await accepts('spend', spendInput({ root: t.root, allowance: a, path: t.path(i), spender: owner, amount: 100_000n, now: start + 1n, shieldedTo: { pk: owner.pk }, extDataHash: 1n }).input);
  });
});

describe('grant to sixteen agents', () => {
  it('funds every slot with its own policy in one proof', async () => {
    const t = new MerkleTree(LEVELS);
    const a = note(20_000n);
    const ia = t.insert(noteCommitment(a));
    const allowances = Array.from({ length: GRANT_OUTPUTS }, (_, k) => ({ ...fresh(1_000n, { windowCap: BigInt(100 + k), maxPerTx: BigInt(50 + k) }), agentPk: randomKeys().pk }));
    const g = grantInput({
      root: t.root, asset: ASSET, owner,
      inputs: [{ note: a, keys: owner, path: t.path(ia) }, dummyNoteInput(ASSET, owner, t)],
      allowances, change: note(4_000n), totalSalt: 1n, extDataHash: 1n,
    });
    expect(g.total).toBe(16_000n);
    await accepts('grant', g.input);
  });
});

describe('delegate', () => {
  const now = 1_800_000_000n;
  let parent: Allowance;
  let t: MerkleTree;
  let idx: number;
  const subA = randomField();
  const subB = randomField();
  beforeAll(() => {
    parent = { ...fresh(1_000n, { windowCap: 300n, maxPerTx: 100n, expiry: 1_900_000_000n, streamRate: 20n, streamStart: now - 1000n }), remaining: 800n, windowId: now / DAY, windowSpent: 120n };
    t = new MerkleTree(LEVELS);
    idx = t.insert(allowanceCommitment(parent));
  });
  const build = (subs: Parameters<typeof delegateInput>[0]['subs'], extra: Partial<Parameters<typeof delegateInput>[0]> = {}) =>
    delegateInput({ root: t.root, allowance: parent, path: t.path(idx), agent, subs, now, extDataHash: 3n, ...extra });

  it('splits an allowance into tighter sub-allowances and a residual', async () => {
    const d = build([
      { agentPk: subA, amount: 300n, windowCap: 100n, maxPerTx: 50n, expiry: 1_850_000_000n, streamRate: 5n },
      { agentPk: subB, amount: 200n, windowCap: 80n, maxPerTx: 100n, streamRate: 5n },
    ]);
    await accepts('delegate', d.input);
    expect(d.residual.remaining).toBe(300n);
    expect(d.residual.policy.lifetimeCap).toBe(500n);      // spent-so-far is preserved
    expect(d.residual.policy.windowCap).toBe(300n - 100n - 80n - 1n - 1n); // placeholders take 1 each
    expect(d.residual.windowSpent).toBe(120n);
    expect(d.subs[0].windowId).toBe(parent.windowId);
    expect(d.subs[0].policy.streamStart).toBe(now);
  });

  it('cannot loosen any rule, exceed the parent, or be done by anyone but the agent', async () => {
    const ok = build([{ agentPk: subA, amount: 100n, windowCap: 50n, maxPerTx: 50n, streamRate: 5n }]);
    await accepts('delegate', ok.input);
    // per-tx cap above the parent's
    await rejects('delegate', { ...ok.input, subMaxPerTx: [101n, 1n, 1n, 1n] });
    // expiry past the parent's
    await rejects('delegate', { ...ok.input, subExpiry: [1_900_000_001n, parent.policy.expiry, parent.policy.expiry, parent.policy.expiry] });
    // window caps that together exceed the parent's
    await rejects('delegate', { ...ok.input, resWindowCap: 300n });
    // stream rates that together exceed the parent's
    await rejects('delegate', { ...ok.input, resStreamRate: 20n });
    // a sub stream that starts in the past would inherit allotment the parent already used
    await rejects('delegate', { ...ok.input, subStreamStart: [now - 1n, now, now, now] });
    // an uncapped sub under a capped parent
    await rejects('delegate', { ...ok.input, subWindowCap: [0n, 1n, 1n, 1n] });
    // more than the parent has
    expect(() => build([{ agentPk: subA, amount: 801n }])).toThrow();
    // a stranger, and the owner (delegation is the agent's act)
    await rejects('delegate', { ...ok.input, sk: randomKeys().sk });
    await rejects('delegate', { ...ok.input, sk: owner.sk });
  });

  it('a sub-agent spends under its sub-policy and the owner can still reclaim it', async () => {
    const real = randomKeys();
    const d2 = build([{ agentPk: real.pk, amount: 300n, windowCap: 100n, maxPerTx: 50n, streamRate: 5n }]);
    const s = d2.subs[0];
    const t3 = new MerkleTree(LEVELS);
    const i3 = t3.insert(allowanceCommitment(s));
    const later = now + 20n; // 5/s * 20s = 100 streamed
    await accepts('spend', spendInput({ root: t3.root, allowance: s, path: t3.path(i3), spender: real, amount: 50n, now: later, publicTo: 1n, extDataHash: 1n }).input);
    await rejects('spend', spendInput({ root: t3.root, allowance: s, path: t3.path(i3), spender: real, amount: 51n, now: later, publicTo: 1n, extDataHash: 1n }).input); // maxPerTx 50
    await rejects('spend', spendInput({ root: t3.root, allowance: s, path: t3.path(i3), spender: real, amount: 50n, now: now + 5n, publicTo: 1n, extDataHash: 1n }).input); // only 25 streamed
    await accepts('spend', spendInput({ root: t3.root, allowance: s, path: t3.path(i3), spender: owner, amount: 300n, now: later, shieldedTo: { pk: owner.pk }, extDataHash: 1n }).input);
  });
});
