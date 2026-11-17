// Backed lines on stream_loan (docs/BACKER-SPEC.md): a backer stakes the loan asset behind one borrower's draw key, so
// a borrower with no stream to pledge can borrow from any lender against that stake.
// Program layer (PDAs, instruction builders, decoders, the pure math mirrored from programs/stream_loan/src/backer.rs)
// and three role helpers: SolanaBacker, SolanaBackedBorrower and the lender's calls (fundBacked, claimBacked, ...).
import { sha256 } from '@noble/hashes/sha2';
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import { type SentTx, send } from './buffer.js';
import { be32, concatBytes, fieldOf, u16le, u64le } from './field.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, GRACE, LOAN_TREASURY, LOCALNET_LOAN_PROGRAM_ID, MAINNET_LOAN_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, type SlotAccount,
  type SubrogationAccount, associatedTokenAddress, decodeLedger, decodeSlot, decodeSubrogation, isSlotAccount, ledgerPda, loanTreasuryAccount,
  originationFee, slotEscrow, slotInbox, slotPda, subrogationPda, syncIx,
} from './lender.js';
import { pullLenderShareIx } from './ops.js';
import { LOCALNET_POOL_PROGRAM_ID } from './program.js';
import { createAtaIdempotentIx } from './token.js';

/** The localnet-only `fast` test build of stream_loan (solana/keys/stream_loan_fast-keypair.json). Never deployed. */
export const LOCALNET_LOAN_FAST_PROGRAM_ID = new PublicKey('Dbb9qZhHanDqz4zAFWhyw35PiziKEWiZ9vZ876q6a2yG');

// ---- compile-time limits of the program (backer.rs); the program enforces them, these are for early refusals ----
/** Full cover: the lender's whole due (advance + lender fee) is reserved. The only cover a mainnet line may offer (v1). */
export const FULL_COVER_BPS = 10_000;
/** Lowest cover the mainnet build accepts. */
export const MAINNET_MIN_COVER_BPS = 10_000;
/** Lowest cover a localnet build accepts (partial cover is test-only in v1). */
export const LOCALNET_MIN_COVER_BPS = 2_000;
export const MAX_BACKER_FEE_BPS = 2_000;
export const MAX_LENDER_FEE_BPS = 2_000;
/** The lender-fee cap a line gets when the backer names none (5%): the reserve covers advance + lender fee, so the cap
 * bounds how far one draw can reach into the stake past its advance. */
export const DEFAULT_MAX_LENDER_FEE_BPS = 500;
export const MIN_ADVANCE = 1_000_000n;
export const MAX_DRAW = 10_000_000_000n;
export const MAX_OPEN_DRAWS = 8;
export const MIN_TERM = 86_400n;
export const MAX_LINE_TERM = 180n * 86_400n;
export const MAX_REQUEST_TTL = 7n * 86_400n;
export const CLAIM_WINDOW = 30n * 86_400n;
export const RECOVERY_HORIZON = 365n * 86_400n;
/** The fast test build's GRACE / MIN_TERM / CLAIM_WINDOW / RECOVERY_HORIZON (seconds). */
export const FAST = { grace: 2n, minTerm: 1n, claimWindow: 5n, recoveryHorizon: 5n } as const;
/** Combined fees above this share of the advance get a warning in the SDK (the program allows up to 40%). */
export const FEE_WARN_BPS = 1_000;

/** The program's time constants for a stream_loan build. */
export function backerTimes(programId: PublicKey): { grace: bigint; minTerm: bigint; claimWindow: bigint; recoveryHorizon: bigint } {
  return programId.equals(LOCALNET_LOAN_FAST_PROGRAM_ID) ? { ...FAST } : { grace: GRACE, minTerm: MIN_TERM, claimWindow: CLAIM_WINDOW, recoveryHorizon: RECOVERY_HORIZON };
}
export const minCoverFor = (programId: PublicKey): number => (programId.equals(MAINNET_LOAN_PROGRAM_ID) ? MAINNET_MIN_COVER_BPS : LOCALNET_MIN_COVER_BPS);

/** stream_loan error codes of backed lines (6000 + index; appended after ReceiptNotWritable = 6039). */
export const BACKER_ERROR = {
  BackingTerms: 6040, NotTheBacker: 6041, NotTheDrawKey: 6042, DrawState: 6043, StakeShort: 6044, LineExpired: 6045, TooManyDraws: 6046,
  DrawTooLarge: 6047, NoBackedDefault: 6048, NotReleasable: 6049, BackingBusy: 6050, LenderNotAllowed: 6051, AssetNotBackable: 6052,
  TermsMismatch: 6053, CoverTooLow: 6054, RequestExpired: 6055, ReceiptsPending: 6056, BadVault: 6057,
} as const;

export const BACKING_ACCOUNT_SIZE = 278;
export const DRAW_ACCOUNT_SIZE = 178;

export const DRAW_STATE = { requested: 0, funded: 1, claimed: 2, released: 3 } as const;
export type DrawStateName = keyof typeof DRAW_STATE;
const STATE_NAMES: DrawStateName[] = ['requested', 'funded', 'claimed', 'released'];

const enc = (s: string) => new TextEncoder().encode(s);

// ------------------------------------------------------------- keys

/**
 * A per-line backer key: ed25519 seed sha256("h081/backer/v1" ‖ be32(sk) ‖ le64(nonce)). `sk` is the backer's bank
 * spending key (a field element); the main wallet never appears on chain. Deterministic: the same (sk, nonce) gives the
 * same key on any device, so a line can be managed again after a reinstall.
 */
export function backerKeyFor(sk: bigint, nonce: bigint): Keypair {
  return Keypair.fromSeed(sha256(concatBytes(enc('h081/backer/v1'), be32(sk), u64le(nonce))));
}
/** A per-line borrower (draw) key: sha256("h081/draw/v1" ‖ be32(sk) ‖ le64(lineNonce)). */
export function drawKeyFor(sk: bigint, lineNonce: bigint): Keypair {
  return Keypair.fromSeed(sha256(concatBytes(enc('h081/draw/v1'), be32(sk), u64le(lineNonce))));
}

// ------------------------------------------------------------- PDAs

/** A line: ["backing", backer, nonce u64 LE]. */
export function backingPda(backer: PublicKey, nonce: bigint, programId = LOCALNET_LOAN_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc('backing'), backer.toBytes(), u64le(nonce)], programId)[0];
}
/** One draw of a line on a slot: ["draw", backing, loan_ref u64 LE]. */
export function drawPda(backing: PublicKey, loanRef: bigint, programId = LOCALNET_LOAN_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc('draw'), backing.toBytes(), u64le(loanRef)], programId)[0];
}
/** The line's stake: the Backing PDA's associated token account for the asset. */
export function backingVault(backing: PublicKey, mint: PublicKey, tokenProgram = SPL_TOKEN_PROGRAM_ID): PublicKey {
  return associatedTokenAddress(backing, mint, tokenProgram);
}

// ------------------------------------------------------------- math (mirrors backer.rs; same vectors in test/data/backer-vectors.json)

