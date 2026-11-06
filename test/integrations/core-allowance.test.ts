// H081Bank.allowanceGrant / allowanceDelegate / allowanceReclaim (h081_allowance_*) against a fake connection: a dry-run
// plan unless confirm: true, the operator ceiling H081_MAX_GRANT, the balance, a child that is never looser than its
// parent (each limit named before any proof), the SDK's own delegate input builder run first, framed address codes,
// missing proving artifacts refused before anything is sent, and balance listing what was granted, held and
// reclaimable. The wallet's grant / delegate / reclaim are mocked: nothing is proven or sent.
import { mkdtempSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Connection, Keypair } from '@solana/web3.js';
import type { StipendAddress } from '../../src/account.js';
import { type Allowance, type Policy, allowanceCommitment } from '../../src/crypto.js';
import type { SolOwnedAllowance, SolanaWallet } from '../../src/solana/wallet.js';
import { H081Bank } from '../../integrations/core/bank.js';
import { FlatDirProver } from '../../integrations/core/circuits.js';
import { encodeAddressCode } from '../../integrations/core/codes.js';
import { deriveAccountSk } from '../../integrations/core/keys.js';
import { runOp } from '../../integrations/core/operations.js';
import { USDG, fakeConnection, testConfig } from './helpers.js';

const NOW = 1_800_000_000n;
const DAY = 86_400n;
const USD = (x: number) => BigInt(Math.round(x * 1e6));

/** A circuits directory holding (empty) artifacts for `names`. */
function circuitsDir(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'h081-allowance-'));
  for (const n of names) for (const ext of ['wasm', 'zkey', 'vkey.json']) writeFileSync(join(dir, `${n}.${ext}`), '');
  return dir;
}
const ALL = circuitsDir(['grant', 'delegate', 'spend']);

async function open(opts: { maxGrant?: bigint; lamports?: number; circuits?: string; shielded?: bigint; signer?: Keypair; cacheDir?: string } = {}) {
  const signer = opts.signer ?? Keypair.generate();
  const conn = fakeConnection(signer, { now: NOW, lamports: opts.lamports });
  const bank = await H081Bank.open({
    config: testConfig({ maxGrant: opts.maxGrant }), signer, accountSk: deriveAccountSk(signer),
    connection: conn as unknown as Connection, prover: new FlatDirProver(opts.circuits ?? ALL), cacheDir: opts.cacheDir ?? null,
  });
  vi.spyOn(bank.owner, 'sync').mockResolvedValue(undefined);
  vi.spyOn(bank.owner, 'balance').mockReturnValue(opts.shielded ?? USD(100));
  for (let i = 0; i < 16; i++) vi.spyOn(bank.agent(i).wallet, 'sync').mockResolvedValue(undefined);
  return { bank, conn, signer };
}

let nextRho = 1n;
/** An allowance held by `agentPk` (default `wallet`'s key), owned by `ownerPk` (default someone else). */
function allowance(bank: H081Bank, wallet: SolanaWallet | null, over: Partial<Policy> & { remaining?: bigint; agentPk?: bigint } = {}): SolOwnedAllowance {
  const { remaining, agentPk, ...policy } = over;
  const P: Policy = {
    lifetimeCap: USD(100), windowCap: 0n, windowLen: DAY, maxPerTx: 0n, expiry: 0n, recipientRoot: 0n, ownerPk: 77n, streamRate: 0n, streamStart: 0n,
    lender: 0n, pledgeBps: 0n, ...policy,
  };
  const a: Allowance = {
    asset: bank.owner.registerMint(USDG), remaining: remaining ?? P.lifetimeCap, agentPk: agentPk ?? wallet!.account.keys.pk, policy: P,
    windowId: NOW / DAY, windowSpent: 0n, rho: (nextRho++) * 1_000_003n, pledgePaid: 0n,
  };
  return { allowance: a, commitment: allowanceCommitment(a), index: Number(nextRho), spent: false, views: { owner: new Uint8Array(32), agent: new Uint8Array(32) } };
}

const tx = (signature: string) => ({ signature, computeUnits: 1, logs: [] as string[] });

