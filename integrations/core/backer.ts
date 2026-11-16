// Backed lines for the H081 agent (docs/BACKER-SPEC.md): the bank side of src/solana/backer.ts. H081Bank delegates
// backOpen / backStake / ... here. Every write returns the plan and sends nothing unless `confirm: true`.
//
// Keys: the backer acts through backerKeyFor(account sk, nonce), the borrower through drawKeyFor(account sk, lineNonce):
// fresh keys per line, re-derivable from the agent key. The agent wallet pays every fee and rent (there is no
// sponsored fee payer for stream_loan), so the chain links each line key to the agent wallet that funded the fee.
// The plans say so; they never claim the backer or the borrower is hidden.
import { Keypair, PublicKey, TransactionInstruction, type Connection } from '@solana/web3.js';
import { send } from '../../src/solana/buffer.js';
import {
  BACKER_ERROR, DEFAULT_MAX_LENDER_FEE_BPS, FULL_COVER_BPS, MAX_DRAW, backedFundTerms, backedTermsDigest, MIN_ADVANCE, SolanaBackedBorrower, SolanaBacker, type BackingAccount, backedLoanView, backedTerms, backerKeyFor, backingPda,
  backingStatus, backingVault, backSettleIx, checkLineTerms, claimBacked, decodeBacking, decodeDraw, drawKeyFor, drawPda, fundBacked, isBackingAccount, minCoverFor,
} from '../../src/solana/backer.js';
import { associatedTokenAddress, decodeSlot, slotPda } from '../../src/solana/lender.js';
import { createAtaIdempotentIx } from '../../src/solana/token.js';
import { type CodeContext, decodeBackingCode, decodeDrawKeyCode, encodeBackingCode, encodeDrawKeyCode } from './codes.js';
import type { H081Config } from './constants.js';
import { fromUnits } from './units.js';

/** What the backer operations need from the bank. */
export interface BackerHost {
  readonly connection: Connection;
  readonly signer: Keypair;
  readonly config: H081Config;
  readonly usdg: PublicKey;
  readonly decimals: number;
  readonly account: { keys: { sk: bigint } };
  readonly loanCodeContext: CodeContext;
  tokenProgram(): Promise<PublicKey>;
  walletUsdgAccount(): Promise<PublicKey>;
  /** a shielded withdraw from the main balance to `recipient` (an off-curve PDA allowed) */
  shieldedWithdrawTo(amount: bigint, recipient: PublicKey): Promise<{ signature?: string } | unknown>;
}

export interface BackPlan { sent: false; dryRun: true; plan: Record<string, unknown>; next: string }
const plan = (p: Record<string, unknown>, next: string): BackPlan => ({ sent: false, dryRun: true, plan: p, next: `nothing was sent. ${next}` });

/** The privacy note every backed-line plan carries: honest about what links. */
export const BACKED_PRIVACY =
  'fresh per-line keys act for the backer and the borrower, but the agent wallet pays their fees and rent, so the chain links each line to it; ' +
  'stake size, line terms, the advance, the lender and any default are public, like every loan';

const LINE_SCAN = 16n;

export class BackerOps {
  constructor(private readonly h: BackerHost) {}

  private get programId(): PublicKey { return this.h.config.loanProgramId; }
  private u(x: bigint): string { return `${fromUnits(x, this.h.decimals)} USDG`; }
  private backer(nonce: bigint): SolanaBacker {
    return new SolanaBacker(this.h.connection, backerKeyFor(this.h.account.keys.sk, nonce), nonce, this.h.signer, this.programId);
  }
  private drawKey(lineNonce: bigint): Keypair { return drawKeyFor(this.h.account.keys.sk, lineNonce); }
  private async line(backing: PublicKey): Promise<BackingAccount> {
    const info = await this.h.connection.getAccountInfo(backing, 'confirmed');
    if (!info || !info.owner.equals(this.programId) || !isBackingAccount(info.data)) throw new Error(`backing ${backing.toBase58()} does not exist on chain (or was closed). Nothing was sent.`);
    const l = decodeBacking(info.data);
    if (!l.asset.equals(this.h.usdg)) throw new Error('that line backs another asset than this bank\'s USDG. Nothing was sent.');
    return l;
  }
  private async now(): Promise<bigint> {
    const t = await this.h.connection.getBlockTime(await this.h.connection.getSlot('confirmed'));
    return BigInt(t ?? Math.floor(Date.now() / 1000));
  }

