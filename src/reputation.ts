// Private reputation (docs/REPUTATION-SPEC.md): inputs for circuits/main/reputation.circom, loan selection, the
// public threshold ladder and audience hashing. No Solana dependency (src/solana/reputation.ts has the program side).
//
// What a reputation proof says, and what it does not:
//   - it is a LOWER BOUND on good loans: "at least N fully repaid loans, at least X volume, ...". Loans that were not
//     repaid never enter the tree, so the proof says nothing about defaults. A perfect record and one that hides
//     defaults under other keys or other accounts look the same.
//   - it measures capital throughput and calendar presence on loans whose keys the prover controls, not
//     creditworthiness: a lender can be the borrower's own second wallet, and anyone can repay a loan for its borrower.
import { sha256 } from '@noble/hashes/sha2';
import { FIELD, loanPk, presNullifier, repLeaf } from './crypto.js';
import type { MerkleTree } from './merkle.js';

export const REP_LEVELS = 20;
/** loans one proof can count (the circuit's N) */
export const REP_SLOTS = 16;
/** rep_registry refuses to attest a loan below this principal (base units of a 6-decimal asset: 1 USDG) */
export const REP_MIN_PRINCIPAL = 1_000_000n;
/** verify_reputation refuses an expiry further than this past the clock; the SDK verifier does the same */
export const REP_MAX_TTL_SEC = 86_400;
export const REP_DAY = 86_400;
/** a "month" in the circuit is a 30-day period of the funding day: floor(fundedDay / 30) */
export const REP_MONTH_DAYS = 30;

/** The public inputs, in circuit order. */
export const REPUTATION_PUBLIC = [
  'repRoot', 'asset', 'minLoans', 'minVolume', 'minLenders', 'minSpanDays', 'minMonths', 'monthFloor',
  'audience', 'nonce', 'expiry', 'bindTo', 'presNullifier',
] as const;
export type RepPublicName = (typeof REPUTATION_PUBLIC)[number];
export type RepPublic = Record<RepPublicName, bigint>;

/** Beta label: the reputation verifying key comes from a single-party setup until a multi-party ceremony runs. */
export const REP_SETUP_STATUS = 'beta: single-party trusted setup (not yet a multi-party ceremony); whoever ran the setup could forge any reputation' as const;
/** What every verifier-facing surface must say about the statement. */
export const REP_STATEMENT_NOTE =
  'A reputation proof is a lower bound on fully repaid loans only. It says nothing about defaults (unpaid loans never enter the tree), cannot tell an independent lender from the borrower\'s own second wallet, and cannot tell who supplied the repaid money. It measures capital throughput and calendar time on loans whose keys the prover controls, not creditworthiness.';

/** What a verifier asks for. All thresholds are lower bounds. */
export interface RepRequirement {
  minLoans: number;
  /** base units of the asset */
  minVolume: bigint;
  minLenders: number;
  minSpanDays: number;
  /** distinct 30-day funding periods that hold a loan of at least `monthFloor` */
  minMonths: number;
  /** base units; a loan below it does not make its period count */
  monthFloor: bigint;
}

export const NO_REQUIREMENT: RepRequirement = { minLoans: 1, minVolume: 0n, minLenders: 0, minSpanDays: 0, minMonths: 0, monthFloor: 0n };

/** One attested loan the prover can count (from a RepAttested event matched to one of its loan keys). */
export interface RepLoan {
  loanRef: bigint;
  principal: bigint;
  assetF: bigint;
  lenderF: bigint;
  fundedDay: bigint;
  /** loan key index k: agentPk = loanPk(masterSk, k) */
  keyIndex: number;
  /** leaf index in the rep tree */
  index: number;
}

export class ReputationUnreachable extends Error {
  constructor(readonly short: Partial<Record<keyof RepRequirement | 'slots', string>>, readonly have: RepStats) {
    super(`ReputationUnreachable: ${Object.entries(short).map(([k, v]) => `${k} ${v}`).join('; ')}`);
  }
}

export interface RepStats { loans: number; volume: bigint; lenders: number; spanDays: number; months: number }