function stubGrant(bank: H081Bank) {
  return vi.spyOn(bank.owner, 'grant').mockImplementation(async (_mint, reqs) => {
    const r = reqs[0];
    const made: Allowance = {
      asset: bank.owner.registerMint(USDG), remaining: r.amount, agentPk: r.to.pk, windowId: 0n, windowSpent: 0n, rho: 42n, pledgePaid: 0n,
      policy: {
        lifetimeCap: r.amount, windowCap: r.windowCap ?? 0n, windowLen: r.windowLen ?? DAY, maxPerTx: r.maxPerTx ?? 0n, expiry: r.expiry ?? 0n, recipientRoot: 0n,
        ownerPk: bank.account.keys.pk, streamRate: r.streamRate ?? 0n, streamStart: r.streamStart ?? 0n, lender: 0n, pledgeBps: 0n,
      },
    };
    return { tx: tx('sigGrant'), proof: {} as never, allowances: [made], total: r.amount, totalSalt: 1n, lenderPayloads: [undefined] };
  });
}

function stubDelegate(wallet: SolanaWallet) {
  return vi.spyOn(wallet, 'delegate').mockImplementation(async (owned, subs) => {
    const s = subs[0];
    const P = owned.allowance.policy;
    const child: Allowance = {
      ...owned.allowance, remaining: s.amount, agentPk: s.to.pk, rho: 99n,
      policy: { ...P, lifetimeCap: s.amount, windowCap: s.windowCap ?? P.windowCap, maxPerTx: s.maxPerTx ?? P.maxPerTx, expiry: s.expiry ?? P.expiry, streamRate: s.streamRate ?? P.streamRate },
    };
    const residual: Allowance = { ...owned.allowance, remaining: owned.allowance.remaining - s.amount, rho: 100n };
    return { tx: tx('sigDelegate'), proof: {} as never, subs: [child], residual, steps: [{ tx: tx('sigDelegate'), proof: {} as never }] };
  });
}

