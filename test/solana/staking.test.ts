// Phase 2 staking on a private solana-test-validator (WSL, rpc 127.0.0.1:9199): capacity_stake and
// safety_pool for a Token-2022 mint with 6 decimals (like H081 on the launchpad), plus Token-2022 with a
// transfer fee and classic SPL Token. safety_pool reads stream_loan Slot/Ledger/inbox accounts that the
// validator loads as fixtures owned by the stream_loan program id (test/solana/staking-fixtures.ts);
// when stream_loan.so is loaded too, its own `shortfall` view is compared with safety_pool's.
// The *_fast builds (cooldowns 3 s, grace 2 s, separate ids) exercise the time-gated paths; the
// production builds show the real 30/14-day cooldowns and 7-day grace refuse early calls.
// Both programs are loaded upgradeable: only their upgrade authority (LOCALNET_UPGRADE_AUTHORITY) may create a
// config/pool, which names a config authority (`uw` here) that caps and pauses deposits/staking only and, for
// safety_pool, underwrites every cover.
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
  decodeStreamSlot, insureIx, loanAccounts, minPremium, mintToIx, positionPda, readCapacity, readSafetyPosition, redeemable, releaseCoverIx, requestUnbondIx,
  requestUnstakeIx, safetyConfigPda, safetyDepositIx, safetyInitPoolIx, safetySetDepositCapsIx, safetySetDepositsPausedIx, safetySetUnderwritingIx,
  safetyTopUpIx, safetyVaultPda, safetyWithdrawIx, setStakeCapsIx, setStakingPausedIx, simulateReturn, slashIx,
  stakeIx, stakePda, streamSlotPda, tokenBalance, unstakeIx, viewCapacity, viewShortfall, padTo, type CreateMintOptions,
} from '../../src/solana/token.js';
import { REF, readStakingMeta, type StakingMeta } from './staking-fixtures.js';
import { LOCALNET_UPGRADE_AUTHORITY } from './config-authority.js';

const RPC = process.env.STAKING_RPC ?? 'http://127.0.0.1:9199';
const CS = LOCALNET_CAPACITY_STAKE_PROGRAM_ID;
const CSF = LOCALNET_CAPACITY_STAKE_FAST_PROGRAM_ID;
const SP = LOCALNET_SAFETY_POOL_PROGRAM_ID;
const SPF = LOCALNET_SAFETY_POOL_FAST_PROGRAM_ID;
const T22 = TOKEN22_PROGRAM_ID;
const TOK = 1_000_000n; // one whole token at 6 decimals
const FAST_GRACE = 2;
const BIG = 10n ** 15n;
const UA = LOCALNET_UPGRADE_AUTHORITY;

const connection = new Connection(RPC, 'confirmed');
const payer = Keypair.generate();
const s1 = Keypair.generate();
const s2 = Keypair.generate();
const s3 = Keypair.generate();
const stranger = Keypair.generate();
/** config authority of every pool/config created here: caps, pause, underwriting */
const uw = Keypair.generate();
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
// F = Token-2022 with a 1% transfer fee; C = classic SPL Token; D = the dust-slash pool; K = the caps/pause pool
const H = Keypair.generate();
const E = Keypair.generate();
const F = Keypair.generate();
const C = Keypair.generate();
const D = Keypair.generate();
const K = Keypair.generate();

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
const txs = (signers: Keypair[], ...ixs: TransactionInstruction[]) => send(connection, signers[0], ixs, { signers: signers.slice(1) });
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
const cfgOf = async (prog: PublicKey, mint: PublicKey) => decodeSafetyConfig(await account(safetyConfigPda(prog, mint)));
/** A pool created by the upgrade authority, config authority `uw`, effectively uncapped. */
const initPool = (prog: PublicKey, mint: PublicKey, caps = { maxTotal: BIG, maxPerDeposit: BIG }, tp = T22) =>
  tx(UA, safetyInitPoolIx(prog, UA.publicKey, mint, { authority: uw.publicKey, ...caps }, tp));
const initCapacity = (prog: PublicKey, mint: PublicKey, tp = T22) =>
  tx(UA, capacityInitConfigIx(prog, UA.publicKey, mint, { authority: uw.publicKey, maxTotal: BIG, maxPerStake: BIG }, tp));
/** `uw` makes `mint`'s pool insure the fixtures' loan asset. */
const underwrite = (prog: PublicKey, mint: PublicKey, over: Partial<{ maxCover: bigint; maxExposure: bigint; minPremiumBps: number; loanAsset: PublicKey }> = {}) =>
  tx(uw, safetySetUnderwritingIx(prog, uw.publicKey, mint, { loanAsset: asset, maxCover: BIG, maxExposure: 10n * BIG, minPremiumBps: 0, ...over }));
