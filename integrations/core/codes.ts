// Hand-over codes. Every code this package makes uses the site's v2 frame further down (letters and digits only, a
// checksum, a kind and a network tag):
//   h081-loan-terms:  loanRef, pledgeBps, the lender's viewing key              (lender -> borrower)   (kind 1)
//   h081-loan-proof:  { ref, payout, proof: {a, b, c}, args: StreamArgs }       (borrower -> lender)   (kind 2)
//   h081-address:     a shielded H081 address (spending pk + viewing key) that others pay privately   (kind 5)
//   h081-key:         the agent key backup: the 32-byte Solana secret seed (CLI only, never sent anywhere)   (kind 6)
//   h081-rep:         a reputation proof for one audience and challenge                       (prover -> verifier) (kind 7)
//   h081-rep-ask:     a reputation request: audience, challenge, thresholds                   (verifier -> prover) (kind 8)
//   h081-rep-sig:     the presenter's session-key signature that unlocks a bound h081-rep code (prover -> verifier) (kind 9)
// Loan codes in the first (v1) format still decode: JSON with bigints, keys and bytes tagged, base64url, prefixed
// (stipend-site/src/lib/live/bank.ts). encodeTerms / encodeProofCode make them only to test that compatibility.
import bs58 from 'bs58';
import { sha256 } from '@noble/hashes/sha256';
import { PublicKey } from '@solana/web3.js';
import type { StipendAddress } from '../../src/account.js';
import { FIELD } from '../../src/crypto.js';
import type { SolidityProof } from '../../src/prover.js';
import { slotPda } from '../../src/solana/lender.js';
import type { StreamArgs } from '../../src/solana/program.js';

export const TERMS_PREFIX = 'h081-loan-terms:';
export const PROOF_PREFIX = 'h081-loan-proof:';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function tag(v: unknown): unknown {
  if (typeof v === 'bigint') return { $b: v.toString() };
  if (v instanceof Uint8Array) return { $u: hex(v) };
  const k = v as { toBase58?: unknown; toBytes?: unknown };
  if (v && typeof k.toBase58 === 'function' && typeof k.toBytes === 'function') return { $k: (k.toBase58 as () => string)() };
  if (Array.isArray(v)) return v.map(tag);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([key, x]) => [key, tag(x)]));
  return v;
}

export function untag(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(untag);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.$b === 'string') return BigInt(o.$b);
    if (typeof o.$k === 'string') return new PublicKey(o.$k);
    if (typeof o.$u === 'string') return Uint8Array.from(o.$u.match(/../g) ?? [], (h: string) => parseInt(h, 16));
    return Object.fromEntries(Object.entries(o).map(([key, x]) => [key, untag(x)]));
  }
  return v;
}

const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

export function encodeCode(prefix: string, obj: unknown): string {
  return prefix + b64u(JSON.stringify(tag(obj)));
}

export function decodeCode<T = unknown>(prefix: string, code: string, what: string): T {
  const t = String(code).trim();
  if (!t.startsWith(prefix)) throw new Error(`That is not a ${what} (it should start with "${prefix}").`);
  try { return untag(JSON.parse(unb64u(t.slice(prefix.length)))) as T; } catch { throw new Error(`That ${what} is damaged; copy it again.`); }
}

export interface LoanTermsCode {
  v: number; cluster: string; program: string; mint: string;
  lender: PublicKey; loanRef: bigint; pledgeBps: bigint; lenderViewPub: Uint8Array;
}

export interface LoanProofCode {
  v: number; cluster: string; program: string; ref: bigint; payout: PublicKey; proof: SolidityProof; args: StreamArgs;
}

export const encodeTerms = (t: LoanTermsCode): string => encodeCode(TERMS_PREFIX, t);
export const encodeProofCode = (p: LoanProofCode): string => encodeCode(PROOF_PREFIX, p);