describe('h081_allowance_grant', () => {
  it('returns the plan and sends nothing without confirm; with confirm grants exactly that to the first free sub-account', async () => {
    const { bank } = await open();
    const grant = stubGrant(bank);
    const plan = await runOp(bank, 'h081_allowance_grant', { usdg: '50', windowCapUsdg: '10', maxPerTxUsdg: '2', days: 30, unlockDays: 10 }) as Record<string, any>;
    expect(plan).toMatchObject({ sent: false, dryRun: true, next: expect.stringMatching(/^nothing was sent\. .*confirm: true/) });
    expect(plan.plan).toMatchObject({
      action: 'grant', to: 'sub-account 0', agentIndex: 0, shieldedAfter: USD(50), shieldedAfterUsdg: '50',
      rules: { amount: USD(50), windowCap: USD(10), windowCapUsdg: '10', windowLen: DAY, maxPerTx: USD(2), expiry: NOW + 30n * DAY, streamRate: (USD(50) + 10n * DAY - 1n) / (10n * DAY), streamStart: NOW, pledgeBps: 0n },
    });
    expect(plan.plan.rules.expiresAt).toBe(new Date(Number(NOW + 30n * DAY) * 1000).toISOString());
    expect(grant).not.toHaveBeenCalled();

    const r = await runOp(bank, 'h081_allowance_grant', { usdg: '50', windowCapUsdg: '10', maxPerTxUsdg: '2', days: 30, unlockDays: 10, confirm: true }) as Record<string, any>;
    expect(grant).toHaveBeenCalledTimes(1);
    const [mint, reqs] = grant.mock.calls[0];
    expect(mint.equals(USDG)).toBe(true);
    expect(reqs).toEqual([{ to: bank.agent(0).account.address, amount: USD(50), windowCap: USD(10), windowLen: DAY, maxPerTx: USD(2), expiry: NOW + 30n * DAY, streamRate: plan.plan.rules.streamRate, streamStart: NOW }]);
    expect(r).toMatchObject({ sent: true, signature: 'sigGrant', to: 'sub-account 0', agentIndex: 0, rules: { amount: USD(50) }, next: expect.stringMatching(/h081_pay \(agentIndex: 0\)/) });
    expect(r.allowanceId).toBe(allowanceCommitment((await grant.mock.results[0].value).allowances[0]));

    // an explicit sub-account, no limits: no window cap, no per-payment cap, no expiry, all at once
    await runOp(bank, 'h081_allowance_grant', { amount: '1000000', agentIndex: 5, confirm: true });
    expect(grant.mock.calls[1][1]).toEqual([{ to: bank.agent(5).account.address, amount: USD(1), windowCap: 0n, windowLen: DAY, maxPerTx: 0n, expiry: 0n, streamRate: 0n }]);
  });

  it('grants to another agent\'s framed "h081-address:" code; refuses its own address, a code for another network, and both recipients', async () => {
    const { bank } = await open();
    const other = await open();
    const grant = stubGrant(bank);
    const code = other.bank.shieldedAddressCode();
    const r = await runOp(bank, 'h081_allowance_grant', { usdg: '20', toAddressCode: code, confirm: true }) as Record<string, any>;
    expect(grant.mock.calls[0][1][0].to).toEqual(other.bank.account.address);
    expect(r).toMatchObject({ sent: true, to: 'another agent\'s shielded address', next: expect.stringMatching(/h081_allowance_reclaim/) });
    expect(r.agentIndex).toBeUndefined();

    await expect(runOp(bank, 'h081_allowance_grant', { usdg: '1', toAddressCode: bank.shieldedAddressCode(), confirm: true })).rejects.toThrow(/own shielded address.*Nothing was sent/);
    const devnet = encodeAddressCode({ ...bank.codeContext, cluster: 'devnet' }, other.bank.account.address);
    await expect(runOp(bank, 'h081_allowance_grant', { usdg: '1', toAddressCode: devnet })).rejects.toThrow(/another network, program or asset/);
    await expect(runOp(bank, 'h081_allowance_grant', { usdg: '1', toAddressCode: code.slice(0, -3) })).rejects.toThrow(/built-in check/);
    await expect(runOp(bank, 'h081_allowance_grant', { usdg: '1', toAddressCode: code, agentIndex: 1 })).rejects.toThrow(/not both/);
    expect(grant).toHaveBeenCalledTimes(1);
  });

  it('refuses before anything is sent: operator ceiling, balance, SOL, missing artifacts, bad days; a program error is explained', async () => {
    const capped = await open({ maxGrant: USD(25) });
    const g1 = stubGrant(capped.bank);
    await expect(runOp(capped.bank, 'h081_allowance_grant', { usdg: '26', confirm: true })).rejects.toThrow(/over the operator ceiling H081_MAX_GRANT \(25 USDG per allowance; asked 26 USDG\)\. Nothing was sent\./);
    await expect(runOp(capped.bank, 'h081_allowance_grant', { usdg: '26' })).rejects.toThrow(/H081_MAX_GRANT/); // a plan over the ceiling is refused too

    const poor = await open({ shielded: USD(5) });
    stubGrant(poor.bank);
    await expect(runOp(poor.bank, 'h081_allowance_grant', { usdg: '6' })).rejects.toThrow(/shielded balance is 5 USDG, less than the budget 6 USDG; deposit first.*Nothing was sent/);

    const noSol = await open({ lamports: 1_000_000 });
    const g2 = stubGrant(noSol.bank);
    expect(await runOp(noSol.bank, 'h081_allowance_grant', { usdg: '1' })).toMatchObject({ dryRun: true }); // planning needs no SOL
    await expect(runOp(noSol.bank, 'h081_allowance_grant', { usdg: '1', confirm: true })).rejects.toThrow(/0\.0010 SOL; a grant stages a large proof and needs about 0\.1 SOL.*Nothing was sent/);

    const noCircuits = await open({ circuits: circuitsDir([]) });
    const g3 = stubGrant(noCircuits.bank);
    await expect(runOp(noCircuits.bank, 'h081_allowance_grant', { usdg: '1', confirm: true })).rejects.toThrow(/the grant proving artifacts are not in .*fetch-circuits.*Nothing was sent/);

    const { bank } = await open();
    await expect(runOp(bank, 'h081_allowance_grant', { usdg: '1', days: 5, unlockDays: 6 })).rejects.toThrow(/unlockDays must not exceed days/);
    await expect(runOp(bank, 'h081_allowance_grant', { usdg: '1', windowLen: 10 })).rejects.toThrow(/windowLen/);
    expect(g1).not.toHaveBeenCalled();
    expect(g2).not.toHaveBeenCalled();
    expect(g3).not.toHaveBeenCalled();

    const g = stubGrant(bank);
    g.mockRejectedValueOnce(new Error('Simulation failed. Logs: Program log: AnchorError occurred. Error Code: AlreadySpent. Error Number: 6005. custom program error: 0x1775'));
    await expect(runOp(bank, 'h081_allowance_grant', { usdg: '1', confirm: true })).rejects.toMatchObject({ name: 'H081Error' });
  });
});