  // ---------------------------------------------------------------- backer

  /** The borrower's draw-key code for line `lineNonce` (read-only, offline): what a backer needs to open a line for it. */
  drawKeyCode(lineNonce: bigint): { drawKey: string; payoutTo: string; drawKeyCode: string; lineNonce: bigint; next: string } {
    const k = this.drawKey(lineNonce);
    const payoutTo = associatedTokenAddress(k.publicKey, this.h.usdg, this.tokenProgramSync());
    return {
      drawKey: k.publicKey.toBase58(), payoutTo: payoutTo.toBase58(), lineNonce,
      drawKeyCode: encodeDrawKeyCode(this.h.loanCodeContext, { drawKey: k.publicKey, payoutTo }),
      next: 'hand drawKeyCode to a backer (h081_back action "open"); it returns an "h081-backing:" code you request draws with (h081_back_draw action "request")',
    };
  }
  private tp?: PublicKey;
  private tokenProgramSync(): PublicKey {
    if (!this.tp) throw new Error('call prepare() first');
    return this.tp;
  }
  async prepare(): Promise<this> { this.tp ??= await this.h.tokenProgram(); return this; }

  async open(req: {
    nonce?: bigint; drawKeyCode: string; coverBps?: number; feeBps: number; maxLenderFeeBps?: number; days: number; maxAdvance: bigint; maxTotal?: bigint; lender?: PublicKey; cosign?: boolean;
    allowPartialCover?: boolean; confirm?: boolean;
  }) {
    const dk = decodeDrawKeyCode(this.h.loanCodeContext, req.drawKeyCode);
    const coverBps = req.coverBps ?? FULL_COVER_BPS;
    if (coverBps < minCoverFor(this.programId)) throw new Error(`cover must be at least ${minCoverFor(this.programId) / 100}% on this network. Nothing was sent.`);
    const maxLenderFeeBps = req.maxLenderFeeBps ?? DEFAULT_MAX_LENDER_FEE_BPS;
    const warnings = checkLineTerms({ coverBps, feeBps: req.feeBps, maxLenderFeeBps }, { allowPartialCover: req.allowPartialCover, allowHighFees: true });
    if (!(req.days >= 1 && req.days <= 180)) throw new Error('days must be 1..180 (the line\'s life). Nothing was sent.');
    if (req.maxAdvance < MIN_ADVANCE || req.maxAdvance > MAX_DRAW) throw new Error(`maxAdvance must be ${this.u(MIN_ADVANCE)}..${this.u(MAX_DRAW)}. Nothing was sent.`);
    const maxTotal = req.maxTotal ?? req.maxAdvance;
    if (maxTotal < req.maxAdvance) throw new Error('maxTotal must be at least maxAdvance. Nothing was sent.');
    const nonce = req.nonce ?? (await this.freeNonce());
    const b = this.backer(nonce);
    if (await this.h.connection.getAccountInfo(b.backing, 'confirmed')) throw new Error(`line #${nonce} already exists (${b.backing.toBase58()}); pick another nonce. Nothing was sent.`);
    const expiry = (await this.now()) + BigInt(Math.round(req.days * 86_400));
    const terms = {
      action: 'open', nonce, backing: b.backing.toBase58(), backerKey: b.key.publicKey.toBase58(), drawKey: dk.drawKey.toBase58(), coverBps, coverPercent: coverBps / 100,
      feeBps: req.feeBps, maxLenderFeeBps, expiry, maxAdvance: req.maxAdvance, maxAdvanceUsdg: fromUnits(req.maxAdvance, this.h.decimals), maxTotal, maxTotalUsdg: fromUnits(maxTotal, this.h.decimals),
      lenderPin: req.lender?.toBase58() ?? null, cosign: !!req.cosign, warnings, privacy: BACKED_PRIVACY,
      lenderFeeCap: `a request may offer its lender at most ${maxLenderFeeBps / 100}% of the advance; the stake covers that fee too`,
      selfFundingGuard: req.lender || req.cosign ? 'on: a lender pin or your co-sign is required for every draw'
        : 'off: without a lender pin or co-sign, the borrower could fund its own draw from a second wallet, default, and claim the stake (advance + lender fee); pin a lender or set cosign if that matters',
      risk: `if the borrower defaults, the stake pays the lender up to ${coverBps / 100}% of what it is due; you then get the borrower's later repayments until that payout is recovered`,
    };
    if (!req.confirm) return plan(terms, 'Call h081_back again with action "open", the same fields and confirm: true; then stake with action "stake".');
    await b.open(this.h.usdg, { coverBps, feeBps: req.feeBps, maxLenderFeeBps, expiry, drawKey: dk.drawKey, maxAdvance: req.maxAdvance, maxTotal, lender: req.lender, cosign: req.cosign }, { allowPartialCover: req.allowPartialCover, allowHighFees: true });
    return {
      sent: true, ...terms, backingCode: encodeBackingCode(this.h.loanCodeContext, { backing: b.backing, loanRef: 0n }),
      next: 'stake USDG behind the line (h081_back action "stake"), then hand backingCode to the borrower',
    };
  }