export function decodeTerms(code: string): LoanTermsCode {
  const t = decodeCode<Partial<LoanTermsCode>>(TERMS_PREFIX, code, 'loan terms code');
  if (t.v !== 1) throw new CodeError('That loan terms code is not in a format this bank reads; ask the lender for it again.');
  if (!(t.lender instanceof PublicKey) || typeof t.loanRef !== 'bigint' || typeof t.pledgeBps !== 'bigint' || !(t.lenderViewPub instanceof Uint8Array)) {
    throw new Error('That loan terms code is incomplete (lender, loanRef, pledgeBps and lenderViewPub are needed).');
  }
  return t as LoanTermsCode;
}

export function decodeProofCode(code: string): LoanProofCode {
  const p = decodeCode<Partial<LoanProofCode>>(PROOF_PREFIX, code, 'borrower proof code');
  if (p.v !== 1) throw new CodeError('That borrower proof code is not in a format this bank reads; ask the borrower for it again.');
  if (typeof p.ref !== 'bigint' || !(p.payout instanceof PublicKey) || !p.proof || !p.args) throw new Error('That borrower proof code is incomplete.');
  return p as LoanProofCode;
}

// ------------------------------------------------------------------ framed codes (v2)
// Codes one agent hands to another go through the site's v2 frame (stipend-site/src/lib/live/frame.ts), byte for
// byte: a base58 payload (letters and digits only, so chat apps and Markdown leave it whole) of
//   version (2) | kind | 4-byte network tag | body | 4-byte checksum
// The network tag is sha256("h081-handover|<cluster>|<program>|<mint>")[0..4]: a code made for another network,
// program or asset is refused with its own message. Kinds 1 (loan terms), 2 (loan proof), 3 (zk proof) and
// 4 (practice proof) are the site's; 5 is the shielded address below.

export const FRAME_VERSION = 2;
export const CODE_KIND = { terms: 1, proof: 2, zkproof: 3, practice: 4, address: 5, key: 6, reputation: 7, repRequest: 8, repSig: 9 } as const;
const KIND_NAME: Record<number, string> = {
  1: 'loan terms code', 2: 'borrower proof code', 3: 'proof code', 4: 'practice proof code', 5: 'shielded address code', 6: 'agent key code',
  7: 'reputation proof code', 8: 'reputation request code', 9: 'reputation presenter signature',
};

/** Which network, program and asset a code belongs to. */
export interface CodeContext { cluster: string; program: string; mint: string }

const sha4 = (b: Uint8Array) => sha256(b).slice(0, 4);
const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
export const contextTag = (c: CodeContext): Uint8Array => sha4(new TextEncoder().encode(`h081-handover|${c.cluster}|${c.program}|${c.mint}`));

/** v2 frame: version | kind | 4-byte context tag | body | 4-byte checksum, as base58 after the prefix. */
export function frameV2(prefix: string, kind: number, ctx: CodeContext, body: Uint8Array): string {
  const unsummed = Uint8Array.from([FRAME_VERSION, kind, ...contextTag(ctx), ...body]);
  return prefix + bs58.encode(Uint8Array.from([...unsummed, ...sha4(unsummed)]));
}

/** A code that cannot be used; the message says why and what to do. Nothing is ever sent on one. */
export class CodeError extends Error {
  readonly code = 'BAD_HANDOVER_CODE';
  constructor(message: string) { super(message); this.name = 'CodeError'; }
}

