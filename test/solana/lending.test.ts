// stream_loan on a private solana-test-validator (WSL, rpc 127.0.0.1:9099) next to stipend_pool.
// Run with `npm run test:solana:loan` (restarts that validator, then runs this file only).
import { beforeAll, describe, expect, it } from 'vitest';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { initCrypto, lenderKey, shareOf, lenderShare } from '../../src/crypto.js';
import { randomViewingKey } from '../../src/encryption.js';
import { Account } from '../../src/client.js';
import {
  LOCALNET_POOL_PROGRAM_ID, POOL_ERROR, SolanaPool, SolanaWallet, concatBytes, customErrorCode, encodeSpendArgs, fieldOf, pullLenderShareIx, send,
  simulate, spendIx, type PreparedSpend, type SolOwnedAllowance, type SpendArgs,
} from '../../src/solana/index.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, GRACE, LOAN_ERROR, LOCALNET_LOAN_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, SolanaLoanLenderWallet, associatedTokenAddress, claimIx,
  decodeRegistry, decodeSlot, collectIx, decodeLedger, fundIx, ledgerPda, loanInitializeIx, openSlotIx, registryPda, settleIx, shortfallIx, slotEscrow,
  slotInbox, slotPda, syncIx,
} from '../../src/solana/lender.js';

const RPC = process.env.STIPEND_LOAN_RPC;
const LOAN = LOCALNET_LOAN_PROGRAM_ID;
const POOL = LOCALNET_POOL_PROGRAM_ID;
const suite = describe.skipIf(!RPC); // only under vitest.solana-loan.config.ts (its own validator)

const connection = new Connection(RPC ?? 'http://127.0.0.1:9099', 'confirmed');
const payer = Keypair.generate();

async function fundSol(...keys: PublicKey[]) {
  for (const k of keys) {
    const sig = await connection.requestAirdrop(k, 20 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction({ signature: sig, ...(await connection.getLatestBlockhash()) }, 'confirmed');
  }
}

async function expectCode(p: Promise<unknown>, code: number) {
  let caught: unknown;
  try { await p; } catch (e) { caught = e; }
  expect(caught, 'transaction should fail').toBeDefined();
  if (customErrorCode(caught) !== code) console.log(String(caught), (caught as { logs?: string[] }).logs?.slice(-12));
  expect(customErrorCode(caught)).toBe(code);
}

// ---- minimal SPL Token instructions (no @solana/spl-token dependency) ----
const MINT_LEN = 82;
function initMint2Ix(mint: PublicKey, decimals: number, authority: PublicKey, freeze: PublicKey | null, tp = SPL_TOKEN_PROGRAM_ID) {
  const data = Buffer.alloc(1 + 1 + 32 + 1 + 32);
  data[0] = 20; data[1] = decimals; authority.toBuffer().copy(data, 2);
  if (freeze) { data[34] = 1; freeze.toBuffer().copy(data, 35); }
  return new TransactionInstruction({ programId: tp, keys: [{ pubkey: mint, isSigner: false, isWritable: true }], data });
}
function createAtaIx(payerKey: PublicKey, owner: PublicKey, mint: PublicKey, tp = SPL_TOKEN_PROGRAM_ID) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payerKey, isSigner: true, isWritable: true }, { pubkey: associatedTokenAddress(owner, mint, tp), isSigner: false, isWritable: true },
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
/** InitializeAccount3: a token account for `owner` at any address; the owner does not sign. */
function initAccount3Ix(account: PublicKey, mint: PublicKey, owner: PublicKey, tp = SPL_TOKEN_PROGRAM_ID) {
  const data = Buffer.alloc(33); data[0] = 18; owner.toBuffer().copy(data, 1);
  return new TransactionInstruction({ programId: tp, keys: [{ pubkey: account, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }], data });
}
/** A token account owned by `owner` (e.g. a slot PDA) that is not its associated token account. Anyone can make one. */
async function sideAccount(payerKp: Keypair, mint: PublicKey, owner: PublicKey): Promise<PublicKey> {
  const acc = Keypair.generate();
  const lamports = await connection.getMinimumBalanceForRentExemption(165);
  await send(connection, payerKp, [
    SystemProgram.createAccount({ fromPubkey: payerKp.publicKey, newAccountPubkey: acc.publicKey, lamports, space: 165, programId: SPL_TOKEN_PROGRAM_ID }),
    initAccount3Ix(acc.publicKey, mint, owner),
  ], { signers: [acc] });
  return acc.publicKey;
}
function freezeIx(account: PublicKey, mint: PublicKey, authority: PublicKey, thaw = false, tp = SPL_TOKEN_PROGRAM_ID) {
  return new TransactionInstruction({ programId: tp, keys: [{ pubkey: account, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: authority, isSigner: true, isWritable: false }], data: Buffer.from([thaw ? 11 : 10]) });
}
async function createMint(authority: Keypair, decimals = 6): Promise<PublicKey> {
  const mint = Keypair.generate();
  const lamports = await connection.getMinimumBalanceForRentExemption(MINT_LEN);
  await send(connection, authority, [
    SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: mint.publicKey, lamports, space: MINT_LEN, programId: SPL_TOKEN_PROGRAM_ID }),
    initMint2Ix(mint.publicKey, decimals, authority.publicKey, authority.publicKey),
  ], { signers: [mint] });
  return mint.publicKey;
}
async function tokenBalance(account: PublicKey): Promise<bigint> {
  const info = await connection.getAccountInfo(account, 'confirmed');
  if (!info) return 0n;
  return Buffer.from(info.data).readBigUInt64LE(64);
}