export interface BackedTerms {
  backerFee: bigint; lenderFee: bigint; principal: bigint; reserve: bigint;
  /** the platform's 0.25% origination fee, out of the advance */
  originationFee: bigint;
  /** what the borrower's payout account receives: advance - origination fee */
  toPayout: bigint;
  /** what the lender is due back: principal - backer fee = advance + lender fee */
  lenderDue: bigint;
  /** the part of the lender's due the stake does not cover */
  uncovered: bigint;
}
export function backedTerms(t: { advance: bigint; feeBps: number; lenderFeeBps: number; coverBps: number }): BackedTerms {
  const a = t.advance;
  const backerFee = (a * BigInt(t.feeBps)) / 10_000n;
  const lenderFee = (a * BigInt(t.lenderFeeBps)) / 10_000n;
  const principal = a + backerFee + lenderFee;
  const lenderDue = a + lenderFee;
  const reserve = (lenderDue * BigInt(t.coverBps) + 9_999n) / 10_000n;
  const fee = originationFee(a);
  return { backerFee, lenderFee, principal, reserve, originationFee: fee, toPayout: a - fee, lenderDue, uncovered: lenderDue > reserve ? lenderDue - reserve : 0n };
}

/** What back_claim pays: min(lender's unpaid due, reserve, vault). Pending receipts must be synced first. */
export function backedClaimAmount(principal: bigint, backerFee: bigint, repaid: bigint, subPaid: bigint, reserve: bigint, vault: bigint): bigint {
  const due = principal > backerFee ? principal - backerFee : 0n;
  const got = repaid > subPaid ? repaid - subPaid : 0n;
  const short = due > got ? due - got : 0n;
  return [short, reserve, vault].reduce((m, x) => (x < m ? x : m));
}

/** Why a funded draw's reserve may be freed: 1 repaid, 2 settled, 3 slot closed, 4 claim window over; 0 not yet. */
export function releaseReason(
  s: { slotClosed: boolean; repaid: bigint; principal: bigint; settled: boolean; expiry: bigint }, now: bigint, times = backerTimes(LOCALNET_LOAN_PROGRAM_ID),
): 0 | 1 | 2 | 3 | 4 {
  if (s.slotClosed) return 3;
  if (s.repaid >= s.principal) return 1;
  if (s.settled) return 2;
  if (now > 0n && now > s.expiry + times.grace + times.claimWindow) return 4;
  return 0;
}
export const routingDone = (slotClosed: boolean, repaid: bigint, principal: bigint, subPaid: bigint, subOwed: bigint) =>
  slotClosed || repaid >= principal || subPaid >= subOwed;

/** Free stake and how large an advance it can still back at the line's cover. */
export function lineCapacity(vault: bigint, reserved: bigint, coverBps: number): { free: bigint; capacity: bigint } {
  const free = vault > reserved ? vault - reserved : 0n;
  return { free, capacity: (free * 10_000n) / BigInt(coverBps) };
}

/**
 * Refuses terms the SDK should never send without an explicit override: cover below full (the lender is then lending
 * the uncovered part to an anonymous borrower), or combined fees above FEE_WARN_BPS. Returns warnings that are fine to
 * show but not to block on.
 */
export function checkLineTerms(
  t: { coverBps: number; feeBps: number; lenderFeeBps?: number; maxLenderFeeBps?: number }, opts: { allowPartialCover?: boolean; allowHighFees?: boolean } = {},
): string[] {
  const warn: string[] = [];
  if (!Number.isInteger(t.coverBps) || t.coverBps < LOCALNET_MIN_COVER_BPS || t.coverBps > FULL_COVER_BPS) throw new Error(`cover must be ${LOCALNET_MIN_COVER_BPS}..${FULL_COVER_BPS} bps`);
  if (t.coverBps < FULL_COVER_BPS) {
    if (!opts.allowPartialCover) throw new Error(`cover ${t.coverBps / 100}% is below 100%: the lender would lend ${(FULL_COVER_BPS - t.coverBps) / 100}% unsecured to a borrower it cannot see (pass allowPartialCover to do it anyway; mainnet refuses it)`);
    warn.push(`partial cover: ${(FULL_COVER_BPS - t.coverBps) / 100}% of the lender's due is unsecured`);
  }
  if (!Number.isInteger(t.feeBps) || t.feeBps < 0 || t.feeBps > MAX_BACKER_FEE_BPS) throw new Error(`backer fee must be 0..${MAX_BACKER_FEE_BPS} bps`);
  const lf = t.lenderFeeBps ?? 0;
  if (!Number.isInteger(lf) || lf < 0 || lf > MAX_LENDER_FEE_BPS) throw new Error(`lender fee must be 0..${MAX_LENDER_FEE_BPS} bps`);
  if (t.maxLenderFeeBps !== undefined) {
    const m = t.maxLenderFeeBps;
    if (!Number.isInteger(m) || m < 0 || m > MAX_LENDER_FEE_BPS) throw new Error(`the line's lender-fee cap must be 0..${MAX_LENDER_FEE_BPS} bps`);
    if (lf > m) throw new Error(`lender fee ${lf} bps is above this line's cap of ${m} bps`);
  }
  if (t.feeBps + lf > FEE_WARN_BPS) {
    if (!opts.allowHighFees) throw new Error(`fees of ${(t.feeBps + lf) / 100}% on the advance are above ${FEE_WARN_BPS / 100}% (pass allowHighFees to accept)`);
    warn.push(`high fees: ${(t.feeBps + lf) / 100}% of the advance`);
  }
  return warn;
}

// ------------------------------------------------------------- instructions

const disc = (name: string) => sha256(enc(`global:${name}`)).subarray(0, 8);
const ix = (programId: PublicKey, name: string, keys: AccountMeta[], ...args: Uint8Array[]) =>
  new TransactionInstruction({ programId, keys, data: Buffer.from(concatBytes(disc(name), ...args)) });
const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });
const i64le = (x: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, x, true); return b; };

export interface BackOpenArgs {
  nonce: bigint; coverBps: number; feeBps: number; expiry: bigint;
  /** the highest lender fee a request on this line may offer (default DEFAULT_MAX_LENDER_FEE_BPS) */
  maxLenderFeeBps?: number;
  drawKey: PublicKey; maxAdvance: bigint; maxTotal: bigint;
  /** pin the line to one lender (default: any) */
  lender?: PublicKey;
  /** require the backer's signature on every request */
  cosign?: boolean;
}
export function backOpenIx(
  backer: PublicKey, payer: PublicKey, mint: PublicKey, a: BackOpenArgs, tokenProgram = SPL_TOKEN_PROGRAM_ID, programId = LOCALNET_LOAN_PROGRAM_ID,
): TransactionInstruction {
  const backing = backingPda(backer, a.nonce, programId);
  return ix(programId, 'back_open', [
    w(backing), r(backer, true), w(payer, true), r(mint), w(backingVault(backing, mint, tokenProgram)), r(tokenProgram), r(ASSOCIATED_TOKEN_PROGRAM_ID),
    r(SystemProgram.programId),
  ], u64le(a.nonce), u16le(a.coverBps), u16le(a.feeBps), u16le(a.maxLenderFeeBps ?? DEFAULT_MAX_LENDER_FEE_BPS), u64le(a.expiry), (a.lender ?? PublicKey.default).toBytes(), a.drawKey.toBytes(),
  u64le(a.maxAdvance), u64le(a.maxTotal), new Uint8Array([a.cosign ? 1 : 0]));
}

