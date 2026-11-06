// Two agents, one loan, through the agent operations (runOp: what the MCP tools and Agent Kit actions call) on a private
// solana-test-validator: agent A lends (h081_lend), agent B borrows (h081_loan_borrow) and pays from the pledged allowance
// (h081_pay allowPledged); A collects, claims and settles. Real H081Bank instances, real proofs (build/circuits).
// Localnet only: skipped unless STIPEND_LOAN_RPC is set (vitest.solana-loan.config.ts sets it to 127.0.0.1:9099; that
// validator loads stipend_pool and stream_loan at the localnet ids, see solana/scripts/loan-start-validator.sh).
import { beforeAll, describe, expect, it } from 'vitest';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { initCrypto } from '../../src/crypto.js';
import { Prover } from '../../src/prover.js';
import { LOCALNET_POOL_PROGRAM_ID, SolanaPool, send } from '../../src/solana/index.js';
import {
  LOAN_TREASURY, LOCALNET_LOAN_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, associatedTokenAddress, decodeRegistry, decodeSlot,
  loanInitializeIx, loanTreasuryAccount, registryPda, slotInbox, slotPda,
} from '../../src/solana/lender.js';
import { LOCALNET_CAPACITY_STAKE_PROGRAM_ID, LOCALNET_SAFETY_POOL_PROGRAM_ID } from '../../src/solana/token.js';
import { LOCALNET_UPGRADE_AUTHORITY } from '../solana/config-authority.js';
import { H081Bank, type BorrowResult, type LendFundResult, type LendOpenResult, type LendPlanResult, type LendSentResult, type LendSlotView, type PayResult } from '../../integrations/core/bank.js';
import { MAINNET_GENESIS, type H081Config } from '../../integrations/core/constants.js';
import { deriveAccountSk } from '../../integrations/core/keys.js';
import { runOp } from '../../integrations/core/operations.js';

const RPC = process.env.STIPEND_LOAN_RPC;
// localnet only: refuse anything that is not a loopback RPC, even when the variable is set
const LOCAL = !!RPC && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(RPC);
const suite = describe.skipIf(!LOCAL);

const U = 1_000_000n;
const connection = new Connection(RPC ?? 'http://127.0.0.1:9099', 'confirmed');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function airdrop(...keys: PublicKey[]) {
  for (const k of keys) {
    const sig = await connection.requestAirdrop(k, 10 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction({ signature: sig, ...(await connection.getLatestBlockhash()) }, 'confirmed');
  }
}
async function tokenBalance(account: PublicKey): Promise<bigint> {
  const info = await connection.getAccountInfo(account, 'confirmed');
  return info ? Buffer.from(info.data).readBigUInt64LE(64) : 0n;
}
function createAtaIx(payer: PublicKey, owner: PublicKey, mint: PublicKey) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true }, { pubkey: associatedTokenAddress(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}
function mintToIx(mint: PublicKey, to: PublicKey, authority: PublicKey, amount: bigint) {
  const data = Buffer.alloc(9); data[0] = 7; data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({ programId: SPL_TOKEN_PROGRAM_ID, keys: [{ pubkey: mint, isSigner: false, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }, { pubkey: authority, isSigner: true, isWritable: false }], data });
}
async function createMint(authority: Keypair): Promise<PublicKey> {
  const mint = Keypair.generate();
  const data = Buffer.alloc(67); data[0] = 20; data[1] = 6; authority.publicKey.toBuffer().copy(data, 2); // InitializeMint2, no freeze authority
  await send(connection, authority, [
    SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: mint.publicKey, lamports: await connection.getMinimumBalanceForRentExemption(82), space: 82, programId: SPL_TOKEN_PROGRAM_ID }),
    new TransactionInstruction({ programId: SPL_TOKEN_PROGRAM_ID, keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }], data }),
  ], { signers: [mint] });
  return mint.publicKey;
}