async function readSlot(loanRef: bigint) {
  const info = await connection.getAccountInfo(slotPda(loanRef), 'confirmed');
  if (!info) throw new Error('no slot');
  return decodeSlot(info.data);
}
async function nextLoanRef(): Promise<bigint> {
  const info = await connection.getAccountInfo(registryPda(), 'confirmed');
  return decodeRegistry(info!.data).nextLoanRef;
}
async function openSlot(lender: Keypair): Promise<bigint> {
  const ref = await nextLoanRef();
  await send(connection, lender, [openSlotIx(lender.publicKey, ref)]);
  return ref;
}
async function viewShortfall(loanRef: bigint, asset: PublicKey): Promise<bigint> {
  const sim = await simulate(connection, payer, [shortfallIx(loanRef, asset)]);
  expect(sim.err).toBeNull();
  const line = sim.logs.find((l) => l.startsWith('Program return: '));
  if (!line) throw new Error('no return data');
  return Buffer.from(line.split(' ')[3], 'base64').readBigUInt64LE(0);
}

beforeAll(async () => {
  if (!RPC) return;
  await initCrypto();
  try {
    await connection.getVersion();
  } catch {
    throw new Error(`no validator at ${RPC}; run: node scripts/solana-loan-localnet.mjs start`);
  }
  for (const id of [POOL, LOAN]) {
    const acc = await connection.getAccountInfo(id);
    if (!acc?.executable) throw new Error(`program ${id.toBase58()} is not loaded; build it and restart the loan validator`);
  }
  await fundSol(payer.publicKey);
});

suite('registry', () => {
  it('initializes once, permissionlessly, and opens sequential slots with no owner', async () => {
    if (!(await connection.getAccountInfo(registryPda()))) await send(connection, payer, [loanInitializeIx(payer.publicKey)]);
    await expect(send(connection, payer, [loanInitializeIx(payer.publicKey)])).rejects.toThrow();
    const lender = Keypair.generate();
    await fundSol(lender.publicKey);
    const first = await openSlot(lender);
    const second = await openSlot(lender);
    expect(second).toBe(first + 1n);
    const s = await readSlot(first);
    expect(s.lender.equals(lender.publicKey)).toBe(true);
    expect(s.loanRef).toBe(first);
    expect(s.funded).toBe(false);
    // a stale loan ref (already taken) cannot be reopened: the PDA no longer matches the counter
    await expect(send(connection, lender, [openSlotIx(lender.publicKey, first)])).rejects.toThrow();
    // settle needs the slot's lender and a funded loan
    const other = Keypair.generate();
    await fundSol(other.publicKey);
    await expectCode(send(connection, other, [settleIx(other.publicKey, first)]), LOAN_ERROR.NotTheLender);
    await expectCode(send(connection, lender, [settleIx(lender.publicKey, first)]), LOAN_ERROR.NoLoan);
    expect(await viewShortfall(first, Keypair.generate().publicKey)).toBe(0n);
    expect(GRACE).toBe(604800n);
  });
});

