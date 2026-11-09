// The lender's side of a stream-backed loan on Solana (stream_loan program, docs/SOLANA-PORT.md 3.2).
// Program layer: PDAs, instruction builders and account decoders. The wallet (SolanaLoanLenderWallet) is below.
import { sha256 } from '@noble/hashes/sha2';
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import { type Allowance, allowanceCommitment, allowanceNullifier, lenderClaimable, nextRho } from '../crypto.js';
import { type AllowanceRecord, type LenderInfo, type LenderPayload, type MemoViews, type ViewingKey, unpackMemos } from '../encryption.js';
import { LEVELS, minRemainingFor, spendInput } from '../inputs.js';
import { MerkleTree } from '../merkle.js';
import type { ProofResult } from '../prover.js';
import { type SentTx, closeBuffer, send, simulate, uploadBuffer } from './buffer.js';
import { concatBytes, encodeProof, fieldOf, fromBe, u32le, u64le } from './field.js';
import { DEFAULT_PUBKEY, type SpendAccounts, type SpendArgs, encodeSpendArgs, encodeSpendExt, extDataHash, pullLenderShareIx, spendIx } from './ops.js';
import { escrowPda, poolPda } from './pda.js';
import { LOCALNET_POOL_PROGRAM_ID, type StreamArgs, bufferCloseIx, encodeStreamArgs, programDataAddress } from './program.js';
import { LOCALNET_SAFETY_POOL_PROGRAM_ID, coverPda, createAtaIdempotentIx, decodeCover, loanAccounts, releaseCoverIx } from './token.js';
import { OP_CU_LIMIT, type SolPledgeTerms, type SolanaPool, openSolLenderMemo, solAllowanceMemo, solSealForLender } from './wallet.js';

/** Localnet stream_loan program id (solana/keys/stream_loan-keypair.json, declared in programs/stream_loan). */
export const LOCALNET_LOAN_PROGRAM_ID = new PublicKey('FvM9Xczax1TCU15imjdNAMg8JXP4apSs2pn9LWCdjyPc');
/** stream_loan and safety_pool on mainnet-beta (docs/MAINNET-RUNBOOK.md, Phase 2). */
export const MAINNET_LOAN_PROGRAM_ID = new PublicKey('8JBd7epQXxdcKRMaWM1S5PC7nsQKoZq3uCetpiJ684g4');
export const MAINNET_SAFETY_POOL_PROGRAM_ID = new PublicKey('HmzKNPn8LaRyjmggt2uT95B7KvphtoVXQkeVc2HHARTt');

/**
 * The safety_pool whose Cover PDA a stream_loan build checks in close_slot (stream_loan safety::SAFETY_POOL_ID):
 * the localnet pair or the mainnet pair; undefined for any other stream_loan (pass it explicitly).
 */
export function safetyPoolFor(loanProgram: PublicKey): PublicKey | undefined {
  if (loanProgram.equals(LOCALNET_LOAN_PROGRAM_ID)) return LOCALNET_SAFETY_POOL_PROGRAM_ID;
  if (loanProgram.equals(MAINNET_LOAN_PROGRAM_ID)) return MAINNET_SAFETY_POOL_PROGRAM_ID;
  return undefined;
}

export const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/** Seconds after the allowance's expiry before an unpaid loan counts as a shortfall. */
export const GRACE = 7n * 86400n;

/** Anchor custom error codes of stream_loan (6000 + variant index). */
export const LOAN_ERROR = {
  NotTheLender: 6000, AlreadyFunded: 6001, WrongSlot: 6002, WrongAsset: 6003, StreamNotStarted: 6004, BadPayout: 6005, NoLoan: 6006,
  NothingOwed: 6007, NotAClaim: 6008, WrongPoolProgram: 6009, BadBuffer: 6010, BadPayload: 6011, BadTokenProgram: 6012, BadMint: 6013,
  BadInbox: 6014, BadLenderAccount: 6015, Overflow: 6016, BadEscrow: 6017, EscrowNotEmpty: 6018, BadTreasury: 6019,
  UpgradeAuthority: 6020, PayoutNotProven: 6021, PrincipalTooLarge: 6022, PrincipalMismatch: 6023, NotSafetyPool: 6024,
  BadSubrogation: 6025, BadRecovery: 6026, BadSlashAmount: 6027, NotSettled: 6028, InboxNotEmpty: 6029, CoverOpen: 6030,
  BadCover: 6031, BadReceipt: 6032, SubrogationOpen: 6033,
  // overpay cap (docs/LOAN-OVERPAY-CAP.md)
  LoanRepaid: 6034, ClaimTooLarge: 6035, NoExcess: 6036, PayoutCannotReceive: 6037, LegacyReceiptNoPayout: 6038, ReceiptNotWritable: 6039,
} as const;

/**
 * Account sizes (Anchor discriminator included): Slot 8 + 245, ClosedSlot receipt 8 + 90. A receipt made after the
 * overpay cap (v2) is CLOSED_SLOT_V2_SIZE: the same struct, then the borrower's payout account in 32 trailing bytes.
 * CLOSED_SLOT_ACCOUNT_SIZE is the minimum size of a receipt.
 */
export const SLOT_ACCOUNT_SIZE = 253;
export const CLOSED_SLOT_ACCOUNT_SIZE = 98;
export const CLOSED_SLOT_V2_SIZE = CLOSED_SLOT_ACCOUNT_SIZE + 32;

/**
 * The stream proof audience `fund` requires: fieldOf(payoutTo). The borrower proves for the token account the
 * principal must go to, so a lender cannot pay it anywhere else.
 */
export const payoutAudience = (payoutTo: PublicKey): bigint => fieldOf(payoutTo);

/**
 * The principal a stream proof backs (stream_loan::max_principal): minRemaining * pledgeBps / 10,000. `fund`
 * requires the principal to be exactly this, so the borrower fixes the amount by proving
 * minRemaining = minRemainingFor(amount, pledgeBps) (src/inputs.ts).
 */
export const maxPrincipal = (minRemaining: bigint, pledgeBps: number | bigint): bigint => (minRemaining * BigInt(pledgeBps)) / 10_000n;
export { minRemainingFor };

/**
 * Owner of the treasury token accounts that receive the loan origination fee (stream_loan fee::TREASURY).
 * PLACEHOLDER until the treasury multisig exists; keep it equal to the program constant.
 */
export const LOAN_TREASURY = new PublicKey('TreasuryP1aceho1derSetMeBeforeMainnet111111');
/** Origination fee in basis points of the principal (stream_loan fee::ORIGINATION_FEE_BPS). A platform fee only. */
export const ORIGINATION_FEE_BPS = 25n;

/** The origination fee `fund` takes out of the payout: principal * 25 / 10_000, rounded down. The loan owes the full principal. */
export function originationFee(principal: bigint): bigint {
  return (principal * ORIGINATION_FEE_BPS) / 10_000n;
}

/** The treasury's associated token account for `mint`: where `fund` sends the origination fee. */
export function loanTreasuryAccount(mint: PublicKey, tokenProgram = SPL_TOKEN_PROGRAM_ID, treasuryOwner = LOAN_TREASURY): PublicKey {
  return associatedTokenAddress(treasuryOwner, mint, tokenProgram);
}
/** Anchor's own error for a `has_one` / seeds mismatch etc. are 2000-range; `has_one = lender` maps to NotTheLender. */

const enc = (s: string) => new TextEncoder().encode(s);

// ------------------------------------------------------------- PDAs

/** Loan-ref counter: ["registry"]. */
export function registryPda(programId = LOCALNET_LOAN_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc('registry')], programId)[0];
}

/** One slot (= one loan): ["slot", loan_ref u64 LE]. Borrowers pledge to lenderAddr = fieldOf(this PDA). */
export function slotPda(loanRef: bigint, programId = LOCALNET_LOAN_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc('slot'), u64le(loanRef)], programId)[0];
}

/** Per (slot, mint) inbox accounting: ["ledger", loan_ref u64 LE, mint]. */
export function ledgerPda(loanRef: bigint, mint: PublicKey, programId = LOCALNET_LOAN_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc('ledger'), u64le(loanRef), mint.toBytes()], programId)[0];
}

/**
 * A safety-pool slash recorded for the loan: ["subrogation", loan_ref u64 LE]. Exists only after a slash; while
 * it does and `paid < owed`, sync/claim forward the loan's receipts to its `to` account before the lender.
 */
export function subrogationPda(loanRef: bigint, programId = LOCALNET_LOAN_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc('subrogation'), u64le(loanRef)], programId)[0];
}

/** Associated token account of `owner` (on or off curve) for `mint`. */
export function associatedTokenAddress(owner: PublicKey, mint: PublicKey, tokenProgram = SPL_TOKEN_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}

/** The slot's inbox: where the pool delivers every share routed to (fieldOf(slot PDA), loanRef). */
export function slotInbox(loanRef: bigint, mint: PublicKey, tokenProgram = SPL_TOKEN_PROGRAM_ID, programId = LOCALNET_LOAN_PROGRAM_ID): PublicKey {
  return associatedTokenAddress(slotPda(loanRef, programId), mint, tokenProgram);
}