describe('h081_allowance_delegate', () => {
  it('plans a child that is no looser than its parent (caps shared, limits inherited), then sends exactly that with confirm', async () => {
    const { bank } = await open();
    const parent = allowance(bank, bank.owner, { windowCap: USD(20), maxPerTx: USD(5), expiry: NOW + 10n * DAY });
    vi.spyOn(bank.owner, 'agentAllowances').mockReturnValue([parent]);
    const del = stubDelegate(bank.owner);
    const args = { allowanceId: String(parent.commitment), toAgentIndex: 2, usdg: '10' };
    const plan = await runOp(bank, 'h081_allowance_delegate', args) as Record<string, any>;
    expect(plan).toMatchObject({ sent: false, dryRun: true });
    // the child's window cap defaults to its share (10/100 of 20 USDG); the parent keeps the rest minus one unit per unused slot
    expect(plan.plan).toMatchObject({
      action: 'delegate', parentId: parent.commitment, parentRemaining: USD(100), to: 'sub-account 2', toAgentIndex: 2,
      child: { amount: USD(10), windowCap: USD(2), maxPerTx: USD(5), expiry: NOW + 10n * DAY, streamRate: 0n },
      parentKeeps: { amount: USD(90), windowCap: USD(20) - USD(2) - 3n, maxPerTx: USD(5), expiry: NOW + 10n * DAY },
    });
    expect(del).not.toHaveBeenCalled();

    const r = await runOp(bank, 'h081_allowance_delegate', { ...args, maxPerTxUsdg: '1', windowCapUsdg: '4', days: 3, confirm: true }) as Record<string, any>;
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0][0]).toBe(parent);
    expect(del.mock.calls[0][1]).toEqual([{ to: bank.agent(2).account.address, amount: USD(10), windowCap: USD(4), maxPerTx: USD(1), expiry: NOW + 3n * DAY, streamRate: 0n }]);
    const made = (await del.mock.results[0].value).subs[0];
    expect(r).toMatchObject({ sent: true, signature: 'sigDelegate', signatures: ['sigDelegate'], parentId: parent.commitment, toAgentIndex: 2, allowanceId: allowanceCommitment(made), residualRemaining: USD(90) });
    expect(r.next).toContain(`h081_pay (agentIndex: 2, allowanceId: ${allowanceCommitment(made)})`);
  });

  it('names the limit a child would exceed and sends nothing', async () => {
    const { bank } = await open();
    const parent = allowance(bank, bank.owner, { lifetimeCap: USD(50), windowCap: USD(20), maxPerTx: USD(5), expiry: NOW + 10n * DAY, streamRate: 1000n, streamStart: NOW - 100n });
    vi.spyOn(bank.owner, 'agentAllowances').mockReturnValue([parent]);
    const del = stubDelegate(bank.owner);
    const id = String(parent.commitment);
    const go = (extra: Record<string, unknown>) => runOp(bank, 'h081_allowance_delegate', { allowanceId: id, toAgentIndex: 1, usdg: '10', ...extra });
    await expect(go({ usdg: '60' })).rejects.toThrow(/the parent has 50 USDG left; a child can never get more than its parent has\. Nothing was sent\./);
    await expect(go({ windowCapUsdg: '20' })).rejects.toThrow(/a child's per-window cap can never exceed its parent's: at most 19\.999996 USDG here.*Nothing was sent/);
    await expect(go({ maxPerTxUsdg: '6' })).rejects.toThrow(/per-payment cap can never exceed its parent's \(maxPerTx 5 USDG\)\. Nothing was sent/);
    await expect(go({ days: 11 })).rejects.toThrow(/a child can never outlive its parent: the parent expires at .*11 days from now is later\. Nothing was sent/);
    await expect(go({ unlockDays: 0.01 })).rejects.toThrow(/a child can never unlock faster than its parent: at most .* a day here.*give a longer unlockDays\. Nothing was sent/);
    await expect(go({ allowanceId: '999' })).rejects.toThrow(/no open allowance with id 999 is held by this account or its sub-accounts.*Nothing was sent/);
    await expect(runOp(bank, 'h081_allowance_delegate', { allowanceId: id, usdg: '1' })).rejects.toThrow(/exactly one recipient for the child/);
    // the holder itself is not a child
    await expect(runOp(bank, 'h081_allowance_delegate', { allowanceId: id, usdg: '1', toAddressCode: bank.shieldedAddressCode() })).rejects.toThrow(/another account than the one holding the parent/);
    // a streaming parent: the child streams too, its default rate a share of the parent's
    const plan = await go({}) as Record<string, any>;
    expect(plan.plan.child.streamRate).toBe(200n);
    expect(plan.plan.parentKeeps.streamRate).toBe(1000n - 200n - 3n);
    expect(plan.plan.child.streamStart).toBeGreaterThanOrEqual(NOW);

    const expired = allowance(bank, bank.owner, { expiry: NOW - 1n });
    vi.spyOn(bank.owner, 'agentAllowances').mockReturnValue([expired]);
    await expect(runOp(bank, 'h081_allowance_delegate', { allowanceId: String(expired.commitment), toAgentIndex: 1, usdg: '1' })).rejects.toThrow(/the parent expired at .*Nothing was sent/);

    const capped = await open({ maxGrant: USD(5) });
    await expect(runOp(capped.bank, 'h081_allowance_delegate', { allowanceId: id, toAgentIndex: 1, usdg: '6' })).rejects.toThrow(/H081_MAX_GRANT \(5 USDG per allowance; asked 6 USDG\)/);
    expect(del).not.toHaveBeenCalled();
  });

  it('delegates from a sub-account\'s allowance to another agent; an uncapped parent allows a capped, streaming child; delegate artifacts are required to send', async () => {
    const { bank } = await open();
    const other = await open();
    const sub = bank.agent(1);
    const parent = allowance(bank, sub.wallet, { lifetimeCap: USD(40) });
    vi.spyOn(sub.wallet, 'agentAllowances').mockReturnValue([parent]);
    const del = stubDelegate(sub.wallet);
    const code = other.bank.shieldedAddressCode();
    const r = await runOp(bank, 'h081_allowance_delegate', { allowanceId: String(parent.commitment), agentIndex: 1, toAddressCode: code, usdg: '8', windowCapUsdg: '2', unlockDays: 4, confirm: true }) as Record<string, any>;
    expect(del.mock.calls[0][1]).toEqual([{ to: other.bank.account.address, amount: USD(8), windowCap: USD(2), maxPerTx: 0n, expiry: 0n, streamRate: (USD(8) + 4n * DAY - 1n) / (4n * DAY), streamStart: NOW }]);
    expect(r).toMatchObject({ sent: true, parentAgentIndex: 1, to: 'another agent\'s shielded address' });

    // the site does not ship the delegate artifacts yet: the plan works, sending is refused before anything is signed
    const noDelegate = await open({ circuits: circuitsDir(['grant', 'spend']) });
    const p2 = allowance(noDelegate.bank, noDelegate.bank.owner);
    vi.spyOn(noDelegate.bank.owner, 'agentAllowances').mockReturnValue([p2]);
    const d2 = stubDelegate(noDelegate.bank.owner);
    const a2 = { allowanceId: String(p2.commitment), toAgentIndex: 3, usdg: '1' };
    expect(await runOp(noDelegate.bank, 'h081_allowance_delegate', a2)).toMatchObject({ dryRun: true });
    await expect(runOp(noDelegate.bank, 'h081_allowance_delegate', { ...a2, confirm: true })).rejects.toThrow(/delegate proving artifacts are not in .*the site does not ship the delegate artifacts yet.*Nothing was sent/);
    expect(d2).not.toHaveBeenCalled();
  });

  it('the SDK input builder runs before any proof: a pledged parent whose lender binding does not check out is refused, nothing sent', async () => {
    const { bank } = await open();
    const parent = allowance(bank, bank.owner, { lifetimeCap: USD(10) });
    parent.allowance.policy.pledgeBps = 4000n; // pledged, but policy.lender (0) is not the hash of the memo's lender: the builder refuses
    parent.lender = { lenderAddr: 5n, loanRef: 3n, viewPub: new Uint8Array(32) };
    vi.spyOn(bank.owner, 'agentAllowances').mockReturnValue([parent]);
    const del = stubDelegate(bank.owner);
    await expect(runOp(bank, 'h081_allowance_delegate', { allowanceId: String(parent.commitment), toAgentIndex: 1, usdg: '1', confirm: true }))
      .rejects.toThrow(/that child cannot be carved from allowance .*Nothing was sent/);
    expect(del).not.toHaveBeenCalled();
  });
});

