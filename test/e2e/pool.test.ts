// End to end on an in-process EVM with real Groth16 proofs: deposit, batch
// grant to three agents under three policies, policy-bound payments (public
// and shielded), refusals, window roll-over, allow-lists, owner reclaim,
// double-spend rejection and selective disclosure.
import { beforeAll, describe, expect, it } from 'vitest';
import { BrowserProvider, Contract, ContractFactory, JsonRpcSigner } from 'ethers';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Account, Wallet, connectLending, deployLending, deployPool, solProof, verifyDisclosure, verifyStream,
  type OwnedAllowance, type SpendMemos, type StreamArgs, type TreasuryNode,
} from '../../src/client.js';
import { LenderWallet, type LenderNote } from '../../src/lender.js';
import { allowanceMemo, randomViewingKey, toHex, type LenderPayload } from '../../src/encryption.js';
import { initCrypto, addressToField, lenderKey, lenderShare, shareOf, type Allowance, type Note } from '../../src/crypto.js';
import type { ProofResult } from '../../src/prover.js';

const U = 1_000_000n; // 6 decimals
const DAY = 86400;
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const artifactOf = (path: string) => JSON.parse(readFileSync(resolve(import.meta.dirname, '../../build/artifacts/contracts', path), 'utf8'));

/** A lender whose claim writes no successor memo for the borrower (malicious, or just buggy). */
class SilentLender extends LenderWallet {
  protected override claimMemos(next: Allowance, note: LenderNote): SpendMemos {
    return { ...super.claimMemos(next, note), encryptedAllowance: '0x' };
  }
}

/** A borrower whose spends withhold every copy of the successor meant for the lender (the LenderMemo and the one packed into the commitment memo). */
class SilentBorrower extends Wallet {
  protected override spendMemos(next: Allowance, payNote: Note, owned: OwnedAllowance, to: string | { pk: bigint; viewPub: Uint8Array }): SpendMemos {
    return { ...super.spendMemos(next, payNote, owned, to), encryptedAllowance: toHex(allowanceMemo(next, owned.views)), encryptedLender: '0x' };
  }
}

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
let s1: Wallet; // sub-agent of a1 (hierarchical delegation)
let b: Wallet;  // borrower agent (Phase 1)
let evm: { send(method: string, params?: unknown[]): Promise<unknown> };

async function increaseTime(seconds: number) {
  await evm.send('evm_increaseTime', [seconds]);
  await evm.send('evm_mine', []);
}

/** The one live (unspent, non-empty) allowance a wallet holds as agent in `inAsset`, or that an owner granted to `pk`. */
const current = (w: Wallet, pk?: bigint, inAsset = asset): OwnedAllowance => {
  const list = (pk === undefined ? w.agentAllowances(inAsset) : w.grantedAllowances().filter((a) => a.allowance.agentPk === pk)).filter((a) => a.allowance.remaining > 0n);
  if (list.length !== 1) throw new Error(`expected one live allowance, got ${list.length}`);
  return list[0];
};

const poolEvents = (receipt: { logs: Array<{ address: string; topics: ReadonlyArray<string>; data: string }> }) =>
  receipt.logs.filter((l) => l.address === pool.target).map((l) => pool.interface.parseLog(l)!);

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

