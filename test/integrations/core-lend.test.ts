// H081Bank as a lender (h081_lend) against a fake connection, and a loan between two agents: agent A opens a slot and
// hands its framed "h081-loan-terms:" code to agent B, B pledges (h081_loan_borrow) and hands back a framed
// "h081-loan-proof:" code, A funds against it, then claims, collects and settles. The codes are real (v2 frame, the
// loan program's network tag); the SDK calls that would prove or send (grant, proveStream, openSlot, fund, claim,
// syncLoan, collect, settle) and the lender's event scan are mocked: nothing is proven or sent.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { type Allowance, allowanceCommitment } from '../../src/crypto.js';
import { minRemainingFor } from '../../src/inputs.js';
import { fieldOf } from '../../src/solana/field.js';
import { type SolLenderNote, maxPrincipal, payoutAudience, registryPda, slotInbox, slotPda } from '../../src/solana/lender.js';
import type { StreamArgs } from '../../src/solana/program.js';
import type { SolOwnedAllowance } from '../../src/solana/wallet.js';
import { H081Bank } from '../../integrations/core/bank.js';
import { FlatDirProver } from '../../integrations/core/circuits.js';
import { decodeLoanProof, decodeLoanTerms, encodeLoanProof } from '../../integrations/core/codes.js';
import { MAINNET } from '../../integrations/core/constants.js';
import { deriveAccountSk } from '../../integrations/core/keys.js';
import { plain, runOp } from '../../integrations/core/operations.js';
import { USDG, fakeConnection, testConfig, tokenAccountData } from './helpers.js';

const NOW = 1_800_000_000n;
const DAY = 86_400n;
const USD = (x: number) => BigInt(Math.round(x * 1e6));
const LOAN = new PublicKey(MAINNET.programs.loan);
const tx = (signature: string) => ({ signature, computeUnits: 1, logs: [] as string[] });

const u64 = (x: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(x); return b; };
const u128 = (x: bigint) => Buffer.concat([u64(x & ((1n << 64n) - 1n)), u64(x >> 64n)]);
const be32 = (x: bigint) => Buffer.from(x.toString(16).padStart(64, '0'), 'hex');

/** A stream_loan Slot account (Anchor layout after the 8-byte discriminator). */
function slotData(s: {
  loanRef: bigint; lender: PublicKey; funded?: boolean; settled?: boolean; principal?: bigint; repaid?: bigint; minRemaining?: bigint; minRate?: bigint;
  pledgeBps?: number; expiry?: bigint; payoutTo?: PublicKey;
}): Buffer {
  const i64 = Buffer.alloc(8); i64.writeBigInt64LE(s.funded ? NOW : 0n);
  const bps = Buffer.alloc(2); bps.writeUInt16LE(s.pledgeBps ?? 0);
  return Buffer.concat([
    Buffer.alloc(8), u64(s.loanRef), s.lender.toBuffer(), Buffer.from([255, s.funded ? 1 : 0, s.settled ? 1 : 0]),
    (s.funded ? USDG : PublicKey.default).toBuffer(), (s.funded ? TOKEN_2022_PROGRAM_ID : PublicKey.default).toBuffer(),
    u64(s.principal ?? 0n), u64(s.repaid ?? 0n), u128(s.minRemaining ?? 0n), u128(s.minRate ?? 0n), bps, u64(s.expiry ?? 0n), be32(0n), i64,
    (s.payoutTo ?? PublicKey.default).toBuffer(), u64(0n),
  ]);
}

function circuitsDir(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'h081-lend-'));
  for (const n of names) for (const ext of ['wasm', 'zkey', 'vkey.json']) writeFileSync(join(dir, `${n}.${ext}`), '');
  return dir;
}
const NO_CIRCUITS = 'C:/nonexistent/h081-lend-circuits';

type Conn = ReturnType<typeof fakeConnection>;

async function openAgent(opts: { maxLend?: bigint; walletUsdg?: bigint; lamports?: number; circuits?: string; signer?: Keypair } = {}) {
  const signer = opts.signer ?? Keypair.generate();
  const conn = fakeConnection(signer, { now: NOW, walletUsdg: opts.walletUsdg ?? USD(500), lamports: opts.lamports });
  conn.accounts.set(registryPda(LOAN).toBase58(), { owner: LOAN, data: Buffer.concat([Buffer.alloc(8), u64(3n)]), executable: false, lamports: 1 });
  const bank = await H081Bank.open({
    config: testConfig({ maxLend: opts.maxLend }), signer, accountSk: deriveAccountSk(signer),
    connection: conn as unknown as Connection, prover: new FlatDirProver(opts.circuits ?? NO_CIRCUITS), cacheDir: null,
  });
  vi.spyOn(bank.owner, 'sync').mockResolvedValue(undefined);
  vi.spyOn(bank.lender(), 'sync').mockResolvedValue(undefined);
  for (let i = 0; i < 16; i++) vi.spyOn(bank.agent(i).wallet, 'sync').mockResolvedValue(undefined);
  return { bank, conn, signer };
}