describe('h081_allowance_reclaim', () => {
  it('plans, then takes back what is left of an allowance this account granted; a pledged one names its lender share', async () => {
    const { bank } = await open();
    const toSub = allowance(bank, null, { agentPk: bank.agent(1).account.keys.pk, ownerPk: bank.account.keys.pk, remaining: USD(30), lifetimeCap: USD(50) });
    const pledged = allowance(bank, null, { agentPk: bank.agent(2).account.keys.pk, ownerPk: bank.account.keys.pk, lifetimeCap: USD(10), pledgeBps: 4000n });
    pledged.lender = { lenderAddr: 5n, loanRef: 3n, viewPub: new Uint8Array(32) };
    vi.spyOn(bank.owner, 'grantedAllowances').mockReturnValue([toSub, pledged]);
    const reclaim = vi.spyOn(bank.owner, 'reclaim').mockImplementation(async (owned) => ({ tx: tx('sigReclaim'), proof: {} as never, next: { ...owned.allowance, remaining: 0n } }));

    const plan = await runOp(bank, 'h081_allowance_reclaim', { allowanceId: String(toSub.commitment) }) as Record<string, any>;
    expect(plan).toMatchObject({ sent: false, dryRun: true, plan: { action: 'reclaim', heldBy: 'sub-account 1', reclaimed: USD(30), lenderShare: 0n, backToShielded: USD(30) } });
    expect(reclaim).not.toHaveBeenCalled();
    const r = await runOp(bank, 'h081_allowance_reclaim', { allowanceId: String(toSub.commitment), confirm: true });
    expect(reclaim.mock.calls[0][0]).toBe(toSub);
    expect(r).toMatchObject({ sent: true, signature: 'sigReclaim', reclaimed: USD(30), reclaimedUsdg: '30', lenderShare: 0n });

    const p = await runOp(bank, 'h081_allowance_reclaim', { allowanceId: String(pledged.commitment) }) as Record<string, any>;
    expect(p.plan).toMatchObject({ lenderShare: USD(4), backToShielded: USD(6), note: expect.stringMatching(/4000 bps .* goes to its lender/) });

    await expect(runOp(bank, 'h081_allowance_reclaim', { allowanceId: '5' })).rejects.toThrow(/no open allowance with id 5 was granted by this account.*Nothing was sent/);
    await expect(runOp(bank, 'h081_allowance_reclaim', {})).rejects.toThrow(/allowanceId is required.*Nothing was sent/);
    const noSpend = await open({ circuits: circuitsDir([]) });
    vi.spyOn(noSpend.bank.owner, 'grantedAllowances').mockReturnValue([toSub]);
    const rc = vi.spyOn(noSpend.bank.owner, 'reclaim');
    await expect(runOp(noSpend.bank, 'h081_allowance_reclaim', { allowanceId: String(toSub.commitment), confirm: true })).rejects.toThrow(/spend proving artifacts are not in.*Nothing was sent/);
    expect(rc).not.toHaveBeenCalled();
  });
});