export interface BackRequestArgs { loanRef: bigint; advance: bigint; lenderFeeBps: number; term: bigint; fundBy: bigint; payoutTo: PublicKey }
export function backRequestIx(
  line: { backing: PublicKey; backer: PublicKey; asset: PublicKey; tokenProgram: PublicKey }, drawKey: PublicKey, payer: PublicKey, a: BackRequestArgs,
  opts: { cosign?: boolean } = {}, programId = LOCALNET_LOAN_PROGRAM_ID,
): TransactionInstruction {
  return ix(programId, 'back_request', [
    w(line.backing), w(drawPda(line.backing, a.loanRef, programId)), r(slotPda(a.loanRef, programId)), r(drawKey, true), r(line.backer, !!opts.cosign),
    w(payer, true), r(a.payoutTo), r(backingVault(line.backing, line.asset, line.tokenProgram)), r(SystemProgram.programId), r(line.asset),
  ], u64le(a.loanRef), u64le(a.advance), u16le(a.lenderFeeBps), u64le(a.term), i64le(a.fundBy));
}

type LineRef = { asset: PublicKey; tokenProgram: PublicKey };

/**
 * back_settle: ends a draw. A request is cancelled; a funded draw's reserve is freed once allowed; a draw closes once
 * nothing more can reach the vault. `forgive` (the backer signs) gives up an unrecovered fee or payout.
 */
export function backSettleIx(
  loanRef: bigint, backing: PublicKey, line: LineRef, signer: PublicKey, drawPayer: PublicKey, forgive = false, programId = LOCALNET_LOAN_PROGRAM_ID,
): TransactionInstruction {
  return ix(programId, 'back_settle', [
    w(backing), w(drawPda(backing, loanRef, programId)), r(slotPda(loanRef, programId)), w(subrogationPda(loanRef, programId)),
    r(backingVault(backing, line.asset, line.tokenProgram)), r(signer, true), w(drawPayer),
  ], u64le(loanRef), new Uint8Array([forgive ? 1 : 0]));
}
/** Cancels an unfunded request (backer, draw key or the slot's lender; anyone once it expired or the slot was funded). */
export const backCancelIx = (loanRef: bigint, backing: PublicKey, line: LineRef, signer: PublicKey, drawPayer: PublicKey, programId = LOCALNET_LOAN_PROGRAM_ID) =>
  backSettleIx(loanRef, backing, line, signer, drawPayer, false, programId);
/** Permissionless release: frees a finished loan's reserve; closes the Draw once nothing more is owed to the vault. */
export const backReleaseIx = backCancelIx;
/** The backer gives up a claimed or released draw's unrecovered fee or payout. */
export const backForgiveIx = (loanRef: bigint, backing: PublicKey, line: LineRef, backer: PublicKey, drawPayer: PublicKey, programId = LOCALNET_LOAN_PROGRAM_ID) =>
  backSettleIx(loanRef, backing, line, backer, drawPayer, true, programId);

export interface FundBackedArgs {
  lender: PublicKey; loanRef: bigint; backing: PublicKey; mint: PublicKey; tokenProgram: PublicKey; lenderSource: PublicKey;
  /** what the lender read and accepts: every field must match the Draw */
  expect: { advance: bigint; principal: bigint; term: bigint; payoutTo: PublicKey; coverBps: number; minCoverBps: number };
  treasury?: PublicKey; poolProgram?: PublicKey;
}
export function fundBackedIx(a: FundBackedArgs, programId = LOCALNET_LOAN_PROGRAM_ID): TransactionInstruction {
  const tp = a.tokenProgram;
  const e = a.expect;
  return ix(programId, 'fund_backed', [
    w(slotPda(a.loanRef, programId)), w(a.lender, true), w(a.backing), w(drawPda(a.backing, a.loanRef, programId)), r(a.mint), w(a.lenderSource), w(e.payoutTo),
    w(slotInbox(a.loanRef, a.mint, tp, programId)), r(backingVault(a.backing, a.mint, tp)), r(tp), r(ASSOCIATED_TOKEN_PROGRAM_ID), r(SystemProgram.programId),
    w(ledgerPda(a.loanRef, a.mint, programId)), r(slotEscrow(a.loanRef, a.mint, a.poolProgram ?? LOCALNET_POOL_PROGRAM_ID, programId)),
    w(a.treasury ?? loanTreasuryAccount(a.mint, tp)), w(subrogationPda(a.loanRef, programId)),
  ], u64le(a.loanRef), u64le(e.advance), u64le(e.principal), u64le(e.term), e.payoutTo.toBytes(), u16le(e.coverBps), u16le(e.minCoverBps));
}

export function backClaimIx(
  loanRef: bigint, backing: PublicKey, slot: { lender: PublicKey; asset: PublicKey; tokenProgram: PublicKey }, programId = LOCALNET_LOAN_PROGRAM_ID,
  poolProgram = LOCALNET_POOL_PROGRAM_ID,
): TransactionInstruction {
  const tp = slot.tokenProgram;
  return ix(programId, 'back_claim', [
    r(slotPda(loanRef, programId)), w(backing), w(drawPda(backing, loanRef, programId)), w(subrogationPda(loanRef, programId)),
    w(ledgerPda(loanRef, slot.asset, programId)), w(backingVault(backing, slot.asset, tp)), r(slot.asset), w(slotInbox(loanRef, slot.asset, tp, programId)),
    r(slotEscrow(loanRef, slot.asset, poolProgram, programId)), w(associatedTokenAddress(slot.lender, slot.asset, tp)), r(tp),
  ], u64le(loanRef));
}

/** back_withdraw: free stake to `destination`; with `close`, everything in the vault and the line is closed (rents to `line.payer`). */
export function backWithdrawIx(
  backing: PublicKey, backer: PublicKey, line: LineRef & { payer: PublicKey }, destination: PublicKey, amount: bigint, close = false, programId = LOCALNET_LOAN_PROGRAM_ID,
): TransactionInstruction {
  return ix(programId, 'back_withdraw', [
    w(backing), r(backer, true), w(backingVault(backing, line.asset, line.tokenProgram)), w(line.asset), w(destination), r(line.tokenProgram), w(line.payer),
  ], u64le(amount), new Uint8Array([close ? 1 : 0]));
}
export const backCloseIx = (backing: PublicKey, backer: PublicKey, line: LineRef & { payer: PublicKey }, destination: PublicKey, programId = LOCALNET_LOAN_PROGRAM_ID) =>
  backWithdrawIx(backing, backer, line, destination, 0n, true, programId);

// ------------------------------------------------------------- accounts