/**
 * stipend_pool's escrow for shares routed to the slot that the pool could not deliver to the inbox:
 * ["owed", mint, fieldOf(slot PDA), loan_ref] under the pool program. stream_loan counts its balance as paid.
 */
export function slotEscrow(loanRef: bigint, mint: PublicKey, poolProgram = LOCALNET_POOL_PROGRAM_ID, programId = LOCALNET_LOAN_PROGRAM_ID): PublicKey {
  return escrowPda(poolProgram, mint, fieldOf(slotPda(loanRef, programId)), loanRef);
}

/** Receipt of a closed funded slot: ["closed", loan_ref u64 LE] (close_slot creates it; never closed). */
export function closedSlotPda(loanRef: bigint, programId = LOCALNET_LOAN_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc('closed'), u64le(loanRef)], programId)[0];
}

/** What a borrower pledges to for `loanRef`: the slot PDA as the lender account, and its field value. */
export function slotLenderAddr(loanRef: bigint, programId = LOCALNET_LOAN_PROGRAM_ID): { lender: PublicKey; lenderAddr: bigint } {
  const lender = slotPda(loanRef, programId);
  return { lender, lenderAddr: fieldOf(lender) };
}

// ------------------------------------------------------------- instructions

const disc = (name: string) => sha256(enc(`global:${name}`)).subarray(0, 8);
const ix = (programId: PublicKey, name: string, keys: AccountMeta[], ...args: Uint8Array[]) =>
  new TransactionInstruction({ programId, keys, data: Buffer.from(concatBytes(disc(name), ...args)) });
const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });

/** Only the stream_loan program's upgrade authority may sign as `payer` (checked against its ProgramData account). */
export function loanInitializeIx(payer: PublicKey, programId = LOCALNET_LOAN_PROGRAM_ID): TransactionInstruction {
  return ix(programId, 'initialize', [w(registryPda(programId)), w(payer, true), r(SystemProgram.programId), r(programDataAddress(programId))]);
}

/** Opens slot `nextLoanRef` (read it from the registry first; the PDA is derived from it). */
export function openSlotIx(lender: PublicKey, nextLoanRef: bigint, programId = LOCALNET_LOAN_PROGRAM_ID): TransactionInstruction {
  return ix(programId, 'open_slot', [w(registryPda(programId)), w(slotPda(nextLoanRef, programId)), w(lender, true), r(SystemProgram.programId)]);
}

export interface FundAccounts {
  lender: PublicKey; loanRef: bigint; principal: bigint; poolProgram: PublicKey; poolState: PublicKey; buffer: PublicKey; mint: PublicKey;
  lenderSource: PublicKey; payoutTo: PublicKey; tokenProgram?: PublicKey;
  /** defaults to loanTreasuryAccount(mint); the program refuses any other account */
  treasury?: PublicKey;
}

/**
 * Fund against the stream proof staged in `buffer` (a stipend_pool Buffer holding borsh (Proof, StreamArgs)).
 * `payoutTo` receives principal - originationFee(principal), the treasury account the fee (it must exist when
 * the fee is above 0); the loan owes the full principal.
 * The proof's audience must be fieldOf(payoutTo) and the principal exactly maxPrincipal(minRemaining, pledgeBps):
 * the borrower's proof fixes the amount. Whatever already sits in the inbox (shares routed to the unfunded slot,
 * never forwarded) is returned to `payoutTo` and does not count as repayment; the pool escrow of the slot must be
 * empty (pull it into the inbox first, see SolanaLoanLenderWallet.fundUnchecked).
 */
export function fundIx(a: FundAccounts, programId = LOCALNET_LOAN_PROGRAM_ID): TransactionInstruction {
  const tp = a.tokenProgram ?? SPL_TOKEN_PROGRAM_ID;
  return ix(programId, 'fund', [
    w(slotPda(a.loanRef, programId)), w(a.lender, true), r(a.poolProgram), r(a.poolState), r(a.buffer), r(a.mint), w(a.lenderSource), w(a.payoutTo),
    w(slotInbox(a.loanRef, a.mint, tp, programId)), r(tp), r(ASSOCIATED_TOKEN_PROGRAM_ID), r(SystemProgram.programId),
    w(ledgerPda(a.loanRef, a.mint, programId)), r(escrowPda(a.poolProgram, a.mint, fieldOf(slotPda(a.loanRef, programId)), a.loanRef)),
    w(a.treasury ?? loanTreasuryAccount(a.mint, tp)),
  ], u64le(a.loanRef), u64le(a.principal));
}

/**
 * Permissionless: credit and forward what arrived in the slot's inbox. `lender` is the slot's lender (for its ATA).
 * `subrogationTo`: the `to` of the loan's Subrogation account when one exists with `paid < owed` (readSubrogation);
 * any account otherwise (defaults to the Subrogation PDA itself).
 */
export function syncIx(
  payer: PublicKey, loanRef: bigint, mint: PublicKey, lender: PublicKey, tokenProgram = SPL_TOKEN_PROGRAM_ID, programId = LOCALNET_LOAN_PROGRAM_ID,
  subrogationTo?: PublicKey,
): TransactionInstruction {
  const sub = subrogationPda(loanRef, programId);
  return ix(programId, 'sync', [
    w(slotPda(loanRef, programId)), w(ledgerPda(loanRef, mint, programId)), w(payer, true), r(mint), w(slotInbox(loanRef, mint, tokenProgram, programId)),
    w(associatedTokenAddress(lender, mint, tokenProgram)), r(tokenProgram), r(SystemProgram.programId), w(sub), w(subrogationTo ?? sub),
  ], u64le(loanRef));
}

/**
 * stream_loan `record_slash`: only a safety_pool SafetyConfig PDA may sign as `safetyConfig` (by CPI from
 * safety_pool `slash`, which builds this itself); exposed so tests can show every other signer is refused.
 */
export function recordSlashIx(payer: PublicKey, loanRef: bigint, amount: bigint, safetyConfig: PublicKey, to: PublicKey, programId = LOCALNET_LOAN_PROGRAM_ID): TransactionInstruction {
  return ix(programId, 'record_slash', [
    r(slotPda(loanRef, programId)), w(subrogationPda(loanRef, programId)), w(payer, true), r(safetyConfig, true), r(to), r(SystemProgram.programId),
  ], u64le(loanRef), u64le(amount));
}

export function collectIx(lender: PublicKey, loanRef: bigint, mint: PublicKey, destination: PublicKey, tokenProgram = SPL_TOKEN_PROGRAM_ID, programId = LOCALNET_LOAN_PROGRAM_ID): TransactionInstruction {
  return ix(programId, 'collect', [
    r(slotPda(loanRef, programId)), w(ledgerPda(loanRef, mint, programId)), r(lender, true), r(mint), w(slotInbox(loanRef, mint, tokenProgram, programId)), w(destination), r(tokenProgram),
  ], u64le(loanRef));
}

/**
 * Lender claim through the registry: `spend` is the stipend_pool `spend` instruction (data + accounts) built
 * for the claim; its accounts are passed through and the slot PDA signs for the pool by CPI.
 */
export function claimIx(
  lender: PublicKey, loanRef: bigint, mint: PublicKey, spend: TransactionInstruction, tokenProgram = SPL_TOKEN_PROGRAM_ID, programId = LOCALNET_LOAN_PROGRAM_ID,
  subrogationTo?: PublicKey,
): TransactionInstruction {
  const slot = slotPda(loanRef, programId);
  const sub = subrogationPda(loanRef, programId);
  // only the lender signs the outer transaction; the slot PDA (the pool's lender signer) is signed by CPI
  const passthrough = spend.keys.map((k) => ({ ...k, isSigner: k.isSigner && k.pubkey.equals(lender) }));
  return ix(programId, 'claim', [
    w(slot), w(ledgerPda(loanRef, mint, programId)), w(lender, true), r(spend.programId), r(mint), w(slotInbox(loanRef, mint, tokenProgram, programId)),
    w(associatedTokenAddress(lender, mint, tokenProgram)), r(tokenProgram), r(SystemProgram.programId), w(sub), w(subrogationTo ?? sub), ...passthrough,
  ], u64le(loanRef), u32le(spend.data.length), Uint8Array.from(spend.data));
}

export function settleIx(lender: PublicKey, loanRef: bigint, programId = LOCALNET_LOAN_PROGRAM_ID): TransactionInstruction {
  return ix(programId, 'settle', [w(slotPda(loanRef, programId)), r(lender, true)], u64le(loanRef));
}

/**
 * The lender closes a finished slot and takes its rent back (stream_loan close_slot). `loan` is the funded loan's
 * asset and token program (omit for a slot that was never funded: those accounts are not read). A funded loan
 * must be settled, its inbox empty (sync/collect first), its safety_pool cover, if any, released, and a recorded
 * slash, if any, fully recovered by the safety pool (Subrogation paid >= owed, else SubrogationOpen); the inbox,
 * the asset's Ledger and the Slot are closed to the lender and a ClosedSlot receipt is left.
 * `safetyProgram` must be the safety_pool the stream_loan build checks (safetyPoolFor(programId)).
 */