describe('lending registry', () => {
  let lending: Contract;
  const ZERO = '0x0000000000000000000000000000000000000000';
  const noProof = () => solProof({ a: [0n, 0n], b: [[0n, 0n], [0n, 0n]], c: [0n, 0n] });

  it('deploys StreamLoan bound to the pool, with no owner and sequential slots', async () => {
    const addr = await deployLending(deployer, pool);
    lending = connectLending(addr, otherSigner);
    expect(await lending.pool()).toBe(await pool.getAddress());
    expect(await lending.GRACE()).toBe(7n * 86400n);
    expect(lending.interface.getFunction('owner')).toBeNull();
    const tx = await lending.openSlot();
    const rc = await tx.wait();
    const opened = rc.logs.map((l: { topics: string[]; data: string }) => lending.interface.parseLog(l)).find((p: { name: string } | null) => p?.name === 'SlotOpened');
    expect(opened.args.loanRef).toBe(1n);
    expect(opened.args.lender).toBe(await otherSigner.getAddress());
    expect((await lending.slots(1n)).toString()).toBe(await otherSigner.getAddress());
    expect(await lending.shortfall(1n)).toBe(0n);
  });

  it('rejects a stream proof against an unknown root and a slot the caller does not own', async () => {
    const args = {
      root: 1n, minRemaining: 0n, minRate: 0n, lenderAddr: await lending.getAddress(), loanRef: 1n, pledgeBps: 1n, expiry: 0n, lifetimeCap: 0n, pledgePaid: 0n,
      agentPk: 0n, audience: 0n, streamStart: 0n, asset: await token.getAddress(),
    };
    expect(await pool.verifyStream(noProof(), args)).toBe(false);
    await expect(lending.fund(1n, noProof(), args, await token.getAddress(), 1n, await otherSigner.getAddress())).rejects.toThrow(/invalid stream proof/);
    await expect((lending.connect(vendorSigner) as Contract).fund(1n, noProof(), args, await token.getAddress(), 1n, await otherSigner.getAddress())).rejects.toThrow(/not the lender/);
    await expect(lending.settle(1n)).rejects.toThrow(/no loan/);
    await expect(lending.onPledge(await token.getAddress(), 1n, 1n)).rejects.toThrow(/not the pool/);
  });

  it('an unpledged spend routes nothing to a lender', async () => {
    const vendor = await vendorSigner.getAddress();
    const w = new Wallet(Account.random(), pool.connect(relayerSigner) as Contract);
    await owner.grant(asset, [{ to: w.account.address, amount: 10n * U }]);
    await w.sync();
    const res = await w.pay(current(w), 1n * U, vendor);
    const parsed = res.receipt.logs.filter((l) => l.address === pool.target).map((l) => pool.interface.parseLog(l)!);
    expect(parsed.some((p) => p.name === 'PledgeRouted' || p.name === 'LenderMemo')).toBe(false);
    expect(res.next.pledgePaid).toBe(0n);
    const tx = await provider.getTransaction(res.receipt.hash);
    const [, args] = pool.interface.decodeFunctionData(pool.interface.getFunction('spend')!, tx!.data).toArray(true) as unknown[][];
    // SpendArgs positions 10..13: lenderAmount, lenderAddr, loanRef, isLenderClaim
    expect(args.slice(10, 14)).toEqual([0n, ZERO, 0n, false]);
  });

  it('a claim from a non-lender has no proof, and a forged one is refused by the pool', async () => {
    const args = {
      root: 1n, nullifier: 1n, newAllowanceCommitment: 1n, payCommitment: 0n, publicAmount: 0n, publicRecipient: ZERO, publicAsset: await token.getAddress(),
      fee: 0n, timestamp: BigInt((await provider.getBlock('latest'))!.timestamp), receipt: 0n, lenderAmount: 1n, lenderAddr: await lending.getAddress(), loanRef: 1n, isLenderClaim: true, extDataHash: 0n,
    };
    const ext = { relayer: ZERO, encryptedAllowance: '0x', encryptedPayment: '0x', encryptedLender: '0x' };
    await expect((lending.connect(vendorSigner) as Contract).claim(1n, noProof(), args, ext)).rejects.toThrow(/not the lender/);
    await expect(lending.claim(1n, noProof(), args, ext)).rejects.toThrow(/unknown root/);
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

describe('stream-backed lending (Phase 1)', () => {
  const BPS = 4000n;
  const principal = 300n * U;
  let lenderSigner: JsonRpcSigner;
  let lendingAddr: string;
  let lending: Contract;
  let lender: LenderWallet;
  let loanRef: bigint;
  let expiry: bigint;
  let streamStart: bigint;
  let payload: LenderPayload;
  let stream: { proof: ProofResult; args: StreamArgs };
  let publicSpendHash: string;
  let claimHash: string;
  const lenderBalance = async () => token.balanceOf(await lenderSigner.getAddress()) as Promise<bigint>;
  const terms = (ref: bigint) => ({ lenderAddr: lendingAddr, loanRef: ref, pledgeBps: BPS, lenderViewPub: lender.view.pub });

  it('lender opens a slot; the owner grants a streamed allowance pledged to it; the agent sees the pledge', async () => {
    lenderSigner = await provider.getSigner(4);
    lendingAddr = await deployLending(deployer, pool);
    lending = connectLending(lendingAddr, lenderSigner);
    lender = new LenderWallet(randomViewingKey(), pool.connect(lenderSigner) as Contract, lending);
    loanRef = await lender.openSlot();
    expect(loanRef).toBe(1n);

    b = new Wallet(Account.random(), pool.connect(relayerSigner) as Contract);
    const now = BigInt((await provider.getBlock('latest'))!.timestamp);
    expiry = now + BigInt(DAY);
    // only the owner creates a pledge (design 4): the allowance is granted pre-pledged
    const res = await owner.grant(asset, [{ to: b.account.address, amount: 1_000n * U, streamRate: 1n * U, windowCap: 500n * U, expiry, pledge: terms(loanRef) }]);
    expect(res.lenderPayloads[0]).toBeDefined();
    payload = res.lenderPayloads[0]!;
    const a = res.allowances[0];
    streamStart = a.policy.streamStart;
    expect(streamStart).toBeGreaterThanOrEqual(now);
    expect(a.remaining).toBe(1_000n * U);
    expect(a.policy.lifetimeCap).toBe(1_000n * U);
    expect(a.policy.pledgeBps).toBe(BPS);
    expect(a.policy.lender).toBe(lenderKey(addressToField(lendingAddr), loanRef));
    expect(a.policy.windowCap).toBe(500n * U);
    expect(a.policy.streamRate).toBe(1n * U);
    expect(a.policy.expiry).toBe(expiry);
    expect(a.pledgePaid).toBe(0n);
    // the chain saw the grant's commitments and nothing about the amount or the terms
    const parsed = poolEvents(res.receipt);
    expect(parsed.filter((p) => p.name === 'NewCommitment')).toHaveLength(17);
    expect(JSON.stringify(parsed.map((p) => p.args.map(String)))).not.toContain((1_000n * U).toString());
    // the agent learns the pledge and its lender from the grant memo
    await b.sync();
    expect(current(b).lender?.loanRef).toBe(loanRef);
    expect(current(b).allowance.policy.pledgeBps).toBe(BPS);
    // an agent cannot pledge (nor re-pledge) an allowance; the owner cannot re-pledge one
    await expect(b.pledge(current(b), terms(2n))).rejects.toThrow(/only the owner/);
    await owner.sync();
    const asOwner = current(owner, b.account.keys.pk);
    expect(asOwner.lender?.loanRef).toBe(loanRef);
    await expect(owner.pledge(asOwner, terms(2n))).rejects.toThrow(/immutable/);
  });

  it('the lender ingests the note, verifies a stream proof on-chain and funds the loan', async () => {
    const tokenAddr = await token.getAddress();
    const audience = addressToField(await lenderSigner.getAddress());
    stream = await b.proveStream(current(b), { minRemaining: 1_000n * U, minRate: 1n * U, audience });
    expect(stream.args.lenderAddr.toLowerCase()).toBe(lendingAddr.toLowerCase());
    expect(stream.args.loanRef).toBe(loanRef);
    expect(stream.args.pledgeBps).toBe(BPS);
    expect(stream.args.expiry).toBe(expiry);
    expect(stream.args.lifetimeCap).toBe(1_000n * U);
    expect(stream.args.pledgePaid).toBe(0n);
    expect(stream.args.streamStart).toBe(streamStart);
    expect(stream.args.asset.toLowerCase()).toBe(tokenAddr.toLowerCase());
    expect(await verifyStream(pool, stream.proof, stream.args)).toBe(true);
    expect(await verifyStream(pool, stream.proof, { ...stream.args, audience: 1n })).toBe(false);
    expect(await verifyStream(pool, stream.proof, { ...stream.args, minRemaining: 1_001n * U })).toBe(false);
    expect(await verifyStream(pool, stream.proof, { ...stream.args, streamStart: streamStart - 1n })).toBe(false);
    expect(await verifyStream(pool, stream.proof, { ...stream.args, asset: lendingAddr })).toBe(false);
    await expect(b.proveStream(current(b), { minRemaining: 1_001n * U, minRate: 0n, audience })).rejects.toThrow();

    const lenderEoa = await lenderSigner.getAddress();
    await (await token.mint(lenderEoa, 1_000n * U)).wait();
    await (await (token.connect(lenderSigner) as Contract).approve(lendingAddr, principal)).wait();
    const payout = await otherSigner.getAddress();
    const before = await token.balanceOf(payout);
    // the SDK funds only against a note it was handed, whose fields the proof restates exactly: a lender
    // that cannot read the note (another viewing key) refuses, however valid the proof
    const stranger = new LenderWallet(randomViewingKey(), pool.connect(lenderSigner) as Contract, lending);
    await expect(stranger.fund(loanRef, stream, tokenAddr, principal, payout)).rejects.toThrow(/does not match a live note/);
    expect(stranger.current(loanRef)).toHaveLength(0);
    expect(lender.current(loanRef)).toHaveLength(0);
    lender.ingest(payload);
    await lender.sync();
    const [note] = lender.current(loanRef);
    expect(note.allowance.remaining).toBe(1_000n * U);
    expect(note.index).toBe(current(b).index);
    await expect(lender.fund(loanRef, { proof: stream.proof, args: { ...stream.args, pledgeBps: 5000n } }, tokenAddr, principal, payout)).rejects.toThrow(/does not match a live note/);
    await expect(lender.fund(loanRef, stream, lendingAddr, principal, payout)).rejects.toThrow(/another asset/);
    // and the registry itself checks the proof, the asset and the start
    await expect(lending.fund(loanRef, solProof(stream.proof.proof), { ...stream.args, pledgeBps: 5000n }, tokenAddr, principal, payout)).rejects.toThrow(/invalid stream proof/);
    await expect(lending.fund(loanRef, solProof(stream.proof.proof), stream.args, lendingAddr, principal, payout)).rejects.toThrow(/proof names another asset/);
    await lender.fund(loanRef, stream, tokenAddr, principal, payout);
    expect(await token.balanceOf(payout)).toBe(before + principal);
    const loan = await lender.loan(loanRef);
    expect(loan.principal).toBe(principal);
    expect(loan.repaid).toBe(0n);
    expect(loan.pledgeBps).toBe(BPS);
    expect(loan.expiry).toBe(expiry);
    expect(loan.agentPk).toBe(b.account.keys.pk);
    expect(loan.streamStart).toBe(streamStart);
    await expect(lender.fund(loanRef, stream, tokenAddr, principal, payout)).rejects.toThrow(/already funded/);
  });

  it('a stream that has not started yet cannot be funded: the proof discloses the start date', async () => {
    const slot = await lender.openSlot();
    const f = new Wallet(Account.random(), pool.connect(relayerSigner) as Contract);
    const now = BigInt((await provider.getBlock('latest'))!.timestamp);
    const res = await owner.grant(asset, [{ to: f.account.address, amount: 100n * U, streamRate: 1n * U, streamStart: now + BigInt(DAY), pledge: terms(slot) }]);
    await f.sync();
    lender.ingest(res.lenderPayloads[0]!);
    const future = await f.proveStream(current(f), { minRemaining: 100n * U, minRate: 1n * U, audience: 1n });
    expect(future.args.streamStart).toBe(now + BigInt(DAY));
    expect(await verifyStream(pool, future.proof, future.args)).toBe(true);
    await expect(lender.fund(slot, future, await token.getAddress(), 10n * U, await otherSigner.getAddress())).rejects.toThrow(/stream not started/);
  });

  it('every spend routes the pledged share to the lender, public or shielded', async () => {
    await increaseTime(250);
    const vendor = await vendorSigner.getAddress();
    const vendorBefore = await token.balanceOf(vendor);
    const lenderBefore = await lenderBalance();
    const res = await b.pay(current(b), 100n * U, vendor);
    publicSpendHash = res.receipt.hash;
    expect(await token.balanceOf(vendor)).toBe(vendorBefore + 60n * U);
    expect(await lenderBalance()).toBe(lenderBefore + 40n * U);
    expect(res.next.remaining).toBe(900n * U);
    expect(res.next.pledgePaid).toBe(40n * U);
    const parsed = poolEvents(res.receipt);
    const routed = parsed.find((p) => p.name === 'PledgeRouted')!;
    expect(routed.args.lenderAddr).toBe(lendingAddr);
    expect(routed.args.loanRef).toBe(loanRef);
    expect(routed.args.amount).toBe(40n * U);
    expect(parsed.some((p) => p.name === 'LenderMemo')).toBe(true);
    // the registry forwarded the share to the lender and counted it as repayment
    expect((await lender.loan(loanRef)).repaid).toBe(40n * U);
    const drips = res.receipt.logs.filter((l) => l.address === lendingAddr).map((l) => lending.interface.parseLog(l)!);
    expect(drips.map((p) => p.name)).toEqual(['DripRouted']);

    // shielded payment: the recipient gets the net, the lender its share, nothing else is public
    const a2Before = a2.balance(asset);
    const sh = await b.pay(current(b), 50n * U, a2.account.address);
    expect(await lenderBalance()).toBe(lenderBefore + 60n * U);
    expect(sh.next.pledgePaid).toBe(60n * U);
    expect(poolEvents(sh.receipt).some((p) => p.name === 'PublicPayout')).toBe(false);
    await a2.sync();
    expect(a2.balance(asset)).toBe(a2Before + 30n * U);
    expect(current(b).allowance.pledgePaid).toBe(60n * U);
  });

  it('a skipped or shorted share, a re-pointed lender or loan ref, and a replay are all refused', async () => {
    const tx = await provider.getTransaction(publicSpendHash);
    const [proof, args, ext] = pool.interface.decodeFunctionData(pool.interface.getFunction('spend')!, tx!.data).toArray(true) as unknown[][];
    const via = pool.connect(relayerSigner) as Contract;
    // SpendArgs positions: 4 publicAmount, 10 lenderAmount, 11 lenderAddr, 12 loanRef
    const tamper = (i: number, v: unknown) => args.map((x, j) => (j === i ? v : x));
    await expect(via.spend(proof, tamper(10, 0n), ext)).rejects.toThrow(/invalid proof/);
    await expect(via.spend(proof, tamper(10, 39n * U), ext)).rejects.toThrow(/invalid proof/);
    await expect(via.spend(proof, tamper(11, await otherSigner.getAddress()), ext)).rejects.toThrow(/invalid proof/);
    await expect(via.spend(proof, tamper(12, 2n), ext)).rejects.toThrow(/invalid proof/);
    await expect(via.spend(proof, args, ext)).rejects.toThrow(/already spent/);
  });

  it('the lender claims the vested share; the agent continues from the successor the lender wrote', async () => {
    await lender.sync();
    const [note] = lender.current(loanRef);
    expect(note.allowance.pledgePaid).toBe(60n * U); // learned from the LenderMemo events
    expect(note.allowance.remaining).toBe(850n * U);
    await increaseTime(100);
    const now = BigInt((await provider.getBlock('latest'))!.timestamp);
    // from first principles: the pledged share of what has vested at 1 U/s, less the 60 U already routed
    const owedAt = (t: bigint) => shareOf(min(1_000n * U, 1n * U * (t - streamStart)), BPS) - 60n * U;
    const claimable = lender.claimable(loanRef, now);
    expect(claimable).toBe(owedAt(now));
    expect(claimable).toBeGreaterThan(0n);
    // more than the vested share has no proof
    await expect(lender.claim(loanRef, claimable + 10n * U)).rejects.toThrow();

    const vendor = await vendorSigner.getAddress();
    const before = await lenderBalance();
    const res = await lender.claim(loanRef);
    claimHash = res.receipt.hash;
    // the claim was built against the block before the one it landed in
    const builtAt = BigInt((await provider.getBlock(res.receipt.blockNumber - 1))!.timestamp);
    expect(res.amount).toBe(owedAt(builtAt));
    expect(res.amount).toBeGreaterThan(0n);
    expect(await lenderBalance()).toBe(before + res.amount);
    expect(res.next.pledgePaid).toBe(60n * U + res.amount);
    expect(res.next.remaining).toBe(850n * U - res.amount);
    expect(res.next.windowId).toBe(note.allowance.windowId); // a claim leaves the window state alone
    expect(res.next.windowSpent).toBe(note.allowance.windowSpent);
    expect((await lender.loan(loanRef)).repaid).toBe(60n * U + res.amount);
    const parsed = poolEvents(res.receipt);
    expect(parsed.some((p) => p.name === 'PublicPayout')).toBe(false);
    expect(parsed.filter((p) => p.name === 'NewCommitment')).toHaveLength(1); // only the successor, no payout note
    expect(lender.current(loanRef)[0].allowance.pledgePaid).toBe(60n * U + res.amount);
    // the agent learns its new note from the lender's memo and keeps spending from it
    await b.sync();
    const live = current(b);
    expect(live.allowance.remaining).toBe(850n * U - res.amount);
    expect(live.allowance.pledgePaid).toBe(60n * U + res.amount);
    expect(live.lender?.loanRef).toBe(loanRef);
    const pay = await b.pay(live, 10n * U, vendor);
    expect(pay.next.pledgePaid).toBe(64n * U + res.amount);
    expect(await lenderBalance()).toBe(before + res.amount + 4n * U);
  });

  it('a claim whose memo for the borrower is blank: the agent and the owner rebuild the successor from the chain', async () => {
    const silent = new SilentLender(lender.view, pool.connect(lenderSigner) as Contract, lending);
    await silent.sync(); // the live note comes from the LenderMemo events
    expect(silent.current(loanRef)).toHaveLength(1);
    await increaseTime(60);
    const before = current(b).allowance;
    const res = await silent.claim(loanRef, 1n * U);
    const inserted = poolEvents(res.receipt).filter((p) => p.name === 'NewCommitment');
    expect(inserted).toHaveLength(1);
    expect(inserted[0].args[2]).toBe('0x'); // nothing for the agent to decrypt
    // the successor is fixed by public calldata: remaining - lenderAmount, pledgePaid + lenderAmount, window kept
    await b.sync();
    const live = current(b);
    expect(live.commitment).toBe(inserted[0].args[0]);
    expect(live.allowance.remaining).toBe(before.remaining - 1n * U);
    expect(live.allowance.pledgePaid).toBe(before.pledgePaid + 1n * U);
    expect(live.allowance.windowId).toBe(before.windowId);
    expect(live.allowance.windowSpent).toBe(before.windowSpent);
    expect(live.lender?.loanRef).toBe(loanRef);
    await owner.sync();
    expect(current(owner, b.account.keys.pk).commitment).toBe(live.commitment);
    // and the agent keeps paying from the recovered note
    const vendor = await vendorSigner.getAddress();
    const pay = await b.pay(live, 5n * U, vendor);
    expect(pay.next.pledgePaid).toBe(live.allowance.pledgePaid + 2n * U);
    await lender.sync();
    expect(lender.current(loanRef)[0].allowance.remaining).toBe(pay.next.remaining);
  });

  it('a claim is accepted only from the slot owner through the registry', async () => {
    const tx = await provider.getTransaction(claimHash);
    const [, proof, args, ext] = lending.interface.decodeFunctionData(lending.interface.getFunction('claim')!, tx!.data).toArray(true) as unknown[][];
    // the proof is valid but the pool requires msg.sender == lenderAddr, which is the registry
    await expect((pool.connect(relayerSigner) as Contract).spend(proof, args, ext)).rejects.toThrow(/lender/);
    await expect((pool.connect(lenderSigner) as Contract).spend(proof, args, ext)).rejects.toThrow(/lender/);
    // the registry requires the slot owner
    await expect((lending.connect(vendorSigner) as Contract).claim(loanRef, proof, args, ext)).rejects.toThrow(/not the lender/);
    // and the owner replaying its own claim is a double spend
    await expect(lending.claim(loanRef, proof, args, ext)).rejects.toThrow(/already spent/);
  });

  it('a transfer that would shrink what the lender is owed is refused', async () => {
    // the claim advanced the lender beyond the share of what was spent, so no residual could carry pledgePaid
    const c = new Wallet(Account.random(), pool.connect(relayerSigner) as Contract);
    await expect(b.transferAllowance(current(b), c.account.address)).rejects.toThrow(/lender/);
  });

  it('a spend that withholds the lender memo leaves the loan opaque to the lender; the share and the shortfall path remain', async () => {
    const vendor = await vendorSigner.getAddress();
    const sb = new SilentBorrower(b.account, pool.connect(relayerSigner) as Contract);
    await sb.sync();
    const lenderBefore = await lenderBalance();
    const res = await sb.pay(current(sb), 1n * U, vendor);
    const parsed = poolEvents(res.receipt);
    expect(parsed.some((p) => p.name === 'LenderMemo')).toBe(false);
    expect(parsed.some((p) => p.name === 'PledgeRouted')).toBe(true); // the circuit still routed the share
    expect(await lenderBalance()).toBe(lenderBefore + shareOf(1n * U, BPS));
    await lender.sync();
    expect(lender.current(loanRef)).toHaveLength(0);
    expect(lender.opaque(loanRef)).toBe(true);
    const now = BigInt((await provider.getBlock('latest'))!.timestamp);
    expect(lender.claimable(loanRef, now)).toBe(0n);
    await expect(lender.claim(loanRef)).rejects.toThrow(/withheld the successor memo/);
    // the borrower itself, and the owner, still hold the live note
    await b.sync();
    expect(current(b).allowance.remaining).toBe(res.next.remaining);
    await owner.sync();
    expect(current(owner, b.account.keys.pk).allowance.remaining).toBe(res.next.remaining);
  });

  it('after expiry the shortfall is reported; the owner reclaim routes the share and repays it; the lender settles', async () => {
    expect(await lender.shortfall(loanRef)).toBe(0n);
    await increaseTime(8 * DAY + 1); // past expiry + GRACE
    const loan = await lender.loan(loanRef);
    expect(loan.repaid).toBeLessThan(principal);
    expect(await lender.shortfall(loanRef)).toBe(principal - loan.repaid);
    // the agent is expired; the owner is not, but the lender's share is still routed
    const vendor = await vendorSigner.getAddress();
    await expect(b.pay(current(b), 1n * U, vendor)).rejects.toThrow();
    await owner.sync();
    const target = current(owner, b.account.keys.pk);
    const share = lenderShare(target.allowance, target.allowance.remaining);
    expect(share).toBeGreaterThan(0n);
    const lenderBefore = await lenderBalance();
    const ownerBefore = owner.balance(asset);
    const res = await owner.reclaim(target);
    expect(await lenderBalance()).toBe(lenderBefore + share);
    expect(owner.balance(asset)).toBe(ownerBefore + target.allowance.remaining - share);
    expect(res.next.remaining).toBe(0n);
    // over the note's life the lender received exactly floor(lifetimeCap * bps / 10000)
    expect(res.next.pledgePaid).toBe(shareOf(1_000n * U, BPS));
    expect((await lender.loan(loanRef)).repaid).toBe(shareOf(1_000n * U, BPS));
    expect(await lender.shortfall(loanRef)).toBe(0n);
    await lender.sync();
    expect(lender.claimable(loanRef, BigInt((await provider.getBlock('latest'))!.timestamp))).toBe(0n);
    await expect((lending.connect(vendorSigner) as Contract).settle(loanRef)).rejects.toThrow(/not the lender/);
    const rc = await lender.settle(loanRef);
    expect(rc.logs.map((l) => lending.interface.parseLog(l)?.name)).toContain('LoanSettled');
    expect((await lender.loan(loanRef)).settled).toBe(true);
  });
});

describe('owner-made pledges and the lender leg', () => {
  const lenderView = randomViewingKey();
  let lenderEoa: string; // a plain-address lender, no sink
  const eoaTerms = (loanRef: bigint, pledgeBps = 5000n) => ({ lenderAddr: lenderEoa, loanRef, pledgeBps, lenderViewPub: lenderView.pub });

  it('the owner pledges an existing allowance by reclaiming it and granting it again to the same agent', async () => {
    lenderEoa = await otherSigner.getAddress();
    const vendor = await vendorSigner.getAddress();
    const p1 = new Wallet(Account.random(), pool.connect(relayerSigner) as Contract);
    await owner.grant(asset, [{ to: p1.account.address, amount: 50n * U, maxPerTx: 20n * U, windowCap: 40n * U }]);
    await p1.sync();
    await p1.pay(current(p1), 10n * U, vendor);
    await owner.sync();
    const before = current(owner, p1.account.keys.pk);
    expect(before.allowance.remaining).toBe(40n * U);
    const res = await owner.pledge(before, eoaTerms(11n, 2500n));
    expect(res.allowance.agentPk).toBe(p1.account.keys.pk);
    expect(res.allowance.remaining).toBe(40n * U);
    expect(res.allowance.policy.lifetimeCap).toBe(40n * U);
    expect(res.allowance.policy.maxPerTx).toBe(20n * U);
    expect(res.allowance.policy.windowCap).toBe(40n * U);
    expect(res.allowance.policy.pledgeBps).toBe(2500n);
    expect(res.allowance.policy.lender).toBe(lenderKey(addressToField(lenderEoa), 11n));
    expect(res.payload.length).toBeGreaterThan(0);
    expect(res.lender.loanRef).toBe(11n);
    await p1.sync();
    const live = current(p1);
    expect(live.commitment).toBe(res.owned.commitment);
    expect(live.lender?.loanRef).toBe(11n);
    // the regranted note routes its share; the agent still cannot pledge anything
    const lb = await token.balanceOf(lenderEoa);
    const pay = await p1.pay(live, 20n * U, vendor);
    expect(await token.balanceOf(lenderEoa)).toBe(lb + 5n * U);
    expect(pay.next.pledgePaid).toBe(5n * U);
    await expect(p1.pledge(current(p1), eoaTerms(12n))).rejects.toThrow(/only the owner/);
  });

  it('a 100% pledge: the public leg is empty and no payout note is written', async () => {
    const vendor = await vendorSigner.getAddress();
    const q = new Wallet(Account.random(), pool.connect(relayerSigner) as Contract);
    await owner.grant(asset, [{ to: q.account.address, amount: 10n * U, pledge: eoaTerms(12n, 10000n) }]);
    await q.sync();
    const lb = await token.balanceOf(lenderEoa);
    const vb = await token.balanceOf(vendor);
    const res = await q.pay(current(q), 4n * U, vendor);
    const parsed = poolEvents(res.receipt);
    expect(parsed.filter((p) => p.name === 'NewCommitment')).toHaveLength(1); // the successor only
    expect(parsed.some((p) => p.name === 'PublicPayout')).toBe(false);
    expect(parsed.find((p) => p.name === 'PledgeRouted')!.args.amount).toBe(4n * U);
    expect(await token.balanceOf(lenderEoa)).toBe(lb + 4n * U);
    expect(await token.balanceOf(vendor)).toBe(vb);
    expect(res.next.remaining).toBe(6n * U);
    expect(res.next.pledgePaid).toBe(4n * U);
  });

  it('a greedy lender contract cannot make a pledged spend cost the block', async () => {
    const greedy = artifactOf('test/GreedySink.sol/GreedySink.json');
    const sink = (await new ContractFactory(greedy.abi, greedy.bytecode, deployer).deploy()) as unknown as Contract;
    await sink.waitForDeployment();
    const sinkAddr = await sink.getAddress();
    const g = new Wallet(Account.random(), pool.connect(relayerSigner) as Contract);
    await owner.grant(asset, [{ to: g.account.address, amount: 10n * U, pledge: { lenderAddr: sinkAddr, loanRef: 1n, pledgeBps: 5000n, lenderViewPub: lenderView.pub } }]);
    await g.sync();
    const res = await g.pay(current(g), 2n * U, await vendorSigner.getAddress());
    expect(res.receipt.gasUsed).toBeLessThan(2_500_000n);
    expect(await sink.calls()).toBe(0n); // the sink ran out of its 300k and was ignored
    expect(await token.balanceOf(sinkAddr)).toBe(1n * U);
    expect(poolEvents(res.receipt).some((p) => p.name === 'PledgeRouted')).toBe(true);
  });

  describe('a lender the token refuses', () => {
    let btoken: Contract;
    let btokenAddr: string;
    let asset2: bigint;
    let registryAddr: string;
    let lender2Signer: JsonRpcSigner;
    let lender2: LenderWallet;
    let slot: bigint;

    it('the pool escrows the share, the owner can still reclaim, and anyone releases the share later', async () => {
      const erc = artifactOf('test/BlockingERC20.sol/BlockingERC20.json');
      btoken = (await new ContractFactory(erc.abi, erc.bytecode, deployer).deploy()) as unknown as Contract;
      await btoken.waitForDeployment();
      btokenAddr = await btoken.getAddress();
      asset2 = addressToField(btokenAddr);
      await (await btoken.mint(await deployer.getAddress(), 1_000n * U)).wait();
      await (await btoken.approve(await pool.getAddress(), 1_000n * U)).wait();
      await owner.deposit(asset2, 1_000n * U);
      const vendor = await vendorSigner.getAddress();
      const e1 = new Wallet(Account.random(), pool.connect(relayerSigner) as Contract);
      await owner.grant(asset2, [{ to: e1.account.address, amount: 100n * U, pledge: eoaTerms(21n) }]);
      await e1.sync();
      await (await btoken.setBlocked(lenderEoa, true)).wait();
      const lb = await btoken.balanceOf(lenderEoa);
      const res = await e1.pay(current(e1, undefined, asset2), 20n * U, vendor);
      expect(await btoken.balanceOf(vendor)).toBe(10n * U);
      expect(await btoken.balanceOf(lenderEoa)).toBe(lb);
      const parsed = poolEvents(res.receipt);
      expect(parsed.find((p) => p.name === 'PledgeEscrowed')!.args.amount).toBe(10n * U);
      expect(parsed.find((p) => p.name === 'PledgeRouted')!.args.amount).toBe(10n * U);
      expect(await pool.owed(btokenAddr, lenderEoa, 21n)).toBe(10n * U);
      // the owner's reclaim goes through while the lender is still refused
      await owner.sync();
      const ownerBefore = owner.balance(asset2);
      const reclaim = await owner.reclaim(current(owner, e1.account.keys.pk));
      expect(reclaim.next.remaining).toBe(0n);
      expect(owner.balance(asset2)).toBe(ownerBefore + 40n * U);
      expect(await pool.owed(btokenAddr, lenderEoa, 21n)).toBe(50n * U);
      // eth_call here: the in-process node keeps a failed gas estimate for identical calldata even after the state changes
      await expect(pool.pullLenderShare.staticCall(btokenAddr, lenderEoa, 21n)).rejects.toThrow(/blocked/);
      await (await btoken.setBlocked(lenderEoa, false)).wait();
      const rc = await (await (pool.connect(vendorSigner) as Contract).pullLenderShare(btokenAddr, lenderEoa, 21n)).wait();
      expect(poolEvents(rc).find((p) => p.name === 'LenderShareReleased')!.args.amount).toBe(50n * U);
      expect(await btoken.balanceOf(lenderEoa)).toBe(lb + 50n * U);
      expect(await pool.owed(btokenAddr, lenderEoa, 21n)).toBe(0n);
      await expect(pool.pullLenderShare(btokenAddr, lenderEoa, 21n)).rejects.toThrow(/nothing owed/);
    });

    it('the registry credits the repayment, keeps what it cannot forward, and the slot lender collects it', async () => {
      lender2Signer = await provider.getSigner(5);
      registryAddr = await deployLending(deployer, pool);
      const registry = connectLending(registryAddr, lender2Signer);
      lender2 = new LenderWallet(randomViewingKey(), pool.connect(lender2Signer) as Contract, registry);
      slot = await lender2.openSlot();
      const lender2Eoa = await lender2Signer.getAddress();
      const vendor = await vendorSigner.getAddress();
      const e2 = new Wallet(Account.random(), pool.connect(relayerSigner) as Contract);
      const res = await owner.grant(asset2, [{ to: e2.account.address, amount: 100n * U, streamRate: 1n * U, pledge: { lenderAddr: registryAddr, loanRef: slot, pledgeBps: 5000n, lenderViewPub: lender2.view.pub } }]);
      await e2.sync();
      lender2.ingest(res.lenderPayloads[0]!);
      const stream = await e2.proveStream(current(e2, undefined, asset2), { minRemaining: 100n * U, minRate: 1n * U, audience: 2n });
      await (await btoken.mint(lender2Eoa, 100n * U)).wait();
      await (await (btoken.connect(lender2Signer) as Contract).approve(registryAddr, 10n * U)).wait();
      await lender2.fund(slot, stream, btokenAddr, 10n * U, lender2Eoa);
      await (await btoken.setBlocked(lender2Eoa, true)).wait();
      await increaseTime(60);
      const lb = await btoken.balanceOf(lender2Eoa);
      const pay = await e2.pay(current(e2, undefined, asset2), 20n * U, vendor);
      const drips = pay.receipt.logs.filter((l) => l.address === registryAddr).map((l) => registry.interface.parseLog(l)!);
      expect(drips.map((p) => p.name)).toEqual(['DripEscrowed']);
      expect(await registry.owed(slot, btokenAddr)).toBe(10n * U);
      expect((await lender2.loan(slot)).repaid).toBe(10n * U); // the borrower did pay
      expect(await btoken.balanceOf(lender2Eoa)).toBe(lb);
      await expect(registry.collect.staticCall(slot, btokenAddr)).rejects.toThrow(/blocked/);
      await (await btoken.setBlocked(lender2Eoa, false)).wait();
      await expect((registry.connect(vendorSigner) as Contract).collect(slot, btokenAddr)).rejects.toThrow(/not the lender/);
      await lender2.collect(slot, btokenAddr);
      expect(await btoken.balanceOf(lender2Eoa)).toBe(lb + 10n * U);
      expect(await registry.owed(slot, btokenAddr)).toBe(0n);
      await expect(lender2.collect(slot, btokenAddr)).rejects.toThrow(/nothing owed/);
    });

    it('a share pledged to a slot nobody opened yet waits for whoever opens it', async () => {
      const next = slot + 1n;
      const vendor = await vendorSigner.getAddress();
      const e3 = new Wallet(Account.random(), pool.connect(relayerSigner) as Contract);
      await owner.grant(asset2, [{ to: e3.account.address, amount: 100n * U, pledge: { lenderAddr: registryAddr, loanRef: next, pledgeBps: 5000n, lenderViewPub: lender2.view.pub } }]);
      await e3.sync();
      const pay = await e3.pay(current(e3, undefined, asset2), 20n * U, vendor);
      const registry = connectLending(registryAddr, lender2Signer);
      const drips = pay.receipt.logs.filter((l) => l.address === registryAddr).map((l) => registry.interface.parseLog(l)!);
      expect(drips.map((p) => p.name)).toEqual(['DripEscrowed']);
      expect(await registry.owed(next, btokenAddr)).toBe(10n * U);
      expect(await lender2.openSlot()).toBe(next);
      const lb = await btoken.balanceOf(await lender2Signer.getAddress());
      await lender2.collect(next, btokenAddr);
      expect(await btoken.balanceOf(await lender2Signer.getAddress())).toBe(lb + 10n * U);
    });
  });
});

describe('bearer notes and treasury tree (Phase 3)', () => {
  let x: Wallet;
  let y: Wallet;

  it('an agent hands its allowance to another agent; the policy travels with it', async () => {
    x = new Wallet(Account.random(), pool.connect(relayerSigner) as Contract);
    y = new Wallet(Account.random(), pool.connect(relayerSigner) as Contract);
    await owner.grant(asset, [{ to: x.account.address, amount: 100n * U, maxPerTx: 30n * U, windowCap: 80n * U }]);
    await x.sync();
    const res = await x.transferAllowance(current(x), y.account.address);
    expect(res.allowance.agentPk).toBe(y.account.keys.pk);
    expect(res.allowance.remaining).toBe(100n * U);
    expect(res.allowance.policy.maxPerTx).toBe(30n * U);
    expect(res.allowance.policy.windowCap).toBe(80n * U - 3n);
    expect(res.allowance.policy.ownerPk).toBe(owner.account.keys.pk);
    expect(res.allowance.policy.pledgeBps).toBe(0n);
    await y.sync();
    expect(current(y).allowance.remaining).toBe(100n * U);
    expect(x.agentAllowances(asset).every((a) => a.allowance.remaining === 0n)).toBe(true);
    expect(() => current(x)).toThrow();
    const vendor = await vendorSigner.getAddress();
    const before = await token.balanceOf(vendor);
    await y.pay(current(y), 30n * U, vendor);
    expect(await token.balanceOf(vendor)).toBe(before + 30n * U);
    await expect(y.pay(current(y), 31n * U, vendor)).rejects.toThrow(); // the per-tx cap travelled
    // the owner still sees and can reclaim the bearer note
    await owner.sync();
    expect(current(owner, y.account.keys.pk).allowance.remaining).toBe(70n * U);
  });

  it('the owner sees its treasury as a tree of lines and the lines delegated from them', async () => {
    await owner.sync();
    const tree = owner.treasuryTree();
    const byAgent = (nodes: TreasuryNode[], pk: bigint) => nodes.filter((n) => n.granted.agentPk === pk);
    // a1 delegated a sub-allowance to s1, which the owner later reclaimed
    const [a1Node] = byAgent(tree, a1.account.keys.pk);
    expect(a1Node.allowance.remaining).toBe(400n * U);
    expect(a1Node.children.map((c) => c.granted.agentPk)).toEqual([s1.account.keys.pk]);
    expect(a1Node.children[0].granted.remaining).toBe(100n * U);
    expect(a1Node.children[0].allowance.remaining).toBe(0n);
    // x handed its note to y
    const [xNode] = byAgent(tree, x.account.keys.pk);
    expect(xNode.allowance.remaining).toBe(0n);
    expect(xNode.children.map((c) => c.granted.agentPk)).toEqual([y.account.keys.pk]);
    expect(xNode.children[0].allowance.remaining).toBe(70n * U);
    // b's line was granted pledged and fully reclaimed; the lender received exactly its lifetime share
    const [bNode] = byAgent(tree, b.account.keys.pk);
    expect(bNode.granted.policy.pledgeBps).toBe(4000n);
    expect(bNode.children).toHaveLength(0);
    expect(bNode.allowance.remaining).toBe(0n);
    expect(bNode.allowance.pledgePaid).toBe(400n * U);
    // every grant is a root (3 + 1 + 1 + 16 + 2 lending + 2 regrant + 1 + 1 + 3 escrow + 1) and every delegated line is nested exactly once
    const count = (ns: TreasuryNode[]): number => ns.reduce((s, n) => s + 1 + count(n.children), 0);
    expect(tree).toHaveLength(31);
    expect(count(tree)).toBe(33);
  });
});