class Reader {
  o = 8;
  constructor(readonly d: Uint8Array) {}
  private dv() { return new DataView(this.d.buffer, this.d.byteOffset, this.d.byteLength); }
  u8() { return this.d[this.o++]; }
  bool() { return this.u8() !== 0; }
  u16() { const v = this.dv().getUint16(this.o, true); this.o += 2; return v; }
  u32() { const v = this.dv().getUint32(this.o, true); this.o += 4; return v; }
  u64() { const v = this.dv().getBigUint64(this.o, true); this.o += 8; return v; }
  i64() { const v = this.dv().getBigInt64(this.o, true); this.o += 8; return v; }
  key() { const k = new PublicKey(this.d.subarray(this.o, this.o + 32)); this.o += 32; return k; }
}
const BACKING_DISC = sha256(enc('account:Backing')).subarray(0, 8);
const DRAW_DISC = sha256(enc('account:Draw')).subarray(0, 8);
const hasDisc = (data: Uint8Array, d: Uint8Array) => data.length >= 8 && d.every((b, i) => data[i] === b);
export const isBackingAccount = (data: Uint8Array) => hasDisc(data, BACKING_DISC) && data.length >= BACKING_ACCOUNT_SIZE;
export const isDrawAccount = (data: Uint8Array) => hasDisc(data, DRAW_DISC) && data.length >= DRAW_ACCOUNT_SIZE;

export interface BackingAccount {
  backer: PublicKey; drawKey: PublicKey; lender: PublicKey; asset: PublicKey; tokenProgram: PublicKey; payer: PublicKey; nonce: bigint; coverBps: number;
  feeBps: number; maxLenderFeeBps: number; expiry: bigint; maxAdvance: bigint; maxTotal: bigint; advancedTotal: bigint; reserved: bigint; openDraws: number; drawsTotal: number;
  coveredOut: bigint; cosign: boolean; createdAt: bigint; bump: number;
}
export function decodeBacking(data: Uint8Array): BackingAccount {
  if (!isBackingAccount(data)) throw new Error('not a Backing account');
  const x = new Reader(data);
  return {
    backer: x.key(), drawKey: x.key(), lender: x.key(), asset: x.key(), tokenProgram: x.key(), payer: x.key(), nonce: x.u64(), coverBps: x.u16(),
    feeBps: x.u16(), maxLenderFeeBps: x.u16(), expiry: x.u64(), maxAdvance: x.u64(), maxTotal: x.u64(), advancedTotal: x.u64(), reserved: x.u64(), openDraws: x.u16(),
    drawsTotal: x.u32(), coveredOut: x.u64(), cosign: x.bool(), createdAt: x.i64(), bump: x.u8(),
  };
}

export interface DrawAccount {
  loanRef: bigint; backing: PublicKey; payer: PublicKey; payoutTo: PublicKey; advance: bigint; backerFee: bigint; lenderFee: bigint; reserve: bigint;
  term: bigint; fundBy: bigint; requestedAt: bigint; claimed: bigint; state: DrawStateName; bump: number;
}
export function decodeDraw(data: Uint8Array): DrawAccount {
  if (!isDrawAccount(data)) throw new Error('not a Draw account');
  const x = new Reader(data);
  const d = {
    loanRef: x.u64(), backing: x.key(), payer: x.key(), payoutTo: x.key(), advance: x.u64(), backerFee: x.u64(), lenderFee: x.u64(), reserve: x.u64(),
    term: x.u64(), fundBy: x.i64(), requestedAt: x.i64(), claimed: x.u64(), state: x.u8(), bump: x.u8(),
  };
  return { ...d, state: STATE_NAMES[d.state] ?? 'requested' };
}

/** A slot funded by fund_backed: no pledge (stream slots always have pledge_bps > 0). Confirm with isBackedSubrogation. */
export const isBackedSlot = (s: Pick<SlotAccount, 'funded' | 'pledgeBps'>) => s.funded && s.pledgeBps === 0n;

/**
 * True when a loan's Subrogation belongs to a backed line, not to a safety-pool slash: its safety_config is a Backing
 * account of this stream_loan program (owner and discriminator checked). Every reader that labels a Subrogation
 * ("slashed", "recovered by the safety pool") must check this first and say "backer fee / recovery" instead.
 */
export async function isBackedSubrogation(connection: Pick<Connection, 'getAccountInfo'>, sub: SubrogationAccount, programId = LOCALNET_LOAN_PROGRAM_ID): Promise<boolean> {
  const info = await connection.getAccountInfo(sub.safetyConfig, 'confirmed');
  return !!info && info.owner.equals(programId) && isBackingAccount(info.data);
}

// ------------------------------------------------------------- readers: never label a backed Subrogation as a slash

/** What a reader calls a loan's Subrogation. `backer`: a backed line's fee and recovery; `slash`: a safety-pool slash. */
export type SubrogationKind = 'backer' | 'slash';
export const SUBROGATION_LABEL: Readonly<Record<SubrogationKind, string>> = { backer: 'backer fee / recovery', slash: 'safety-pool slash recovery' };

/**
 * The kind of a Subrogation from its `safety_config` account (as read) and, when known, its slot. Backed when the slot
 * is backed (funded with pledge_bps == 0: fund_backed is the only way to fund one) or when safety_config is a Backing
 * owned by this stream_loan program. Everything else is a safety-pool slash.
 */
export function subrogationKindOf(
  safetyConfig: { owner: PublicKey; data: Uint8Array } | null | undefined, programId = LOCALNET_LOAN_PROGRAM_ID, slot?: Pick<SlotAccount, 'funded' | 'pledgeBps'>,
): SubrogationKind {
  if (slot && isBackedSlot(slot)) return 'backer';
  return safetyConfig && safetyConfig.owner.equals(programId) && isBackingAccount(safetyConfig.data) ? 'backer' : 'slash';
}

/** subrogationKindOf for many Subrogations, reading their safety_config accounts in batches of 100 (one RPC call each). */
export async function subrogationKinds(
  connection: Pick<Connection, 'getMultipleAccountsInfo'>, subs: SubrogationAccount[], programId = LOCALNET_LOAN_PROGRAM_ID,
  slots?: Array<Pick<SlotAccount, 'funded' | 'pledgeBps'> | undefined>,
): Promise<SubrogationKind[]> {
  const infos: Array<{ owner: PublicKey; data: Uint8Array } | null> = [];
  for (let i = 0; i < subs.length; i += 100) {
    infos.push(...await connection.getMultipleAccountsInfo(subs.slice(i, i + 100).map((s) => s.safetyConfig), 'confirmed'));
  }
  return subs.map((_, i) => subrogationKindOf(infos[i], programId, slots?.[i]));
}

