// Builds circuit inputs (and the public values a contract call needs) from
// SDK objects. Pure functions: no I/O, no proving.
import {
  Allowance, Note, SpendingKey, allowanceCommitment, allowanceNullifier, addressKey, assertAmount, mod,
  noteCommitment, noteNullifier, policyHash, randomField, receiptCommitment, spendAllowance, totalCommitment,
} from './crypto.js';
import { MerklePath, MerkleTree } from './merkle.js';
import type { CircuitInput } from './prover.js';

export const LEVELS = 20;
export const RECIPIENT_LEVELS = 8;
export const GRANT_OUTPUTS = 8;

export interface NoteInput { note: Note; keys: SpendingKey; path: MerklePath }

/** A zero-amount note that satisfies the circuit without existing in the tree. */
export function dummyNoteInput(asset: bigint, keys: SpendingKey, tree: MerkleTree): NoteInput {
  return { note: { asset, amount: 0n, pk: keys.pk, blinding: randomField() }, keys, path: tree.emptyPath() };
}

// ---------------------------------------------------------------- transact

export interface TransactParams {
  root: bigint;
  asset: bigint;
  inputs: [NoteInput, NoteInput];
  outputs: [Note, Note];
  /** extAmount - fee: positive for deposits, negative for withdrawals, 0 for shielded transfers */
  publicAmount: bigint;
  extDataHash: bigint;
}

export function transactInput(p: TransactParams) {
  for (const i of p.inputs) if (i.note.asset !== p.asset) throw new Error('asset mismatch');
  for (const o of p.outputs) { assertAmount(o.amount); if (o.asset !== p.asset) throw new Error('asset mismatch'); }
  const inputNullifier = p.inputs.map((i) => noteNullifier(i.keys.nk, noteCommitment(i.note)));
  const outputCommitment = p.outputs.map(noteCommitment);
  const publicAmount = mod(p.publicAmount);
  const publicAsset = publicAmount === 0n ? 0n : p.asset;
  const input: CircuitInput = {
    root: p.root,
    publicAmount,
    publicAsset,
    extDataHash: p.extDataHash,
    inputNullifier,
    outputCommitment,
    asset: p.asset,
    inAmount: p.inputs.map((i) => i.note.amount),
    inBlinding: p.inputs.map((i) => i.note.blinding),
    inSk: p.inputs.map((i) => i.keys.sk),
    inPathIndices: p.inputs.map((i) => i.path.pathIndices),
    inPathElements: p.inputs.map((i) => i.path.pathElements),
    outAmount: p.outputs.map((o) => o.amount),
    outPk: p.outputs.map((o) => o.pk),
    outBlinding: p.outputs.map((o) => o.blinding),
  };
  return { input, inputNullifier, outputCommitment, publicAmount, publicAsset };
}

// ---------------------------------------------------------------- grant

export interface GrantParams {
  root: bigint;
  asset: bigint;
  owner: SpendingKey;
  inputs: [NoteInput, NoteInput];
  /** up to GRANT_OUTPUTS allowances; missing slots are filled with zero-amount placeholders */
  allowances: Allowance[];
  change: Note;
  totalSalt: bigint;
  extDataHash: bigint;
}

export function grantInput(p: GrantParams) {
  if (p.allowances.length > GRANT_OUTPUTS) throw new Error(`at most ${GRANT_OUTPUTS} allowances per grant`);
  const allowances = [...p.allowances];
  while (allowances.length < GRANT_OUTPUTS) {
    allowances.push({
      asset: p.asset, remaining: 0n, agentPk: randomField(), windowId: 0n, windowSpent: 0n, rho: randomField(),
      policy: { lifetimeCap: 0n, windowCap: 0n, windowLen: 86400n, maxPerTx: 0n, expiry: 0n, recipientRoot: 0n, ownerPk: p.owner.pk },
    });
  }
  for (const a of allowances) {
    if (a.asset !== p.asset) throw new Error('asset mismatch');
    if (a.policy.lifetimeCap !== a.remaining || a.windowId !== 0n || a.windowSpent !== 0n) throw new Error('fresh allowance expected');
    if (a.policy.ownerPk !== p.owner.pk) throw new Error('policy owner must be the granter');
    if (a.policy.windowLen === 0n) throw new Error('windowLen must be > 0');
    assertAmount(a.remaining);
  }
  const total = allowances.reduce((s, a) => s + a.remaining, 0n);
  const sumIn = p.inputs.reduce((s, i) => s + i.note.amount, 0n);
  if (sumIn !== total + p.change.amount) throw new Error('inputs must equal allowances plus change');

  const inputNullifier = p.inputs.map((i) => noteNullifier(p.owner.nk, noteCommitment(i.note)));
  const allowanceCommitments = allowances.map(allowanceCommitment);
  const changeCommitment = noteCommitment(p.change);
  const total_ = totalCommitment(p.asset, total, p.totalSalt);
  const input: CircuitInput = {
    root: p.root,
    inputNullifier,
    allowanceCommitment: allowanceCommitments,
    changeCommitment,
    totalCommitment: total_,
    extDataHash: p.extDataHash,
    asset: p.asset,
    sk: p.owner.sk,
    inAmount: p.inputs.map((i) => i.note.amount),
    inBlinding: p.inputs.map((i) => i.note.blinding),
    inPathIndices: p.inputs.map((i) => i.path.pathIndices),
    inPathElements: p.inputs.map((i) => i.path.pathElements),
    agentPk: allowances.map((a) => a.agentPk),
    amount: allowances.map((a) => a.remaining),
    windowCap: allowances.map((a) => a.policy.windowCap),
    windowLen: allowances.map((a) => a.policy.windowLen),
    maxPerTx: allowances.map((a) => a.policy.maxPerTx),
    expiry: allowances.map((a) => a.policy.expiry),
    recipientRoot: allowances.map((a) => a.policy.recipientRoot),
    rho: allowances.map((a) => a.rho),
    changeAmount: p.change.amount,
    changeBlinding: p.change.blinding,
    totalSalt: p.totalSalt,
  };
  return { input, allowances, inputNullifier, allowanceCommitments, changeCommitment, totalCommitment: total_, total };
}

