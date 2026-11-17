// Backed lines: the SDK's pure parts (no validator). The math vectors are shared with the program's Rust tests.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  BACKER_ERROR, BACKING_ACCOUNT_SIZE, DEFAULT_MAX_LENDER_FEE_BPS, DRAW_ACCOUNT_SIZE, FULL_COVER_BPS, backedFundTerms, backedTermsDigest, LOCALNET_LOAN_FAST_PROGRAM_ID, backClaimIx, backOpenIx, backRequestIx, backSettleIx,
  backWithdrawIx, backedClaimAmount, backedTerms, backerKeyFor, backerTimes, backingPda, backingVault, checkLineTerms, decodeBacking, decodeDraw, drawKeyFor, drawPda,
  fundBackedIx, isBackedSlot, lineCapacity, releaseReason, routingDone, SUBROGATION_LABEL, backedLenderPosition, subrogationKindOf, subrogationKinds,
} from '../../src/solana/backer.js';
import { LOAN_ERROR, LOCALNET_LOAN_PROGRAM_ID, MAINNET_LOAN_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, loanStatus, slotPda, subrogationPda } from '../../src/solana/lender.js';

const V = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'data', 'backer-vectors.json'), 'utf8'));
const disc = (s: string) => createHash('sha256').update(s).digest().subarray(0, 8);