/** The lender's side of a backed loan: what it is due, what it got from repayments and from the cover, what is still short. */
export interface BackedLenderPosition {
  /** principal - backer fee (= advance + lender fee) */
  lenderDue: bigint;
  backerFee: bigint;
  /** receipts that went (or, unsynced, will go) to the backer's vault: fee first, then recovery of a cover payout */
  toBacker: bigint;
  /** receipts credited (or, unsynced, to be credited) to the lender: repaid - what went to the backer */
  toLender: bigint;
  /** what back_claim paid the lender from the stake */
  coverPaid: bigint;
  /**
   * Once expiry + grace has passed with the loan unpaid and unsettled: lenderDue - toLender - coverPaid; 0 otherwise.
   * stream_loan's own shortfall (principal - repaid) also counts the backer's fee and ignores the cover already paid.
   */
  lenderShortfall: bigint;
}
export function backedLenderPosition(
  slot: SlotAccount, sub: Pick<SubrogationAccount, 'owed' | 'paid'> | undefined, draw: Pick<DrawAccount, 'backerFee' | 'claimed'> | undefined, now: bigint,
  pending = 0n, grace = GRACE,
): BackedLenderPosition {
  // the Draw closes only once nothing more can reach the vault; without it, the Subrogation's owed is the fee (a claim raises it)
  const backerFee = draw?.backerFee ?? sub?.owed ?? 0n;
  const coverPaid = draw?.claimed ?? 0n;
  const lenderDue = slot.principal > backerFee ? slot.principal - backerFee : 0n;
  const subPaid = sub?.paid ?? 0n;
  const subLeft = sub && sub.owed > sub.paid ? sub.owed - sub.paid : 0n;
  const pendingToBacker = pending < subLeft ? pending : subLeft;
  const toBacker = subPaid + pendingToBacker;
  const toLender = (slot.repaid > subPaid ? slot.repaid - subPaid : 0n) + (pending - pendingToBacker);
  const late = slot.funded && !slot.settled && slot.expiry !== 0n && now > slot.expiry + grace && slot.repaid + pending < slot.principal;
  const got = toLender + coverPaid;
  return { lenderDue, backerFee, toBacker, toLender, coverPaid, lenderShortfall: late && lenderDue > got ? lenderDue - got : 0n };
}

/** The draws of a line, by one getProgramAccounts (discriminator + backing at offset 16). */
export async function drawsOf(connection: Pick<Connection, 'getProgramAccounts'>, backing: PublicKey, programId = LOCALNET_LOAN_PROGRAM_ID): Promise<Array<DrawAccount & { address: PublicKey }>> {
  const found = await connection.getProgramAccounts(programId, {
    commitment: 'confirmed',
    filters: [{ memcmp: { offset: 0, bytes: Buffer.from(DRAW_DISC).toString('base64'), encoding: 'base64' } }, { memcmp: { offset: 16, bytes: backing.toBase58() } }],
  });
  return found.map((f) => ({ ...decodeDraw(f.account.data), address: f.pubkey })).sort((a, b) => (a.loanRef < b.loanRef ? -1 : 1));
}

export interface BackingStatus {
  backing: PublicKey; line: BackingAccount; vault: PublicKey; staked: bigint; free: bigint; capacity: bigint;
  draws: Array<DrawAccount & { address: PublicKey }>;
}
export async function backingStatus(connection: Connection, backing: PublicKey, programId = LOCALNET_LOAN_PROGRAM_ID): Promise<BackingStatus | undefined> {
  const info = await connection.getAccountInfo(backing, 'confirmed');
  if (!info || !info.owner.equals(programId) || !isBackingAccount(info.data)) return undefined;
  const line = decodeBacking(info.data);
  const vault = backingVault(backing, line.asset, line.tokenProgram);
  const v = await connection.getAccountInfo(vault, 'confirmed');
  const staked = v && v.data.length >= 72 ? Buffer.from(v.data).readBigUInt64LE(64) : 0n;
  const { free, capacity } = lineCapacity(staked, line.reserved, line.coverBps);
  return { backing, line, vault, staked, free, capacity, draws: await drawsOf(connection, backing, programId) };
}

// ------------------------------------------------------------- events

function eventsNamed(logs: string[], name: string): Uint8Array[] {
  const d = sha256(enc(`event:${name}`)).subarray(0, 8);
  return logs.filter((l) => l.startsWith('Program data: ')).map((l) => new Uint8Array(Buffer.from(l.slice('Program data: '.length), 'base64'))).filter((x) => hasDisc(x, d));
}
export interface BackingClaimedEvent { backing: PublicKey; loanRef: bigint; lender: PublicKey; amount: bigint; held: boolean; feeForfeited: bigint }
export function backingClaimedEvents(logs: string[]): BackingClaimedEvent[] {
  return eventsNamed(logs, 'BackingClaimed').map((d) => { const x = new Reader(d); return { backing: x.key(), loanRef: x.u64(), lender: x.key(), amount: x.u64(), held: x.bool(), feeForfeited: x.u64() }; });
}
export interface BackedFundedEvent { backing: PublicKey; loanRef: bigint; lender: PublicKey; advance: bigint; backerFee: bigint; lenderFee: bigint; reserve: bigint; expiry: bigint }
export function backedFundedEvents(logs: string[]): BackedFundedEvent[] {
  return eventsNamed(logs, 'BackedFunded').map((d) => {
    const x = new Reader(d);
    return { backing: x.key(), loanRef: x.u64(), lender: x.key(), advance: x.u64(), backerFee: x.u64(), lenderFee: x.u64(), reserve: x.u64(), expiry: x.u64() };
  });
}
export interface DrawReleasedEvent { backing: PublicKey; loanRef: bigint; reason: number; forgone: bigint; closed: boolean }
export function drawReleasedEvents(logs: string[]): DrawReleasedEvent[] {
  return eventsNamed(logs, 'DrawReleased').map((d) => { const x = new Reader(d); return { backing: x.key(), loanRef: x.u64(), reason: x.u8(), forgone: x.u64(), closed: x.bool() }; });
}

// ------------------------------------------------------------- roles

async function tokenProgramOf(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint, 'confirmed');
  if (!info) throw new Error(`mint ${mint.toBase58()} not found`);
  return info.owner;
}
async function readAccount<T>(connection: Connection, key: PublicKey, decode: (d: Uint8Array) => T): Promise<T> {
  const info = await connection.getAccountInfo(key, 'confirmed');
  if (!info) throw new Error(`account ${key.toBase58()} not found`);
  return decode(info.data);
}
async function nowOf(connection: Connection): Promise<bigint> {
  const slot = await connection.getSlot('confirmed');
  const t = await connection.getBlockTime(slot);
  return BigInt(t ?? Math.floor(Date.now() / 1000));
}

/**
 * The backer of one line. `key` signs for the line (a fresh per-line key: backerKeyFor(sk, nonce)); `payer` pays fees
 * and rent and gets the rent back at close. Note on privacy: the key is fresh, but whoever funds `payer` with SOL is
 * visible on chain; without a sponsored fee payer the line is linkable to that funding wallet.
 */
export class SolanaBacker {
  constructor(
    readonly connection: Connection,
    readonly key: Keypair,
    readonly nonce: bigint,
    readonly payer: Keypair = key,
    readonly programId: PublicKey = LOCALNET_LOAN_PROGRAM_ID,
  ) {}

  get backing(): PublicKey { return backingPda(this.key.publicKey, this.nonce, this.programId); }