export function closeSlotIx(
  lender: PublicKey, loanRef: bigint, loan?: { asset: PublicKey; tokenProgram: PublicKey }, programId = LOCALNET_LOAN_PROGRAM_ID,
  safetyProgram = safetyPoolFor(programId),
): TransactionInstruction {
  if (!safetyProgram) throw new Error('closeSlotIx: pass the safety_pool program id this stream_loan checks');
  const closed = closedSlotPda(loanRef, programId);
  // an unfunded slot reads none of the loan accounts: the receipt address stands in for them
  const ledger = loan ? ledgerPda(loanRef, loan.asset, programId) : closed;
  const mint = loan?.asset ?? closed;
  const inbox = loan ? slotInbox(loanRef, loan.asset, loan.tokenProgram, programId) : closed;
  return ix(programId, 'close_slot', [
    w(slotPda(loanRef, programId)), w(lender, true), w(ledger), w(mint), w(inbox), r(loan?.tokenProgram ?? SPL_TOKEN_PROGRAM_ID),
    r(coverPda(safetyProgram, loanRef)), w(closed), r(SystemProgram.programId), r(subrogationPda(loanRef, programId)),
  ], u64le(loanRef));
}

/**
 * The lender of a closed slot takes what reached the slot's inbox in `mint` after the close (stream_loan
 * sweep_closed) to `destination`, up to what the loan still owes (principal - receipt.repaid, loan asset only; the
 * receipt records it, so it is passed writable); an emptied inbox is closed to the lender. The rest is the
 * borrower's (returnExcessIx). Pull the pool escrow of the slot into the inbox first (pullLenderShareIx is
 * permissionless) when shares were escrowed. The mint's Ledger PDA follows (writable): what it still holds for the
 * lender (another mint's shares held before the overpay cap) is paid first and the Ledger is closed to the lender;
 * a missing Ledger is ignored.
 */
export function sweepClosedIx(
  lender: PublicKey, loanRef: bigint, mint: PublicKey, destination: PublicKey, tokenProgram = SPL_TOKEN_PROGRAM_ID, programId = LOCALNET_LOAN_PROGRAM_ID,
): TransactionInstruction {
  return ix(programId, 'sweep_closed', [
    w(closedSlotPda(loanRef, programId)), w(lender, true), r(slotPda(loanRef, programId)), w(mint), w(slotInbox(loanRef, mint, tokenProgram, programId)),
    w(destination), r(tokenProgram), w(ledgerPda(loanRef, mint, programId)),
  ], u64le(loanRef));
}

/**
 * Permissionless (stream_loan return_excess): sends the borrower's excess in the slot's inbox for `mint` (what is
 * above `held` and above what the loan may still credit) to the borrower, for an open funded slot or a closed one
 * with a v2 receipt. `payoutTo` is the loan's recorded payout account; `destination` is payoutTo itself for the loan
 * asset, the associated token account of payoutTo's owner for another mint, or, when `ownerSigner` (payoutTo's
 * owner) signs, any token account of `mint`.
 */
export function returnExcessIx(
  loanRef: bigint, mint: PublicKey, payoutTo: PublicKey, destination: PublicKey, tokenProgram = SPL_TOKEN_PROGRAM_ID, programId = LOCALNET_LOAN_PROGRAM_ID,
  ownerSigner?: PublicKey,
): TransactionInstruction {
  return ix(programId, 'return_excess', [
    r(slotPda(loanRef, programId)), r(closedSlotPda(loanRef, programId)), r(ledgerPda(loanRef, mint, programId)), r(mint),
    w(slotInbox(loanRef, mint, tokenProgram, programId)), r(payoutTo), w(destination), r(tokenProgram), ...(ownerSigner ? [r(ownerSigner, true)] : []),
  ], u64le(loanRef));
}

/**
 * View (simulate it): return data is the shortfall as u64 LE. `asset`/`tokenProgram` are the loan's. The
 * unsynced inbox balance and the pool escrow of the slot count as paid.
 */
export function shortfallIx(
  loanRef: bigint, asset: PublicKey, tokenProgram = SPL_TOKEN_PROGRAM_ID, programId = LOCALNET_LOAN_PROGRAM_ID, poolProgram = LOCALNET_POOL_PROGRAM_ID,
): TransactionInstruction {
  return ix(programId, 'shortfall', [
    r(slotPda(loanRef, programId)), r(slotInbox(loanRef, asset, tokenProgram, programId)), r(ledgerPda(loanRef, asset, programId)),
    r(slotEscrow(loanRef, asset, poolProgram, programId)),
  ], u64le(loanRef));
}

// ------------------------------------------------------------- accounts

class Reader {
  o = 8; // skip the Anchor discriminator
  constructor(readonly d: Uint8Array) {}
  private dv() { return new DataView(this.d.buffer, this.d.byteOffset, this.d.byteLength); }
  u8() { return this.d[this.o++]; }
  bool() { return this.u8() !== 0; }
  u16() { const v = this.dv().getUint16(this.o, true); this.o += 2; return v; }
  u64() { const v = this.dv().getBigUint64(this.o, true); this.o += 8; return v; }
  i64() { const v = this.dv().getBigInt64(this.o, true); this.o += 8; return v; }
  u128() { const lo = this.u64(); const hi = this.u64(); return (hi << 64n) | lo; }
  key() { const k = new PublicKey(this.d.subarray(this.o, this.o + 32)); this.o += 32; return k; }
  be32() { const v = fromBe(this.d.subarray(this.o, this.o + 32)); this.o += 32; return v; }
}

export interface RegistryAccount { nextLoanRef: bigint }
export function decodeRegistry(data: Uint8Array): RegistryAccount {
  return { nextLoanRef: new Reader(data).u64() };
}

/** The Slot account (Anchor borsh, after the discriminator). Mirrors StreamLoan's Slot + Loan. */
export interface SlotAccount {
  loanRef: bigint; lender: PublicKey; bump: number; funded: boolean; settled: boolean; asset: PublicKey; tokenProgram: PublicKey;
  principal: bigint; repaid: bigint; minRemaining: bigint; minRate: bigint; pledgeBps: bigint; expiry: bigint; agentPk: bigint;
  fundedAt: bigint; payoutTo: PublicKey; streamStart: bigint;
}
export function decodeSlot(data: Uint8Array): SlotAccount {
  const x = new Reader(data);
  return {
    loanRef: x.u64(), lender: x.key(), bump: x.u8(), funded: x.bool(), settled: x.bool(), asset: x.key(), tokenProgram: x.key(), principal: x.u64(),
    repaid: x.u64(), minRemaining: x.u128(), minRate: x.u128(), pledgeBps: BigInt(x.u16()), expiry: x.u64(), agentPk: x.be32(), fundedAt: x.i64(),
    payoutTo: x.key(), streamStart: x.u64(),
  };
}

export interface LedgerAccount { loanRef: bigint; mint: PublicKey; held: bigint; received: bigint }
export function decodeLedger(data: Uint8Array): LedgerAccount {
  const x = new Reader(data);
  return { loanRef: x.u64(), mint: x.key(), held: x.u64(), received: x.u64() };
}

/** The Subrogation account: a safety pool paid the lender `owed`; `paid` of the loan's receipts went to `to` so far. */
export interface SubrogationAccount { loanRef: bigint; safetyConfig: PublicKey; to: PublicKey; owed: bigint; paid: bigint }
export function decodeSubrogation(data: Uint8Array): SubrogationAccount {
  const x = new Reader(data);
  return { loanRef: x.u64(), safetyConfig: x.key(), to: x.key(), owed: x.u64(), paid: x.u64() };
}

/** The loan's Subrogation, or undefined before any slash. */
export async function readSubrogation(connection: Connection, loanRef: bigint, programId = LOCALNET_LOAN_PROGRAM_ID): Promise<SubrogationAccount | undefined> {
  const info = await connection.getAccountInfo(subrogationPda(loanRef, programId), 'confirmed');
  return info && info.owner.equals(programId) ? decodeSubrogation(info.data) : undefined;
}

/** The LoanFunded event (`emit!`, logged as "Program data: <base64>"). `principal` is owed; `payoutTo` received principal - fee. */
export interface LoanFundedEvent { loanRef: bigint; lender: PublicKey; asset: PublicKey; principal: bigint; fee: bigint; payoutTo: PublicKey }
const LOAN_FUNDED_DISC = sha256(enc('event:LoanFunded')).subarray(0, 8);
/** The LoanFunded events in a transaction's logs (e.g. SentTx.logs of a fund). */
export function loanFundedEvents(logs: string[]): LoanFundedEvent[] {
  const out: LoanFundedEvent[] = [];
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue;
    const d = new Uint8Array(Buffer.from(line.slice('Program data: '.length), 'base64'));
    if (d.length < 8 + 8 + 32 + 32 + 8 + 8 + 32 || !LOAN_FUNDED_DISC.every((b, i) => d[i] === b)) continue;
    const x = new Reader(d);
    out.push({ loanRef: x.u64(), lender: x.key(), asset: x.key(), principal: x.u64(), fee: x.u64(), payoutTo: x.key() });
  }
  return out;
}

/**
 * The ClosedSlot receipt (Anchor borsh, after the discriminator). `lender` is at offset 16, as in Slot. `payoutTo`:
 * the borrower's payout account, recorded only in receipts made after the overpay cap (v2, 130 bytes).
 */
