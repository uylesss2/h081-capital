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
// What it does NOT bind: that the note is unspent. The pool's Merkle tree is append-only and disclose checks no
// nullifier, so a note spent or reclaimed long ago is still a leaf of every later root and still proves at the
// current root (rootAge 0). Root recency dates the PROOF, never the note.
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
  'that the funds are there now, or were there when the proof was made: the note may have been spent or reclaimed BEFORE the proof (the pool\'s tree is append-only and disclose checks no nullifier, so a spent or reclaimed note still proves against the CURRENT root; rootAge dates the proof, not the note) or right after (nothing is locked)',
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

export interface VaultCapView {
  mint: string; maxTotal: bigint; vaultBalance: bigint;
  /** the most the vault ever held, at any point of any transaction since it was created (vaultTxPeak over its history) */
  peak: bigint;
}

const max = (...xs: bigint[]) => xs.reduce((m, x) => (x > m ? x : m), 0n);

/**
 * The most base units any non-`usdg` vault could back: max over those vaults of max(cap.max_total, balance, PEAK).
 * Every unspent note of a mint is backed by its vault, so a note of remaining R was written while the vault held at
 * least R. Notes are never removed from the tree (no nullifier in disclose), so a note written while the vault was
 * large still proves after its cap is lowered and the vault drained: the vault's HISTORICAL peak bounds every note it
 * ever backed; today's cap and balance alone do not. A bound above this floor can only be held in `usdg`. 0n when there
 * is no other vault.
 */
export function assetFloor(vaults: readonly VaultCapView[], usdg: string): bigint {
  let floor = 0n;
  for (const v of vaults) {
    if (v.mint === usdg) continue;
    const m = max(v.maxTotal, v.vaultBalance, v.peak);
    if (m > floor) floor = m;
  }
  return floor;
}

/** SPL Token and Token-2022: the programs whose instructions move a vault's tokens. */
export const TOKEN_PROGRAM_IDS: readonly string[] = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];

/** One transaction of a vault's history, from a jsonParsed getTransaction (keys include lookup-table ones). */
export interface VaultTx {
  keys: readonly string[];
  pre: ReadonlyArray<{ accountIndex: number; amount: string }>;
  post: ReadonlyArray<{ accountIndex: number; amount: string }>;
  /** top-level and inner instructions: parsed ({type, info}) or raw (accounts) */
  ixs: ReadonlyArray<{ programId: string; parsed?: unknown; accounts?: readonly string[] }>;
  /** the transaction failed: its state changes, inflows included, were rolled back */
  failed?: boolean;
}

/** Token instructions that never credit the account they name. */
const NO_INFLOW = new Set([
  'initializeAccount', 'initializeAccount2', 'initializeAccount3', 'initializeImmutableOwner', 'getAccountDataSize', 'burn', 'burnChecked', 'approve',
  'approveChecked', 'revoke', 'setAuthority', 'closeAccount', 'freezeAccount', 'thawAccount', 'syncNative', 'reallocate',
]);

/**
 * The most `vault` held at any point inside one transaction: max(before, after, before + every inflow). Inflows are
 * counted without the outflows, so a deposit taken out again in the same transaction still counts. `createdHere`: the
 * vault had no token balance before (the transaction that created it). A failed transaction moved nothing: only its
 * balances count. `before` / `after` let the caller check that consecutive transactions join up (no gap). Throws on
 * what it cannot read (no balance after, an unparsed token instruction naming the vault, a token instruction type it
 * does not know): the caller fails closed.
 */