  async line(): Promise<BackingAccount> { return readAccount(this.connection, this.backing, decodeBacking); }

  /** Opens the line (Backing + vault). Refuses partial cover or high fees unless allowed explicitly. */
  async open(mint: PublicKey, a: Omit<BackOpenArgs, 'nonce'>, opts: { allowPartialCover?: boolean; allowHighFees?: boolean } = {}): Promise<SentTx & { backing: PublicKey; vault: PublicKey; warnings: string[] }> {
    const warnings = checkLineTerms(a, opts);
    if (a.coverBps < minCoverFor(this.programId)) throw new Error(`this stream_loan build accepts cover >= ${minCoverFor(this.programId)} bps`);
    const tp = await tokenProgramOf(this.connection, mint);
    const tx = await send(this.connection, this.payer, [backOpenIx(this.key.publicKey, this.payer.publicKey, mint, { ...a, nonce: this.nonce }, tp, this.programId)], {
      signers: this.payer === this.key ? [] : [this.key],
    });
    return { ...tx, backing: this.backing, vault: backingVault(this.backing, mint, tp), warnings };
  }

  /** Stakes `amount` from a public token account `owner` owns (a plain transfer into the vault; the payer pays the fee). */
  async stake(from: PublicKey, owner: Keypair, amount: bigint): Promise<SentTx> {
    const l = await this.line();
    const decimals = await this.decimals(l.asset);
    return send(this.connection, this.payer, [transferChecked(from, l.asset, backingVault(this.backing, l.asset, l.tokenProgram), owner.publicKey, amount, decimals, l.tokenProgram)], {
      signers: owner === this.payer ? [] : [owner],
    });
  }

  /**
   * Stakes from the shielded pool: a pool withdraw straight to the Backing PDA (its vault is that PDA's associated token
   * account). The withdraw amount and time are public, so they link to this vault; split or delay stakes for privacy.
   */
  async stakeFromShielded(wallet: { withdraw(mint: PublicKey, amount: bigint, recipient: PublicKey, relay?: object, opts?: { allowOffCurve?: boolean }): Promise<unknown> }, amount: bigint): Promise<unknown> {
    const l = await this.line();
    return wallet.withdraw(l.asset, amount, this.backing, {}, { allowOffCurve: true });
  }

  async status(): Promise<BackingStatus | undefined> { return backingStatus(this.connection, this.backing, this.programId); }

  /** Takes free stake to `destination` (default: the backer key's associated token account, created if missing). */
  async withdraw(amount: bigint, destination?: PublicKey): Promise<SentTx> {
    const l = await this.line();
    const dest = destination ?? associatedTokenAddress(this.key.publicKey, l.asset, l.tokenProgram);
    const pre = destination ? [] : [createAtaIdempotentIx(this.payer.publicKey, this.key.publicKey, l.asset, l.tokenProgram)];
    return send(this.connection, this.payer, [...pre, backWithdrawIx(this.backing, this.key.publicKey, l, dest, amount, false, this.programId)], { signers: this.signers() });
  }

  async cancel(loanRef: bigint): Promise<SentTx> {
    const d = await readAccount(this.connection, drawPda(this.backing, loanRef, this.programId), decodeDraw);
    return send(this.connection, this.payer, [backCancelIx(loanRef, this.backing, await this.line(), this.key.publicKey, d.payer, this.programId)], { signers: this.signers() });
  }

  async forgive(loanRef: bigint): Promise<SentTx> {
    const d = await readAccount(this.connection, drawPda(this.backing, loanRef, this.programId), decodeDraw);
    return send(this.connection, this.payer, [backForgiveIx(loanRef, this.backing, await this.line(), this.key.publicKey, d.payer, this.programId)], { signers: this.signers() });
  }

  /** Permissionless release of a draw (frees the reserve; closes the Draw once nothing more is owed to the vault). */
  async release(loanRef: bigint): Promise<SentTx> {
    return releaseBacked(this.connection, this.payer, this.backing, loanRef, this.programId);
  }

  /** Closes a line with no open draw: sweeps the vault to `destination` (default the backer key's ATA), rents to the payer. */
  async close(destination?: PublicKey): Promise<SentTx> {
    const l = await this.line();
    const dest = destination ?? associatedTokenAddress(this.key.publicKey, l.asset, l.tokenProgram);
    const pre = destination ? [] : [createAtaIdempotentIx(this.payer.publicKey, this.key.publicKey, l.asset, l.tokenProgram)];
    return send(this.connection, this.payer, [...pre, backCloseIx(this.backing, this.key.publicKey, l, dest, this.programId)], { signers: this.signers() });
  }

  private signers(): Keypair[] { return this.payer === this.key ? [] : [this.key]; }
  private async decimals(mint: PublicKey): Promise<number> {
    const info = await this.connection.getAccountInfo(mint, 'confirmed');
    if (!info) throw new Error('mint not found');
    return info.data[44];
  }
}

function transferChecked(from: PublicKey, mint: PublicKey, to: PublicKey, owner: PublicKey, amount: bigint, decimals: number, tp: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(10); data[0] = 12; data.writeBigUInt64LE(amount, 1); data[9] = decimals;
  return new TransactionInstruction({ programId: tp, keys: [w(from), r(mint), w(to), r(owner, true)], data });
}

/** Permissionless release (anyone may pay the fee; the Draw's rent goes to its payer). */
export async function releaseBacked(connection: Connection, payer: Keypair, backing: PublicKey, loanRef: bigint, programId = LOCALNET_LOAN_PROGRAM_ID): Promise<SentTx> {
  const line = await readAccount(connection, backing, decodeBacking);
  const d = await readAccount(connection, drawPda(backing, loanRef, programId), decodeDraw);
  return send(connection, payer, [backReleaseIx(loanRef, backing, line, payer.publicKey, d.payer, programId)]);
}

/**
 * The instructions of a permissionless default claim, in the one order that cannot be blocked: when the slot's pool
 * escrow holds anything (anyone can create it with a spend naming the slot and no lender account, and anyone can send
 * dust into it), (re)create the inbox and pull the escrow into it; then sync the inbox (a share synced after the
 * claim would be taken as recovery and short-change the lender); then back_claim. back_claim refuses while the escrow
 * or the inbox holds unsynced value, so the three must travel in one transaction.
 */
export async function claimBackedIxs(
  connection: Connection, payer: PublicKey, backing: PublicKey, loanRef: bigint, programId = LOCALNET_LOAN_PROGRAM_ID, poolProgram = LOCALNET_POOL_PROGRAM_ID,
): Promise<TransactionInstruction[]> {
  const slot = await readAccount(connection, slotPda(loanRef, programId), decodeSlot);
  const sub = await readAccount(connection, subrogationPda(loanRef, programId), decodeSubrogation);
  const tp = slot.tokenProgram;
  const slotKey = slotPda(loanRef, programId);
  const escrow = await connection.getAccountInfo(slotEscrow(loanRef, slot.asset, poolProgram, programId), 'confirmed');
  const escrowed = escrow && escrow.data.length >= 72 ? Buffer.from(escrow.data).readBigUInt64LE(64) : 0n;
  const pull = escrowed > 0n
    ? [createAtaIdempotentIx(payer, slotKey, slot.asset, tp), pullLenderShareIx(poolProgram, slot.asset, tp, fieldOf(slotKey), loanRef, slotInbox(loanRef, slot.asset, tp, programId))]
    : [];
  return [...pull, syncIx(payer, loanRef, slot.asset, slot.lender, tp, programId, sub.to), backClaimIx(loanRef, backing, slot, programId, poolProgram)];
}