// what copying adds: invisible characters, look-alike dashes, wrapping quotes / brackets / Markdown, trailing punctuation
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤﻿]/g;
const DASHES = /[‐-―−﹘﹣－]/g;
const WRAPPERS = /["'`<>()[\]{}*~|‘-‟«»‹›]/g;

/**
 * Reads a v2 code of `kind`: tolerant of spaces, line breaks, invisible characters, quotes and a missing prefix;
 * strict about the checksum, the kind and the network tag.
 */
export function unframeV2(prefix: string, kind: number, ctx: CodeContext, input: string): Uint8Array {
  const name = KIND_NAME[kind] ?? 'code';
  const text = String(input ?? '').normalize('NFKC').replace(INVISIBLE, '').replace(DASHES, '-').replace(/\s+/g, '').replace(WRAPPERS, '').replace(/[.,;:!?]+$/, '');
  if (!text) throw new CodeError(`Give the ${name} (it starts with "${prefix}").`);
  const other = /^h081-[a-z-]+:/i.exec(text);
  if (other && other[0].toLowerCase() !== prefix) throw new CodeError(`That is a "${other[0]}" code, not a ${name} (it should start with "${prefix}").`);
  const payload = text.toLowerCase().startsWith(prefix) ? text.slice(prefix.length) : text;
  if (!payload) throw new CodeError(`That ${name} has nothing after its prefix: only the start was copied.`);
  let all: Uint8Array;
  try { all = bs58.decode(payload); } catch { throw new CodeError(`That ${name} contains characters a code never has (letters and digits only); copy it again.`); }
  if (all.length < 10) throw new CodeError(`That ${name} is far too short: most of it was cut off.`);
  const body = all.slice(0, -4);
  if (!bytesEqual(sha4(body), all.slice(-4))) throw new CodeError(`That ${name} does not pass its built-in check: it was cut off or changed when it was copied.`);
  if (body[0] !== FRAME_VERSION) throw new CodeError(`That ${name} has an unknown version (${body[0]}).`);
  if (body[1] !== kind) throw new CodeError(`That is a ${KIND_NAME[body[1]] ?? `code of kind ${body[1]}`}, not a ${name}.`);
  if (!bytesEqual(body.slice(2, 6), contextTag(ctx))) throw new CodeError(`That ${name} is for another network, program or asset than this bank (${ctx.cluster}).`);
  return body.slice(6);
}

// ---- shielded address: what an agent hands out to be paid privately (note to note)

export const ADDRESS_PREFIX = 'h081-address:';

const be32 = (x: bigint) => { const b = new Uint8Array(32); for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
const readBe = (b: Uint8Array) => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);

/** "h081-address:<base58>": kind 5, body = spending pk (32 bytes, big-endian field element) | viewing pub (32 bytes). */
export function encodeAddressCode(ctx: CodeContext, a: StipendAddress): string {
  if (a.pk <= 0n || a.pk >= FIELD) throw new Error('the shielded address pk is not a field element');
  if (a.viewPub.length !== 32) throw new Error('the viewing key must be 32 bytes');
  return frameV2(ADDRESS_PREFIX, CODE_KIND.address, ctx, Uint8Array.from([...be32(a.pk), ...a.viewPub]));
}

export function decodeAddressCode(ctx: CodeContext, code: string): StipendAddress {
  const body = unframeV2(ADDRESS_PREFIX, CODE_KIND.address, ctx, code);
  if (body.length !== 64) throw new CodeError('That shielded address code is incomplete (64 bytes expected); copy it again.');
  const pk = readBe(body.slice(0, 32));
  if (pk === 0n || pk >= FIELD) throw new CodeError('That shielded address code does not hold a valid address.');
  return { pk, viewPub: body.slice(32) };
}

// ---- loan codes in the v2 frame (kinds 1 and 2), byte for byte the site's (stipend-site/src/lib/live/codes.ts). Their
// network tag is made with the stream_loan program (not the pool): `loanCodeContext` below. Codes in the old v1 format
// still decode (decodeLoanTerms / decodeLoanProof fall back to it); everything this package makes is v2.

/** What a borrower needs from a lender: the slot, the share of every payment routed to it, the lender's viewing key. */
export interface LoanTerms { loanRef: bigint; pledgeBps: bigint; lenderViewPub: Uint8Array }
/** What a lender funds against: the slot, the borrower's payout token account, the stream proof and its public args. */
export interface LoanProof { ref: bigint; payout: PublicKey; proof: SolidityProof; args: StreamArgs }

/** The share of every payment a terms code may ask for, as the site accepts it: 1% to 90%. */
export const PLEDGE_BPS_MIN = 100n;
export const PLEDGE_BPS_MAX = 9000n;

const u64le = (x: bigint) => { const b = new Uint8Array(8); for (let i = 0; i < 8; i++) b[i] = Number((x >> BigInt(8 * i)) & 0xffn); return b; };
const readU64le = (b: Uint8Array, o: number) => { let x = 0n; for (let i = 7; i >= 0; i--) x = (x << 8n) | BigInt(b[o + i]); return x; };

/** "h081-loan-terms:<base58>": kind 1, body = loanRef u64 LE | pledgeBps u16 LE | lender viewing pub (32 bytes). */
export function encodeLoanTerms(ctx: CodeContext, t: LoanTerms): string {
  if (t.lenderViewPub.length !== 32) throw new Error('the lender viewing key must be 32 bytes');
  if (t.loanRef < 0n || t.loanRef >= 1n << 64n) throw new Error('loanRef out of range');
  if (t.pledgeBps < PLEDGE_BPS_MIN || t.pledgeBps > PLEDGE_BPS_MAX) throw new Error('pledgeBps must be 100..9000 (1% to 90% of each payment)');
  const body = new Uint8Array(42);
  body.set(u64le(t.loanRef), 0);
  body[8] = Number(t.pledgeBps & 0xffn); body[9] = Number(t.pledgeBps >> 8n);
  body.set(t.lenderViewPub, 10);
  return frameV2(TERMS_PREFIX, CODE_KIND.terms, ctx, body);
}

/** "h081-loan-proof:<base58>": kind 2, body = the tagged JSON of { ref, payout, proof, args } (as the site makes it). */
export function encodeLoanProof(ctx: CodeContext, p: LoanProof): string {
  return frameV2(PROOF_PREFIX, CODE_KIND.proof, ctx, new TextEncoder().encode(JSON.stringify(tag({ ref: p.ref, payout: p.payout, proof: p.proof, args: p.args }))));
}

function checkLoanTerms(t: Partial<LoanTerms>): LoanTerms {
  if (typeof t.loanRef !== 'bigint' || typeof t.pledgeBps !== 'bigint' || !(t.lenderViewPub instanceof Uint8Array) || t.lenderViewPub.length !== 32) {
    throw new CodeError('That loan terms code is missing parts; ask the lender for it again.');
  }
  if (t.pledgeBps < PLEDGE_BPS_MIN || t.pledgeBps > PLEDGE_BPS_MAX) throw new CodeError('Those loan terms ask for a share outside 1% to 90% of each payment, which is not accepted.');
  return { loanRef: t.loanRef, pledgeBps: t.pledgeBps, lenderViewPub: t.lenderViewPub };
}

function checkLoanProof(p: Partial<LoanProof> | undefined): LoanProof {
  const a = p?.args as Partial<StreamArgs> | undefined;
  if (!p || typeof p.ref !== 'bigint' || !(p.payout instanceof PublicKey) || !p.proof || !a
    || !(a.lender instanceof PublicKey) || !(a.asset instanceof PublicKey) || typeof a.minRemaining !== 'bigint' || typeof a.loanRef !== 'bigint'
    || typeof a.pledgeBps !== 'number' || typeof a.audience !== 'bigint' || typeof a.expiry !== 'bigint') {
    throw new CodeError('That borrower proof code is missing parts; ask the borrower for it again.');
  }
  return p as LoanProof;
}

/** The v2 code, else (when it is not one) the v1 code; a v1 code must name `ctx`. The v2 error wins when neither reads. */
function decodeLoan<T>(prefix: string, kind: number, ctx: CodeContext, input: string, v2: (body: Uint8Array) => T, v1: () => { ctx: Partial<CodeContext>; value: T }): T {
  let body: Uint8Array;
  try { body = unframeV2(prefix, kind, ctx, input); } catch (e2) {
    let old: { ctx: Partial<CodeContext>; value: T };
    // not v1 either: the v2 reason (cut off, changed, wrong kind or network) is the useful one, unless v1 parsed and said why
    try { old = v1(); } catch (e1) { throw e1 instanceof CodeError || /incomplete/.test((e1 as Error).message) ? e1 : e2; }
    // as the site's tryV1: cluster and program always, and a terms code must name this asset (a missing mint is refused)
    const mintOk = kind === CODE_KIND.terms ? old.ctx.mint === ctx.mint : old.ctx.mint === undefined || old.ctx.mint === ctx.mint;
    if (old.ctx.cluster !== ctx.cluster || old.ctx.program !== ctx.program || !mintOk) {
      throw new CodeError(`That ${KIND_NAME[kind]} is for another network, loan program or asset than this bank (${ctx.cluster}).`);
    }
    return old.value;
  }
  return v2(body);
}

/** A lender's "h081-loan-terms:" code for `ctx` (loanCodeContext): v2, or the old v1 format. */
export function decodeLoanTerms(ctx: CodeContext, input: string): LoanTerms {
  return decodeLoan(TERMS_PREFIX, CODE_KIND.terms, ctx, input, (b) => {
    if (b.length !== 42) throw new CodeError('That loan terms code has the wrong length; copy it again.');
    return checkLoanTerms({ loanRef: readU64le(b, 0), pledgeBps: BigInt(b[8] | (b[9] << 8)), lenderViewPub: b.slice(10, 42) });
  }, () => {
    const t = decodeTerms(String(input).trim());
    if (t.program === ctx.program && !t.lender.equals(slotPda(t.loanRef, new PublicKey(ctx.program)))) {
      throw new CodeError('Those loan terms name an account that is not the loan slot.');
    }
    return { ctx: { cluster: t.cluster, program: t.program, mint: t.mint }, value: checkLoanTerms(t) };
  });
}

/** A borrower's "h081-loan-proof:" code for `ctx` (loanCodeContext): v2, or the old v1 format. */
export function decodeLoanProof(ctx: CodeContext, input: string): LoanProof {
  return decodeLoan(PROOF_PREFIX, CODE_KIND.proof, ctx, input, (b) => {
    let o: unknown;
    try { o = untag(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b))); } catch { throw new CodeError('That borrower proof code could not be read; copy it again.'); }
    return checkLoanProof(o as Partial<LoanProof>);
  }, () => {
    const p = decodeProofCode(String(input).trim());
    return { ctx: { cluster: p.cluster, program: p.program }, value: checkLoanProof(p) };
  });
}