// ---------------------------------------------------------------- spend

export interface SpendParams {
  root: bigint;
  allowance: Allowance;
  path: MerklePath;
  /** the agent's key, or the owner's key to reclaim */
  spender: SpendingKey;
  amount: bigint;
  now: bigint;
  fee?: bigint;
  extDataHash: bigint;
  /** exactly one of these */
  shieldedTo?: { pk: bigint; blinding?: bigint };
  publicTo?: bigint; // recipient address as a field element
  /** Merkle path of the recipient key inside the policy's allow-list, when one is set */
  recipientPath?: MerklePath;
}

export function spendInput(p: SpendParams) {
  const a = p.allowance;
  const isOwner = p.spender.pk === a.policy.ownerPk;
  const isPublic = p.publicTo !== undefined;
  if (isPublic === (p.shieldedTo !== undefined)) throw new Error('choose exactly one of shieldedTo / publicTo');
  const fee = p.fee ?? 0n;
  assertAmount(p.amount);
  assertAmount(fee, 'fee');
  if (!isPublic && fee !== 0n) throw new Error('fees only on public payouts');
  if (fee > p.amount) throw new Error('fee exceeds amount');

  const commitment = allowanceCommitment(a);
  const nullifier = allowanceNullifier(a.rho, commitment);
  const next = spendAllowance(a, p.amount, p.now, !isOwner);
  const newAllowanceCommitment = allowanceCommitment(next);
  const payBlinding = p.shieldedTo?.blinding ?? randomField();
  const recipientPk = p.shieldedTo?.pk ?? 0n;
  const publicRecipient = p.publicTo ?? 0n;
  const recipientKey = isPublic ? addressKey(publicRecipient) : recipientPk;
  const payNote: Note = { asset: a.asset, amount: p.amount, pk: recipientPk, blinding: payBlinding };
  const payCommitment = isPublic ? 0n : noteCommitment(payNote);
  const receipt = receiptCommitment(a.asset, p.amount, recipientKey, next.windowId, nullifier);
  const rp = p.recipientPath ?? { pathElements: new Array(RECIPIENT_LEVELS).fill(0n), pathIndices: new Array(RECIPIENT_LEVELS).fill(0), root: 0n, index: -1 };

  const input: CircuitInput = {
    root: p.root,
    nullifier,
    newAllowanceCommitment,
    payCommitment,
    publicAmount: isPublic ? p.amount : 0n,
    publicRecipient,
    publicAsset: isPublic ? a.asset : 0n,
    fee,
    now: p.now,
    receipt,
    extDataHash: p.extDataHash,
    asset: a.asset,
    remaining: a.remaining,
    agentPk: a.agentPk,
    windowId: a.windowId,
    windowSpent: a.windowSpent,
    rho: a.rho,
    lifetimeCap: a.policy.lifetimeCap,
    windowCap: a.policy.windowCap,
    windowLen: a.policy.windowLen,
    maxPerTx: a.policy.maxPerTx,
    expiry: a.policy.expiry,
    recipientRoot: a.policy.recipientRoot,
    ownerPk: a.policy.ownerPk,
    sk: p.spender.sk,
    pathIndices: p.path.pathIndices,
    pathElements: p.path.pathElements,
    amount: p.amount,
    isPublic: isPublic ? 1n : 0n,
    recipientPk,
    payBlinding,
    recipientPathIndices: rp.pathIndices,
    recipientPathElements: rp.pathElements,
  };
  return { input, nullifier, next, newAllowanceCommitment, payNote, payCommitment, receipt, isPublic, fee };
}

// ---------------------------------------------------------------- disclose

export type DisclosureKind = 'remainingAtLeast' | 'spentAtMost' | 'windowSpentAtMost';
const KIND: Record<DisclosureKind, bigint> = { remainingAtLeast: 0n, spentAtMost: 1n, windowSpentAtMost: 2n };

export interface DiscloseParams {
  root: bigint;
  allowance: Allowance;
  path: MerklePath;
  kind: DisclosureKind;
  bound: bigint;
  /** required for windowSpentAtMost; must equal the note's current window */
  windowId?: bigint;
  audience: bigint;
}

export function discloseInput(p: DiscloseParams) {
  const a = p.allowance;
  const windowIdPub = p.kind === 'windowSpentAtMost' ? (p.windowId ?? a.windowId) : 0n;
  const input: CircuitInput = {
    root: p.root,
    kind: KIND[p.kind],
    bound: p.bound,
    windowIdPub,
    agentPk: a.agentPk,
    audience: p.audience,
    asset: a.asset,
    remaining: a.remaining,
    windowId: a.windowId,
    windowSpent: a.windowSpent,
    rho: a.rho,
    lifetimeCap: a.policy.lifetimeCap,
    windowCap: a.policy.windowCap,
    windowLen: a.policy.windowLen,
    maxPerTx: a.policy.maxPerTx,
    expiry: a.policy.expiry,
    recipientRoot: a.policy.recipientRoot,
    ownerPk: a.policy.ownerPk,
    pathIndices: p.path.pathIndices,
    pathElements: p.path.pathElements,
  };
  const publicSignals = [p.root, KIND[p.kind], p.bound, windowIdPub, a.agentPk, p.audience];
  return { input, publicSignals, policyHash: policyHash(a.policy) };
}