suite('inbox sync, escrow and collect', () => {
  it('forwards what lands in the inbox, holds it while the lender account is frozen, and the lender collects it', async () => {
    const authority = Keypair.generate();
    const lender = Keypair.generate();
    const stranger = Keypair.generate();
    await fundSol(authority.publicKey, lender.publicKey, stranger.publicKey);
    const mint = await createMint(authority);
    const ref = await openSlot(lender);
    const inbox = slotInbox(ref, mint);
    const lenderAta = associatedTokenAddress(lender.publicKey, mint);
    // nothing arrived yet (no inbox): sync is a no-op that anyone may call
    await send(connection, stranger, [syncIx(stranger.publicKey, ref, mint, lender.publicKey)]);
    // a share routed to the slot before the lender has a token account: held
    await send(connection, authority, [createAtaIx(authority.publicKey, slotPda(ref), mint), mintToIx(mint, inbox, authority.publicKey, 7_000n)]);
    await send(connection, stranger, [syncIx(stranger.publicKey, ref, mint, lender.publicKey)]);
    let ledger = decodeLedger((await connection.getAccountInfo(ledgerPda(ref, mint), 'confirmed'))!.data);
    expect(ledger.held).toBe(7_000n);
    expect(ledger.received).toBe(7_000n);
    // the lender's account exists now: new arrivals are forwarded, the held part stays for collect
    await send(connection, lender, [createAtaIx(lender.publicKey, lender.publicKey, mint)]);
    await send(connection, authority, [mintToIx(mint, inbox, authority.publicKey, 500n)]);
    await send(connection, stranger, [syncIx(stranger.publicKey, ref, mint, lender.publicKey)]);
    expect(await tokenBalance(lenderAta)).toBe(500n);
    expect(await tokenBalance(inbox)).toBe(7_000n);
    // a frozen lender account: held again
    await send(connection, authority, [freezeIx(lenderAta, mint, authority.publicKey), mintToIx(mint, inbox, authority.publicKey, 300n)]);
    await send(connection, stranger, [syncIx(stranger.publicKey, ref, mint, lender.publicKey)]);
    ledger = decodeLedger((await connection.getAccountInfo(ledgerPda(ref, mint), 'confirmed'))!.data);
    expect(ledger.held).toBe(7_300n);
    expect(ledger.received).toBe(7_800n);
    // a sync aimed at another account than the lender's ATA is refused (no griefing into escrow)
    const wrong = syncIx(stranger.publicKey, ref, mint, lender.publicKey);
    wrong.keys[5].pubkey = associatedTokenAddress(stranger.publicKey, mint);
    await expectCode(send(connection, stranger, [wrong]), LOAN_ERROR.BadLenderAccount);
    // only the slot's lender collects; nothing was credited as repayment (no loan in this slot)
    await send(connection, authority, [freezeIx(lenderAta, mint, authority.publicKey, true)]);
    await send(connection, stranger, [createAtaIx(stranger.publicKey, stranger.publicKey, mint)]);
    await expectCode(send(connection, stranger, [{ ...collectIx(lender.publicKey, ref, mint, associatedTokenAddress(stranger.publicKey, mint)), keys: collectIx(lender.publicKey, ref, mint, associatedTokenAddress(stranger.publicKey, mint)).keys.map((k) => (k.pubkey.equals(lender.publicKey) ? { ...k, pubkey: stranger.publicKey } : k)) } as TransactionInstruction]), LOAN_ERROR.NotTheLender);
    await send(connection, lender, [collectIx(lender.publicKey, ref, mint, lenderAta)]);
    expect(await tokenBalance(lenderAta)).toBe(7_800n);
    expect(await tokenBalance(inbox)).toBe(0n);
    await expectCode(send(connection, lender, [collectIx(lender.publicKey, ref, mint, lenderAta)]), LOAN_ERROR.NothingOwed);
    expect((await readSlot(ref)).repaid).toBe(0n);
  });
});

// ------------------------------------------------------------------ end to end with stipend_pool

const U = 1_000_000n; // 6 decimals
const BPS = 4000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Re-encodes a prepared spend with some public inputs changed (the proof stays the same). */
function tamper(p: PreparedSpend, over: Partial<SpendArgs>): PreparedSpend {
  const argsLen = encodeSpendArgs(p.args).length;
  const ext = p.payload.subarray(256 + argsLen);
  const args = { ...p.args, ...over };
  return { ...p, args, payload: concatBytes(p.payload.subarray(0, 256), encodeSpendArgs(args), ext) };
}