  private async freeNonce(): Promise<bigint> {
    for (let n = 1n; n <= LINE_SCAN; n++) if (!(await this.h.connection.getAccountInfo(this.backer(n).backing, 'confirmed'))) return n;
    throw new Error(`lines 1..${LINE_SCAN} are all in use; pass nonce. Nothing was sent.`);
  }

  async stake(req: { nonce: bigint; amount: bigint; fromShielded?: boolean; confirm?: boolean }) {
    const b = this.backer(req.nonce);
    const l = await this.line(b.backing);
    const vault = backingVault(b.backing, l.asset, l.tokenProgram);
    const staked = await this.balance(vault);
    const max = this.h.config.maxBack;
    if (max !== undefined && (req.amount > max || staked + req.amount > max)) {
      throw new Error(`over the operator ceiling H081_MAX_BACK (${this.u(max)} per stake and per vault; the vault holds ${this.u(staked)}). Nothing was sent.`);
    }
    const p = {
      action: 'stake', nonce: req.nonce, backing: b.backing.toBase58(), amount: req.amount, amountUsdg: fromUnits(req.amount, this.h.decimals), vaultAfter: staked + req.amount,
      from: req.fromShielded ? 'the shielded balance (a pool withdraw straight to the line; its amount and time are public)' : 'the agent wallet\'s public USDG',
      privacy: BACKED_PRIVACY,
    };
    if (!req.confirm) return plan(p, 'Call h081_back again with action "stake", the same amount and confirm: true.');
    if (req.fromShielded) {
      await this.h.shieldedWithdrawTo(req.amount, b.backing);
    } else {
      const from = await this.h.walletUsdgAccount();
      await b.stake(from, this.h.signer, req.amount);
    }
    return { sent: true, ...p, staked: await this.balance(vault) };
  }

  private async balance(account: PublicKey): Promise<bigint> {
    const info = await this.h.connection.getAccountInfo(account, 'confirmed');
    return info && info.data.length >= 72 ? Buffer.from(info.data).readBigUInt64LE(64) : 0n;
  }

  async status(req: { nonce?: bigint }) {
    const nonces = req.nonce !== undefined ? [req.nonce] : Array.from({ length: Number(LINE_SCAN) }, (_, i) => BigInt(i + 1));
    const lines = [];
    for (const n of nonces) {
      const b = this.backer(n);
      const st = await backingStatus(this.h.connection, b.backing, this.programId);
      if (!st) continue;
      lines.push({
        nonce: n, backing: b.backing.toBase58(), backingCode: encodeBackingCode(this.h.loanCodeContext, { backing: b.backing, loanRef: 0n }),
        staked: st.staked, free: st.free, capacity: st.capacity, reserved: st.line.reserved, coverBps: st.line.coverBps, feeBps: st.line.feeBps, maxLenderFeeBps: st.line.maxLenderFeeBps, expiry: st.line.expiry,
        openDraws: st.line.openDraws, coveredOut: st.line.coveredOut, advancedTotal: st.line.advancedTotal,
        draws: st.draws.map((d) => ({ loanRef: d.loanRef, state: d.state, advance: d.advance, backerFee: d.backerFee, lenderFee: d.lenderFee, reserve: d.reserve, claimed: d.claimed })),
      });
    }
    return { lines };
  }