const putSlot = (conns: Conn[], data: Buffer, ref = 3n) => { for (const c of conns) c.accounts.set(slotPda(ref, LOAN).toBase58(), { owner: LOAN, data, executable: false, lamports: 1 }); };
const putToken = (conns: Conn[], at: PublicKey, owner: PublicKey, amount: bigint) => {
  for (const c of conns) c.accounts.set(at.toBase58(), { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccountData(USDG, owner, amount), executable: false, lamports: 1 });
};

/** A borrower's pledged allowance for slot 3 and the proof code over it (as h081_loan_borrow would make it). */
function pledged(bank: H081Bank, opts: { principal?: bigint; budget?: bigint; bps?: bigint; expiry?: bigint; payout?: PublicKey } = {}) {
  const bps = opts.bps ?? 4000n, budget = opts.budget ?? USD(100);
  const a: Allowance = {
    asset: fieldOf(USDG), remaining: budget, agentPk: 4242n, windowId: 0n, windowSpent: 0n, rho: 99n, pledgePaid: 0n,
    policy: {
      lifetimeCap: budget, windowCap: 0n, windowLen: DAY, maxPerTx: 0n, expiry: opts.expiry ?? NOW + 30n * DAY, recipientRoot: 0n, ownerPk: 7n,
      streamRate: budget / (30n * DAY) + 1n, streamStart: NOW, lender: fieldOf(slotPda(3n, LOAN)), pledgeBps: bps,
    },
  };
  const principal = opts.principal ?? maxPrincipal(budget, bps);
  const payout = opts.payout ?? Keypair.generate().publicKey;
  const args: StreamArgs = {
    root: 1n, minRemaining: minRemainingFor(principal, bps), minRate: a.policy.streamRate, lender: slotPda(3n, LOAN), loanRef: 3n, pledgeBps: Number(bps),
    expiry: a.policy.expiry, lifetimeCap: budget, pledgePaid: 0n, agentPk: a.agentPk, audience: payoutAudience(payout), streamStart: NOW, asset: USDG,
  };
  const proof = { a: [1n, 2n] as [bigint, bigint], b: [[3n, 4n], [5n, 6n]] as [[bigint, bigint], [bigint, bigint]], c: [7n, 8n] as [bigint, bigint] };
  const note: SolLenderNote = {
    allowance: a, commitment: allowanceCommitment(a), index: 5, spent: false, lost: false, views: { owner: new Uint8Array(32), agent: new Uint8Array(32) },
    lender: { lenderAddr: fieldOf(slotPda(3n, LOAN)), loanRef: 3n, viewPub: bank.lender().view.pub }, mint: USDG,
  };
  const proofCode = encodeLoanProof(bank.loanCodeContext, { ref: 3n, payout, proof, args });
  return { a, args, proof, payout, principal, note, proofCode };
}