export interface ClosedSlotAccount {
  loanRef: bigint; lender: PublicKey; asset: PublicKey; principal: bigint; repaid: bigint; slotBump: number; bump: number; payoutTo?: PublicKey;
}
const CLOSED_SLOT_DISC = sha256(enc('account:ClosedSlot')).subarray(0, 8);
const SLOT_DISC = sha256(enc('account:Slot')).subarray(0, 8);
const hasDisc = (data: Uint8Array, disc: Uint8Array) => data.length >= 8 && disc.every((b, i) => data[i] === b);
export const isSlotAccount = (data: Uint8Array) => hasDisc(data, SLOT_DISC);
export const isClosedSlotAccount = (data: Uint8Array) => hasDisc(data, CLOSED_SLOT_DISC);
export function decodeClosedSlot(data: Uint8Array): ClosedSlotAccount {
  if (!isClosedSlotAccount(data) || data.length < CLOSED_SLOT_ACCOUNT_SIZE) throw new Error('not a ClosedSlot account');
  const x = new Reader(data);
  const c: ClosedSlotAccount = { loanRef: x.u64(), lender: x.key(), asset: x.key(), principal: x.u64(), repaid: x.u64(), slotBump: x.u8(), bump: x.u8() };
  if (data.length >= CLOSED_SLOT_V2_SIZE) c.payoutTo = x.key();
  return c;
}

/** The SlotClosed event: `lamportsRefunded` is net of the receipt's rent; the final figures of the loan. */
export interface SlotClosedEvent {
  loanRef: bigint; lender: PublicKey; lamportsRefunded: bigint; funded: boolean; asset: PublicKey; principal: bigint; repaid: bigint; agentPk: bigint; expiry: bigint;
}
const SLOT_CLOSED_DISC = sha256(enc('event:SlotClosed')).subarray(0, 8);
export function slotClosedEvents(logs: string[]): SlotClosedEvent[] {
  const out: SlotClosedEvent[] = [];
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue;
    const d = new Uint8Array(Buffer.from(line.slice('Program data: '.length), 'base64'));
    if (d.length < 8 + 8 + 32 + 8 + 1 + 32 + 8 + 8 + 32 + 8 || !hasDisc(d, SLOT_CLOSED_DISC)) continue;
    const x = new Reader(d);
    out.push({
      loanRef: x.u64(), lender: x.key(), lamportsRefunded: x.u64(), funded: x.bool(), asset: x.key(), principal: x.u64(), repaid: x.u64(), agentPk: x.be32(),
      expiry: x.u64(),
    });
  }
  return out;
}

/**
 * Where a loan ref stands on chain. `open`: the Slot exists. `closed`: the lender closed it (close_slot); `receipt`
 * holds the final figures of a funded loan (absent for a slot that never lent). `none`: the ref was never opened.
 * A closed slot is a finished loan, never an error.
 */
export type LoanStatus =
  | { state: 'open'; slot: SlotAccount }
  | { state: 'closed'; receipt?: ClosedSlotAccount }
  | { state: 'none' };
type AccountsReader = Pick<Connection, 'getMultipleAccountsInfo'>;
export async function loanStatus(connection: AccountsReader, loanRef: bigint, programId = LOCALNET_LOAN_PROGRAM_ID): Promise<LoanStatus> {
  const [slot, receipt, registry] = await connection.getMultipleAccountsInfo(
    [slotPda(loanRef, programId), closedSlotPda(loanRef, programId), registryPda(programId)], 'confirmed',
  );
  if (slot && slot.owner.equals(programId) && isSlotAccount(slot.data)) return { state: 'open', slot: decodeSlot(slot.data) };
  if (receipt && receipt.owner.equals(programId) && isClosedSlotAccount(receipt.data)) return { state: 'closed', receipt: decodeClosedSlot(receipt.data) };
  // no slot and no receipt: a closed unfunded slot when the ref was handed out, else never opened
  if (registry && loanRef > 0n && loanRef < decodeRegistry(registry.data).nextLoanRef) return { state: 'closed' };
  return { state: 'none' };
}

type ProgramAccountsReader = Pick<Connection, 'getProgramAccounts'>;
const byLender = (lender: PublicKey, size: number) => ({ commitment: 'confirmed' as const, filters: [{ dataSize: size }, { memcmp: { offset: 16, bytes: lender.toBase58() } }] });
/** Every ClosedSlot receipt of `lender`, whatever its size (98-byte receipts and 130-byte v2 ones): discriminator + lender. */
const receiptsOf = (lender: PublicKey) => ({
  commitment: 'confirmed' as const,
  filters: [{ memcmp: { offset: 0, bytes: Buffer.from(CLOSED_SLOT_DISC).toString('base64'), encoding: 'base64' as const } }, { memcmp: { offset: 16, bytes: lender.toBase58() } }],
});

/**
 * A lender's slots whose rent close_slot can reclaim now or after a step the SDK takes for it: settled loans
 * (`reason: 'settled'`) and, with `includeUnfunded`, slots that never lent (`'unfunded'`; a slot waiting for its
 * borrower is one of those, so they are left out by default). `lamports`: the slot's own rent (the inbox and
 * Ledger of a settled loan add theirs; the receipt takes some back). One getProgramAccounts call.
 */
export async function reclaimableSlots(
  connection: ProgramAccountsReader, lender: PublicKey, programId = LOCALNET_LOAN_PROGRAM_ID, opts: { includeUnfunded?: boolean } = {},
): Promise<Array<{ loanRef: bigint; reason: 'settled' | 'unfunded'; lamports: number; slot: SlotAccount }>> {
  const found = await connection.getProgramAccounts(programId, byLender(lender, SLOT_ACCOUNT_SIZE));
  const out: Array<{ loanRef: bigint; reason: 'settled' | 'unfunded'; lamports: number; slot: SlotAccount }> = [];
  for (const f of found) {
    if (!isSlotAccount(f.account.data)) continue;
    const s = decodeSlot(f.account.data);
    if (!s.lender.equals(lender)) continue;
    if (s.funded && s.settled) out.push({ loanRef: s.loanRef, reason: 'settled', lamports: f.account.lamports, slot: s });
    else if (!s.funded && opts.includeUnfunded) out.push({ loanRef: s.loanRef, reason: 'unfunded', lamports: f.account.lamports, slot: s });
  }
  return out.sort((a, b) => (a.loanRef < b.loanRef ? -1 : 1));
}

/** A lender's ClosedSlot receipts (its closed funded loans, both receipt sizes), oldest first. One getProgramAccounts call. */
export async function closedSlots(connection: ProgramAccountsReader, lender: PublicKey, programId = LOCALNET_LOAN_PROGRAM_ID): Promise<ClosedSlotAccount[]> {
  const found = await connection.getProgramAccounts(programId, receiptsOf(lender));
  return found.filter((f) => isClosedSlotAccount(f.account.data)).map((f) => decodeClosedSlot(f.account.data))
    .filter((c) => c.lender.equals(lender)).sort((a, b) => (a.loanRef < b.loanRef ? -1 : 1));
}

const tokenAmount = (info: { data: Uint8Array } | null | undefined): bigint =>
  info && info.data.length >= 72 ? Buffer.from(info.data.buffer, info.data.byteOffset, info.data.byteLength).readBigUInt64LE(64) : 0n;
const tokenOwner = (info: { data: Uint8Array; owner: PublicKey } | null | undefined): PublicKey | undefined =>
  info && info.data.length >= 165 && (info.owner.equals(SPL_TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID)) ? new PublicKey(info.data.subarray(32, 64)) : undefined;

/** What the lender may still claim on an open loan (the program's claim check): principal - repaid - unsynced inbox - escrow. */
export function claimRoom(s: Pick<SlotAccount, 'principal' | 'repaid'>, pendingInbox: bigint, escrowed: bigint): bigint {
  const room = s.principal - s.repaid - pendingInbox - escrowed;
  return room > 0n ? room : 0n;
}

/** sweep_closed's split of a closed slot's inbox (state::sweep_split): the held part first, then up to the room. */
export function sweepSplit(inbox: bigint, held: bigint, room: bigint): { fromHeld: bigint; fromRoom: bigint } {
  const fromHeld = held < inbox ? held : inbox;
  const rest = inbox - fromHeld;
  return { fromHeld, fromRoom: rest < room ? rest : room };
}

/**
 * The amount a lender claim asks for (prepareClaim): `amount` when given, else everything vested, capped at `owed`
 * (claimRoom) when the cap applies (`owed` undefined: another mint, or the cap is skipped). Throws, as the program
 * would refuse, once nothing is owed (`repaid`: the loan itself is repaid; otherwise value already routed covers it)
 * or when `amount` is above `owed`.
 */
export function claimAmount(vested: bigint, owed: bigint | undefined, amount: bigint | undefined, loanRef: bigint, repaid = false): bigint {
  if (owed !== undefined) {
    if (owed === 0n) {
      throw new Error(repaid ? `loan ${loanRef} is repaid: nothing more to claim` : `loan ${loanRef}: what is still owed is already on its way (sync it)`);
    }
    if (amount !== undefined && amount > owed) throw new Error(`claim of ${amount} is more than loan ${loanRef} still owes (${owed})`);
  }
  const want = amount ?? (owed !== undefined && owed < vested ? owed : vested);
  if (want <= 0n) throw new Error('nothing claimable yet');
  return want;
}