  async withdraw(req: { nonce: bigint; amount?: bigint; close?: boolean; confirm?: boolean }) {
    const b = this.backer(req.nonce);
    const l = await this.line(b.backing);
    const staked = await this.balance(backingVault(b.backing, l.asset, l.tokenProgram));
    const free = staked > l.reserved ? staked - l.reserved : 0n;
    if (req.close && (l.openDraws > 0 || l.reserved > 0n)) throw new Error(`line #${req.nonce} still has ${l.openDraws} open draw(s); release or cancel them first. Nothing was sent.`);
    const amount = req.close ? staked : req.amount ?? free;
    if (!req.close && (amount <= 0n || amount > free)) throw new Error(`only ${this.u(free)} of the stake is free (the rest backs open draws). Nothing was sent.`);
    const p = { action: req.close ? 'close' : 'withdraw', nonce: req.nonce, backing: b.backing.toBase58(), amount, amountUsdg: fromUnits(amount, this.h.decimals), to: 'the backer key\'s USDG account (then moved to the agent wallet)' };
    if (!req.confirm) return plan(p, `Call h081_back again with action "${p.action}" and confirm: true.`);
    const dest = await this.h.walletUsdgAccount();
    const tx = req.close ? await b.close(dest) : await b.withdraw(amount, dest);
    return { sent: true, ...p, to: dest.toBase58(), signature: tx.signature };
  }

  /** cancel (a request), release (a finished loan, permissionless) or forgive (give up an unrecovered fee or payout). */
  async settle(req: { nonce: bigint; loanRef: bigint; mode: 'cancel' | 'release' | 'forgive'; confirm?: boolean }) {
    const b = this.backer(req.nonce);
    const l = await this.line(b.backing);
    const info = await this.h.connection.getAccountInfo(drawPda(b.backing, req.loanRef, this.programId), 'confirmed');
    if (!info) throw new Error(`line #${req.nonce} has no draw on loan #${req.loanRef}. Nothing was sent.`);
    const d = decodeDraw(info.data);
    const p = { action: req.mode, nonce: req.nonce, loanRef: req.loanRef, drawState: d.state, reserve: d.reserve };
    if (req.mode !== 'release' && !req.confirm) return plan(p, `Call h081_back again with action "${req.mode}", the same loanRef and confirm: true.`);
    const tx = await send(this.h.connection, this.h.signer, [backSettleIx(req.loanRef, b.backing, l, b.key.publicKey, d.payer, req.mode === 'forgive', this.programId)], { signers: [b.key] });
    return { sent: true, ...p, signature: tx.signature };
  }

  /** Permissionless default claim on a backed loan (syncs first). Anyone may send it; it pays the slot's lender. */
  async claim(req: { backingCode: string; loanRef?: bigint }) {
    const c = decodeBackingCode(this.h.loanCodeContext, req.backingCode);
    const ref = req.loanRef ?? c.loanRef;
    if (!ref) throw new Error('loanRef is required (the backing code carries none). Nothing was sent.');
    const tx = await claimBacked(this.h.connection, this.h.signer, c.backing, ref, this.programId, this.h.config.poolProgramId);
    return { sent: true, action: 'claim', loanRef: ref, signature: tx.signature };
  }

  // ---------------------------------------------------------------- borrower

  private borrower(backing: PublicKey, lineNonce: bigint): SolanaBackedBorrower {
    return new SolanaBackedBorrower(this.h.connection, this.drawKey(lineNonce), backing, this.h.signer, this.programId);
  }

