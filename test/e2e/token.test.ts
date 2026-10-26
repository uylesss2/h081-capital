// Phase 2 end to end on an in-process EVM: the H081 token, capacity staking
// with its cooldown and capacity views, and the safety pool insuring two real
// stream-backed loans (granted, proved and funded through the pool with real
// Groth16 proofs). The shortfall that gets slashed is the registry's own:
// the allowances expire, GRACE passes, nothing was repaid.
import { beforeAll, describe, expect, it } from 'vitest';
import { BrowserProvider, Contract, ContractFactory, JsonRpcSigner } from 'ethers';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Account, Wallet, connectLending, deployLending, deployPool, type OwnedAllowance } from '../../src/client.js';
import { LenderWallet } from '../../src/lender.js';
import { randomViewingKey } from '../../src/encryption.js';
import { addressToField, initCrypto } from '../../src/crypto.js';
import {
  CAPACITY_COOLDOWN, DESK_UNIT, SAFETY_COOLDOWN, SHIELD_PER_UNIT, SHIELD_UNIT, connectCapacityStake, connectSafetyPool, connectToken,
  deployCapacityStake, deploySafetyPool, deployToken, deskCapacity, shieldCap,
} from '../../src/token.js';

const U = 1_000_000n; // tUSD, 6 decimals
const E18 = 10n ** 18n; // H081, 18 decimals
const SUPPLY = 1_000_000_000n * E18;
const GRACE = 7n * 86400n; // StreamLoan.GRACE
const artifactOf = (path: string) => JSON.parse(readFileSync(resolve(import.meta.dirname, '../../build/artifacts/contracts', path), 'utf8'));

let provider: BrowserProvider;
let deployer: JsonRpcSigner;
let relayerSigner: JsonRpcSigner;
let otherSigner: JsonRpcSigner;
let lenderSigner: JsonRpcSigner;
let stakerA: JsonRpcSigner;
let stakerB: JsonRpcSigner;
let pool: Contract;
let usd: Contract;
let asset: bigint;
let owner: Wallet;
let b1: Wallet;
let b2: Wallet;
let lendingAddr: string;
let lending: Contract;
let lender: LenderWallet;
let h081: Contract;
let stake: Contract;
let safety: Contract;

const addr = (s: JsonRpcSigner) => s.getAddress();
const as = (c: Contract, s: JsonRpcSigner) => c.connect(s) as Contract;
const h081Of = async (s: JsonRpcSigner) => h081.balanceOf(await addr(s)) as Promise<bigint>;

/** The one live allowance `w` holds as agent in `asset`. */
const current = (w: Wallet): OwnedAllowance => {
  const list = w.agentAllowances(asset).filter((a) => a.allowance.remaining > 0n);
  if (list.length !== 1) throw new Error(`expected one live allowance, got ${list.length}`);
  return list[0];
};

beforeAll(async () => {
  await initCrypto();
  const hre = (await import('hardhat')).default as unknown as { network: { provider: unknown } };
  // ethers shares identical RPC requests made within 250 ms; an in-process EVM is faster than that, so the cache is off
  provider = new BrowserProvider(hre.network.provider as never, undefined, { cacheTimeout: -1 });
  [deployer, relayerSigner, otherSigner, lenderSigner, stakerA, stakerB] = await Promise.all([0, 1, 3, 4, 5, 6].map((i) => provider.getSigner(i)));

  ({ pool } = await deployPool(deployer));
  const erc = artifactOf('test/TestERC20.sol/TestERC20.json');
  usd = (await new ContractFactory(erc.abi, erc.bytecode, deployer).deploy()) as unknown as Contract;
  await usd.waitForDeployment();
  asset = addressToField(await usd.getAddress());
  await (await usd.mint(await addr(deployer), 10_000n * U)).wait();
  await (await usd.approve(await pool.getAddress(), 10_000n * U)).wait();
  owner = new Wallet(Account.random(), pool.connect(deployer) as Contract);
  await owner.deposit(asset, 5_000n * U);
  b1 = new Wallet(Account.random(), pool.connect(relayerSigner) as Contract);
  b2 = new Wallet(Account.random(), pool.connect(relayerSigner) as Contract);

  lendingAddr = await deployLending(deployer, pool);
  lending = connectLending(lendingAddr, lenderSigner);
  lender = new LenderWallet(randomViewingKey(), pool.connect(lenderSigner) as Contract, lending);

  h081 = await deployToken(deployer, SUPPLY);
  stake = await deployCapacityStake(deployer, h081);
  safety = await deploySafetyPool(deployer, h081, lendingAddr);
  for (const [s, amount] of [[stakerA, 1_000n * E18], [stakerB, 1_000n * E18], [lenderSigner, 100n * E18]] as const) {
    await (await h081.transfer(await addr(s), amount)).wait();
  }
});