/** The borrower's excess waiting in a loan's inbox (overpay cap), with what return_excess needs to send it. */
export interface LoanExcess {
  loanRef: bigint; mint: PublicKey; tokenProgram: PublicKey; amount: bigint; asset?: PublicKey;
  /** the recorded payout account; undefined for a closed loan with an older (98-byte) receipt */
  payoutTo?: PublicKey;
  /** the loan is open (Slot) or closed (receipt) */
  closed: boolean;
}

/**
 * The borrower's excess in the slot's inbox for `mint` (default: the loan asset): everything above `held` and above
 * what the loan may still credit (principal - repaid in the loan asset, 0 in any other mint), as return_excess
 * computes it. 0 for a slot that never lent or a ref with no receipt.
 */
export async function loanExcess(connection: Connection, loanRef: bigint, mint?: PublicKey, programId = LOCALNET_LOAN_PROGRAM_ID): Promise<LoanExcess> {
  const st = await loanStatus(connection, loanRef, programId);
  let principal = 0n, repaid = 0n, asset: PublicKey | undefined, payoutTo: PublicKey | undefined;
  if (st.state === 'open' && st.slot.funded) ({ principal, repaid, asset, payoutTo } = st.slot);
  else if (st.state === 'closed' && st.receipt) ({ principal, repaid, asset, payoutTo } = st.receipt);
  const m = mint ?? asset;
  if (!m) return { loanRef, mint: PublicKey.default, tokenProgram: SPL_TOKEN_PROGRAM_ID, amount: 0n, closed: st.state === 'closed' };
  const mintInfo = await connection.getAccountInfo(m, 'confirmed');
  const tokenProgram = mintInfo?.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : SPL_TOKEN_PROGRAM_ID;
  const [inbox, ledger] = await connection.getMultipleAccountsInfo([slotInbox(loanRef, m, tokenProgram, programId), ledgerPda(loanRef, m, programId)], 'confirmed');
  const held = ledger && ledger.owner.equals(programId) ? decodeLedger(ledger.data).held : 0n;
  const room = asset && m.equals(asset) && principal > repaid ? principal - repaid : 0n;
  const above = tokenAmount(inbox) - held - room;
  return { loanRef, mint: m, tokenProgram, amount: asset && above > 0n ? above : 0n, asset, payoutTo, closed: st.state === 'closed' };
}

/**
 * Sends the borrower's excess back (stream_loan return_excess; anyone may, `payer` pays the fee and, for another
 * mint, the rent of the payout owner's token account if it is missing). With `owner` (the payout account's owner,
 * signing) it goes to `destination` (default: the owner's associated token account, created if needed). Throws when
 * nothing is waiting, or when a closed loan's older receipt records no payout account.
 */
export async function returnExcess(
  connection: Connection, payer: Keypair, loanRef: bigint, opts: { mint?: PublicKey; programId?: PublicKey; owner?: Keypair; destination?: PublicKey } = {},
): Promise<SentTx & { amount: bigint }> {
  const programId = opts.programId ?? LOCALNET_LOAN_PROGRAM_ID;
  const ex = await loanExcess(connection, loanRef, opts.mint, programId);
  if (ex.amount <= 0n) throw new Error(`no borrower excess waiting for loan ${loanRef}`);
  if (!ex.payoutTo) throw new Error(`loan ${loanRef} was closed before the overpay cap: its receipt records no payout account`);
  const tp = ex.tokenProgram;
  const pre: TransactionInstruction[] = [];
  let destination: PublicKey;
  if (opts.owner) {
    destination = opts.destination ?? associatedTokenAddress(opts.owner.publicKey, ex.mint, tp);
    if (!opts.destination) pre.push(createAtaIdempotentIx(payer.publicKey, opts.owner.publicKey, ex.mint, tp));
  } else if (ex.asset && ex.mint.equals(ex.asset)) {
    destination = ex.payoutTo;
  } else {
    const owner = tokenOwner(await connection.getAccountInfo(ex.payoutTo, 'confirmed'));
    if (!owner) throw new Error(`payout account ${ex.payoutTo.toBase58()} cannot be read: its owner must sign to redirect the excess`);
    destination = associatedTokenAddress(owner, ex.mint, tp);
    pre.push(createAtaIdempotentIx(payer.publicKey, owner, ex.mint, tp));
  }
  const tx = await send(connection, payer, [...pre, returnExcessIx(loanRef, ex.mint, ex.payoutTo, destination, tp, programId, opts.owner?.publicKey)], {
    signers: opts.owner && !opts.owner.publicKey.equals(payer.publicKey) ? [opts.owner] : [],
  });
  return { ...tx, amount: ex.amount };
}

/** Same rule as the program: unpaid principal once expiry + GRACE has passed (`pending`: unsynced inbox value plus the pool escrow, which count as paid). */
export function shortfallOf(s: SlotAccount, now: bigint, pending = 0n): bigint {
  if (!s.funded || s.settled || s.expiry === 0n) return 0n;
  if (now <= s.expiry + GRACE) return 0n;
  const paid = s.repaid + pending;
  return paid >= s.principal ? 0n : s.principal - paid;
}

// ============================================================= wallet

/** A pledged note as the lender knows it. `lost`: spent on chain, and no successor memo the lender could read. */
export interface SolLenderNote {
  allowance: Allowance; commitment: bigint; index: number; spent: boolean; lost: boolean; views: MemoViews; lender: LenderInfo; mint?: PublicKey;
}

/** Records handed over before their commitment appeared on chain are kept up to this many; older ones are dropped. */
export const PENDING_MAX = 256;

type LenderRecord = AllowanceRecord & { lender: LenderInfo; mint?: PublicKey; lenderKey?: PublicKey };

/** The memos a claim writes (see claimMemos). */
export interface SolSpendMemos { encryptedAllowance: Uint8Array; encryptedPayment: Uint8Array; encryptedLender: Uint8Array }

/** A lender claim built and proven but not sent (tests replay or tamper with it). */
export interface PreparedLoanClaim {
  loanRef: bigint; mint: PublicKey; tokenProgram: PublicKey; amount: bigint; next: Allowance; proof: ProofResult; args: SpendArgs;
  accounts: Omit<SpendAccounts, 'buffer'>; payload: Uint8Array;
}

function safeUnpack(b: Uint8Array): Uint8Array[] {
  try { return unpackMemos(b); } catch { return []; }
}

/**
 * The lender's side of a stream-backed loan through the stream_loan registry: the surface of LenderWallet
 * in src/lender.ts. Tracks the pledged notes it was handed, follows their successors on chain (every spend on
 * a pledged note emits a LenderMemo for the lender), prices what it may claim, and pulls the vested share
 * through the registry (the slot PDA signs the pool's lender claim). On Solana each slot is its own
 * lenderAddr, fieldOf(slot PDA), so `address(loanRef)` replaces the registry-wide address of the EVM wallet.
 */
export class SolanaLoanLenderWallet {
  readonly tree = new MerkleTree(LEVELS);
  /** every pledged note this lender knows, by commitment */
  readonly notes = new Map<bigint, SolLenderNote>();
  private pending: LenderRecord[] = [];
  private nullifierSet = new Set<bigint>();
  private cursor = 0;
  private treeQueue = new Map<number, { commitment: bigint; memo: Uint8Array }>();

  /** `signer` owns the slots (open_slot, fund, claim, settle check it) and pays fees. */
  constructor(
    readonly pool: SolanaPool,
    readonly signer: Keypair,
    readonly view: ViewingKey,
    readonly programId: PublicKey = LOCALNET_LOAN_PROGRAM_ID,
    /** owner of the fee treasury accounts: stream_loan fee::TREASURY of the build this wallet talks to */
    readonly treasuryOwner: PublicKey = LOAN_TREASURY,
    /** the safety_pool whose covers close_slot checks (stream_loan safety::SAFETY_POOL_ID); known for localnet and mainnet */
    readonly safetyProgram: PublicKey | undefined = safetyPoolFor(programId),
  ) {
    // localnet defaults against any other stipend_pool are a wrong-cluster setup (the program would refuse
    // the treasury, or the ids would not be the deployed ones): demand explicit ids instead
    if (!pool.programId.equals(LOCALNET_POOL_PROGRAM_ID) && (programId.equals(LOCALNET_LOAN_PROGRAM_ID) || treasuryOwner.equals(LOAN_TREASURY))) {
      throw new Error('SolanaLoanLenderWallet: pass the stream_loan program id and treasury owner of this cluster (the defaults are localnet only)');
    }
  }

  get connection(): Connection { return this.pool.connection; }

  /** What a borrower's owner needs to pledge to this lender for `loanRef`. */
  address(loanRef: bigint): { lender: PublicKey; lenderAddr: bigint; loanRef: bigint; viewPub: Uint8Array } {
    const { lender, lenderAddr } = slotLenderAddr(loanRef, this.programId);
    return { lender, lenderAddr, loanRef, viewPub: this.view.pub };
  }

  /** Pledge terms for SolanaWallet.grant / pledge. */
  terms(loanRef: bigint, pledgeBps: bigint): SolPledgeTerms {
    return { lender: slotPda(loanRef, this.programId), loanRef, pledgeBps, lenderViewPub: this.view.pub };
  }