// ---- agent key backup: the one code that restores the agent key, and with it the shielded account and its sub-accounts

export const KEY_PREFIX = 'h081-key:';

/** "h081-key:<base58>": kind 6, body = the 32-byte Solana secret seed. Whoever holds it controls the agent's funds. */
export function encodeKeyCode(ctx: CodeContext, seed: Uint8Array): string {
  if (seed.length !== 32) throw new Error('the agent key seed must be 32 bytes');
  return frameV2(KEY_PREFIX, CODE_KIND.key, ctx, seed);
}

/** The 32-byte seed in an "h081-key:" code made for `ctx` (checksum, kind and network checked). */
export function decodeKeyCode(ctx: CodeContext, code: string): Uint8Array {
  const body = unframeV2(KEY_PREFIX, CODE_KIND.key, ctx, code);
  if (body.length !== 32) throw new CodeError('That agent key code is incomplete (32 bytes expected); copy it again.');
  return body;
}

// ---- reputation codes (kinds 7, 8, 9). Network tag: { cluster, program: rep_registry id, mint: USDG }. The asset is
// implicit (the tag's mint): a verifier rebuilds it as fieldOf(USDG).

export const REP_PREFIX = 'h081-rep:';
export const REP_ASK_PREFIX = 'h081-rep-ask:';
export const REP_SIG_PREFIX = 'h081-rep-sig:';
const REP_CODE_VERSION = 1;