describe('h081_lend: open', () => {
  it('plans without confirm (next slot, share, no USDG moves), then opens and returns a framed terms code the borrower side reads', async () => {
    const { bank, signer } = await openAgent();
    const open = vi.spyOn(bank.lender(), 'openSlot').mockResolvedValue(3n);
    const plan = await runOp(bank, 'h081_lend', { action: 'open', pledgeBps: 4000 });
    expect(plan).toMatchObject({ sent: false, dryRun: true, plan: { action: 'open', loanRef: 3n, pledgeBps: 4000n, lender: signer.publicKey.toBase58() } });
    expect((plan as { next: string }).next).toMatch(/^nothing was sent/);
    expect(open).not.toHaveBeenCalled();

    const r = await runOp(bank, 'h081_lend', { action: 'open', pledgeBps: 4000, confirm: true }) as { termsCode: string; loanRef: bigint };
    expect(open).toHaveBeenCalledOnce();
    expect(r.loanRef).toBe(3n);
    expect(r.termsCode).toMatch(/^h081-loan-terms:[1-9A-HJ-NP-Za-km-z]+$/);
    const t = decodeLoanTerms(bank.loanCodeContext, r.termsCode);
    expect(t).toEqual({ loanRef: 3n, pledgeBps: 4000n, lenderViewPub: bank.lender().view.pub });
    // the lender viewing key is not the shielded account's: a terms code does not reveal the agent's shielded address
    expect(Buffer.from(t.lenderViewPub).equals(Buffer.from(bank.account.view.pub))).toBe(false);
    // a terms code is for the loan program: the pool-context address decoder and another network refuse it
    expect(() => decodeLoanTerms({ ...bank.loanCodeContext, cluster: 'devnet' }, r.termsCode)).toThrow(/another network, program or asset/);
  });

  it('refuses a share outside 1%..90%, a missing registry, too little SOL, and explains a program error; nothing sent', async () => {
    const { bank, conn } = await openAgent();
    const open = vi.spyOn(bank.lender(), 'openSlot');
    await expect(runOp(bank, 'h081_lend', { action: 'open', pledgeBps: 50 })).rejects.toThrow(/100\.\.9000/);
    await expect(runOp(bank, 'h081_lend', { action: 'open' })).rejects.toThrow(/pledgeBps is required/);
    await expect(runOp(bank, 'h081_lend', { action: 'lend' })).rejects.toThrow(/action must be one of open, fund, status, claim, collect, settle, close/);
    const poor = await openAgent({ lamports: 1_000 });
    await expect(poor.bank.lendOpen({ pledgeBps: 4000n, confirm: true })).rejects.toThrow(/SOL; opening a loan slot needs about 0\.01 SOL.*Nothing was sent/);
    conn.accounts.delete(registryPda(LOAN).toBase58());
    await expect(bank.lendOpen({ pledgeBps: 4000n, confirm: true })).rejects.toThrow(/registry is not initialized.*Nothing was sent/);
    expect(open).not.toHaveBeenCalled();
    const ok = await openAgent();
    vi.spyOn(ok.bank.lender(), 'openSlot').mockRejectedValue(new Error(`Program ${MAINNET.programs.loan} failed: custom program error: 0x1770`));
    await expect(ok.bank.lendOpen({ pledgeBps: 4000n, confirm: true })).rejects.toThrow(/^NotTheLender \(6000, stream_loan\)/);
  });
});

