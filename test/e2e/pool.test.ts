// End to end on an in-process EVM with real Groth16 proofs: deposit, batch
// grant to three agents under three policies, policy-bound payments (public
// and shielded), refusals, window roll-over, allow-lists, owner reclaim,
// double-spend rejection and selective disclosure.
import { beforeAll, describe, expect, it } from 'vitest';
import { BrowserProvider, Contract, ContractFactory, JsonRpcSigner } from 'ethers';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Account, Wallet, deployPool, verifyDisclosure, type OwnedAllowance } from '../../src/client.js';
import { initCrypto, addressToField } from '../../src/crypto.js';

const U = 1_000_000n; // 6 decimals
const DAY = 86400;

let provider: BrowserProvider;
let deployer: JsonRpcSigner;
let relayerSigner: JsonRpcSigner;
let vendorSigner: JsonRpcSigner;
let otherSigner: JsonRpcSigner;
let pool: Contract;
let token: Contract;
let asset: bigint;
let owner: Wallet;
let a1: Wallet;
let a2: Wallet;
let a3: Wallet;
let evm: { send(method: string, params?: unknown[]): Promise<unknown> };

async function increaseTime(seconds: number) {
  await evm.send('evm_increaseTime', [seconds]);
  await evm.send('evm_mine', []);
}

const current = (w: Wallet, pk?: bigint): OwnedAllowance => {
  const list = pk === undefined ? w.agentAllowances(asset) : w.grantedAllowances().filter((a) => a.allowance.agentPk === pk);
  if (list.length !== 1) throw new Error(`expected one live allowance, got ${list.length}`);
  return list[0];
};

beforeAll(async () => {
  await initCrypto();
  const hre = (await import('hardhat')).default as unknown as { network: { provider: { request(a: { method: string; params?: unknown[] }): Promise<unknown>; send(m: string, p?: unknown[]): Promise<unknown> } } };
  evm = hre.network.provider;
  provider = new BrowserProvider(hre.network.provider as never);
  [deployer, relayerSigner, vendorSigner, otherSigner] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));

  ({ pool } = await deployPool(deployer));
  const erc = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../build/artifacts/contracts/test/TestERC20.sol/TestERC20.json'), 'utf8'));
  token = (await new ContractFactory(erc.abi, erc.bytecode, deployer).deploy()) as unknown as Contract;
  await token.waitForDeployment();
  asset = addressToField(await token.getAddress());
  await (await token.mint(await deployer.getAddress(), 10_000n * U)).wait();
  await (await token.approve(await pool.getAddress(), 10_000n * U)).wait();

  owner = new Wallet(Account.random(), pool.connect(deployer) as Contract);
  // Agents submit through the relayer's key so no agent address ever appears on chain.
  const viaRelayer = pool.connect(relayerSigner) as Contract;
  a1 = new Wallet(Account.random(), viaRelayer);
  a2 = new Wallet(Account.random(), viaRelayer);
  a3 = new Wallet(Account.random(), viaRelayer);
});

describe('treasury', () => {
  it('deposits with a relayer fee and sees a shielded balance', async () => {
    const relayer = await relayerSigner.getAddress();
    await owner.deposit(asset, 5_000n * U, { relayer, fee: 1n * U });
    expect(await token.balanceOf(await pool.getAddress())).toBe(4_999n * U);
    expect(await token.balanceOf(relayer)).toBe(1n * U);
    expect(owner.balance(asset)).toBe(4_999n * U);
  });
});

describe('distribution', () => {
  it('funds three agents under three policies in one transaction', async () => {
    const vendor = await vendorSigner.getAddress();
    const now = BigInt((await provider.getBlock('latest'))!.timestamp);
    const res = await owner.grant(asset, [
      { to: a1.account.address, amount: 1_000n * U, windowCap: 300n * U, maxPerTx: 250n * U },
      { to: a2.account.address, amount: 500n * U, recipients: [vendor] },
      { to: a3.account.address, amount: 200n * U, expiry: now + 3600n },
    ]);
    expect(res.total).toBe(1_700n * U);
    expect(owner.balance(asset)).toBe(3_299n * U);

    // the chain learned nine commitments and one opaque total, nothing else
    const logs = res.receipt.logs.filter((l) => l.address === pool.target);
    const parsed = logs.map((l) => pool.interface.parseLog(l)).filter(Boolean);
    expect(parsed.filter((p) => p!.name === 'NewCommitment')).toHaveLength(17); // 16 slots + change
    expect(parsed.filter((p) => p!.name === 'NewGrant')).toHaveLength(1);
    const json = JSON.stringify(parsed.map((p) => p!.args.map(String)));
    expect(json).not.toContain((1_000n * U).toString());
    expect(json).not.toContain((1_700n * U).toString());

    await Promise.all([a1.sync(), a2.sync(), a3.sync()]);
    expect(current(a1).allowance.remaining).toBe(1_000n * U);
    expect(current(a2).allowance.policy.recipientRoot).not.toBe(0n);
    expect(current(a3).allowance.policy.expiry).toBe(now + 3600n);
    expect(owner.grantedAllowances()).toHaveLength(3);
  });
});