describe('h081_bank_balance with allowances', () => {
  it('lists granted (sub-accounts / other agents), held and delegated-in allowances with ids h081_pay takes and a reclaimable flag', async () => {
    const { bank } = await open();
    const other = await open();
    const toSub = allowance(bank, null, { agentPk: bank.agent(1).account.keys.pk, ownerPk: bank.account.keys.pk });
    const toOther = allowance(bank, null, { agentPk: (other.bank.account.address as StipendAddress).pk, ownerPk: bank.account.keys.pk });
    const mine = allowance(bank, bank.owner);
    vi.spyOn(bank.owner, 'grantedAllowances').mockReturnValue([toSub, toOther]);
    vi.spyOn(bank.owner, 'agentAllowances').mockReturnValue([mine]);
    // sub-account 1 holds the grant (owner: this account) and a child delegated from an allowance someone else owns
    const foreign = allowance(bank, bank.agent(1).wallet, { ownerPk: 77n });
    vi.spyOn(bank.agent(1).wallet, 'agentAllowances').mockReturnValue([{ ...toSub }, foreign]);
    const b = await bank.balance();
    expect(b.subAccounts).toEqual([expect.objectContaining({ id: toSub.commitment, agentIndex: 1, reclaimable: true })]);
    expect(b.grantedToOthers).toEqual([expect.objectContaining({ id: toOther.commitment, reclaimable: true })]);
    expect(b.grantedToOthers[0].agentIndex).toBeUndefined();
    expect(b.agentAllowances).toEqual([expect.objectContaining({ id: mine.commitment, reclaimable: false })]);
    expect(b.heldBySubAccounts).toEqual([expect.objectContaining({ id: foreign.commitment, agentIndex: 1, reclaimable: false })]);

    // a sub-account this process delegated to is listed even though this account granted it nothing
    const parent = allowance(bank, bank.owner);
    vi.spyOn(bank.owner, 'agentAllowances').mockReturnValue([parent]);
    stubDelegate(bank.owner);
    await bank.allowanceDelegate({ allowanceId: parent.commitment, toAgentIndex: 4, amount: USD(1), confirm: true });
    const held4 = allowance(bank, bank.agent(4).wallet, { ownerPk: 77n });
    vi.spyOn(bank.agent(4).wallet, 'agentAllowances').mockReturnValue([held4]);
    expect((await bank.balance()).heldBySubAccounts.map((v) => v.agentIndex)).toEqual([1, 4]);
    // and h081_pay finds it by id
    const pay = vi.spyOn(bank.agent(4).wallet, 'pay').mockResolvedValue({ tx: tx('sigPay'), proof: {} as never, next: { ...held4.allowance, remaining: held4.allowance.remaining - USD(1) } });
    const r = await bank.pay({ amount: USD(1), to: other.bank.account.address, allowanceId: held4.commitment });
    expect(r.agentIndex).toBe(4);
    expect(pay).toHaveBeenCalledTimes(1);

    const info = await bank.protocolInfo();
    expect(info.operatorCeilings).toEqual({ maxDeposit: null, maxPay: null, maxGrant: null, maxLend: null });
  });
});

