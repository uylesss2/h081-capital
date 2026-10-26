// Constraint-level tests: every circuit accepts honest inputs and rejects
// each kind of dishonest one. Witness generation only (no proving) so the
// suite runs in seconds.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  Allowance, Note, Policy, SpendingKey, addressKey, allowanceCommitment, allowanceNullifier, initCrypto, lenderClaimable, lenderKey, noteCommitment,
  randomField, randomKeys, shareOf, spendAllowance,
} from '../../src/crypto.js';
import { MerkleTree, recipientListRoot } from '../../src/merkle.js';
import { GRANT_OUTPUTS, LEVELS, SPEND_PUBLIC, STREAM_PUBLIC, delegateInput, discloseInput, dummyNoteInput, grantInput, spendInput, streamInput, transactInput } from '../../src/inputs.js';
import { Prover, type CircuitName } from '../../src/prover.js';

const prover = new Prover();
const ASSET = 0x1111111111111111111111111111111111111111n;
const DAY = 86400n;
const LENDER_ADDR = 0x00000000000000000000000000000000deadbeefn;
const LOAN_REF = 7n;
const LENDER = { lenderAddr: LENDER_ADDR, loanRef: LOAN_REF };

let owner: SpendingKey;
let agent: SpendingKey;
let tree: MerkleTree;

function policy(over: Partial<Policy> = {}): Policy {
  return { lifetimeCap: 0n, windowCap: 0n, windowLen: DAY, maxPerTx: 0n, expiry: 0n, recipientRoot: 0n, ownerPk: owner.pk, streamRate: 0n, streamStart: 0n, lender: 0n, pledgeBps: 0n, ...over };
}

function fresh(amount: bigint, over: Partial<Policy> = {}): Allowance {
  return { asset: ASSET, remaining: amount, agentPk: agent.pk, policy: policy({ lifetimeCap: amount, ...over }), windowId: 0n, windowSpent: 0n, rho: randomField(), pledgePaid: 0n };
}

/** A fresh allowance pledged to LENDER at `bps`. */
function pledged(amount: bigint, bps: bigint, over: Partial<Policy> = {}): Allowance {
  return fresh(amount, { ...over, lender: lenderKey(LENDER_ADDR, LOAN_REF), pledgeBps: bps });
}

function note(amount: bigint, pk = owner.pk): Note {
  return { asset: ASSET, amount, pk, blinding: randomField() };
}