/** The lender asks, the underwriter co-signs. */
const insure = (ref: bigint, cover: bigint, o: { prog?: PublicKey; mint?: PublicKey; premium?: bigint; who?: Keypair; underwriter?: Keypair } = {}) => {
  const who = o.who ?? lender, under = o.underwriter ?? uw, mint = o.mint ?? H.publicKey;
  return txs([who, under], insureIx(o.prog ?? SPF, who.publicKey, mint, ataAddress(who.publicKey, mint), ref, o.premium ?? 0n, cover, under.publicKey));
};

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
  for (const k of [s1, s2, s3, stranger, lender, uw, UA]) await airdrop(k.publicKey);
  await makeMint(H);
  await makeMint(E);
  await makeMint(D);
  await makeMint(K);
  await makeMint(F, { transferFee: { bps: 100, max: 1_000_000n * TOK } });
  await makeMint(C, { tokenProgram: CLASSIC_TOKEN_PROGRAM_ID });
  for (const k of [s1, s2, s3, lender]) await fund(k.publicKey, H.publicKey, 10_000n * TOK);
  await fund(stranger.publicKey, H.publicKey, 0n);
  await fund(s1.publicKey, D.publicKey, 2_000_000n * TOK);
  const now = await chainNow();
  if (now > meta.liveExpiry - 60) throw new Error(`fixtures are stale (chain ${now}, live expiry ${meta.liveExpiry}); restart with npm run test:staking`);
});