  /** True when the note's lender is one of this registry's slots. */
  private ours(l: LenderInfo): boolean {
    return l.loanRef > 0n && fieldOf(slotPda(l.loanRef, this.programId)) === l.lenderAddr;
  }

  // ---- registry ----

  /** Creates the registry's loan-ref counter if missing. The signer must be the program's upgrade authority. */
  async initialize(): Promise<void> {
    if (await this.connection.getAccountInfo(registryPda(this.programId), 'confirmed')) return;
    await send(this.connection, this.signer, [loanInitializeIx(this.signer.publicKey, this.programId)]);
  }

  /** Reserve a slot; the borrower pledges to (fieldOf(slot PDA), loanRef). Retries if another lender took the ref first. */
  async openSlot(): Promise<bigint> {
    for (let attempt = 0; ; attempt++) {
      const info = await this.connection.getAccountInfo(registryPda(this.programId), 'confirmed');
      if (!info) throw new Error('registry not initialized');
      const ref = decodeRegistry(info.data).nextLoanRef;
      try {
        await send(this.connection, this.signer, [openSlotIx(this.signer.publicKey, ref, this.programId)]);
        return ref;
      } catch (e) {
        if (attempt >= 3) throw e;
      }
    }
  }

  /**
   * Fund a slot against a stream proof; the principal leaves the lender's associated token account:
   * principal - originationFee(principal) to `payoutTo` (a token account of `mint`), the fee to the treasury.
   * The loan owes the full principal. The proof must describe a live note this lender was handed (same
   * agent, cap, expiry, pledge, routed total, start and asset, with the bounds holding), and `principal` must
   * be exactly what it backs, maxPrincipal(minRemaining, pledgeBps): the borrower fixed it by proving
   * minRemaining = minRemainingFor(principal, pledgeBps).
   */
  async fund(loanRef: bigint, stream: { proof: ProofResult; args: StreamArgs }, mint: PublicKey, principal: bigint, payoutTo: PublicKey): Promise<SentTx> {
    const s = stream.args;
    if (s.loanRef !== loanRef) throw new Error('stream proof is for another slot');
    if (!s.lender.equals(slotPda(loanRef, this.programId))) throw new Error('stream proof names another lender');
    if (!s.asset.equals(mint)) throw new Error('stream proof names another asset');
    if (s.audience !== payoutAudience(payoutTo)) throw new Error('stream proof was not made for this payout account (audience must be fieldOf(payoutTo))');
    await this.sync();
    const backing = this.current(loanRef).find((n) => {
      const a = n.allowance;
      const P = a.policy;
      return a.agentPk === s.agentPk && P.lifetimeCap === s.lifetimeCap && P.expiry === s.expiry && P.pledgeBps === BigInt(s.pledgeBps)
        && a.pledgePaid === s.pledgePaid && P.streamStart === s.streamStart && a.asset === fieldOf(mint)
        && a.remaining >= s.minRemaining && P.streamRate >= s.minRate;
    });
    if (!backing) throw new Error('stream proof does not match a live note handed to this lender');
    if (principal <= 0n || principal !== maxPrincipal(s.minRemaining, s.pledgeBps)) {
      throw new Error(`principal must be exactly what the proof backs: ${maxPrincipal(s.minRemaining, s.pledgeBps)} (minRemaining * pledgeBps / 10,000)`);
    }
    return this.fundUnchecked(loanRef, stream, mint, principal, payoutTo);
  }

  /** The fund transaction without the SDK-side note checks (the program's checks still apply). */
  async fundUnchecked(
    loanRef: bigint, stream: { proof: ProofResult; args: StreamArgs }, mint: PublicKey, principal: bigint, payoutTo: PublicKey, opts: { pullEscrow?: boolean; treasury?: PublicKey } = {},
  ): Promise<SentTx> {
    const tokenProgram = await this.pool.tokenProgramOf(mint);
    const payload = concatBytes(encodeProof(stream.proof.proof), encodeStreamArgs(stream.args));
    // a share the pool escrowed for this slot before funding is pulled into the inbox first; it counts as repayment
    const slot = slotPda(loanRef, this.programId);
    const escrowed = await this.pool.tokenBalance(slotEscrow(loanRef, mint, this.pool.programId, this.programId));
    const pre = escrowed > 0n && opts.pullEscrow !== false
      ? [createAtaIdempotentIx(this.signer.publicKey, slot, mint, tokenProgram), pullLenderShareIx(this.pool.programId, mint, tokenProgram, fieldOf(slot), loanRef, slotInbox(loanRef, mint, tokenProgram, this.programId))]
      : [];
    // the treasury's account for the asset must exist when a fee is due; creating it is idempotent (the lender pays rent once per asset)
    if (originationFee(principal) > 0n) pre.push(createAtaIdempotentIx(this.signer.publicKey, this.treasuryOwner, mint, tokenProgram));
    const buf = await uploadBuffer(this.connection, this.pool.programId, this.signer, payload);
    try {
      return await send(this.connection, this.signer, [
        ...pre,
        fundIx({
          lender: this.signer.publicKey, loanRef, principal, poolProgram: this.pool.programId, poolState: poolPda(this.pool.programId), buffer: buf.address,
          mint, lenderSource: associatedTokenAddress(this.signer.publicKey, mint, tokenProgram), payoutTo, tokenProgram, treasury: opts.treasury ?? loanTreasuryAccount(mint, tokenProgram, this.treasuryOwner),
        }, this.programId),
        bufferCloseIx(this.pool.programId, this.signer.publicKey, buf.seed),
      ], { cuLimit: OP_CU_LIMIT });
    } catch (e) {
      await closeBuffer(this.connection, this.pool.programId, this.signer, buf.seed).catch(() => undefined);
      throw e;
    }
  }

  /** Permissionless: credit and forward the shares that reached the slot's inbox (defaults to the loan asset). */
  async syncLoan(loanRef: bigint, mint?: PublicKey, payer: Keypair = this.signer): Promise<SentTx> {
    const slot = await this.loan(loanRef);
    const m = mint ?? slot.asset;
    const sub = await this.subrogation(loanRef);
    return send(this.connection, payer, [syncIx(payer.publicKey, loanRef, m, slot.lender, await this.pool.tokenProgramOf(m), this.programId, sub?.to)]);
  }

  /** The slash recorded for the loan by a safety pool, if any (its receipts go to `to` until `paid` reaches `owed`). */
  async subrogation(loanRef: bigint): Promise<SubrogationAccount | undefined> {
    return readSubrogation(this.connection, loanRef, this.programId);
  }

  /** The slot's lender takes shares the registry could not forward (lender account missing or frozen). */
  async collect(loanRef: bigint, mint: PublicKey, destination?: PublicKey): Promise<SentTx> {
    const tp = await this.pool.tokenProgramOf(mint);
    const to = destination ?? (await this.pool.ensureAta(this.signer, mint, this.signer.publicKey));
    return send(this.connection, this.signer, [collectIx(this.signer.publicKey, loanRef, mint, to, tp, this.programId)]);
  }

  async settle(loanRef: bigint): Promise<SentTx> {
    return send(this.connection, this.signer, [settleIx(this.signer.publicKey, loanRef, this.programId)]);
  }

  async loan(loanRef: bigint): Promise<SlotAccount> {
    const info = await this.connection.getAccountInfo(slotPda(loanRef, this.programId), 'confirmed');
    if (!info) {
      const st = await loanStatus(this.connection, loanRef, this.programId);
      throw new Error(st.state === 'closed' ? `slot ${loanRef} is closed (the loan is finished; see status())` : `no slot ${loanRef}`);
    }
    return decodeSlot(info.data);
  }

  /** Where `loanRef` stands: open (the Slot), closed (the lender reclaimed its rent; the receipt's final figures), or none. */
  status(loanRef: bigint): Promise<LoanStatus> {
    return loanStatus(this.connection, loanRef, this.programId);
  }

  /** This lender's slots whose rent `close` reclaims: settled loans (and, with includeUnfunded, slots that never lent). */
  reclaimable(opts: { includeUnfunded?: boolean } = {}) {
    return reclaimableSlots(this.connection, this.signer.publicKey, this.programId, opts);
  }

  /** This lender's closed loans (ClosedSlot receipts). */
  closed(): Promise<ClosedSlotAccount[]> {
    return closedSlots(this.connection, this.signer.publicKey, this.programId);
  }