/** Puts one allowance into its own tree and returns what a proof over it needs. */
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

  it('grants a pre-pledged allowance and rejects inconsistent lender fields', async () => {
    const t = new MerkleTree(LEVELS);
    const a = note(5000n);
    const ia = t.insert(noteCommitment(a));
    const build = (allowances: Allowance[], lenders: Array<typeof LENDER | undefined>) => grantInput({
      root: t.root, asset: ASSET, owner,
      inputs: [{ note: a, keys: owner, path: t.path(ia) }, dummyNoteInput(ASSET, owner, t)],
      allowances, lenders, change: note(3000n), totalSalt: 1n, extDataHash: 1n,
    });
    const ok = build([pledged(2000n, 4000n, { streamRate: 5n, streamStart: 1_800_000_000n })], [LENDER]);
    expect(ok.allowances[0].pledgePaid).toBe(0n);
    await accepts('grant', ok.input);
    const arr = (k: string, v: bigint) => (ok.input[k] as bigint[]).map((x, i) => (i === 0 ? v : x));
    // the lender hash must open to (lenderAddr, loanRef)
    await rejects('grant', { ...ok.input, lenderAddr: arr('lenderAddr', 0xbeefn) });
    await rejects('grant', { ...ok.input, loanRef: arr('loanRef', 8n) });
    // a pledged policy cannot carry lender 0, and an unpledged one cannot carry a lender
    await rejects('grant', { ...ok.input, lender: arr('lender', 0n) });
    const plain = build([fresh(2000n)], [undefined]);
    await rejects('grant', { ...plain.input, lender: (plain.input.lender as bigint[]).map((x, i) => (i === 0 ? lenderKey(LENDER_ADDR, LOAN_REF) : x)) });
    await rejects('grant', { ...plain.input, lenderAddr: (plain.input.lenderAddr as bigint[]).map((x, i) => (i === 0 ? LENDER_ADDR : x)) });
    // pledgeBps above 10000 is out of range (the SDK refuses it first)
    expect(() => build([pledged(2000n, 10001n)], [LENDER])).toThrow();
    expect(() => build([pledged(2000n, 4000n)], [{ lenderAddr: 0xbeefn, loanRef: LOAN_REF }])).toThrow();
  });

  it('has no proof for a pledge whose preimage no SpendArgs can carry: lenderAddr 0 or >= 2^160, loanRef >= 2^64', async () => {
    const t = new MerkleTree(LEVELS);
    const a = note(5000n);
    const ia = t.insert(noteCommitment(a));
    const build = (ref: { lenderAddr: bigint; loanRef: bigint }) => {
      // the SDK refuses such refs; build with a good one and open the hash to the bad one so only the range rule can fail
      const ok = grantInput({
        root: t.root, asset: ASSET, owner,
        inputs: [{ note: a, keys: owner, path: t.path(ia) }, dummyNoteInput(ASSET, owner, t)],
        allowances: [pledged(2000n, 4000n)], lenders: [LENDER], change: note(3000n), totalSalt: 1n, extDataHash: 1n,
      });
      const bad = { ...ok.allowances[0], policy: { ...ok.allowances[0].policy, lender: lenderKey(ref.lenderAddr, ref.loanRef) } };
      const first = (k: string, v: bigint) => (ok.input[k] as bigint[]).map((x, i) => (i === 0 ? v : x));
      return {
        ...ok.input, lender: first('lender', bad.policy.lender), lenderAddr: first('lenderAddr', ref.lenderAddr), loanRef: first('loanRef', ref.loanRef),
        allowanceCommitment: (ok.input.allowanceCommitment as bigint[]).map((x, i) => (i === 0 ? allowanceCommitment(bad) : x)),
      };
    };
    await accepts('grant', build(LENDER));
    await rejects('grant', build({ lenderAddr: 0n, loanRef: LOAN_REF }));
    await rejects('grant', build({ lenderAddr: 1n << 160n, loanRef: LOAN_REF }));
    await rejects('grant', build({ lenderAddr: LENDER_ADDR, loanRef: 1n << 64n }));
    for (const ref of [{ lenderAddr: 0n, loanRef: LOAN_REF }, { lenderAddr: 1n << 160n, loanRef: LOAN_REF }, { lenderAddr: LENDER_ADDR, loanRef: 1n << 64n }]) {
      expect(() => grantInput({
        root: t.root, asset: ASSET, owner, inputs: [{ note: a, keys: owner, path: t.path(ia) }, dummyNoteInput(ASSET, owner, t)],
        allowances: [fresh(2000n, { lender: lenderKey(ref.lenderAddr, ref.loanRef), pledgeBps: 4000n })], lenders: [ref], change: note(3000n), totalSalt: 1n, extDataHash: 1n,
      })).toThrow();
    }
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
    expect(s.next.pledgePaid).toBe(0n);
    expect(s.lenderAmount).toBe(0n);
    expect(s.publicSignals).toHaveLength(15);
    expect(s.publicSignals[SPEND_PUBLIC.indexOf('publicAmount')]).toBe(200n);
    expect(s.publicSignals[SPEND_PUBLIC.indexOf('isLenderClaim')]).toBe(0n);
  });

  it('agent pays a shielded recipient', async () => {
    const s = spendInput({ root: tree.root, allowance: a, path: tree.path(idx), spender: agent, amount: 100n, now, shieldedTo: { pk: randomKeys().pk }, extDataHash: 4n });
    await accepts('spend', s.input);
    expect(s.payCommitment).not.toBe(0n);
    expect(s.input.publicAsset).toBe(0n);
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

  it('binds the rules to the agent key even when the owner granted to itself', async () => {
    // owner == agent: the circuit enforces the window, so the model must count the amount too
    const self = { ...fresh(1000n, { windowCap: 300n }), agentPk: owner.pk };
    const p = inTree(self);
    const ok = spendInput({ ...p, spender: owner, amount: 300n, now, publicTo: 1n, extDataHash: 1n });
    await accepts('spend', ok.input);
    expect(ok.next.windowSpent).toBe(300n);
    expect(ok.next.windowId).toBe(now / DAY);
    await rejects('spend', spendInput({ ...p, spender: owner, amount: 301n, now, publicTo: 1n, extDataHash: 1n }).input);
    // a successor that leaves the amount out of the window has no proof
    await rejects('spend', { ...ok.input, newAllowanceCommitment: allowanceCommitment({ ...ok.next, windowSpent: 0n }) });
    // a self-granted allow-list binds the owner too
    const { root, tree: list } = recipientListRoot([addressKey(0xaaaan)]);
    const listed = inTree({ ...fresh(1000n, { recipientRoot: root }), agentPk: owner.pk });
    await accepts('spend', spendInput({ ...listed, spender: owner, amount: 10n, now, publicTo: 0xaaaan, recipientPath: list.path(0), extDataHash: 1n }).input);
    await rejects('spend', spendInput({ ...listed, spender: owner, amount: 10n, now, publicTo: 0xbbbbn, recipientPath: list.path(0), extDataHash: 1n }).input);
  });

  it('rejects a stranger, a mismatched nullifier and a public/shielded mix-up', async () => {
    const stranger = randomKeys();
    await rejects('spend', spendInput({ root: tree.root, allowance: a, path: tree.path(idx), spender: stranger, amount: 10n, now, publicTo: 1n, extDataHash: 1n }).input);
    const s = spendInput({ root: tree.root, allowance: a, path: tree.path(idx), spender: agent, amount: 10n, now, publicTo: 1n, extDataHash: 1n });
    await rejects('spend', { ...s.input, nullifier: (s.nullifier + 1n) });
    await rejects('spend', { ...s.input, publicAmount: 0n });
    await rejects('spend', { ...s.input, fee: 11n });
    // an unpledged note cannot be claimed, nor may it name a lender or pay one
    await rejects('spend', { ...s.input, isLenderClaim: 1n });
    await rejects('spend', { ...s.input, lenderAddr: LENDER_ADDR });
    await rejects('spend', { ...s.input, lenderAmount: 1n });
  });
});

