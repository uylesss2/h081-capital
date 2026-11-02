// End to end on an in-process EVM with real Groth16 proofs: payments that need
// more than two input notes. The wallet merges notes pairwise with fully
// shielded 2-in-2-out transfers to itself, then pays with at most two inputs.
import { beforeAll, describe, expect, it } from 'vitest';
import { BrowserProvider, Contract, ContractFactory, JsonRpcSigner } from 'ethers';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Account, Wallet, deployPool } from '../../src/client.js';
import { addressToField, initCrypto } from '../../src/crypto.js';

const U = 1_000_000n;

let deployer: JsonRpcSigner;
let vendorSigner: JsonRpcSigner;
let relayerSigner: JsonRpcSigner;
let pool: Contract;
let token: Contract;
let asset: bigint;
let owner: Wallet;

const poolEvents = (receipt: { logs: Array<{ address: string; topics: ReadonlyArray<string>; data: string }> }) =>
  receipt.logs.filter((l) => l.address === pool.target).map((l) => pool.interface.parseLog(l)!);

beforeAll(async () => {
  await initCrypto();
  const hre = (await import('hardhat')).default as unknown as { network: { provider: unknown } };
  const provider = new BrowserProvider(hre.network.provider as never);
  [deployer, vendorSigner, relayerSigner] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  ({ pool } = await deployPool(deployer));
  const erc = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../build/artifacts/contracts/test/TestERC20.sol/TestERC20.json'), 'utf8'));
  token = (await new ContractFactory(erc.abi, erc.bytecode, deployer).deploy()) as unknown as Contract;
  await token.waitForDeployment();
  asset = addressToField(await token.getAddress());
  await (await token.mint(await deployer.getAddress(), 1_000n * U)).wait();
  await (await token.approve(await pool.getAddress(), 1_000n * U)).wait();
  owner = new Wallet(Account.random(), pool.connect(deployer) as Contract);
  // five separate deposits: five notes of 10
  for (let i = 0; i < 5; i++) await owner.deposit(asset, 10n * U);
});

describe('note consolidation', () => {
  it('a withdrawal that needs four notes merges twice, then withdraws with two inputs', async () => {
    expect(owner.unspentNotes(asset).map((n) => n.note.amount)).toEqual(Array(5).fill(10n * U));
    const vendor = await vendorSigner.getAddress();
    const relayer = await relayerSigner.getAddress();
    const before = await pool.nextIndex();
    await owner.withdraw(asset, 35n * U, vendor, { relayer, fee: 1n * U });
    expect(await token.balanceOf(vendor)).toBe(34n * U);
    expect(await token.balanceOf(relayer)).toBe(1n * U);
    expect(owner.balance(asset)).toBe(15n * U);
    // two merges and the withdrawal: three transactions of two commitments each
    expect(Number(await pool.nextIndex()) - Number(before)).toBe(6);
    expect(owner.unspentNotes(asset).map((n) => n.note.amount)).toEqual([10n * U, 5n * U]);
  });

  it('a merge is an ordinary fully shielded transfer: no amount, asset or address on chain', async () => {
    for (let i = 0; i < 2; i++) await owner.deposit(asset, 10n * U);
    // notes: 10, 10, 10, 5; consolidating all of it into one note takes three merges
    const merges = await owner.consolidate(asset, undefined, 1);
    expect(merges).toHaveLength(3);
    for (const m of merges) {
      const evs = poolEvents(m.receipt);
      expect(evs.map((e) => e.name).sort()).toEqual(['NewCommitment', 'NewCommitment', 'NewNullifier', 'NewNullifier']);
      expect(m.receipt.logs.some((l) => l.address === token.target)).toBe(false);
      const json = JSON.stringify(evs.map((e) => e.args.map(String)));
      expect(json).not.toContain((35n * U).toString());
      expect(json).not.toContain(String(asset));
    }
    expect(owner.unspentNotes(asset).map((n) => n.note.amount)).toEqual([35n * U]);
    expect(await owner.consolidate(asset)).toEqual([]);
  });

  it('a shielded transfer and a grant that need three notes consolidate first', async () => {
    const friend = new Wallet(Account.random(), pool.connect(deployer) as Contract);
    for (let i = 0; i < 3; i++) await owner.deposit(asset, 10n * U); // notes: 35, 10, 10, 10
    await owner.transfer(asset, 60n * U, friend.account.address); // 35 + 10 + 10 > 2 inputs
    await friend.sync();
    expect(friend.balance(asset)).toBe(60n * U);
    expect(owner.balance(asset)).toBe(5n * U);

    for (let i = 0; i < 2; i++) await friend.deposit(asset, 10n * U); // friend: 60, 10, 10
    const agent = Account.random();
    const res = await friend.grant(asset, [{ to: agent.address, amount: 75n * U }]);
    expect(res.total).toBe(75n * U);
    expect(friend.balance(asset)).toBe(5n * U);
  });

  it('a short balance is refused before any merge is sent', async () => {
    const before = await pool.nextIndex();
    await expect(owner.withdraw(asset, 1_000n * U, await vendorSigner.getAddress())).rejects.toThrow('insufficient shielded balance');
    expect(await pool.nextIndex()).toBe(before);
  });
});