describe('StipendToken', () => {
  it('is H0.81 Capital (H081), 18 decimals, the whole supply minted once to the deployer', async () => {
    expect(await h081.name()).toBe('H0.81 Capital');
    expect(await h081.symbol()).toBe('H081');
    expect(await h081.decimals()).toBe(18n);
    expect(await h081.totalSupply()).toBe(SUPPLY);
    expect(await h081Of(deployer)).toBe(SUPPLY - 2_100n * E18);
    const t = connectToken(await h081.getAddress(), provider);
    expect(await t.totalSupply()).toBe(SUPPLY);
  });

  it('has no mint, owner, pause or upgrade on any Phase 2 contract', () => {
    for (const c of [h081, stake, safety]) {
      for (const f of ['mint', 'owner', 'pause', 'unpause', 'upgradeTo', 'upgradeToAndCall', 'transferOwnership']) {
        expect(c.interface.hasFunction(f)).toBe(false);
      }
    }
  });

  it('refuses an empty supply', async () => {
    await expect(deployToken(deployer, 0n)).rejects.toThrow(/supply/);
  });
});

describe('CapacityStake', () => {
  it('stake buys desks and a shielding cap on the published curve', async () => {
    const a = await addr(stakerA);
    await (await as(h081, stakerA).approve(await stake.getAddress(), 1_000n * E18)).wait();
    await expect(as(stake, stakerA).stake(0n)).rejects.toThrow(/amount/);
    await (await as(stake, stakerA).stake(250n * E18)).wait();
    expect(await stake.staked(a)).toBe(250n * E18);
    expect(await stake.deskCapacity(a)).toBe(2n);
    expect(await stake.shieldCap(a)).toBe(20_000n * U);
    expect(await stake.DESK_UNIT()).toBe(DESK_UNIT);
    expect(await stake.SHIELD_UNIT()).toBe(SHIELD_UNIT);
    expect(await stake.SHIELD_PER_UNIT()).toBe(SHIELD_PER_UNIT);
    expect(await stake.COOLDOWN()).toBe(CAPACITY_COOLDOWN);
    // the SDK's pure curve agrees with the chain
    expect(deskCapacity(250n * E18)).toBe(2n);
    expect(shieldCap(250n * E18)).toBe(20_000n * U);
    expect(deskCapacity(99n * E18)).toBe(0n);
    // another account has no capacity
    expect(await stake.deskCapacity(await addr(stakerB))).toBe(0n);
    expect(await stake.shieldCap(await addr(stakerB))).toBe(0n);
  });

  it('an unstake request drops capacity at once; the tokens leave after the 7-day cooldown', async () => {
    const a = await addr(stakerA);
    const s = as(stake, stakerA);
    await expect(s.requestUnstake(251n * E18)).rejects.toThrow(/more than staked/);
    await expect(s.unstake()).rejects.toThrow(/nothing pending/);
    const requested = await (await s.requestUnstake(100n * E18)).wait();
    const requestedAt = BigInt((await provider.getBlock(requested.blockNumber))!.timestamp);
    expect(await stake.staked(a)).toBe(150n * E18);
    expect(await stake.deskCapacity(a)).toBe(1n);
    expect(await stake.shieldCap(a)).toBe(10_000n * U);
    const [pendingAmount, readyAt] = await stake.pending(a);
    expect(pendingAmount).toBe(100n * E18);
    expect(readyAt).toBe(requestedAt + CAPACITY_COOLDOWN);
    await expect(s.unstake()).rejects.toThrow(/cooldown/);
    await time.increaseTo(readyAt - 60n); // a minute short: the next block lands before readyAt
    await expect(s.unstake()).rejects.toThrow(/cooldown/);
    await time.increaseTo(readyAt);
    const before = await h081Of(stakerA);
    await (await s.unstake()).wait();
    expect(await h081Of(stakerA)).toBe(before + 100n * E18);
    expect((await stake.pending(a))[0]).toBe(0n);
    expect(await stake.staked(a)).toBe(150n * E18);
    await expect(s.unstake()).rejects.toThrow(/nothing pending/);
    const viaConnector = connectCapacityStake(await stake.getAddress(), provider);
    expect(await viaConnector.deskCapacity(a)).toBe(1n);
  });
});