describe('spending under policy', () => {
  it('agent pays a public recipient; payer stays hidden; fee goes to the relayer', async () => {
    const vendor = await vendorSigner.getAddress();
    const relayer = await relayerSigner.getAddress();
    const before = await token.balanceOf(vendor);
    const res = await a1.pay(current(a1), 200n * U, vendor, { relayer, fee: 2n * U });
    expect(await token.balanceOf(vendor)).toBe(before + 198n * U);
    expect(await token.balanceOf(relayer)).toBe(3n * U);
    expect(res.next.remaining).toBe(800n * U);
    expect(res.next.windowSpent).toBe(200n * U);
    // the transaction came from the relayer's account, not from anyone tied to the agent
    expect(res.receipt.from).toBe(relayer);
    expect(current(a1).allowance.remaining).toBe(800n * U);
  });

  it('has no proof over the per-transaction cap or the window cap', async () => {
    const vendor = await vendorSigner.getAddress();
    await expect(a1.pay(current(a1), 251n * U, vendor)).rejects.toThrow();
    await expect(a1.pay(current(a1), 101n * U, vendor)).rejects.toThrow(); // 200 + 101 > 300 this window
    expect(current(a1).allowance.remaining).toBe(800n * U); // nothing moved
  });

  it('window cap resets after the window rolls over', async () => {
    const vendor = await vendorSigner.getAddress();
    await increaseTime(DAY);
    const res = await a1.pay(current(a1), 250n * U, vendor);
    expect(res.next.windowSpent).toBe(250n * U);
    expect(res.next.remaining).toBe(550n * U);
  });

  it('allow-listed agent can pay the vendor and nobody else', async () => {
    const vendor = await vendorSigner.getAddress();
    const other = await otherSigner.getAddress();
    a2.rememberRecipients([vendor]);
    const res = await a2.pay(current(a2), 50n * U, vendor);
    expect(res.next.remaining).toBe(450n * U);
    await expect(a2.pay(current(a2), 50n * U, other)).rejects.toThrow();
  });

  it('shielded payment between agents reveals nothing and can be unshielded later', async () => {
    const res = await a1.pay(current(a1), 40n * U, a2.account.address); // window: 250 + 40 of 300
    const parsed = res.receipt.logs.filter((l) => l.address === pool.target).map((l) => pool.interface.parseLog(l)!);
    expect(parsed.map((p) => p.name).sort()).toEqual(['NewCommitment', 'NewCommitment', 'NewNullifier', 'NewReceipt']);
    expect(parsed.some((p) => p.name === 'PublicPayout')).toBe(false);

    await a2.sync();
    expect(a2.balance(asset)).toBe(40n * U);
    const other = await otherSigner.getAddress();
    const before = await token.balanceOf(other);
    await a2.withdraw(asset, 40n * U, other);
    expect(await token.balanceOf(other)).toBe(before + 40n * U);
    expect(a2.balance(asset)).toBe(0n);
  });

  it('expired allowance cannot be spent by the agent', async () => {
    const vendor = await vendorSigner.getAddress();
    await expect(a3.pay(current(a3), 1n * U, vendor)).rejects.toThrow(); // a day has passed, expiry was +1h
  });

  it('rejects a replayed spend as already spent', async () => {
    const vendor = await vendorSigner.getAddress();
    const spendTx = pool.interface.getFunction('spend')!;
    const res = await a1.pay(current(a1), 10n * U, vendor); // window: 300 of 300
    const tx = await provider.getTransaction(res.receipt.hash);
    const decoded = pool.interface.decodeFunctionData(spendTx, tx!.data);
    const [proof, args, ext] = decoded.toArray(true) as unknown[][];
    await expect((pool.connect(relayerSigner) as Contract).spend(proof, args, ext)).rejects.toThrow(/already spent/);
  });
});

describe('owner controls', () => {
  it('owner reclaims the expired agent allowance into the treasury', async () => {
    const before = owner.balance(asset);
    const target = current(owner, a3.account.keys.pk);
    expect(target.allowance.remaining).toBe(200n * U);
    await owner.reclaim(target);
    expect(owner.balance(asset)).toBe(before + 200n * U);
    await a3.sync();
    expect(a3.agentAllowances(asset).every((a) => a.allowance.remaining === 0n)).toBe(true);
  });
});