suite('stream-backed lending through stream_loan', () => {
  let pool: SolanaPool;
  let mint: PublicKey;
  let otherMint: PublicKey;
  const authority = Keypair.generate();
  const ownerKp = Keypair.generate();
  const agentKp = Keypair.generate();
  const lenderKp = Keypair.generate();
  const strangerKp = Keypair.generate();
  const vendorKp = Keypair.generate();
  const borrowerKp = Keypair.generate(); // the wallet the principal is paid to
  let owner: SolanaWallet;
  let b: SolanaWallet;
  let a2: SolanaWallet;
  let lender: SolanaLoanLenderWallet;
  let stranger: SolanaLoanLenderWallet;
  let ref: bigint;
  let ref2: bigint;
  let payout: PublicKey;
  let lenderAta: PublicKey;
  let streamStart: bigint;
  let payload: Uint8Array;
  const principal = 300n * U;

  const current = (w: SolanaWallet, pk?: bigint): SolOwnedAllowance => {
    const list = (pk === undefined ? w.agentAllowances(mint) : w.grantedAllowances().filter((a) => a.allowance.agentPk === pk)).filter((a) => a.allowance.remaining > 0n);
    if (list.length !== 1) throw new Error(`expected one live allowance, got ${list.length}`);
    return list[0];
  };
  const bal = (account: PublicKey) => tokenBalance(account);
  const waitChain = async (t: bigint) => { while ((await pool.now()) < t) await sleep(1000); };

  beforeAll(async () => {
    if (!RPC) return;
    pool = new SolanaPool(connection);
    await fundSol(authority.publicKey, ownerKp.publicKey, agentKp.publicKey, lenderKp.publicKey, strangerKp.publicKey, vendorKp.publicKey, borrowerKp.publicKey);
    await pool.initialize(payer);
    mint = await createMint(authority);
    otherMint = await createMint(authority);
    for (const k of [ownerKp, lenderKp]) await send(connection, authority, [createAtaIx(authority.publicKey, k.publicKey, mint)]);
    await send(connection, authority, [
      mintToIx(mint, associatedTokenAddress(ownerKp.publicKey, mint), authority.publicKey, 10_000n * U),
      mintToIx(mint, associatedTokenAddress(lenderKp.publicKey, mint), authority.publicKey, 1_000n * U),
    ]);
    lenderAta = associatedTokenAddress(lenderKp.publicKey, mint);
    payout = associatedTokenAddress(borrowerKp.publicKey, mint);
    await send(connection, authority, [createAtaIx(authority.publicKey, borrowerKp.publicKey, mint)]);
    owner = new SolanaWallet(Account.random(), pool, ownerKp);
    b = new SolanaWallet(Account.random(), pool, agentKp);
    a2 = new SolanaWallet(Account.random(), pool, agentKp);
    lender = new SolanaLoanLenderWallet(pool, lenderKp, randomViewingKey());
    stranger = new SolanaLoanLenderWallet(pool, strangerKp, randomViewingKey());
    await lender.initialize();
    await owner.deposit(mint, 5_000n * U);
    expect(owner.balance(mint)).toBe(5_000n * U);
  });

  it('lender opens a slot; the owner grants a streamed allowance pledged to the slot PDA; the agent sees the pledge', async () => {
    ref = await lender.openSlot();
    const addr = lender.address(ref);
    expect(addr.lender.equals(slotPda(ref))).toBe(true);
    expect(addr.lenderAddr).toBe(fieldOf(slotPda(ref)));
    const now = await pool.now();
    const res = await owner.grant(mint, [{
      to: b.address, amount: 1_000n * U, streamRate: 10n * U, windowCap: 500n * U, expiry: now + 86400n, pledge: lender.terms(ref, BPS),
    }]);
    payload = res.lenderPayloads[0]!;
    expect(payload).toBeDefined();
    const a = res.allowances[0];
    streamStart = a.policy.streamStart;
    expect(a.policy.lender).toBe(lenderKey(fieldOf(slotPda(ref)), ref));
    expect(a.policy.pledgeBps).toBe(BPS);
    await b.sync();
    const cur = current(b);
    expect(cur.lender?.loanRef).toBe(ref);
    expect(cur.lenderKey?.equals(slotPda(ref))).toBe(true);
    expect(await lender.shortfall(ref)).toBe(0n);
  });

  it('proveStream verifies on chain; fund checks the lender, the slot, the asset and the proof, then pays the principal out', async () => {
    const stream = await b.proveStream(current(b), { minRemaining: 1_000n * U, minRate: 10n * U, audience: fieldOf(lenderKp.publicKey) });
    expect(stream.args.lender.equals(slotPda(ref))).toBe(true);
    expect(stream.args.loanRef).toBe(ref);
    expect(stream.args.asset.equals(mint)).toBe(true);
    expect(stream.args.streamStart).toBe(streamStart);
    expect(await pool.verifyStream(payer, stream.proof, stream.args)).toBe(true);
    expect(await pool.verifyStream(payer, stream.proof, { ...stream.args, audience: 1n }, 'simulate')).toBe(false);

    // the SDK funds only against a note it was handed
    await expect(stranger.fund(ref, stream, mint, principal, payout)).rejects.toThrow(/does not match a live note/);
    lender.ingest(payload);
    await lender.sync();
    expect(lender.current(ref)).toHaveLength(1);
    await expect(lender.fund(ref, { proof: stream.proof, args: { ...stream.args, pledgeBps: 5000 } }, mint, principal, payout)).rejects.toThrow(/does not match a live note/);

    // the program's own checks
    ref2 = await lender.openSlot();
    // wrong lender: someone other than the slot's lender
    await expectCode(stranger.fundUnchecked(ref, stream, mint, principal, payout), LOAN_ERROR.NotTheLender);
    // a proof for slot `ref` presented to slot `ref2` (lenderAddr = fieldOf(slot PDA) and loanRef both differ)
    await expectCode(lender.fundUnchecked(ref2, stream, mint, principal, payout), LOAN_ERROR.WrongSlot);
    // re-pointing the proof's lender and loan ref to slot `ref2`: the pool's verifier refuses it
    await expectCode(lender.fundUnchecked(ref2, { proof: stream.proof, args: { ...stream.args, lender: slotPda(ref2), loanRef: ref2 } }, mint, principal, payout), POOL_ERROR.InvalidProof);
    // tampered terms
    await expectCode(lender.fundUnchecked(ref, { proof: stream.proof, args: { ...stream.args, pledgeBps: 5000 } }, mint, principal, payout), POOL_ERROR.InvalidProof);
    // another asset
    await expectCode(lender.fundUnchecked(ref, stream, otherMint, principal, payout), LOAN_ERROR.WrongAsset);

    const before = await bal(payout);
    const lenderBefore = await bal(lenderAta);
    await lender.fund(ref, stream, mint, principal, payout);
    expect(await bal(payout)).toBe(before + principal);
    expect(await bal(lenderAta)).toBe(lenderBefore - principal);
    const loan = await lender.loan(ref);
    expect(loan.funded).toBe(true);
    expect(loan.principal).toBe(principal);
    expect(loan.repaid).toBe(0n);
    expect(loan.pledgeBps).toBe(BPS);
    expect(loan.agentPk).toBe(b.account.keys.pk);
    expect(loan.streamStart).toBe(streamStart);
    expect(loan.asset.equals(mint)).toBe(true);
    expect(loan.payoutTo.equals(payout)).toBe(true);
    expect(loan.minRemaining).toBe(1_000n * U);
    // the inbox exists now, so routed shares land in it
    expect(await connection.getAccountInfo(slotInbox(ref, mint), 'confirmed')).not.toBeNull();
    await expectCode(lender.fundUnchecked(ref, stream, mint, principal, payout), LOAN_ERROR.AlreadyFunded);
  });

  it('a stream that has not started cannot be funded', async () => {
    const f = new SolanaWallet(Account.random(), pool, agentKp);
    const now = await pool.now();
    const res = await owner.grant(mint, [{ to: f.address, amount: 100n * U, streamRate: 1n * U, streamStart: now + 86400n, pledge: lender.terms(ref2, BPS) }]);
    lender.ingest(res.lenderPayloads[0]!);
    await f.sync();
    const future = await f.proveStream(f.agentAllowances(mint)[0], { minRemaining: 100n * U, minRate: 1n * U, audience: 1n });
    await expectCode(lender.fund(ref2, future, mint, 10n * U, payout), LOAN_ERROR.StreamNotStarted);
  });

  it('every spend routes the pledged share to the slot inbox; sync credits it as repayment and forwards it to the lender', async () => {
    await waitChain(streamStart + 16n);
    const vendorAta = associatedTokenAddress(vendorKp.publicKey, mint);
    const inbox = slotInbox(ref, mint);
    const lenderBefore = await bal(lenderAta);
    const res = await b.pay(current(b), 100n * U, vendorKp.publicKey);
    expect(await bal(vendorAta)).toBe(60n * U);
    expect(await bal(inbox)).toBe(40n * U);
    expect(res.next.pledgePaid).toBe(40n * U);
    // not yet synced: repaid lags, but the shortfall view already counts the inbox
    expect((await lender.loan(ref)).repaid).toBe(0n);
    await lender.syncLoan(ref, undefined, strangerKp); // permissionless
    expect((await lender.loan(ref)).repaid).toBe(40n * U);
    expect(await bal(lenderAta)).toBe(lenderBefore + 40n * U);
    expect(await bal(inbox)).toBe(0n);
    // a second sync with nothing new changes nothing
    await lender.syncLoan(ref);
    expect((await lender.loan(ref)).repaid).toBe(40n * U);

    // shielded payment: the recipient gets the net as a note, the lender its share
    await b.pay(current(b), 50n * U, a2.address);
    await lender.syncLoan(ref);
    expect((await lender.loan(ref)).repaid).toBe(60n * U);
    expect(await bal(lenderAta)).toBe(lenderBefore + 60n * U);
    await a2.sync();
    expect(a2.balance(mint)).toBe(30n * U);
    expect(current(b).allowance.pledgePaid).toBe(60n * U);
  });

  it('a skipped or shorted share and a re-pointed lender or loan ref have no proof; a withheld lender account only escrows the share', async () => {
    const p = await b.prepareSpend(current(b), 10n * U, vendorKp.publicKey);
    expect(p.args.lenderAmount).toBe(4n * U);
    await expectCode(b.submitSpend(tamper(p, { lenderAmount: 0n })), POOL_ERROR.InvalidProof);
    await expectCode(b.submitSpend(tamper(p, { lenderAmount: 3n * U })), POOL_ERROR.InvalidProof);
    await expectCode(b.submitSpend(tamper(p, { loanRef: ref2 })), POOL_ERROR.InvalidProof);
    await expectCode(b.submitSpend(tamper(p, { lenderAddr: fieldOf(slotPda(ref2)) })), POOL_ERROR.InvalidProof);
    await expectCode(b.submitSpend(tamper(p, { lenderAddr: fieldOf(lenderKp.publicKey) })), POOL_ERROR.InvalidProof);
    // anyone can create a token account owned by the slot PDA that is not its inbox (stream_loan never reads
    // it). A submitter naming it as the lender leg must not divert the share there: the pool escrows it
    const inbox = slotInbox(ref, mint);
    const side = await sideAccount(strangerKp, mint, slotPda(ref));
    await b.submitSpend({ ...p, accounts: { ...p.accounts, lenderToken: side } });
    expect(await bal(side)).toBe(0n);
    expect(await bal(inbox)).toBe(0n);
    expect(await bal(slotEscrow(ref, mint))).toBe(4n * U);
    await expectCode(b.submitSpend(p), POOL_ERROR.AlreadySpent);
    // nor can anyone push the escrowed share there; it only goes to the slot inbox, where sync credits it
    await expectCode(send(connection, strangerKp, [pullLenderShareIx(POOL, mint, SPL_TOKEN_PROGRAM_ID, fieldOf(slotPda(ref)), ref, side)]), POOL_ERROR.LenderAccount);
    await pool.pullLenderShare(strangerKp, mint, slotPda(ref), ref);
    expect(await bal(side)).toBe(0n);
    expect(await bal(inbox)).toBe(4n * U);
    expect(await lender.shortfall(ref)).toBe(0n);
    await lender.syncLoan(ref);
    expect((await lender.loan(ref)).repaid).toBe(64n * U);
  });

  it('the lender claims the vested share through the registry; only the slot lender, only via the slot PDA, only for its slot', async () => {
    await lender.sync();
    const [note] = lender.current(ref);
    expect(note.allowance.pledgePaid).toBe(64n * U); // learned from LenderMemo events
    expect(note.allowance.remaining).toBe(840n * U);
    const now = await pool.now();
    const claimable = lender.claimable(ref, now);
    expect(claimable).toBeGreaterThan(0n);
    const pc = await lender.prepareClaim(ref);
    expect(pc.args.isLenderClaim).toBe(true);
    // a stranger cannot submit it through the registry
    const asStranger = { ...pc, accounts: { ...pc.accounts, payer: strangerKp.publicKey } };
    await expectCode(stranger.submitClaim(asStranger), LOAN_ERROR.NotTheLender);
    // the lender's own wallet cannot sign it at the pool: fieldOf(lender wallet) != fieldOf(slot PDA)
    await expectCode(
      pool.run(lenderKp, pc.payload, (buf) => spendIx(pool.programId, { ...pc.accounts, buffer: buf, lenderSigner: lenderKp.publicKey })),
      POOL_ERROR.Lender,
    );
    // nor can it be routed through another slot the lender owns
    await expectCode(lender.submitClaim(pc, ref2), LOAN_ERROR.NotAClaim);
    // a forged claim instruction that is not a `spend`
    const fake = claimIx(lenderKp.publicKey, ref, mint, spendIx(pool.programId, { ...pc.accounts, buffer: slotPda(ref) }));
    fake.data = Buffer.concat([fake.data.subarray(0, 16), Buffer.from([8, 0, 0, 0]), Buffer.alloc(8, 7)]);
    await expectCode(send(connection, lenderKp, [fake]), LOAN_ERROR.NotAClaim);

    const before = await bal(lenderAta);
    const repaidBefore = (await lender.loan(ref)).repaid;
    const tx = await lender.submitClaim(pc);
    expect(tx.computeUnits).toBeGreaterThan(0);
    expect(await bal(lenderAta)).toBe(before + pc.amount);
    expect((await lender.loan(ref)).repaid).toBe(repaidBefore + pc.amount); // credited in the same instruction
    expect(await bal(slotInbox(ref, mint))).toBe(0n);
    await expectCode(lender.submitClaim(pc), POOL_ERROR.AlreadySpent); // replay
    await lender.sync();
    expect(lender.current(ref)[0].allowance.pledgePaid).toBe(64n * U + pc.amount);
    // the agent continues from the successor the lender wrote
    await b.sync();
    const live = current(b);
    expect(live.allowance.pledgePaid).toBe(64n * U + pc.amount);
    expect(live.allowance.remaining).toBe(840n * U - pc.amount);
    console.log('claim through stream_loan: compute units', tx.computeUnits);
  });

  it('after expiry + GRACE the shortfall is reported; the owner reclaim routes the share and repays it; the lender settles', async () => {
    // GRACE is 7 days and the local clock cannot be warped, so this loan's allowance expired more than GRACE ago
    const refC = await lender.openSlot();
    const c = new SolanaWallet(Account.random(), pool, agentKp);
    const now = await pool.now();
    const expiry = now - GRACE - 60n;
    const res = await owner.grant(mint, [{ to: c.address, amount: 1_000n * U, streamRate: 10n * U, streamStart: expiry - 100_000n, expiry, pledge: lender.terms(refC, BPS) }]);
    lender.ingest(res.lenderPayloads[0]!);
    await c.sync();
    const stream = await c.proveStream(current(c), { minRemaining: 1_000n * U, minRate: 10n * U, audience: 2n });
    const principalC = 500n * U;
    // tokens that reach the inbox before funding are not repayment (StreamLoan.onPledge credits only while funded)
    const early = 1_000n;
    await send(connection, authority, [createAtaIx(authority.publicKey, slotPda(refC), mint), mintToIx(mint, slotInbox(refC, mint), authority.publicKey, early)]);
    await lender.fund(refC, stream, mint, principalC, payout);
    expect((await lender.loan(refC)).expiry).toBe(expiry);
    expect((await lender.loan(refC)).repaid).toBe(0n);
    expect((await lender.ledger(refC, mint))!.held).toBe(early);
    expect(await lender.shortfall(refC)).toBe(principalC);
    // loan `ref` has not expired: no shortfall
    expect(await lender.shortfall(ref)).toBe(0n);
    // the agent is expired; the owner reclaims and the lender's share is still routed
    await expect(c.pay(current(c), 1n * U, vendorKp.publicKey)).rejects.toThrow();
    await owner.sync();
    const target = current(owner, c.account.keys.pk);
    const share = lenderShare(target.allowance, target.allowance.remaining);
    expect(share).toBe(shareOf(1_000n * U, BPS));
    // the reclaim is submitted without the lender's account: the share waits in the pool escrow, and the
    // escrow already counts as paid (otherwise a lender could route shares to escrow, slash the safety pool
    // for the full principal, then pull the escrow too)
    const reclaim = await owner.prepareSpend(target, target.allowance.remaining, owner.address);
    await owner.submitSpend({ ...reclaim, accounts: { ...reclaim.accounts, lenderToken: undefined } });
    expect(await bal(slotEscrow(refC, mint))).toBe(share);
    expect(await bal(slotInbox(refC, mint))).toBe(early);
    expect(await lender.shortfall(refC)).toBe(principalC - share);
    // pulled into the inbox: routed but not yet synced still counts
    await pool.pullLenderShare(strangerKp, mint, slotPda(refC), refC);
    expect(await bal(slotInbox(refC, mint))).toBe(early + share);
    expect(await lender.shortfall(refC)).toBe(principalC - share);
    await lender.syncLoan(refC, undefined, strangerKp);
    expect((await lender.loan(refC)).repaid).toBe(share);
    expect(await lender.shortfall(refC)).toBe(principalC - share);
    // the early tokens were held for the lender, not credited
    const lenderBefore = await bal(lenderAta);
    await lender.collect(refC, mint, lenderAta);
    expect(await bal(lenderAta)).toBe(lenderBefore + early);
    // only the slot lender settles; afterwards no shortfall is reported
    await expectCode(send(connection, strangerKp, [settleIx(strangerKp.publicKey, refC)]), LOAN_ERROR.NotTheLender);
    const fakeSettle = settleIx(strangerKp.publicKey, refC);
    expect(fakeSettle.keys[1].isSigner).toBe(true);
    await lender.settle(refC);
    expect((await lender.loan(refC)).settled).toBe(true);
    expect(await lender.shortfall(refC)).toBe(0n);
  });

  it('fund refuses a slot whose pool escrow holds shares; the SDK pulls them into the inbox first, where they are held, not credited', async () => {
    const refE = await lender.openSlot();
    const g = new SolanaWallet(Account.random(), pool, agentKp);
    const now = await pool.now();
    const res = await owner.grant(mint, [{ to: g.address, amount: 100n * U, streamRate: 1n * U, streamStart: now - 1_000n, pledge: lender.terms(refE, BPS) }]);
    lender.ingest(res.lenderPayloads[0]!);
    await g.sync();
    const stream = await g.proveStream(current(g), { minRemaining: 100n * U, minRate: 1n * U, audience: 3n });
    // before funding the owner reclaims; the slot has no inbox yet, so the pool escrows the share
    await owner.sync();
    const target = current(owner, g.account.keys.pk);
    const share = lenderShare(target.allowance, target.allowance.remaining);
    expect(share).toBeGreaterThan(0n);
    await owner.reclaim(target);
    const escrow = slotEscrow(refE, mint);
    expect(await bal(escrow)).toBe(share);
    await expectCode(lender.fundUnchecked(refE, stream, mint, 1n * U, payout, { pullEscrow: false }), LOAN_ERROR.EscrowNotEmpty);
    await lender.fundUnchecked(refE, stream, mint, 1n * U, payout);
    expect(await bal(escrow)).toBe(0n);
    expect(await bal(slotInbox(refE, mint))).toBe(share);
    const loan = await lender.loan(refE);
    expect(loan.funded).toBe(true);
    expect(loan.repaid).toBe(0n);
    expect((await lender.ledger(refE, mint))!.held).toBe(share);
  });

  it('fund instruction is refused for an unknown pool program', async () => {
    const ix = fundIx({
      lender: lenderKp.publicKey, loanRef: ref2, principal: 1n, poolProgram: SystemProgram.programId, poolState: slotPda(ref2), buffer: slotPda(ref2), mint,
      lenderSource: lenderAta, payoutTo: payout,
    });
    await expectCode(send(connection, lenderKp, [ix]), LOAN_ERROR.BadBuffer);
  });
});

export { createAtaIx, createMint, freezeIx, mintToIx, tokenBalance };