export function statsOf(loans: RepLoan[], monthFloor = 0n): RepStats {
  if (loans.length === 0) return { loans: 0, volume: 0n, lenders: 0, spanDays: 0, months: 0 };
  const days = loans.map((l) => Number(l.fundedDay));
  return {
    loans: loans.length,
    volume: loans.reduce((s, l) => s + l.principal, 0n),
    lenders: new Set(loans.map((l) => l.lenderF)).size,
    spanDays: Math.max(...days) - Math.min(...days),
    months: new Set(loans.filter((l) => l.principal >= monthFloor).map((l) => Math.floor(Number(l.fundedDay) / REP_MONTH_DAYS))).size,
  };
}

function meets(s: RepStats, r: RepRequirement): Partial<Record<keyof RepRequirement, string>> {
  const out: Partial<Record<keyof RepRequirement, string>> = {};
  if (s.loans < Math.max(1, r.minLoans)) out.minLoans = `needs ${r.minLoans} loans, has ${s.loans}`;
  if (s.volume < r.minVolume) out.minVolume = `needs ${r.minVolume}, has ${s.volume}`;
  if (s.lenders < r.minLenders) out.minLenders = `needs ${r.minLenders} lenders, has ${s.lenders}`;
  if (s.spanDays < r.minSpanDays) out.minSpanDays = `needs ${r.minSpanDays} days, has ${s.spanDays}`;
  if (s.months < r.minMonths) out.minMonths = `needs ${r.minMonths} periods, has ${s.months}`;
  return out;
}

/**
 * Picks at most REP_SLOTS loans that meet `req`: the earliest and latest funding (span), the largest loan of each of
 * the biggest lenders, the largest qualifying loan of each period, then the largest remaining loans. Throws
 * ReputationUnreachable naming what is short (against every loan the prover has, so the message is actionable).
 */
export function selectLoans(all: RepLoan[], req: RepRequirement, slots = REP_SLOTS): RepLoan[] {
  const loans = [...new Map(all.map((l) => [l.loanRef, l])).values()];
  const total = statsOf(loans, req.monthFloor);
  const shortAll = meets(total, req);
  if (Object.keys(shortAll).length) throw new ReputationUnreachable(shortAll, total);
  if (req.minLoans > slots) throw new ReputationUnreachable({ minLoans: `one proof counts at most ${slots} loans` }, total);

  const byPrincipal = [...loans].sort((a, b) => (b.principal > a.principal ? 1 : b.principal < a.principal ? -1 : Number(a.loanRef - b.loanRef)));
  const pick = new Map<bigint, RepLoan>();
  const add = (l?: RepLoan) => { if (l && pick.size < slots) pick.set(l.loanRef, l); };
  if (req.minSpanDays > 0) {
    const byDay = [...loans].sort((a, b) => Number(a.fundedDay - b.fundedDay));
    add(byDay[0]);
    add(byDay[byDay.length - 1]);
  }
  if (req.minLenders > 0) {
    const best = new Map<bigint, RepLoan>();
    for (const l of byPrincipal) if (!best.has(l.lenderF)) best.set(l.lenderF, l);
    const have = new Set([...pick.values()].map((l) => l.lenderF));
    for (const l of best.values()) { if (have.size >= req.minLenders) break; if (!have.has(l.lenderF)) { add(l); have.add(l.lenderF); } }
  }
  if (req.minMonths > 0) {
    const best = new Map<number, RepLoan>();
    for (const l of byPrincipal) {
      if (l.principal < req.monthFloor) continue;
      const m = Math.floor(Number(l.fundedDay) / REP_MONTH_DAYS);
      if (!best.has(m)) best.set(m, l);
    }
    const have = new Set([...pick.values()].filter((l) => l.principal >= req.monthFloor).map((l) => Math.floor(Number(l.fundedDay) / REP_MONTH_DAYS)));
    for (const [m, l] of best) { if (have.size >= req.minMonths) break; if (!have.has(m)) { add(l); have.add(m); } }
  }
  for (const l of byPrincipal) {
    const s = statsOf([...pick.values()], req.monthFloor);
    if (pick.size >= slots || (Object.keys(meets(s, req)).length === 0 && pick.size >= Math.max(1, req.minLoans))) break;
    add(l);
  }
  const chosen = [...pick.values()].sort((a, b) => (a.loanRef < b.loanRef ? -1 : 1));
  const s = statsOf(chosen, req.monthFloor);
  const short = meets(s, req);
  if (Object.keys(short).length) throw new ReputationUnreachable({ ...short, slots: `the claim needs more than ${slots} loans in one proof` }, s);
  return chosen;
}

