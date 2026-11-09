// SDK side of stream_loan close_slot / sweep_closed (no validator): instruction layout, the ClosedSlot receipt and
// SlotClosed event decoders, and the readers that must treat a closed slot as a finished loan, never an error.
import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import {
  CLOSED_SLOT_ACCOUNT_SIZE, CLOSED_SLOT_V2_SIZE, LOAN_ERROR, LOCALNET_LOAN_PROGRAM_ID, MAINNET_LOAN_PROGRAM_ID, MAINNET_SAFETY_POOL_PROGRAM_ID, SLOT_ACCOUNT_SIZE,
  SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, claimAmount, claimRoom, sweepSplit, closeSlotIx, closedSlotPda, closedSlots, decodeClosedSlot, isClosedSlotAccount, isSlotAccount,
  ledgerPda, loanStatus, reclaimableSlots, registryPda, returnExcessIx, safetyPoolFor, slotClosedEvents, slotInbox, slotPda, subrogationPda, sweepClosedIx,
} from '../../src/solana/lender.js';
import { LOCALNET_SAFETY_POOL_PROGRAM_ID, coverPda, encodeStreamSlot } from '../../src/solana/token.js';

const enc = (s: string) => new TextEncoder().encode(s);
const disc = (s: string) => sha256(enc(s)).subarray(0, 8);
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const LOAN = LOCALNET_LOAN_PROGRAM_ID;

function receiptData(o: { loanRef: bigint; lender: PublicKey; asset: PublicKey; principal: bigint; repaid: bigint; payoutTo?: PublicKey }): Buffer {
  return Buffer.concat([
    disc('account:ClosedSlot'), u64(o.loanRef), o.lender.toBuffer(), o.asset.toBuffer(), u64(o.principal), u64(o.repaid), Buffer.from([254, 253]),
    o.payoutTo ? o.payoutTo.toBuffer() : Buffer.alloc(0),
  ]);
}
function slotData(o: { loanRef: bigint; lender: PublicKey; funded: boolean; settled: boolean }): Buffer {
  return Buffer.concat([disc('account:Slot'), Buffer.from(encodeStreamSlot({
    loanRef: o.loanRef, lender: o.lender, bump: 255, funded: o.funded, settled: o.settled, asset: PublicKey.default, tokenProgram: SPL_TOKEN_PROGRAM_ID,
    principal: 10n, repaid: 10n, minRemaining: 1n, minRate: 1n, pledgeBps: 4000, expiry: 0n, agentPk: new Uint8Array(32), fundedAt: 0n,
    payoutTo: PublicKey.default, streamStart: 0n,
  })).subarray(8)]);
}
const registryData = (next: bigint) => Buffer.concat([disc('account:Registry'), u64(next), Buffer.from([255])]);
const acct = (data: Buffer, owner = LOAN, lamports = 1_000) => ({ data, owner, lamports, executable: false, rentEpoch: 0 });

