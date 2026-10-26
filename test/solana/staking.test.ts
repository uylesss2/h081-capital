// Phase 2 staking on a private solana-test-validator (WSL, rpc 127.0.0.1:9199): capacity_stake and
// safety_pool for a Token-2022 mint with 6 decimals (like H081 on the launchpad), plus Token-2022 with a
// transfer fee and classic SPL Token. safety_pool reads stream_loan Slot/Ledger/inbox accounts that the
// validator loads as fixtures owned by the stream_loan program id (test/solana/staking-fixtures.ts);
// when stream_loan.so is loaded too, its own `shortfall` view is compared with safety_pool's.
// The *_fast builds (cooldowns 3 s, grace 2 s, separate ids) exercise the time-gated paths; the
// production builds show the real 7/14-day cooldowns and 7-day grace refuse early calls.
// Run with `npm run test:staking`.
import { beforeAll, describe, expect, it } from 'vitest';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { customErrorCode, send } from '../../src/solana/buffer.js';
import { concatBytes, u64le } from '../../src/solana/field.js';
import { sha256 } from '@noble/hashes/sha2';
import {
  CAPACITY_ERROR, CLASSIC_TOKEN_PROGRAM_ID, LOCALNET_CAPACITY_STAKE_FAST_PROGRAM_ID, LOCALNET_CAPACITY_STAKE_PROGRAM_ID,
  LOCALNET_SAFETY_POOL_FAST_PROGRAM_ID, LOCALNET_SAFETY_POOL_PROGRAM_ID, SAFETY_ERROR, SAFETY_STREAM_LOAN_PROGRAM_ID, SHIELD_PER_UNIT,
  TOKEN22_PROGRAM_ID, ataAddress, capacityConfigPda, capacityInitConfigIx, capacityOf, capacityVaultPda, closePositionIx, closeStakeIx,
  coverPda, createAtaIdempotentIx, createMintIxs, sharesFor, transferCheckedIx, decodeCapacityConfig, decodeCover, decodePosition, decodeSafetyConfig, decodeStake,
  decodeStreamSlot, insureIx, loanAccounts, mintToIx, positionPda, readCapacity, readSafetyPosition, redeemable, requestUnbondIx,
  requestUnstakeIx, safetyConfigPda, safetyDepositIx, safetyInitPoolIx, safetyVaultPda, safetyWithdrawIx, simulateReturn, slashIx,
  stakeIx, stakePda, streamSlotPda, tokenBalance, unstakeIx, viewCapacity, viewShortfall, padTo, type CreateMintOptions,
} from '../../src/solana/token.js';
import { REF, readStakingMeta, type StakingMeta } from './staking-fixtures.js';

const RPC = process.env.STAKING_RPC ?? 'http://127.0.0.1:9199';
const CS = LOCALNET_CAPACITY_STAKE_PROGRAM_ID;
const CSF = LOCALNET_CAPACITY_STAKE_FAST_PROGRAM_ID;
const SP = LOCALNET_SAFETY_POOL_PROGRAM_ID;
const SPF = LOCALNET_SAFETY_POOL_FAST_PROGRAM_ID;
const T22 = TOKEN22_PROGRAM_ID;
const TOK = 1_000_000n; // one whole token at 6 decimals
const FAST_GRACE = 2;

const connection = new Connection(RPC, 'confirmed');
const payer = Keypair.generate();
const s1 = Keypair.generate();
const s2 = Keypair.generate();
const s3 = Keypair.generate();
const stranger = Keypair.generate();
let lender: Keypair;
let meta: StakingMeta;
let asset: PublicKey;
let streamLoanLoaded = false;
// Runs only under vitest.staking.config.ts (STAKING_REQUIRED=1, fresh fixtures); skipped by other suites
// whose include globs reach test/solana, even if a staking validator happens to be up.
let reachable = !!process.env.STAKING_REQUIRED;
try {
  if (reachable) await connection.getVersion();
} catch {
  reachable = false;
}
if (!reachable && process.env.STAKING_REQUIRED) throw new Error(`no staking validator at ${RPC}; run: node scripts/solana-staking-localnet.mjs restart`);

// mints: H = Token-2022, 6 decimals (H081-like); E = second Token-2022 mint for the empty-pool case;
// F = Token-2022 with a 1% transfer fee; C = classic SPL Token
const H = Keypair.generate();
const E = Keypair.generate();
const F = Keypair.generate();
const C = Keypair.generate();

async function airdrop(to: PublicKey, sol = 10) {
  const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature: sig, ...(await connection.getLatestBlockhash()) }, 'confirmed');
}

async function makeMint(mint: Keypair, opts: CreateMintOptions = {}) {
  await send(connection, payer, await createMintIxs(connection, payer.publicKey, mint.publicKey, payer.publicKey, opts), { signers: [mint] });
}

