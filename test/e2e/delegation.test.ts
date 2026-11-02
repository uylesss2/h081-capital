// End to end on an in-process EVM with real Groth16 proofs: delegating to more
// than four sub-agents, as a chain of delegate calls on the residual.
import { beforeAll, describe, expect, it } from 'vitest';
import { BrowserProvider, Contract, ContractFactory, JsonRpcSigner } from 'ethers';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Account, Wallet, deployPool, type OwnedAllowance } from '../../src/client.js';
import { addressToField, initCrypto } from '../../src/crypto.js';

const U = 1_000_000n;

let deployer: JsonRpcSigner;
let relayerSigner: JsonRpcSigner;
let vendorSigner: JsonRpcSigner;
let pool: Contract;
let token: Contract;
let asset: bigint;
let owner: Wallet;
let agent: Wallet;
let subs: Wallet[];

const live = (w: Wallet): OwnedAllowance => {
  const list = w.agentAllowances(asset).filter((a) => a.allowance.remaining > 0n);
  if (list.length !== 1) throw new Error(`expected one live allowance, got ${list.length}`);
  return list[0];
};

beforeAll(async () => {
  await initCrypto();
  const hre = (await import('hardhat')).default as unknown as { network: { provider: unknown } };
  const provider = new BrowserProvider(hre.network.provider as never);
  [deployer, relayerSigner, vendorSigner] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  ({ pool } = await deployPool(deployer));
  const erc = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../build/artifacts/contracts/test/TestERC20.sol/TestERC20.json'), 'utf8'));
  token = (await new ContractFactory(erc.abi, erc.bytecode, deployer).deploy()) as unknown as Contract;
  await token.waitForDeployment();
  asset = addressToField(await token.getAddress());
  await (await token.mint(await deployer.getAddress(), 2_000n * U)).wait();
  await (await token.approve(await pool.getAddress(), 2_000n * U)).wait();
  owner = new Wallet(Account.random(), pool.connect(deployer) as Contract);
  const viaRelayer = pool.connect(relayerSigner) as Contract;
  agent = new Wallet(Account.random(), viaRelayer);
  subs = Array.from({ length: 6 }, () => new Wallet(Account.random(), viaRelayer));
  await owner.deposit(asset, 2_000n * U);
  await owner.grant(asset, [{ to: agent.account.address, amount: 1_000n * U, windowCap: 900n * U, maxPerTx: 200n * U }]);
  await agent.sync();
});

describe('more than four subs per delegation', () => {
  it('six subs: two delegate steps, the second from the first step\'s residual', async () => {
    const before = await pool.nextIndex();
    const res = await agent.delegate(live(agent), subs.map((s) => ({ to: s.account.address, amount: 100n * U, windowCap: 100n * U, maxPerTx: 50n * U })));
    expect(res.steps).toHaveLength(2);
    expect(res.subs).toHaveLength(6);
    // each step writes four sub slots and a residual
    expect(Number(await pool.nextIndex()) - Number(before)).toBe(10);
    expect(res.residual.remaining).toBe(400n * U);
    // 900 - 6*100 - two placeholder slots of one base unit each
    expect(res.residual.policy.windowCap).toBe(300n * U - 2n);
    expect(res.residual.policy.lifetimeCap).toBe(400n * U);
    expect(live(agent).allowance.remaining).toBe(400n * U);
  });

  it('every sub sees its own allowance under the tighter policy and can spend under it', async () => {
    await Promise.all(subs.map((s) => s.sync()));
    for (const s of subs) {
      const a = live(s).allowance;
      expect(a.remaining).toBe(100n * U);
      expect(a.policy.windowCap).toBe(100n * U);
      expect(a.policy.maxPerTx).toBe(50n * U);
      expect(a.policy.ownerPk).toBe(owner.account.keys.pk);
    }
    const vendor = await vendorSigner.getAddress();
    await subs[5].pay(live(subs[5]), 50n * U, vendor);
    expect(await token.balanceOf(vendor)).toBe(50n * U);
    await expect(subs[5].pay(live(subs[5]), 51n * U, vendor)).rejects.toThrow();
  });

  it('the owner sees all six subs as children of the agent\'s line and can reclaim any of them', async () => {
    await owner.sync();
    const tree = owner.treasuryTree();
    expect(tree).toHaveLength(1);
    expect(tree[0].allowance.remaining).toBe(400n * U);
    expect(tree[0].children).toHaveLength(6);
    const target = owner.grantedAllowances().find((a) => a.allowance.agentPk === subs[0].account.keys.pk)!;
    const before = owner.balance(asset);
    await owner.reclaim(target);
    expect(owner.balance(asset)).toBe(before + 100n * U);
  });

  it('a chain that does not fit is refused before the first transaction', async () => {
    const before = await pool.nextIndex();
    const more = Array.from({ length: 5 }, () => ({ to: Account.random().address, amount: 50n * U, windowCap: 61n * U }));
    // window caps: 4*61 fits in 300, the fifth does not
    await expect(agent.delegate(live(agent), more)).rejects.toThrow('window caps exceed the parent');
    expect(await pool.nextIndex()).toBe(before);
  });
});
