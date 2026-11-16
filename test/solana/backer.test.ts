// Backed lines on stream_loan (docs/BACKER-SPEC.md) on a private solana-test-validator (WSL, rpc 127.0.0.1:18899).
// Run with `npm run test:solana:backer`: it starts that validator with the stream_loan build from BEFORE backed lines
// (target-so/stream_loan_base.so), so the first test is the upgrade rehearsal, then runs this file. Localnet only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { customErrorCode, send } from '../../src/solana/index.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, LOAN_TREASURY, LOCALNET_LOAN_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, associatedTokenAddress, closeSlotIx, decodeRegistry,
  decodeSlot, decodeSubrogation, loanFundedEvents, loanInitializeIx, loanStatus, loanTreasuryAccount, openSlotIx, registryPda, safetyPoolFor, settleIx,
  slotInbox, slotPda, subrogationPda, syncIx,
} from '../../src/solana/lender.js';
import {
  BACKER_ERROR, BACKING_ACCOUNT_SIZE, DRAW_ACCOUNT_SIZE, LOCALNET_LOAN_FAST_PROGRAM_ID, SolanaBackedBorrower, SolanaBacker, backClaimIx, backOpenIx,
  backRequestIx, backSettleIx, backedClaimAmount, backedFundedEvents, backedTerms, backerKeyFor, backingClaimedEvents, backingPda, backingVault,
  claimBacked, decodeBacking, decodeDraw, drawKeyFor, drawPda, drawReleasedEvents, fundBacked, fundBackedIx, isBackedSubrogation, releaseBacked,
} from '../../src/solana/backer.js';
import { LOCALNET_UPGRADE_AUTHORITY } from './config-authority.js';

const RPC = process.env.STIPEND_BACKER_RPC;
const LOAN = LOCALNET_LOAN_PROGRAM_ID;
const FAST = LOCALNET_LOAN_FAST_PROGRAM_ID;
const suite = describe.skipIf(!RPC);
const connection = new Connection(RPC ?? 'http://127.0.0.1:18899', 'confirmed');
const U = 1_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const funder = Keypair.generate();

// Compute units of the backed-line transactions on this validator, written to solana/compute-units-backer.json.
const CU: Record<string, number> = {};
const cu = (name: string, tx: { computeUnits?: number }) => { CU[name] = Math.max(CU[name] ?? 0, tx.computeUnits ?? 0); console.log(`${name}: compute units ${tx.computeUnits}`); };

async function fundSol(...keys: PublicKey[]) {
  for (const k of keys) {
    const sig = await connection.requestAirdrop(k, 10 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction({ signature: sig, ...(await connection.getLatestBlockhash()) }, 'confirmed');
  }
}
async function newKeys(n: number): Promise<Keypair[]> {
  const ks = Array.from({ length: n }, () => Keypair.generate());
  await fundSol(...ks.map((k) => k.publicKey));
  return ks;
}
async function expectCode(p: Promise<unknown>, code: number) {
  let caught: unknown;
  try { await p; } catch (e) { caught = e; }
  expect(caught, 'transaction should fail').toBeDefined();
  if (customErrorCode(caught) !== code) console.log(String(caught), (caught as { logs?: string[] }).logs?.slice(-8));
  expect(customErrorCode(caught)).toBe(code);
}
async function expectFail(p: Promise<unknown>) {
  let caught: unknown;
  try { await p; } catch (e) { caught = e; }
  expect(caught, 'transaction should fail').toBeDefined();
}

// ---- minimal SPL Token helpers ----
function createAtaIx(payer: PublicKey, owner: PublicKey, mint: PublicKey, tp = SPL_TOKEN_PROGRAM_ID) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true }, { pubkey: associatedTokenAddress(owner, mint, tp), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: tp, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}
function mintToIx(mint: PublicKey, to: PublicKey, authority: PublicKey, amount: bigint, tp = SPL_TOKEN_PROGRAM_ID) {
  const data = Buffer.alloc(9); data[0] = 7; data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({ programId: tp, keys: [{ pubkey: mint, isSigner: false, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }, { pubkey: authority, isSigner: true, isWritable: false }], data });
}
function transferIx(from: PublicKey, mint: PublicKey, to: PublicKey, owner: PublicKey, amount: bigint, tp = SPL_TOKEN_PROGRAM_ID) {
  const data = Buffer.alloc(10); data[0] = 12; data.writeBigUInt64LE(amount, 1); data[9] = 6;
  return new TransactionInstruction({
    programId: tp, keys: [{ pubkey: from, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: to, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }], data,
  });
}
function freezeIx(account: PublicKey, mint: PublicKey, authority: PublicKey, thaw = false) {
  return new TransactionInstruction({ programId: SPL_TOKEN_PROGRAM_ID, keys: [{ pubkey: account, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: authority, isSigner: true, isWritable: false }], data: Buffer.from([thaw ? 11 : 10]) });
}
async function createMint(authority: Keypair): Promise<PublicKey> {
  const mint = Keypair.generate();
  const lamports = await connection.getMinimumBalanceForRentExemption(82);
  const init = Buffer.alloc(67); init[0] = 20; init[1] = 6; authority.publicKey.toBuffer().copy(init, 2); init[34] = 1; authority.publicKey.toBuffer().copy(init, 35);
  await send(connection, authority, [
    SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: mint.publicKey, lamports, space: 82, programId: SPL_TOKEN_PROGRAM_ID }),
    new TransactionInstruction({ programId: SPL_TOKEN_PROGRAM_ID, keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }], data: init }),
  ], { signers: [mint] });
  return mint.publicKey;
}
async function bal(account: PublicKey): Promise<bigint> {
  const info = await connection.getAccountInfo(account, 'confirmed');
  return info ? Buffer.from(info.data).readBigUInt64LE(64) : 0n;
}
async function chainNow(): Promise<bigint> {
  const t = await connection.getBlockTime(await connection.getSlot('confirmed'));
  return BigInt(t!);
}
async function waitUntil(t: bigint) {
  for (let i = 0; i < 120 && (await chainNow()) <= t; i++) await sleep(500);
}
async function nextRef(programId: PublicKey): Promise<bigint> {
  return decodeRegistry((await connection.getAccountInfo(registryPda(programId), 'confirmed'))!.data).nextLoanRef;
}
async function openSlot(lender: Keypair, programId = LOAN): Promise<bigint> {
  const ref = await nextRef(programId);
  await send(connection, lender, [openSlotIx(lender.publicKey, ref, programId)]);
  return ref;
}
async function readSlot(ref: bigint, programId = LOAN) { return decodeSlot((await connection.getAccountInfo(slotPda(ref, programId), 'confirmed'))!.data); }
async function readSub(ref: bigint, programId = LOAN) { return decodeSubrogation((await connection.getAccountInfo(subrogationPda(ref, programId), 'confirmed'))!.data); }
async function readLine(backing: PublicKey) { return decodeBacking((await connection.getAccountInfo(backing, 'confirmed'))!.data); }