  /**
   * Closes the slot of a finished loan and takes its rent back (close_slot). A settled loan: routed shares still in
   * the inbox are synced to this lender first (creating its token account if needed) and what is held is collected;
   * an open safety_pool cover of the loan is released in the same transaction (release_cover is permissionless and
   * succeeds on a settled loan). A slot that never lent closes as it is. Returns the close transaction and the
   * lamports it refunded net of the receipt (the SlotClosed event). A repaid loan may close with borrower excess still
   * in its inbox; `returnExcess: true` sends it back right after (best effort, a separate return_excess transaction;
   * anyone may do it later). Off by default: a caller that allowlists the instructions it sends must list
   * stream_loan `return_excess` before turning it on.
   */
  async close(loanRef: bigint, opts: { returnExcess?: boolean } = {}): Promise<SentTx & { refunded: bigint }> {
    const s = await this.loan(loanRef);
    if (!s.lender.equals(this.signer.publicKey)) throw new Error(`slot ${loanRef} belongs to another lender`);
    const pre: TransactionInstruction[] = [];
    let loan: { asset: PublicKey; tokenProgram: PublicKey } | undefined;
    if (s.funded) {
      if (!s.settled) throw new Error(`loan ${loanRef} is not settled: settle it first`);
      const sub = await this.subrogation(loanRef);
      if (sub && sub.paid < sub.owed && s.repaid < s.principal) {
        throw new Error(`loan ${loanRef} was slashed and the safety pool has recovered ${sub.paid} of ${sub.owed}: the slot stays open until it has`);
      }
      loan = { asset: s.asset, tokenProgram: s.tokenProgram };
      const inbox = slotInbox(loanRef, s.asset, s.tokenProgram, this.programId);
      if ((await this.pool.tokenBalance(inbox)) > 0n) {
        await this.pool.ensureAta(this.signer, s.asset, this.signer.publicKey);
        await send(this.connection, this.signer, [syncIx(this.signer.publicKey, loanRef, s.asset, s.lender, s.tokenProgram, this.programId, (await this.subrogation(loanRef))?.to)]);
        if (((await this.ledger(loanRef, s.asset))?.held ?? 0n) > 0n) await this.collect(loanRef, s.asset);
      }
      if (!this.safetyProgram) throw new Error('pass the safety_pool program id of this cluster to SolanaLoanLenderWallet');
      const cover = await this.connection.getAccountInfo(coverPda(this.safetyProgram, loanRef), 'confirmed');
      if (cover && cover.owner.equals(this.safetyProgram)) {
        const c = decodeCover(cover.data);
        if (!c.paid && !c.released) {
          pre.push(releaseCoverIx(this.safetyProgram, c.mint, loanRef, loanAccounts(loanRef, s.asset, s.tokenProgram, this.programId, this.pool.programId)));
        }
      }
    }
    const tx = await send(this.connection, this.signer, [...pre, closeSlotIx(this.signer.publicKey, loanRef, loan, this.programId, this.safetyProgram)]);
    const ev = slotClosedEvents(tx.logs ?? []).find((e) => e.loanRef === loanRef);
    // a repaid loan may close with borrower excess still in the inbox: send it back when asked (best effort; anyone may later)
    if (s.funded && opts.returnExcess) await this.returnExcess(loanRef).catch(() => undefined);
    return { ...tx, refunded: ev?.lamportsRefunded ?? 0n };
  }

  /** The borrower's excess waiting in the loan's inbox for `mint` (default: the loan asset); see loanExcess. */
  excess(loanRef: bigint, mint?: PublicKey): Promise<LoanExcess> {
    return loanExcess(this.connection, loanRef, mint, this.programId);
  }

  /** Permissionless: sends the borrower's excess to its payout account (stream_loan return_excess); this wallet pays the fee. */
  returnExcess(loanRef: bigint, mint?: PublicKey): Promise<SentTx & { amount: bigint }> {
    return returnExcess(this.connection, this.signer, loanRef, { mint, programId: this.programId });
  }

  /**
   * After a close: hands this lender what a pledge routed to the closed loan in `mint` (default: the loan asset), up
   * to what the loan still owes (principal - receipt.repaid; nothing in another mint), pulling the pool escrow of the
   * slot into a re-created inbox first. What the mint's Ledger still holds for this lender (shares in another mint held
   * before the overpay cap) is paid first, and the Ledger closed. The rest is the borrower's: with `returnExcess: true`
   * and a v2 receipt it is sent back to the payout account in the same transaction (return_excess; off by default, see
   * close). An emptied inbox is closed again (its rent comes back). Throws when nothing reached the loan, or when
   * nothing is owed to this lender and the excess is not (or cannot be) sent back.
   */
  async sweepClosed(loanRef: bigint, mint?: PublicKey, destination?: PublicKey, opts: { returnExcess?: boolean } = {}): Promise<SentTx> {
    const st = await this.status(loanRef);
    if (st.state !== 'closed' || !st.receipt) throw new Error(`slot ${loanRef} has no closed-loan receipt`);
    const rc = st.receipt;
    if (!rc.lender.equals(this.signer.publicKey)) throw new Error(`loan ${loanRef} belongs to another lender`);
    const m = mint ?? rc.asset;
    const tp = await this.pool.tokenProgramOf(m);
    const slot = slotPda(loanRef, this.programId);
    const inbox = slotInbox(loanRef, m, tp, this.programId);
    const escrowed = await this.pool.tokenBalance(slotEscrow(loanRef, m, this.pool.programId, this.programId));
    const ixs = escrowed > 0n
      ? [createAtaIdempotentIx(this.signer.publicKey, slot, m, tp), pullLenderShareIx(this.pool.programId, m, tp, fieldOf(slot), loanRef, inbox)]
      : [];
    const inboxInfo = await this.connection.getAccountInfo(inbox, 'confirmed');
    if (!ixs.length && !inboxInfo) throw new Error(`nothing reached closed loan ${loanRef} in ${m.toBase58()}`);
    const ledger = await this.ledger(loanRef, m);
    const room = m.equals(rc.asset) && rc.principal > rc.repaid ? rc.principal - rc.repaid : 0n;
    const { fromHeld, fromRoom } = sweepSplit(tokenAmount(inboxInfo) + escrowed, ledger?.held ?? 0n, room);
    const pay = fromHeld + fromRoom;
    const rest = tokenAmount(inboxInfo) + escrowed - pay;
    const sweep = async () => sweepClosedIx(this.signer.publicKey, loanRef, m, destination ?? (await this.pool.ensureAta(this.signer, m, this.signer.publicKey)), tp, this.programId);
    if (pay > 0n) ixs.push(await sweep());
    if (rest > 0n && !opts.returnExcess) {
      if (pay === 0n) throw new Error(`nothing is owed to the lender on closed loan ${loanRef}; the ${rest} waiting is the borrower's (send it back with returnExcess)`);
    } else if (rest > 0n) {
      if (!rc.payoutTo) {
        if (pay === 0n) throw new Error(`nothing is owed to the lender on closed loan ${loanRef}; the rest is the borrower's and its older receipt records no payout account`);
      } else {
        const toBorrower = m.equals(rc.asset) ? rc.payoutTo : tokenOwner(await this.connection.getAccountInfo(rc.payoutTo, 'confirmed'));
        if (toBorrower) {
          const dest = m.equals(rc.asset) ? rc.payoutTo : associatedTokenAddress(toBorrower, m, tp);
          if (!m.equals(rc.asset)) ixs.push(createAtaIdempotentIx(this.signer.publicKey, toBorrower, m, tp));
          ixs.push(returnExcessIx(loanRef, m, rc.payoutTo, dest, tp, this.programId));
          ixs.push(await sweep()); // closes the emptied inbox (a Ledger was closed by the first sweep)
        } else if (pay === 0n) {
          throw new Error(`nothing is owed to the lender on closed loan ${loanRef}; the borrower's payout account cannot be read`);
        }
      }
    } else if (pay === 0n) {
      ixs.push(await sweep()); // nothing waiting: just close the inbox
    }
    return send(this.connection, this.signer, ixs);
  }

  async ledger(loanRef: bigint, mint: PublicKey): Promise<LedgerAccount | undefined> {
    const info = await this.connection.getAccountInfo(ledgerPda(loanRef, mint, this.programId), 'confirmed');
    return info ? decodeLedger(info.data) : undefined;
  }

  /** The program's shortfall view (simulated; unsynced inbox value and the pool escrow count as paid). */
  async shortfall(loanRef: bigint): Promise<bigint> {
    const s = await this.loan(loanRef);
    const asset = s.funded ? s.asset : PublicKey.default;
    const tp = s.funded ? s.tokenProgram : SPL_TOKEN_PROGRAM_ID;
    const sim = await simulate(this.connection, this.signer, [shortfallIx(loanRef, asset, tp, this.programId, this.pool.programId)]);
    if (sim.err) throw new Error(`shortfall view failed: ${JSON.stringify(sim.err)}`);
    const line = sim.logs.find((l) => l.startsWith(`Program return: ${this.programId.toBase58()} `));
    if (!line) throw new Error('shortfall view returned nothing');
    return Buffer.from(line.split(' ')[3], 'base64').readBigUInt64LE(0);
  }

  // ---- notes ----

  /** Take in the sealed copy a borrower's owner hands over after a pledge. */
  ingest(payload: LenderPayload): SolLenderNote | undefined {
    const rec = openSolLenderMemo(this.view, payload);
    if (!rec) throw new Error('payload is not a pledged allowance for this key');
    return this.record(rec);
  }

  private record(rec: LenderRecord): SolLenderNote | undefined {
    if (!this.ours(rec.lender)) throw new Error('allowance is pledged to another lender');
    const commitment = allowanceCommitment(rec.allowance);
    const known = this.notes.get(commitment);
    if (known) return known;
    const index = this.tree.indexOf(commitment);
    if (index < 0) {
      this.pending.push(rec);
      if (this.pending.length > PENDING_MAX) this.pending.splice(0, this.pending.length - PENDING_MAX);
      return undefined;
    }
    const note: SolLenderNote = {
      allowance: rec.allowance, commitment, index, spent: this.nullifierSet.has(allowanceNullifier(rec.allowance.rho, commitment)), lost: false,
      views: rec.views, lender: rec.lender, mint: rec.mint,
    };
    this.notes.set(commitment, note);
    return note;
  }