// ---- the public threshold ladder (limits what one audience learns by probing thresholds)

export const LADDER = {
  loans: [1, 2, 3, 5, 8, 12, 16],
  lenders: [0, 1, 2, 3, 5, 8],
  spanDays: [0, 7, 30, 90, 180, 365, 730],
  months: [0, 1, 2, 3, 6, 9, 12, 16],
} as const;

/** 0, then 1 / 2.5 / 5 x 10^k whole tokens (k = 0..9), in base units. */
export function volumeLadder(decimals = 6): bigint[] {
  const unit = 10n ** BigInt(decimals);
  const out = [0n];
  for (let k = 0n; k <= 9n; k++) {
    const p = 10n ** k;
    out.push(p * unit, (p * unit * 5n) / 2n, p * unit * 5n);
  }
  return out;
}

const floorTo = <T extends number | bigint>(steps: readonly T[], x: T): T => {
  let best = steps[0];
  for (const s of steps) if (s <= x) best = s;
  return best;
};

/** Rounds every threshold DOWN to the ladder; the proof states the snapped values. */
export function snapRequirement(r: RepRequirement, decimals = 6): RepRequirement {
  const vol = volumeLadder(decimals);
  return {
    minLoans: floorTo(LADDER.loans, Math.max(1, r.minLoans)),
    minVolume: floorTo(vol, r.minVolume),
    minLenders: floorTo(LADDER.lenders, r.minLenders),
    minSpanDays: floorTo(LADDER.spanDays, r.minSpanDays),
    minMonths: floorTo(LADDER.months, r.minMonths),
    monthFloor: r.minMonths > 0 ? floorTo(vol, r.monthFloor) : 0n,
  };
}

export function isOnLadder(r: RepRequirement, decimals = 6): boolean {
  const s = snapRequirement(r, decimals);
  return s.minLoans === r.minLoans && s.minVolume === r.minVolume && s.minLenders === r.minLenders && s.minSpanDays === r.minSpanDays
    && s.minMonths === r.minMonths && s.monthFloor === r.monthFloor;
}

/** Range checks the circuit applies to the public thresholds (a value outside them has no proof). */
export function assertRequirementRange(r: RepRequirement): void {
  const u = (x: number, bits: number, n: string) => { if (!Number.isInteger(x) || x < 0 || x >= 2 ** bits) throw new Error(`${n} must be an integer 0..${2 ** bits - 1}`); };
  u(r.minLoans, 8, 'minLoans'); u(r.minLenders, 8, 'minLenders'); u(r.minSpanDays, 16, 'minSpanDays'); u(r.minMonths, 8, 'minMonths');
  if (r.minVolume < 0n || r.minVolume >= 1n << 64n) throw new Error('minVolume must fit 64 bits');
  if (r.monthFloor < 0n || r.monthFloor >= 1n << 64n) throw new Error('monthFloor must fit 64 bits');
}

// ---- audiences

const be = (b: Uint8Array) => { let x = 0n; for (const v of b) x = (x << 8n) | BigInt(v); return x; };

/**
 * The audience field of a verifier. Domain separated so a name can never equal a key:
 *   key (32 bytes):  sha256(0x01 || key)[0..20]
 *   name (string):   sha256(0x02 || "h081-rep-audience|" || utf8(name))[0..20]
 */
export function audienceOf(x: string | Uint8Array): bigint {
  if (typeof x === 'string') {
    const name = x.trim();
    if (!name) throw new Error('the audience name is empty');
    const body = new TextEncoder().encode(`h081-rep-audience|${name}`);
    const m = new Uint8Array(1 + body.length); m[0] = 2; m.set(body, 1);
    return be(sha256(m).subarray(0, 20));
  }
  if (x.length !== 32) throw new Error('an audience key must be 32 bytes');
  const m = new Uint8Array(33); m[0] = 1; m.set(x, 1);
  return be(sha256(m).subarray(0, 20));
}

/** A fresh 248-bit nonce. */
export function randomNonce(): bigint {
  const b = new Uint8Array(31);
  globalThis.crypto.getRandomValues(b);
  return be(b);
}