describe('pledged spend (design 2.6)', () => {
  const now = 1_800_000_000n;
  const BPS = 4000n;

  it('routes floor(amount * bps / 10000) to the lender and reveals the asset, public or shielded', async () => {
    const p = inTree(pledged(1000n, BPS, { windowCap: 300n, maxPerTx: 250n }));
    const pub = spendInput({ ...p, spender: agent, amount: 250n, fee: 5n, now, publicTo: 0xabcdefn, lender: LENDER, extDataHash: 1n });
    await accepts('spend', pub.input);
    expect(pub.lenderAmount).toBe(100n);
    expect(pub.net).toBe(150n);
    expect(pub.input.publicAmount).toBe(150n);
    expect(pub.input.publicAsset).toBe(ASSET);
    expect(pub.next.remaining).toBe(750n);
    expect(pub.next.pledgePaid).toBe(100n);
    expect(pub.next.windowSpent).toBe(250n); // the window counts the gross amount
    const sh = spendInput({ ...p, spender: agent, amount: 33n, now, shieldedTo: { pk: randomKeys().pk }, lender: LENDER, extDataHash: 1n });
    await accepts('spend', sh.input);
    expect(sh.lenderAmount).toBe(13n);
    expect(sh.payNote.amount).toBe(20n);
    expect(sh.input.publicAsset).toBe(ASSET);
    expect(sh.input.publicAmount).toBe(0n);
    // the asset cannot be hidden on a pledged spend
    await rejects('spend', { ...sh.input, publicAsset: 0n });
  });

  it('has no proof for a short, skipped or inflated share', async () => {
    const p = inTree(pledged(1000n, BPS));
    const s = spendInput({ ...p, spender: agent, amount: 250n, now, publicTo: 1n, lender: LENDER, extDataHash: 1n });
    const withShare = (lenderAmount: bigint) => ({
      ...s.input, lenderAmount, publicAmount: 250n - lenderAmount,
      newAllowanceCommitment: allowanceCommitment({ ...s.next, pledgePaid: lenderAmount }),
    });
    await accepts('spend', withShare(100n));
    await rejects('spend', withShare(99n));
    await rejects('spend', withShare(0n));
    await rejects('spend', withShare(101n));
    // the chain's lenderAmount alone cannot be changed either
    await rejects('spend', { ...s.input, lenderAmount: 0n });
  });

  it('has no proof for a re-pointed lender or loan ref', async () => {
    const p = inTree(pledged(1000n, BPS));
    const s = spendInput({ ...p, spender: agent, amount: 250n, now, publicTo: 1n, lender: LENDER, extDataHash: 1n });
    await rejects('spend', { ...s.input, lenderAddr: 0xbeefn });
    await rejects('spend', { ...s.input, loanRef: LOAN_REF + 1n });
    await rejects('spend', { ...s.input, lenderAddr: 0n, loanRef: 0n });
    expect(() => spendInput({ ...p, spender: agent, amount: 250n, now, publicTo: 1n, lender: { lenderAddr: 0xbeefn, loanRef: LOAN_REF }, extDataHash: 1n })).toThrow();
  });

  it('owner reclaim of a pledged allowance still routes the share', async () => {
    const p = inTree(pledged(1000n, BPS, { recipientRoot: 123n, expiry: 1n }));
    const r = spendInput({ ...p, spender: owner, amount: 1000n, now, shieldedTo: { pk: owner.pk }, lender: LENDER, extDataHash: 1n });
    await accepts('spend', r.input);
    expect(r.lenderAmount).toBe(400n);
    expect(r.payNote.amount).toBe(600n);
    expect(r.next.pledgePaid).toBe(400n);
    expect(r.next.windowSpent).toBe(0n);
    await rejects('spend', { ...r.input, lenderAmount: 0n, newAllowanceCommitment: allowanceCommitment({ ...r.next, pledgePaid: 0n }) });
  });

  describe('lender claim', () => {
    const start = 1_800_000_000n;
    const streamed = () => pledged(100_000n, BPS, { streamRate: 10n, streamStart: start, expiry: start + 10n, maxPerTx: 1n, windowCap: 1n });

    it('pulls the vested share without a key, ignoring the agent-only rules', async () => {
      const p = inTree(streamed());
      const at = start + 1000n; // 10_000 vested, 4_000 owed
      expect(lenderClaimable(p.allowance, at)).toBe(4000n);
      const c = spendInput({ ...p, claim: true, amount: 4000n, now: at, lender: LENDER, extDataHash: 1n });
      await accepts('spend', c.input);
      expect(c.input.sk).toBe(0n);
      expect(c.lenderAmount).toBe(4000n);
      expect(c.net).toBe(0n);
      expect(c.payCommitment).toBe(0n);
      expect(c.input.publicAmount).toBe(0n);
      expect(c.input.publicAsset).toBe(ASSET);
      expect(c.input.isLenderClaim).toBe(1n);
      expect(c.next.remaining).toBe(96_000n);
      expect(c.next.pledgePaid).toBe(4000n);
      expect(c.next.windowSpent).toBe(0n);
      // a smaller claim, and a smaller vested than allotted, are fine
      await accepts('spend', spendInput({ ...p, claim: true, amount: 1n, now: at, vested: 5n, lender: LENDER, extDataHash: 1n }).input);
    });

    it('has no proof for a claim beyond the vested share, less what was routed', async () => {
      const p = inTree(streamed());
      const at = start + 1000n;
      await rejects('spend', spendInput({ ...p, claim: true, amount: 4001n, now: at, lender: LENDER, extDataHash: 1n }).input);
      // after 1_000 was routed (shares or claims), only 3_000 is left of the vested share
      const paid = { ...streamed(), pledgePaid: 1000n, remaining: 99_000n };
      const q = inTree(paid);
      expect(lenderClaimable(paid, at)).toBe(3000n);
      await accepts('spend', spendInput({ ...q, claim: true, amount: 3000n, now: at, lender: LENDER, extDataHash: 1n }).input);
      await rejects('spend', spendInput({ ...q, claim: true, amount: 3001n, now: at, lender: LENDER, extDataHash: 1n }).input);
    });

    it('has no proof for vested above the allotment or the lifetime cap, or a claim above the balance', async () => {
      const p = inTree(streamed());
      const at = start + 1000n;
      const ok = spendInput({ ...p, claim: true, amount: 1n, now: at, lender: LENDER, extDataHash: 1n });
      // vested 10_001 > allotted 10_000 (division witness kept consistent)
      await rejects('spend', { ...ok.input, vested: 10_001n, owedQ: 4000n, owedRem: 4000n });
      // before the stream starts nothing has vested, and a forged vested cannot pass the start gate either
      expect(lenderClaimable(p.allowance, start - 1n)).toBe(0n);
      await rejects('spend', spendInput({ ...p, claim: true, amount: 1n, now: start - 1n, vested: 10n, lender: LENDER, extDataHash: 1n }).input);
      // unstreamed: vested may not exceed the lifetime cap
      const flat = inTree(pledged(1000n, BPS));
      await accepts('spend', spendInput({ ...flat, claim: true, amount: 400n, now: at, lender: LENDER, extDataHash: 1n }).input);
      await rejects('spend', { ...spendInput({ ...flat, claim: true, amount: 400n, now: at, lender: LENDER, extDataHash: 1n }).input, vested: 1001n, owedQ: 400n, owedRem: 4000n });
      // claim above the balance: lifetime cap 1000, 950 already spent (and nothing routed)
      const low = inTree({ ...pledged(1000n, BPS), remaining: 50n });
      await rejects('spend', spendInput({ ...low, claim: true, amount: 51n, now: at, lender: LENDER, extDataHash: 1n }).input);
      await accepts('spend', spendInput({ ...low, claim: true, amount: 50n, now: at, lender: LENDER, extDataHash: 1n }).input);
    });

    it('has no proof for a claim on an unpledged note or one that also pays a recipient', async () => {
      const plain = inTree(fresh(1000n));
      expect(() => spendInput({ ...plain, claim: true, amount: 1n, now: start, extDataHash: 1n })).toThrow();
      const p = inTree(streamed());
      const c = spendInput({ ...p, claim: true, amount: 100n, now: start + 1000n, lender: LENDER, extDataHash: 1n });
      await rejects('spend', { ...c.input, payCommitment: 1n });
      await rejects('spend', { ...c.input, publicAmount: 1n });
      await rejects('spend', { ...c.input, isPublic: 1n, publicRecipient: 1n });
      await rejects('spend', { ...c.input, fee: 1n });
      // a claim cannot be dressed up as an agent spend of the same amount
      await rejects('spend', { ...c.input, isLenderClaim: 0n });
    });

    it('leaves the window state untouched, so a claim dated in the previous window cannot reset the cap', async () => {
      const boundary = ((start / DAY) + 1n) * DAY; // first second of the window after `start`
      const p = inTree(pledged(100_000n, BPS, { streamRate: 10n, streamStart: start, windowCap: 300n }));
      const at = boundary + 100n;
      const full = spendInput({ ...p, spender: agent, amount: 300n, now: at, publicTo: 1n, lender: LENDER, extDataHash: 1n });
      await accepts('spend', full.input);
      expect(full.next.windowSpent).toBe(300n);
      const q = inTree(full.next);
      // the lender claims with `now` 15 minutes back, inside the previous window
      const claim = spendInput({ ...q, claim: true, amount: 1000n, now: boundary - 100n, lender: LENDER, extDataHash: 1n });
      await accepts('spend', claim.input);
      expect(claim.next.windowId).toBe(full.next.windowId);
      expect(claim.next.windowSpent).toBe(300n);
      // a successor carrying the older window id with a fresh counter has no proof
      await rejects('spend', { ...claim.input, newAllowanceCommitment: allowanceCommitment({ ...claim.next, windowId: (boundary - 100n) / DAY, windowSpent: 0n }) });
      // the agent's next spend in the same window is still over the cap
      const r = inTree(claim.next);
      await rejects('spend', spendInput({ ...r, spender: agent, amount: 1n, now: at + 10n, publicTo: 1n, lender: LENDER, extDataHash: 1n }).input);
      await accepts('spend', spendInput({ ...r, spender: agent, amount: 1n, now: at + DAY, publicTo: 1n, lender: LENDER, extDataHash: 1n }).input);
    });
  });

  it('never routes more than floor(lifetimeCap * bps / 10000) in total: a spend after a full claim routes nothing', async () => {
    const L = 1000n;
    const half = 5000n;
    const p = inTree(pledged(L, half));
    const claim = spendInput({ ...p, claim: true, amount: 500n, now, lender: LENDER, extDataHash: 1n });
    await accepts('spend', claim.input);
    expect(claim.next.pledgePaid).toBe(shareOf(L, half));
    const q = inTree(claim.next);
    const s = spendInput({ ...q, spender: agent, amount: 500n, now, publicTo: 1n, lender: LENDER, extDataHash: 1n });
    expect(s.lenderAmount).toBe(0n);
    expect(s.net).toBe(500n);
    await accepts('spend', s.input);
    await rejects('spend', { ...s.input, lenderAmount: 250n, publicAmount: 250n, newAllowanceCommitment: allowanceCommitment({ ...s.next, pledgePaid: 750n }) });
    // and the lender cannot claim again either
    expect(lenderClaimable(claim.next, now)).toBe(0n);
    await rejects('spend', spendInput({ ...q, claim: true, amount: 1n, now, lender: LENDER, extDataHash: 1n }).input);
  });

  it('pure model: random sequences of spends and claims never exceed the lifetime share', () => {
    let seed = 12345;
    const rnd = (n: bigint) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return BigInt(seed) % (n + 1n); };
    for (let run = 0; run < 200; run++) {
      const L = 1n + rnd(5000n);
      const bps = rnd(10000n);
      const rate = rnd(3n);
      let a: Allowance = pledged(L, bps === 0n ? 1n : bps, { streamRate: rate, streamStart: now });
      let t = now;
      for (let step = 0; step < 12 && a.remaining > 0n; step++) {
        t += rnd(2000n);
        if (rnd(2n) === 0n) {
          const c = lenderClaimable(a, t);
          if (c > 0n) a = spendAllowance(a, 1n + rnd(c - 1n), t, false, true);
        } else {
          const amount = 1n + rnd(a.remaining - 1n);
          a = spendAllowance(a, amount, t, false);
        }
        expect(a.pledgePaid).toBeLessThanOrEqual(shareOf(L, a.policy.pledgeBps));
        expect(a.remaining).toBeGreaterThanOrEqual(0n);
      }
    }
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

  it('works over a pledged note with the same six public inputs', async () => {
    const p = inTree({ ...pledged(1000n, 4000n), remaining: 640n, pledgePaid: 144n });
    const d = discloseInput({ ...p, kind: 'remainingAtLeast', bound: 600n, audience: 77n });
    expect(d.publicSignals).toHaveLength(6);
    await accepts('disclose', d.input);
    await rejects('disclose', { ...d.input, pledgePaid: 0n });
  });
});

describe('stream proof (design 5)', () => {
  const start = 1_800_000_000n;
  it('discloses the pledge terms and bounds, hiding the balance', async () => {
    const a = { ...pledged(100_000n, 4000n, { streamRate: 10n, streamStart: start, expiry: start + 86400n }), remaining: 90_000n, pledgePaid: 4000n };
    const p = inTree(a);
    const s = streamInput({ ...p, lender: LENDER, minRemaining: 80_000n, minRate: 10n, audience: 99n });
    expect(s.publicSignals).toHaveLength(13);
    expect(s.publicSignals.map(String)).toEqual([p.root, 80_000n, 10n, LENDER_ADDR, LOAN_REF, 4000n, start + 86400n, 100_000n, 4000n, agent.pk, 99n, start, ASSET].map(String));
    expect(STREAM_PUBLIC[1]).toBe('minRemaining');
    expect(STREAM_PUBLIC[11]).toBe('streamStartPub');
    await accepts('stream', s.input);
    await accepts('stream', { ...s.input, minRemaining: 90_000n, minRate: 0n });
    await rejects('stream', { ...s.input, minRemaining: 90_001n });
    await rejects('stream', { ...s.input, minRate: 11n });
    await rejects('stream', { ...s.input, lenderAddr: 0xbeefn });
    await rejects('stream', { ...s.input, loanRef: LOAN_REF + 1n });
    await rejects('stream', { ...s.input, pledgeBpsPub: 4001n });
    await rejects('stream', { ...s.input, expiryPub: start });
    await rejects('stream', { ...s.input, lifetimeCapPub: 100_001n });
    await rejects('stream', { ...s.input, pledgePaidPub: 0n });
    await rejects('stream', { ...s.input, agentPk: randomKeys().pk });
    // the start date and the asset cannot be misstated: a lender knows when the cashflow begins and what it is paid in
    await rejects('stream', { ...s.input, streamStartPub: start - 1n });
    await rejects('stream', { ...s.input, assetPub: 0n });
    expect(() => streamInput({ ...p, lender: LENDER, minRemaining: 90_001n, minRate: 10n, audience: 1n })).toThrow();
    expect(() => streamInput({ ...inTree(fresh(1000n)), lender: LENDER, minRemaining: 1n, minRate: 0n, audience: 1n })).toThrow();
  });

  it('has no proof over an unpledged note', async () => {
    const p = inTree(fresh(1000n, { streamRate: 10n, streamStart: start }));
    const ok = streamInput({ ...inTree(pledged(1000n, 4000n, { streamRate: 10n, streamStart: start })), lender: LENDER, minRemaining: 1n, minRate: 1n, audience: 1n });
    const forged = { ...ok.input, root: p.root, pathElements: p.path.pathElements, pathIndices: p.path.pathIndices, lender: 0n, pledgeBps: 0n, pledgeBpsPub: 0n, lenderAddr: 0n, loanRef: 0n, rho: p.allowance.rho };
    await rejects('stream', forged);
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
    expect(d.residual.pledgePaid).toBe(0n);
    expect(d.subs[0].windowId).toBe(parent.windowId);
    expect(d.subs[0].policy.streamStart).toBe(now);
    expect(d.subs[0].policy.pledgeBps).toBe(0n);
    expect(d.subs[0].pledgePaid).toBe(0n);
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
    // a live residual under a capped or streamed parent keeps a cap and a rate
    await rejects('delegate', { ...ok.input, resWindowCap: 0n });
    await rejects('delegate', { ...ok.input, resStreamRate: 0n });
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

  describe('pledges (design 3)', () => {
    const BPS = 4000n;

    it('an agent cannot create a pledge: a sub of an unpledged parent carries no lender, whoever it is for', async () => {
      // the SDK has no way to ask for one, and the circuit rebuilds every sub policy from the parent's lender fields
      const plain = build([{ agentPk: agent.pk, amount: 800n, windowCap: 297n, maxPerTx: 100n, streamRate: 17n }]);
      await accepts('delegate', plain.input);
      expect(plain.subs[0].policy.pledgeBps).toBe(0n);
      expect(plain.subs[0].policy.lender).toBe(0n);
      const self = { ...plain.subs[0], policy: { ...plain.subs[0].policy, lender: lenderKey(LENDER_ADDR, LOAN_REF), pledgeBps: BPS } };
      const subCommitment = (plain.input.subCommitment as bigint[]).map((x, i) => (i === 0 ? allowanceCommitment(self) : x));
      await rejects('delegate', { ...plain.input, subCommitment });
      await rejects('delegate', { ...plain.input, subCommitment, lender: self.policy.lender, pledgeBps: BPS, lenderAddr: LENDER_ADDR, loanRef: LOAN_REF });
      // nor may an unpledged parent name a lender
      await rejects('delegate', { ...plain.input, lenderAddr: LENDER_ADDR, loanRef: LOAN_REF });
    });

    it('a pledged parent passes its pledge unchanged to every sub and the residual', async () => {
      const pp = { ...pledged(1_000n, BPS, { windowCap: 300n, maxPerTx: 100n, streamRate: 20n, streamStart: now - 1000n }), remaining: 800n, pledgePaid: 80n, windowId: now / DAY, windowSpent: 120n };
      const p = inTree(pp);
      const mk = (subs: Parameters<typeof delegateInput>[0]['subs'], extra: Partial<Parameters<typeof delegateInput>[0]> = {}) =>
        delegateInput({ ...p, agent, subs, now, lender: LENDER, extDataHash: 3n, ...extra });
      const d = mk([{ agentPk: subA, amount: 300n, windowCap: 100n, maxPerTx: 50n, streamRate: 5n }, { agentPk: agent.pk, amount: 100n, windowCap: 50n, maxPerTx: 50n, streamRate: 5n }]);
      await accepts('delegate', d.input);
      for (const s of d.subs) {
        expect(s.policy.lender).toBe(pp.policy.lender);
        expect(s.policy.pledgeBps).toBe(BPS);
        expect(s.pledgePaid).toBe(0n);
      }
      expect(d.residual.policy.lender).toBe(pp.policy.lender);
      expect(d.residual.policy.pledgeBps).toBe(BPS);
      expect(d.residual.pledgePaid).toBe(80n);
      expect(d.residual.policy.lifetimeCap).toBe(600n);
      // the pledged sub routes its share on a spend, can be claimed by the lender and backs a stream proof
      const s = inTree(d.subs[1]);
      const at = now + 100n; // 5/s * 100s = 500 allotted, capped at the 100 lifetime: 40 owed
      const spend = spendInput({ ...s, spender: agent, amount: 50n, now: at, publicTo: 1n, lender: LENDER, extDataHash: 1n });
      await accepts('spend', spend.input);
      expect(spend.lenderAmount).toBe(20n);
      expect(lenderClaimable(d.subs[1], at)).toBe(40n);
      await accepts('spend', spendInput({ ...s, claim: true, amount: 40n, now: at, lender: LENDER, extDataHash: 1n }).input);
      await rejects('spend', spendInput({ ...s, claim: true, amount: 41n, now: at, lender: LENDER, extDataHash: 1n }).input);
      await accepts('stream', streamInput({ ...s, lender: LENDER, minRemaining: 100n, minRate: 5n, audience: 5n }).input);
      // re-pledge or re-point of a sub: no proof
      const subWith = (policy: Partial<Policy>) => (d.input.subCommitment as bigint[]).map((x, i) => (i === 0 ? allowanceCommitment({ ...d.subs[0], policy: { ...d.subs[0].policy, ...policy } }) : x));
      await rejects('delegate', { ...d.input, subCommitment: subWith({ pledgeBps: BPS + 1n }) });
      await rejects('delegate', { ...d.input, subCommitment: subWith({ pledgeBps: 0n, lender: 0n }) });
      const other = { lenderAddr: 0xbeefn, loanRef: 1n };
      await rejects('delegate', { ...d.input, subCommitment: subWith({ lender: lenderKey(other.lenderAddr, other.loanRef) }) });
      await rejects('delegate', { ...d.input, lenderAddr: other.lenderAddr, loanRef: other.loanRef });
      expect(() => mk([{ agentPk: subA, amount: 100n }], { lender: other })).toThrow();
      // the residual cannot drop the pledge
      await rejects('delegate', { ...d.input, residualCommitment: allowanceCommitment({ ...d.residual, policy: { ...d.residual.policy, lender: 0n, pledgeBps: 0n } }) });
      await rejects('delegate', { ...d.input, residualCommitment: allowanceCommitment({ ...d.residual, pledgePaid: 0n }) });
      // the residual's lifetime share must still cover what the lender was paid (80 of floor(1000 * 0.4) = 400):
      // delegating 800 leaves a residual cap of 200, share 80: allowed; the circuit refuses when pledgePaid exceeds it
      const edge = mk([{ agentPk: subA, amount: 800n, windowCap: 297n, maxPerTx: 100n, streamRate: 17n }]);
      await accepts('delegate', edge.input);
      expect(edge.residual.remaining).toBe(0n);
      const over = { ...pp, pledgePaid: 81n };
      const q = inTree(over);
      expect(() => delegateInput({ ...q, agent, subs: [{ agentPk: subA, amount: 800n, windowCap: 297n, maxPerTx: 100n, streamRate: 17n }], now, lender: LENDER, extDataHash: 3n })).toThrow();
      // the same statement forged by hand (the note really has pledgePaid 81) has no proof
      const forged = {
        ...edge.input, root: q.root, pathElements: q.path.pathElements, pathIndices: q.path.pathIndices, pledgePaid: 81n,
        nullifier: allowanceNullifier(over.rho, allowanceCommitment(over)),
        residualCommitment: allowanceCommitment({ ...edge.residual, pledgePaid: 81n }),
      };
      await rejects('delegate', forged);
    });

    it('a parent whose pledge preimage no SpendArgs can carry cannot be delegated either', async () => {
      // such a note cannot exist (grant refuses it); if it did, delegate would not propagate it
      const good = inTree(pledged(1_000n, BPS));
      const d = delegateInput({ ...good, agent, subs: [{ agentPk: subA, amount: 100n }], now, lender: LENDER, extDataHash: 3n });
      await accepts('delegate', d.input);
      const forge = (ref: { lenderAddr: bigint; loanRef: bigint }) => {
        const lender = lenderKey(ref.lenderAddr, ref.loanRef);
        const bad = { ...good.allowance, policy: { ...good.allowance.policy, lender } };
        const b = inTree(bad);
        const repledge = (a: Allowance) => ({ ...a, policy: { ...a.policy, lender } });
        return {
          ...d.input, root: b.root, pathElements: b.path.pathElements, pathIndices: b.path.pathIndices, lender, lenderAddr: ref.lenderAddr, loanRef: ref.loanRef,
          nullifier: allowanceNullifier(bad.rho, allowanceCommitment(bad)),
          subCommitment: d.subs.map((s) => allowanceCommitment(repledge(s))), residualCommitment: allowanceCommitment(repledge(d.residual)),
        };
      };
      await accepts('delegate', forge(LENDER));
      await rejects('delegate', forge({ lenderAddr: 0n, loanRef: LOAN_REF }));
      await rejects('delegate', forge({ lenderAddr: 1n << 160n, loanRef: LOAN_REF }));
      await rejects('delegate', forge({ lenderAddr: LENDER_ADDR, loanRef: 1n << 64n }));
    });
  });
});