/** Permissionless default claim: pull the slot's pool escrow (if any), sync, then back_claim, in one transaction. */
export async function claimBacked(connection: Connection, payer: Keypair, backing: PublicKey, loanRef: bigint, programId = LOCALNET_LOAN_PROGRAM_ID, poolProgram = LOCALNET_POOL_PROGRAM_ID): Promise<SentTx> {
  return send(connection, payer, await claimBackedIxs(connection, payer.publicKey, backing, loanRef, programId, poolProgram));
}

/**
 * The borrower of one line: `drawKey` (drawKeyFor(sk, lineNonce)) requests draws; the advance goes to `payoutTo`
 * (default: the draw key's associated token account). It hands the backer its draw-key code (kind 11) first.
 */
export class SolanaBackedBorrower {
  constructor(
    readonly connection: Connection,
    readonly drawKey: Keypair,
    readonly backing: PublicKey,
    readonly payer: Keypair = drawKey,
    readonly programId: PublicKey = LOCALNET_LOAN_PROGRAM_ID,
  ) {}

  async line(): Promise<BackingAccount> { return readAccount(this.connection, this.backing, decodeBacking); }

  payoutAccount(line: Pick<BackingAccount, 'asset' | 'tokenProgram'>): PublicKey {
    return associatedTokenAddress(this.drawKey.publicKey, line.asset, line.tokenProgram);
  }

  /** What the line will owe and pay for an advance at a lender fee. */
  async quote(advance: bigint, lenderFeeBps: number): Promise<BackedTerms & { warnings: string[] }> {
    const l = await this.line();
    const warnings = checkLineTerms({ coverBps: l.coverBps, feeBps: l.feeBps, lenderFeeBps }, { allowPartialCover: true, allowHighFees: true });
    return { ...backedTerms({ advance, feeBps: l.feeBps, lenderFeeBps, coverBps: l.coverBps }), warnings };
  }

  /**
   * Requests an advance from the lender of `loanRef`. `term` is the loan's length from funding; the request is void
   * after `ttl` seconds. Creates the payout account if missing. `backer` signs too when the line requires a co-sign.
   */
  async request(loanRef: bigint, advance: bigint, lenderFeeBps: number, term: bigint, opts: { ttl?: bigint; backer?: Keypair; payoutTo?: PublicKey; allowHighFees?: boolean } = {}): Promise<SentTx & { draw: PublicKey; terms: BackedTerms }> {
    const l = await this.line();
    if (lenderFeeBps > l.maxLenderFeeBps) throw new Error(`lender fee ${lenderFeeBps} bps is above this line's cap of ${l.maxLenderFeeBps} bps (the backer set it at open)`);
    if (l.feeBps + lenderFeeBps > FEE_WARN_BPS && !opts.allowHighFees) throw new Error(`fees of ${(l.feeBps + lenderFeeBps) / 100}% on the advance are above ${FEE_WARN_BPS / 100}% (pass allowHighFees to accept)`);
    const payoutTo = opts.payoutTo ?? this.payoutAccount(l);
    const pre = opts.payoutTo ? [] : [createAtaIdempotentIx(this.payer.publicKey, this.drawKey.publicKey, l.asset, l.tokenProgram)];
    const fundBy = (await nowOf(this.connection)) + (opts.ttl ?? 86_400n);
    const signers = [this.drawKey, ...(opts.backer ? [opts.backer] : [])].filter((k) => k !== this.payer);
    const tx = await send(this.connection, this.payer, [
      ...pre,
      backRequestIx({ backing: this.backing, backer: l.backer, asset: l.asset, tokenProgram: l.tokenProgram }, this.drawKey.publicKey, this.payer.publicKey,
        { loanRef, advance, lenderFeeBps, term, fundBy, payoutTo }, { cosign: !!opts.backer }, this.programId),
    ], { signers });
    return { ...tx, draw: drawPda(this.backing, loanRef, this.programId), terms: backedTerms({ advance, feeBps: l.feeBps, lenderFeeBps, coverBps: l.coverBps }) };
  }

  async cancel(loanRef: bigint): Promise<SentTx> {
    const d = await readAccount(this.connection, drawPda(this.backing, loanRef, this.programId), decodeDraw);
    return send(this.connection, this.payer, [backCancelIx(loanRef, this.backing, await this.line(), this.drawKey.publicKey, d.payer, this.programId)], {
      signers: this.payer === this.drawKey ? [] : [this.drawKey],
    });
  }

  /**
   * Repays from a public token account (any transfer into the slot's inbox counts), then syncs so the backer's fee and
   * the lender are paid at once. For a shielded repayment, withdraw from the pool to the slot PDA instead (the inbox is
   * its associated token account) and call `sync`.
   */
  async repay(loanRef: bigint, from: PublicKey, owner: Keypair, amount: bigint): Promise<SentTx> {
    const slot = await readAccount(this.connection, slotPda(loanRef, this.programId), decodeSlot);
    const sub = await readAccount(this.connection, subrogationPda(loanRef, this.programId), decodeSubrogation);
    const mintInfo = await this.connection.getAccountInfo(slot.asset, 'confirmed');
    const decimals = mintInfo!.data[44];
    return send(this.connection, this.payer, [
      transferChecked(from, slot.asset, slotInbox(loanRef, slot.asset, slot.tokenProgram, this.programId), owner.publicKey, amount, decimals, slot.tokenProgram),
      syncIx(this.payer.publicKey, loanRef, slot.asset, slot.lender, slot.tokenProgram, this.programId, sub.to),
    ], { signers: owner === this.payer ? [] : [owner] });
  }

  /** Repays from the shielded pool: a withdraw to the slot PDA (its inbox), then a sync. Amount and time are public. */
  async repayFromShielded(wallet: { withdraw(mint: PublicKey, amount: bigint, recipient: PublicKey, relay?: object, opts?: { allowOffCurve?: boolean }): Promise<unknown> }, loanRef: bigint, amount: bigint): Promise<SentTx> {
    const slot = await readAccount(this.connection, slotPda(loanRef, this.programId), decodeSlot);
    await wallet.withdraw(slot.asset, amount, slotPda(loanRef, this.programId), {}, { allowOffCurve: true });
    return this.sync(loanRef);
  }

  async sync(loanRef: bigint, payer: Keypair = this.payer): Promise<SentTx> {
    const slot = await readAccount(this.connection, slotPda(loanRef, this.programId), decodeSlot);
    const sub = await readAccount(this.connection, subrogationPda(loanRef, this.programId), decodeSubrogation);
    return send(this.connection, payer, [syncIx(payer.publicKey, loanRef, slot.asset, slot.lender, slot.tokenProgram, this.programId, sub.to)]);
  }
}