/** Thresholds a reputation code states (all lower bounds). */
export interface RepThresholds { minLoans: number; minVolume: bigint; minLenders: number; minSpanDays: number; minMonths: number; monthFloor: bigint }

/** What an "h081-rep:" code carries: the proof, its public inputs (asset implicit) and the tree version it was made on. */
export interface RepCode extends RepThresholds {
  treeVersion: number;
  proof: Uint8Array;
  repRoot: bigint; presNullifier: bigint; audience: bigint; nonce: bigint; expiry: bigint; bindTo: bigint;
}

/** What an "h081-rep-ask:" code carries: who asks, the challenge, the thresholds, and an optional binding and label. */
export interface RepRequestCode extends RepThresholds {
  audience: bigint; nonce: bigint; expiry: bigint; bindTo: bigint; label: string;
}

/** "h081-rep-sig:": the session key the code is bound to (bindTo = fieldOf(pub)) and its signature over the challenge. */
export interface RepSigCode { pub: Uint8Array; sig: Uint8Array }

class W {
  private parts: number[] = [];
  u8(x: number) { if (!Number.isInteger(x) || x < 0 || x > 255) throw new Error('u8 out of range'); this.parts.push(x); return this; }
  u16(x: number) { if (!Number.isInteger(x) || x < 0 || x > 0xffff) throw new Error('u16 out of range'); this.parts.push(x & 0xff, x >> 8); return this; }
  u64(x: bigint) { if (x < 0n || x >= 1n << 64n) throw new Error('u64 out of range'); this.parts.push(...u64le(x)); return this; }
  f(x: bigint) { if (x < 0n || x >= FIELD) throw new Error('not a field element'); this.parts.push(...be32(x)); return this; }
  raw(b: Uint8Array) { this.parts.push(...b); return this; }
  done() { return Uint8Array.from(this.parts); }
}
class R {
  o = 0;
  constructor(private b: Uint8Array, private what: string) {}
  need(n: number) { if (this.o + n > this.b.length) throw new CodeError(`That ${this.what} is incomplete; copy it again.`); }
  u8() { this.need(1); return this.b[this.o++]; }
  u16() { this.need(2); const v = this.b[this.o] | (this.b[this.o + 1] << 8); this.o += 2; return v; }
  u64() { this.need(8); const v = readU64le(this.b, this.o); this.o += 8; return v; }
  f() { this.need(32); const v = readBe(this.b.slice(this.o, this.o + 32)); this.o += 32; if (v >= FIELD) throw new CodeError(`That ${this.what} holds a value out of range.`); return v; }
  raw(n: number) { this.need(n); const v = this.b.slice(this.o, this.o + n); this.o += n; return v; }
  end() { if (this.o !== this.b.length) throw new CodeError(`That ${this.what} has the wrong length; copy it again.`); }
}