// ---- localnet program upgrade (WSL solana CLI against 127.0.0.1:18899 only) ----
const SOLANA_DIR = resolve(import.meta.dirname, '..', '..', 'solana');
const toWsl = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => `/mnt/${d.toLowerCase()}`);
function upgradeLoanProgram(so: string) {
  const dir = mkdtempSync(join(tmpdir(), 'backer-upgrade-'));
  const auth = join(dir, 'authority.json');
  writeFileSync(auth, JSON.stringify(Array.from(LOCALNET_UPGRADE_AUTHORITY.secretKey)));
  try {
    const script = join(SOLANA_DIR, 'scripts', 'loan-upgrade-localnet.sh');
    const win = process.platform === 'win32';
    const port = new URL(RPC!).port;
    const args = [win ? toWsl(script) : script, win ? toWsl(so) : so, win ? toWsl(auth) : auth, LOAN.toBase58(), port];
    const r = spawnSync(win ? 'wsl.exe' : 'bash', win ? ['-d', 'Ubuntu', '--', 'bash', ...args] : args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    if (r.status !== 0 || /error/i.test(r.stdout + r.stderr)) throw new Error(`localnet upgrade to ${so} failed: ${r.stdout}${r.stderr}`);
    return r.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A mint, a lender with funds, a backer key, a borrower draw key: the cast of most tests. */
async function cast(opts: { programId?: PublicKey; lenderFunds?: bigint; backerFunds?: bigint } = {}) {
  const [authority, lender, payerB, payerA, stranger] = await newKeys(5);
  const mint = await createMint(authority);
  const backerKey = backerKeyFor(BigInt('0x' + Buffer.from(Keypair.generate().secretKey.subarray(0, 31)).toString('hex')), 1n);
  const drawKey = drawKeyFor(BigInt('0x' + Buffer.from(Keypair.generate().secretKey.subarray(0, 31)).toString('hex')), 1n);
  const lenderAta = associatedTokenAddress(lender.publicKey, mint);
  const backerAta = associatedTokenAddress(backerKey.publicKey, mint);
  await send(connection, authority, [
    createAtaIx(authority.publicKey, lender.publicKey, mint), mintToIx(mint, lenderAta, authority.publicKey, opts.lenderFunds ?? 5_000n * U),
    createAtaIx(authority.publicKey, backerKey.publicKey, mint), mintToIx(mint, backerAta, authority.publicKey, opts.backerFunds ?? 5_000n * U),
    createAtaIx(authority.publicKey, LOAN_TREASURY, mint), createAtaIx(authority.publicKey, drawKey.publicKey, mint),
  ]);
  return { authority, lender, payerB, payerA, stranger, mint, backerKey, drawKey, lenderAta, backerAta, programId: opts.programId ?? LOAN };
}
type Cast = Awaited<ReturnType<typeof cast>>;

async function openLine(c: Cast, nonce: bigint, o: { coverBps?: number; feeBps?: number; ttl?: bigint; stake?: bigint; maxAdvance?: bigint; maxTotal?: bigint; lender?: PublicKey; cosign?: boolean; allowPartialCover?: boolean } = {}) {
  const backer = new SolanaBacker(connection, c.backerKey, nonce, c.payerB, c.programId);
  const opened = await backer.open(c.mint, {
    coverBps: o.coverBps ?? 10_000, feeBps: o.feeBps ?? 500, expiry: (await chainNow()) + (o.ttl ?? 30n * 86_400n), drawKey: c.drawKey.publicKey,
    maxAdvance: o.maxAdvance ?? 1_000n * U, maxTotal: o.maxTotal ?? 3_000n * U, lender: o.lender, cosign: o.cosign,
  }, { allowPartialCover: o.allowPartialCover, allowHighFees: true });
  cu('back_open', opened);
  if ((o.stake ?? 600n * U) > 0n) await backer.stake(c.backerAta, c.backerKey, o.stake ?? 600n * U);
  const borrower = new SolanaBackedBorrower(connection, c.drawKey, backer.backing, c.payerA, c.programId);
  return { backer, borrower, backing: backer.backing, vault: backingVault(backer.backing, c.mint) };
}

beforeAll(async () => {
  if (!RPC) return;
  try { await connection.getVersion(); } catch { throw new Error(`no validator at ${RPC}; run: node scripts/solana-backer-localnet.mjs start base`); }
  await fundSol(funder.publicKey, LOCALNET_UPGRADE_AUTHORITY.publicKey);
  for (const id of [LOAN, FAST]) {
    if (!(await connection.getAccountInfo(registryPda(id)))) await send(connection, LOCALNET_UPGRADE_AUTHORITY, [loanInitializeIx(LOCALNET_UPGRADE_AUTHORITY.publicKey, id)]);
  }
});

suite('upgrade rehearsal: the program before backed lines, upgraded in place', () => {
  it('old registry and slots survive the upgrade, the new instructions appear, and an old slot can be lent backed', async () => {
    const [lender] = await newKeys(1);
    // under the old program (if the validator was started with `base`): back_open does not exist yet
    const probe = backOpenIx(lender.publicKey, lender.publicKey, PublicKey.default, { nonce: 1n, coverBps: 10_000, feeBps: 0, expiry: 0n, drawKey: lender.publicKey, maxAdvance: U, maxTotal: U });
    let before: unknown;
    try { await send(connection, lender, [probe]); } catch (e) { before = e; }
    const wasBase = String((before as { logs?: string[] })?.logs ?? before).includes('InstructionFallbackNotFound') || String(before).includes('0x65');
    const r1 = await openSlot(lender);
    const r2 = await openSlot(lender);
    await send(connection, lender, [settleIx(lender.publicKey, r2)]).catch(() => undefined); // unfunded: NoLoan, as before
    const out = upgradeLoanProgram(join(SOLANA_DIR, 'target-so', 'stream_loan.so'));
    console.log(`base program before the upgrade: ${wasBase}; upgrade: ${out.trim().split('\n').pop()}`);
    await sleep(1500);
    // old accounts decode, the counter continues, nothing moved
    const s1 = await readSlot(r1);
    expect([s1.loanRef, s1.funded, s1.lender.equals(lender.publicKey)]).toEqual([r1, false, true]);
    expect(await nextRef(LOAN)).toBe(r2 + 1n);
    // the upgrade authority is kept (never --final)
    const pd = PublicKey.findProgramAddressSync([LOAN.toBytes()], new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0];
    const pdInfo = await connection.getAccountInfo(pd, 'confirmed');
    expect(pdInfo!.data[12]).toBe(1);
    expect(new PublicKey(pdInfo!.data.subarray(13, 45)).equals(LOCALNET_UPGRADE_AUTHORITY.publicKey)).toBe(true);
    // a slot opened before the upgrade is lent through a backed line after it
    const c = await cast();
    const { borrower, backing } = await openLine(c, 1n, {});
    const lenderAta = associatedTokenAddress(lender.publicKey, c.mint);
    await send(connection, c.authority, [createAtaIx(c.authority.publicKey, lender.publicKey, c.mint), mintToIx(c.mint, lenderAta, c.authority.publicKey, 1_000n * U)]);
    await borrower.request(r1, 100n * U, 0, 2n * 86_400n);
    await fundBacked(connection, lender, backing, r1);
    expect((await readSlot(r1)).principal).toBe(105n * U);
  });
});

suite('three wallets, the happy path', () => {
  it('backer stakes, borrower draws, lender funds; the fee reaches the vault first, the lender the rest; everything closes with its rent back', async () => {
    const c = await cast();
    const ref = await openSlot(c.lender);
    const { backer, borrower, backing, vault } = await openLine(c, 7n, { stake: 600n * U });
    expect((await connection.getAccountInfo(backing))!.data.length).toBe(BACKING_ACCOUNT_SIZE);
    const line0 = await readLine(backing);
    expect([line0.coverBps, line0.feeBps, line0.drawKey.equals(c.drawKey.publicKey), line0.reserved, line0.openDraws]).toEqual([10_000, 500, true, 0n, 0]);
    expect(await bal(vault)).toBe(600n * U);

    const q = await borrower.quote(500n * U, 300);
    expect([q.backerFee, q.lenderFee, q.principal, q.reserve, q.lenderDue, q.uncovered]).toEqual([25n * U, 15n * U, 540n * U, 515n * U, 515n * U, 0n]);
    const req = await borrower.request(ref, 500n * U, 300, 2n * 86_400n, { ttl: 3_600n });
    cu('back_request (+ payout ATA idempotent)', req);
    const draw = decodeDraw((await connection.getAccountInfo(req.draw, 'confirmed'))!.data);
    expect((await connection.getAccountInfo(req.draw))!.data.length).toBe(DRAW_ACCOUNT_SIZE);
    expect([draw.state, draw.advance, draw.backerFee, draw.lenderFee, draw.reserve, draw.term]).toEqual(['requested', 500n * U, 25n * U, 15n * U, 515n * U, 2n * 86_400n]);
    expect((await readLine(backing)).reserved).toBe(515n * U);

    const payout = associatedTokenAddress(c.drawKey.publicKey, c.mint);
    const treasury = loanTreasuryAccount(c.mint);
    const [lb, tb] = [await bal(c.lenderAta), await bal(treasury)];
    const funded = await fundBacked(connection, c.lender, backing, ref);
    cu('fund_backed (+ treasury ATA idempotent)', funded);
    expect(await bal(payout)).toBe(500n * U - 1_250_000n); // advance - 0.25%
    expect(await bal(treasury)).toBe(tb + 1_250_000n);
    expect(await bal(c.lenderAta)).toBe(lb - 500n * U);
    const ev = loanFundedEvents(funded.logs)[0];
    expect([ev.principal, ev.fee]).toEqual([540n * U, 1_250_000n]);
    const bf = backedFundedEvents(funded.logs)[0];
    expect([bf.advance, bf.backerFee, bf.lenderFee, bf.reserve]).toEqual([500n * U, 25n * U, 15n * U, 515n * U]);
    const slot = await readSlot(ref);
    expect([slot.funded, slot.principal, slot.pledgeBps, slot.agentPk, slot.minRemaining]).toEqual([true, 540n * U, 0n, 0n, 0n]);
    expect(slot.expiry).toBe(BigInt(slot.fundedAt) + 2n * 86_400n); // B5: the term starts at funding
    const sub = await readSub(ref);
    expect([sub.safetyConfig.equals(backing), sub.to.equals(vault), sub.owed, sub.paid]).toEqual([true, true, 25n * U, 0n]);
    expect(await isBackedSubrogation(connection, sub)).toBe(true);
    const st = await loanStatus(connection, ref);
    expect(st.state === 'open' && st.backed).toBe(true);
    // a second fund of the same draw fails
    await expectFail(fundBacked(connection, c.lender, backing, ref));

    // repay 300 (fee 25 to the vault, 275 to the lender), then 240 (all to the lender) and 10 more (borrower excess)
    await send(connection, c.authority, [mintToIx(c.mint, payout, c.authority.publicKey, 100n * U)]);
    cu('transfer + sync (fee to the vault, rest to the lender)', await borrower.repay(ref, payout, c.drawKey, 300n * U));
    expect(await bal(vault)).toBe(625n * U);
    expect(await bal(c.lenderAta)).toBe(lb - 500n * U + 275n * U);
    await borrower.repay(ref, payout, c.drawKey, 250n * U);
    expect(await bal(c.lenderAta)).toBe(lb - 500n * U + 515n * U);
    expect((await readSlot(ref)).repaid).toBe(540n * U);
    expect((await readSub(ref)).paid).toBe(25n * U);
    expect(await bal(slotInbox(ref, c.mint))).toBe(10n * U); // the overpay cap keeps the excess for the borrower

    // nothing to claim on a repaid loan
    await expectCode(claimBacked(connection, c.stranger, backing, ref), BACKER_ERROR.NoBackedDefault);
    // the lender settles; anyone releases: reserve freed, Draw closed, its rent back to the borrower's payer
    await send(connection, c.lender, [settleIx(c.lender.publicKey, ref)]);
    const payerBefore = await connection.getBalance(c.payerA.publicKey);
    const rel = await releaseBacked(connection, c.stranger, backing, ref);
    cu('back_settle (release + close Draw)', rel);
    expect(drawReleasedEvents(rel.logs)[0]).toMatchObject({ reason: 1, forgone: 0n, closed: true });
    expect(await connection.getAccountInfo(req.draw)).toBeNull();
    expect(await connection.getBalance(c.payerA.publicKey)).toBeGreaterThan(payerBefore);
    const line1 = await readLine(backing);
    expect([line1.reserved, line1.openDraws, line1.drawsTotal, line1.advancedTotal]).toEqual([0n, 0, 1, 500n * U]);
    // the lender closes the slot (the Subrogation is recovered, so it never blocks)
    await send(connection, c.lender, [closeSlotIx(c.lender.publicKey, ref, { asset: c.mint, tokenProgram: SPL_TOKEN_PROGRAM_ID }, LOAN, safetyPoolFor(LOAN))]);
    expect(await connection.getAccountInfo(slotPda(ref))).toBeNull();
    // the backer closes the line: stake + fee back, both rents to its payer
    const [bb, pb] = [await bal(c.backerAta), await connection.getBalance(c.payerB.publicKey)];
    cu('back_withdraw close (+ backer ATA idempotent)', await backer.close());
    expect(await bal(c.backerAta)).toBe(bb + 625n * U);
    expect(await connection.getAccountInfo(backing)).toBeNull();
    expect(await connection.getAccountInfo(vault)).toBeNull();
    expect(await connection.getBalance(c.payerB.publicKey)).toBeGreaterThan(pb);
  });
});

suite('default (fast test build: grace 2 s, claim window 5 s, recovery horizon 5 s)', () => {
  it('a stranger claims for the lender, the lender gets exactly its unpaid due, pending shares must be synced first, recovery goes to the vault', async () => {
    const c = await cast({ programId: FAST });
    const ref = await openSlot(c.lender, FAST);
    const { backer, borrower, backing, vault } = await openLine(c, 1n, { stake: 600n * U, ttl: 3_600n });
    await borrower.request(ref, 500n * U, 300, 3n);
    await fundBacked(connection, c.lender, backing, ref, { programId: FAST });
    const payout = associatedTokenAddress(c.drawKey.publicKey, c.mint);
    await borrower.repay(ref, payout, c.drawKey, 10n * U); // below the fee: all of it to the vault
    expect(await bal(vault)).toBe(610n * U);
    // not in default yet
    await expectCode(send(connection, c.stranger, [backClaimIx(ref, backing, await readSlot(ref, FAST), FAST)]), BACKER_ERROR.NoBackedDefault);
    const slot = await readSlot(ref, FAST);
    await waitUntil(slot.expiry + 2n);
    // B1: a share in the inbox, not synced: the claim alone is refused
    await send(connection, c.payerA, [transferIx(payout, c.mint, slotInbox(ref, c.mint, SPL_TOKEN_PROGRAM_ID, FAST), c.drawKey.publicKey, 7n * U)], { signers: [c.drawKey] });
    await expectCode(send(connection, c.stranger, [backClaimIx(ref, backing, slot, FAST)]), BACKER_ERROR.ReceiptsPending);
    // sync + claim in one transaction: the 7 pays more of the fee, then the lender gets its whole due (515) from the stake
    const lb = await bal(c.lenderAta);
    const tx = await claimBacked(connection, c.stranger, backing, ref, FAST);
    cu('sync + back_claim', tx);
    const ev = backingClaimedEvents(tx.logs)[0];
    expect(backedClaimAmount(540n * U, 25n * U, 17n * U, 17n * U, 515n * U, 617n * U)).toBe(515n * U);
    expect([ev.amount, ev.held, ev.feeForfeited]).toEqual([515n * U, false, 8n * U]);
    expect(await bal(c.lenderAta)).toBe(lb + 515n * U);
    expect(await bal(vault)).toBe(617n * U - 515n * U);
    const sub = await readSub(ref, FAST);
    expect([sub.paid, sub.owed]).toEqual([17n * U, 17n * U + 515n * U]);
    const line = await readLine(backing);
    expect([line.reserved, line.openDraws, line.coveredOut]).toEqual([0n, 1, 515n * U]);
    expect(decodeDraw((await connection.getAccountInfo(drawPda(backing, ref, FAST)))!.data).state).toBe('claimed');
    await expectCode(claimBacked(connection, c.stranger, backing, ref, FAST), BACKER_ERROR.DrawState);
    // later repayments go to the vault first (recovery), the lender gets nothing more until it is recovered
    await borrower.repay(ref, payout, c.drawKey, 100n * U);
    expect(await bal(vault)).toBe(202n * U);
    expect(await bal(c.lenderAta)).toBe(lb + 515n * U);
    // the line cannot close while its Subrogation may still route to the vault (B2), and the lender's close waits too
    await expectCode(backer.close(), BACKER_ERROR.BackingBusy);
    await send(connection, c.lender, [settleIx(c.lender.publicKey, ref, FAST)]);
    await expectCode(send(connection, c.lender, [closeSlotIx(c.lender.publicKey, ref, { asset: c.mint, tokenProgram: SPL_TOKEN_PROGRAM_ID }, FAST, safetyPoolFor(LOAN))]), 6033);
    // release before the recovery horizon: nothing to free, nothing done
    await expectCode(releaseBacked(connection, c.stranger, backing, ref, FAST), BACKER_ERROR.NotReleasable);
    // forgiving needs the backer
    await expectCode(send(connection, c.stranger, [backSettleIx(ref, backing, { asset: c.mint, tokenProgram: SPL_TOKEN_PROGRAM_ID }, c.stranger.publicKey, c.payerA.publicKey, true, FAST)]), BACKER_ERROR.NotTheBacker);
    // after the horizon anyone releases: the unrecovered part stops routing, the Draw closes, the slot can close
    await waitUntil(slot.expiry + 2n + 5n + 5n);
    const rel = await releaseBacked(connection, c.stranger, backing, ref, FAST);
    expect(drawReleasedEvents(rel.logs)[0]).toMatchObject({ reason: 0, forgone: 532n * U - 117n * U, closed: true });
    await send(connection, c.lender, [closeSlotIx(c.lender.publicKey, ref, { asset: c.mint, tokenProgram: SPL_TOKEN_PROGRAM_ID }, FAST, safetyPoolFor(LOAN))]);
    const bb = await bal(c.backerAta);
    await backer.close();
    expect(await bal(c.backerAta)).toBe(bb + 202n * U);
  });

  it('partial cover at 20% (localnet only): a full default pays the lender exactly 20% of its due', async () => {
    const c = await cast({ programId: FAST });
    const ref = await openSlot(c.lender, FAST);
    const { borrower, backing, vault } = await openLine(c, 2n, { coverBps: 2_000, feeBps: 0, stake: 100n * U, ttl: 3_600n, allowPartialCover: true });
    await borrower.request(ref, 500n * U, 0, 1n);
    // a lender insisting on full cover refuses the line
    await expect(fundBacked(connection, c.lender, backing, ref, { programId: FAST })).rejects.toThrow(/below your minimum/);
    // and the program refuses it too when the SDK check is bypassed
    const d = decodeDraw((await connection.getAccountInfo(drawPda(backing, ref, FAST)))!.data);
    const expect0 = { advance: d.advance, principal: 500n * U, term: d.term, payoutTo: d.payoutTo, coverBps: 2_000, minCoverBps: 10_000 };
    await expectCode(send(connection, c.lender, [fundBackedIx({ lender: c.lender.publicKey, loanRef: ref, backing, mint: c.mint, tokenProgram: SPL_TOKEN_PROGRAM_ID, lenderSource: c.lenderAta, expect: expect0 }, FAST)]), BACKER_ERROR.CoverTooLow);
    await fundBacked(connection, c.lender, backing, ref, { programId: FAST, minCoverBps: 2_000 });
    await waitUntil((await readSlot(ref, FAST)).expiry + 2n);
    const lb = await bal(c.lenderAta);
    await claimBacked(connection, c.stranger, backing, ref, FAST);
    expect(await bal(c.lenderAta)).toBe(lb + 100n * U); // 20% of 500
    expect(await bal(vault)).toBe(0n);
    // the backer forgives the unrecoverable 100 and closes the Draw itself
    const l = await readLine(backing);
    const tx = await send(connection, c.payerB, [backSettleIx(ref, backing, l, c.backerKey.publicKey, c.payerA.publicKey, true, FAST)], { signers: [c.backerKey] });
    expect(drawReleasedEvents(tx.logs)[0]).toMatchObject({ forgone: 100n * U, closed: true });
    expect((await readLine(backing)).openDraws).toBe(0);
  });

  it('a request is void after fund_by; then anyone may cancel it', async () => {
    const c = await cast({ programId: FAST });
    const ref = await openSlot(c.lender, FAST);
    const { borrower, backing } = await openLine(c, 3n, { ttl: 3_600n });
    await borrower.request(ref, 50n * U, 0, 60n, { ttl: 12n });
    const d = decodeDraw((await connection.getAccountInfo(drawPda(backing, ref, FAST)))!.data);
    await expectCode(send(connection, c.stranger, [backSettleIx(ref, backing, { asset: c.mint, tokenProgram: SPL_TOKEN_PROGRAM_ID }, c.stranger.publicKey, d.payer, false, FAST)]), BACKER_ERROR.NotReleasable);
    await waitUntil(d.fundBy + 1n);
    await expectCode(fundBacked(connection, c.lender, backing, ref, { programId: FAST }), BACKER_ERROR.RequestExpired);
    await send(connection, c.stranger, [backSettleIx(ref, backing, { asset: c.mint, tokenProgram: SPL_TOKEN_PROGRAM_ID }, c.stranger.publicKey, d.payer, false, FAST)]);
    expect((await readLine(backing)).reserved).toBe(0n);
  });

  it('a frozen lender account does not let the cover lapse: the claim is paid into the inbox as held, the lender collects it', async () => {
    const c = await cast({ programId: FAST });
    const ref = await openSlot(c.lender, FAST);
    const { borrower, backing } = await openLine(c, 4n, { feeBps: 0, stake: 200n * U, ttl: 3_600n });
    await borrower.request(ref, 100n * U, 0, 1n);
    await fundBacked(connection, c.lender, backing, ref, { programId: FAST });
    await waitUntil((await readSlot(ref, FAST)).expiry + 2n);
    await send(connection, c.authority, [freezeIx(c.lenderAta, c.mint, c.authority.publicKey)]);
    const tx = await claimBacked(connection, c.stranger, backing, ref, FAST);
    expect(backingClaimedEvents(tx.logs)[0]).toMatchObject({ amount: 100n * U, held: true });
    expect(await bal(slotInbox(ref, c.mint, SPL_TOKEN_PROGRAM_ID, FAST))).toBe(100n * U);
    await send(connection, c.authority, [freezeIx(c.lenderAta, c.mint, c.authority.publicKey, true)]);
    // a sync does not treat the held payout as a receipt
    await send(connection, c.stranger, [syncIx(c.stranger.publicKey, ref, c.mint, c.lender.publicKey, SPL_TOKEN_PROGRAM_ID, FAST, (await readSub(ref, FAST)).to)]);
    expect((await readSlot(ref, FAST)).repaid).toBe(0n);
    const { collectIx } = await import('../../src/solana/lender.js');
    const lb = await bal(c.lenderAta);
    await send(connection, c.lender, [collectIx(c.lender.publicKey, ref, c.mint, c.lenderAta, SPL_TOKEN_PROGRAM_ID, FAST)]);
    expect(await bal(c.lenderAta)).toBe(lb + 100n * U);
  });
});

suite('four wallets: one line, two lenders', () => {
  it('reserves add up per draw, free stake bounds new draws and withdrawals, a lender cancels a draw on its slot', async () => {
    const c = await cast();
    const [lender2] = await newKeys(1);
    const l2Ata = associatedTokenAddress(lender2.publicKey, c.mint);
    await send(connection, c.authority, [createAtaIx(c.authority.publicKey, lender2.publicKey, c.mint), mintToIx(c.mint, l2Ata, c.authority.publicKey, 1_000n * U)]);
    const r1 = await openSlot(c.lender);
    const r2 = await openSlot(lender2);
    const r3 = await openSlot(c.lender);
    const { backer, borrower, backing } = await openLine(c, 11n, { feeBps: 0, stake: 1_000n * U });
    await borrower.request(r1, 300n * U, 0, 2n * 86_400n);
    await borrower.request(r2, 400n * U, 0, 2n * 86_400n);
    expect((await readLine(backing)).reserved).toBe(700n * U);
    await expectCode(borrower.request(r3, 400n * U, 0, 2n * 86_400n), BACKER_ERROR.StakeShort);
    await expectCode(backer.withdraw(301n * U), BACKER_ERROR.StakeShort);
    await fundBacked(connection, c.lender, backing, r1);
    // lender 2 refuses: it cancels the draw on its own slot
    const d2 = decodeDraw((await connection.getAccountInfo(drawPda(backing, r2)))!.data);
    await send(connection, lender2, [backSettleIx(r2, backing, { asset: c.mint, tokenProgram: SPL_TOKEN_PROGRAM_ID }, lender2.publicKey, d2.payer)]);
    expect((await readLine(backing)).reserved).toBe(300n * U);
    await backer.withdraw(700n * U);
    expect((await readLine(backing)).openDraws).toBe(1);
    // the funded draw cannot be cancelled
    const d1 = decodeDraw((await connection.getAccountInfo(drawPda(backing, r1)))!.data);
    await expectCode(send(connection, c.lender, [backSettleIx(r1, backing, { asset: c.mint, tokenProgram: SPL_TOKEN_PROGRAM_ID }, c.lender.publicKey, d1.payer)]), BACKER_ERROR.NotReleasable);
  });
});

suite('guards', () => {
  it('line terms, keys, limits, payout and lender pin', async () => {
    const c = await cast();
    const ref = await openSlot(c.lender);
    const now = await chainNow();
    const open = (o: Partial<Parameters<typeof backOpenIx>[3]>) => send(connection, c.payerB, [backOpenIx(c.backerKey.publicKey, c.payerB.publicKey, c.mint, {
      nonce: 99n, coverBps: 10_000, feeBps: 0, expiry: now + 86_400n * 10n, drawKey: c.drawKey.publicKey, maxAdvance: 10n * U, maxTotal: 10n * U, ...o,
    })], { signers: [c.backerKey] });
    await expectCode(open({ coverBps: 1_999 }), BACKER_ERROR.BackingTerms);
    await expectCode(open({ coverBps: 10_001 }), BACKER_ERROR.BackingTerms);
    await expectCode(open({ feeBps: 2_001 }), BACKER_ERROR.BackingTerms);
    await expectCode(open({ expiry: now + 181n * 86_400n }), BACKER_ERROR.BackingTerms);
    await expectCode(open({ maxAdvance: U - 1n }), BACKER_ERROR.BackingTerms);
    await expectCode(open({ maxTotal: 5n * U }), BACKER_ERROR.BackingTerms);
    await expectCode(open({ drawKey: PublicKey.default }), BACKER_ERROR.BackingTerms);

    const { borrower, backing } = await openLine(c, 21n, { feeBps: 0, maxAdvance: 200n * U, maxTotal: 250n * U });
    const line = { backing, backer: c.backerKey.publicKey, asset: c.mint, tokenProgram: SPL_TOKEN_PROGRAM_ID };
    const payout = associatedTokenAddress(c.drawKey.publicKey, c.mint);
    const fundBy = (await chainNow()) + 600n;
    const req = (o: Partial<Parameters<typeof backRequestIx>[3]>, key = c.drawKey) => send(connection, c.payerA, [backRequestIx(line, key.publicKey, c.payerA.publicKey, {
      loanRef: ref, advance: 10n * U, lenderFeeBps: 0, term: 2n * 86_400n, fundBy, payoutTo: payout, ...o,
    })], { signers: [key] });
    await expectCode(req({}, c.stranger), BACKER_ERROR.NotTheDrawKey);
    await expectCode(req({ advance: U - 1n }), BACKER_ERROR.DrawTooLarge);
    await expectCode(req({ advance: 201n * U }), BACKER_ERROR.DrawTooLarge);
    await expectCode(req({ lenderFeeBps: 2_001 }), BACKER_ERROR.BackingTerms);
    await expectCode(req({ term: 86_399n }), BACKER_ERROR.LineExpired);
    await expectCode(req({ term: 31n * 86_400n }), BACKER_ERROR.LineExpired);
    await expectCode(req({ fundBy: (await chainNow()) + 8n * 86_400n }), BACKER_ERROR.BackingTerms);
    await expectCode(req({ payoutTo: c.lenderAta }), 6005); // BadPayout: owned by the lender
    await expectCode(req({ payoutTo: backingVault(backing, c.mint) }), 6005);
    await expectCode(req({ payoutTo: c.backerAta }), 6005); // owned by the backer

    // B3: the borrower cancels and re-requests bigger; the lender's fund at the terms it read is refused
    await borrower.request(ref, 10n * U, 0, 2n * 86_400n);
    const d = decodeDraw((await connection.getAccountInfo(drawPda(backing, ref)))!.data);
    await borrower.cancel(ref);
    await borrower.request(ref, 200n * U, 0, 2n * 86_400n);
    const stale = { advance: d.advance, principal: d.advance, term: d.term, payoutTo: d.payoutTo, coverBps: 10_000, minCoverBps: 10_000 };
    await expectCode(send(connection, c.lender, [fundBackedIx({ lender: c.lender.publicKey, loanRef: ref, backing, mint: c.mint, tokenProgram: SPL_TOKEN_PROGRAM_ID, lenderSource: c.lenderAta, expect: stale })]), BACKER_ERROR.TermsMismatch);
    await expect(fundBacked(connection, c.lender, backing, ref, { expect: { advance: 10n * U, payoutTo: d.payoutTo } })).rejects.toThrow(/changed/);

    // B4: a stranger's own line requests on the same slot: it does not block this one, and the lender can cancel it
    const s = await cast();
    const stLine = new SolanaBacker(connection, s.backerKey, 1n, s.payerB, LOAN);
    // the stranger's line uses another mint, so the cast's mint is reused here instead
    await stLine.open(c.mint, { coverBps: 10_000, feeBps: 0, expiry: (await chainNow()) + 86_400n * 5n, drawKey: s.drawKey.publicKey, maxAdvance: 10n * U, maxTotal: 10n * U });
    await send(connection, c.authority, [createAtaIx(c.authority.publicKey, s.backerKey.publicKey, c.mint), mintToIx(c.mint, associatedTokenAddress(s.backerKey.publicKey, c.mint), c.authority.publicKey, 10n * U)]);
    await stLine.stake(associatedTokenAddress(s.backerKey.publicKey, c.mint), s.backerKey, 10n * U);
    const grief = new SolanaBackedBorrower(connection, s.drawKey, stLine.backing, s.payerA, LOAN);
    await grief.request(ref, U, 0, 2n * 86_400n);
    const g = decodeDraw((await connection.getAccountInfo(drawPda(stLine.backing, ref)))!.data);
    await send(connection, c.lender, [backSettleIx(ref, stLine.backing, { asset: c.mint, tokenProgram: SPL_TOKEN_PROGRAM_ID }, c.lender.publicKey, g.payer)]);
    // a stranger cannot cancel the real borrower's live request
    const real = decodeDraw((await connection.getAccountInfo(drawPda(backing, ref)))!.data);
    await expectCode(send(connection, c.stranger, [backSettleIx(ref, backing, { asset: c.mint, tokenProgram: SPL_TOKEN_PROGRAM_ID }, c.stranger.publicKey, real.payer)]), BACKER_ERROR.NotReleasable);
    // the over-limit total: 200 funded, then 60 more would pass max_total 250
    await fundBacked(connection, c.lender, backing, ref);
    const ref2 = await openSlot(c.lender);
    await expectCode(borrower.request(ref2, 60n * U, 0, 2n * 86_400n), BACKER_ERROR.DrawTooLarge);

    // a line pinned to another lender
    const p = await cast();
    const pref = await openSlot(p.lender);
    const pinned = await openLine(p, 31n, { lender: c.lender.publicKey });
    await expectCode(pinned.borrower.request(pref, 10n * U, 0, 2n * 86_400n), BACKER_ERROR.LenderNotAllowed);
    // a co-signed line needs the backer on every request
    const cs = await openLine(p, 32n, { cosign: true });
    await expectCode(cs.borrower.request(pref, 10n * U, 0, 2n * 86_400n), BACKER_ERROR.NotTheBacker);
    await cs.borrower.request(pref, 10n * U, 0, 2n * 86_400n, { backer: p.backerKey });
    // the SDK refuses partial cover unless asked
    await expect(new SolanaBacker(connection, p.backerKey, 33n, p.payerB).open(p.mint, { coverBps: 5_000, feeBps: 0, expiry: (await chainNow()) + 86_400n * 5n, drawKey: p.drawKey.publicKey, maxAdvance: U, maxTotal: U })).rejects.toThrow(/below 100%/);
  });

  it('dust sent to a vault cannot block the close: it is swept to the backer', async () => {
    const c = await cast();
    const { backer, vault } = await openLine(c, 41n, { stake: 5n * U });
    await send(connection, c.authority, [mintToIx(c.mint, vault, c.authority.publicKey, 1n)]);
    const bb = await bal(c.backerAta);
    await backer.close();
    expect(await bal(c.backerAta)).toBe(bb + 5n * U + 1n);
  });

  it('a slot already funded by a backed draw refuses a second line\'s request', async () => {
    const c = await cast();
    const ref = await openSlot(c.lender);
    const { borrower, backing } = await openLine(c, 51n, { feeBps: 0 });
    await borrower.request(ref, 10n * U, 0, 2n * 86_400n);
    await fundBacked(connection, c.lender, backing, ref);
    const { borrower: b2 } = await openLine(c, 52n, { feeBps: 0 });
    await expectCode(b2.request(ref, 10n * U, 0, 2n * 86_400n), 6001); // AlreadyFunded
  });
});

afterAll(() => {
  if (Object.keys(CU).length >= 6) writeFileSync(resolve(SOLANA_DIR, 'compute-units-backer.json'), JSON.stringify({ measured: new Date().toISOString(), rpc: RPC, computeUnits: CU }, null, 2) + '\n');
});
// terms used above, cross-checked against the shared math
it('the worked example of the spec', () => {
  expect(backedTerms({ advance: 500n * U, feeBps: 500, lenderFeeBps: 300, coverBps: 10_000 })).toMatchObject({ principal: 540n * U, reserve: 515n * U, toPayout: 498_750_000n });
  expect(backingPda(LOAN, 1n).equals(backingPda(LOAN, 1n))).toBe(true);
});