describe('close_slot / sweep_closed instructions', () => {
  const lender = Keypair.generate().publicKey;
  const asset = Keypair.generate().publicKey;

  it('close_slot of a funded loan: accounts in program order, lender signs, data = discriminator + loan ref', () => {
    const ix = closeSlotIx(lender, 7n, { asset, tokenProgram: TOKEN_2022_PROGRAM_ID });
    expect(ix.programId.equals(LOAN)).toBe(true);
    const keys = ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]);
    expect(keys).toEqual([
      [slotPda(7n).toBase58(), false, true], [lender.toBase58(), true, true], [ledgerPda(7n, asset).toBase58(), false, true], [asset.toBase58(), false, true],
      [slotInbox(7n, asset, TOKEN_2022_PROGRAM_ID).toBase58(), false, true], [TOKEN_2022_PROGRAM_ID.toBase58(), false, false],
      [coverPda(LOCALNET_SAFETY_POOL_PROGRAM_ID, 7n).toBase58(), false, false], [closedSlotPda(7n).toBase58(), false, true], [SystemProgram.programId.toBase58(), false, false],
      [subrogationPda(7n).toBase58(), false, false],
    ]);
    expect(Buffer.from(ix.data)).toEqual(Buffer.concat([disc('global:close_slot'), u64(7n)]));
  });

  it('close_slot of a slot that never lent passes the receipt address for the unread loan accounts', () => {
    const ix = closeSlotIx(lender, 9n);
    const closed = closedSlotPda(9n);
    expect([2, 3, 4].map((i) => ix.keys[i].pubkey.equals(closed))).toEqual([true, true, true]);
    expect(ix.keys[5].pubkey.equals(SPL_TOKEN_PROGRAM_ID)).toBe(true);
  });

  it('the cover is the safety_pool of the stream_loan build; any other stream_loan must name it', () => {
    expect(safetyPoolFor(MAINNET_LOAN_PROGRAM_ID)!.equals(MAINNET_SAFETY_POOL_PROGRAM_ID)).toBe(true);
    const main = closeSlotIx(lender, 3n, { asset, tokenProgram: TOKEN_2022_PROGRAM_ID }, MAINNET_LOAN_PROGRAM_ID);
    expect(main.keys[6].pubkey.equals(coverPda(MAINNET_SAFETY_POOL_PROGRAM_ID, 3n))).toBe(true);
    const other = Keypair.generate().publicKey;
    expect(safetyPoolFor(other)).toBeUndefined();
    expect(() => closeSlotIx(lender, 3n, undefined, other)).toThrow(/safety_pool/);
    const safety = Keypair.generate().publicKey;
    expect(closeSlotIx(lender, 3n, undefined, other, safety).keys[6].pubkey.equals(coverPda(safety, 3n))).toBe(true);
  });

  it('sweep_closed: receipt (writable: the capped sweep records what it paid), lender (signer), slot PDA, mint, inbox, destination, token program, then the mint\'s Ledger (writable)', () => {
    const to = Keypair.generate().publicKey;
    const ix = sweepClosedIx(lender, 5n, asset, to, TOKEN_2022_PROGRAM_ID);
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [closedSlotPda(5n).toBase58(), false, true], [lender.toBase58(), true, true], [slotPda(5n).toBase58(), false, false], [asset.toBase58(), false, true],
      [slotInbox(5n, asset, TOKEN_2022_PROGRAM_ID).toBase58(), false, true], [to.toBase58(), false, true], [TOKEN_2022_PROGRAM_ID.toBase58(), false, false],
      [ledgerPda(5n, asset).toBase58(), false, true],
    ]);
    expect(Buffer.from(ix.data)).toEqual(Buffer.concat([disc('global:sweep_closed'), u64(5n)]));
  });

  it('return_excess: slot, receipt, ledger, mint, inbox, payout, destination, token program, then the optional owner signer', () => {
    const payout = Keypair.generate().publicKey;
    const to = Keypair.generate().publicKey;
    const ix = returnExcessIx(6n, asset, payout, to, TOKEN_2022_PROGRAM_ID);
    expect(ix.programId.equals(LOAN)).toBe(true);
    const keys = [
      [slotPda(6n).toBase58(), false, false], [closedSlotPda(6n).toBase58(), false, false], [ledgerPda(6n, asset).toBase58(), false, false],
      [asset.toBase58(), false, false], [slotInbox(6n, asset, TOKEN_2022_PROGRAM_ID).toBase58(), false, true], [payout.toBase58(), false, false],
      [to.toBase58(), false, true], [TOKEN_2022_PROGRAM_ID.toBase58(), false, false],
    ];
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual(keys);
    expect(Buffer.from(ix.data)).toEqual(Buffer.concat([disc('global:return_excess'), u64(6n)]));
    const owner = Keypair.generate().publicKey;
    const signed = returnExcessIx(6n, asset, payout, to, TOKEN_2022_PROGRAM_ID, LOAN, owner);
    expect(signed.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([...keys, [owner.toBase58(), true, false]]);
  });

  it('claimRoom: what a claim may still take (the program check), and the new error codes are appended', () => {
    expect(claimRoom({ principal: 20n, repaid: 0n }, 0n, 0n)).toBe(20n);
    expect(claimRoom({ principal: 20n, repaid: 5n }, 3n, 2n)).toBe(10n);
    expect(claimRoom({ principal: 20n, repaid: 20n }, 0n, 0n)).toBe(0n);
    expect(claimRoom({ principal: 20n, repaid: 35n }, 0n, 0n)).toBe(0n);
    expect(claimRoom({ principal: 20n, repaid: 5n }, 40n, 0n)).toBe(0n);
    expect([LOAN_ERROR.SubrogationOpen, LOAN_ERROR.LoanRepaid, LOAN_ERROR.ClaimTooLarge, LOAN_ERROR.NoExcess, LOAN_ERROR.PayoutCannotReceive,
      LOAN_ERROR.LegacyReceiptNoPayout, LOAN_ERROR.ReceiptNotWritable]).toEqual([6033, 6034, 6035, 6036, 6037, 6038, 6039]);
  });

  it('claimAmount (prepareClaim): everything vested clamped at what is owed; an explicit amount above it, or nothing owed, throws', () => {
    // the bug repro: 40 vested on a 20 loan -> the default claim asks for 20
    expect(claimAmount(40n, 20n, undefined, 1n)).toBe(20n);
    expect(claimAmount(7n, 20n, undefined, 1n)).toBe(7n);
    expect(claimAmount(40n, 20n, 20n, 1n)).toBe(20n);
    expect(claimAmount(40n, 20n, 5n, 1n)).toBe(5n);
    expect(() => claimAmount(40n, 20n, 21n, 1n)).toThrow(/more than loan 1 still owes \(20\)/);
    expect(() => claimAmount(40n, 0n, undefined, 1n, true)).toThrow(/is repaid/);
    // not repaid, but the unsynced inbox / escrow already covers the rest
    expect(() => claimAmount(40n, 0n, undefined, 1n, false)).toThrow(/already on its way/);
    // no cap (another mint, or the tests-only uncapped bypass): the vested amount or the explicit one, unchecked
    expect(claimAmount(40n, undefined, undefined, 1n)).toBe(40n);
    expect(claimAmount(40n, undefined, 99n, 1n)).toBe(99n);
    expect(() => claimAmount(0n, 20n, undefined, 1n)).toThrow(/nothing claimable/);
    expect(() => claimAmount(0n, undefined, undefined, 1n)).toThrow(/nothing claimable/);
  });

  it('sweepSplit (sweep_closed): what the Ledger held for the lender first, then up to the room; the rest is the borrower\'s', () => {
    expect(sweepSplit(10n, 0n, 4n)).toEqual({ fromHeld: 0n, fromRoom: 4n });
    expect(sweepSplit(10n, 3n, 0n)).toEqual({ fromHeld: 3n, fromRoom: 0n });
    expect(sweepSplit(10n, 3n, 100n)).toEqual({ fromHeld: 3n, fromRoom: 7n });
    expect(sweepSplit(2n, 3n, 100n)).toEqual({ fromHeld: 2n, fromRoom: 0n });
  });

  it('the receipt PDA is ["closed", loan_ref] and differs from the slot', () => {
    expect(closedSlotPda(1n).equals(PublicKey.findProgramAddressSync([enc('closed'), u64(1n)], LOAN)[0])).toBe(true);
    expect(closedSlotPda(1n).equals(slotPda(1n))).toBe(false);
  });
});