export function vaultTxPeak(vault: string, tx: VaultTx): { peak: bigint; createdHere: boolean; before?: bigint; after: bigint } {
  const i = tx.keys.indexOf(vault);
  if (i < 0) throw new Error(`a transaction in the vault's history does not name the vault ${vault}`);
  const amt = (xs: VaultTx['pre']) => { const b = xs.find((x) => x.accountIndex === i); return b ? BigInt(b.amount) : undefined; };
  const before = amt(tx.pre), after = amt(tx.post);
  if (after === undefined) throw new Error(`a transaction in the vault's history shows no token balance for the vault ${vault} after it`);
  let inflow = 0n;
  for (const ix of tx.failed ? [] : tx.ixs) {
    if (!TOKEN_PROGRAM_IDS.includes(ix.programId)) continue;
    const p = ix.parsed as { type?: string; info?: Record<string, unknown> } | undefined;
    if (!p || typeof p !== 'object' || !p.info) {
      if ((ix.accounts ?? []).includes(vault)) throw new Error(`a token instruction naming the vault ${vault} could not be read`);
      continue;
    }
    const info = p.info;
    const units = (o: Record<string, unknown>) => BigInt(String(o.amount ?? (o.tokenAmount as { amount?: string } | undefined)?.amount ?? 'x'));
    if ((p.type === 'transfer' || p.type === 'transferChecked') && info.destination === vault) inflow += units(info);
    else if ((p.type === 'mintTo' || p.type === 'mintToChecked') && info.account === vault) inflow += units(info);
    else if (p.type === 'transfer' || p.type === 'transferChecked' || p.type === 'mintTo' || p.type === 'mintToChecked' || NO_INFLOW.has(String(p.type))) continue;
    else if (Object.values(info).includes(vault)) throw new Error(`a token instruction "${p.type}" names the vault ${vault}; its effect on the balance is not known here`);
  }
  return { peak: max(before ?? 0n, after, (before ?? 0n) + inflow), createdHere: before === undefined, ...(before === undefined ? {} : { before }), after };
}

/** The one-sentence statement a valid presentation supports (spec section 6). */
export function solvencyStatement(o: { bound: string; symbol: string; rootAge: number; wallet: string; assetSound: boolean }): string {
  const what = o.assetSound ? `${o.bound} ${o.symbol}` : `${o.bound} base units of SOME asset in the pool (not shown to be ${o.symbol}: a non-${o.symbol} vault could back that much)`;
  return `Someone who knows the figures of ONE allowance note that was written into the H081 pool at some point (it may since have been spent or reclaimed: the circuit checks no nullifier) proved that the note had at least ${what} remaining when it was written; the proof was made against a pool root ${o.rootAge} operations old, which dates when the proof was made, not when the note was last unspent; the wallet ${o.wallet} signed this presentation for this one request.`;
}

/** UTC day number of a unix-millisecond time. */
export const utcDay = (ms: number): number => Math.floor(ms / 86_400_000);

/** One ask the prover took up: `proven` false for an attempt that ended in a plan or a refusal (absent = proven). */
export interface ProbeEntry { day: number; verifier: string; bound: string; proven?: boolean }

/**
 * The probing cap (spec 2.3): refuses, within one UTC day, a 5th distinct bound to one verifier key (attempts count,
 * answered or not) and a 9th distinct PROVEN bound across all verifiers. A bound already asked by that verifier today,
 * or proven to anyone today for the global cap, is free. Unanswered attempts stay out of the global count: they taught
 * nobody anything beyond their own key's slots, and counting them let anyone lock out every asker for the day.
 * Returns the reason, or undefined when allowed. Pure: the caller keeps the log.
 */
export function probeBlock(log: readonly ProbeEntry[], verifier: string, bound: bigint, nowMs: number): string | undefined {
  const day = utcDay(nowMs), b = bound.toString();
  const today = log.filter((e) => e.day === day);
  const mine = new Set(today.filter((e) => e.verifier === verifier).map((e) => e.bound));
  if (!mine.has(b) && mine.size >= SOLVENCY_MAX_BOUNDS_PER_VERIFIER_DAY) {
    return `this verifier already received ${SOLVENCY_MAX_BOUNDS_PER_VERIFIER_DAY} different solvency bounds from this account today; a 5th would let it narrow down the reserve. Repeat a bound already proven today, or try again tomorrow (UTC). Nothing was proven.`;
  }
  const all = new Set(today.filter((e) => e.proven !== false).map((e) => e.bound));
  if (!all.has(b) && all.size >= SOLVENCY_MAX_BOUNDS_PER_DAY) {
    return `this account already proved ${SOLVENCY_MAX_BOUNDS_PER_DAY} different solvency bounds today across all verifiers; one verifier asking under several keys could narrow down the reserve. Repeat a bound already proven today, or try again tomorrow (UTC). Nothing was proven.`;
  }
  return undefined;
}