suite('two agents lend and borrow through h081_lend and h081_loan_borrow (localnet)', () => {
  const authority = Keypair.generate();
  const lenderKp = Keypair.generate(); // agent A
  const borrowerKp = Keypair.generate(); // agent B
  const vendorKp = Keypair.generate(); // whoever B pays
  let usdg: PublicKey;
  let A: H081Bank;
  let B: H081Bank;
  let loanRef: string;
  let termsCode: string;
  let borrowed: BorrowResult;
  const BPS = 4000; // 40% of every borrower payment goes to the lender
  const principal = 20n * U;
  const fee = principal / 400n; // 0.25%

  const open = async (signer: Keypair, cfg: H081Config) => H081Bank.open({ config: cfg, signer, accountSk: deriveAccountSk(signer), prover: new Prover(), cacheDir: null });
  const slotOf = async (ref: string) => decodeSlot((await connection.getAccountInfo(slotPda(BigInt(ref)), 'confirmed'))!.data);

  beforeAll(async () => {
    await initCrypto();
    const genesis = await connection.getGenesisHash();
    if (genesis === MAINNET_GENESIS) throw new Error('refusing: this RPC is mainnet');
    for (const id of [LOCALNET_POOL_PROGRAM_ID, LOCALNET_LOAN_PROGRAM_ID]) {
      if (!(await connection.getAccountInfo(id))?.executable) throw new Error(`program ${id.toBase58()} is not loaded on ${RPC}`);
    }
    await airdrop(authority.publicKey, lenderKp.publicKey, borrowerKp.publicKey, LOCALNET_UPGRADE_AUTHORITY.publicKey);
    // both programs are upgradeable on this validator; only their upgrade authority initializes them (no-op when done)
    await new SolanaPool(connection).initialize(LOCALNET_UPGRADE_AUTHORITY);
    if (!(await connection.getAccountInfo(registryPda(), 'confirmed'))) await send(connection, LOCALNET_UPGRADE_AUTHORITY, [loanInitializeIx(LOCALNET_UPGRADE_AUTHORITY.publicKey)]);
    usdg = await createMint(authority);
    await send(connection, authority, [
      createAtaIx(authority.publicKey, lenderKp.publicKey, usdg), createAtaIx(authority.publicKey, borrowerKp.publicKey, usdg), createAtaIx(authority.publicKey, vendorKp.publicKey, usdg),
      mintToIx(usdg, associatedTokenAddress(lenderKp.publicKey, usdg), authority.publicKey, 1_000n * U),
      mintToIx(usdg, associatedTokenAddress(borrowerKp.publicKey, usdg), authority.publicKey, 500n * U),
    ]);
    const cfg: H081Config = {
      cluster: 'localnet', rpcUrl: RPC!, relayerUrl: undefined, circuitsDir: 'build/circuits', circuitsUrl: 'http://127.0.0.1:1/',
      poolProgramId: LOCALNET_POOL_PROGRAM_ID, loanProgramId: LOCALNET_LOAN_PROGRAM_ID, capacityProgramId: LOCALNET_CAPACITY_STAKE_PROGRAM_ID,
      safetyProgramId: LOCALNET_SAFETY_POOL_PROGRAM_ID, usdgMint: usdg, stakeMint: usdg, loanTreasury: LOAN_TREASURY, decimals: 6,
    };
    A = await open(lenderKp, cfg);
    B = await open(borrowerKp, cfg);
    // B shields USDG first: the pledged allowance comes out of the shielded balance
    const dep = await runOp(B, 'h081_bank_deposit', { usdg: '300' }) as { shielded: bigint };
    expect(dep.shielded).toBe(300n * U);
  });

  it('A opens a slot: a dry run sends nothing; confirm returns the "h081-loan-terms:" code', async () => {
    const before = decodeRegistry((await connection.getAccountInfo(registryPda(), 'confirmed'))!.data).nextLoanRef;
    const plan = await runOp(A, 'h081_lend', { action: 'open', pledgeBps: BPS }) as LendPlanResult;
    expect(plan.sent).toBe(false);
    expect(plan.dryRun).toBe(true);
    expect(plan.plan.loanRef).toBe(before);
    expect(decodeRegistry((await connection.getAccountInfo(registryPda(), 'confirmed'))!.data).nextLoanRef).toBe(before);
    expect(await connection.getAccountInfo(slotPda(before), 'confirmed')).toBeNull();

    const r = await runOp(A, 'h081_lend', { action: 'open', pledgeBps: BPS, confirm: true }) as LendOpenResult;
    expect(r.sent).toBe(true);
    expect(r.loanRef).toBe(before);
    expect(r.termsCode).toMatch(/^h081-loan-terms:/);
    loanRef = r.loanRef.toString();
    termsCode = r.termsCode;
    const s = await slotOf(loanRef);
    expect(s.lender.equals(lenderKp.publicKey)).toBe(true);
    expect(s.funded).toBe(false);
    // status gives the same terms code again for an open slot
    const st = await runOp(A, 'h081_lend', { action: 'status', loanRef, pledgeBps: BPS }) as { slots: LendSlotView[] };
    expect(st.slots).toHaveLength(1);
    expect(st.slots[0].state).toBe('open');
    expect(st.slots[0].termsCode).toBe(termsCode);
    // the listing without loanRef finds it too (getProgramAccounts on the lender key)
    const all = await runOp(A, 'h081_lend', { action: 'status' }) as { slots: LendSlotView[] };
    expect(all.slots.map((x) => x.loanRef.toString())).toContain(loanRef);
  });

  it('B borrows with the terms code and gets an "h081-loan-proof:" code; B (not the slot lender) cannot fund it', async () => {
    // a budget bigger than the principal needs (100 at 40% would let A take 40 for a 20 loan) is refused, nothing granted
    await expect(runOp(B, 'h081_loan_borrow', { termsCode, budgetUsdg: '100', principalUsdg: '20', days: 1, unlockDays: 0.002 })).rejects.toThrow(/Overpay/);
    // without a budget it is sized to the principal: 20 / 40% = 50
    borrowed = await runOp(B, 'h081_loan_borrow', { termsCode, principalUsdg: '20', days: 1, unlockDays: 0.002 }) as BorrowResult;
    expect(borrowed.proofCode).toMatch(/^h081-loan-proof:[1-9A-HJ-NP-Za-km-z]+$/);
    expect(borrowed.loanRef.toString()).toBe(loanRef);
    expect(borrowed.principal).toBe(principal);
    expect(borrowed.payoutAccount).toBe(associatedTokenAddress(borrowerKp.publicKey, usdg).toBase58());
    const bal = await runOp(B, 'h081_bank_balance', {}) as { shielded: bigint; subAccounts: Array<{ pledgeBps: bigint; loanRef?: bigint }> };
    expect(bal.shielded).toBe(250n * U); // 300 deposited - the 50 budget
    expect(bal.subAccounts.some((x) => x.pledgeBps === BigInt(BPS) && x.loanRef === BigInt(loanRef))).toBe(true);
    await expect(runOp(B, 'h081_lend', { action: 'fund', proofCode: borrowed.proofCode, confirm: true })).rejects.toThrow(/belongs to another lender/);
  });

  it('A funds: without confirm nothing moves; with confirm B receives the principal minus 0.25%', async () => {
    const lenderAta = associatedTokenAddress(lenderKp.publicKey, usdg);
    const payout = new PublicKey(borrowed.payoutAccount);
    const treasury = loanTreasuryAccount(usdg);
    const [l0, p0, t0] = await Promise.all([tokenBalance(lenderAta), tokenBalance(payout), tokenBalance(treasury)]);
    // asking for another amount than the proof backs is refused before anything is sent
    await expect(runOp(A, 'h081_lend', { action: 'fund', proofCode: borrowed.proofCode, principalUsdg: '21', confirm: true })).rejects.toThrow(/exactly 20 USDG/);
    const plan = await runOp(A, 'h081_lend', { action: 'fund', proofCode: borrowed.proofCode }) as LendPlanResult;
    expect(plan.sent).toBe(false);
    expect(plan.plan.principal).toBe(principal);
    expect(plan.plan.borrowerReceives).toBe(principal - fee);
    expect(String(plan.plan.proofChecked)).toMatch(/verified locally/);
    expect([await tokenBalance(lenderAta), await tokenBalance(payout), await tokenBalance(treasury)]).toEqual([l0, p0, t0]);
    expect((await slotOf(loanRef)).funded).toBe(false);

    const r = await runOp(A, 'h081_lend', { action: 'fund', proofCode: borrowed.proofCode, confirm: true }) as LendFundResult;
    expect(r.sent).toBe(true);
    expect(await tokenBalance(lenderAta)).toBe(l0 - principal);
    expect(await tokenBalance(payout)).toBe(p0 + principal - fee);
    expect(await tokenBalance(treasury)).toBe(t0 + fee);
    const s = await slotOf(loanRef);
    expect(s.funded).toBe(true);
    expect(s.principal).toBe(principal);
    expect(s.payoutTo.equals(payout)).toBe(true);
    // the same proof cannot fund twice
    await expect(runOp(A, 'h081_lend', { action: 'fund', proofCode: borrowed.proofCode, confirm: true })).rejects.toThrow(/AlreadyFunded/);
  });

  it('B pays from the pledged allowance only with allowPledged; 40% of the payment is routed to the slot', async () => {
    const vendor = vendorKp.publicKey;
    const vendorAta = associatedTokenAddress(vendor, usdg);
    const pay = { usdg: '5', to: vendor.toBase58(), agentIndex: borrowed.agentIndex };
    // the 50 budget unlocks over ~173 s: wait until 5 has unlocked (the error then names allowPledged, not the stream)
    for (let i = 0; i < 40; i++) {
      const e = await runOp(B, 'h081_pay', pay).then(() => null, (err: Error) => err.message);
      if (e && /allowPledged/.test(e)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    await expect(runOp(B, 'h081_pay', pay)).rejects.toThrow(/allowPledged/);
    expect(await tokenBalance(vendorAta)).toBe(0n);
    const inbox = slotInbox(BigInt(loanRef), usdg);
    const r = await runOp(B, 'h081_pay', { ...pay, allowPledged: true }) as PayResult;
    expect(r.lenderShare).toBe(2n * U);
    expect(r.linkedToLoan).toBe(BigInt(loanRef));
    expect(await tokenBalance(vendorAta)).toBe(3n * U);
    expect(await tokenBalance(inbox)).toBe(2n * U);
  });

  it('A collects the routed share, claims the vested share of the stream, and settles once repaid', async () => {
    const lenderAta = associatedTokenAddress(lenderKp.publicKey, usdg);
    let st = (await runOp(A, 'h081_lend', { action: 'status', loanRef }) as { slots: LendSlotView[] }).slots[0];
    expect(st.state).toBe('funded');
    expect(st.collectable).toBe(2n * U);
    const l0 = await tokenBalance(lenderAta);
    const c = await runOp(A, 'h081_lend', { action: 'collect', loanRef }) as LendSentResult;
    expect(c.collected).toBe(2n * U);
    expect(await tokenBalance(lenderAta)).toBe(l0 + 2n * U);
    expect((await slotOf(loanRef)).repaid).toBe(2n * U);
    await expect(runOp(A, 'h081_lend', { action: 'collect', loanRef })).rejects.toThrow(/nothing has been routed/);

    // the budget streams in over ~173 s; claim once at least the rest of the principal (18 USDG) has vested to the lender
    for (let i = 0; i < 60; i++) {
      st = (await runOp(A, 'h081_lend', { action: 'status', loanRef }) as { slots: LendSlotView[] }).slots[0];
      if (st.claimable >= 18n * U) break;
      await sleep(5000);
    }
    expect(st.claimable).toBeGreaterThanOrEqual(18n * U);
    // a claim over what is claimable is refused
    await expect(runOp(A, 'h081_lend', { action: 'claim', loanRef, amount: (st.claimable + 10n * U).toString() })).rejects.toThrow(/claimable now/);
    const l1 = await tokenBalance(lenderAta);
    const cl = await runOp(A, 'h081_lend', { action: 'claim', loanRef, usdg: '18' }) as LendSentResult;
    expect(cl.collected).toBe(18n * U);
    // the claim lands in the slot inbox; collect forwards it (unless the claim already did)
    const after = await tokenBalance(lenderAta);
    if (after - l1 < 18n * U) await runOp(A, 'h081_lend', { action: 'collect', loanRef });
    expect(await tokenBalance(lenderAta)).toBe(l1 + 18n * U);
    const s = await slotOf(loanRef);
    expect(s.repaid).toBe(principal);
    st = (await runOp(A, 'h081_lend', { action: 'status', loanRef }) as { slots: LendSlotView[] }).slots[0];
    expect(st.state).toBe('repaid');
    expect(st.outstanding).toBe(0n);
    // the budget was sized to the principal, so once repaid nothing more is claimable: the lender got exactly 20
    expect(st.claimable).toBe(0n);

    // settle: the plan first (nothing sent), then confirm
    const plan = await runOp(A, 'h081_lend', { action: 'settle', loanRef }) as LendPlanResult;
    expect(plan.sent).toBe(false);
    expect(plan.plan.outstanding).toBe(0n);
    expect((await slotOf(loanRef)).settled).toBe(false);
    const done = await runOp(A, 'h081_lend', { action: 'settle', loanRef, confirm: true }) as LendSentResult;
    expect(done.sent).toBe(true);
    expect(done.slot?.state).toBe('settled');
    expect((await slotOf(loanRef)).settled).toBe(true);
    await expect(runOp(A, 'h081_lend', { action: 'settle', loanRef, confirm: true })).rejects.toThrow(/already settled/);
  });
});
