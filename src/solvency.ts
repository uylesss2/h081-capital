// Prove solvency in one line (docs/SOLVENCY-SPEC.md): the pure parts, shared by the bank (integrations/core/solvency.ts)
// and anyone who wants to check a presentation without the bank. No I/O here.
//
// A solvency proof is the ceremony'd `disclose` circuit, kind 0 (`remaining >= bound`), over ONE allowance note: the
// agent's dedicated reserve. Everything the circuit cannot bind is bound off chain:
//   - the request (asker's key, nonce, expiry, minimum, root age, expected wallet) is hashed into `requestDigest`;
//   - `audience` = sha256("h081-solvency-audience|v1|" || requestDigest || wallet)[0..31], a public input of the proof;
//   - the agent's Solana wallet signs sha256("h081-solvency-present|v1|" || requestDigest || DiscloseArgs bytes).
// The asset is private in the circuit; `assetFloor` (the largest amount any non-USDG vault could back) closes that off
// chain: a bound above it can only be USDG.
import { sha256 } from '@noble/hashes/sha2';
import { FIELD } from './crypto.js';

export const SOLVENCY_AUDIENCE_DOMAIN = 'h081-solvency-audience|v1|';
export const SOLVENCY_PRESENT_DOMAIN = 'h081-solvency-present|v1|';

/** disclose kind 0: `bound <= remaining`. The only kind a solvency proof uses (spec section 0). */
export const SOLVENCY_DISCLOSE_KIND = 0n;
/** Default for how many pool operations old the proof's root may be (spec 3.2). */
export const SOLVENCY_DEFAULT_MAX_ROOT_AGE = 32;
/** The pool keeps this many roots; an older root is unknown to the program. */
export const SOLVENCY_ROOT_HISTORY = 1024;
/** A request lives at most a day. */
export const SOLVENCY_MAX_TTL_SEC = 86_400;
/** Default lifetime of a request. */
export const SOLVENCY_DEFAULT_TTL_SEC = 30 * 60;
/** Distinct bounds one account proves to one verifier key per UTC day; a 5th is refused (a repeat is free). */
export const SOLVENCY_MAX_BOUNDS_PER_VERIFIER_DAY = 4;
/** Distinct bounds one account proves per UTC day across all verifiers; a 9th is refused. */
export const SOLVENCY_MAX_BOUNDS_PER_DAY = 8;
/** Bytes of a label in a request. */
export const SOLVENCY_MAX_LABEL = 32;

/** What every verifier surface prints (spec section 6), verbatim. */
export const SOLVENCY_DOES_NOT_SAY: readonly string[] = [
  'that the funds are still there: they are not locked and can be reclaimed or spent right after',
  'that they are not shown to other counterparties at the same time (no exclusivity)',
  'the account\'s total balance (one note; shielded notes are not counted)',
  'that the note is free of a pledge, an expiry or a recipient restriction (private policy; only the agent\'s own reserve construction makes it plain)',
  'that `wallet` derived the note\'s key (not provable without a key check in the circuit)',
  'anything about spending behaviour, debts or creditworthiness',
];

/** The default pre-deal step, for agent prompts and docs. */
export const SOLVENCY_HANDSHAKE =
  'Before a deal where you carry risk, send an `h081-solvency-ask:` for the amount at risk; deal only with the wallet a valid `h081-solvency:` names.';

// ---- the ladder: 1 / 2.5 / 5 x 10^k whole tokens

const pow10 = (k: number) => 10n ** BigInt(k);

/** Ladder steps in base units from 1 token up to 10^18 tokens. */
export function ladder(decimals: number): bigint[] {
  const one = pow10(decimals);
  const out: bigint[] = [];
  for (let k = 0; k <= 18; k++) {
    const t = one * pow10(k);
    out.push(t, (t * 5n) / 2n, t * 5n);
  }
  return out;
}

/** The smallest ladder step >= x (1 token at least). */
export function snapUp(x: bigint, decimals: number): bigint {
  for (const s of ladder(decimals)) if (s >= x) return s;
  throw new Error('amount above the ladder');
}

/** The largest ladder step <= x, or 0n when x is below one token. */
export function snapDown(x: bigint, decimals: number): bigint {
  let best = 0n;
  for (const s of ladder(decimals)) { if (s <= x) best = s; else break; }
  return best;
}

export const isOnLadder = (x: bigint, decimals: number): boolean => ladder(decimals).includes(x);

// ---- binding

const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...xs: Uint8Array[]) => { const o = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of xs) { o.set(x, i); i += x.length; } return o; };
const beInt = (b: Uint8Array) => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);

/** sha256 of the request's framed bytes without the checksum (version | kind | network tag | body). */
export const requestDigestOf = (framedUnsummed: Uint8Array): Uint8Array => sha256(framedUnsummed);