const thresholdsOut = (w: W, t: RepThresholds) => w.u8(t.minLoans).u64(t.minVolume).u8(t.minLenders).u16(t.minSpanDays).u8(t.minMonths).u64(t.monthFloor);
const thresholdsIn = (r: R): RepThresholds => ({ minLoans: r.u8(), minVolume: r.u64(), minLenders: r.u8(), minSpanDays: r.u16(), minMonths: r.u8(), monthFloor: r.u64() });

/** "h081-rep:<base58>": kind 7, body = ver 1 | treeVersion u16 | proof 256 | repRoot | presNullifier | audience | nonce (32 each) | expiry u64 | bindTo 32 | thresholds (21 B). 448 bytes. */
export function encodeRepCode(ctx: CodeContext, c: RepCode): string {
  if (c.proof.length !== 256) throw new Error('the proof must be 256 bytes');
  const w = new W().u8(REP_CODE_VERSION).u16(c.treeVersion).raw(c.proof).f(c.repRoot).f(c.presNullifier).f(c.audience).f(c.nonce).u64(c.expiry).f(c.bindTo);
  return frameV2(REP_PREFIX, CODE_KIND.reputation, ctx, thresholdsOut(w, c).done());
}

export function decodeRepCode(ctx: CodeContext, code: string): RepCode {
  const what = KIND_NAME[CODE_KIND.reputation];
  const r = new R(unframeV2(REP_PREFIX, CODE_KIND.reputation, ctx, code), what);
  if (r.u8() !== REP_CODE_VERSION) throw new CodeError(`That ${what} is in a format this bank does not read; ask for a new one.`);
  const treeVersion = r.u16(), proof = r.raw(256);
  const repRoot = r.f(), presNullifier = r.f(), audience = r.f(), nonce = r.f(), expiry = r.u64(), bindTo = r.f();
  const t = thresholdsIn(r);
  r.end();
  return { treeVersion, proof, repRoot, presNullifier, audience, nonce, expiry, bindTo, ...t };
}

