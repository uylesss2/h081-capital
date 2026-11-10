// stream_loan on a private solana-test-validator (WSL, rpc 127.0.0.1:9099) next to stipend_pool.
// Run with `npm run test:solana:loan` (restarts that validator, then runs this file only).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { initCrypto, lenderKey, shareOf, lenderShare } from '../../src/crypto.js';
import { randomViewingKey } from '../../src/encryption.js';
import { Account } from '../../src/client.js';
import {
  LOCALNET_POOL_PROGRAM_ID, POOL_ERROR, SolanaPool, SolanaWallet, concatBytes, customErrorCode, encodeSpendArgs, fieldOf, pullLenderShareIx, send,
  simulate, spendIx, type PreparedSpend, type SolOwnedAllowance, type SpendArgs,
} from '../../src/solana/index.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, GRACE, LOAN_ERROR, LOAN_TREASURY, LOCALNET_LOAN_PROGRAM_ID, ORIGINATION_FEE_BPS, SPL_TOKEN_PROGRAM_ID, SolanaLoanLenderWallet,
  associatedTokenAddress, claimIx, decodeRegistry, decodeSlot, collectIx, decodeLedger, fundIx, ledgerPda, loanFundedEvents, loanInitializeIx,
  loanTreasuryAccount, maxPrincipal, minRemainingFor, openSlotIx, originationFee, payoutAudience, recordSlashIx, registryPda, settleIx, shortfallIx, slotEscrow,
  slotInbox, slotPda, subrogationPda, syncIx,
  CLOSED_SLOT_ACCOUNT_SIZE, closeSlotIx, closedSlotPda, decodeClosedSlot, loanStatus, reclaimableSlots, slotClosedEvents, sweepClosedIx,
  CLOSED_SLOT_V2_SIZE, loanExcess, returnExcess, returnExcessIx,
} from '../../src/solana/lender.js';
import { LOCALNET_UPGRADE_AUTHORITY } from './config-authority.js';
import { LOCALNET_SAFETY_POOL_FAST_PROGRAM_ID, TOKEN22_PROGRAM_ID, coverPda } from '../../src/solana/token.js';

// The H081 launch wallets hold the token's trading creator fees (the team's); the loan fee never goes there.
const LAUNCH_WALLETS = ['2wjxKzH7fVGpjcA9KpjDBDHjSAhz7u8ZgMLnVPVGSkDP', 'FZEMfMN7hhQcKPHRt2kb9ig5XArMvK5LqfSTXpQ1j4DZ', '5XJNtM7a9ocRL8f8vsyNVmQoekutCFJkGNXNQbkJP4bw'];

describe('origination fee (platform fee, no validator)', () => {
  it('is 0.25% of the principal, rounded down; loans under 400 base units pay none', () => {
    expect(ORIGINATION_FEE_BPS).toBe(25n);
    expect(originationFee(0n)).toBe(0n);
    expect(originationFee(399n)).toBe(0n);
    expect(originationFee(400n)).toBe(1n);
    expect(originationFee(300_000_000n)).toBe(750_000n);
    expect(originationFee(2n ** 64n - 1n)).toBe((2n ** 64n - 1n) / 400n);
  });
  it('goes to the treasury, never to a launch (creator-fee) wallet', () => {
    expect(LAUNCH_WALLETS).not.toContain(LOAN_TREASURY.toBase58());
    expect(loanTreasuryAccount(PublicKey.default).equals(associatedTokenAddress(LOAN_TREASURY, PublicKey.default))).toBe(true);
  });
});

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
async function createMint(authority: Keypair, decimals = 6, tp = SPL_TOKEN_PROGRAM_ID): Promise<PublicKey> {
  const mint = Keypair.generate();
  const lamports = await connection.getMinimumBalanceForRentExemption(MINT_LEN);
  await send(connection, authority, [
    SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: mint.publicKey, lamports, space: MINT_LEN, programId: tp }),
    initMint2Ix(mint.publicKey, decimals, authority.publicKey, authority.publicKey, tp),
  ], { signers: [mint] });
  return mint.publicKey;
}
/** Token-2022 mint with a PermanentDelegate extension (like USDG): `delegate` can move tokens out of any account. */
async function createPermanentDelegateMint(authority: Keypair, delegate: PublicKey): Promise<PublicKey> {
  const tp = TOKEN22_PROGRAM_ID;
  const mint = Keypair.generate();
  const space = 165 + 1 + 4 + 32; // base mint padded to 165, account type, TLV(PermanentDelegate)
  const lamports = await connection.getMinimumBalanceForRentExemption(space);
  const initDelegate = new TransactionInstruction({
    programId: tp, keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }], data: Buffer.concat([Buffer.from([35]), delegate.toBuffer()]),
  });
  await send(connection, authority, [
    SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: mint.publicKey, lamports, space, programId: tp }),
    initDelegate, initMint2Ix(mint.publicKey, 6, authority.publicKey, authority.publicKey, tp),
  ], { signers: [mint] });
  return mint.publicKey;
}
function transferCheckedIx(from: PublicKey, mint: PublicKey, to: PublicKey, owner: PublicKey, amount: bigint, decimals: number, tp = SPL_TOKEN_PROGRAM_ID) {
  const data = Buffer.alloc(10); data[0] = 12; data.writeBigUInt64LE(amount, 1); data[9] = decimals;
  return new TransactionInstruction({
    programId: tp, keys: [{ pubkey: from, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: to, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }], data,
  });
}
async function tokenBalance(account: PublicKey): Promise<bigint> {
  const info = await connection.getAccountInfo(account, 'confirmed');
  if (!info) return 0n;
  return Buffer.from(info.data).readBigUInt64LE(64);
}

/** Bodies (after the 8-byte discriminator) of the `name` events in a transaction's logs. */
function eventsNamed(logs: string[], name: string): Buffer[] {
  const disc = createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
  return logs.filter((l) => l.startsWith('Program data: ')).map((l) => Buffer.from(l.slice('Program data: '.length), 'base64'))
    .filter((d) => d.length >= 8 && d.subarray(0, 8).equals(disc)).map((d) => d.subarray(8));
}
/** ExcessHeld (waiting: a level) / ExcessReturned (amount): loan_ref u64 | asset 32 | u64 ... */
const excessAmounts = (logs: string[], name: 'ExcessHeld' | 'ExcessReturned') => eventsNamed(logs, name).map((b) => b.readBigUInt64LE(40));

// Compute units of the overpay-cap instructions on this validator, with a budget each (OP_CU_LIMIT is 1.4M). Written to
// solana/compute-units-loan.json after a run that measured all of them (compute-units-ops.json belongs to the pool e2e suite,
// which rewrites it whole).
const CU_BUDGET: Record<string, number> = {
  claim_capped: 400_000, sync_excess: 60_000, return_excess_open: 60_000, return_excess_closed: 60_000, sweep_closed_held: 60_000, collect_legacy: 40_000,
};
const loanCu: Record<string, number> = {};
function recordCu(name: keyof typeof CU_BUDGET, units: number | undefined) {
  expect(units, `${name}: no compute units in the transaction meta`).toBeGreaterThan(0);
  expect(units!).toBeLessThan(CU_BUDGET[name]);
  loanCu[name] = Math.max(loanCu[name] ?? 0, units!);
  console.log(`${name}: compute units ${units}`);
}
afterAll(() => {
  if (Object.keys(CU_BUDGET).every((k) => loanCu[k] !== undefined)) {
    writeFileSync(resolve(import.meta.dirname, '..', '..', 'solana', 'compute-units-loan.json'),
      JSON.stringify({ measured: new Date().toISOString(), rpc: RPC, budget: CU_BUDGET, computeUnits: loanCu }, null, 2) + '\n');
  }
});