describe('SafetyPool', () => {
  const BPS = 4000n;
  const principal1 = 300n * U;
  const principal2 = 250n * U;
  let expiry: bigint;
  let ref1: bigint;
  let ref2: bigint;
  let unfunded: bigint;
  let readyB: bigint; // when staker B's unbonding shares may leave

  it('the lender funds two stream-backed loans that will go unpaid', async () => {
    ref1 = await lender.openSlot();
    ref2 = await lender.openSlot();
    unfunded = await lender.openSlot();
    expiry = BigInt(await time.latest()) + 10n * 86400n;
    const terms = (ref: bigint) => ({ lenderAddr: lendingAddr, loanRef: ref, pledgeBps: BPS, lenderViewPub: lender.view.pub });
    const res = await owner.grant(asset, [
      { to: b1.account.address, amount: 1_000n * U, streamRate: 1n * U, expiry, pledge: terms(ref1) },
      { to: b2.account.address, amount: 500n * U, streamRate: 1n * U, expiry, pledge: terms(ref2) },
    ]);
    await Promise.all([b1.sync(), b2.sync()]);
    lender.ingest(res.lenderPayloads[0]!);
    lender.ingest(res.lenderPayloads[1]!);
    await lender.sync();
    const audience = addressToField(await addr(lenderSigner));
    const s1 = await b1.proveStream(current(b1), { minRemaining: 1_000n * U, minRate: 1n * U, audience });
    const s2 = await b2.proveStream(current(b2), { minRemaining: 500n * U, minRate: 1n * U, audience });
    const usdAddr = await usd.getAddress();
    const lenderEoa = await addr(lenderSigner);
    await (await usd.mint(lenderEoa, 1_000n * U)).wait();
    await (await as(usd, lenderSigner).approve(lendingAddr, principal1 + principal2)).wait();
    const payout = await addr(otherSigner);
    await lender.fund(ref1, s1, usdAddr, principal1, payout);
    await lender.fund(ref2, s2, usdAddr, principal2, payout);
    expect((await lender.loan(ref1)).repaid).toBe(0n);
    expect((await lender.loan(ref2)).principal).toBe(principal2);
    expect(await lender.shortfall(ref1)).toBe(0n);
  });

  it('stakers deposit; shares follow the pool', async () => {
    const safetyAddr = await safety.getAddress();
    await (await as(h081, stakerA).approve(safetyAddr, 1_000n * E18)).wait();
    await (await as(h081, stakerB).approve(safetyAddr, 1_000n * E18)).wait();
    await expect(as(safety, stakerA).deposit(0n)).rejects.toThrow(/amount/);
    // sized to the loans: v1 values a shortfall 1:1 in base units, so 400e6 H081 base units back a 400 tUSD shortfall
    await (await as(safety, stakerA).deposit(400n * U)).wait();
    await (await as(safety, stakerB).deposit(100n * U)).wait();
    expect(await safety.poolBalance()).toBe(500n * U);
    expect(await safety.totalShares()).toBe(500n * U);
    expect(await safety.sharesOf(await addr(stakerA))).toBe(400n * U);
    expect(await safety.sharesOf(await addr(stakerB))).toBe(100n * U);
    expect(await safety.redeemable(100n * U)).toBe(100n * U);
    expect(await safety.COOLDOWN()).toBe(SAFETY_COOLDOWN);
    expect(await safety.generation()).toBe(0n);
  });

  it('only the slot lender insures a funded, unexpired loan; the premium joins the pool', async () => {
    const safetyAddr = await safety.getAddress();
    await (await as(h081, lenderSigner).approve(safetyAddr, 100n * E18)).wait();
    await expect(as(safety, otherSigner).insure(ref1, 0n)).rejects.toThrow(/not the lender/);
    await expect(as(safety, lenderSigner).insure(unfunded, 0n)).rejects.toThrow(/no loan/);
    await expect(as(safety, lenderSigner).insure(99n, 0n)).rejects.toThrow(/not the lender/);
    await (await as(safety, lenderSigner).insure(ref1, 10n * U)).wait();
    await (await as(safety, lenderSigner).insure(ref2, 5n * U)).wait();
    await expect(as(safety, lenderSigner).insure(ref1, 1n)).rejects.toThrow(/already insured/);
    expect(await safety.poolBalance()).toBe(515n * U);
    expect(await safety.totalShares()).toBe(500n * U);
    // premiums accrue to the stakers: 400 of 500 shares are now worth 412
    expect(await safety.redeemable(400n * U)).toBe(412n * U);
    const cover = await safety.covers(ref1);
    expect(cover.lender).toBe(await addr(lenderSigner));
    expect(cover.premium).toBe(10n * U);
    expect(cover.paid).toBe(false);
    const viaConnector = connectSafetyPool(safetyAddr, provider);
    expect(await viaConnector.poolBalance()).toBe(515n * U);
  });

  it('slash fails while the registry reports no shortfall, and on a loan that is not insured', async () => {
    expect(await lender.shortfall(ref1)).toBe(0n);
    await expect(as(safety, otherSigner).slash(ref1)).rejects.toThrow(/no shortfall/);
    await expect(as(safety, otherSigner).slash(unfunded)).rejects.toThrow(/not insured/);
    // past expiry but inside GRACE: still no shortfall
    await time.increaseTo(expiry + 1n);
    expect(await lender.shortfall(ref1)).toBe(0n);
    await expect(as(safety, otherSigner).slash(ref1)).rejects.toThrow(/no shortfall/);
    // and an expired loan can no longer be insured
    await expect(as(safety, lenderSigner).insure(unfunded, 0n)).rejects.toThrow(/no loan/);
    expect(await safety.poolBalance()).toBe(515n * U);
  });

  it('unbonding takes 14 days and the shares stay at risk meanwhile', async () => {
    const a = as(safety, stakerA);
    const bb = as(safety, stakerB);
    await expect(a.requestUnbond(0n)).rejects.toThrow(/shares/);
    await expect(a.requestUnbond(401n * U)).rejects.toThrow(/more than held/);
    await expect(bb.withdraw()).rejects.toThrow(/nothing unbonding/);
    const requested = await (await bb.requestUnbond(100n * U)).wait();
    const requestedAt = BigInt((await provider.getBlock(requested.blockNumber))!.timestamp);
    await (await a.requestUnbond(50n * U)).wait();
    expect(await safety.sharesOf(await addr(stakerB))).toBe(0n);
    expect(await safety.sharesOf(await addr(stakerA))).toBe(350n * U);
    const [unb, readyAt] = await safety.unbondingOf(await addr(stakerB));
    expect(unb).toBe(100n * U);
    expect(readyAt).toBe(requestedAt + SAFETY_COOLDOWN);
    readyB = readyAt;
    expect(await safety.totalShares()).toBe(500n * U);
    await expect(bb.withdraw()).rejects.toThrow(/cooldown/);
  });

  it('once GRACE has passed with nothing repaid, anyone slashes and the lender is paid the shortfall', async () => {
    await time.increaseTo(expiry + GRACE + 1n);
    expect(await lender.shortfall(ref1)).toBe(principal1);
    expect(await lender.shortfall(ref2)).toBe(principal2);
    // B's cooldown (14 days, requested after expiry) ends later than GRACE: it leaves at today's price before any slash
    expect(readyB).toBeGreaterThan(expiry + GRACE + 1n);
    await expect(as(safety, stakerB).withdraw()).rejects.toThrow(/cooldown/);
    await time.increaseTo(readyB);
    const bBefore = await h081Of(stakerB);
    await (await as(safety, stakerB).withdraw()).wait();
    expect(await h081Of(stakerB)).toBe(bBefore + 103n * U); // 100 of 500 shares of 515
    expect(await safety.poolBalance()).toBe(412n * U);
    expect(await safety.totalShares()).toBe(400n * U);

    const lenderBefore = await h081Of(lenderSigner);
    const rc = await (await as(safety, otherSigner).slash(ref1)).wait();
    expect(await h081Of(lenderSigner)).toBe(lenderBefore + principal1);
    expect(await safety.poolBalance()).toBe(112n * U);
    const slashed = rc.logs.map((l: { topics: ReadonlyArray<string>; data: string }) => { try { return safety.interface.parseLog(l); } catch { return null; } }).find((p: { name: string } | null) => p?.name === 'Slashed');
    expect(slashed.args.shortfall).toBe(principal1);
    expect(slashed.args.paid).toBe(principal1);
    const cover = await safety.covers(ref1);
    expect(cover.paid).toBe(true);
    expect(cover.paidOut).toBe(principal1);
    await expect(as(safety, otherSigner).slash(ref1)).rejects.toThrow(/already paid/);
    // the stakers bore the loss pro rata: A's 350 at-risk shares of 400 are now worth 98
    expect(await safety.redeemable(350n * U)).toBe(98n * U);
    // the registry's shortfall is unchanged: the pool paid the lender, the borrower still owes
    expect(await lender.shortfall(ref1)).toBe(principal1);
    // a settled loan has no shortfall, so a cover for it can never be slashed
    await lender.settle(ref1);
    expect(await lender.shortfall(ref1)).toBe(0n);
  });

  it('a shortfall larger than the pool takes the whole pool, retires every share, and the next deposit starts fresh', async () => {
    const a = await addr(stakerA);
    const lenderBefore = await h081Of(lenderSigner);
    await (await as(safety, otherSigner).slash(ref2)).wait();
    expect(await h081Of(lenderSigner)).toBe(lenderBefore + 112n * U);
    expect(await safety.poolBalance()).toBe(0n);
    const cover = await safety.covers(ref2);
    expect(cover.paid).toBe(true);
    expect(cover.paidOut).toBe(112n * U);
    expect(await safety.generation()).toBe(1n);
    expect(await safety.totalShares()).toBe(0n);
    expect(await safety.sharesOf(a)).toBe(0n);
    expect((await safety.unbondingOf(a))[0]).toBe(0n);
    await expect(as(safety, stakerA).withdraw()).rejects.toThrow(/nothing unbonding/);
    await expect(as(safety, stakerA).requestUnbond(1n)).rejects.toThrow(/more than held/);
    // a fresh pool
    await (await as(safety, stakerA).deposit(100n * U)).wait();
    expect(await safety.sharesOf(a)).toBe(100n * U);
    expect(await safety.totalShares()).toBe(100n * U);
    expect(await safety.redeemable(100n * U)).toBe(100n * U);
    // nothing left to slash against an empty cover
    await expect(as(safety, otherSigner).slash(ref2)).rejects.toThrow(/already paid/);
  });
});