  /** Follows the pool's events: commitments (with packed lender copies), LenderMemo successors, nullifiers. */
  async sync(): Promise<void> {
    await this.pool.log.refresh();
    const evs = this.pool.log.events;
    const found: LenderRecord[] = [];
    for (; this.cursor < evs.length; this.cursor++) {
      const e = evs[this.cursor];
      if (e.name === 'NewCommitment') this.treeQueue.set(e.index, { commitment: e.commitment, memo: e.encryptedOutput });
      else if (e.name === 'NewNullifier') this.nullifierSet.add(e.nullifier);
      else if (e.name === 'LenderMemo') {
        const rec = openSolLenderMemo(this.view, e.encryptedLender);
        if (rec && this.ours(rec.lender)) found.push(rec);
      }
    }
    for (let next = this.treeQueue.get(this.tree.size); next; next = this.treeQueue.get(this.tree.size)) {
      this.treeQueue.delete(this.tree.size);
      this.tree.insert(next.commitment);
      // a pledged grant output, sub or residual carries a lender copy in its commitment memo
      for (const m of next.memo.length > 0 ? [next.memo, ...safeUnpack(next.memo)] : []) {
        const rec = openSolLenderMemo(this.view, m);
        if (rec && this.ours(rec.lender) && allowanceCommitment(rec.allowance) === next.commitment) found.push(rec);
      }
    }
    const pending = this.pending;
    this.pending = [];
    for (const rec of [...pending, ...found]) this.record(rec);
    // a spent note whose successor (rho' = nextRho(rho)) never reached this lender is lost to the pull path
    const rhos = new Set([...this.notes.values()].map((n) => n.allowance.rho));
    for (const n of this.notes.values()) {
      if (this.nullifierSet.has(allowanceNullifier(n.allowance.rho, n.commitment))) n.spent = true;
      n.lost = n.spent && !rhos.has(nextRho(n.allowance.rho));
    }
  }

  /** Live notes pledged to `loanRef`, largest balance first. */
  current(loanRef: bigint): SolLenderNote[] {
    return [...this.notes.values()].filter((n) => !n.spent && n.lender.loanRef === loanRef).sort((a, b) => (a.allowance.remaining > b.allowance.remaining ? -1 : 1));
  }

  /** True when the borrower moved a note of this loan without handing the lender its successor; only the shortfall path remains. */
  opaque(loanRef: bigint): boolean {
    return [...this.notes.values()].some((n) => n.lost && n.lender.loanRef === loanRef);
  }

  /** What the lender may pull right now across every live note of the loan. */
  claimable(loanRef: bigint, now: bigint): bigint {
    return this.current(loanRef).reduce((s, n) => s + lenderClaimable(n.allowance, now), 0n);
  }

  /**
   * Builds the claim on the loan's live note with the most to claim (`amount` defaults to all of it, capped at what
   * the loan still owes: principal - repaid - unsynced inbox - escrow; throws once the loan is repaid): the
   * lender-claim spend payload and the stipend_pool `spend` accounts (lender leg to the slot's inbox, the slot
   * PDA as lender signer). Not sent; see `claim`.
   */
  async prepareClaim(loanRef: bigint, amount?: bigint, opts: { now?: bigint; /** tests only: skip the owed check (the program still refuses) */ uncapped?: boolean } = {}): Promise<PreparedLoanClaim> {
    await this.sync();
    const now = opts.now ?? (await this.pool.now());
    const notes = this.current(loanRef);
    if (notes.length === 0) {
      if (this.opaque(loanRef)) throw new Error('borrower withheld the successor memo; use shortfall/settle');
      throw new Error('no live note for this loan');
    }
    const note = notes.reduce((best, n) => (lenderClaimable(n.allowance, now) > lenderClaimable(best.allowance, now) ? n : best));
    const slot = await this.loan(loanRef);
    const mint = note.mint ?? (slot.funded ? slot.asset : undefined);
    if (!mint) throw new Error('mint of the pledged note is unknown');
    // overpay cap: the program refuses a claim above what the loan still owes (principal - repaid - value already
    // routed: the unsynced inbox and the slot's pool escrow), and any claim once it is repaid. Valid against the
    // program before the cap too (it only ever asks for less).
    let owed: bigint | undefined;
    if (slot.funded && mint.equals(slot.asset) && !opts.uncapped) {
      const tp = await this.pool.tokenProgramOf(mint);
      const [inboxBal, ledger, escrowed] = await Promise.all([
        this.pool.tokenBalance(slotInbox(loanRef, mint, tp, this.programId)), this.ledger(loanRef, mint),
        this.pool.tokenBalance(slotEscrow(loanRef, mint, this.pool.programId, this.programId)),
      ]);
      const pending = inboxBal > (ledger?.held ?? 0n) ? inboxBal - (ledger?.held ?? 0n) : 0n;
      owed = claimRoom(slot, pending, escrowed);
    }
    const want = claimAmount(lenderClaimable(note.allowance, now), owed, amount, loanRef, slot.repaid >= slot.principal);
    const base = {
      root: this.tree.root, allowance: note.allowance, path: this.tree.path(note.index), amount: want, now, claim: true,
      lender: { lenderAddr: note.lender.lenderAddr, loanRef },
    };
    const draft = spendInput({ ...base, extDataHash: 0n });
    const extBytes = encodeSpendExt({ relayer: DEFAULT_PUBKEY, feeRecipient: DEFAULT_PUBKEY, ...this.claimMemos(draft.next, note, mint) });
    const h = extDataHash(extBytes);
    const built = spendInput({ ...base, extDataHash: h });
    const proof = await this.pool.prover.prove('spend', built.input);
    const args: SpendArgs = {
      root: base.root, nullifier: built.nullifier, newAllowanceCommitment: built.newAllowanceCommitment, payCommitment: 0n, publicAmount: 0n,
      publicRecipient: DEFAULT_PUBKEY, publicAsset: mint, fee: 0n, timestamp: now, receipt: built.receipt, lenderAmount: built.lenderAmount,
      lenderAddr: note.lender.lenderAddr, loanRef, isLenderClaim: true, extDataHash: h,
    };
    const tokenProgram = await this.pool.tokenProgramOf(mint);
    await this.pool.ensureVault(this.signer, mint);
    const accounts: Omit<SpendAccounts, 'buffer'> = {
      payer: this.signer.publicKey, nullifier: built.nullifier, token: { mint, tokenProgram }, lenderToken: slotInbox(loanRef, mint, tokenProgram, this.programId),
      escrow: { lenderAddr: note.lender.lenderAddr, loanRef }, lenderSigner: slotPda(loanRef, this.programId),
    };
    return {
      loanRef, mint, tokenProgram, amount: want, next: built.next, proof, args, accounts,
      payload: concatBytes(encodeProof(proof.proof), encodeSpendArgs(args), extBytes),
    };
  }

  /** Sends a prepared claim through the registry (`stream_loan.claim`); the share is credited in the same instruction. */
  async submitClaim(p: PreparedLoanClaim, loanRef = p.loanRef): Promise<SentTx> {
    const sub = await this.subrogation(loanRef);
    const buf = await uploadBuffer(this.connection, this.pool.programId, this.signer, p.payload);
    try {
      const spend = spendIx(this.pool.programId, { ...p.accounts, buffer: buf.address });
      return await send(this.connection, this.signer, [claimIx(this.signer.publicKey, loanRef, p.mint, spend, p.tokenProgram, this.programId, sub?.to)], { cuLimit: OP_CU_LIMIT });
    } catch (e) {
      await closeBuffer(this.connection, this.pool.programId, this.signer, buf.seed).catch(() => undefined);
      throw e;
    }
  }

  /**
   * Pull the vested share from the loan's live note with the most to claim (`amount` defaults to all of it).
   * The registry checks the slot owner and signs the pool's lender claim with the slot PDA. The borrower
   * learns its successor note from the memo this writes.
   */
  async claim(loanRef: bigint, amount?: bigint): Promise<{ tx: SentTx; proof: ProofResult; next: Allowance; amount: bigint }> {
    const p = await this.prepareClaim(loanRef, amount);
    const tx = await this.submitClaim(p);
    await this.sync();
    return { tx, proof: p.proof, next: p.next, amount: p.amount };
  }

  /**
   * The memos a claim writes: the successor for the agent and the owner, and the lender's own copy. A subclass
   * may override it (a lender that withholds the borrower's copy; the borrower recovers anyway).
   */
  protected claimMemos(next: Allowance, note: SolLenderNote, mint: PublicKey): SolSpendMemos {
    const extra = { mint, lenderKey: slotPda(note.lender.loanRef, this.programId) };
    return {
      encryptedAllowance: solAllowanceMemo(next, note.views, note.lender, extra),
      encryptedPayment: new Uint8Array(),
      encryptedLender: solSealForLender(next, note.views, note.lender, extra),
    };
  }
}