describe('sub-accounts delegated to survive a restart', () => {
  it('a child delegated to a sub-account is still listed and payable by id after the bank is reopened', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'h081-subs-'));
    const signer = Keypair.generate();
    const first = await open({ signer, cacheDir });
    const parent = allowance(first.bank, first.bank.owner);
    vi.spyOn(first.bank.owner, 'agentAllowances').mockReturnValue([parent]);
    stubDelegate(first.bank.owner);
    await first.bank.allowanceDelegate({ allowanceId: parent.commitment, toAgentIndex: 2, amount: USD(10), confirm: true });
    // only the sub-account list is under test: drop the event cache so the reopened bank does not replay it
    for (const f of readdirSync(cacheDir)) if (f.endsWith('.events.json')) unlinkSync(join(cacheDir, f));
    expect(readdirSync(cacheDir).some((f) => f.includes('.subaccounts-'))).toBe(true);

    const again = await open({ signer, cacheDir });
    const child = allowance(again.bank, again.bank.agent(2).wallet, { ownerPk: 77n, lifetimeCap: USD(10) });
    vi.spyOn(again.bank.agent(2).wallet, 'agentAllowances').mockReturnValue([child]);
    expect((await again.bank.balance()).heldBySubAccounts).toEqual([expect.objectContaining({ id: child.commitment, agentIndex: 2 })]);
    const pay = vi.spyOn(again.bank.agent(2).wallet, 'pay').mockResolvedValue({ tx: tx('sigPay'), proof: {} as never, next: { ...child.allowance, remaining: USD(9) } });
    const other = await open();
    const r = await again.bank.pay({ amount: USD(1), to: other.bank.account.address, allowanceId: child.commitment });
    expect(r.agentIndex).toBe(2);
    expect(pay).toHaveBeenCalledTimes(1);
  });

  it('without a cache, h081_pay still finds an id held by a sub-account it did not know about, and remembers it', async () => {
    const { bank } = await open();
    const other = await open();
    const child = allowance(bank, bank.agent(9).wallet, { ownerPk: 77n, lifetimeCap: USD(10) });
    vi.spyOn(bank.agent(9).wallet, 'agentAllowances').mockReturnValue([child]);
    expect((await bank.balance()).heldBySubAccounts).toEqual([]); // not known yet
    vi.spyOn(bank.agent(9).wallet, 'pay').mockResolvedValue({ tx: tx('sigPay'), proof: {} as never, next: { ...child.allowance, remaining: USD(9) } });
    expect((await bank.pay({ amount: USD(1), to: other.bank.account.address, allowanceId: child.commitment })).agentIndex).toBe(9);
    expect((await bank.balance()).heldBySubAccounts.map((v) => v.agentIndex)).toEqual([9]);
  });
});