describe('backed-line math (shared vectors with backer.rs)', () => {
  it('terms: fees round down, the reserve rounds up', () => {
    for (const t of V.terms) {
      const r = backedTerms({ advance: BigInt(t.advance), feeBps: t.feeBps, lenderFeeBps: t.lenderFeeBps, coverBps: t.coverBps });
      expect([r.backerFee, r.lenderFee, r.principal, r.reserve]).toEqual([BigInt(t.backerFee), BigInt(t.lenderFee), BigInt(t.principal), BigInt(t.reserve)]);
      expect(r.lenderDue).toBe(r.principal - r.backerFee);
      expect(r.toPayout).toBe(BigInt(t.advance) - r.originationFee);
    }
    const w = backedTerms({ advance: 500_000_000n, feeBps: 500, lenderFeeBps: 300, coverBps: 2000 });
    expect(w.uncovered).toBe(w.lenderDue - w.reserve);
  });
  it('claim amount table', () => {
    for (const c of V.claim) {
      expect(backedClaimAmount(BigInt(c.principal), BigInt(c.backerFee), BigInt(c.repaid), BigInt(c.subPaid), BigInt(c.reserve), BigInt(c.vault))).toBe(BigInt(c.pay));
    }
  });
  it('release reasons and routing', () => {
    for (const r of V.release) {
      expect(releaseReason({ slotClosed: r.slotClosed, repaid: BigInt(r.repaid), principal: BigInt(r.principal), settled: r.settled, expiry: BigInt(r.expiry) }, BigInt(r.now))).toBe(r.reason);
    }
    expect(routingDone(false, 9n, 10n, 4n, 5n)).toBe(false);
    expect(routingDone(false, 0n, 10n, 5n, 5n)).toBe(true);
    expect(backerTimes(LOCALNET_LOAN_FAST_PROGRAM_ID).grace).toBe(2n);
    expect(backerTimes(LOCALNET_LOAN_PROGRAM_ID).claimWindow).toBe(30n * 86_400n);
    expect(lineCapacity(1000n, 300n, 5000)).toEqual({ free: 700n, capacity: 1400n });
    expect(lineCapacity(100n, 300n, 10_000)).toEqual({ free: 0n, capacity: 0n });
  });
  it('the SDK refuses partial cover and high fees unless asked', () => {
    expect(checkLineTerms({ coverBps: FULL_COVER_BPS, feeBps: 500, lenderFeeBps: 300 })).toEqual([]);
    expect(() => checkLineTerms({ coverBps: 5000, feeBps: 0 })).toThrow(/below 100%/);
    expect(checkLineTerms({ coverBps: 5000, feeBps: 0 }, { allowPartialCover: true })[0]).toMatch(/unsecured/);
    expect(() => checkLineTerms({ coverBps: 10_000, feeBps: 800, lenderFeeBps: 500 })).toThrow(/above 10%/);
    expect(() => checkLineTerms({ coverBps: 1999, feeBps: 0 }, { allowPartialCover: true })).toThrow();
    expect(() => checkLineTerms({ coverBps: 10_000, feeBps: 2001 })).toThrow();
    // the line's lender-fee cap
    expect(DEFAULT_MAX_LENDER_FEE_BPS).toBe(500);
    expect(checkLineTerms({ coverBps: 10_000, feeBps: 0, lenderFeeBps: 500, maxLenderFeeBps: 500 })).toEqual([]);
    expect(() => checkLineTerms({ coverBps: 10_000, feeBps: 0, lenderFeeBps: 501, maxLenderFeeBps: 500 })).toThrow(/above this line's cap/);
    expect(() => checkLineTerms({ coverBps: 10_000, feeBps: 0, maxLenderFeeBps: 2001 })).toThrow(/cap must be/);
  });
  it('the fund-terms digest changes with every term a lender is shown', () => {
    const backing = Keypair.generate().publicKey, payoutTo = Keypair.generate().publicKey;
    const t = backedFundTerms({ advance: 500n, backerFee: 25n, lenderFee: 15n, term: 86_400n, payoutTo }, { coverBps: 10_000 });
    expect(t).toEqual({ advance: 500n, principal: 540n, term: 86_400n, payoutTo, coverBps: 10_000 });
    const d = backedTermsDigest(backing, 3n, t);
    expect(d).toMatch(/^[0-9a-f]{16}$/);
    expect(backedTermsDigest(backing, 3n, { ...t })).toBe(d);
    for (const other of [
      backedTermsDigest(backing, 4n, t), backedTermsDigest(Keypair.generate().publicKey, 3n, t), backedTermsDigest(backing, 3n, { ...t, term: 86_401n }),
      backedTermsDigest(backing, 3n, { ...t, principal: 541n }), backedTermsDigest(backing, 3n, { ...t, advance: 501n }),
      backedTermsDigest(backing, 3n, { ...t, payoutTo: Keypair.generate().publicKey }), backedTermsDigest(backing, 3n, { ...t, coverBps: 9_999 }),
    ]) expect(other).not.toBe(d);
  });
});

describe('per-line keys', () => {
  it('are deterministic, distinct per nonce and per role', () => {
    const sk = 123456789n;
    expect(backerKeyFor(sk, 1n).publicKey.equals(backerKeyFor(sk, 1n).publicKey)).toBe(true);
    expect(backerKeyFor(sk, 1n).publicKey.equals(backerKeyFor(sk, 2n).publicKey)).toBe(false);
    expect(backerKeyFor(sk, 1n).publicKey.equals(drawKeyFor(sk, 1n).publicKey)).toBe(false);
    expect(drawKeyFor(sk, 1n).publicKey.equals(drawKeyFor(sk + 1n, 1n).publicKey)).toBe(false);
    // the seed is sha256("h081/backer/v1" | be32(sk) | le64(nonce))
    const seed = createHash('sha256').update(Buffer.concat([Buffer.from('h081/backer/v1'), Buffer.from(sk.toString(16).padStart(64, '0'), 'hex'), Buffer.from([7, 0, 0, 0, 0, 0, 0, 0])])).digest();
    expect(backerKeyFor(sk, 7n).publicKey.equals(Keypair.fromSeed(seed).publicKey)).toBe(true);
  });
});

describe('instructions and accounts', () => {
  const backer = Keypair.generate().publicKey, mint = Keypair.generate().publicKey, payer = Keypair.generate().publicKey, dk = Keypair.generate().publicKey;
  const backing = backingPda(backer, 3n);
  it('encode the program\'s argument layouts', () => {
    const open = backOpenIx(backer, payer, mint, { nonce: 3n, coverBps: 10_000, feeBps: 500, expiry: 99n, drawKey: dk, maxAdvance: 1n, maxTotal: 2n, cosign: true });
    expect(open.data.length).toBe(8 + 8 + 2 + 2 + 2 + 8 + 32 + 32 + 8 + 8 + 1);
    expect(Buffer.from(open.data).readUInt16LE(8 + 8 + 2 + 2)).toBe(DEFAULT_MAX_LENDER_FEE_BPS); // max_lender_fee_bps follows fee_bps
    expect(Buffer.from(backOpenIx(backer, payer, mint, { nonce: 3n, coverBps: 10_000, feeBps: 500, maxLenderFeeBps: 120, expiry: 99n, drawKey: dk, maxAdvance: 1n, maxTotal: 2n }).data).readUInt16LE(20)).toBe(120);
    expect(Buffer.from(open.data.subarray(0, 8)).equals(disc('global:back_open'))).toBe(true);
    expect(open.keys[0].pubkey.equals(backing)).toBe(true);
    expect(open.keys[4].pubkey.equals(backingVault(backing, mint))).toBe(true);
    const req = backRequestIx({ backing, backer, asset: mint, tokenProgram: SPL_TOKEN_PROGRAM_ID }, dk, payer, { loanRef: 5n, advance: 10n, lenderFeeBps: 1, term: 2n, fundBy: 3n, payoutTo: payer });
    expect(req.data.length).toBe(8 + 8 + 8 + 2 + 8 + 8);
    expect(req.keys[1].pubkey.equals(drawPda(backing, 5n))).toBe(true);
    expect(req.keys[4].isSigner).toBe(false);
    expect(req.keys.length).toBe(10);
    expect(req.keys[9].pubkey.equals(mint)).toBe(true); // the asset, for the transfer-fee check
    const fund = fundBackedIx({ lender: payer, loanRef: 5n, backing, mint, tokenProgram: SPL_TOKEN_PROGRAM_ID, lenderSource: payer, expect: { advance: 1n, principal: 2n, term: 3n, payoutTo: dk, coverBps: 10_000, minCoverBps: 10_000 } });
    expect(fund.data.length).toBe(8 + 8 + 8 + 8 + 8 + 32 + 2 + 2);
    expect(fund.keys.length).toBe(16);
    expect(fund.keys[15].pubkey.equals(subrogationPda(5n))).toBe(true);
    const claim = backClaimIx(5n, backing, { lender: payer, asset: mint, tokenProgram: SPL_TOKEN_PROGRAM_ID });
    expect(claim.keys[0].pubkey.equals(slotPda(5n))).toBe(true);
    expect(backSettleIx(5n, backing, { asset: mint, tokenProgram: SPL_TOKEN_PROGRAM_ID }, backer, payer, true).data.at(-1)).toBe(1);
    expect(backWithdrawIx(backing, backer, { asset: mint, tokenProgram: SPL_TOKEN_PROGRAM_ID, payer }, payer, 0n, true).data.length).toBe(8 + 8 + 1);
  });
  it('decode Backing and Draw at their sizes', () => {
    const b = Buffer.alloc(BACKING_ACCOUNT_SIZE);
    disc('account:Backing').copy(b, 0);
    backer.toBuffer().copy(b, 8); dk.toBuffer().copy(b, 40); mint.toBuffer().copy(b, 104);
    let o = 8 + 32 * 6; b.writeBigUInt64LE(3n, o); o += 8; b.writeUInt16LE(10_000, o); o += 2; b.writeUInt16LE(500, o); o += 2; b.writeUInt16LE(300, o); o += 2; b.writeBigUInt64LE(77n, o); o += 8;
    o += 8 * 3; b.writeBigUInt64LE(515n, o); o += 8; b.writeUInt16LE(2, o);
    const l = decodeBacking(b);
    expect([l.backer.equals(backer), l.drawKey.equals(dk), l.asset.equals(mint), l.nonce, l.coverBps, l.feeBps, l.maxLenderFeeBps, l.expiry, l.reserved, l.openDraws]).toEqual([true, true, true, 3n, 10_000, 500, 300, 77n, 515n, 2]);
    expect(BACKING_ACCOUNT_SIZE).toBe(278);
    const d = Buffer.alloc(DRAW_ACCOUNT_SIZE);
    disc('account:Draw').copy(d, 0); d.writeBigUInt64LE(9n, 8); backing.toBuffer().copy(d, 16); d[DRAW_ACCOUNT_SIZE - 2] = 2;
    const dr = decodeDraw(d);
    expect([dr.loanRef, dr.backing.equals(backing), dr.state]).toEqual([9n, true, 'claimed']);
    expect(() => decodeDraw(b)).toThrow();
  });
  it('a backed slot has no pledge; error codes are appended after ReceiptNotWritable', () => {
    expect(isBackedSlot({ funded: true, pledgeBps: 0n })).toBe(true);
    expect(isBackedSlot({ funded: true, pledgeBps: 4000n })).toBe(false);
    expect(isBackedSlot({ funded: false, pledgeBps: 0n })).toBe(false);
    expect(BACKER_ERROR.BackingTerms).toBe(LOAN_ERROR.ReceiptNotWritable + 1);
    expect(BACKER_ERROR.BadVault).toBe(6057);
    for (const [k, v] of Object.entries(BACKER_ERROR)) expect((LOAN_ERROR as Record<string, number>)[k]).toBe(v);
    expect(LOCALNET_LOAN_FAST_PROGRAM_ID.equals(MAINNET_LOAN_PROGRAM_ID)).toBe(false);
  });
  it('loanStatus marks a backed slot', async () => {
    const data = Buffer.alloc(253);
    disc('account:Slot').copy(data, 0);
    data[8 + 8 + 32 + 1] = 1; // funded; pledge_bps stays 0
    const fake = { getMultipleAccountsInfo: async () => [{ owner: LOCALNET_LOAN_PROGRAM_ID, data }, null, null] } as never;
    const st = await loanStatus(fake, 1n);
    expect(st.state === 'open' && st.backed).toBe(true);
    void PublicKey;
  });
});

// docs/BACKER-SPEC.md section 16: readers call a backed loan's Subrogation the backer's fee and recovery, never a slash
describe('readers: Subrogation kind and the lender\'s position on a backed loan', () => {
  const P = LOCALNET_LOAN_PROGRAM_ID;
  const backingData = Buffer.concat([disc('account:Backing'), Buffer.alloc(BACKING_ACCOUNT_SIZE - 8)]);
  it('a Backing owned by stream_loan, or a backed slot (pledge 0), makes it the backer\'s; anything else is a slash', async () => {
    expect(SUBROGATION_LABEL).toEqual({ backer: 'backer fee / recovery', slash: 'safety-pool slash recovery' });
    expect(subrogationKindOf({ owner: P, data: backingData }, P)).toBe('backer');
    expect(subrogationKindOf({ owner: Keypair.generate().publicKey, data: backingData }, P)).toBe('slash'); // a look-alike owned elsewhere
    expect(subrogationKindOf({ owner: P, data: Buffer.alloc(BACKING_ACCOUNT_SIZE) }, P)).toBe('slash');
    expect(subrogationKindOf(null, P)).toBe('slash');
    expect(subrogationKindOf(null, P, { funded: true, pledgeBps: 0n })).toBe('backer');
    expect(subrogationKindOf(null, P, { funded: true, pledgeBps: 4000n })).toBe('slash');
    // batched: one getMultipleAccountsInfo per 100 Subrogations, in order
    const cfgs = Array.from({ length: 150 }, () => Keypair.generate().publicKey);
    const subs = cfgs.map((safetyConfig, i) => ({ loanRef: BigInt(i), safetyConfig, to: safetyConfig, owed: 1n, paid: 0n }));
    let calls = 0;
    const conn = { getMultipleAccountsInfo: async (ks: PublicKey[]) => { calls++; expect(ks.length).toBeLessThanOrEqual(100); return ks.map((k) => (cfgs.indexOf(k) % 2 === 0 ? { owner: P, data: backingData } : null)); } };
    const kinds = await subrogationKinds(conn as never, subs, P);
    expect(calls).toBe(2);
    expect(kinds.filter((k) => k === 'backer')).toHaveLength(75);
    expect(kinds[0]).toBe('backer');
    expect(kinds[1]).toBe('slash');
  });

  it('the lender\'s position: fee first, then the lender; its shortfall nets the cover paid; nothing before expiry + grace', () => {
    // advance 500, fee 25, lender fee 15: principal 540, lender due 515
    const slot = { loanRef: 1n, lender: PublicKey.default, funded: true, settled: false, asset: PublicKey.default, tokenProgram: PublicKey.default, principal: 540n, repaid: 10n, minRemaining: 0n, minRate: 0n, pledgeBps: 0n, expiry: 1_000n, agentPk: 0n, fundedAt: 0n, payoutTo: PublicKey.default, streamStart: 0n, bump: 255 };
    const draw = { backerFee: 25n, claimed: 0n };
    expect(backedLenderPosition(slot, { owed: 25n, paid: 10n }, draw, 1_001n, 0n, 2n)).toEqual({ lenderDue: 515n, backerFee: 25n, toBacker: 10n, toLender: 0n, coverPaid: 0n, lenderShortfall: 0n, drawClosed: false });
    // after expiry + grace: the lender is short its whole due; 30 unsynced in the inbox would pay the fee's last 15 first
    expect(backedLenderPosition(slot, { owed: 25n, paid: 10n }, draw, 1_003n, 0n, 2n).lenderShortfall).toBe(515n);
    expect(backedLenderPosition(slot, { owed: 25n, paid: 10n }, draw, 1_003n, 30n, 2n)).toMatchObject({ toBacker: 25n, toLender: 15n, lenderShortfall: 500n });
    // the claim paid 515 (owed = paid + payout): nothing short; recoveries go to the backer, not the lender
    const claimed = backedLenderPosition({ ...slot, repaid: 110n }, { owed: 525n, paid: 110n }, { backerFee: 25n, claimed: 515n }, 1_003n, 0n, 2n);
    expect(claimed).toMatchObject({ toBacker: 110n, toLender: 0n, coverPaid: 515n, lenderShortfall: 0n });
    // 20% cover: the lender keeps the uncovered rest as its shortfall
    expect(backedLenderPosition(slot, { owed: 113n, paid: 10n }, { backerFee: 25n, claimed: 103n }, 1_003n, 0n, 2n).lenderShortfall).toBe(412n);
    // settled: no shortfall
    expect(backedLenderPosition({ ...slot, settled: true }, { owed: 25n, paid: 10n }, draw, 1_003n, 0n, 2n).lenderShortfall).toBe(0n);
    expect(backedLenderPosition(slot, { owed: 25n, paid: 10n }, draw, 1_003n, 0n, 2n).drawClosed).toBe(false);
    // claimed, then the Draw closed at the recovery horizon (owed cut to paid): the fee and the cover paid are gone from
    // chain, so nothing is guessed (a guess from owed would call a lender paid 3 + 100 of 103 short by 90)
    const closed = backedLenderPosition({ ...slot, principal: 108n, repaid: 18n }, { owed: 15n, paid: 15n }, undefined, 1_003n, 0n, 2n);
    expect(closed).toEqual({ lenderDue: null, backerFee: null, toBacker: 15n, toLender: 3n, coverPaid: null, lenderShortfall: null, drawClosed: true });
    expect(backedLenderPosition({ ...slot, repaid: 540n }, { owed: 25n, paid: 25n }, undefined, 1_003n, 0n, 2n)).toMatchObject({ toLender: 515n, lenderShortfall: null, drawClosed: true });
  });
});