describe('receipt and event decoders', () => {
  const lender = Keypair.generate().publicKey;
  const asset = Keypair.generate().publicKey;

  it('decodes a ClosedSlot receipt and refuses anything else', () => {
    const d = receiptData({ loanRef: 42n, lender, asset, principal: 300n, repaid: 301n });
    expect(d.length).toBe(CLOSED_SLOT_ACCOUNT_SIZE);
    expect(isClosedSlotAccount(d)).toBe(true);
    expect(isSlotAccount(d)).toBe(false);
    const r = decodeClosedSlot(d);
    expect([r.loanRef, r.principal, r.repaid, r.slotBump, r.bump]).toEqual([42n, 300n, 301n, 254, 253]);
    expect(r.lender.equals(lender) && r.asset.equals(asset)).toBe(true);
    // lender at offset 16, as in Slot (one memcmp finds both)
    expect(new PublicKey(d.subarray(16, 48)).equals(lender)).toBe(true);
    expect(() => decodeClosedSlot(slotData({ loanRef: 1n, lender, funded: true, settled: true }))).toThrow();
    expect(slotData({ loanRef: 1n, lender, funded: true, settled: true }).length).toBe(SLOT_ACCOUNT_SIZE);
    // an older receipt records no payout account
    expect(r.payoutTo).toBeUndefined();
  });

  it('decodes a v2 receipt (130 bytes): the same figures, then the borrower payout account', () => {
    const payoutTo = Keypair.generate().publicKey;
    const d = receiptData({ loanRef: 43n, lender, asset, principal: 20n, repaid: 20n, payoutTo });
    expect(d.length).toBe(CLOSED_SLOT_V2_SIZE);
    expect(CLOSED_SLOT_V2_SIZE).toBe(130);
    const r = decodeClosedSlot(d);
    expect([r.loanRef, r.principal, r.repaid, r.slotBump, r.bump]).toEqual([43n, 20n, 20n, 254, 253]);
    expect(r.payoutTo?.equals(payoutTo)).toBe(true);
  });

  it('reads SlotClosed events from transaction logs', () => {
    const agentPk = Buffer.alloc(32); agentPk[31] = 9;
    const body = Buffer.concat([disc('event:SlotClosed'), u64(11n), lender.toBuffer(), u64(4_600_000n), Buffer.from([1]), asset.toBuffer(), u64(50n), u64(51n), agentPk, u64(99n)]);
    const evs = slotClosedEvents(['Program log: x', `Program data: ${body.toString('base64')}`, `Program data: ${Buffer.alloc(40).toString('base64')}`]);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ loanRef: 11n, lamportsRefunded: 4_600_000n, funded: true, principal: 50n, repaid: 51n, agentPk: 9n, expiry: 99n });
  });
});