describe.skipIf(!reachable)('safety_pool: setup and insure (must run before the live loans expire)', () => {
  it('fixtures decode as stream_loan Slot accounts', async () => {
    const s = decodeStreamSlot(await account(streamSlotPda(REF.live)));
    expect(s.loanRef).toBe(REF.live);
    expect(s.lender.equals(lender.publicKey)).toBe(true);
    expect(s.expiry).toBe(BigInt(meta.liveExpiry));
  });

  it('init_pool: only the upgrade authority, per mint, exactly once; it names the config authority and the caps', async () => {
    for (const prog of [SP, SPF]) {
      const caps = { authority: uw.publicKey, maxTotal: BIG, maxPerDeposit: BIG };
      await expectCode(tx(stranger, safetyInitPoolIx(prog, stranger.publicKey, H.publicKey, caps)), SAFETY_ERROR.UpgradeAuthority);
      await initPool(prog, H.publicKey);
      const c = await cfgOf(prog, H.publicKey);
      expect(c.mint.equals(H.publicKey)).toBe(true);
      expect(c.vault.equals(safetyVaultPda(prog, H.publicKey))).toBe(true);
      expect(c.tokenProgram.equals(T22)).toBe(true);
      expect(c.decimals).toBe(6);
      expect(c.totalShares).toBe(0n);
      expect(c.generation).toBe(0n);
      expect(c.authority.equals(uw.publicKey)).toBe(true);
      expect(c.depositsPaused).toBe(false);
      expect(c.maxTotal).toBe(BIG);
      expect(c.maxPerDeposit).toBe(BIG);
      // nothing is insurable until the config authority says what
      expect(c.loanAsset.equals(PublicKey.default)).toBe(true);
      expect(c.exposure).toBe(0n);
      await expectFail(initPool(prog, H.publicKey));
    }
    await initPool(SPF, E.publicKey);
    await initPool(SPF, D.publicKey);
  });

  it('the config setters take only the config authority', async () => {
    await expectCode(tx(stranger, safetySetDepositCapsIx(SPF, stranger.publicKey, H.publicKey, 1n, 1n)), SAFETY_ERROR.ConfigAuthority);
    await expectCode(tx(stranger, safetySetDepositsPausedIx(SPF, stranger.publicKey, H.publicKey, true)), SAFETY_ERROR.ConfigAuthority);
    await expectCode(tx(stranger, safetySetUnderwritingIx(SPF, stranger.publicKey, H.publicKey, { loanAsset: asset, maxCover: BIG, maxExposure: BIG, minPremiumBps: 0 })), SAFETY_ERROR.ConfigAuthority);
    for (const prog of [SP, SPF]) await underwrite(prog, H.publicKey);
    await underwrite(SPF, D.publicKey);
    const c = await cfgOf(SPF, H.publicKey);
    expect(c.loanAsset.equals(asset)).toBe(true);
    expect(c.maxCover).toBe(BIG);
    expect(c.minPremiumBps).toBe(0);
  });

  it('deposit mints shares at (assets + 10^6) / (shares + 10^9); a donation straight to the vault does not move the price', async () => {
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
    // the dust-slash pool: 2M tokens at risk
    await tx(s1, safetyDepositIx(SPF, s1.publicKey, D.publicKey, ataAddress(s1.publicKey, D.publicKey), 2_000_000n * TOK));
  });

  it('deposit caps (total and per deposit) and the deposit-only pause; unbonding and withdrawals are never paused', async () => {
    await fund(s1.publicKey, K.publicKey, 1_000n * TOK);
    const from = ataAddress(s1.publicKey, K.publicKey);
    await initPool(SPF, K.publicKey, { maxTotal: 100n * TOK, maxPerDeposit: 60n * TOK });
    const dep = (n: bigint) => tx(s1, safetyDepositIx(SPF, s1.publicKey, K.publicKey, from, n));
    await expectCode(dep(61n * TOK), SAFETY_ERROR.DepositCap);
    await dep(60n * TOK);
    await expectCode(dep(41n * TOK), SAFETY_ERROR.DepositCap); // 101 > 100 in total
    await dep(40n * TOK);
    expect((await cfgOf(SPF, K.publicKey)).assets).toBe(100n * TOK);
    // paused: deposits and new covers are refused, unbonding and withdrawing still work
    await tx(uw, safetySetDepositsPausedIx(SPF, uw.publicKey, K.publicKey, true));
    expect((await cfgOf(SPF, K.publicKey)).depositsPaused).toBe(true);
    await tx(uw, safetySetDepositCapsIx(SPF, uw.publicKey, K.publicKey, BIG, BIG));
    await expectCode(dep(1n * TOK), SAFETY_ERROR.DepositsPaused);
    await underwrite(SPF, K.publicKey);
    await fund(lender.publicKey, K.publicKey, 0n);
    await expectCode(insure(REF.live, 1n, { mint: K.publicKey }), SAFETY_ERROR.DepositsPaused);
    const p = await readSafetyPosition(connection, SPF, K.publicKey, s1.publicKey);
    await tx(s1, requestUnbondIx(SPF, s1.publicKey, K.publicKey, p.shares / 2n));
    const ready = decodePosition(await account(positionPda(SPF, K.publicKey, s1.publicKey))).readyAt;
    await waitUntilChain(Number(ready) + 1);
    const before = await tokenBalance(connection, from);
    await tx(s1, safetyWithdrawIx(SPF, s1.publicKey, K.publicKey, from));
    expect(50n * TOK - (await tokenBalance(connection, from) - before)).toBeLessThanOrEqual(1n);
    // resumed
    await tx(uw, safetySetDepositsPausedIx(SPF, uw.publicKey, K.publicKey, false));
    await dep(1n * TOK);
  });

  it('insure: lender and underwriter sign; only funded, unsettled, dated, unexpired loans; valid stream_loan accounts only', async () => {
    await fund(stranger.publicKey, H.publicKey, 10n * TOK);
    await expectCode(insure(REF.live, 1n, { who: stranger }), SAFETY_ERROR.NotTheLender);
    await expectCode(insure(REF.unfunded, 1n), SAFETY_ERROR.NoLoan);
    await expectCode(insure(REF.noExpiry, 1n), SAFETY_ERROR.NoDueDate);
    await expectCode(insure(REF.expired, 1n), SAFETY_ERROR.Expired);
    await expectCode(insure(REF.settled, 1n), SAFETY_ERROR.Settled);
    await expectCode(insure(REF.wrongOwner, 1n), SAFETY_ERROR.BadLoanAccount);
    // another loan's slot passed for this loan ref
    const forged = insureIx(SPF, lender.publicKey, H.publicKey, ataAddress(lender.publicKey, H.publicKey), REF.unfunded, 0n, 1n, uw.publicKey);
    forged.keys[2].pubkey = streamSlotPda(REF.live);
    await expectCode(txs([lender, uw], forged), SAFETY_ERROR.BadLoanAccount);
    // the underwriter must sign: another signer in its place, or no signature at all
    await expectCode(insure(REF.live, 1n, { underwriter: stranger }), SAFETY_ERROR.ConfigAuthority);
    await expectFail(tx(lender, insureIx(SPF, lender.publicKey, H.publicKey, ataAddress(lender.publicKey, H.publicKey), REF.live, 0n, 1n, uw.publicKey)));
    // a pool insures only the asset its underwriter named (E has none yet, then another one)
    await fund(lender.publicKey, E.publicKey, 0n);
    await expectCode(insure(REF.emptyPool, 1n, { mint: E.publicKey }), SAFETY_ERROR.NotInsurable);
    await underwrite(SPF, E.publicKey, { loanAsset: PublicKey.unique() });
    await expectCode(insure(REF.emptyPool, 1n, { mint: E.publicKey }), SAFETY_ERROR.NotInsurable);
    // production: the loan can be slashed (expiry + 7-day grace) before a staker could unbond (14 days)
    await expectCode(insure(REF.live, 1n, { prog: SP }), SAFETY_ERROR.TooShort);
    // the cover: positive, at most the principal and the per-cover limit; total open cover under its limit
    await expectCode(insure(REF.live, 0n), SAFETY_ERROR.CoverTooLarge);
    await expectCode(insure(REF.live, 5_000_001n), SAFETY_ERROR.CoverTooLarge);
    await underwrite(SPF, H.publicKey, { maxCover: 1_000_000n });
    await expectCode(insure(REF.live, 2_000_000n), SAFETY_ERROR.CoverTooLarge);
    await underwrite(SPF, H.publicKey, { maxExposure: 1_000_000n });
    await expectCode(insure(REF.live, 2_000_000n), SAFETY_ERROR.ExposureCap);
    // the premium floor (bps of the cover, rounded up)
    await underwrite(SPF, H.publicKey, { minPremiumBps: 100 });
    expect(minPremium(5_000_000n, 100)).toBe(50_000n);
    await expectCode(insure(REF.live, 5_000_000n, { premium: 49_999n }), SAFETY_ERROR.PremiumTooLow);
    expect(await connection.getAccountInfo(coverPda(SPF, REF.live))).toBeNull();
  });

  it('insure binds the cover and the premium raises the share price', async () => {
    const before = await tokenBalance(connection, safetyVaultPda(SPF, H.publicKey));
    await insure(REF.live, 5_000_000n, { premium: 150n * TOK });
    await underwrite(SPF, H.publicKey); // premium floor back to 0 for the other covers
    const c = decodeCover(await account(coverPda(SPF, REF.live)));
    expect(c.loanRef).toBe(REF.live);
    expect(c.lender.equals(lender.publicKey)).toBe(true);
    expect(c.mint.equals(H.publicKey)).toBe(true);
    expect(c.premium).toBe(150n * TOK);
    expect(c.limit).toBe(5_000_000n);
    expect(c.released).toBe(false);
    expect(c.paid).toBe(false);
    expect(c.boundAt).toBeGreaterThan(0n);
    expect(await tokenBalance(connection, safetyVaultPda(SPF, H.publicKey))).toBe(before + 150n * TOK);
    const p1 = await readSafetyPosition(connection, SPF, H.publicKey, s1.publicKey);
    expect(p1.config.assets).toBe(1_650n * TOK);
    expect(p1.config.exposure).toBe(5_000_000n);
    expect(p1.value).toBe(redeemable(p1.shares, p1.config.assets, p1.config.totalShares));
    // about 1,100 tokens (the 1-token virtual stake keeps a sliver of the premium)
    expect((1_000n * TOK * 1_650n) / 1_500n - p1.value).toBeLessThan(TOK / 5n);
    // one cover per loan: again in the same pool, or in another mint's pool of the same program
    await expectFail(insure(REF.live, 1n));
    await underwrite(SPF, E.publicKey);
    await expectFail(insure(REF.live, 1n, { mint: E.publicKey }));
  });

  it('insures the remaining live loans (pending inbox, huge, escrowed, repaid, empty pool, dust) and the production cover', async () => {
    await insure(REF.pending, 2_000_000n); // below its 2.25M shortfall: the slash is limited by the cover
    await insure(REF.huge, BIG);
    await insure(REF.escrowed, 3_000_000n);
    await insure(REF.repaid, 2_000_000n);
    await insure(REF.emptyPool, 2_000_000n, { mint: E.publicKey });
    await fund(lender.publicKey, D.publicKey, 0n);
    await insure(REF.dust, 2_000_000n * TOK - 1n, { mint: D.publicKey });
    await insure(REF.long, 5_000_000n, { prog: SP });
    expect(decodeCover(await account(coverPda(SP, REF.long))).premium).toBe(0n);
    expect((await cfgOf(SPF, H.publicKey)).exposure).toBe(5_000_000n + 2_000_000n + BIG + 3_000_000n + 2_000_000n);
  });

  it('release_cover: anyone frees a repaid loan\'s cover (its exposure); an unpaid loan\'s cover stays', async () => {
    const e0 = (await cfgOf(SPF, H.publicKey)).exposure;
    await expectCode(tx(stranger, releaseCoverIx(SPF, H.publicKey, REF.live, loanOf(REF.live))), SAFETY_ERROR.NotReleasable);
    // another loan's accounts are refused
    await expectCode(tx(stranger, releaseCoverIx(SPF, H.publicKey, REF.repaid, loanOf(REF.live))), SAFETY_ERROR.BadLoanAccount);
    await tx(stranger, releaseCoverIx(SPF, H.publicKey, REF.repaid, loanOf(REF.repaid)));
    const c = decodeCover(await account(coverPda(SPF, REF.repaid)));
    expect(c.released).toBe(true);
    expect((await cfgOf(SPF, H.publicKey)).exposure).toBe(e0 - 2_000_000n);
    await expectCode(tx(stranger, releaseCoverIx(SPF, H.publicKey, REF.repaid, loanOf(REF.repaid))), SAFETY_ERROR.Released);
  });

  it('a later deposit gets shares at the raised price', async () => {
    const c0 = await cfgOf(SPF, H.publicKey);
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
  it('init_config: only the upgrade authority, per mint, exactly once, units scaled by decimals', async () => {
    for (const prog of [CS, CSF]) {
      const caps = { authority: uw.publicKey, maxTotal: BIG, maxPerStake: BIG };
      await expectCode(tx(stranger, capacityInitConfigIx(prog, stranger.publicKey, H.publicKey, caps)), CAPACITY_ERROR.UpgradeAuthority);
      await initCapacity(prog, H.publicKey);
      const c = decodeCapacityConfig(await account(capacityConfigPda(prog, H.publicKey)));
      expect(c.mint.equals(H.publicKey)).toBe(true);
      expect(c.vault.equals(capacityVaultPda(prog, H.publicKey))).toBe(true);
      expect(c.tokenProgram.equals(T22)).toBe(true);
      expect(c.decimals).toBe(6);
      expect(c.deskUnit).toBe(100n * TOK);
      expect(c.shieldUnit).toBe(100n * TOK);
      expect(c.authority.equals(uw.publicKey)).toBe(true);
      expect(c.stakingPaused).toBe(false);
      expect(c.maxTotal).toBe(BIG);
      await expectFail(initCapacity(prog, H.publicKey));
    }
    // a mint must be passed with its own token program
    await expectFail(initCapacity(CS, H.publicKey, CLASSIC_TOKEN_PROGRAM_ID));
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

  it('request_unstake leaves capacity at once and starts the 30-day cooldown (one full relayer capacity window)', async () => {
    await expectCode(tx(s1, requestUnstakeIx(CS, s1.publicKey, H.publicKey, 301n * TOK)), CAPACITY_ERROR.MoreThanStaked);
    await expectCode(tx(s1, requestUnstakeIx(CS, s1.publicKey, H.publicKey, 0n)), CAPACITY_ERROR.Amount);
    await tx(s1, requestUnstakeIx(CS, s1.publicKey, H.publicKey, 150n * TOK));
    const st = decodeStake(await account(stakePda(CS, H.publicKey, s1.publicKey)));
    expect(st.staked).toBe(150n * TOK);
    expect(st.pending).toBe(150n * TOK);
    expect(st.readyAt - BigInt(await chainNow())).toBeGreaterThan(30n * 86400n - 120n);
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

  it('staking caps (total and per stake) and the stake-only pause; unstake requests and unstaking are never paused', async () => {
    const ata = ataAddress(s1.publicKey, H.publicKey);
    const st = (n: bigint) => tx(s1, stakeIx(CSF, s1.publicKey, H.publicKey, ata, n));
    await expectCode(tx(stranger, setStakeCapsIx(CSF, stranger.publicKey, H.publicKey, 1n, 1n)), CAPACITY_ERROR.ConfigAuthority);
    await expectCode(tx(stranger, setStakingPausedIx(CSF, stranger.publicKey, H.publicKey, true)), CAPACITY_ERROR.ConfigAuthority);
    await tx(uw, setStakeCapsIx(CSF, uw.publicKey, H.publicKey, 80n * TOK, 50n * TOK));
    await expectCode(st(51n * TOK), CAPACITY_ERROR.StakeCap);
    await st(50n * TOK);
    await expectCode(st(31n * TOK), CAPACITY_ERROR.StakeCap); // 81 > 80 in total
    await st(30n * TOK);
    await tx(uw, setStakingPausedIx(CSF, uw.publicKey, H.publicKey, true));
    await tx(uw, setStakeCapsIx(CSF, uw.publicKey, H.publicKey, BIG, BIG));
    await expectCode(st(1n), CAPACITY_ERROR.StakingPaused);
    await tx(s1, requestUnstakeIx(CSF, s1.publicKey, H.publicKey, 80n * TOK));
    const pend = decodeStake(await account(stakePda(CSF, H.publicKey, s1.publicKey)));
    await waitUntilChain(Number(pend.readyAt) + 1);
    const before = await tokenBalance(connection, ata);
    await tx(s1, unstakeIx(CSF, s1.publicKey, H.publicKey, ata));
    expect(await tokenBalance(connection, ata)).toBe(before + 80n * TOK);
    await tx(uw, setStakingPausedIx(CSF, uw.publicKey, H.publicKey, false));
    await st(1n);
  });

  it('Token-2022 transfer fee: only what the vault receives counts', async () => {
    const ata = await fund(s1.publicKey, F.publicKey, 10_000n * TOK);
    await initCapacity(CS, F.publicKey);
    await tx(s1, stakeIx(CS, s1.publicKey, F.publicKey, ata, 1_000n * TOK));
    const st = decodeStake(await account(stakePda(CS, F.publicKey, s1.publicKey)));
    expect(st.staked).toBe(990n * TOK); // 1% fee withheld
    expect(await tokenBalance(connection, capacityVaultPda(CS, F.publicKey))).toBe(990n * TOK);
  });

  it('classic SPL Token mints work through the same interface', async () => {
    const ata = await fund(s2.publicKey, C.publicKey, 1_000n * TOK, CLASSIC_TOKEN_PROGRAM_ID);
    await initCapacity(CSF, C.publicKey, CLASSIC_TOKEN_PROGRAM_ID);
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
    expect(await viewShortfall(connection, payer, SPF, REF.repaid, loanOf(REF.repaid))).toBe(0n);
    // shares held in the stipend_pool escrow for the slot count as paid, like the unsynced inbox
    expect(await viewShortfall(connection, payer, SPF, REF.escrowed, loanOf(REF.escrowed))).toBe(3_000_000n - 500_000n - 1_200_000n);
    // the escrow account must be the slot's: another loan's escrow is refused
    await expect(viewShortfall(connection, payer, SPF, REF.escrowed, { ...loanOf(REF.escrowed), escrow: loanOf(REF.live).escrow })).rejects.toThrow();
    expect(await viewShortfall(connection, payer, SPF, REF.settled, loanOf(REF.settled))).toBe(0n);
    // production: 7-day grace, so the live loan is not short yet; the 8-days-overdue one is
    expect(await viewShortfall(connection, payer, SP, REF.live, loanOf(REF.live))).toBe(0n);
    expect(await viewShortfall(connection, payer, SP, REF.long, loanOf(REF.long))).toBe(0n);
    expect(await viewShortfall(connection, payer, SP, REF.overdue, loanOf(REF.overdue))).toBe(7_000_000n - 2_000_000n - 1_000_000n);
  });

  it('matches stream_loan\'s own shortfall view on the same accounts (layout check)', async () => {
    // the staking validator must load the real stream_loan.so: without it this check would prove nothing
    expect(streamLoanLoaded, 'stream_loan.so is not loaded on the staking validator (build it: npm run solana:build)').toBe(true);
    const disc = sha256(new TextEncoder().encode('global:shortfall')).subarray(0, 8);
    for (const ref of [REF.overdue, REF.live, REF.pending, REF.noExpiry, REF.settled, REF.unfunded, REF.escrowed, REF.long, REF.repaid, REF.dust]) {
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

  it('slash: anyone triggers it, the cover lender is paid 1:1 in base units up to the cover, once', async () => {
    const lenderAta = ataAddress(lender.publicKey, H.publicKey);
    // the payout must go to a token account the cover lender owns
    await expectFail(tx(stranger, slashIx(SPF, H.publicKey, REF.live, loanOf(REF.live), ataAddress(stranger.publicKey, H.publicKey))));
    // the cover lives in the H pool; E's pool cannot pay it
    await expectFail(tx(stranger, slashIx(SPF, E.publicKey, REF.live, loanOf(REF.live), ataAddress(lender.publicKey, E.publicKey))));
    // slot accounts of another loan
    await expectCode(tx(stranger, slashIx(SPF, H.publicKey, REF.live, loanOf(REF.pending), lenderAta)), SAFETY_ERROR.BadLoanAccount);
    const before = await tokenBalance(connection, lenderAta);
    const vault0 = await tokenBalance(connection, safetyVaultPda(SPF, H.publicKey));
    const e0 = (await cfgOf(SPF, H.publicKey)).exposure;
    await tx(stranger, slashIx(SPF, H.publicKey, REF.live, loanOf(REF.live), lenderAta));
    expect(await tokenBalance(connection, lenderAta)).toBe(before + 4_000_000n); // 4 USDG short -> 4,000,000 base units of H081
    expect(await tokenBalance(connection, safetyVaultPda(SPF, H.publicKey))).toBe(vault0 - 4_000_000n);
    expect((await cfgOf(SPF, H.publicKey)).exposure).toBe(e0 - 5_000_000n); // the whole cover is closed
    const c = decodeCover(await account(coverPda(SPF, REF.live)));
    expect(c.paid).toBe(true);
    expect(c.paidOut).toBe(4_000_000n);
    await expectCode(tx(stranger, slashIx(SPF, H.publicKey, REF.live, loanOf(REF.live), lenderAta)), SAFETY_ERROR.AlreadyPaid);
    // production: still inside the 7-day grace
    await expectCode(tx(stranger, slashIx(SP, H.publicKey, REF.long, loanOf(REF.long), lenderAta)), SAFETY_ERROR.NoShortfall);
    // production: overdue loan but never insured
    await expectFail(tx(stranger, slashIx(SP, H.publicKey, REF.overdue, loanOf(REF.overdue), lenderAta)));
    // the pending-inbox loan is 2.25M short but covered for 2M: the cover caps the payout
    await tx(stranger, slashIx(SPF, H.publicKey, REF.pending, loanOf(REF.pending), lenderAta));
    expect(decodeCover(await account(coverPda(SPF, REF.pending))).paidOut).toBe(2_000_000n);
    // the escrowed loan pays principal minus repaid minus what the pool holds in escrow for the slot
    const a0 = (await cfgOf(SPF, H.publicKey)).assets;
    await tx(stranger, slashIx(SPF, H.publicKey, REF.escrowed, loanOf(REF.escrowed), lenderAta));
    expect(decodeCover(await account(coverPda(SPF, REF.escrowed))).paidOut).toBe(1_300_000n);
    expect((await cfgOf(SPF, H.publicKey)).assets).toBe(a0 - 1_300_000n);
    // a released cover cannot be slashed
    await expectCode(tx(stranger, slashIx(SPF, H.publicKey, REF.repaid, loanOf(REF.repaid), lenderAta)), SAFETY_ERROR.Released);
  });

  it('withdraw after the cooldown redeems at the price of the day (slashes lowered it)', async () => {
    const ata = ataAddress(s2.publicKey, H.publicKey);
    const c = await cfgOf(SPF, H.publicKey);
    const pos = decodePosition(await account(positionPda(SPF, H.publicKey, s2.publicKey)));
    await waitUntilChain(Number(pos.readyAt) + 1);
    const expected = redeemable(pos.unbonding, c.assets, c.totalShares);
    expect(expected).toBeLessThan((500n * TOK * 1_650n) / 1_500n); // below the post-premium price
    const before = await tokenBalance(connection, ata);
    await tx(s2, safetyWithdrawIx(SPF, s2.publicKey, H.publicKey, ata));
    expect(await tokenBalance(connection, ata)).toBe(before + expected);
    const c2 = await cfgOf(SPF, H.publicKey);
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
    const cE = await cfgOf(SPF, E.publicKey);
    expect(cE.generation).toBe(1n);
    expect(cE.totalShares).toBe(0n);
    expect(cE.exposure).toBe(0n);
  });

  it('a slash that takes the whole pool retires every share (unbonding too); the next deposit starts fresh', async () => {
    const lenderAta = ataAddress(lender.publicKey, H.publicKey);
    await tx(s3, requestUnbondIx(SPF, s3.publicKey, H.publicKey, 100n * TOK)); // unbonding shares are at risk
    const bal = await tokenBalance(connection, safetyVaultPda(SPF, H.publicKey));
    const assets = (await cfgOf(SPF, H.publicKey)).assets;
    const before = await tokenBalance(connection, lenderAta);
    await tx(stranger, slashIx(SPF, H.publicKey, REF.huge, loanOf(REF.huge), lenderAta));
    expect(await tokenBalance(connection, lenderAta)).toBe(before + assets); // the whole pool, not the unaccounted donation
    expect(await tokenBalance(connection, safetyVaultPda(SPF, H.publicKey))).toBe(bal - assets);
    const c = await cfgOf(SPF, H.publicKey);
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

  it('a slash that leaves dust retires the collapsed generation; a later depositor withdraws in full (no overflow)', async () => {
    const lenderD = ataAddress(lender.publicKey, D.publicKey);
    const c0 = await cfgOf(SPF, D.publicKey);
    expect(c0.assets).toBe(2_000_000n * TOK);
    expect(await viewShortfall(connection, payer, SPF, REF.dust, loanOf(REF.dust))).toBe(2_000_000n * TOK - 1n);
    await tx(stranger, slashIx(SPF, D.publicKey, REF.dust, loanOf(REF.dust), lenderD));
    expect(await tokenBalance(connection, lenderD)).toBe(2_000_000n * TOK - 1n);
    const c = await cfgOf(SPF, D.publicKey);
    // one base unit left against 2e15 shares: more than 10^9 shares per unit, so the generation is retired
    expect(c.assets).toBe(1n);
    expect(c.generation).toBe(1n);
    expect(c.totalShares).toBe(0n);
    expect((await readSafetyPosition(connection, SPF, D.publicKey, s1.publicKey)).shares).toBe(0n);
    // a new 1M-token staker can get out again
    const a2 = await fund(s2.publicKey, D.publicKey, 1_000_000n * TOK);
    await tx(s2, safetyDepositIx(SPF, s2.publicKey, D.publicKey, a2, 1_000_000n * TOK));
    const p2 = await readSafetyPosition(connection, SPF, D.publicKey, s2.publicKey);
    await tx(s2, requestUnbondIx(SPF, s2.publicKey, D.publicKey, p2.shares));
    const ready = decodePosition(await account(positionPda(SPF, D.publicKey, s2.publicKey))).readyAt;
    await waitUntilChain(Number(ready) + 1);
    await tx(s2, safetyWithdrawIx(SPF, s2.publicKey, D.publicKey, a2));
    expect(await tokenBalance(connection, a2)).toBeGreaterThanOrEqual(1_000_000n * TOK - 1n);
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
    await initPool(SPF, G.publicKey);
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

  it('a dust stake cannot capture a top-up: a top-up is capped at the pool\'s assets, and pays the dust only its share', async () => {
    const G = Keypair.generate();
    const att = Keypair.generate();
    await makeMint(G);
    await airdrop(att.publicKey);
    const attAta = await fund(att.publicKey, G.publicKey, 1n);
    const aS = await fund(stranger.publicKey, G.publicKey, 300n * TOK);
    await initPool(SPF, G.publicKey);
    await tx(att, safetyDepositIx(SPF, att.publicKey, G.publicKey, attAta, 1n));
    expect((await readSafetyPosition(connection, SPF, G.publicKey, att.publicKey)).shares).toBe(1_000n);
    // the flywheel's 300-token top-up into a pool holding one base unit is refused outright
    await expectCode(tx(stranger, safetyTopUpIx(SPF, stranger.publicKey, G.publicKey, aS, 300n * TOK)), SAFETY_ERROR.TopUpTooLarge);
    await tx(stranger, safetyTopUpIx(SPF, stranger.publicKey, G.publicKey, aS, 1n));
    const pa = await readSafetyPosition(connection, SPF, G.publicKey, att.publicKey);
    expect(pa.config.assets).toBe(2n);
    // 1,000 shares against 10^9 virtual ones: the dust stake redeems for its one unit, not half the top-up
    expect(pa.value).toBeLessThanOrEqual(1n);
  });
});

// top_up: the flywheel pays stakers with H081 bought from PLATFORM fees (never the token's creator fees).
// Runs after the slash describe above, which retires the E pool's generation 0.
describe.skipIf(!reachable)('safety_pool: top_up', () => {
  const LAUNCH = new PublicKey('2wjxKzH7fVGpjcA9KpjDBDHjSAhz7u8ZgMLnVPVGSkDP');

  it('raises what every share redeems for (unbonding ones too) without minting shares; refused at zero shares', async () => {
    const G = Keypair.generate();
    await makeMint(G);
    const a1 = await fund(s1.publicKey, G.publicKey, 1_000n * TOK);
    const a2 = await fund(s2.publicKey, G.publicKey, 500n * TOK);
    const aS = await fund(stranger.publicKey, G.publicKey, 300n * TOK);
    await initPool(SPF, G.publicKey);
    const vault = safetyVaultPda(SPF, G.publicKey);
    // nobody to pay yet: refused, nothing moves
    await expectCode(tx(stranger, safetyTopUpIx(SPF, stranger.publicKey, G.publicKey, aS, 300n * TOK)), SAFETY_ERROR.NoShares);
    expect(await tokenBalance(connection, aS)).toBe(300n * TOK);
    expect(await tokenBalance(connection, vault)).toBe(0n);

    await tx(s1, safetyDepositIx(SPF, s1.publicKey, G.publicKey, a1, 1_000n * TOK));
    await tx(s2, safetyDepositIx(SPF, s2.publicKey, G.publicKey, a2, 500n * TOK));
    const q2 = await readSafetyPosition(connection, SPF, G.publicKey, s2.publicKey);
    await tx(s2, requestUnbondIx(SPF, s2.publicKey, G.publicKey, q2.shares));
    const c0 = await cfgOf(SPF, G.publicKey);
    const q1 = await readSafetyPosition(connection, SPF, G.publicKey, s1.publicKey);

    await expectCode(tx(stranger, safetyTopUpIx(SPF, stranger.publicKey, G.publicKey, aS, 0n)), SAFETY_ERROR.Amount);
    await tx(stranger, safetyTopUpIx(SPF, stranger.publicKey, G.publicKey, aS, 300n * TOK));
    expect(await tokenBalance(connection, aS)).toBe(0n);
    expect(await tokenBalance(connection, vault)).toBe(1_800n * TOK);
    const p1 = await readSafetyPosition(connection, SPF, G.publicKey, s1.publicKey);
    const p2 = await readSafetyPosition(connection, SPF, G.publicKey, s2.publicKey);
    expect(p1.config.totalShares).toBe(c0.totalShares); // no shares minted
    expect(p1.config.assets).toBe(c0.assets + 300n * TOK);
    expect(p1.config.generation).toBe(c0.generation);
    expect(p1.shares).toBe(q1.shares);
    expect(p2.unbonding).toBe(q2.shares);
    expect(p1.value).toBeGreaterThan(q1.value);
    expect(p1.value).toBe(redeemable(p1.shares, p1.config.assets, p1.config.totalShares));
    // 1,000 + 2/3 of 300 (less the 1-token virtual stake's sliver)
    expect(1_200n * TOK - p1.value).toBeLessThan(TOK / 2n);
    expect(600n * TOK - p2.unbondingValue).toBeLessThan(TOK / 2n); // 500 + 1/3 of 300, while unbonding
    // on chain: the unbonding staker withdraws its share of the top-up
    await waitUntilChain(Number(p2.readyAt) + 1);
    await tx(s2, safetyWithdrawIx(SPF, s2.publicKey, G.publicKey, a2));
    expect(600n * TOK - (await tokenBalance(connection, a2))).toBeLessThan(TOK / 2n);
  });

  it('refuses a launch wallet as the source', async () => {
    const launchAta = await fund(LAUNCH, H.publicKey, 0n);
    await expectCode(tx(stranger, safetyTopUpIx(SPF, stranger.publicKey, H.publicKey, launchAta, 1n)), SAFETY_ERROR.LaunchWallet);
  });

  it('Token-2022 transfer fee: only what the vault receives is added', async () => {
    const ata = ataAddress(s1.publicKey, F.publicKey);
    await initPool(SPF, F.publicKey);
    await tx(s1, safetyDepositIx(SPF, s1.publicKey, F.publicKey, ata, 100n * TOK));
    expect((await cfgOf(SPF, F.publicKey)).assets).toBe(99n * TOK);
    // more than the pool holds: refused
    await expectCode(tx(s1, safetyTopUpIx(SPF, s1.publicKey, F.publicKey, ata, 100n * TOK)), SAFETY_ERROR.TopUpTooLarge);
    await tx(s1, safetyTopUpIx(SPF, s1.publicKey, F.publicKey, ata, 50n * TOK));
    const c = await cfgOf(SPF, F.publicKey);
    expect(c.assets).toBe(99n * TOK + 49_500_000n); // 1% withheld on each transfer
    expect(await tokenBalance(connection, safetyVaultPda(SPF, F.publicKey))).toBe(99n * TOK + 49_500_000n);
  });

  it('survives a generation bump: refused while the retired pool has no shares, then pays only the new generation', async () => {
    // the E pool was emptied by a slash above (generation 1, no shares); s3's generation-0 position is retired
    const c0 = await cfgOf(SPF, E.publicKey);
    expect(c0.generation).toBe(1n);
    expect(c0.totalShares).toBe(0n);
    const aS = await fund(stranger.publicKey, E.publicKey, 500n * TOK);
    await expectCode(tx(stranger, safetyTopUpIx(SPF, stranger.publicKey, E.publicKey, aS, 500n * TOK)), SAFETY_ERROR.NoShares);
    const a2 = await fund(s2.publicKey, E.publicKey, 1_000n * TOK);
    await tx(s2, safetyDepositIx(SPF, s2.publicKey, E.publicKey, a2, 1_000n * TOK));
    await tx(stranger, safetyTopUpIx(SPF, stranger.publicKey, E.publicKey, aS, 500n * TOK));
    const p2 = await readSafetyPosition(connection, SPF, E.publicKey, s2.publicKey);
    expect(p2.config.generation).toBe(1n);
    expect(p2.config.assets).toBe(1_500n * TOK);
    expect(p2.shares).toBe(p2.config.totalShares);
    expect(1_500n * TOK - p2.value).toBeLessThan(TOK); // the only live staker gets the top-up (but for the virtual stake's sliver)
    const p3 = await readSafetyPosition(connection, SPF, E.publicKey, s3.publicKey);
    expect(p3.shares).toBe(0n);
    expect(p3.value).toBe(0n);
  });
});