// ---- circuit input

export interface ReputationInputArgs {
  masterSk: bigint;
  /** the loans to count (at most REP_SLOTS), each in `tree` */
  loans: RepLoan[];
  tree: MerkleTree;
  req: RepRequirement;
  assetF: bigint;
  audience: bigint;
  nonce: bigint;
  expiry: bigint;
  bindTo: bigint;
}

export function reputationInput(a: ReputationInputArgs): { input: Record<string, unknown>; publicSignals: RepPublic } {
  if (a.masterSk <= 0n || a.masterSk >= FIELD) throw new Error('masterSk must be a non-zero field element');
  assertRequirementRange(a.req);
  if (a.loans.length === 0 || a.loans.length > REP_SLOTS) throw new Error(`a proof counts 1..${REP_SLOTS} loans`);
  const loans = [...a.loans].sort((x, y) => (x.loanRef < y.loanRef ? -1 : x.loanRef > y.loanRef ? 1 : 0));
  for (let i = 1; i < loans.length; i++) if (loans[i].loanRef === loans[i - 1].loanRef) throw new Error(`loan ${loans[i].loanRef} is listed twice`);
  const N = REP_SLOTS, L = REP_LEVELS;
  const z = <T>(v: T) => new Array<T>(N).fill(v);
  const enabled = z(0), keyIndex = z(0), loanRef = z<bigint>(0n), principal = z<bigint>(0n), lenderF = z<bigint>(0n), fundedDay = z<bigint>(0n);
  const pathElements: bigint[][] = Array.from({ length: N }, () => new Array<bigint>(L).fill(0n));
  const pathIndices: number[][] = Array.from({ length: N }, () => new Array<number>(L).fill(0));
  const selLo = z(0), selHi = z(0);
  loans.forEach((l, j) => {
    if (l.assetF !== a.assetF) throw new Error(`loan ${l.loanRef} is in another asset`);
    const pk = loanPk(a.masterSk, l.keyIndex);
    const leaf = repLeaf({ agentPk: pk, loanRef: l.loanRef, principal: l.principal, assetF: a.assetF, lenderF: l.lenderF, fundedDay: l.fundedDay });
    if (a.tree.leaf(l.index) !== leaf) throw new Error(`loan ${l.loanRef}: leaf ${l.index} of the rep tree is not this account's leaf for it`);
    const p = a.tree.path(l.index);
    enabled[j] = 1; keyIndex[j] = l.keyIndex; loanRef[j] = l.loanRef; principal[j] = l.principal; lenderF[j] = l.lenderF; fundedDay[j] = l.fundedDay;
    pathElements[j] = p.pathElements; pathIndices[j] = p.pathIndices;
  });
  let lo = 0, hi = 0;
  loans.forEach((l, j) => { if (l.fundedDay < loans[lo].fundedDay) lo = j; if (l.fundedDay > loans[hi].fundedDay) hi = j; });
  selLo[lo] = 1; selHi[hi] = 1;
  const pub: RepPublic = {
    repRoot: a.tree.root, asset: a.assetF,
    minLoans: BigInt(a.req.minLoans), minVolume: a.req.minVolume, minLenders: BigInt(a.req.minLenders), minSpanDays: BigInt(a.req.minSpanDays),
    minMonths: BigInt(a.req.minMonths), monthFloor: a.req.monthFloor,
    audience: a.audience, nonce: a.nonce, expiry: a.expiry, bindTo: a.bindTo, presNullifier: presNullifier(a.masterSk, a.audience),
  };
  return {
    input: { ...pub, masterSk: a.masterSk, enabled, keyIndex, loanRef, principal, lenderF, fundedDay, pathElements, pathIndices, selLo, selHi },
    publicSignals: pub,
  };
}

/** Public signals in circuit order. */
export function repPublicList(p: RepPublic): bigint[] {
  return REPUTATION_PUBLIC.map((k) => p[k]);
}

export function repPublicFromList(xs: bigint[]): RepPublic {
  if (xs.length !== REPUTATION_PUBLIC.length) throw new Error(`expected ${REPUTATION_PUBLIC.length} public signals, got ${xs.length}`);
  return Object.fromEntries(REPUTATION_PUBLIC.map((k, i) => [k, xs[i]])) as RepPublic;
}