// ---- localnet program upgrade (the migration test): WSL solana CLI against 127.0.0.1:9099 only ----
const SOLANA_DIR = resolve(import.meta.dirname, '..', '..', 'solana');
const toWsl = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => `/mnt/${d.toLowerCase()}`);
/** Upgrades stream_loan on the loan validator to `so` (solana/scripts/loan-upgrade-localnet.sh), signed by the localnet authority. */
function upgradeLoanProgram(so: string) {
  const dir = mkdtempSync(join(tmpdir(), 'loan-upgrade-'));
  const auth = join(dir, 'authority.json');
  writeFileSync(auth, JSON.stringify(Array.from(LOCALNET_UPGRADE_AUTHORITY.secretKey)));
  try {
    const script = join(SOLANA_DIR, 'scripts', 'loan-upgrade-localnet.sh');
    const win = process.platform === 'win32';
    const args = [win ? toWsl(script) : script, win ? toWsl(so) : so, win ? toWsl(auth) : auth, LOAN.toBase58()];
    const r = spawnSync(win ? 'wsl.exe' : 'bash', win ? ['-d', 'Ubuntu', '--', 'bash', ...args] : args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    if (r.status !== 0) throw new Error(`localnet upgrade to ${so} failed: ${r.stdout}${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  it('initializes once, only by the upgrade authority, and opens sequential slots with no owner', async () => {
    if (!(await connection.getAccountInfo(registryPda()))) {
      // anyone else is refused: the program reads its ProgramData account
      await expectCode(send(connection, payer, [loanInitializeIx(payer.publicKey)]), LOAN_ERROR.UpgradeAuthority);
      await fundSol(LOCALNET_UPGRADE_AUTHORITY.publicKey);
      await send(connection, LOCALNET_UPGRADE_AUTHORITY, [loanInitializeIx(LOCALNET_UPGRADE_AUTHORITY.publicKey)]);
    }
    await expect(send(connection, LOCALNET_UPGRADE_AUTHORITY, [loanInitializeIx(LOCALNET_UPGRADE_AUTHORITY.publicKey)])).rejects.toThrow();
    // a forged ProgramData account (any other address) is refused by the seeds constraint
    const forged = loanInitializeIx(payer.publicKey);
    forged.keys[3].pubkey = payer.publicKey;
    await expect(send(connection, payer, [forged])).rejects.toThrow();
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

suite('inbox of an unfunded slot', () => {
  it('nothing is forwarded, held or collectable before the slot is funded: routed shares wait in the inbox', async () => {
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
    // a share routed to the slot before it is funded, with the lender's account ready to take it
    await send(connection, lender, [createAtaIx(lender.publicKey, lender.publicKey, mint)]);
    await send(connection, authority, [createAtaIx(authority.publicKey, slotPda(ref), mint), mintToIx(mint, inbox, authority.publicKey, 7_000n)]);
    await send(connection, stranger, [syncIx(stranger.publicKey, ref, mint, lender.publicKey)]);
    // not forwarded (a lender that never funds must not collect a borrower's pledge), not held, not credited
    expect(await tokenBalance(lenderAta)).toBe(0n);
    expect(await tokenBalance(inbox)).toBe(7_000n);
    const ledger = decodeLedger((await connection.getAccountInfo(ledgerPda(ref, mint), 'confirmed'))!.data);
    expect(ledger.held).toBe(0n);
    expect(ledger.received).toBe(0n);
    await expectCode(send(connection, lender, [collectIx(lender.publicKey, ref, mint, lenderAta)]), LOAN_ERROR.NothingOwed);
    expect(await tokenBalance(inbox)).toBe(7_000n);
    expect((await readSlot(ref)).repaid).toBe(0n);
    // a sync aimed at another account than the lender's ATA is still refused
    const wrong = syncIx(stranger.publicKey, ref, mint, lender.publicKey);
    wrong.keys[5].pubkey = associatedTokenAddress(stranger.publicKey, mint);
    await expectCode(send(connection, stranger, [wrong]), LOAN_ERROR.BadLenderAccount);
    // and a claim through an unfunded slot is refused before the pool is reached
    const claim = claimIx(lender.publicKey, ref, mint, new TransactionInstruction({ programId: POOL, keys: [], data: Buffer.alloc(8) }));
    await expectCode(send(connection, lender, [claim]), LOAN_ERROR.NoLoan);
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
    // stipend_pool is loaded upgradeable on the loan validator; only its upgrade authority may initialize
    await fundSol(LOCALNET_UPGRADE_AUTHORITY.publicKey);
    await pool.initialize(LOCALNET_UPGRADE_AUTHORITY);
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
    // the borrower fixes the amount it borrows: minRemaining is the smallest bound whose pledged share is the principal
    const minRemaining = minRemainingFor(principal, BPS);
    expect(minRemaining).toBe(750n * U);
    expect(maxPrincipal(minRemaining, BPS)).toBe(principal);
    const stream = await b.proveStream(current(b), { minRemaining, minRate: 10n * U, audience: payoutAudience(payout) });
    expect(stream.args.audience).toBe(fieldOf(payout));
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
    // ... and only to the account the proof was made for, for at most what the pledge can repay
    const strangerAta = associatedTokenAddress(strangerKp.publicKey, mint);
    await send(connection, authority, [createAtaIx(authority.publicKey, strangerKp.publicKey, mint)]);
    await expect(lender.fund(ref, stream, mint, principal, strangerAta)).rejects.toThrow(/not made for this payout account/);
    expect(maxPrincipal(1_000n * U, Number(BPS))).toBe(400n * U);
    // ... and for exactly the amount the proof backs: neither more nor less (a smaller loan would still take the whole pledge)
    await expect(lender.fund(ref, stream, mint, principal + 1n, payout)).rejects.toThrow(/must be exactly what the proof backs/);
    await expect(lender.fund(ref, stream, mint, principal - 1n, payout)).rejects.toThrow(/must be exactly what the proof backs/);

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
    // the fee only goes to the treasury's associated token account of the loan asset
    await expectCode(lender.fundUnchecked(ref, stream, mint, principal, payout, { treasury: lenderAta }), LOAN_ERROR.BadTreasury);
    await expectCode(lender.fundUnchecked(ref, stream, mint, principal, payout, { treasury: loanTreasuryAccount(otherMint) }), LOAN_ERROR.BadTreasury);
    // a token account owned by the treasury that is not its associated account
    const treasurySide = await sideAccount(strangerKp, mint, LOAN_TREASURY);
    await expectCode(lender.fundUnchecked(ref, stream, mint, principal, payout, { treasury: treasurySide }), LOAN_ERROR.BadTreasury);
    for (const w of LAUNCH_WALLETS) {
      await expectCode(lender.fundUnchecked(ref, stream, mint, principal, payout, { treasury: associatedTokenAddress(new PublicKey(w), mint) }), LOAN_ERROR.BadTreasury);
    }
    // the principal goes only to the account the borrower proved for (audience = fieldOf(payout_to))
    await expectCode(lender.fundUnchecked(ref, stream, mint, principal, strangerAta), LOAN_ERROR.PayoutNotProven);
    // re-pointing the audience to another account: the verifier refuses the proof
    await expectCode(lender.fundUnchecked(ref, { proof: stream.proof, args: { ...stream.args, audience: fieldOf(strangerAta) } }, mint, principal, strangerAta), POOL_ERROR.InvalidProof);
    // never to the lender itself (its source account or any account it owns), nor to the slot's inbox
    await expectCode(lender.fundUnchecked(ref, stream, mint, principal, lenderAta), LOAN_ERROR.BadPayout);
    const lenderSide = await sideAccount(strangerKp, mint, lenderKp.publicKey);
    await expectCode(lender.fundUnchecked(ref, stream, mint, principal, lenderSide), LOAN_ERROR.BadPayout);
    await expectCode(lender.fundUnchecked(ref, stream, mint, principal, slotInbox(ref, mint)), LOAN_ERROR.BadPayout);
    // the principal is exactly what the pledge backs, min_remaining * pledge_bps / 10,000: the lender cannot lend one
    // unit and capture the whole pledge, nor more than the proof backs
    await expectCode(lender.fundUnchecked(ref, stream, mint, principal + 1n, payout), LOAN_ERROR.PrincipalMismatch);
    await expectCode(lender.fundUnchecked(ref, stream, mint, principal - 1n, payout), LOAN_ERROR.PrincipalMismatch);
    await expectCode(lender.fundUnchecked(ref, stream, mint, 1n, payout), LOAN_ERROR.PrincipalMismatch);
    await expectCode(lender.fundUnchecked(ref, stream, mint, 0n, payout), LOAN_ERROR.PrincipalMismatch);

    const treasury = loanTreasuryAccount(mint);
    const fee = originationFee(principal);
    expect(fee).toBe(750_000n); // 0.25% of 300 tokens
    const before = await bal(payout);
    const lenderBefore = await bal(lenderAta);
    const treasuryBefore = await bal(treasury);
    const tx = await lender.fund(ref, stream, mint, principal, payout);
    // the borrower gets principal - fee, the treasury the fee; the lender pays the principal
    expect(await bal(payout)).toBe(before + principal - fee);
    expect(await bal(treasury)).toBe(treasuryBefore + fee);
    expect(await bal(lenderAta)).toBe(lenderBefore - principal);
    expect(await bal(treasurySide)).toBe(0n);
    const [ev] = loanFundedEvents(tx.logs);
    expect(ev).toBeDefined();
    expect(ev.loanRef).toBe(ref);
    expect(ev.principal).toBe(principal);
    expect(ev.fee).toBe(fee);
    expect(ev.payoutTo.equals(payout)).toBe(true);
    const loan = await lender.loan(ref);
    expect(loan.funded).toBe(true);
    // the loan owes the full principal, not principal - fee
    expect(loan.principal).toBe(principal);
    expect(loan.repaid).toBe(0n);
    expect(loan.pledgeBps).toBe(BPS);
    expect(loan.agentPk).toBe(b.account.keys.pk);
    expect(loan.streamStart).toBe(streamStart);
    expect(loan.asset.equals(mint)).toBe(true);
    expect(loan.payoutTo.equals(payout)).toBe(true);
    expect(loan.minRemaining).toBe(minRemaining);
    // the inbox exists now, so routed shares land in it
    expect(await connection.getAccountInfo(slotInbox(ref, mint), 'confirmed')).not.toBeNull();
    await expectCode(lender.fundUnchecked(ref, stream, mint, principal, payout), LOAN_ERROR.AlreadyFunded);
  });

  it('record_slash (subrogation) takes only a safety_pool config PDA as signer; no stranger can redirect a loan\'s receipts', async () => {
    // a plain keypair signing as the "safety config" (the payer itself, then the lender)
    await expectCode(send(connection, strangerKp, [recordSlashIx(strangerKp.publicKey, ref, 1n, strangerKp.publicKey, lenderAta)]), LOAN_ERROR.NotSafetyPool);
    await expectCode(send(connection, strangerKp, [recordSlashIx(strangerKp.publicKey, ref, 1n, lenderKp.publicKey, lenderAta)], { signers: [lenderKp] }), LOAN_ERROR.NotSafetyPool);
    // an unfunded slot has nothing to record
    await expectCode(send(connection, strangerKp, [recordSlashIx(strangerKp.publicKey, ref2, 1n, strangerKp.publicKey, lenderAta)]), LOAN_ERROR.NoLoan);
    expect(await connection.getAccountInfo(subrogationPda(ref), 'confirmed')).toBeNull();
    // without a recorded slash, sync accepts any stand-in for the subrogation `to` account
    await lender.syncLoan(ref, undefined, strangerKp);
  });

  it('a stream that has not started cannot be funded', async () => {
    const f = new SolanaWallet(Account.random(), pool, agentKp);
    const now = await pool.now();
    const res = await owner.grant(mint, [{ to: f.address, amount: 100n * U, streamRate: 1n * U, streamStart: now + 86400n, pledge: lender.terms(ref2, BPS) }]);
    lender.ingest(res.lenderPayloads[0]!);
    await f.sync();
    const future = await f.proveStream(f.agentAllowances(mint)[0], { minRemaining: 100n * U, minRate: 1n * U, audience: payoutAudience(payout) });
    await expectCode(lender.fund(ref2, future, mint, 40n * U, payout), LOAN_ERROR.StreamNotStarted);
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
    // a partial claim (the default would now be capped at what the loan owes and repay it in full; the replay below needs it open)
    const pc = await lender.prepareClaim(ref, claimable < 100n * U ? claimable : 100n * U);
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
    await expectCode(lender.submitClaim(pc, ref2), LOAN_ERROR.NoLoan);
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
    const stream = await c.proveStream(current(c), { minRemaining: 1_000n * U, minRate: 10n * U, audience: payoutAudience(payout) });
    const principalC = 400n * U;
    // tokens that reach the inbox before funding wait there (never forwarded to the lender); `fund` returns them to
    // the borrower's payout account: they repaid nothing, and the lender must not count them as repayment
    const early = 1_000n;
    await send(connection, authority, [createAtaIx(authority.publicKey, slotPda(refC), mint), mintToIx(mint, slotInbox(refC, mint), authority.publicKey, early)]);
    const payoutBefore = await bal(payout);
    const lenderAtFund = await bal(lenderAta);
    const fundTx = await lender.fund(refC, stream, mint, principalC, payout);
    expect(await bal(payout)).toBe(payoutBefore + principalC - originationFee(principalC) + early);
    expect(await bal(lenderAta)).toBe(lenderAtFund - principalC);
    expect(fundTx.logs.some((l) => l.startsWith('Program data: '))).toBe(true); // LoanFunded + PreFundReturned
    expect((await lender.loan(refC)).expiry).toBe(expiry);
    expect((await lender.loan(refC)).repaid).toBe(0n);
    expect((await lender.ledger(refC, mint))!.held).toBe(0n);
    expect(await bal(slotInbox(refC, mint))).toBe(0n);
    // the borrower received principal - fee (+ its early tokens back), but the shortfall (and so repayment) is on
    // the full principal: the early tokens count for nothing
    expect(await lender.shortfall(refC)).toBe(principalC);
    await lender.syncLoan(refC, undefined, strangerKp);
    expect((await lender.loan(refC)).repaid).toBe(0n);
    // loan `ref` has not expired: no shortfall
    expect(await lender.shortfall(ref)).toBe(0n);
    // the agent is expired; the owner reclaims and the lender's share is still routed
    await expect(c.pay(current(c), 1n * U, vendorKp.publicKey)).rejects.toThrow();
    await owner.sync();
    const target = current(owner, c.account.keys.pk);
    // the owner reclaims half: its share (200 tokens) repays half of the 400-token loan
    const half = target.allowance.remaining / 2n;
    const share = lenderShare(target.allowance, half);
    expect(share).toBe(shareOf(500n * U, BPS));
    // the reclaim is submitted without the lender's account: the share waits in the pool escrow, and the
    // escrow already counts as paid (otherwise a lender could route shares to escrow, slash the safety pool
    // for the full principal, then pull the escrow too)
    const reclaim = await owner.prepareSpend(target, half, owner.address);
    await owner.submitSpend({ ...reclaim, accounts: { ...reclaim.accounts, lenderToken: undefined } });
    expect(await bal(slotEscrow(refC, mint))).toBe(share);
    expect(await bal(slotInbox(refC, mint))).toBe(0n);
    expect(await lender.shortfall(refC)).toBe(principalC - share);
    // pulled into the inbox: routed but not yet synced still counts
    await pool.pullLenderShare(strangerKp, mint, slotPda(refC), refC);
    expect(await bal(slotInbox(refC, mint))).toBe(share);
    expect(await lender.shortfall(refC)).toBe(principalC - share);
    const lenderBefore = await bal(lenderAta);
    await lender.syncLoan(refC, undefined, strangerKp);
    // the share routed after funding is repayment and reaches the lender
    expect((await lender.loan(refC)).repaid).toBe(share);
    expect(await lender.shortfall(refC)).toBe(principalC - share);
    expect(await bal(lenderAta)).toBe(lenderBefore + share);
    await expectCode(lender.collect(refC, mint, lenderAta), LOAN_ERROR.NothingOwed);
    // only the slot lender settles; afterwards no shortfall is reported
    await expectCode(send(connection, strangerKp, [settleIx(strangerKp.publicKey, refC)]), LOAN_ERROR.NotTheLender);
    const fakeSettle = settleIx(strangerKp.publicKey, refC);
    expect(fakeSettle.keys[1].isSigner).toBe(true);
    await lender.settle(refC);
    expect((await lender.loan(refC)).settled).toBe(true);
    expect(await lender.shortfall(refC)).toBe(0n);
  });

  it('fund refuses a slot whose pool escrow holds shares; the SDK pulls them into the inbox first, and fund returns them to the borrower', async () => {
    const refE = await lender.openSlot();
    const g = new SolanaWallet(Account.random(), pool, agentKp);
    const now = await pool.now();
    const res = await owner.grant(mint, [{ to: g.address, amount: 100n * U, streamRate: 1n * U, streamStart: now - 1_000n, pledge: lender.terms(refE, BPS) }]);
    lender.ingest(res.lenderPayloads[0]!);
    await g.sync();
    const stream = await g.proveStream(current(g), { minRemaining: 100n * U, minRate: 1n * U, audience: payoutAudience(payout) });
    // before funding the owner reclaims; the slot has no inbox yet, so the pool escrows the share
    await owner.sync();
    const target = current(owner, g.account.keys.pk);
    const share = lenderShare(target.allowance, target.allowance.remaining);
    expect(share).toBeGreaterThan(0n);
    await owner.reclaim(target);
    const escrow = slotEscrow(refE, mint);
    expect(await bal(escrow)).toBe(share);
    const principalE = maxPrincipal(100n * U, BPS); // 40 tokens: what the proof backs
    await expectCode(lender.fundUnchecked(refE, stream, mint, principalE, payout, { pullEscrow: false }), LOAN_ERROR.EscrowNotEmpty);
    const payoutBefore = await bal(payout);
    await lender.fundUnchecked(refE, stream, mint, principalE, payout);
    // the pulled share went through the inbox and back to the borrower with the principal: it repays nothing
    expect(await bal(payout)).toBe(payoutBefore + principalE - originationFee(principalE) + share);
    expect(await bal(escrow)).toBe(0n);
    expect(await bal(slotInbox(refE, mint))).toBe(0n);
    const loan = await lender.loan(refE);
    expect(loan.funded).toBe(true);
    expect(loan.repaid).toBe(0n);
    expect((await lender.ledger(refE, mint))!.held).toBe(0n);
    await lender.syncLoan(refE);
    expect((await lender.loan(refE)).repaid).toBe(0n);
    expect(await lender.shortfall(refE)).toBe(0n); // no expiry on this allowance
  });

  it('a tiny loan pays no origination fee (rounds down to 0); the treasury account is still address-checked', async () => {
    const refT = await lender.openSlot();
    const t = new SolanaWallet(Account.random(), pool, agentKp);
    const now = await pool.now();
    const res = await owner.grant(mint, [{ to: t.address, amount: 10n * U, streamRate: 1n * U, streamStart: now - 1_000n, expiry: now + 86400n, pledge: lender.terms(refT, BPS) }]);
    lender.ingest(res.lenderPayloads[0]!);
    await t.sync();
    const tiny = 399n;
    const stream = await t.proveStream(current(t), { minRemaining: minRemainingFor(tiny, BPS), minRate: 1n * U, audience: payoutAudience(payout) });
    expect(stream.args.minRemaining).toBe(998n); // ceil(399 * 10,000 / 4,000); floor(998 * 4,000 / 10,000) = 399
    expect(originationFee(tiny)).toBe(0n);
    await expectCode(lender.fundUnchecked(refT, stream, mint, tiny, payout, { treasury: lenderAta }), LOAN_ERROR.BadTreasury);
    const treasury = loanTreasuryAccount(mint);
    const [payoutBefore, treasuryBefore, lenderBefore] = [await bal(payout), await bal(treasury), await bal(lenderAta)];
    const tx = await lender.fund(refT, stream, mint, tiny, payout);
    expect(await bal(payout)).toBe(payoutBefore + tiny);
    expect(await bal(treasury)).toBe(treasuryBefore);
    expect(await bal(lenderAta)).toBe(lenderBefore - tiny);
    expect(loanFundedEvents(tx.logs)[0].fee).toBe(0n);
    expect((await lender.loan(refT)).principal).toBe(tiny);
  });

  /**
   * A fresh slot with a started stream on `m` pledged to it (budget 100 tokens, fully vested, 40% pledged: backs up to
   * 40 tokens), ready to fund to `to`. `minRemaining` fixes the principal the proof backs (minRemainingFor).
   */
  async function streamFor(m: PublicKey, to = payout, minRemaining = 100n * U) {
    const refN = await lender.openSlot();
    const t = new SolanaWallet(Account.random(), pool, agentKp);
    const now = await pool.now();
    const res = await owner.grant(m, [{ to: t.address, amount: 100n * U, streamRate: 1n * U, streamStart: now - 1_000n, expiry: now + 86400n, pledge: lender.terms(refN, BPS) }]);
    lender.ingest(res.lenderPayloads[0]!);
    await t.sync();
    const live = t.agentAllowances(m).filter((a) => a.allowance.remaining > 0n);
    expect(live).toHaveLength(1);
    return { refN, t, stream: await t.proveStream(live[0], { minRemaining, minRate: 1n * U, audience: payoutAudience(to) }) };
  }

  it('a frozen treasury account never blocks lending: the loan is funded with no fee', async () => {
    const { refN, stream } = await streamFor(mint);
    const principalF = 40n * U;
    await send(connection, authority, [mintToIx(mint, lenderAta, authority.publicKey, principalF)]);
    const treasury = loanTreasuryAccount(mint);
    expect(originationFee(principalF)).toBe(100_000n);
    await send(connection, authority, [freezeIx(treasury, mint, authority.publicKey)]);
    try {
      const [payoutBefore, treasuryBefore, lenderBefore] = [await bal(payout), await bal(treasury), await bal(lenderAta)];
      const tx = await lender.fund(refN, stream, mint, principalF, payout);
      expect(await bal(payout)).toBe(payoutBefore + principalF);
      expect(await bal(treasury)).toBe(treasuryBefore);
      expect(await bal(lenderAta)).toBe(lenderBefore - principalF);
      expect(loanFundedEvents(tx.logs)[0].fee).toBe(0n);
      expect((await lender.loan(refN)).principal).toBe(principalF);
    } finally {
      await send(connection, authority, [freezeIx(treasury, mint, authority.publicKey, true)]);
    }
  });

  it('Token-2022 asset: the fee goes to the treasury ATA derived under Token-2022; the SPL-derived account is refused', async () => {
    const T22 = TOKEN22_PROGRAM_ID;
    const m22 = await createMint(authority, 6, T22);
    await send(connection, authority, [ownerKp, lenderKp, borrowerKp].map((k) => createAtaIx(authority.publicKey, k.publicKey, m22, T22)));
    const lenderAta22 = associatedTokenAddress(lenderKp.publicKey, m22, T22);
    const payout22 = associatedTokenAddress(borrowerKp.publicKey, m22, T22);
    await send(connection, authority, [
      mintToIx(m22, associatedTokenAddress(ownerKp.publicKey, m22, T22), authority.publicKey, 1_000n * U, T22),
      mintToIx(m22, lenderAta22, authority.publicKey, 1_000n * U, T22),
    ]);
    await owner.deposit(m22, 500n * U);
    const { refN, stream } = await streamFor(m22, payout22);
    const principal22 = 40n * U;
    const fee = originationFee(principal22);
    expect(fee).toBe(100_000n);
    const treasury22 = loanTreasuryAccount(m22, T22);
    expect(treasury22.equals(loanTreasuryAccount(m22))).toBe(false);
    // the treasury's SPL-Token-derived address is not its account for a Token-2022 asset
    await expectCode(lender.fundUnchecked(refN, stream, m22, principal22, payout22, { treasury: loanTreasuryAccount(m22) }), LOAN_ERROR.BadTreasury);
    const [payoutBefore, treasuryBefore, lenderBefore] = [await bal(payout22), await bal(treasury22), await bal(lenderAta22)];
    const tx = await lender.fund(refN, stream, m22, principal22, payout22);
    expect(await bal(payout22)).toBe(payoutBefore + principal22 - fee);
    expect(await bal(treasury22)).toBe(treasuryBefore + fee);
    expect(await bal(lenderAta22)).toBe(lenderBefore - principal22);
    expect(loanFundedEvents(tx.logs)[0].fee).toBe(fee);
    expect((await lender.loan(refN)).principal).toBe(principal22);
  });

  it('funded loan: a frozen lender account holds shares for collect; a permanent delegate draining the inbox is reconciled', async () => {
    const delegate = Keypair.generate();
    const mPd = await createPermanentDelegateMint(authority, delegate.publicKey);
    const T22 = TOKEN22_PROGRAM_ID;
    await send(connection, authority, [ownerKp, lenderKp, borrowerKp].map((k) => createAtaIx(authority.publicKey, k.publicKey, mPd, T22)));
    const lenderPd = associatedTokenAddress(lenderKp.publicKey, mPd, T22);
    const payoutPd = associatedTokenAddress(borrowerKp.publicKey, mPd, T22);
    await send(connection, authority, [
      mintToIx(mPd, associatedTokenAddress(ownerKp.publicKey, mPd, T22), authority.publicKey, 1_000n * U, T22),
      mintToIx(mPd, lenderPd, authority.publicKey, 1_000n * U, T22),
    ]);
    await owner.deposit(mPd, 500n * U);
    const { refN, stream } = await streamFor(mPd, payoutPd);
    await lender.fund(refN, stream, mPd, 40n * U, payoutPd);
    const inbox = slotInbox(refN, mPd, T22);
    const loan = () => lender.loan(refN);
    // the lender's account is frozen: a routed share is credited and held
    await send(connection, authority, [freezeIx(lenderPd, mPd, authority.publicKey, false, T22), mintToIx(mPd, inbox, authority.publicKey, 100n, T22)]);
    await lender.syncLoan(refN, undefined, strangerKp);
    expect((await loan()).repaid).toBe(100n);
    expect((await lender.ledger(refN, mPd))!.held).toBe(100n);
    // the issuer's permanent delegate takes the held tokens out of the inbox
    const sink = associatedTokenAddress(delegate.publicKey, mPd, T22);
    await fundSol(delegate.publicKey);
    await send(connection, delegate, [createAtaIx(delegate.publicKey, delegate.publicKey, mPd, T22), transferCheckedIx(inbox, mPd, sink, delegate.publicKey, 100n, 6, T22)]);
    expect(await bal(inbox)).toBe(0n);
    // a sync (anyone may send one) reconciles held down to the inbox balance (HeldReconciled event)...
    const rec = await lender.syncLoan(refN, undefined, strangerKp);
    expect(rec.logs.some((l) => l.startsWith('Program data: '))).toBe(true);
    expect((await lender.ledger(refN, mPd))!.held).toBe(0n);
    // ...so the next repayment is credited and forwarded again instead of being absorbed by a stale held
    await send(connection, authority, [freezeIx(lenderPd, mPd, authority.publicKey, true, T22), mintToIx(mPd, inbox, authority.publicKey, 70n, T22)]);
    const lenderBefore = await bal(lenderPd);
    await lender.syncLoan(refN, undefined, strangerKp);
    expect((await loan()).repaid).toBe(170n);
    expect((await lender.ledger(refN, mPd))!.held).toBe(0n);
    expect(await bal(lenderPd)).toBe(lenderBefore + 70n);
    await expectCode(lender.collect(refN, mPd, lenderPd), LOAN_ERROR.NothingOwed);
    // a held share the lender collects (to an account of its choice)
    await send(connection, authority, [freezeIx(lenderPd, mPd, authority.publicKey, false, T22), mintToIx(mPd, inbox, authority.publicKey, 30n, T22)]);
    await lender.syncLoan(refN, undefined, strangerKp);
    await send(connection, authority, [freezeIx(lenderPd, mPd, authority.publicKey, true, T22)]);
    await lender.collect(refN, mPd, lenderPd);
    expect(await bal(lenderPd)).toBe(lenderBefore + 100n);
    expect((await loan()).repaid).toBe(200n);
  });

  // ---- close_slot / sweep_closed: the lender takes the rent of a finished loan back ----

  /** Lamports of `keys` (0 for a missing account). */
  const lamportsOf = async (...keys: PublicKey[]) => (await connection.getMultipleAccountsInfo(keys, 'confirmed')).map((a) => a?.lamports ?? 0);
  const txFee = async (sig: string) => (await connection.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }))!.meta!.fee;

  let closedRef: bigint;
  let closedBorrower: SolanaWallet;

  it('close_slot: only the slot lender, only a settled loan whose inbox is empty; a wrong loan or cover account is refused', async () => {
    const { refN, t } = await (async () => {
      const r = await streamFor(mint);
      await send(connection, authority, [mintToIx(mint, lenderAta, authority.publicKey, 40n * U)]);
      await lender.fund(r.refN, r.stream, mint, 40n * U, payout);
      return r;
    })();
    closedRef = refN;
    closedBorrower = t;
    const loanAcc = { asset: mint, tokenProgram: SPL_TOKEN_PROGRAM_ID };
    const close = (who: Keypair, acc = loanAcc) => send(connection, who, [closeSlotIx(who.publicKey, refN, acc)]);
    // a funded loan that is not settled
    await expectCode(close(lenderKp), LOAN_ERROR.NotSettled);
    expect((await lender.reclaimable()).map((x) => x.loanRef)).not.toContain(refN);
    // anyone else, before and after settle (the signer is not the slot's lender)
    await expectCode(close(strangerKp), LOAN_ERROR.NotTheLender);
    await lender.settle(refN);
    await expectCode(close(strangerKp), LOAN_ERROR.NotTheLender);
    // the lender's account in the transaction, but another signer: the instruction needs the lender's signature
    const forged = closeSlotIx(lenderKp.publicKey, refN, loanAcc);
    forged.keys[1] = { ...forged.keys[1], isSigner: false };
    await expect(send(connection, strangerKp, [forged])).rejects.toThrow();
    expect((await lender.reclaimable()).map((x) => x.loanRef)).toContain(refN);
    // a routed share still waits in the inbox: never stranded, the close is refused until it is synced
    await send(connection, authority, [mintToIx(mint, slotInbox(refN, mint), authority.publicKey, 7n)]);
    await expectCode(close(lenderKp), LOAN_ERROR.InboxNotEmpty);
    // the loan's own asset, inbox and token program only
    await expectCode(close(lenderKp, { asset: otherMint, tokenProgram: SPL_TOKEN_PROGRAM_ID }), LOAN_ERROR.BadMint);
    await expectCode(close(lenderKp, { asset: mint, tokenProgram: TOKEN22_PROGRAM_ID }), LOAN_ERROR.BadTokenProgram);
    const wrongInbox = closeSlotIx(lenderKp.publicKey, refN, loanAcc);
    wrongInbox.keys[4] = { ...wrongInbox.keys[4], pubkey: await sideAccount(strangerKp, mint, slotPda(refN)) };
    await expectCode(send(connection, lenderKp, [wrongInbox]), LOAN_ERROR.BadInbox);
    const wrongLedger = closeSlotIx(lenderKp.publicKey, refN, loanAcc);
    wrongLedger.keys[2] = { ...wrongLedger.keys[2], pubkey: ledgerPda(refN, otherMint) };
    await expectCode(send(connection, lenderKp, [wrongLedger]), LOAN_ERROR.BadInbox);
    // the cover must be safety_pool's ["cover", loan_ref] of the safety_pool this build checks
    const wrongCover = closeSlotIx(lenderKp.publicKey, refN, loanAcc);
    wrongCover.keys[6] = { ...wrongCover.keys[6], pubkey: coverPda(LOCALNET_SAFETY_POOL_FAST_PROGRAM_ID, refN) };
    await expectCode(send(connection, lenderKp, [wrongCover]), LOAN_ERROR.BadCover);
    // a receipt address that is not ["closed", loan_ref]
    const wrongReceipt = closeSlotIx(lenderKp.publicKey, refN, loanAcc);
    wrongReceipt.keys[7] = { ...wrongReceipt.keys[7], pubkey: closedSlotPda(refN + 1n) };
    await expect(send(connection, lenderKp, [wrongReceipt])).rejects.toThrow();
    // nothing moved
    expect((await lender.loan(refN)).settled).toBe(true);
  });

  it('close_slot refunds the slot, inbox and ledger rent to the lender, leaves a receipt with the final figures, and the ref is never reused', async () => {
    const refN = closedRef;
    const slot = slotPda(refN);
    const inbox = slotInbox(refN, mint);
    const ledger = ledgerPda(refN, mint);
    const receipt = closedSlotPda(refN);
    // the SDK's close syncs the 7 waiting base units to the lender first; sync here so the close is one transaction
    await lender.syncLoan(refN);
    const repaid = (await lender.loan(refN)).repaid;
    expect(await bal(inbox)).toBe(0n);
    const [slotRent, inboxRent, ledgerRent] = await lamportsOf(slot, inbox, ledger);
    expect(slotRent * inboxRent * ledgerRent).toBeGreaterThan(0);
    // the receipt is a v2 one (the struct plus the borrower's payout account, for return_excess after the close)
    const receiptRent = await connection.getMinimumBalanceForRentExemption(CLOSED_SLOT_V2_SIZE);
    const before = await connection.getBalance(lenderKp.publicKey, 'confirmed');
    const tx = await lender.close(refN);
    const after = await connection.getBalance(lenderKp.publicKey, 'confirmed');
    const fee = await txFee(tx.signature);
    const refunded = slotRent + inboxRent + ledgerRent - receiptRent;
    expect(after - before + fee).toBe(refunded);
    expect(tx.refunded).toBe(BigInt(refunded));
    const [ev] = slotClosedEvents(tx.logs);
    expect(ev.loanRef).toBe(refN);
    expect(ev.lender.equals(lenderKp.publicKey)).toBe(true);
    expect(ev.funded).toBe(true);
    expect([ev.principal, ev.repaid]).toEqual([40n * U, repaid]);
    expect(ev.asset.equals(mint)).toBe(true);
    console.log(`close_slot (SPL Token loan): slot ${slotRent} + inbox ${inboxRent} + ledger ${ledgerRent} - receipt ${receiptRent} = ${refunded} lamports refunded; fee ${fee}; CU ${tx.computeUnits}`);
    // slot, inbox and ledger are gone; the receipt holds the final figures
    expect(await lamportsOf(slot, inbox, ledger)).toEqual([0, 0, 0]);
    const receiptInfo = (await connection.getAccountInfo(receipt, 'confirmed'))!;
    expect(receiptInfo.data.length).toBe(CLOSED_SLOT_V2_SIZE);
    expect(CLOSED_SLOT_V2_SIZE).toBe(CLOSED_SLOT_ACCOUNT_SIZE + 32);
    const r = decodeClosedSlot(receiptInfo.data);
    expect(r.payoutTo?.equals(payout)).toBe(true);
    expect(r.loanRef).toBe(refN);
    expect(r.lender.equals(lenderKp.publicKey)).toBe(true);
    expect(r.asset.equals(mint)).toBe(true);
    expect([r.principal, r.repaid]).toEqual([40n * U, repaid]);
    const st = await loanStatus(connection, refN);
    expect(st.state).toBe('closed');
    expect(st.state === 'closed' && st.receipt?.repaid).toBe(repaid);
    expect((await lender.closed()).map((c) => c.loanRef)).toContain(refN);
    expect((await lender.reclaimable()).map((x) => x.loanRef)).not.toContain(refN);
    await expect(lender.loan(refN)).rejects.toThrow(/closed/);
    // the ref is never reused: open_slot only creates the registry's next ref ...
    await expect(send(connection, lenderKp, [openSlotIx(lenderKp.publicKey, refN)])).rejects.toThrow();
    expect(await nextLoanRef()).toBeGreaterThan(refN);
    const fresh = await lender.openSlot();
    expect(fresh).toBeGreaterThan(refN);
    expect(await lamportsOf(slot)).toEqual([0]);
    // ... and every other instruction needs the slot account: closing again, settle, sync and collect all fail
    await expect(send(connection, lenderKp, [closeSlotIx(lenderKp.publicKey, refN, { asset: mint, tokenProgram: SPL_TOKEN_PROGRAM_ID })])).rejects.toThrow();
    await expect(lender.settle(refN)).rejects.toThrow();
    await expect(send(connection, strangerKp, [syncIx(strangerKp.publicKey, refN, mint, lenderKp.publicKey)])).rejects.toThrow();
    await expect(send(connection, lenderKp, [collectIx(lenderKp.publicKey, refN, mint, lenderAta)])).rejects.toThrow();
    expect(await lamportsOf(slot, ledger)).toEqual([0, 0]);
  });

  it('after the close, a share the pledge still routes is escrowed by the pool; only the lender sweeps it (sweep_closed)', async () => {
    const refN = closedRef;
    const t = closedBorrower;
    await t.sync();
    const live = t.agentAllowances(mint).filter((a) => a.allowance.remaining > 0n);
    expect(live).toHaveLength(1);
    // the borrower keeps spending: its pledged share still goes to the loan; with no inbox the pool escrows it
    await t.pay(live[0], 10n * U, vendorKp.publicKey);
    const escrow = slotEscrow(refN, mint);
    const share = shareOf(10n * U, BPS);
    expect(await bal(escrow)).toBe(share);
    // nobody but the lender can sweep (the receipt names it)
    const strangerAta = associatedTokenAddress(strangerKp.publicKey, mint);
    // anyone may re-create the inbox and push the escrowed share into it (pull_lender_share is permissionless) ...
    await pool.pullLenderShare(strangerKp, mint, slotPda(refN), refN);
    expect(await bal(escrow)).toBe(0n);
    expect(await bal(slotInbox(refN, mint))).toBe(share);
    await expectCode(send(connection, strangerKp, [sweepClosedIx(strangerKp.publicKey, refN, mint, strangerAta)]), LOAN_ERROR.NotTheLender);
    const lenderBefore = await bal(lenderAta);
    const repaidBefore = decodeClosedSlot((await connection.getAccountInfo(closedSlotPda(refN), 'confirmed'))!.data).repaid;
    expect(repaidBefore + share).toBeLessThanOrEqual(40n * U); // still owed: the capped sweep pays all of it
    const tx = await lender.sweepClosed(refN);
    expect(await bal(lenderAta)).toBe(lenderBefore + share);
    // the receipt records what the sweep paid (the cap is principal - receipt.repaid)
    expect(decodeClosedSlot((await connection.getAccountInfo(closedSlotPda(refN), 'confirmed'))!.data).repaid).toBe(repaidBefore + share);
    expect(await lamportsOf(slotInbox(refN, mint))).toEqual([0]); // the re-created inbox is closed again (rent to the lender)
    expect(await bal(escrow)).toBe(0n); // the pool's escrow account stays (the pool never closes it), empty
    expect(tx.logs.some((l) => l.startsWith('Program data: '))).toBe(true);
    await expect(lender.sweepClosed(refN)).rejects.toThrow(/nothing reached/);
    // the receipt stays (it is how a later share is reached)
    expect(await connection.getAccountInfo(closedSlotPda(refN), 'confirmed')).not.toBeNull();
  });

  it('another mint reaching a closed loan is the borrower\'s: it goes back to the payout owner\'s account; the withheld fee is harvested so the inbox closes', async () => {
    const refN = closedRef;
    const T22 = TOKEN22_PROGRAM_ID;
    // a Token-2022 mint with a 1% transfer fee (USDG carries TransferFeeConfig, today at 0)
    const feeMint = Keypair.generate();
    const space = 165 + 1 + 4 + 108;
    const initFee = new TransactionInstruction({
      programId: T22, keys: [{ pubkey: feeMint.publicKey, isSigner: false, isWritable: true }],
      data: Buffer.concat([Buffer.from([26, 0, 1]), authority.publicKey.toBuffer(), Buffer.from([1]), authority.publicKey.toBuffer(),
        Buffer.from(new Uint16Array([100]).buffer), Buffer.from(new BigUint64Array([1_000_000n]).buffer)]),
    });
    await send(connection, authority, [
      SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: feeMint.publicKey, lamports: await connection.getMinimumBalanceForRentExemption(space), space, programId: T22 }),
      initFee, initMint2Ix(feeMint.publicKey, 6, authority.publicKey, null, T22),
    ], { signers: [feeMint] });
    const m = feeMint.publicKey;
    const src = associatedTokenAddress(authority.publicKey, m, T22);
    const inbox = slotInbox(refN, m, T22);
    await send(connection, authority, [createAtaIx(authority.publicKey, authority.publicKey, m, T22), createAtaIx(authority.publicKey, slotPda(refN), m, T22), mintToIx(m, src, authority.publicKey, 10_000n, T22)]);
    await send(connection, authority, [transferCheckedIx(src, m, inbox, authority.publicKey, 10_000n, 6, T22)]);
    expect(await bal(inbox)).toBe(9_900n); // 100 withheld in the inbox
    // overpay cap: the lender is owed nothing in another mint, so sweep_closed alone pays nothing and cannot close a non-empty inbox
    await expectCode(send(connection, lenderKp, [sweepClosedIx(lenderKp.publicKey, refN, m, associatedTokenAddress(strangerKp.publicKey, m, T22), T22)]), LOAN_ERROR.NothingOwed);
    // the SDK's sweep leaves the borrower's excess alone unless asked (return_excess is opt-in) ...
    await expect(lender.sweepClosed(refN, m)).rejects.toThrow(/borrower's \(send it back with returnExcess\)/);
    // ... and with returnExcess it goes to the borrower (the payout account's owner, its ATA for this mint) and the inbox closes
    const tx = await lender.sweepClosed(refN, m, undefined, { returnExcess: true });
    expect(tx.signature).toBeTruthy();
    expect(excessAmounts(tx.logs, 'ExcessReturned')).toEqual([9_900n]);
    expect(await connection.getAccountInfo(inbox, 'confirmed')).toBeNull();
    expect(await bal(associatedTokenAddress(borrowerKp.publicKey, m, T22))).toBe(9_900n - 99n); // 1% fee withheld on the way
    expect(await bal(associatedTokenAddress(lenderKp.publicKey, m, T22))).toBe(0n);
  });

  it('a slot that never lent closes for its own rent, with no receipt; shares routed to it stay where they are', async () => {
    const refU = await lender.openSlot();
    expect((await lender.reclaimable()).map((x) => x.loanRef)).not.toContain(refU);
    expect((await lender.reclaimable({ includeUnfunded: true })).find((x) => x.loanRef === refU)?.reason).toBe('unfunded');
    // a share routed to the unfunded slot is not the lender's: it is left in the inbox, which is not closed
    await send(connection, authority, [createAtaIx(authority.publicKey, slotPda(refU), mint), mintToIx(mint, slotInbox(refU, mint), authority.publicKey, 5n)]);
    await expectCode(send(connection, strangerKp, [closeSlotIx(strangerKp.publicKey, refU)]), LOAN_ERROR.NotTheLender);
    const [slotRent] = await lamportsOf(slotPda(refU));
    const before = await connection.getBalance(lenderKp.publicKey, 'confirmed');
    const tx = await lender.close(refU);
    const after = await connection.getBalance(lenderKp.publicKey, 'confirmed');
    expect(after - before + (await txFee(tx.signature))).toBe(slotRent);
    expect(tx.refunded).toBe(BigInt(slotRent));
    expect(slotClosedEvents(tx.logs)[0].funded).toBe(false);
    console.log(`close_slot (never funded): ${slotRent} lamports refunded`);
    expect(await connection.getAccountInfo(closedSlotPda(refU), 'confirmed')).toBeNull();
    expect(await bal(slotInbox(refU, mint))).toBe(5n);
    expect(await loanStatus(connection, refU)).toEqual({ state: 'closed' });
    // there is no receipt, so nobody can sweep it
    await expect(lender.sweepClosed(refU)).rejects.toThrow(/no closed-loan receipt/);
    // a ref that was never handed out
    expect(await loanStatus(connection, (await nextLoanRef()) + 5n)).toEqual({ state: 'none' });
  });

  // ---- overpay cap (docs/LOAN-OVERPAY-CAP.md): the lender (plus the safety pool) never gets more than the principal ----

  const P20 = 20n * U;
  /** A 20-token loan against a 100-token budget pledged at 40% (min_remaining 50): the pledge could route 40. */
  async function overPledged(to = payout) {
    const r = await streamFor(mint, to, minRemainingFor(P20, BPS));
    expect(r.stream.args.minRemaining).toBe(50n * U);
    await send(connection, authority, [mintToIx(mint, lenderAta, authority.publicKey, P20)]);
    await lender.fund(r.refN, r.stream, mint, P20, to);
    return r;
  }
  const liveNote = async (t: SolanaWallet) => {
    await t.sync();
    const live = t.agentAllowances(mint).filter((a) => a.allowance.remaining > 0n);
    expect(live).toHaveLength(1);
    return live[0];
  };

  it('budget 100 at 40% for a 20 loan: the lender gets exactly 20, the borrower the rest; no claim once repaid', async () => {
    const { refN, t } = await overPledged();
    const inbox = slotInbox(refN, mint);
    await lender.sync();
    expect(lender.claimable(refN, await pool.now())).toBe(40n * U); // the pledged share of the whole budget: the bug
    // the old tools' claim of everything vested: the program refuses it (and the SDK no longer builds it)
    const over = await lender.prepareClaim(refN, 40n * U, { uncapped: true });
    expect(over.args.lenderAmount).toBe(40n * U);
    await expectCode(lender.submitClaim(over), LOAN_ERROR.ClaimTooLarge);
    await expect(lender.prepareClaim(refN, 40n * U)).rejects.toThrow(/more than loan .* still owes/);
    // by default the SDK claims exactly what is owed
    const lenderBefore = await bal(lenderAta);
    const c = await lender.claim(refN);
    expect(c.amount).toBe(P20);
    expect(await bal(lenderAta)).toBe(lenderBefore + P20);
    expect((await lender.loan(refN)).repaid).toBe(P20);
    recordCu('claim_capped', c.tx.computeUnits);
    // repaid: any further claim is refused, by the SDK and by the program
    await expect(lender.prepareClaim(refN)).rejects.toThrow(/repaid/);
    const more = await lender.prepareClaim(refN, 1n * U, { uncapped: true });
    await expectCode(lender.submitClaim(more), LOAN_ERROR.LoanRepaid);

    // the borrower keeps spending: the pledge still routes 40% to the loan, but none of it is the lender's
    await t.pay(await liveNote(t), 10n * U, vendorKp.publicKey);
    expect(await bal(inbox)).toBe(4n * U);
    const syncTx = await lender.syncLoan(refN, undefined, strangerKp);
    expect(excessAmounts(syncTx.logs, 'ExcessHeld')).toEqual([4n * U]);
    expect(await bal(lenderAta)).toBe(lenderBefore + P20);
    expect((await lender.loan(refN)).repaid).toBe(P20);
    expect((await lender.ledger(refN, mint))!.held).toBe(0n);
    expect((await loanExcess(connection, refN)).amount).toBe(4n * U);
    recordCu('sync_excess', syncTx.computeUnits);
    // ExcessHeld reports a level (everything waiting), not an increment: a second sync with nothing new reports the
    // same 4, and one after 4 more arrive reports 8 (an indexer must not sum it)
    expect(excessAmounts((await lender.syncLoan(refN, undefined, strangerKp)).logs, 'ExcessHeld')).toEqual([4n * U]);
    await send(connection, authority, [mintToIx(mint, inbox, authority.publicKey, 4n * U)]);
    expect(excessAmounts((await lender.syncLoan(refN, undefined, strangerKp)).logs, 'ExcessHeld')).toEqual([8n * U]);
    expect((await loanExcess(connection, refN)).amount).toBe(8n * U);
    // return_excess: only to the recorded payout account (or where its owner says)
    const strangerAta = associatedTokenAddress(strangerKp.publicKey, mint);
    await expectCode(send(connection, strangerKp, [returnExcessIx(refN, mint, payout, strangerAta)]), LOAN_ERROR.BadPayout);
    await expectCode(send(connection, strangerKp, [returnExcessIx(refN, mint, strangerAta, strangerAta)]), LOAN_ERROR.BadPayout);
    await expectCode(send(connection, strangerKp, [returnExcessIx(refN, mint, payout, strangerAta, SPL_TOKEN_PROGRAM_ID, LOAN, strangerKp.publicKey)]), LOAN_ERROR.BadPayout);
    // anyone sends it to payout_to
    const payoutBefore = await bal(payout);
    const ret = await returnExcess(connection, strangerKp, refN);
    expect(ret.amount).toBe(8n * U);
    expect(excessAmounts(ret.logs, 'ExcessReturned')).toEqual([8n * U]);
    recordCu('return_excess_open', ret.computeUnits);
    expect(await bal(payout)).toBe(payoutBefore + 8n * U);
    expect(await bal(inbox)).toBe(0n);
    await expectCode(send(connection, strangerKp, [returnExcessIx(refN, mint, payout, payout)]), LOAN_ERROR.NoExcess);
    // the payout account's owner may send its excess anywhere it likes
    await t.pay(await liveNote(t), 10n * U, vendorKp.publicKey);
    const side = await sideAccount(strangerKp, mint, borrowerKp.publicKey);
    await returnExcess(connection, strangerKp, refN, { owner: borrowerKp, destination: side });
    expect(await bal(side)).toBe(4n * U);
    expect(await bal(payout)).toBe(payoutBefore + 8n * U);
    expect(await bal(lenderAta)).toBe(lenderBefore + P20);

    // another mint routed to the slot never repays the loan: the lender gets nothing, the borrower's ATA for it is refunded
    const otherInbox = slotInbox(refN, otherMint);
    await send(connection, authority, [createAtaIx(authority.publicKey, slotPda(refN), otherMint), mintToIx(otherMint, otherInbox, authority.publicKey, 3n * U)]);
    await send(connection, authority, [createAtaIx(authority.publicKey, lenderKp.publicKey, otherMint)]);
    const s2 = await lender.syncLoan(refN, otherMint, strangerKp);
    expect(excessAmounts(s2.logs, 'ExcessHeld')).toEqual([3n * U]);
    expect(await bal(associatedTokenAddress(lenderKp.publicKey, otherMint))).toBe(0n);
    expect((await lender.ledger(refN, otherMint))!.received).toBe(0n);
    await returnExcess(connection, strangerKp, refN, { mint: otherMint });
    expect(await bal(associatedTokenAddress(borrowerKp.publicKey, otherMint))).toBe(3n * U);
    expect(await bal(otherInbox)).toBe(0n);
    // a claim in another mint is refused outright
    const wrongMint = claimIx(lenderKp.publicKey, refN, otherMint, new TransactionInstruction({ programId: POOL, keys: [], data: Buffer.alloc(8) }));
    await expectCode(send(connection, lenderKp, [wrongMint]), LOAN_ERROR.WrongAsset);
  });

  it('a sync that crosses the principal credits only the rest of it; a frozen lender account holds only that credit; close waits for collect', async () => {
    const { refN } = await overPledged();
    const inbox = slotInbox(refN, mint);
    await send(connection, authority, [mintToIx(mint, inbox, authority.publicKey, 15n * U)]);
    await lender.syncLoan(refN, undefined, strangerKp);
    expect((await lender.loan(refN)).repaid).toBe(15n * U);
    await send(connection, authority, [freezeIx(lenderAta, mint, authority.publicKey)]);
    try {
      // 10 arrive with repaid at 15: 5 are credited (held: the lender's account is frozen), 5 are the borrower's
      await send(connection, authority, [mintToIx(mint, inbox, authority.publicKey, 10n * U)]);
      const tx = await lender.syncLoan(refN, undefined, strangerKp);
      expect(excessAmounts(tx.logs, 'ExcessHeld')).toEqual([5n * U]);
      expect((await lender.loan(refN)).repaid).toBe(P20);
      expect((await lender.ledger(refN, mint))!.held).toBe(5n * U);
      expect(await bal(inbox)).toBe(10n * U);
      expect((await loanExcess(connection, refN)).amount).toBe(5n * U);
      // close_slot refuses while anything is held for the lender
      await lender.settle(refN);
      await expectCode(send(connection, lenderKp, [closeSlotIx(lenderKp.publicKey, refN, { asset: mint, tokenProgram: SPL_TOKEN_PROGRAM_ID })]), LOAN_ERROR.InboxNotEmpty);
      // the borrower's 5 leave; the lender's held 5 stay
      const payoutBefore = await bal(payout);
      await returnExcess(connection, strangerKp, refN);
      expect(await bal(payout)).toBe(payoutBefore + 5n * U);
      expect(await bal(inbox)).toBe(5n * U);
      // collect pays exactly the held credit
      const side = await sideAccount(strangerKp, mint, lenderKp.publicKey);
      await lender.collect(refN, mint, side);
      expect(await bal(side)).toBe(5n * U);
      expect(await bal(inbox)).toBe(0n);
    } finally {
      await send(connection, authority, [freezeIx(lenderAta, mint, authority.publicKey, true)]);
    }
    await lender.close(refN);
    expect(decodeClosedSlot((await connection.getAccountInfo(closedSlotPda(refN), 'confirmed'))!.data).repaid).toBe(P20);
  });

  it('a payout account that cannot receive (frozen, closed) keeps the excess waiting; the owner redirects it, or anyone retries once it can', async () => {
    const b2 = Keypair.generate();
    await send(connection, authority, [createAtaIx(authority.publicKey, b2.publicKey, mint)]);
    const payout2 = associatedTokenAddress(b2.publicKey, mint);
    const { refN } = await overPledged(payout2);
    const inbox = slotInbox(refN, mint);
    await send(connection, authority, [mintToIx(mint, inbox, authority.publicKey, 25n * U)]);
    await lender.syncLoan(refN, undefined, strangerKp);
    expect((await loanExcess(connection, refN)).amount).toBe(5n * U);
    // frozen payout account: the excess cannot be delivered and stays; the lender's sync is not blocked by it
    await send(connection, authority, [freezeIx(payout2, mint, authority.publicKey)]);
    await expectCode(returnExcess(connection, strangerKp, refN), LOAN_ERROR.PayoutCannotReceive);
    expect(await bal(inbox)).toBe(5n * U);
    await send(connection, authority, [mintToIx(mint, inbox, authority.publicKey, 1n * U)]);
    await lender.syncLoan(refN, undefined, strangerKp);
    expect(await bal(inbox)).toBe(6n * U);
    // its owner redirects it to another of its accounts
    const side2 = await sideAccount(strangerKp, mint, b2.publicKey);
    await returnExcess(connection, strangerKp, refN, { owner: b2, destination: side2 });
    expect(await bal(side2)).toBe(6n * U);
    await send(connection, authority, [freezeIx(payout2, mint, authority.publicKey, true)]);
    // the borrower closes its payout ATA: the excess waits (missing account) ...
    const left = await bal(payout2);
    const closeIx = new TransactionInstruction({
      programId: SPL_TOKEN_PROGRAM_ID, data: Buffer.from([9]),
      keys: [{ pubkey: payout2, isSigner: false, isWritable: true }, { pubkey: strangerKp.publicKey, isSigner: false, isWritable: true }, { pubkey: b2.publicKey, isSigner: true, isWritable: false }],
    });
    await send(connection, strangerKp, [transferCheckedIx(payout2, mint, side2, b2.publicKey, left, 6), closeIx], { signers: [b2] });
    expect(await connection.getAccountInfo(payout2, 'confirmed')).toBeNull();
    await send(connection, authority, [mintToIx(mint, inbox, authority.publicKey, 2n * U)]);
    await lender.syncLoan(refN, undefined, strangerKp);
    await expectCode(send(connection, strangerKp, [returnExcessIx(refN, mint, payout2, payout2)]), LOAN_ERROR.PayoutCannotReceive);
    expect(await bal(inbox)).toBe(2n * U);
    // the closed ATA's owner can still redirect it: the program recognises it by the ATA derivation (no account to read)
    const sideBefore = await bal(side2);
    await returnExcess(connection, strangerKp, refN, { owner: b2, destination: side2 });
    expect(await bal(side2)).toBe(sideBefore + 2n * U);
    // any other signer is not the owner: the destination must then be payout_to itself
    await send(connection, authority, [mintToIx(mint, inbox, authority.publicKey, 2n * U)]);
    await lender.syncLoan(refN, undefined, strangerKp);
    await expectCode(send(connection, strangerKp, [returnExcessIx(refN, mint, payout2, side2, SPL_TOKEN_PROGRAM_ID, LOAN, strangerKp.publicKey)]), LOAN_ERROR.BadPayout);
    expect(await bal(inbox)).toBe(2n * U);
    // ... until anyone re-creates the associated account, and the same call goes through
    await send(connection, strangerKp, [createAtaIx(strangerKp.publicKey, b2.publicKey, mint)]);
    await returnExcess(connection, strangerKp, refN);
    expect(await bal(payout2)).toBe(2n * U);
    expect(await bal(inbox)).toBe(0n);
  });

  it('settle and close_slot with excess waiting: the inbox stays open, return_excess works after the close, sweep_closed only closes the empty inbox', async () => {
    const { refN } = await overPledged();
    const inbox = slotInbox(refN, mint);
    const lenderBefore = await bal(lenderAta);
    await send(connection, authority, [mintToIx(mint, inbox, authority.publicKey, 25n * U)]);
    await lender.syncLoan(refN, undefined, strangerKp);
    expect(await bal(lenderAta)).toBe(lenderBefore + P20);
    await lender.settle(refN);
    // the raw close (the SDK's close would return the excess right after)
    const tx = await send(connection, lenderKp, [closeSlotIx(lenderKp.publicKey, refN, { asset: mint, tokenProgram: SPL_TOKEN_PROGRAM_ID })]);
    expect(slotClosedEvents(tx.logs)[0].repaid).toBe(P20);
    const info = (await connection.getAccountInfo(closedSlotPda(refN), 'confirmed'))!;
    expect(info.data.length).toBe(CLOSED_SLOT_V2_SIZE);
    const receipt = decodeClosedSlot(info.data);
    expect([receipt.principal, receipt.repaid]).toEqual([P20, P20]);
    expect(receipt.payoutTo?.equals(payout)).toBe(true);
    expect(await connection.getAccountInfo(slotPda(refN), 'confirmed')).toBeNull();
    expect(await bal(inbox)).toBe(5n * U); // left open for the borrower
    expect((await loanExcess(connection, refN)).amount).toBe(5n * U);
    // nothing is owed to the lender: sweep_closed pays nothing and cannot close the non-empty inbox
    await expectCode(send(connection, lenderKp, [sweepClosedIx(lenderKp.publicKey, refN, mint, lenderAta)]), LOAN_ERROR.NothingOwed);
    // anyone returns it after the close
    const payoutBefore = await bal(payout);
    const ret = await returnExcess(connection, strangerKp, refN);
    recordCu('return_excess_closed', ret.computeUnits);
    expect(await bal(payout)).toBe(payoutBefore + 5n * U);
    // sweep_closed with nothing owed closes the empty inbox; an old caller passing the receipt read-only works here
    const ro = sweepClosedIx(lenderKp.publicKey, refN, mint, lenderAta);
    ro.keys[0] = { ...ro.keys[0], isWritable: false };
    await send(connection, lenderKp, [ro]);
    expect(await connection.getAccountInfo(inbox, 'confirmed')).toBeNull();
    expect(await bal(lenderAta)).toBe(lenderBefore + P20);
  });

  it('closed below the principal, then routing after the close: the lender sweeps up to the principal, the borrower gets the rest', async () => {
    const { refN } = await overPledged();
    const inbox = slotInbox(refN, mint);
    await send(connection, authority, [mintToIx(mint, inbox, authority.publicKey, 12n * U)]);
    await lender.syncLoan(refN, undefined, strangerKp);
    await lender.settle(refN);
    await lender.close(refN);
    expect(decodeClosedSlot((await connection.getAccountInfo(closedSlotPda(refN), 'confirmed'))!.data).repaid).toBe(12n * U);
    // 15 more reach the (re-created) inbox after the close: 8 are still owed to the lender, 7 are the borrower's
    await send(connection, authority, [createAtaIx(authority.publicKey, slotPda(refN), mint), mintToIx(mint, inbox, authority.publicKey, 15n * U)]);
    // an old caller passing the receipt read-only fails cleanly while the lender is still owed (never overpays)
    const ro = sweepClosedIx(lenderKp.publicKey, refN, mint, lenderAta);
    ro.keys[0] = { ...ro.keys[0], isWritable: false };
    await expectCode(send(connection, lenderKp, [ro]), LOAN_ERROR.ReceiptNotWritable);
    const [lenderBefore, payoutBefore] = [await bal(lenderAta), await bal(payout)];
    const tx = await lender.sweepClosed(refN, undefined, undefined, { returnExcess: true });
    expect(await bal(lenderAta)).toBe(lenderBefore + 8n * U);
    expect(await bal(payout)).toBe(payoutBefore + 7n * U);
    expect(excessAmounts(tx.logs, 'ExcessReturned')).toEqual([7n * U]);
    expect(decodeClosedSlot((await connection.getAccountInfo(closedSlotPda(refN), 'confirmed'))!.data).repaid).toBe(P20);
    expect(await connection.getAccountInfo(inbox, 'confirmed')).toBeNull();
    // later arrivals: nothing is owed any more; a read-only receipt is fine, and everything goes back
    await send(connection, authority, [createAtaIx(authority.publicKey, slotPda(refN), mint), mintToIx(mint, inbox, authority.publicKey, 3n * U)]);
    await expectCode(send(connection, lenderKp, [ro]), LOAN_ERROR.NothingOwed);
    await expect(lender.sweepClosed(refN)).rejects.toThrow(/borrower's/);
    await lender.sweepClosed(refN, undefined, undefined, { returnExcess: true });
    expect(await bal(payout)).toBe(payoutBefore + 10n * U);
    expect(await bal(lenderAta)).toBe(lenderBefore + 8n * U);
    expect(await connection.getAccountInfo(inbox, 'confirmed')).toBeNull();
  });

  it('value already routed shrinks a claim: unsynced inbox value and the pool escrow (frozen inbox) both count; ClaimTooLarge, never LoanRepaid, before repayment', async () => {
    // (1) 15 routed to the inbox and not yet synced: only 5 more may be claimed
    {
      const { refN } = await overPledged();
      await lender.sync();
      await send(connection, authority, [mintToIx(mint, slotInbox(refN, mint), authority.publicKey, 15n * U)]);
      const over = await lender.prepareClaim(refN, 6n * U, { uncapped: true });
      await expectCode(lender.submitClaim(over), LOAN_ERROR.ClaimTooLarge);
      const lenderBefore = await bal(lenderAta);
      const c = await lender.claim(refN); // the SDK reads the inbox too: it asks for exactly 5
      expect(c.amount).toBe(5n * U);
      expect((await lender.loan(refN)).repaid).toBe(P20); // the claim's own sync credited the 15 and the 5
      expect(await bal(lenderAta)).toBe(lenderBefore + P20);
    }
    // (2) the slot's inbox is frozen: the pool escrows each claimed share, and the escrow counts against the next claim
    {
      const { refN } = await overPledged();
      const inbox = slotInbox(refN, mint);
      const escrow = slotEscrow(refN, mint);
      await lender.sync();
      await send(connection, authority, [freezeIx(inbox, mint, authority.publicKey)]);
      try {
        await lender.claim(refN, 8n * U);
        expect(await bal(escrow)).toBe(8n * U);
        expect((await lender.loan(refN)).repaid).toBe(0n);
        const over = await lender.prepareClaim(refN, 13n * U, { uncapped: true });
        await expectCode(lender.submitClaim(over), LOAN_ERROR.ClaimTooLarge);
        const c = await lender.claim(refN); // the SDK reads the escrow too: 20 - 8
        expect(c.amount).toBe(12n * U);
        expect(await bal(escrow)).toBe(P20);
        // nothing repaid on chain yet, but nothing more is owed: ClaimTooLarge (not LoanRepaid), and the SDK says why
        expect((await lender.loan(refN)).repaid).toBe(0n);
        const one = await lender.prepareClaim(refN, 1n * U, { uncapped: true });
        await expectCode(lender.submitClaim(one), LOAN_ERROR.ClaimTooLarge);
        await expect(lender.prepareClaim(refN)).rejects.toThrow(/already on its way/);
      } finally {
        await send(connection, authority, [freezeIx(inbox, mint, authority.publicKey, true)]);
      }
      const lenderBefore = await bal(lenderAta);
      await pool.pullLenderShare(strangerKp, mint, slotPda(refN), refN);
      await lender.syncLoan(refN, undefined, strangerKp);
      expect((await lender.loan(refN)).repaid).toBe(P20);
      expect(await bal(lenderAta)).toBe(lenderBefore + P20);
      expect(await bal(inbox)).toBe(0n);
    }
  });

  it('Token-2022 loan with excess waiting: a memo-required payout blocks only the refund (its owner redirects); a permanent delegate drain comes out of the excess, never the lender\'s held share', async () => {
    const T22 = TOKEN22_PROGRAM_ID;
    const delegate = Keypair.generate();
    await fundSol(delegate.publicKey);
    const m = await createPermanentDelegateMint(authority, delegate.publicKey);
    await send(connection, authority, [ownerKp, lenderKp, borrowerKp].map((k) => createAtaIx(authority.publicKey, k.publicKey, m, T22)));
    const lenderM = associatedTokenAddress(lenderKp.publicKey, m, T22);
    const payoutM = associatedTokenAddress(borrowerKp.publicKey, m, T22);
    await send(connection, authority, [
      mintToIx(m, associatedTokenAddress(ownerKp.publicKey, m, T22), authority.publicKey, 1_000n * U, T22),
      mintToIx(m, lenderM, authority.publicKey, 1_000n * U, T22),
    ]);
    await owner.deposit(m, 500n * U);
    const { refN, stream } = await streamFor(m, payoutM, minRemainingFor(P20, BPS));
    await lender.fund(refN, stream, m, P20, payoutM);
    const inbox = slotInbox(refN, m, T22);
    // the borrower turns on required memos for incoming transfers (Reallocate for MemoTransfer, then Enable)
    await send(connection, strangerKp, [
      new TransactionInstruction({
        programId: T22, data: Buffer.from([29, 8, 0]),
        keys: [{ pubkey: payoutM, isSigner: false, isWritable: true }, { pubkey: strangerKp.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: borrowerKp.publicKey, isSigner: true, isWritable: false }],
      }),
      new TransactionInstruction({
        programId: T22, data: Buffer.from([30, 0]),
        keys: [{ pubkey: payoutM, isSigner: false, isWritable: true }, { pubkey: borrowerKp.publicKey, isSigner: true, isWritable: false }],
      }),
    ], { signers: [borrowerKp] });
    // 25 arrive with the lender's account frozen: 20 credited and held, 5 the borrower's
    await send(connection, authority, [freezeIx(lenderM, m, authority.publicKey, false, T22), mintToIx(m, inbox, authority.publicKey, 25n * U, T22)]);
    try {
      // the lender's sync is not affected by the payout account's memo rule
      const s = await lender.syncLoan(refN, undefined, strangerKp);
      expect(excessAmounts(s.logs, 'ExcessHeld')).toEqual([5n * U]);
      expect((await lender.ledger(refN, m))!.held).toBe(P20);
      // the plain refund to a memo-required payout account fails; the excess waits, nothing moves
      await expect(returnExcess(connection, strangerKp, refN)).rejects.toThrow();
      expect(await bal(inbox)).toBe(25n * U);
      // the permanent delegate takes 3: it comes out of the borrower's excess (2 left), the lender's 20 stay held
      const sink = associatedTokenAddress(delegate.publicKey, m, T22);
      await send(connection, delegate, [createAtaIx(delegate.publicKey, delegate.publicKey, m, T22), transferCheckedIx(inbox, m, sink, delegate.publicKey, 3n * U, 6, T22)]);
      expect((await loanExcess(connection, refN)).amount).toBe(2n * U);
      // the payout account's owner redirects its 2 to an account without the memo rule
      const alt = Keypair.generate();
      const altAta = associatedTokenAddress(alt.publicKey, m, T22);
      await send(connection, authority, [createAtaIx(authority.publicKey, alt.publicKey, m, T22)]);
      await returnExcess(connection, strangerKp, refN, { owner: borrowerKp, destination: altAta });
      expect(await bal(altAta)).toBe(2n * U);
      expect(await bal(inbox)).toBe(P20);
      // drained below what is held: nothing is the borrower's, and a sync lowers held to the inbox (repaid stays)
      await send(connection, delegate, [transferCheckedIx(inbox, m, sink, delegate.publicKey, 4n * U, 6, T22)]);
      await expectCode(send(connection, strangerKp, [returnExcessIx(refN, m, payoutM, payoutM, T22)]), LOAN_ERROR.NoExcess);
      await lender.syncLoan(refN, undefined, strangerKp);
      expect((await lender.ledger(refN, m))!.held).toBe(16n * U);
      expect((await lender.loan(refN)).repaid).toBe(P20);
    } finally {
      await send(connection, authority, [freezeIx(lenderM, m, authority.publicKey, true, T22)]);
    }
    const lb = await bal(lenderM);
    await lender.collect(refN, m, lenderM);
    expect(await bal(lenderM)).toBe(lb + 16n * U);
    expect(await bal(inbox)).toBe(0n);
  });

  it('upgrade migration: loans made under the program before the cap keep working, and an over-repaid one releases its held overage once', async () => {
    const legacySo = join(SOLANA_DIR, 'target-so', 'stream_loan_legacy.so');
    const newSo = join(SOLANA_DIR, 'target-so', 'stream_loan.so');
    expect(existsSync(legacySo), 'build it: bash solana/scripts/loan-build-legacy.sh <pre-cap source dir>').toBe(true);
    await fundSol(LOCALNET_UPGRADE_AUTHORITY.publicKey, LOCALNET_UPGRADE_AUTHORITY.publicKey);
    // streams first (proofs need only the pool), then the loans under the pre-cap program
    const a = await streamFor(mint, payout, minRemainingFor(P20, BPS));
    const b2 = await streamFor(mint, payout, minRemainingFor(P20, BPS));
    const c = await streamFor(mint, payout, minRemainingFor(P20, BPS));
    const d = await streamFor(mint, payout, minRemainingFor(P20, BPS));
    const m2 = await createMint(authority); // a mint the lender has no account for
    upgradeLoanProgram(legacySo);
    try {
      await sleep(1500);
      for (const r of [a, b2, c, d]) {
        await send(connection, authority, [mintToIx(mint, lenderAta, authority.publicKey, P20)]);
        await lender.fund(r.refN, r.stream, mint, P20, payout);
      }
      // (a) and (d) open and over-repaid by 10, all 30 still held (the lender's account was frozen)
      await send(connection, authority, [
        freezeIx(lenderAta, mint, authority.publicKey), mintToIx(mint, slotInbox(a.refN, mint), authority.publicKey, 30n * U),
        mintToIx(mint, slotInbox(d.refN, mint), authority.publicKey, 30n * U),
      ]);
      try {
        await lender.syncLoan(a.refN, undefined, strangerKp);
        await lender.syncLoan(d.refN, undefined, strangerKp);
      } finally {
        await send(connection, authority, [freezeIx(lenderAta, mint, authority.publicKey, true)]);
      }
      for (const r of [a, d]) {
        expect((await lender.loan(r.refN)).repaid).toBe(30n * U);
        expect((await lender.ledger(r.refN, mint))!.held).toBe(30n * U);
      }
      // (b) closed below the principal (repaid 5): a 98-byte receipt. Before the close, 6 of another mint reached it and the
      // pre-cap sync held them for the lender (no account for that mint); close_slot leaves that mint's Ledger open
      await send(connection, authority, [createAtaIx(authority.publicKey, slotPda(b2.refN), m2), mintToIx(m2, slotInbox(b2.refN, m2), authority.publicKey, 6n * U)]);
      await send(connection, strangerKp, [syncIx(strangerKp.publicKey, b2.refN, m2, lenderKp.publicKey)]);
      expect((await lender.ledger(b2.refN, m2))!.held).toBe(6n * U);
      await send(connection, authority, [mintToIx(mint, slotInbox(b2.refN, mint), authority.publicKey, 5n * U)]);
      await lender.syncLoan(b2.refN, undefined, strangerKp);
      await lender.settle(b2.refN);
      await lender.close(b2.refN);
      // (c) closed over-repaid (repaid 25): a 98-byte receipt
      await send(connection, authority, [mintToIx(mint, slotInbox(c.refN, mint), authority.publicKey, 25n * U)]);
      await lender.syncLoan(c.refN, undefined, strangerKp);
      await lender.settle(c.refN);
      await lender.close(c.refN);
      for (const r of [b2, c]) expect((await connection.getAccountInfo(closedSlotPda(r.refN), 'confirmed'))!.data.length).toBe(CLOSED_SLOT_ACCOUNT_SIZE);
    } finally {
      upgradeLoanProgram(newSo);
      await sleep(1500);
    }
    // every account still decodes; old receipts record no payout account
    expect((await lender.loan(a.refN)).repaid).toBe(30n * U);
    const rb = decodeClosedSlot((await connection.getAccountInfo(closedSlotPda(b2.refN), 'confirmed'))!.data);
    const rc = decodeClosedSlot((await connection.getAccountInfo(closedSlotPda(c.refN), 'confirmed'))!.data);
    expect([rb.repaid, rb.payoutTo, rc.repaid, rc.payoutTo]).toEqual([5n * U, undefined, 25n * U, undefined]);
    expect((await lender.closed()).map((x) => x.loanRef)).toEqual(expect.arrayContaining([b2.refN, c.refN, closedRef]));

    // (a): the first sync releases the held overage once (repaid 30 -> 20, held 30 -> 20); the lender collects exactly 20
    const lenderBefore = await bal(lenderAta);
    const s1 = await lender.syncLoan(a.refN, undefined, strangerKp);
    expect(eventsNamed(s1.logs, 'LegacyExcessReleased').map((x) => x.readBigUInt64LE(8))).toEqual([10n * U]);
    expect(excessAmounts(s1.logs, 'ExcessHeld')).toEqual([10n * U]);
    expect((await lender.loan(a.refN)).repaid).toBe(P20);
    expect((await lender.ledger(a.refN, mint))!.held).toBe(P20);
    const s2 = await lender.syncLoan(a.refN, undefined, strangerKp);
    expect(eventsNamed(s2.logs, 'LegacyExcessReleased')).toHaveLength(0); // once only
    expect((await lender.loan(a.refN)).repaid).toBe(P20);
    await lender.collect(a.refN, mint);
    expect(await bal(lenderAta)).toBe(lenderBefore + P20);
    const more = await lender.prepareClaim(a.refN, 1n * U, { uncapped: true });
    await expectCode(lender.submitClaim(more), LOAN_ERROR.LoanRepaid);
    const payoutBefore = await bal(payout);
    await returnExcess(connection, strangerKp, a.refN);
    expect(await bal(payout)).toBe(payoutBefore + 10n * U);
    await lender.settle(a.refN);
    await lender.close(a.refN);
    expect(decodeClosedSlot((await connection.getAccountInfo(closedSlotPda(a.refN), 'confirmed'))!.data).repaid).toBe(P20);

    // (d): the lender collects BEFORE anyone syncs: it gets its 20, the overage stays held for the sync to release
    const ld = await bal(lenderAta);
    const col = await lender.collect(d.refN, mint);
    recordCu('collect_legacy', col.computeUnits);
    expect(await bal(lenderAta)).toBe(ld + P20);
    expect((await lender.ledger(d.refN, mint))!.held).toBe(10n * U);
    await expectCode(lender.collect(d.refN, mint), LOAN_ERROR.NothingOwed);
    const sd = await lender.syncLoan(d.refN, undefined, strangerKp);
    expect(eventsNamed(sd.logs, 'LegacyExcessReleased').map((x) => x.readBigUInt64LE(8))).toEqual([10n * U]);
    expect(excessAmounts(sd.logs, 'ExcessHeld')).toEqual([10n * U]);
    expect((await lender.loan(d.refN)).repaid).toBe(P20);
    expect((await lender.ledger(d.refN, mint))!.held).toBe(0n);
    const pd = await bal(payout);
    await returnExcess(connection, strangerKp, d.refN);
    expect(await bal(payout)).toBe(pd + 10n * U);
    expect(await bal(lenderAta)).toBe(ld + P20);

    // (b, other mint): the 6 held for the lender before the cap are still its own after the close. An old caller (no
    // Ledger account) gets nothing; the SDK passes the Ledger: the lender is paid the 6, the Ledger and the inbox close
    const lender2 = associatedTokenAddress(lenderKp.publicKey, m2);
    const old = sweepClosedIx(lenderKp.publicKey, b2.refN, m2, lender2);
    old.keys.pop();
    await expectCode(send(connection, lenderKp, [old]), LOAN_ERROR.NothingOwed);
    const sw = await lender.sweepClosed(b2.refN, m2);
    recordCu('sweep_closed_held', sw.computeUnits);
    expect(await bal(lender2)).toBe(6n * U);
    expect(await connection.getAccountInfo(ledgerPda(b2.refN, m2), 'confirmed')).toBeNull();
    expect(await connection.getAccountInfo(slotInbox(b2.refN, m2), 'confirmed')).toBeNull();
    expect(decodeClosedSlot((await connection.getAccountInfo(closedSlotPda(b2.refN), 'confirmed'))!.data).repaid).toBe(5n * U); // not counted as repayment

    // (b): a 98-byte receipt below the principal: the sweep is capped at what is still owed (15), and the receipt records it
    const inboxB = slotInbox(b2.refN, mint);
    await send(connection, authority, [createAtaIx(authority.publicKey, slotPda(b2.refN), mint), mintToIx(mint, inboxB, authority.publicKey, 30n * U)]);
    const roB = sweepClosedIx(lenderKp.publicKey, b2.refN, mint, lenderAta);
    roB.keys[0] = { ...roB.keys[0], isWritable: false };
    await expectCode(send(connection, lenderKp, [roB]), LOAN_ERROR.ReceiptNotWritable);
    const lb = await bal(lenderAta);
    await lender.sweepClosed(b2.refN);
    expect(await bal(lenderAta)).toBe(lb + 15n * U);
    const rb2 = (await connection.getAccountInfo(closedSlotPda(b2.refN), 'confirmed'))!;
    expect(rb2.data.length).toBe(CLOSED_SLOT_ACCOUNT_SIZE);
    expect(decodeClosedSlot(rb2.data).repaid).toBe(P20);
    // the rest has no recorded payout account (R1): it stays in the inbox, and nobody can move it
    expect(await bal(inboxB)).toBe(15n * U);
    await expectCode(send(connection, strangerKp, [returnExcessIx(b2.refN, mint, payout, payout)]), LOAN_ERROR.LegacyReceiptNoPayout);
    await expectCode(send(connection, lenderKp, [roB]), LOAN_ERROR.NothingOwed);
    await expect(lender.sweepClosed(b2.refN, undefined, undefined, { returnExcess: true })).rejects.toThrow(/older receipt records no payout/);

    // (c): a 98-byte receipt already over-repaid: post-upgrade arrivals are not the lender's (R1: they wait)
    const inboxC = slotInbox(c.refN, mint);
    await send(connection, authority, [createAtaIx(authority.publicKey, slotPda(c.refN), mint), mintToIx(mint, inboxC, authority.publicKey, 4n * U)]);
    const lc = await bal(lenderAta);
    await expectCode(send(connection, lenderKp, [sweepClosedIx(lenderKp.publicKey, c.refN, mint, lenderAta)]), LOAN_ERROR.NothingOwed);
    await expectCode(send(connection, strangerKp, [returnExcessIx(c.refN, mint, payout, payout)]), LOAN_ERROR.LegacyReceiptNoPayout);
    expect(await bal(lenderAta)).toBe(lc);
    expect(await bal(inboxC)).toBe(4n * U);
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