describe('h081_lend: fund', () => {
  it('plans exactly what the proof backs, then funds it with confirm; the SDK gets the proof, USDG, the principal and the payout', async () => {
    const { bank, conn, signer } = await openAgent();
    putSlot([conn], slotData({ loanRef: 3n, lender: signer.publicKey }));
    const p = pledged(bank);
    putToken([conn], p.payout, Keypair.generate().publicKey, 0n);
    vi.spyOn(bank.lender(), 'current').mockReturnValue([p.note]);
    const fund = vi.spyOn(bank.lender(), 'fund').mockResolvedValue(tx('sigFund'));

    const plan = await runOp(bank, 'h081_lend', { action: 'fund', proofCode: p.proofCode }) as { plan: Record<string, unknown> };
    expect(plan).toMatchObject({ sent: false, dryRun: true });
    expect(plan.plan).toMatchObject({
      action: 'fund', loanRef: 3n, principal: USD(40), principalUsdg: '40', originationFee: 100_000n, borrowerReceivesUsdg: '39.9', payoutTo: p.payout.toBase58(),
      pledgeBps: 4000, walletUsdg: USD(500), walletUsdgAfter: USD(460),
    });
    expect(String(plan.plan.proofChecked)).toMatch(/program verifies the proof on chain/);
    expect(String(plan.plan.privacy)).toMatch(/agent wallet is public as the lender/);
    expect(fund).not.toHaveBeenCalled();

    const r = await runOp(bank, 'h081_lend', { action: 'fund', proofCode: p.proofCode, principalUsdg: '40', pledgeBps: 4000, confirm: true });
    expect(r).toMatchObject({ sent: true, signature: 'sigFund', principal: USD(40), borrowerReceives: USD(40) - 100_000n });
    expect(fund).toHaveBeenCalledOnce();
    const [ref, stream, mint, principal, payout] = fund.mock.calls[0];
    expect(ref).toBe(3n);
    expect(stream.proof.proof).toEqual(p.proof);
    expect(stream.args).toEqual(p.args);
    expect(mint.equals(USDG)).toBe(true);
    expect(principal).toBe(USD(40));
    expect((payout as PublicKey).equals(p.payout)).toBe(true);
    expect(() => JSON.stringify(plain(r))).not.toThrow();
  });

  it('refuses before anything is sent: the operator ceiling, another amount, a lower share, the wallet, the slot, the payout, expiry, no backing note', async () => {
    const { bank, conn, signer } = await openAgent({ maxLend: USD(30), walletUsdg: USD(500) });
    putSlot([conn], slotData({ loanRef: 3n, lender: signer.publicKey }));
    const p = pledged(bank);
    putToken([conn], p.payout, Keypair.generate().publicKey, 0n);
    const current = vi.spyOn(bank.lender(), 'current').mockReturnValue([p.note]);
    const fund = vi.spyOn(bank.lender(), 'fund');
    await expect(bank.lendFund({ proofCode: p.proofCode, confirm: true })).rejects.toThrow(/H081_MAX_LEND \(30 USDG per loan; this proof asks for 40 USDG\)\. Nothing was sent/);

    const { bank: b2, conn: c2, signer: s2 } = await openAgent({ walletUsdg: USD(10) });
    putSlot([c2], slotData({ loanRef: 3n, lender: s2.publicKey }));
    const q = pledged(b2);
    vi.spyOn(b2.lender(), 'current').mockReturnValue([q.note]);
    const fund2 = vi.spyOn(b2.lender(), 'fund');
    await expect(b2.lendFund({ proofCode: q.proofCode, principal: USD(39) })).rejects.toThrow(/asks for exactly 40 USDG; the loan program funds that amount and no other/);
    await expect(b2.lendFund({ proofCode: q.proofCode, pledgeBps: 5000n })).rejects.toThrow(/pledges 40% of each payment, less than the 50%/);
    await expect(b2.lendFund({ proofCode: q.proofCode, loanRef: 4n })).rejects.toThrow(/for loan slot #3, not #4/);
    await expect(b2.lendFund({ proofCode: q.proofCode })).rejects.toThrow(/payout account .* does not exist/);
    putToken([c2], q.payout, Keypair.generate().publicKey, 0n);
    await expect(b2.lendFund({ proofCode: q.proofCode, confirm: true })).rejects.toThrow(/holds 10 USDG, less than the 40 USDG.*public USDG, not the shielded balance.*Nothing was sent/);
    // a slot of another lender, a funded slot, a missing slot
    putSlot([c2], slotData({ loanRef: 3n, lender: Keypair.generate().publicKey }));
    await expect(b2.lendFund({ proofCode: q.proofCode })).rejects.toThrow(/belongs to another lender .*only its owner can fund it\. Nothing was sent/);
    putSlot([c2], slotData({ loanRef: 3n, lender: s2.publicKey, funded: true, principal: 1n }));
    await expect(b2.lendFund({ proofCode: q.proofCode })).rejects.toThrow(/AlreadyFunded/);
    c2.accounts.delete(slotPda(3n, LOAN).toBase58());
    await expect(b2.lendFund({ proofCode: q.proofCode })).rejects.toThrow(/loan slot #3 does not exist/);
    expect(fund2).not.toHaveBeenCalled();

    // expired, wrong audience, no live pledged note
    const { bank: b3, conn: c3, signer: s3 } = await openAgent();
    putSlot([c3], slotData({ loanRef: 3n, lender: s3.publicKey }));
    const old = pledged(b3, { expiry: NOW - 1n });
    putToken([c3], old.payout, Keypair.generate().publicKey, 0n);
    await expect(b3.lendFund({ proofCode: old.proofCode })).rejects.toThrow(/expired at .*nothing would repay this loan/);
    const r = pledged(b3);
    const swapped = encodeLoanProof(b3.loanCodeContext, { ref: 3n, payout: old.payout, proof: r.proof, args: r.args });
    await expect(b3.lendFund({ proofCode: swapped })).rejects.toThrow(/not made for the payout account in the code/);
    putToken([c3], r.payout, Keypair.generate().publicKey, 0n);
    vi.spyOn(b3.lender(), 'current').mockReturnValue([]);
    await expect(b3.lendFund({ proofCode: r.proofCode })).rejects.toThrow(/does not match a live allowance pledged to loan slot #3 that this lender can read/);
    const fund3 = vi.spyOn(b3.lender(), 'fund');
    expect(fund3).not.toHaveBeenCalled();
    expect(fund).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled(); // the ceiling came first
  });

  it('a proof code for another network, a terms code, or a damaged code is refused by the frame; an invalid proof by the local vkey', async () => {
    const { bank, conn, signer } = await openAgent({ circuits: circuitsDir(['stream']) });
    putSlot([conn], slotData({ loanRef: 3n, lender: signer.publicKey }));
    const p = pledged(bank);
    putToken([conn], p.payout, Keypair.generate().publicKey, 0n);
    vi.spyOn(bank.lender(), 'current').mockReturnValue([p.note]);
    const fund = vi.spyOn(bank.lender(), 'fund');
    const devnet = encodeLoanProof({ ...bank.loanCodeContext, cluster: 'devnet' }, { ref: 3n, payout: p.payout, proof: p.proof, args: p.args });
    await expect(bank.lendFund({ proofCode: devnet })).rejects.toThrow(/another network, program or asset/);
    await expect(bank.lendFund({ proofCode: bank.loanTermsCode(3n, 4000n) })).rejects.toThrow(/"h081-loan-terms:" code, not a borrower proof code/);
    const cut = p.proofCode.slice(0, -6);
    await expect(bank.lendFund({ proofCode: cut })).rejects.toThrow(/does not pass its built-in check/);
    const verify = vi.spyOn(bank.prover, 'verify').mockResolvedValue(false);
    await expect(bank.lendFund({ proofCode: p.proofCode })).rejects.toThrow(/stream proof does not verify/);
    // the public signals handed to snarkjs are the circuit's, in its order
    const sig = verify.mock.calls[0][1].raw.publicSignals;
    expect(sig).toEqual([p.args.root, p.args.minRemaining, p.args.minRate, fieldOf(p.args.lender), 3n, 4000n, p.args.expiry, p.args.lifetimeCap, 0n, p.args.agentPk, p.args.audience, NOW, fieldOf(USDG)].map(String));
    verify.mockResolvedValue(true);
    const plan = await bank.lendFund({ proofCode: p.proofCode }) as unknown as { plan: { proofChecked: string } };
    expect(plan.plan.proofChecked).toMatch(/^verified locally/);
    expect(fund).not.toHaveBeenCalled();
  });
});

describe('h081_lend: status, claim, collect, settle, close', () => {
  async function funded(over: Partial<Parameters<typeof slotData>[0]> = {}) {
    const ctx = await openAgent({ circuits: circuitsDir(['spend']) });
    const payout = Keypair.generate().publicKey;
    putSlot([ctx.conn], slotData({ loanRef: 3n, lender: ctx.signer.publicKey, funded: true, principal: USD(40), repaid: USD(10), pledgeBps: 4000, expiry: NOW + 30n * DAY, payoutTo: payout, ...over }));
    return ctx;
  }

  it('status reads the slot: state, repaid, outstanding, claimable, collectable, shortfall; an open slot gives its terms code again', async () => {
    const { bank, conn, signer } = await funded();
    vi.spyOn(bank.lender(), 'claimable').mockReturnValue(USD(1.5));
    putToken([conn], slotInbox(3n, USDG, TOKEN_2022_PROGRAM_ID, LOAN), slotPda(3n, LOAN), USD(2));
    const st = await runOp(bank, 'h081_lend', { action: 'status', loanRef: '3' }) as { slots: Array<Record<string, unknown>> };
    expect(st.slots).toHaveLength(1);
    expect(st.slots[0]).toMatchObject({
      loanRef: 3n, mine: true, state: 'funded', principalUsdg: '40', repaidUsdg: '10', outstandingUsdg: '30', claimableUsdg: '1.5', collectableUsdg: '2', shortfall: 0n,
      pledgeBps: 4000n, borrowerWithheldMemo: false,
    });
    expect(st.slots[0]).not.toHaveProperty('termsCode');
    // listing needs getProgramAccounts: the fake RPC has none, which is reported, not thrown
    const all = await bank.lendStatus();
    expect(all.slots).toEqual([]);
    expect(all.note).toMatch(/cannot list the agent's slots/);
    // an open slot of this agent with its share: the terms code again
    putSlot([conn], slotData({ loanRef: 3n, lender: signer.publicKey }));
    const open = await bank.lendStatus({ loanRef: 3n, pledgeBps: 4000n });
    expect(open.slots[0]).toMatchObject({ state: 'open', funded: false });
    expect(decodeLoanTerms(bank.loanCodeContext, open.slots[0].termsCode!)).toMatchObject({ loanRef: 3n, pledgeBps: 4000n });
    // past expiry + 7 days the unpaid principal is a shortfall
    putSlot([conn], slotData({ loanRef: 3n, lender: signer.publicKey, funded: true, principal: USD(40), repaid: USD(10), pledgeBps: 4000, expiry: NOW - 8n * DAY }));
    putToken([conn], slotInbox(3n, USDG, TOKEN_2022_PROGRAM_ID, LOAN), slotPda(3n, LOAN), 0n);
    expect((await bank.lendStatus({ loanRef: 3n })).slots[0]).toMatchObject({ shortfall: USD(30) });
    await expect(bank.lendStatus({ loanRef: 9n })).rejects.toThrow(/loan slot #9 does not exist/);
  });

  it('claim pulls the vested share (spend artifacts, SOL), refuses nothing-to-claim and a withheld memo; collect forwards routed shares', async () => {
    const { bank, conn } = await funded();
    const claimable = vi.spyOn(bank.lender(), 'claimable').mockReturnValue(0n);
    const opaque = vi.spyOn(bank.lender(), 'opaque').mockReturnValue(false);
    const claim = vi.spyOn(bank.lender(), 'claim').mockResolvedValue({ tx: tx('sigClaim'), proof: {} as never, next: {} as never, amount: USD(1.5) });
    await expect(runOp(bank, 'h081_lend', { action: 'claim', loanRef: '3' })).rejects.toThrow(/nothing is claimable on loan #3 yet.*Nothing was sent/);
    opaque.mockReturnValue(true);
    await expect(bank.lendClaim({ loanRef: 3n })).rejects.toThrow(/without handing this lender its successor/);
    opaque.mockReturnValue(false);
    claimable.mockReturnValue(USD(1.5));
    await expect(bank.lendClaim({ loanRef: 3n, amount: USD(2) })).rejects.toThrow(/at most 1\.5 USDG is claimable now/);
    expect(claim).not.toHaveBeenCalled();
    const r = await runOp(bank, 'h081_lend', { action: 'claim', loanRef: '3', usdg: '1' });
    expect(claim).toHaveBeenCalledWith(3n, USD(1));
    expect(r).toMatchObject({ sent: true, action: 'claim', signatures: ['sigClaim'], collected: USD(1.5) });
    // claim needs the spend artifacts
    const bare = await openAgent();
    putSlot([bare.conn], slotData({ loanRef: 3n, lender: bare.signer.publicKey, funded: true, principal: USD(40), pledgeBps: 4000 }));
    vi.spyOn(bare.bank.lender(), 'claimable').mockReturnValue(USD(1));
    const c2 = vi.spyOn(bare.bank.lender(), 'claim');
    await expect(bare.bank.lendClaim({ loanRef: 3n })).rejects.toThrow(/spend proving artifacts are not in .*Nothing was sent/);
    expect(c2).not.toHaveBeenCalled();

    // collect
    const sync = vi.spyOn(bank.lender(), 'syncLoan').mockResolvedValue(tx('sigSync'));
    const collect = vi.spyOn(bank.lender(), 'collect').mockResolvedValue(tx('sigCollect'));
    const ledger = vi.spyOn(bank.lender(), 'ledger').mockResolvedValue(undefined);
    await expect(bank.lendCollect({ loanRef: 3n })).rejects.toThrow(/nothing has been routed to loan slot #3.*Nothing was sent/);
    putToken([conn], slotInbox(3n, USDG, TOKEN_2022_PROGRAM_ID, LOAN), slotPda(3n, LOAN), USD(2));
    ledger.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ loanRef: 3n, mint: USDG, held: USD(2), received: USD(2) });
    const col = await runOp(bank, 'h081_lend', { action: 'collect', loanRef: '3' });
    expect(sync).toHaveBeenCalledWith(3n);
    expect(collect).toHaveBeenCalledWith(3n, USDG);
    expect(col).toMatchObject({ sent: true, action: 'collect', signatures: ['sigSync', 'sigCollect'], collected: USD(2), collectedUsdg: '2' });
  });

  it('settle plans (naming what is unpaid) unless confirm; close needs a settled slot and an SDK with close_slot; only the owner may act', async () => {
    const { bank, conn, signer } = await funded();
    const settle = vi.spyOn(bank.lender(), 'settle').mockResolvedValue(tx('sigSettle'));
    const plan = await runOp(bank, 'h081_lend', { action: 'settle', loanRef: '3' }) as { plan: { warning: string } };
    expect(plan).toMatchObject({ sent: false, dryRun: true, plan: { action: 'settle', outstanding: USD(30) } });
    expect(plan.plan.warning).toMatch(/30 USDG is still unpaid: settling now gives up any shortfall claim/);
    expect(settle).not.toHaveBeenCalled();
    await expect(bank.lendClose({ loanRef: 3n })).rejects.toThrow(/not settled: settle it first/);
    expect(await runOp(bank, 'h081_lend', { action: 'settle', loanRef: '3', confirm: true })).toMatchObject({ sent: true, action: 'settle', signatures: ['sigSettle'] });
    expect(settle).toHaveBeenCalledWith(3n);

    putSlot([conn], slotData({ loanRef: 3n, lender: signer.publicKey, funded: true, settled: true, principal: USD(40), repaid: USD(40), pledgeBps: 4000 }));
    await expect(bank.lendSettle({ loanRef: 3n, confirm: true })).rejects.toThrow(/already settled/);
    // this build's SDK has no close_slot: refused, nothing sent
    await expect(bank.lendClose({ loanRef: 3n, confirm: true })).rejects.toThrow(/close_slot\) is not in this build's SDK yet.*Nothing was sent/);
    // an SDK that has it: plan, then close
    const close = vi.fn(async () => ({ ...tx('sigClose'), refunded: 4_000_000n }));
    (bank.lender() as unknown as { close: typeof close }).close = close;
    expect(await bank.lendClose({ loanRef: 3n })).toMatchObject({ sent: false, dryRun: true });
    expect(close).not.toHaveBeenCalled();
    expect(await bank.lendClose({ loanRef: 3n, confirm: true })).toMatchObject({ sent: true, action: 'close', refundedLamports: 4_000_000n });

    putSlot([conn], slotData({ loanRef: 3n, lender: Keypair.generate().publicKey, funded: true, principal: USD(40), pledgeBps: 4000 }));
    for (const action of ['claim', 'collect', 'settle', 'close']) {
      await expect(runOp(bank, 'h081_lend', { action, loanRef: '3', ...(action === 'settle' || action === 'close' ? { confirm: true } : {}) })).rejects.toThrow(/belongs to another lender/);
    }
    await expect(runOp(bank, 'h081_lend', { action: 'settle' })).rejects.toThrow(/loanRef is required/);
    await expect(runOp(bank, 'h081_lend', { action: 'settle', loanRef: '-1' })).rejects.toThrow(/non-negative integer/);
  });
});

describe('a loan between two agents (mocked SDK, real codes)', () => {
  it('A opens a slot, B pledges to its terms code, A funds against B\'s proof code, claims, collects and settles', async () => {
    const A = await openAgent({ walletUsdg: USD(500), circuits: circuitsDir(['spend']) });
    const B = await openAgent({ walletUsdg: 0n });
    const both = [A.conn, B.conn];
    const ref = 3n;

    // A: open
    vi.spyOn(A.bank.lender(), 'openSlot').mockImplementation(async () => { putSlot(both, slotData({ loanRef: ref, lender: A.signer.publicKey })); return ref; });
    const opened = await runOp(A.bank, 'h081_lend', { action: 'open', pledgeBps: 4000, confirm: true }) as { termsCode: string };

    // B: borrow with A's terms code (grant and stream proof mocked; B's codes are its own bank's)
    vi.spyOn(B.bank.owner, 'balance').mockReturnValue(USD(200));
    const grant = vi.spyOn(B.bank.owner, 'grant').mockResolvedValue({ tx: tx('sigGrant'), proof: {} as never, allowances: [], total: 0n, totalSalt: 0n, lenderPayloads: [undefined] });
    const bPayout = getAssociatedTokenAddressSync(USDG, B.signer.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const p = pledged(A.bank, { payout: bPayout });
    const owned: SolOwnedAllowance = { allowance: p.a, commitment: p.note.commitment, index: 5, spent: false, views: p.note.views, lender: p.note.lender, lenderKey: slotPda(ref, LOAN), mint: USDG };
    vi.spyOn(B.bank.agent(0).wallet, 'agentAllowances').mockReturnValue([owned]);
    const prove = vi.spyOn(B.bank.agent(0).wallet, 'proveStream').mockImplementation(async (_o, bounds) => ({
      proof: { proof: p.proof, publicSignals: [], raw: { proof: {}, publicSignals: [] } }, args: { ...p.args, minRemaining: bounds.minRemaining, audience: bounds.audience },
    }));
    const borrowed = await runOp(B.bank, 'h081_loan_borrow', { termsCode: opened.termsCode, budgetUsdg: '100', days: 30, unlockDays: 30, principalUsdg: '40' }) as { proofCode: string; principal: bigint };
    expect(grant).toHaveBeenCalledOnce();
    const pledge = grant.mock.calls[0][1][0].pledge!;
    expect(pledge.lender.equals(slotPda(ref, LOAN))).toBe(true);
    expect(pledge.loanRef).toBe(ref);
    expect(pledge.pledgeBps).toBe(4000n);
    expect(Buffer.from(pledge.lenderViewPub).equals(Buffer.from(A.bank.lender().view.pub))).toBe(true);
    expect(prove.mock.calls[0][1].audience).toBe(payoutAudience(bPayout));
    expect(borrowed.principal).toBe(USD(40));
    expect(borrowed.proofCode).toMatch(/^h081-loan-proof:[1-9A-HJ-NP-Za-km-z]+$/);
    expect(decodeLoanProof(A.bank.loanCodeContext, borrowed.proofCode).payout.equals(bPayout)).toBe(true);

    // A: fund against B's proof code (plan first, then confirm); B's payout account is on A's chain view too
    putToken([A.conn], bPayout, B.signer.publicKey, 0n);
    vi.spyOn(A.bank.lender(), 'current').mockReturnValue([p.note]);
    const fund = vi.spyOn(A.bank.lender(), 'fund').mockImplementation(async () => {
      putSlot(both, slotData({ loanRef: ref, lender: A.signer.publicKey, funded: true, principal: USD(40), pledgeBps: 4000, expiry: p.a.policy.expiry, payoutTo: bPayout }));
      return tx('sigFund');
    });
    expect(await runOp(A.bank, 'h081_lend', { action: 'fund', proofCode: borrowed.proofCode })).toMatchObject({ sent: false, plan: { principalUsdg: '40', payoutTo: bPayout.toBase58() } });
    expect(fund).not.toHaveBeenCalled();
    expect(await runOp(A.bank, 'h081_lend', { action: 'fund', proofCode: borrowed.proofCode, confirm: true })).toMatchObject({ sent: true, borrowerReceivesUsdg: '39.9' });
    expect(fund.mock.calls[0][4].equals(bPayout)).toBe(true);

    // both sides see the funded loan: B through h081_loan_quote, A through status
    expect((await runOp(B.bank, 'h081_loan_quote', { loanRef: '3' }) as { slot: { funded: boolean; lender: string } }).slot).toMatchObject({ funded: true, lender: A.signer.publicKey.toBase58() });
    vi.spyOn(A.bank.lender(), 'claimable').mockReturnValue(USD(0.5));
    expect((await runOp(A.bank, 'h081_lend', { action: 'status', loanRef: '3' }) as { slots: unknown[] }).slots[0]).toMatchObject({ state: 'funded', claimableUsdg: '0.5', mine: true });
    // B cannot act on A's slot
    await expect(runOp(B.bank, 'h081_lend', { action: 'settle', loanRef: '3', confirm: true })).rejects.toThrow(/belongs to another lender/);

    // A: claim (with the spend artifacts), collect after B's payments, settle once repaid
    const claim = vi.spyOn(A.bank.lender(), 'claim').mockResolvedValue({ tx: tx('sigClaim'), proof: {} as never, next: {} as never, amount: USD(0.5) });
    expect(await runOp(A.bank, 'h081_lend', { action: 'claim', loanRef: '3' })).toMatchObject({ sent: true, collected: USD(0.5) });
    expect(claim).toHaveBeenCalledWith(3n, undefined);
    putToken(both, slotInbox(ref, USDG, TOKEN_2022_PROGRAM_ID, LOAN), slotPda(ref, LOAN), USD(3));
    vi.spyOn(A.bank.lender(), 'syncLoan').mockImplementation(async () => {
      putToken(both, slotInbox(ref, USDG, TOKEN_2022_PROGRAM_ID, LOAN), slotPda(ref, LOAN), 0n);
      putSlot(both, slotData({ loanRef: ref, lender: A.signer.publicKey, funded: true, principal: USD(40), repaid: USD(40), pledgeBps: 4000, expiry: p.a.policy.expiry, payoutTo: bPayout }));
      return tx('sigSync');
    });
    vi.spyOn(A.bank.lender(), 'ledger').mockResolvedValue(undefined);
    expect(await runOp(A.bank, 'h081_lend', { action: 'collect', loanRef: '3' })).toMatchObject({ sent: true, signatures: ['sigSync'], slot: { state: 'repaid', outstanding: 0n } });
    const settle = vi.spyOn(A.bank.lender(), 'settle').mockResolvedValue(tx('sigSettle'));
    expect((await runOp(A.bank, 'h081_lend', { action: 'settle', loanRef: '3' }) as { plan: { warning: string } }).plan.warning).toMatch(/repaid; settling closes it/);
    expect(await runOp(A.bank, 'h081_lend', { action: 'settle', loanRef: '3', confirm: true })).toMatchObject({ sent: true });
    expect(settle).toHaveBeenCalledOnce();
  });
});