  async request(req: { backingCode: string; lineNonce: bigint; loanRef: bigint; advance: bigint; lenderFeeBps: number; days: number; ttlHours?: number; allowHighFees?: boolean; confirm?: boolean }) {
    const c = decodeBackingCode(this.h.loanCodeContext, req.backingCode);
    const l = await this.line(c.backing);
    const k = this.drawKey(req.lineNonce);
    if (!l.drawKey.equals(k.publicKey)) throw new Error(`that line is for another draw key; this agent's line #${req.lineNonce} key is ${k.publicKey.toBase58()}. Nothing was sent.`);
    const max = this.h.config.maxDraw;
    if (max !== undefined && req.advance > max) throw new Error(`over the operator ceiling H081_MAX_DRAW (${this.u(max)} per advance). Nothing was sent.`);
    if (req.advance < MIN_ADVANCE || req.advance > l.maxAdvance) throw new Error(`the advance must be ${this.u(MIN_ADVANCE)}..${this.u(l.maxAdvance)} on this line. Nothing was sent.`);
    const slotInfo = await this.h.connection.getAccountInfo(slotPda(req.loanRef, this.programId), 'confirmed');
    if (!slotInfo) throw new Error(`loan slot #${req.loanRef} does not exist (the lender opens it with h081_lend action "open"). Nothing was sent.`);
    const slot = decodeSlot(slotInfo.data);
    if (slot.funded) throw new Error(`loan slot #${req.loanRef} is already funded. Nothing was sent.`);
    if (req.lenderFeeBps > l.maxLenderFeeBps) throw new Error(`lenderFeeBps ${req.lenderFeeBps} is above this line's cap of ${l.maxLenderFeeBps} (the backer set it). Nothing was sent.`);
    const t = backedTerms({ advance: req.advance, feeBps: l.feeBps, lenderFeeBps: req.lenderFeeBps, coverBps: l.coverBps });
    const warnings = checkLineTerms({ coverBps: l.coverBps, feeBps: l.feeBps, lenderFeeBps: req.lenderFeeBps }, { allowPartialCover: true, allowHighFees: req.allowHighFees });
    const term = BigInt(Math.round(req.days * 86_400));
    const p = {
      action: 'request', loanRef: req.loanRef, lender: slot.lender.toBase58(), backing: c.backing.toBase58(), advance: req.advance, advanceUsdg: fromUnits(req.advance, this.h.decimals),
      principal: t.principal, principalUsdg: fromUnits(t.principal, this.h.decimals), backerFee: t.backerFee, lenderFee: t.lenderFee, youReceive: t.toPayout,
      youReceiveUsdg: fromUnits(t.toPayout, this.h.decimals), termDays: req.days, cover: `${l.coverBps / 100}% of the lender's due (${this.u(t.reserve)})`, warnings,
      privacy: BACKED_PRIVACY,
    };
    if (!req.confirm) return plan(p, 'Call h081_back_draw again with action "request", the same fields and confirm: true; then hand the returned backingCode to the lender.');
    await this.prepare();
    const tx = await this.borrower(c.backing, req.lineNonce).request(req.loanRef, req.advance, req.lenderFeeBps, term, { ttl: BigInt(Math.round((req.ttlHours ?? 24) * 3600)), allowHighFees: true });
    return {
      sent: true, ...p, signature: tx.signature, backingCode: encodeBackingCode(this.h.loanCodeContext, { backing: c.backing, loanRef: req.loanRef }),
      next: 'hand backingCode to the lender (h081_lend action "fund" with backingCode); it funds exactly these terms or nothing',
    };
  }

  async cancelDraw(req: { backingCode: string; lineNonce: bigint; loanRef?: bigint; confirm?: boolean }) {
    const c = decodeBackingCode(this.h.loanCodeContext, req.backingCode);
    const ref = req.loanRef ?? c.loanRef;
    if (!ref) throw new Error('loanRef is required. Nothing was sent.');
    if (!req.confirm) return plan({ action: 'cancel', loanRef: ref, backing: c.backing.toBase58() }, 'Call h081_back_draw again with action "cancel" and confirm: true.');
    const tx = await this.borrower(c.backing, req.lineNonce).cancel(ref);
    return { sent: true, action: 'cancel', loanRef: ref, signature: tx.signature };
  }