describe('selective disclosure', () => {
  it('agent proves bounds on its spending without revealing figures', async () => {
    const live = current(a1); // remaining 500, spent 500 lifetime, 300 this window
    expect(live.allowance.remaining).toBe(500n * U);
    const audience = 0xa0d170n;

    const ok = await a1.prove(live, 'remainingAtLeast', 400n * U, audience);
    expect(await verifyDisclosure(pool, ok.proof, ok.args)).toBe(true);
    expect(Object.values(ok.args).map(String)).not.toContain((500n * U).toString());

    const spent = await a1.prove(live, 'spentAtMost', 500n * U, audience);
    expect(await verifyDisclosure(pool, spent.proof, spent.args)).toBe(true);
    await expect(a1.prove(live, 'spentAtMost', 499n * U, audience)).rejects.toThrow();

    const window = await a1.prove(live, 'windowSpentAtMost', 300n * U, audience);
    expect(await verifyDisclosure(pool, window.proof, window.args)).toBe(true);

    await expect(a1.prove(live, 'remainingAtLeast', 501n * U, audience)).rejects.toThrow();
    // a proof for one audience does not verify for another
    expect(await verifyDisclosure(pool, ok.proof, { ...ok.args, audience: 1n })).toBe(false);
  });
});

describe('hierarchical delegation', () => {
  let s1: Wallet;
  it('an agent splits its allowance into a tighter sub-allowance without the owner', async () => {
    s1 = new Wallet(Account.random(), pool.connect(relayerSigner) as Contract);
    const parent = current(a1); // remaining 500, cap 300/day, max 250/tx
    const res = await a1.delegate(parent, [{ to: s1.account.address, amount: 100n * U, windowCap: 60n * U, maxPerTx: 50n * U }]);
    expect(res.residual.remaining).toBe(400n * U);
    expect(res.residual.policy.windowCap).toBe(300n * U - 60n * U - 3n); // three placeholder slots take one unit each
    expect(res.receipt.from).toBe(await relayerSigner.getAddress());

    await s1.sync();
    const sub = current(s1);
    expect(sub.allowance.remaining).toBe(100n * U);
    expect(sub.allowance.policy.maxPerTx).toBe(50n * U);
    expect(sub.allowance.policy.ownerPk).toBe(owner.account.keys.pk);
    expect(current(a1).allowance.remaining).toBe(400n * U);
  });

  it('the sub-agent spends under the sub-policy; the owner sees and can reclaim the sub-allowance', async () => {
    const vendor = await vendorSigner.getAddress();
    const before = await token.balanceOf(vendor);
    await s1.pay(current(s1), 50n * U, vendor);
    expect(await token.balanceOf(vendor)).toBe(before + 50n * U);
    await expect(s1.pay(current(s1), 51n * U, vendor)).rejects.toThrow(); // sub max per tx
    await expect(s1.pay(current(s1), 11n * U, vendor)).rejects.toThrow(); // 50 + 11 > 60 sub window cap

    await owner.sync();
    const subAsOwner = current(owner, s1.account.keys.pk);
    expect(subAsOwner.allowance.remaining).toBe(50n * U);
    const bal = owner.balance(asset);
    await owner.reclaim(subAsOwner);
    expect(owner.balance(asset)).toBe(bal + 50n * U);
  });
});

describe('streaming budgets', () => {
  let s: Wallet;
  it('releases budget at a rate per second', async () => {
    s = new Wallet(Account.random(), pool.connect(relayerSigner) as Contract);
    const vendor = await vendorSigner.getAddress();
    await owner.grant(asset, [{ to: s.account.address, amount: 600n * U, streamRate: 1n * U }]); // 1 USDG per second
    await s.sync();
    await expect(s.pay(current(s), 100n * U, vendor)).rejects.toThrow(); // only a few seconds have streamed
    await increaseTime(300);
    const res = await s.pay(current(s), 100n * U, vendor);
    expect(res.next.remaining).toBe(500n * U);
    await expect(s.pay(current(s), 250n * U, vendor)).rejects.toThrow(); // about 200 of the 300 streamed remain
    await increaseTime(60);
    await s.pay(current(s), 250n * U, vendor); // 360 streamed, 350 spent after this
  });
});

describe('sixteen agents per grant', () => {
  it('funds sixteen agents in one proof and each sees only its own slot', async () => {
    const fleet = Array.from({ length: 16 }, () => new Wallet(Account.random(), pool.connect(relayerSigner) as Contract));
    const res = await owner.grant(asset, fleet.map((w, i) => ({ to: w.account.address, amount: BigInt(10 + i) * U, maxPerTx: 5n * U })));
    expect(res.total).toBe(fleet.reduce((sum, _, i) => sum + BigInt(10 + i) * U, 0n));
    const parsed = res.receipt.logs.filter((l) => l.address === pool.target).map((l) => pool.interface.parseLog(l)!);
    expect(parsed.filter((p) => p.name === 'NewCommitment')).toHaveLength(17);
    await Promise.all(fleet.map((w) => w.sync()));
    fleet.forEach((w, i) => {
      expect(w.agentAllowances(asset)).toHaveLength(1);
      expect(w.agentAllowances(asset)[0].allowance.remaining).toBe(BigInt(10 + i) * U);
    });
  });
});