/** "h081-rep-ask:<base58>": kind 8, body = ver 1 | audience | nonce | expiry u64 | bindTo (0 = none) | thresholds | label len u8 + UTF-8 (at most 32 bytes). */
export function encodeRepRequest(ctx: CodeContext, q: RepRequestCode): string {
  const label = new TextEncoder().encode(q.label ?? '');
  if (label.length > 32) throw new Error('the request label is at most 32 bytes');
  const w = new W().u8(REP_CODE_VERSION).f(q.audience).f(q.nonce).u64(q.expiry).f(q.bindTo);
  return frameV2(REP_ASK_PREFIX, CODE_KIND.repRequest, ctx, thresholdsOut(w, q).u8(label.length).raw(label).done());
}

export function decodeRepRequest(ctx: CodeContext, code: string): RepRequestCode {
  const what = KIND_NAME[CODE_KIND.repRequest];
  const r = new R(unframeV2(REP_ASK_PREFIX, CODE_KIND.repRequest, ctx, code), what);
  if (r.u8() !== REP_CODE_VERSION) throw new CodeError(`That ${what} is in a format this bank does not read; ask for a new one.`);
  const audience = r.f(), nonce = r.f(), expiry = r.u64(), bindTo = r.f();
  const t = thresholdsIn(r);
  const n = r.u8();
  if (n > 32) throw new CodeError(`That ${what} has a label longer than 32 bytes.`);
  let label: string;
  try { label = new TextDecoder('utf-8', { fatal: true }).decode(r.raw(n)); } catch { throw new CodeError(`That ${what} has an unreadable label.`); }
  r.end();
  return { audience, nonce, expiry, bindTo, label, ...t };
}

/** "h081-rep-sig:<base58>": kind 9, body = session pub 32 | ed25519 signature 64. */
export function encodeRepSig(ctx: CodeContext, s: RepSigCode): string {
  if (s.pub.length !== 32 || s.sig.length !== 64) throw new Error('a presenter signature is a 32-byte key and a 64-byte signature');
  return frameV2(REP_SIG_PREFIX, CODE_KIND.repSig, ctx, Uint8Array.from([...s.pub, ...s.sig]));
}

export function decodeRepSig(ctx: CodeContext, code: string): RepSigCode {
  const body = unframeV2(REP_SIG_PREFIX, CODE_KIND.repSig, ctx, code);
  if (body.length !== 96) throw new CodeError('That reputation presenter signature has the wrong length; copy it again.');
  return { pub: body.slice(0, 32), sig: body.slice(32) };
}

/** What the presenter's session key signs: sha256("h081-rep-present|" || audience || nonce || presNullifier), 32-byte fields. */
export function repPresentationMessage(audience: bigint, nonce: bigint, presNullifier: bigint): Uint8Array {
  return sha256(Uint8Array.from([...new TextEncoder().encode('h081-rep-present|'), ...be32(audience), ...be32(nonce), ...be32(presNullifier)]));
}

/** The kind of an "h081-*:" code from its prefix, or undefined. */
export const PREFIX_KIND: Record<string, number> = {
  [TERMS_PREFIX]: CODE_KIND.terms, [PROOF_PREFIX]: CODE_KIND.proof, [ADDRESS_PREFIX]: CODE_KIND.address, [KEY_PREFIX]: CODE_KIND.key,
  [REP_PREFIX]: CODE_KIND.reputation, [REP_ASK_PREFIX]: CODE_KIND.repRequest, [REP_SIG_PREFIX]: CODE_KIND.repSig,
};
export const KIND_NAMES: Readonly<Record<number, string>> = KIND_NAME;