  /** Repays from the draw key's USDG account (where the advance was paid), or from the shielded balance. */
  async repay(req: { backingCode: string; lineNonce: bigint; loanRef?: bigint; amount: bigint; fromShielded?: boolean; confirm?: boolean }) {
    const c = decodeBackingCode(this.h.loanCodeContext, req.backingCode);
    const ref = req.loanRef ?? c.loanRef;
    if (!ref) throw new Error('loanRef is required. Nothing was sent.');
    const view = await backedLoanView(this.h.connection, c.backing, ref, this.programId);
    if (!view.slot?.funded) throw new Error(`loan #${ref} is not a funded backed loan. Nothing was sent.`);
    const owed = view.slot.principal > view.slot.repaid ? view.slot.principal - view.slot.repaid : 0n;
    if (owed === 0n) throw new Error(`loan #${ref} is repaid. Nothing was sent.`);
    const amount = req.amount > owed ? owed : req.amount;
    const p = { action: 'repay', loanRef: ref, amount, amountUsdg: fromUnits(amount, this.h.decimals), owedBefore: owed, from: req.fromShielded ? 'the shielded balance (a pool withdraw to the loan; amount and time public)' : 'the draw key\'s USDG account' };
    if (!req.confirm) return plan(p, 'Call h081_back_draw again with action "repay", the same amount and confirm: true.');
    const br = this.borrower(c.backing, req.lineNonce);
    const tx = req.fromShielded
      ? await (async () => { await this.h.shieldedWithdrawTo(amount, slotPda(ref, this.programId)); return br.sync(ref); })()
      : await br.repay(ref, associatedTokenAddress(br.drawKey.publicKey, view.slot!.asset, view.slot!.tokenProgram), br.drawKey, amount);
    return { sent: true, ...p, signature: tx.signature };
  }

  /** Moves USDG out of the draw key's account (the advance) to the agent wallet, signed by the draw key. */
  async take(req: { lineNonce: bigint; amount: bigint; confirm?: boolean }) {
    const k = this.drawKey(req.lineNonce);
    const tp = await this.h.tokenProgram();
    const from = associatedTokenAddress(k.publicKey, this.h.usdg, tp);
    const have = await this.balance(from);
    if (req.amount > have) throw new Error(`the draw key holds ${this.u(have)}. Nothing was sent.`);
    const to = await this.h.walletUsdgAccount();
    if (!req.confirm) return plan({ action: 'take', amount: req.amount, from: from.toBase58(), to: to.toBase58() }, 'Call h081_back_draw again with action "take" and confirm: true.');
    const ixs: TransactionInstruction[] = [createAtaIdempotentIx(this.h.signer.publicKey, this.h.signer.publicKey, this.h.usdg, tp), transferChecked(from, this.h.usdg, to, k.publicKey, req.amount, this.h.decimals, tp)];
    const tx = await send(this.h.connection, this.h.signer, ixs, { signers: [k] });
    return { sent: true, action: 'take', amount: req.amount, signature: tx.signature };
  }

  async drawStatus(req: { backingCode: string; loanRef?: bigint }) {
    const c = decodeBackingCode(this.h.loanCodeContext, req.backingCode);
    const ref = req.loanRef ?? c.loanRef;
    const st = await backingStatus(this.h.connection, c.backing, this.programId);
    if (!st) throw new Error('that line does not exist on chain');
    const loan = ref ? await backedLoanView(this.h.connection, c.backing, ref, this.programId) : undefined;
    return {
      backing: c.backing.toBase58(), coverBps: st.line.coverBps, feeBps: st.line.feeBps, maxLenderFeeBps: st.line.maxLenderFeeBps, maxAdvance: st.line.maxAdvance, free: st.free, capacity: st.capacity, expiry: st.line.expiry,
      loan: loan && { loanRef: ref, draw: loan.draw?.state ?? null, principal: loan.slot?.principal ?? null, repaid: loan.slot?.repaid ?? null, expiry: loan.slot?.expiry ?? null, toBacker: loan.toBacker, toLender: loan.toLender },
    };
  }

  // ---------------------------------------------------------------- lender