/** Creates `owner`'s ATA for `mint` and mints `amount` into it. */
async function fund(owner: PublicKey, mint: PublicKey, amount: bigint, prog = T22): Promise<PublicKey> {
  const ata = ataAddress(owner, mint, prog);
  await send(connection, payer, [createAtaIdempotentIx(payer.publicKey, owner, mint, prog), ...(amount > 0n ? [mintToIx(mint, ata, payer.publicKey, amount, prog)] : [])]);
  return ata;
}

async function expectCode(p: Promise<unknown>, code: number) {
  let caught: unknown;
  try { await p; } catch (e) { caught = e; }
  expect(caught, 'transaction should fail').toBeDefined();
  expect(customErrorCode(caught)).toBe(code);
}
async function expectFail(p: Promise<unknown>) {
  let caught: unknown;
  try { await p; } catch (e) { caught = e; }
  expect(caught, 'transaction should fail').toBeDefined();
}

const tx = (signer: Keypair, ...ixs: TransactionInstruction[]) => send(connection, signer, ixs);
async function account(addr: PublicKey) {
  const info = await connection.getAccountInfo(addr, 'confirmed');
  if (!info) throw new Error(`missing account ${addr.toBase58()}`);
  return info.data;
}
async function chainNow(): Promise<number> {
  const slot = await connection.getSlot('confirmed');
  return (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
}
async function waitUntilChain(t: number) {
  for (;;) {
    if ((await chainNow()) >= t) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const loanOf = (loanRef: bigint) => loanAccounts(loanRef, asset, CLASSIC_TOKEN_PROGRAM_ID);

beforeAll(async () => {
  if (!reachable) return;
  meta = readStakingMeta();
  lender = Keypair.fromSecretKey(Uint8Array.from(meta.lenderSecret));
  asset = new PublicKey(meta.asset);
  for (const id of [CS, CSF, SP, SPF]) {
    const acc = await connection.getAccountInfo(id);
    if (!acc?.executable) throw new Error(`program ${id.toBase58()} is not loaded; run npm run test:staking (it builds nothing: node scripts/solana-staking-localnet.mjs build first)`);
  }
  streamLoanLoaded = !!(await connection.getAccountInfo(SAFETY_STREAM_LOAN_PROGRAM_ID))?.executable;
  await airdrop(payer.publicKey, 100);
  for (const k of [s1, s2, s3, stranger, lender]) await airdrop(k.publicKey);
  await makeMint(H);
  await makeMint(E);
  await makeMint(F, { transferFee: { bps: 100, max: 1_000_000n * TOK } });
  await makeMint(C, { tokenProgram: CLASSIC_TOKEN_PROGRAM_ID });
  for (const k of [s1, s2, s3, lender]) await fund(k.publicKey, H.publicKey, 10_000n * TOK);
  await fund(stranger.publicKey, H.publicKey, 0n);
  const now = await chainNow();
  if (now > meta.liveExpiry - 30) throw new Error(`fixtures are stale (chain ${now}, live expiry ${meta.liveExpiry}); restart with npm run test:staking`);
});

describe.skipIf(!reachable)('safety_pool: setup and insure (must run before the live loans expire)', () => {
  it('fixtures decode as stream_loan Slot accounts', async () => {
    const s = decodeStreamSlot(await account(streamSlotPda(REF.live)));
    expect(s.loanRef).toBe(REF.live);
    expect(s.lender.equals(lender.publicKey)).toBe(true);
    expect(s.expiry).toBe(BigInt(meta.liveExpiry));
  });

  it('init_pool is permissionless, per mint, exactly once', async () => {
    for (const prog of [SP, SPF]) {
      await tx(stranger, safetyInitPoolIx(prog, stranger.publicKey, H.publicKey));
      const c = decodeSafetyConfig(await account(safetyConfigPda(prog, H.publicKey)));
      expect(c.mint.equals(H.publicKey)).toBe(true);
      expect(c.vault.equals(safetyVaultPda(prog, H.publicKey))).toBe(true);
      expect(c.tokenProgram.equals(T22)).toBe(true);
      expect(c.decimals).toBe(6);
      expect(c.totalShares).toBe(0n);
      expect(c.generation).toBe(0n);
      await expectFail(tx(payer, safetyInitPoolIx(prog, payer.publicKey, H.publicKey)));
    }
    await tx(payer, safetyInitPoolIx(SPF, payer.publicKey, E.publicKey));
  });

  it('deposit mints shares at (assets + 1) / (shares + 1,000); a donation straight to the vault does not move the price', async () => {
    await tx(s1, safetyDepositIx(SPF, s1.publicKey, H.publicKey, ataAddress(s1.publicKey, H.publicKey), 1_000n * TOK));
    const first = sharesFor(1_000n * TOK, 0n, 0n);
    expect(first).toBe(1_000n * TOK * 1_000n);
    // tokens sent to the vault outside deposit/insure are not pool assets
    await tx(s3, transferCheckedIx(ataAddress(s3.publicKey, H.publicKey), H.publicKey, safetyVaultPda(SPF, H.publicKey), s3.publicKey, 777n * TOK, 6));
    await tx(s2, safetyDepositIx(SPF, s2.publicKey, H.publicKey, ataAddress(s2.publicKey, H.publicKey), 500n * TOK));
    const p1 = await readSafetyPosition(connection, SPF, H.publicKey, s1.publicKey);
    const p2 = await readSafetyPosition(connection, SPF, H.publicKey, s2.publicKey);
    expect(p1.shares).toBe(first);
    expect(p2.shares).toBe(sharesFor(500n * TOK, 1_000n * TOK, first));
    expect(p1.config.totalShares).toBe(p1.shares + p2.shares);
    expect(p1.poolBalance).toBe(1_500n * TOK); // accounted assets
    expect(p1.config.assets).toBe(1_500n * TOK);
    expect(await tokenBalance(connection, safetyVaultPda(SPF, H.publicKey))).toBe(2_277n * TOK); // the donation sits in the vault, unaccounted
    expect(500n * TOK - p2.value).toBeLessThanOrEqual(1n); // s2 got what it paid for
    await expectCode(tx(s1, safetyDepositIx(SPF, s1.publicKey, H.publicKey, ataAddress(s1.publicKey, H.publicKey), 0n)), SAFETY_ERROR.Amount);
    // production program too (used later to show the 7-day grace and 14-day cooldown)
    await tx(s1, safetyDepositIx(SP, s1.publicKey, H.publicKey, ataAddress(s1.publicKey, H.publicKey), 100n * TOK));
  });

  it('insure: only the slot lender, only funded, unsettled, dated, unexpired loans; valid stream_loan accounts only', async () => {
    const from = ataAddress(lender.publicKey, H.publicKey);
    const ins = (ref: bigint, who = lender, premium = 0n) => tx(who, insureIx(SPF, who.publicKey, H.publicKey, ataAddress(who.publicKey, H.publicKey), ref, premium));
    await fund(stranger.publicKey, H.publicKey, 10n * TOK);
    await expectCode(ins(REF.live, stranger), SAFETY_ERROR.NotTheLender);
    await expectCode(ins(REF.unfunded), SAFETY_ERROR.NoLoan);
    await expectCode(ins(REF.noExpiry), SAFETY_ERROR.NoDueDate);
    await expectCode(ins(REF.expired), SAFETY_ERROR.Expired);
    await expectCode(ins(REF.settled), SAFETY_ERROR.Settled);
    await expectCode(ins(REF.wrongOwner), SAFETY_ERROR.BadLoanAccount);
    // another loan's slot passed for this loan ref
    const forged = insureIx(SPF, lender.publicKey, H.publicKey, from, REF.unfunded, 0n);
    forged.keys[2].pubkey = streamSlotPda(REF.live);
    await expectCode(tx(lender, forged), SAFETY_ERROR.BadLoanAccount);
    expect(await connection.getAccountInfo(coverPda(SPF, REF.live))).toBeNull();
  });

  it('insure binds the cover and the premium raises the share price', async () => {
    const before = await tokenBalance(connection, safetyVaultPda(SPF, H.publicKey));
    await tx(lender, insureIx(SPF, lender.publicKey, H.publicKey, ataAddress(lender.publicKey, H.publicKey), REF.live, 150n * TOK));
    const c = decodeCover(await account(coverPda(SPF, REF.live)));
    expect(c.loanRef).toBe(REF.live);
    expect(c.lender.equals(lender.publicKey)).toBe(true);
    expect(c.mint.equals(H.publicKey)).toBe(true);
    expect(c.premium).toBe(150n * TOK);
    expect(c.paid).toBe(false);
    expect(c.boundAt).toBeGreaterThan(0n);
    expect(await tokenBalance(connection, safetyVaultPda(SPF, H.publicKey))).toBe(before + 150n * TOK);
    const p1 = await readSafetyPosition(connection, SPF, H.publicKey, s1.publicKey);
    expect(p1.config.assets).toBe(1_650n * TOK);
    expect(p1.value).toBe(redeemable(p1.shares, p1.config.assets, p1.config.totalShares));
    expect((1_000n * TOK * 1_650n) / 1_500n - p1.value).toBeLessThanOrEqual(2n); // about 1,100 tokens
    // one cover per loan: again in the same pool, or in another mint's pool of the same program
    await expectFail(tx(lender, insureIx(SPF, lender.publicKey, H.publicKey, ataAddress(lender.publicKey, H.publicKey), REF.live, 0n)));
    await fund(lender.publicKey, E.publicKey, 0n);
    await expectFail(tx(lender, insureIx(SPF, lender.publicKey, E.publicKey, ataAddress(lender.publicKey, E.publicKey), REF.live, 0n)));
  });

  it('insures the remaining live loans (pending inbox, huge, empty pool) and the production cover', async () => {
    const from = ataAddress(lender.publicKey, H.publicKey);
    await tx(lender, insureIx(SPF, lender.publicKey, H.publicKey, from, REF.pending, 0n));
    await tx(lender, insureIx(SPF, lender.publicKey, H.publicKey, from, REF.huge, 0n));
    await tx(lender, insureIx(SPF, lender.publicKey, H.publicKey, from, REF.escrowed, 0n));
    await tx(lender, insureIx(SPF, lender.publicKey, E.publicKey, ataAddress(lender.publicKey, E.publicKey), REF.emptyPool, 0n));
    await tx(lender, insureIx(SP, lender.publicKey, H.publicKey, from, REF.live, 0n));
    expect(decodeCover(await account(coverPda(SP, REF.live))).premium).toBe(0n);
  });

  it('a later deposit gets shares at the raised price', async () => {
    const c0 = decodeSafetyConfig(await account(safetyConfigPda(SPF, H.publicKey)));
    await tx(s3, safetyDepositIx(SPF, s3.publicKey, H.publicKey, ataAddress(s3.publicKey, H.publicKey), 330n * TOK));
    const p3 = await readSafetyPosition(connection, SPF, H.publicKey, s3.publicKey);
    expect(p3.shares).toBe(sharesFor(330n * TOK, c0.assets, c0.totalShares));
    expect(330n * TOK - p3.value).toBeLessThanOrEqual(2n);
  });

  it('slash before expiry + grace finds no shortfall', async () => {
    expect(await viewShortfall(connection, payer, SPF, REF.live, loanOf(REF.live))).toBe(0n);
    await expectCode(tx(stranger, slashIx(SPF, H.publicKey, REF.live, loanOf(REF.live), ataAddress(lender.publicKey, H.publicKey))), SAFETY_ERROR.NoShortfall);
  });

  it('unbonding: bounded by shares held; withdraw waits for the cooldown', async () => {
    const p2 = await readSafetyPosition(connection, SPF, H.publicKey, s2.publicKey);
    await expectCode(tx(s2, requestUnbondIx(SPF, s2.publicKey, H.publicKey, p2.shares + 1n)), SAFETY_ERROR.MoreThanHeld);
    await expectCode(tx(s2, requestUnbondIx(SPF, s2.publicKey, H.publicKey, 0n)), SAFETY_ERROR.Shares);
    await tx(s2, requestUnbondIx(SPF, s2.publicKey, H.publicKey, p2.shares));
    await expectCode(tx(s2, safetyWithdrawIx(SPF, s2.publicKey, H.publicKey, ataAddress(s2.publicKey, H.publicKey))), SAFETY_ERROR.Cooldown);
    const after = await readSafetyPosition(connection, SPF, H.publicKey, s2.publicKey);
    expect(after.shares).toBe(0n);
    expect(after.unbonding).toBe(p2.shares);
    // nobody else can move s2's position
    const forged = requestUnbondIx(SPF, stranger.publicKey, H.publicKey, 1n);
    forged.keys[1].pubkey = positionPda(SPF, H.publicKey, s2.publicKey);
    await expectFail(tx(stranger, forged));
    // production: the 14-day cooldown
    await tx(s1, requestUnbondIx(SP, s1.publicKey, H.publicKey, 10n * TOK));
    const pp = decodePosition(await account(positionPda(SP, H.publicKey, s1.publicKey)));
    expect(pp.readyAt - BigInt(await chainNow())).toBeGreaterThan(14n * 86400n - 120n);
    await expectCode(tx(s1, safetyWithdrawIx(SP, s1.publicKey, H.publicKey, ataAddress(s1.publicKey, H.publicKey))), SAFETY_ERROR.Cooldown);
  });
});

describe.skipIf(!reachable)('capacity_stake', () => {
  it('init_config is permissionless, per mint, exactly once, units scaled by decimals', async () => {
    for (const prog of [CS, CSF]) {
      await tx(stranger, capacityInitConfigIx(prog, stranger.publicKey, H.publicKey));
      const c = decodeCapacityConfig(await account(capacityConfigPda(prog, H.publicKey)));
      expect(c.mint.equals(H.publicKey)).toBe(true);
      expect(c.vault.equals(capacityVaultPda(prog, H.publicKey))).toBe(true);
      expect(c.tokenProgram.equals(T22)).toBe(true);
      expect(c.decimals).toBe(6);
      expect(c.deskUnit).toBe(100n * TOK);
      expect(c.shieldUnit).toBe(100n * TOK);
      await expectFail(tx(payer, capacityInitConfigIx(prog, payer.publicKey, H.publicKey)));
    }
    // a mint must be passed with its own token program
    await expectFail(tx(payer, capacityInitConfigIx(CS, payer.publicKey, H.publicKey, CLASSIC_TOKEN_PROGRAM_ID)));
  });

  it('stake counts as capacity at once; desks and shield cap follow the units', async () => {
    const from = ataAddress(s1.publicKey, H.publicKey);
    await expectCode(tx(s1, stakeIx(CS, s1.publicKey, H.publicKey, from, 0n)), CAPACITY_ERROR.Amount);
    await tx(s1, stakeIx(CS, s1.publicKey, H.publicKey, from, 250n * TOK));
    let cap = await readCapacity(connection, CS, H.publicKey, s1.publicKey);
    expect(cap.stake.staked).toBe(250n * TOK);
    expect(cap.desks).toBe(2n);
    expect(cap.shieldCap).toBe(2n * SHIELD_PER_UNIT);
    expect(cap.shieldCap).toBe(20_000_000_000n); // 20,000 USDG per 30 days
    expect(await viewCapacity(connection, payer, CS, H.publicKey, s1.publicKey)).toEqual({ desks: 2n, shieldCap: 2n * SHIELD_PER_UNIT });
    await tx(s1, stakeIx(CS, s1.publicKey, H.publicKey, from, 50n * TOK));
    cap = await readCapacity(connection, CS, H.publicKey, s1.publicKey);
    expect(cap.desks).toBe(3n);
    expect(cap.config.totalStaked).toBe(300n * TOK);
    expect(await tokenBalance(connection, capacityVaultPda(CS, H.publicKey))).toBe(300n * TOK);
    // no stake yet: zero capacity
    expect((await readCapacity(connection, CS, H.publicKey, s2.publicKey)).desks).toBe(0n);
    // the view against the production numbers of a big stake
    expect(capacityOf(cap.config, 1_000_000n * TOK)).toEqual({ desks: 10_000n, shieldCap: 10_000n * SHIELD_PER_UNIT });
  });

  it('request_unstake leaves capacity at once and starts the 7-day cooldown', async () => {
    await expectCode(tx(s1, requestUnstakeIx(CS, s1.publicKey, H.publicKey, 301n * TOK)), CAPACITY_ERROR.MoreThanStaked);
    await expectCode(tx(s1, requestUnstakeIx(CS, s1.publicKey, H.publicKey, 0n)), CAPACITY_ERROR.Amount);
    await tx(s1, requestUnstakeIx(CS, s1.publicKey, H.publicKey, 150n * TOK));
    const st = decodeStake(await account(stakePda(CS, H.publicKey, s1.publicKey)));
    expect(st.staked).toBe(150n * TOK);
    expect(st.pending).toBe(150n * TOK);
    expect(st.readyAt - BigInt(await chainNow())).toBeGreaterThan(7n * 86400n - 120n);
    expect((await readCapacity(connection, CS, H.publicKey, s1.publicKey)).desks).toBe(1n);
    await expectCode(tx(s1, unstakeIx(CS, s1.publicKey, H.publicKey, ataAddress(s1.publicKey, H.publicKey))), CAPACITY_ERROR.Cooldown);
    // nothing pending for someone who never asked
    await tx(s2, stakeIx(CS, s2.publicKey, H.publicKey, ataAddress(s2.publicKey, H.publicKey), 100n * TOK));
    await expectCode(tx(s2, unstakeIx(CS, s2.publicKey, H.publicKey, ataAddress(s2.publicKey, H.publicKey))), CAPACITY_ERROR.NothingPending);
    // nobody else can move s1's stake
    const forged = requestUnstakeIx(CS, stranger.publicKey, H.publicKey, 1n);
    forged.keys[1].pubkey = stakePda(CS, H.publicKey, s1.publicKey);
    await expectFail(tx(stranger, forged));
    const forged2 = unstakeIx(CS, stranger.publicKey, H.publicKey, ataAddress(stranger.publicKey, H.publicKey));
    forged2.keys[1].pubkey = stakePda(CS, H.publicKey, s1.publicKey);
    await expectFail(tx(stranger, forged2));
  });

  it('fast build: a new request adds to pending and restarts the cooldown; unstake after it returns the tokens', async () => {
    const ata = ataAddress(s3.publicKey, H.publicKey);
    await tx(s3, stakeIx(CSF, s3.publicKey, H.publicKey, ata, 400n * TOK));
    await tx(s3, requestUnstakeIx(CSF, s3.publicKey, H.publicKey, 100n * TOK));
    const first = decodeStake(await account(stakePda(CSF, H.publicKey, s3.publicKey)));
    await new Promise((r) => setTimeout(r, 1500));
    await tx(s3, requestUnstakeIx(CSF, s3.publicKey, H.publicKey, 300n * TOK));
    const second = decodeStake(await account(stakePda(CSF, H.publicKey, s3.publicKey)));
    expect(second.pending).toBe(400n * TOK);
    expect(second.staked).toBe(0n);
    expect(second.readyAt).toBeGreaterThanOrEqual(first.readyAt);
    await expectCode(tx(s3, closeStakeIx(CSF, s3.publicKey, H.publicKey)), CAPACITY_ERROR.NotEmpty);
    await waitUntilChain(Number(second.readyAt) + 1);
    const before = await tokenBalance(connection, ata);
    await tx(s3, unstakeIx(CSF, s3.publicKey, H.publicKey, ata));
    expect(await tokenBalance(connection, ata)).toBe(before + 400n * TOK);
    const cfg = decodeCapacityConfig(await account(capacityConfigPda(CSF, H.publicKey)));
    expect(cfg.totalPending).toBe(0n);
    expect(cfg.totalStaked).toBe(0n);
    await expectCode(tx(s3, unstakeIx(CSF, s3.publicKey, H.publicKey, ata)), CAPACITY_ERROR.NothingPending);
    // empty: close returns the rent
    await tx(s3, closeStakeIx(CSF, s3.publicKey, H.publicKey));
    expect(await connection.getAccountInfo(stakePda(CSF, H.publicKey, s3.publicKey))).toBeNull();
  });

  it('Token-2022 transfer fee: only what the vault receives counts', async () => {
    const ata = await fund(s1.publicKey, F.publicKey, 10_000n * TOK);
    await tx(payer, capacityInitConfigIx(CS, payer.publicKey, F.publicKey));
    await tx(s1, stakeIx(CS, s1.publicKey, F.publicKey, ata, 1_000n * TOK));
    const st = decodeStake(await account(stakePda(CS, F.publicKey, s1.publicKey)));
    expect(st.staked).toBe(990n * TOK); // 1% fee withheld
    expect(await tokenBalance(connection, capacityVaultPda(CS, F.publicKey))).toBe(990n * TOK);
  });

  it('classic SPL Token mints work through the same interface', async () => {
    const ata = await fund(s2.publicKey, C.publicKey, 1_000n * TOK, CLASSIC_TOKEN_PROGRAM_ID);
    await tx(payer, capacityInitConfigIx(CSF, payer.publicKey, C.publicKey, CLASSIC_TOKEN_PROGRAM_ID));
    await tx(s2, stakeIx(CSF, s2.publicKey, C.publicKey, ata, 200n * TOK, CLASSIC_TOKEN_PROGRAM_ID));
    expect((await readCapacity(connection, CSF, C.publicKey, s2.publicKey)).desks).toBe(2n);
    await tx(s2, requestUnstakeIx(CSF, s2.publicKey, C.publicKey, 200n * TOK));
    const st = decodeStake(await account(stakePda(CSF, C.publicKey, s2.publicKey)));
    await waitUntilChain(Number(st.readyAt) + 1);
    await tx(s2, unstakeIx(CSF, s2.publicKey, C.publicKey, ata, CLASSIC_TOKEN_PROGRAM_ID));
    expect(await tokenBalance(connection, ata)).toBe(1_000n * TOK);
  });
});

describe.skipIf(!reachable)('safety_pool: shortfall and slash (after the live loans expire + grace)', () => {
  it('waits for expiry + grace on the chain clock', async () => {
    await waitUntilChain(meta.liveExpiry + FAST_GRACE + 1);
  });

  it('shortfall = principal - repaid - unsynced inbox value, like stream_loan', async () => {
    expect(await viewShortfall(connection, payer, SPF, REF.live, loanOf(REF.live))).toBe(4_000_000n);
    expect(await viewShortfall(connection, payer, SPF, REF.pending, loanOf(REF.pending))).toBe(3_000_000n - 750_000n);
    expect(await viewShortfall(connection, payer, SPF, REF.noExpiry, loanOf(REF.noExpiry))).toBe(0n);
    // shares held in the stipend_pool escrow for the slot count as paid, like the unsynced inbox
    expect(await viewShortfall(connection, payer, SPF, REF.escrowed, loanOf(REF.escrowed))).toBe(3_000_000n - 500_000n - 1_200_000n);
    // the escrow account must be the slot's: another loan's escrow is refused
    await expect(viewShortfall(connection, payer, SPF, REF.escrowed, { ...loanOf(REF.escrowed), escrow: loanOf(REF.live).escrow })).rejects.toThrow();
    expect(await viewShortfall(connection, payer, SPF, REF.settled, loanOf(REF.settled))).toBe(0n);
    // production: 7-day grace, so the live loan is not short yet; the 8-days-overdue one is
    expect(await viewShortfall(connection, payer, SP, REF.live, loanOf(REF.live))).toBe(0n);
    expect(await viewShortfall(connection, payer, SP, REF.overdue, loanOf(REF.overdue))).toBe(7_000_000n - 2_000_000n - 1_000_000n);
  });

  it('matches stream_loan\'s own shortfall view on the same accounts (layout check)', async () => {
    // the staking validator must load the real stream_loan.so: without it this check would prove nothing
    expect(streamLoanLoaded, 'stream_loan.so is not loaded on the staking validator (build it: npm run solana:build)').toBe(true);
    const disc = sha256(new TextEncoder().encode('global:shortfall')).subarray(0, 8);
    for (const ref of [REF.overdue, REF.live, REF.pending, REF.noExpiry, REF.settled, REF.unfunded, REF.escrowed]) {
      const l = loanOf(ref);
      const ix = new TransactionInstruction({
        programId: SAFETY_STREAM_LOAN_PROGRAM_ID,
        keys: [l.slot, l.inbox, l.ledger, l.escrow].map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
        data: Buffer.from(concatBytes(disc, u64le(ref))),
      });
      const theirs = new DataView(padTo(await simulateReturn(connection, payer, ix), 8).buffer).getBigUint64(0, true);
      expect(await viewShortfall(connection, payer, SP, ref, l), `loan ${ref}`).toBe(theirs);
    }
  });

  it('slash: anyone triggers it, the cover lender is paid 1:1 in base units, once', async () => {
    const lenderAta = ataAddress(lender.publicKey, H.publicKey);
    // the payout must go to a token account the cover lender owns
    await expectFail(tx(stranger, slashIx(SPF, H.publicKey, REF.live, loanOf(REF.live), ataAddress(stranger.publicKey, H.publicKey))));
    // the cover lives in the H pool; E's pool cannot pay it
    await expectFail(tx(stranger, slashIx(SPF, E.publicKey, REF.live, loanOf(REF.live), ataAddress(lender.publicKey, E.publicKey))));
    // slot accounts of another loan
    await expectCode(tx(stranger, slashIx(SPF, H.publicKey, REF.live, loanOf(REF.pending), lenderAta)), SAFETY_ERROR.BadLoanAccount);
    const before = await tokenBalance(connection, lenderAta);
    const vault0 = await tokenBalance(connection, safetyVaultPda(SPF, H.publicKey));
    await tx(stranger, slashIx(SPF, H.publicKey, REF.live, loanOf(REF.live), lenderAta));
    expect(await tokenBalance(connection, lenderAta)).toBe(before + 4_000_000n); // 4 USDG short -> 4,000,000 base units of H081
    expect(await tokenBalance(connection, safetyVaultPda(SPF, H.publicKey))).toBe(vault0 - 4_000_000n);
    const c = decodeCover(await account(coverPda(SPF, REF.live)));
    expect(c.paid).toBe(true);
    expect(c.paidOut).toBe(4_000_000n);
    await expectCode(tx(stranger, slashIx(SPF, H.publicKey, REF.live, loanOf(REF.live), lenderAta)), SAFETY_ERROR.AlreadyPaid);
    // production: still inside the 7-day grace
    await expectCode(tx(stranger, slashIx(SP, H.publicKey, REF.live, loanOf(REF.live), lenderAta)), SAFETY_ERROR.NoShortfall);
    // production: overdue loan but never insured
    await expectFail(tx(stranger, slashIx(SP, H.publicKey, REF.overdue, loanOf(REF.overdue), lenderAta)));
    // the pending-inbox loan pays principal minus what is already routed
    await tx(stranger, slashIx(SPF, H.publicKey, REF.pending, loanOf(REF.pending), lenderAta));
    expect(decodeCover(await account(coverPda(SPF, REF.pending))).paidOut).toBe(2_250_000n);
    // the escrowed loan pays principal minus repaid minus what the pool holds in escrow for the slot
    const a0 = decodeSafetyConfig(await account(safetyConfigPda(SPF, H.publicKey))).assets;
    await tx(stranger, slashIx(SPF, H.publicKey, REF.escrowed, loanOf(REF.escrowed), lenderAta));
    expect(decodeCover(await account(coverPda(SPF, REF.escrowed))).paidOut).toBe(1_300_000n);
    expect(decodeSafetyConfig(await account(safetyConfigPda(SPF, H.publicKey))).assets).toBe(a0 - 1_300_000n);
  });

  it('withdraw after the cooldown redeems at the price of the day (slashes lowered it)', async () => {
    const ata = ataAddress(s2.publicKey, H.publicKey);
    const c = decodeSafetyConfig(await account(safetyConfigPda(SPF, H.publicKey)));
    const pos = decodePosition(await account(positionPda(SPF, H.publicKey, s2.publicKey)));
    await waitUntilChain(Number(pos.readyAt) + 1);
    const expected = redeemable(pos.unbonding, c.assets, c.totalShares);
    expect(expected).toBeLessThan((500n * TOK * 1_650n) / 1_500n); // below the post-premium price
    const before = await tokenBalance(connection, ata);
    await tx(s2, safetyWithdrawIx(SPF, s2.publicKey, H.publicKey, ata));
    expect(await tokenBalance(connection, ata)).toBe(before + expected);
    const c2 = decodeSafetyConfig(await account(safetyConfigPda(SPF, H.publicKey)));
    expect(c2.totalShares).toBe(c.totalShares - pos.unbonding);
    expect(c2.assets).toBe(c.assets - expected);
    await expectCode(tx(s2, safetyWithdrawIx(SPF, s2.publicKey, H.publicKey, ata)), SAFETY_ERROR.NothingUnbonding);
    await tx(s2, closePositionIx(SPF, s2.publicKey, H.publicKey));
    expect(await connection.getAccountInfo(positionPda(SPF, H.publicKey, s2.publicKey))).toBeNull();
  });

  it('slash on an empty pool fails and leaves the cover open; it pays once the pool is funded', async () => {
    const lenderE = ataAddress(lender.publicKey, E.publicKey);
    await expectCode(tx(stranger, slashIx(SPF, E.publicKey, REF.emptyPool, loanOf(REF.emptyPool), lenderE)), SAFETY_ERROR.PoolEmpty);
    expect(decodeCover(await account(coverPda(SPF, REF.emptyPool))).paid).toBe(false);
    const sAta = await fund(s3.publicKey, E.publicKey, 500_000n);
    await tx(s3, safetyDepositIx(SPF, s3.publicKey, E.publicKey, sAta, 500_000n));
    await tx(stranger, slashIx(SPF, E.publicKey, REF.emptyPool, loanOf(REF.emptyPool), lenderE));
    expect(await tokenBalance(connection, lenderE)).toBe(500_000n); // min(shortfall 2,000,000, pool 500,000)
    const cE = decodeSafetyConfig(await account(safetyConfigPda(SPF, E.publicKey)));
    expect(cE.generation).toBe(1n);
    expect(cE.totalShares).toBe(0n);
  });

  it('a slash that takes the whole pool retires every share (unbonding too); the next deposit starts at 1:1', async () => {
    const lenderAta = ataAddress(lender.publicKey, H.publicKey);
    await tx(s3, requestUnbondIx(SPF, s3.publicKey, H.publicKey, 100n * TOK)); // unbonding shares are at risk
    const bal = await tokenBalance(connection, safetyVaultPda(SPF, H.publicKey));
    const assets = decodeSafetyConfig(await account(safetyConfigPda(SPF, H.publicKey))).assets;
    const before = await tokenBalance(connection, lenderAta);
    await tx(stranger, slashIx(SPF, H.publicKey, REF.huge, loanOf(REF.huge), lenderAta));
    expect(await tokenBalance(connection, lenderAta)).toBe(before + assets); // the whole pool, not the unaccounted donation
    expect(await tokenBalance(connection, safetyVaultPda(SPF, H.publicKey))).toBe(bal - assets);
    const c = decodeSafetyConfig(await account(safetyConfigPda(SPF, H.publicKey)));
    expect(c.generation).toBe(1n);
    expect(c.totalShares).toBe(0n);
    expect(c.assets).toBe(0n);
    for (const k of [s1, s3]) {
      const p = await readSafetyPosition(connection, SPF, H.publicKey, k.publicKey);
      expect(p.shares).toBe(0n);
      expect(p.unbonding).toBe(0n);
    }
    await expectCode(tx(s3, safetyWithdrawIx(SPF, s3.publicKey, H.publicKey, ataAddress(s3.publicKey, H.publicKey))), SAFETY_ERROR.NothingUnbonding);
    await tx(s1, safetyDepositIx(SPF, s1.publicKey, H.publicKey, ataAddress(s1.publicKey, H.publicKey), 42n * TOK));
    const p1 = await readSafetyPosition(connection, SPF, H.publicKey, s1.publicKey);
    expect(p1.shares).toBe(sharesFor(42n * TOK, 0n, 0n));
    expect(p1.config.totalShares).toBe(p1.shares);
    expect(p1.config.assets).toBe(42n * TOK);
    // a retired position is empty and can be closed
    await tx(s3, closePositionIx(SPF, s3.publicKey, H.publicKey));
  });
});

describe.skipIf(!reachable)('safety_pool: share price manipulation', () => {
  it('a first depositor cannot inflate the share price with a donation: a later depositor withdraws what it paid', async () => {
    const G = Keypair.generate();
    const att = Keypair.generate();
    const vic = Keypair.generate();
    await makeMint(G);
    for (const k of [att, vic]) await airdrop(k.publicKey);
    const attAta = await fund(att.publicKey, G.publicKey, 1_001n * TOK);
    const vicAta = await fund(vic.publicKey, G.publicKey, 1_500n * TOK);
    await tx(payer, safetyInitPoolIx(SPF, payer.publicKey, G.publicKey));
    // one base unit for the first shares, then a large donation straight into the vault
    await tx(att, safetyDepositIx(SPF, att.publicKey, G.publicKey, attAta, 1n));
    await tx(att, transferCheckedIx(attAta, G.publicKey, safetyVaultPda(SPF, G.publicKey), att.publicKey, 1_000n * TOK, 6));
    await tx(vic, safetyDepositIx(SPF, vic.publicKey, G.publicKey, vicAta, 1_500n * TOK));
    const pv = await readSafetyPosition(connection, SPF, G.publicKey, vic.publicKey);
    expect(1_500n * TOK - pv.value).toBeLessThanOrEqual(1n);
    // on chain: unbond, wait for the fast cooldown, withdraw
    await tx(vic, requestUnbondIx(SPF, vic.publicKey, G.publicKey, pv.shares));
    const ready = decodePosition(await account(positionPda(SPF, G.publicKey, vic.publicKey))).readyAt;
    await waitUntilChain(Number(ready) + 1);
    await tx(vic, safetyWithdrawIx(SPF, vic.publicKey, G.publicKey, vicAta));
    expect(await tokenBalance(connection, vicAta)).toBeGreaterThanOrEqual(1_500n * TOK - 1n);
    // the attacker's shares redeem for about the one unit it deposited; the donation is not pool assets
    const pa = await readSafetyPosition(connection, SPF, G.publicKey, att.publicKey);
    expect(pa.value).toBeLessThanOrEqual(1n);
  });
});