/** The disclose `audience` for one request and one presenting wallet: the first 31 bytes of the hash, big-endian (< 2^248 < field). */
export function solvencyAudience(requestDigest: Uint8Array, wallet: Uint8Array): bigint {
  if (requestDigest.length !== 32 || wallet.length !== 32) throw new Error('requestDigest and wallet must be 32 bytes');
  const a = beInt(sha256(cat(enc(SOLVENCY_AUDIENCE_DOMAIN), requestDigest, wallet)).subarray(0, 31));
  if (a >= FIELD) throw new Error('audience out of field'); // cannot happen: 248 bits
  return a;
}

/** What the wallet signs: sha256(domain || requestDigest || DiscloseArgs bytes). Domain separated: never a Solana transaction. */
export function presentationMessage(requestDigest: Uint8Array, argsBytes: Uint8Array): Uint8Array {
  if (requestDigest.length !== 32 || argsBytes.length !== 192) throw new Error('requestDigest must be 32 bytes and the args 192');
  return sha256(cat(enc(SOLVENCY_PRESENT_DOMAIN), requestDigest, argsBytes));
}

// ---- root recency and the asset floor

/**
 * How many pool operations ago `root` was the current root: (currentRootIndex - i) mod history for the newest slot i
 * holding it; undefined when the pool no longer (or never) held it.
 */
export function rootAge(roots: readonly bigint[], currentRootIndex: number, root: bigint): number | undefined {
  const n = roots.length;
  if (root === 0n) return undefined;
  for (let age = 0; age < n; age++) {
    const i = (((currentRootIndex - age) % n) + n) % n;
    if (roots[i] === root) return age;
  }
  return undefined;
}

export interface VaultCapView { mint: string; maxTotal: bigint; vaultBalance: bigint }

/**
 * The most base units any non-`usdg` vault could back: max over those vaults of max(cap.max_total, vault balance). A
 * vault never takes a deposit that would put it above its cap (ops.rs check_deposit), and notes of a mint are backed by
 * its vault, so a bound above this floor can only be held in `usdg`. 0n when there is no other vault.
 */
export function assetFloor(vaults: readonly VaultCapView[], usdg: string): bigint {
  let floor = 0n;
  for (const v of vaults) {
    if (v.mint === usdg) continue;
    const m = v.maxTotal > v.vaultBalance ? v.maxTotal : v.vaultBalance;
    if (m > floor) floor = m;
  }
  return floor;
}

/** The one-sentence statement a valid presentation supports (spec section 6). */
export function solvencyStatement(o: { bound: string; symbol: string; rootAge: number; wallet: string; assetSound: boolean }): string {
  const what = o.assetSound ? `${o.bound} ${o.symbol}` : `${o.bound} base units of SOME asset in the pool (not shown to be ${o.symbol}: a non-${o.symbol} vault could back that much)`;
  return `The holder of the reserve note for this request proved that ONE allowance note in the H081 pool, as of a pool root ${o.rootAge} operations old, had at least ${what} remaining; the wallet ${o.wallet} signed this presentation for this one request.`;
}

/** UTC day number of a unix-millisecond time. */
export const utcDay = (ms: number): number => Math.floor(ms / 86_400_000);

export interface ProbeEntry { day: number; verifier: string; bound: string }

/**
 * The probing cap (spec 2.3): refuses, within one UTC day, a 5th distinct bound to one verifier key and a 9th distinct
 * bound across all verifiers. A bound already proven today (to that verifier, or at all for the global cap) is free.
 * Returns the reason, or undefined when allowed. Pure: the caller keeps the log.
 */
export function probeBlock(log: readonly ProbeEntry[], verifier: string, bound: bigint, nowMs: number): string | undefined {
  const day = utcDay(nowMs), b = bound.toString();
  const today = log.filter((e) => e.day === day);
  const mine = new Set(today.filter((e) => e.verifier === verifier).map((e) => e.bound));
  if (!mine.has(b) && mine.size >= SOLVENCY_MAX_BOUNDS_PER_VERIFIER_DAY) {
    return `this verifier already received ${SOLVENCY_MAX_BOUNDS_PER_VERIFIER_DAY} different solvency bounds from this account today; a 5th would let it narrow down the reserve. Repeat a bound already proven today, or try again tomorrow (UTC). Nothing was proven.`;
  }
  const all = new Set(today.map((e) => e.bound));
  if (!all.has(b) && all.size >= SOLVENCY_MAX_BOUNDS_PER_DAY) {
    return `this account already proved ${SOLVENCY_MAX_BOUNDS_PER_DAY} different solvency bounds today across all verifiers; one verifier asking under several keys could narrow down the reserve. Repeat a bound already proven today, or try again tomorrow (UTC). Nothing was proven.`;
  }
  return undefined;
}