describe('readers: a closed slot is a finished loan', () => {
  const lender = Keypair.generate().publicKey;
  const asset = Keypair.generate().publicKey;
  /** getMultipleAccountsInfo over a fixed address book. */
  const conn = (book: Map<string, ReturnType<typeof acct>>) => ({
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => book.get(k.toBase58()) ?? null),
  }) as never;

  it('loanStatus: open, closed with its receipt, closed without one (never lent), never opened', async () => {
    const book = new Map<string, ReturnType<typeof acct>>([[registryPda().toBase58(), acct(registryData(10n))]]);
    book.set(slotPda(2n).toBase58(), acct(slotData({ loanRef: 2n, lender, funded: true, settled: false })));
    book.set(closedSlotPda(3n).toBase58(), acct(receiptData({ loanRef: 3n, lender, asset, principal: 5n, repaid: 6n })));
    const open = await loanStatus(conn(book), 2n);
    expect(open.state === 'open' && open.slot.funded).toBe(true);
    const closed = await loanStatus(conn(book), 3n);
    expect(closed.state === 'closed' && closed.receipt?.repaid).toBe(6n);
    expect(await loanStatus(conn(book), 4n)).toEqual({ state: 'closed' });
    expect(await loanStatus(conn(book), 10n)).toEqual({ state: 'none' });
    expect(await loanStatus(conn(book), 0n)).toEqual({ state: 'none' });
    // a system-owned leftover at the slot address (lamports sent after the close) is not a slot
    book.set(slotPda(3n).toBase58(), acct(Buffer.alloc(0), SystemProgram.programId));
    expect((await loanStatus(conn(book), 3n)).state).toBe('closed');
  });

  it('reclaimableSlots lists settled loans (and unfunded slots on request) with one filtered getProgramAccounts', async () => {
    const calls: unknown[] = [];
    const rows = [
      { loanRef: 1n, funded: true, settled: true }, { loanRef: 2n, funded: true, settled: false }, { loanRef: 3n, funded: false, settled: false },
    ].map((r) => ({ pubkey: slotPda(r.loanRef), account: acct(slotData({ ...r, lender }), LOAN, 2_651_760) }));
    const c = { getProgramAccounts: async (_p: PublicKey, cfg: unknown) => { calls.push(cfg); return rows; } } as never;
    expect((await reclaimableSlots(c, lender)).map((x) => [x.loanRef, x.reason, x.lamports])).toEqual([[1n, 'settled', 2_651_760]]);
    expect((await reclaimableSlots(c, lender, LOAN, { includeUnfunded: true })).map((x) => x.reason)).toEqual(['settled', 'unfunded']);
    expect(calls[0]).toEqual({ commitment: 'confirmed', filters: [{ dataSize: SLOT_ACCOUNT_SIZE }, { memcmp: { offset: 16, bytes: lender.toBase58() } }] });
    // someone else's slot that slipped through is never listed
    const other = { getProgramAccounts: async () => [{ pubkey: slotPda(8n), account: acct(slotData({ loanRef: 8n, lender: asset, funded: true, settled: true })) }] } as never;
    expect(await reclaimableSlots(other, lender)).toEqual([]);
  });

  it('closedSlots lists the lender\'s receipts of both sizes (discriminator + lender filter, no size filter)', async () => {
    const payoutTo = Keypair.generate().publicKey;
    const c = {
      getProgramAccounts: async (_p: PublicKey, cfg: { filters: Array<{ dataSize?: number; memcmp?: { offset: number; bytes: string; encoding?: string } }> }) => {
        expect(cfg.filters.some((f) => f.dataSize !== undefined)).toBe(false);
        expect(cfg.filters[0].memcmp).toEqual({ offset: 0, bytes: disc('account:ClosedSlot').length && Buffer.from(disc('account:ClosedSlot')).toString('base64'), encoding: 'base64' });
        expect(cfg.filters[1].memcmp).toEqual({ offset: 16, bytes: lender.toBase58() });
        return [
          { pubkey: closedSlotPda(5n), account: acct(receiptData({ loanRef: 5n, lender, asset, principal: 1n, repaid: 1n, payoutTo })) },
          { pubkey: closedSlotPda(4n), account: acct(receiptData({ loanRef: 4n, lender, asset, principal: 1n, repaid: 1n })) },
        ];
      },
    } as never;
    const got = await closedSlots(c, lender);
    expect(got.map((r) => r.loanRef)).toEqual([4n, 5n]);
    expect(got[0].payoutTo).toBeUndefined();
    expect(got[1].payoutTo?.equals(payoutTo)).toBe(true);
  });
});