  /**
   * h081_lend fund with a backing code: funds the draw at exactly its on-chain terms; H081_MAX_LEND applies. The plan
   * returns the exact terms and their `planDigest`; the confirm call must pass that digest back, and the terms it
   * stands for are what the transaction carries (the program refuses the fund if the Draw no longer has them).
   */
  async lendFund(req: { backingCode: string; loanRef?: bigint; minCoverBps?: number; planDigest?: string; confirm?: boolean }) {
    const c = decodeBackingCode(this.h.loanCodeContext, req.backingCode);
    const ref = req.loanRef ?? c.loanRef;
    if (!ref) throw new Error('the backing code names no loan slot; ask the borrower for the code its request returned (or pass loanRef). Nothing was sent.');
    const l = await this.line(c.backing);
    const dInfo = await this.h.connection.getAccountInfo(drawPda(c.backing, ref, this.programId), 'confirmed');
    if (!dInfo) throw new Error(`there is no request on loan slot #${ref} from that line. Nothing was sent.`);
    const d = decodeDraw(dInfo.data);
    const slot = decodeSlot((await this.h.connection.getAccountInfo(slotPda(ref, this.programId), 'confirmed'))!.data);
    if (!slot.lender.equals(this.h.signer.publicKey)) throw new Error(`loan slot #${ref} belongs to another lender. Nothing was sent.`);
    const minCoverBps = req.minCoverBps ?? FULL_COVER_BPS;
    if (l.coverBps < minCoverBps) throw new Error(`the line covers ${l.coverBps / 100}% of your due, below your minimum ${minCoverBps / 100}% (pass minCoverBps to accept less). Nothing was sent.`);
    const max = this.h.config.maxLend;
    if (max !== undefined && d.advance > max) throw new Error(`over the operator ceiling H081_MAX_LEND (${this.u(max)} per loan). Nothing was sent.`);
    if (d.state !== 'requested') throw new Error(`the draw on loan slot #${ref} is ${d.state}, not waiting for a lender. Nothing was sent.`);
    const t = backedTerms({ advance: d.advance, feeBps: l.feeBps, lenderFeeBps: 0, coverBps: l.coverBps });
    const due = d.advance + d.lenderFee;
    const fundTerms = backedFundTerms(d, l);
    const planDigest = backedTermsDigest(c.backing, ref, fundTerms);
    const p = {
      action: 'fund', kind: 'backed', loanRef: ref, backing: c.backing.toBase58(), advance: d.advance, advanceUsdg: fromUnits(d.advance, this.h.decimals),
      youAreDue: due, youAreDueUsdg: fromUnits(due, this.h.decimals), lenderFee: d.lenderFee, backerFeeFirst: d.backerFee, termDays: Number(d.term) / 86_400,
      covered: d.reserve, coveredUsdg: fromUnits(d.reserve, this.h.decimals), uncovered: due > d.reserve ? due - d.reserve : 0n, coverBps: l.coverBps,
      borrowerReceives: t.toPayout, payoutTo: d.payoutTo.toBase58(), fundBy: d.fundBy,
      terms: { advance: fundTerms.advance, principal: fundTerms.principal, term: fundTerms.term, payoutTo: fundTerms.payoutTo.toBase58(), coverBps: fundTerms.coverBps },
      planDigest,
      risk: 'the borrower is an anonymous per-line key: repayment is its own; on default the stake pays your shortfall up to the cover. The backer is paid its fee from repayments before you',
    };
    if (!req.confirm) return plan(p, `Call h081_lend again with action "fund", the same backingCode, planDigest "${planDigest}" and confirm: true to lend exactly this.`);
    if (!req.planDigest) throw new Error(`planDigest is required to fund a backed draw: call h081_lend fund without confirm first, check the terms, then confirm with the planDigest it returns (now "${planDigest}"). Nothing was sent.`);
    if (req.planDigest.trim().toLowerCase() !== planDigest) {
      throw new Error(`the draw on loan slot #${ref} changed since your plan (its terms now give planDigest "${planDigest}"): read the new plan before lending. Nothing was sent.`);
    }
    const tx = await fundBacked(this.h.connection, this.h.signer, c.backing, ref, {
      minCoverBps, programId: this.programId, treasuryOwner: this.h.config.loanTreasury, poolProgram: this.h.config.poolProgramId, expect: fundTerms,
    });
    return { sent: true, ...p, signature: tx.signature, next: 'h081_lend action "status" shows repayments; on a default anyone may send h081_back action "claim" with this backingCode' };
  }
}

function transferChecked(from: PublicKey, mint: PublicKey, to: PublicKey, owner: PublicKey, amount: bigint, decimals: number, tp: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(10); data[0] = 12; data.writeBigUInt64LE(amount, 1); data[9] = decimals;
  return new TransactionInstruction({ programId: tp, keys: [{ pubkey: from, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: to, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }], data });
}

export { BACKER_ERROR, backingPda };
