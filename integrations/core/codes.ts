// Hand-over codes. Every code this package makes uses the site's v2 frame further down (letters and digits only, a
// checksum, a kind and a network tag):
//   h081-loan-terms:  loanRef, pledgeBps, the lender's viewing key              (lender -> borrower)   (kind 1)
//   h081-loan-proof:  { ref, payout, proof: {a, b, c}, args: StreamArgs }       (borrower -> lender)   (kind 2)
//   h081-address:     a shielded H081 address (spending pk + viewing key) that others pay privately   (kind 5)
//   h081-key:         the agent key backup: the 32-byte Solana secret seed (CLI only, never sent anywhere)   (kind 6)
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
// 4 (practice proof) are the site's; 5 is the shielded address below, 6 the key backup, 10/11 solvency (request and
// presentation). Proposed registry across branches (docs/SOLVENCY-SPEC.md 2.2, owner decision D2): 7-9 reputation,
// 10/11 solvency, 12/13 backer.

export const FRAME_VERSION = 2;
export const CODE_KIND = { terms: 1, proof: 2, zkproof: 3, practice: 4, address: 5, key: 6, solvencyAsk: 10, solvency: 11 } as const;
const KIND_NAME: Record<number, string> = {
  1: 'loan terms code', 2: 'borrower proof code', 3: 'proof code', 4: 'practice proof code', 5: 'shielded address code', 6: 'agent key code',
  10: 'solvency request code', 11: 'solvency proof code',
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

// ---- solvency (docs/SOLVENCY-SPEC.md 2.2): the asker's request (kind 10) and the agent's presentation (kind 11)

export const SOLVENCY_ASK_PREFIX = 'h081-solvency-ask:';
export const SOLVENCY_PREFIX = 'h081-solvency:';
const SOLVENCY_VERSION = 1;
const u16le = (x: number) => Uint8Array.of(x & 0xff, (x >> 8) & 0xff);

/** What an asker puts in an "h081-solvency-ask:" code. */
export interface SolvencyRequest {
  /** the asker's ed25519 public key (its wallet), or 32 random bytes */
  verifierKey: Uint8Array;
  /** 16 random bytes; a verifier accepts each nonce once */
  nonce: Uint8Array;
  /** unix seconds; at most a day after the request is made */
  expiry: bigint;
  /** base units of USDG the proof must show at least */
  min: bigint;
  /** how many pool operations old the proof's root may be */
  maxRootAge: number;
  /** the wallet that must present (32 zero bytes: anyone) */
  expectWallet: Uint8Array;
  /** a short name for the asker, UTF-8, at most 32 bytes */
  label: string;
}

/** A decoded request plus its digest: sha256 of the framed bytes without the checksum. */
export interface DecodedSolvencyRequest extends SolvencyRequest { digest: Uint8Array }

/** What an agent hands back: the proof and its public args (kind 3's first 448 bytes), the wallet and its signature. */
export interface SolvencyPresentation {
  requestDigest: Uint8Array;
  /** encodeProof (256 bytes) */
  proof: Uint8Array;
  /** encodeDiscloseArgs (192 bytes) */
  args: Uint8Array;
  wallet: Uint8Array;
  signature: Uint8Array;
}

/** The frame without its checksum: what the request digest hashes. */
function unsummedFrame(kind: number, ctx: CodeContext, body: Uint8Array): Uint8Array {
  return Uint8Array.from([FRAME_VERSION, kind, ...contextTag(ctx), ...body]);
}

const SOLVENCY_ASK_FIXED = 1 + 32 + 16 + 8 + 8 + 2 + 32 + 1;

function solvencyRequestBody(r: SolvencyRequest): Uint8Array {
  if (r.verifierKey.length !== 32) throw new Error('verifierKey must be 32 bytes');
  if (r.nonce.length !== 16) throw new Error('nonce must be 16 bytes');
  if (r.expectWallet.length !== 32) throw new Error('expectWallet must be 32 bytes (all zero: anyone)');
  if (r.expiry < 0n || r.expiry >= 1n << 64n) throw new Error('expiry out of range');
  if (r.min <= 0n || r.min >= 1n << 64n) throw new Error('min must be a positive u64');
  if (!Number.isInteger(r.maxRootAge) || r.maxRootAge < 1 || r.maxRootAge > 1023) throw new Error('maxRootAge must be 1..1023');
  const label = new TextEncoder().encode(r.label ?? '');
  if (label.length > 32) throw new Error('the label must be at most 32 bytes');
  return Uint8Array.from([SOLVENCY_VERSION, ...r.verifierKey, ...r.nonce, ...u64le(r.expiry), ...u64le(r.min), ...u16le(r.maxRootAge), ...r.expectWallet, label.length, ...label]);
}

/** "h081-solvency-ask:<base58>": kind 10. Returns the code and its digest (the presentation commits to it). */
export function encodeSolvencyRequest(ctx: CodeContext, r: SolvencyRequest): { code: string; digest: Uint8Array } {
  const body = solvencyRequestBody(r);
  return { code: frameV2(SOLVENCY_ASK_PREFIX, CODE_KIND.solvencyAsk, ctx, body), digest: sha256(unsummedFrame(CODE_KIND.solvencyAsk, ctx, body)) };
}

/** A request made for `ctx` (checksum, kind, network checked); its digest is recomputed here, never taken from a code. */
export function decodeSolvencyRequest(ctx: CodeContext, code: string): DecodedSolvencyRequest {
  const b = unframeV2(SOLVENCY_ASK_PREFIX, CODE_KIND.solvencyAsk, ctx, code);
  if (b.length < SOLVENCY_ASK_FIXED) throw new CodeError('That solvency request code is incomplete; ask for it again.');
  if (b[0] !== SOLVENCY_VERSION) throw new CodeError(`That solvency request code is in a format this bank does not read (version ${b[0]}).`);
  const labelLen = b[SOLVENCY_ASK_FIXED - 1];
  if (labelLen > 32 || b.length !== SOLVENCY_ASK_FIXED + labelLen) throw new CodeError('That solvency request code has the wrong length; copy it again.');
  let label: string;
  try { label = new TextDecoder('utf-8', { fatal: true }).decode(b.slice(SOLVENCY_ASK_FIXED)); } catch { throw new CodeError('That solvency request code has a label that is not text.'); }
  const r: DecodedSolvencyRequest = {
    verifierKey: b.slice(1, 33), nonce: b.slice(33, 49), expiry: readU64le(b, 49), min: readU64le(b, 57), maxRootAge: b[65] | (b[66] << 8),
    expectWallet: b.slice(67, 99), label, digest: sha256(unsummedFrame(CODE_KIND.solvencyAsk, ctx, b)),
  };
  if (r.min === 0n) throw new CodeError('That solvency request asks for a minimum of 0, which proves nothing.');
  if (r.maxRootAge < 1 || r.maxRootAge > 1023) throw new CodeError('That solvency request has a root age outside 1..1023.');
  return r;
}

/** Bytes of a kind 11 body: ver | requestDigest 32 | proof 256 | DiscloseArgs 192 | wallet 32 | signature 64. */
export const SOLVENCY_CODE_BODY = 1 + 32 + 256 + 192 + 32 + 64;

/** "h081-solvency:<base58>": kind 11. The proof and args bytes are kind 3's first 448 bytes (encodeProof + encodeDiscloseArgs). */
export function encodeSolvencyCode(ctx: CodeContext, p: SolvencyPresentation): string {
  if (p.requestDigest.length !== 32 || p.proof.length !== 256 || p.args.length !== 192 || p.wallet.length !== 32 || p.signature.length !== 64) {
    throw new Error('a solvency presentation is requestDigest 32 | proof 256 | args 192 | wallet 32 | signature 64 bytes');
  }
  return frameV2(SOLVENCY_PREFIX, CODE_KIND.solvency, ctx, Uint8Array.from([SOLVENCY_VERSION, ...p.requestDigest, ...p.proof, ...p.args, ...p.wallet, ...p.signature]));
}

/** A presentation made for `ctx` (checksum, kind, network checked). Field ranges and the signature are the verifier's job. */
export function decodeSolvencyCode(ctx: CodeContext, code: string): SolvencyPresentation {
  const b = unframeV2(SOLVENCY_PREFIX, CODE_KIND.solvency, ctx, code);
  if (b.length !== SOLVENCY_CODE_BODY) throw new CodeError(`That solvency proof code has the wrong length (${b.length} of ${SOLVENCY_CODE_BODY} bytes); copy it again.`);
  if (b[0] !== SOLVENCY_VERSION) throw new CodeError(`That solvency proof code is in a format this bank does not read (version ${b[0]}).`);
  return { requestDigest: b.slice(1, 33), proof: b.slice(33, 289), args: b.slice(289, 481), wallet: b.slice(481, 513), signature: b.slice(513, 577) };
}

/** The kind of an "h081-*:" code from its prefix, or undefined. */
export const PREFIX_KIND: Record<string, number> = {
  [TERMS_PREFIX]: CODE_KIND.terms, [PROOF_PREFIX]: CODE_KIND.proof, [ADDRESS_PREFIX]: CODE_KIND.address, [KEY_PREFIX]: CODE_KIND.key,
  [SOLVENCY_ASK_PREFIX]: CODE_KIND.solvencyAsk, [SOLVENCY_PREFIX]: CODE_KIND.solvency,
};
export const KIND_NAMES: Readonly<Record<number, string>> = KIND_NAME;