/** The terms a lender agrees to fund: what fund_backed's `expect` carries (with minCoverBps), and what a plan shows. */
export interface BackedFundTerms { advance: bigint; principal: bigint; term: bigint; payoutTo: PublicKey; coverBps: number }

/** The fund terms of a requested Draw on its line, as read from chain. */
export function backedFundTerms(draw: Pick<DrawAccount, 'advance' | 'backerFee' | 'lenderFee' | 'term' | 'payoutTo'>, line: Pick<BackingAccount, 'coverBps'>): BackedFundTerms {
  return { advance: draw.advance, principal: draw.advance + draw.backerFee + draw.lenderFee, term: draw.term, payoutTo: draw.payoutTo, coverBps: line.coverBps };
}

/**
 * A short digest (16 hex) of the exact terms a lender is shown for one draw: backing, loan ref, advance, principal,
 * term, payout account and cover. A plan returns it; the confirm call passes it back, and the draw is funded only if
 * its terms on chain still give that digest. So a borrower that cancels and re-requests between the plan and the
 * confirm (another term or lender fee at the same advance) cannot make the lender fund terms it never saw.
 */
export function backedTermsDigest(backing: PublicKey, loanRef: bigint, t: BackedFundTerms): string {
  const body = concatBytes(enc('h081/backed-fund/v1'), backing.toBytes(), u64le(loanRef), u64le(t.advance), u64le(t.principal), u64le(t.term), t.payoutTo.toBytes(), u16le(t.coverBps));
  return Buffer.from(sha256(body)).subarray(0, 8).toString('hex');
}

/**
 * The lender's side: reads the Draw and the line, checks them against what the lender accepts, and funds at exactly
 * those terms (the program refuses any change in between). `minCoverBps` defaults to full cover. With `expect` (the
 * terms the lender was shown), the transaction carries those terms unchanged, not the ones read now: the SDK refuses
 * when the Draw differs in any of them, and the program refuses a change made after this read (TermsMismatch).
 */
export async function fundBacked(
  connection: Connection, lender: Keypair, backing: PublicKey, loanRef: bigint,
  opts: { minCoverBps?: number; maxAdvance?: bigint; programId?: PublicKey; treasuryOwner?: PublicKey; poolProgram?: PublicKey; expect?: Omit<BackedFundTerms, 'coverBps'> & { coverBps?: number } } = {},
): Promise<SentTx & { terms: BackedTerms; draw: DrawAccount; line: BackingAccount }> {
  const programId = opts.programId ?? LOCALNET_LOAN_PROGRAM_ID;
  const line = await readAccount(connection, backing, decodeBacking);
  const draw = await readAccount(connection, drawPda(backing, loanRef, programId), decodeDraw);
  if (draw.state !== 'requested') throw new Error(`draw is ${draw.state}, not requested`);
  const minCoverBps = opts.minCoverBps ?? FULL_COVER_BPS;
  if (line.coverBps < minCoverBps) throw new Error(`line cover ${line.coverBps / 100}% is below your minimum ${minCoverBps / 100}%`);
  if (opts.maxAdvance !== undefined && draw.advance > opts.maxAdvance) throw new Error(`advance ${draw.advance} is above your limit ${opts.maxAdvance}`);
  const onChain = backedFundTerms(draw, line);
  const e = opts.expect;
  if (e && (e.advance !== onChain.advance || e.principal !== onChain.principal || e.term !== onChain.term || !e.payoutTo.equals(onChain.payoutTo)
    || (e.coverBps !== undefined && e.coverBps !== onChain.coverBps))) {
    throw new Error('the draw changed since you read it (advance, principal, term, payout account or cover); nothing was sent');
  }
  const funded: BackedFundTerms = e ? { advance: e.advance, principal: e.principal, term: e.term, payoutTo: e.payoutTo, coverBps: e.coverBps ?? onChain.coverBps } : onChain;
  const terms = backedTerms({ advance: draw.advance, feeBps: line.feeBps, lenderFeeBps: 0, coverBps: line.coverBps });
  const principal = funded.principal;
  const tp = line.tokenProgram;
  const treasuryOwner = opts.treasuryOwner ?? LOAN_TREASURY;
  const pre = originationFee(draw.advance) > 0n ? [createAtaIdempotentIx(lender.publicKey, treasuryOwner, line.asset, tp)] : [];
  const tx = await send(connection, lender, [
    ...pre,
    fundBackedIx({
      lender: lender.publicKey, loanRef, backing, mint: line.asset, tokenProgram: tp, lenderSource: associatedTokenAddress(lender.publicKey, line.asset, tp),
      expect: { ...funded, minCoverBps },
      treasury: loanTreasuryAccount(line.asset, tp, treasuryOwner), poolProgram: opts.poolProgram,
    }, programId),
  ]);
  return { ...tx, terms: { ...terms, backerFee: draw.backerFee, lenderFee: draw.lenderFee, principal, reserve: draw.reserve }, draw, line };
}

/** A backed loan as a lender or borrower sees it: the slot, its line, its draw and where the money went. */
export interface BackedLoanView {
  loanRef: bigint; backing: PublicKey; draw?: DrawAccount; slot?: SlotAccount; sub?: SubrogationAccount;
  /** what the backer has received through the loan so far (fee first, then any recovery) */
  toBacker: bigint;
  /** what the lender has been credited from repayments (repaid - toBacker) */
  toLender: bigint;
  pendingInbox: bigint;
}
export async function backedLoanView(connection: Connection, backing: PublicKey, loanRef: bigint, programId = LOCALNET_LOAN_PROGRAM_ID): Promise<BackedLoanView> {
  const [d, s, sb] = await connection.getMultipleAccountsInfo([drawPda(backing, loanRef, programId), slotPda(loanRef, programId), subrogationPda(loanRef, programId)], 'confirmed');
  const draw = d && isDrawAccount(d.data) ? decodeDraw(d.data) : undefined;
  const slot = s && isSlotAccount(s.data) ? decodeSlot(s.data) : undefined;
  const sub = sb && sb.owner.equals(programId) ? decodeSubrogation(sb.data) : undefined;
  let pendingInbox = 0n;
  if (slot?.funded) {
    const [inbox, ledger] = await connection.getMultipleAccountsInfo([slotInbox(loanRef, slot.asset, slot.tokenProgram, programId), ledgerPda(loanRef, slot.asset, programId)], 'confirmed');
    const held = ledger ? decodeLedger(ledger.data).held : 0n;
    const amt = inbox && inbox.data.length >= 72 ? Buffer.from(inbox.data).readBigUInt64LE(64) : 0n;
    pendingInbox = amt > held ? amt - held : 0n;
  }
  const toBacker = sub?.paid ?? 0n;
  const repaid = slot?.repaid ?? 0n;
  return { loanRef, backing, draw, slot, sub, toBacker, toLender: repaid > toBacker ? repaid - toBacker : 0n, pendingInbox };
}
