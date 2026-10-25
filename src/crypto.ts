// Hashes, keys and commitments. Every function here mirrors a template in
// circuits/lib/hashes.circom; the circuit tests assert they agree.
import { buildPoseidon } from 'circomlibjs';
import { randomBytes } from '@noble/hashes/utils';
import { keccak_256 } from '@noble/hashes/sha3';
import { utf8ToBytes, bytesToHex } from '@noble/hashes/utils';

export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const AMOUNT_BITS = 128n;
export const MAX_AMOUNT = (1n << AMOUNT_BITS) - 1n;

export const DOM = {
  PK: 1n, NK: 2n, NOTE: 3n, ALLOW: 4n, POLICY: 5n, NF: 6n, NFA: 7n, RHO: 8n, TOTAL: 9n, RCPT: 10n, ADDR: 11n,
} as const;

type PoseidonFn = ((inputs: bigint[]) => Uint8Array) & { F: { toObject(x: Uint8Array): bigint } };
let poseidonFn: PoseidonFn | undefined;

export async function initCrypto(): Promise<void> {
  if (!poseidonFn) poseidonFn = (await buildPoseidon()) as unknown as PoseidonFn;
}

export function poseidon(inputs: bigint[]): bigint {
  if (!poseidonFn) throw new Error('call initCrypto() first');
  return poseidonFn.F.toObject(poseidonFn(inputs));
}

export function randomField(): bigint {
  return BigInt('0x' + bytesToHex(randomBytes(31)));
}

export function mod(x: bigint): bigint {
  const r = x % FIELD;
  return r < 0n ? r + FIELD : r;
}

/** keccak256(utf8) reduced into the field; used for the empty leaf. */
export function fieldFromString(s: string): bigint {
  return BigInt('0x' + bytesToHex(keccak_256(utf8ToBytes(s)))) % FIELD;
}

export const ZERO_LEAF = fieldFromString('stipend');

export function assertAmount(x: bigint, what = 'amount'): void {
  if (x < 0n || x > MAX_AMOUNT) throw new Error(`${what} out of range`);
}

// ---------- keys ----------

export interface SpendingKey { sk: bigint; pk: bigint; nk: bigint }

export function keysFromSk(sk: bigint): SpendingKey {
  return { sk, pk: poseidon([DOM.PK, sk]), nk: poseidon([DOM.NK, sk]) };
}

export function randomKeys(): SpendingKey {
  return keysFromSk(randomField());
}

// ---------- treasury notes ----------

export interface Note {
  asset: bigint;
  amount: bigint;
  pk: bigint;
  blinding: bigint;
}

export function noteCommitment(n: Note): bigint {
  return poseidon([DOM.NOTE, n.asset, n.amount, n.pk, n.blinding]);
}

export function noteNullifier(nk: bigint, commitment: bigint): bigint {
  return poseidon([DOM.NF, nk, commitment]);
}

// ---------- policies and allowances ----------

export interface Policy {
  lifetimeCap: bigint;
  windowCap: bigint;     // 0 = unlimited
  windowLen: bigint;     // seconds, must be > 0
  maxPerTx: bigint;      // 0 = unlimited
  expiry: bigint;        // unix seconds, 0 = never
  recipientRoot: bigint; // 0 = any recipient
  ownerPk: bigint;
}

export function policyHash(p: Policy): bigint {
  return poseidon([DOM.POLICY, p.lifetimeCap, p.windowCap, p.windowLen, p.maxPerTx, p.expiry, p.recipientRoot, p.ownerPk]);
}

export interface Allowance {
  asset: bigint;
  remaining: bigint;
  agentPk: bigint;
  policy: Policy;
  windowId: bigint;
  windowSpent: bigint;
  rho: bigint;
}

export function allowanceCommitment(a: Allowance): bigint {
  return poseidon([DOM.ALLOW, a.asset, a.remaining, a.agentPk, policyHash(a.policy), a.windowId, a.windowSpent, a.rho]);
}

export function allowanceNullifier(rho: bigint, commitment: bigint): bigint {
  return poseidon([DOM.NFA, rho, commitment]);
}

export function nextRho(rho: bigint): bigint {
  return poseidon([DOM.RHO, rho]);
}

export function totalCommitment(asset: bigint, total: bigint, salt: bigint): bigint {
  return poseidon([DOM.TOTAL, asset, total, salt]);
}

export function receiptCommitment(asset: bigint, amount: bigint, recipientKey: bigint, windowId: bigint, nullifier: bigint): bigint {
  return poseidon([DOM.RCPT, asset, amount, recipientKey, windowId, nullifier]);
}

export function addressKey(address: bigint): bigint {
  return poseidon([DOM.ADDR, address]);
}

export function addressToField(address: string): bigint {
  return BigInt(address);
}

/** The successor of an allowance after a spend of `amount` at time `now`, as the circuit computes it. */
export function spendAllowance(a: Allowance, amount: bigint, now: bigint, enforce = true): Allowance {
  const newWindowId = now / a.policy.windowLen;
  const carried = newWindowId === a.windowId ? a.windowSpent : 0n;
  return {
    ...a,
    remaining: a.remaining - amount,
    windowId: newWindowId,
    windowSpent: carried + (enforce ? amount : 0n),
    rho: nextRho(a.rho),
  };
}
