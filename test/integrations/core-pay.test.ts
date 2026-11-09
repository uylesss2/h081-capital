// H081Bank.pay (h081_pay) against a fake connection: the allowance is picked inside its caps or the blocking cap is
// named, a public payout goes through the relayer with the fee the relayer checks (to the treasury) and fails closed,
// a private payment goes to a framed "h081-address:" code, the operator ceiling H081_MAX_PAY holds. The wallet's pay
// is mocked: nothing is proven or sent.
import { describe, expect, it, vi } from 'vitest';
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import type { Allowance, Policy } from '../../src/crypto.js';
import { allowanceCommitment } from '../../src/crypto.js';
import { Prover } from '../../src/prover.js';
import type { SolOwnedAllowance, SolanaWallet } from '../../src/solana/wallet.js';
import { H081Bank } from '../../integrations/core/bank.js';
import { decodeAddressCode, encodeAddressCode } from '../../integrations/core/codes.js';
import { MAINNET } from '../../integrations/core/constants.js';
import { deriveAccountSk } from '../../integrations/core/keys.js';
import { runOp } from '../../integrations/core/operations.js';
import { RELAYER_INFO, USDG, fakeConnection, fakeRelayerFetch, testConfig, tokenAccountData } from './helpers.js';

const noProver = new Prover('C:/nonexistent');
const NOW = 1_800_000_000n;
const TERMS = { minFee: BigInt(RELAYER_INFO.solana.minFees[MAINNET.usdg.mint]), feeBps: RELAYER_INFO.solana.feeBps };
const USD = (x: number) => BigInt(Math.round(x * 1e6));

async function open(opts: { relayer?: boolean; info?: unknown; payees?: PublicKey[]; maxPay?: bigint; lamports?: number; stake?: { staked: bigint; pending: bigint; readyAt: bigint } } = {}) {
  const signer = Keypair.generate();
  // payees with an existing USDG account (the relayer then charges no account-creation surcharge)
  const accounts = Object.fromEntries((opts.payees ?? []).map((p) => [
    getAssociatedTokenAddressSync(USDG, p, true, TOKEN_2022_PROGRAM_ID).toBase58(), { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccountData(USDG, p, 0n) },
  ]));
  const conn = fakeConnection(signer, { now: NOW, accounts, lamports: opts.lamports, stake: opts.stake });
  const fetch = fakeRelayerFetch(opts.info ?? RELAYER_INFO);
  const bank = await H081Bank.open({
    config: testConfig({ ...(opts.relayer === false ? {} : { relayerUrl: MAINNET.relayer }), maxPay: opts.maxPay }), signer, accountSk: deriveAccountSk(signer),
    connection: conn as unknown as Connection, prover: noProver, cacheDir: null, fetch,
  });
  vi.spyOn(bank.owner, 'sync').mockResolvedValue(undefined);
  return { bank, conn, fetch, signer };
}

let nextIndex = 1;
/** An allowance held by `wallet` (agentPk = its key) with `over` applied to the policy and state. */
function allowance(bank: H081Bank, wallet: SolanaWallet, over: Partial<Policy> & { remaining?: bigint; windowId?: bigint; windowSpent?: bigint; withLender?: boolean } = {}): SolOwnedAllowance {
  const { remaining, windowId, windowSpent, withLender, ...policy } = over;
  const P: Policy = {
    lifetimeCap: USD(100), windowCap: 0n, windowLen: 86400n, maxPerTx: 0n, expiry: 0n, recipientRoot: 0n, ownerPk: 77n, streamRate: 0n, streamStart: 0n,
    lender: 0n, pledgeBps: 0n, ...policy,
  };
  const a: Allowance = {
    asset: bank.owner.registerMint(USDG), remaining: remaining ?? P.lifetimeCap, agentPk: wallet.account.keys.pk, policy: P,
    windowId: windowId ?? 0n, windowSpent: windowSpent ?? 0n, rho: BigInt(nextIndex) * 1_000_003n, pledgePaid: 0n,
  };
  const idx = nextIndex++;
  return {
    allowance: a, commitment: allowanceCommitment(a), index: idx, spent: false, views: { owner: new Uint8Array(32), agent: new Uint8Array(32) },
    ...(withLender ? { lender: { lenderAddr: 5n, loanRef: 3n, viewPub: new Uint8Array(32) }, lenderKey: Keypair.generate().publicKey } : {}),
  };
}

/** Stubs a wallet: its allowances, no chain sync, and a pay that returns the successor (remaining - amount). */
function holding(wallet: SolanaWallet, list: SolOwnedAllowance[]) {
  vi.spyOn(wallet, 'sync').mockResolvedValue(undefined);
  vi.spyOn(wallet, 'agentAllowances').mockReturnValue(list);
  return vi.spyOn(wallet, 'pay').mockImplementation(async (owned, amount) => ({
    tx: { signature: 'sigPay', computeUnits: 1, logs: [] }, proof: {} as never, next: { ...owned.allowance, remaining: owned.allowance.remaining - amount, rho: owned.allowance.rho + 1n },
  }));
}

describe('H081Bank.pay', () => {
  it('pays a wallet through the relayer: fee max(min, 0.20% of the gross amount) to the treasury, picked allowance, what is left', async () => {
    const payee = Keypair.generate().publicKey;
    const { bank } = await open({ payees: [payee] });
    const small = allowance(bank, bank.owner, { lifetimeCap: USD(10) });
    const big = allowance(bank, bank.owner, { lifetimeCap: USD(100) });
    const pay = holding(bank.owner, [big, small]);

    const r = await bank.pay({ amount: USD(5), to: payee });
    // the smallest allowance that can pay is used
    expect(pay.mock.calls[0][0]).toBe(small);
    expect(pay.mock.calls[0][1]).toBe(USD(5));
    expect((pay.mock.calls[0][2] as PublicKey).equals(payee)).toBe(true);
    const relay = pay.mock.calls[0][3]!;
    expect(relay.fee).toBe(50_000n);
    expect(relay.feeRecipient!.toBase58()).toBe(MAINNET.treasuryUsdgAccount);
    expect(relay.relayer!.toBase58()).toBe(RELAYER_INFO.solana.relayer);
    expect(relay.via).toBeDefined();
    expect(relay.operator).toBeUndefined();
    expect(r).toMatchObject({
      signature: 'sigPay', amount: USD(5), fee: 50_000n, lenderShare: 0n, received: USD(5) - 50_000n, receivedUsdg: '4.95', to: payee.toBase58(),
      private: false, via: 'relayer', allowanceId: small.commitment, remaining: USD(5), remainingUsdg: '5',
    });
    expect(r.nextAllowanceId).toBe(allowanceCommitment({ ...small.allowance, remaining: USD(5), rho: small.allowance.rho + 1n }));
    expect(r.agentIndex).toBeUndefined();

    // the spend fee is on the gross amount (the relayer's public leg = payout + lender share), not amount - fee
    expect(H081Bank.spendRelayFee(USD(100), TERMS)).toBe(200_000n);
    expect(H081Bank.spendRelayFee(USD(1), TERMS)).toBe(50_000n);
    expect(H081Bank.spendRelayFee(USD(100), TERMS)).toBeGreaterThan(H081Bank.relayFee(USD(100), TERMS));
    const r100 = await bank.pay({ amount: USD(80), to: payee });
    expect(r100.fee).toBe(160_000n);
    expect(pay.mock.calls[1][0]).toBe(big);
  });

  it('names the cap that blocks each allowance and sends nothing; an explicit allowanceId is honored or refused', async () => {
    const payee = Keypair.generate().publicKey;
    const { bank } = await open({ payees: [payee] });
    const perTx = allowance(bank, bank.owner, { maxPerTx: USD(1) });
    const day = BigInt(NOW / 86400n);
    const window = allowance(bank, bank.owner, { windowCap: USD(20), windowId: day, windowSpent: USD(18) });
    const expired = allowance(bank, bank.owner, { expiry: NOW - 1n });
    const stream = allowance(bank, bank.owner, { streamRate: 100n, streamStart: NOW - 10_000n }); // 1 USDG unlocked
    const low = allowance(bank, bank.owner, { lifetimeCap: USD(50), remaining: USD(2) });
    const listed = allowance(bank, bank.owner, { recipientRoot: 12345n });
    const pay = holding(bank.owner, [perTx, window, expired, stream, low, listed]);

    const err = await bank.pay({ amount: USD(3), to: payee }).catch((e: Error) => e.message);
    expect(err).toMatch(/^no allowance can pay 3 USDG now\. Nothing was sent\./);
    expect(err).toContain(`allowance ${perTx.commitment}: over its per-payment cap (maxPerTx 1 USDG)`);
    expect(err).toMatch(/over its per-window cap \(windowCap 20 USDG per 86400 s; 2 USDG left in this window, which resets at /);
    expect(err).toMatch(/expired at .* \(expiry\)/);
    expect(err).toMatch(/it streams: 1 USDG unlocked and unspent so far \(streamRate 8\.64 USDG a day\); 3 USDG unlocks in about 20000 s/);
    expect(err).toContain('only 2 USDG left of its lifetime cap 50 USDG (remaining)');
    expect(err).toContain('allow-list of recipients');
    expect(pay).not.toHaveBeenCalled();

    // the window resets in the next window: the same allowance pays there
    expect(bank.payBlock(window, USD(3), (day + 1n) * 86400n)).toBeUndefined();

    // explicit id: refused with its own reason, or used even when another would also do
    await expect(bank.pay({ amount: USD(3), to: payee, allowanceId: perTx.commitment })).rejects.toThrow(/over its per-payment cap \(maxPerTx 1 USDG\)/);
    await expect(bank.pay({ amount: USD(1), to: payee, allowanceId: 999n })).rejects.toThrow(/no open allowance with id 999 .*Nothing was sent/);
    expect(pay).not.toHaveBeenCalled();
    const r = await bank.pay({ amount: USD(1), to: payee, allowanceId: window.commitment });
    expect(pay.mock.calls[0][0]).toBe(window);
    expect(r.allowanceId).toBe(window.commitment);

    // nothing to pay from at all
    const none = await open({ payees: [payee] });
    holding(none.bank.owner, []);
    await expect(none.bank.pay({ amount: USD(1), to: payee })).rejects.toThrow(/this account holds no USDG allowance to pay from .*Nothing was sent/);
  });

  it('fails closed like a withdrawal: an unusable relayer refuses the payment; direct: true or no relayer sends it from the agent key', async () => {
    const payee = Keypair.generate().publicKey;
    const down = await open({ payees: [payee], info: { error: 'down' } });
    const pay = holding(down.bank.owner, [allowance(down.bank, down.bank.owner)]);
    // a relayer that answers without Solana terms, or with a fee account that is not the treasury's
    await expect(down.bank.pay({ amount: USD(5), to: payee })).rejects.toThrow(/does not relay Solana operations\. The payment was not sent: retry later, or pass direct: true/);
    const lookalike = Keypair.generate().publicKey.toBase58();
    const wrong = await open({ payees: [payee], info: { solana: { ...RELAYER_INFO.solana, feeAccounts: { [MAINNET.usdg.mint]: lookalike } } } });
    const payW = holding(wrong.bank.owner, [allowance(wrong.bank, wrong.bank.owner)]);
    await expect(wrong.bank.pay({ amount: USD(5), to: payee })).rejects.toThrow(/fee account .*H081 relay fees go only to the protocol treasury.*The payment was not sent/);
    expect(pay).not.toHaveBeenCalled();
    expect(payW).not.toHaveBeenCalled();

    const d = await down.bank.pay({ amount: USD(5), to: payee, direct: true });
    expect(d).toMatchObject({ via: 'direct', fee: 0n, received: USD(5), private: false });
    expect(pay.mock.calls[0][3]).toEqual({});

    const norelay = await open({ payees: [payee], relayer: false });
    const payN = holding(norelay.bank.owner, [allowance(norelay.bank, norelay.bank.owner)]);
    expect(await norelay.bank.pay({ amount: USD(5), to: payee })).toMatchObject({ via: 'direct', fee: 0n });
    expect(payN.mock.calls[0][3]).toEqual({});
    expect(norelay.fetch).not.toHaveBeenCalled();

    // the agent key needs SOL to send it itself
    const poor = await open({ payees: [payee], relayer: false, lamports: 1_000_000 });
    holding(poor.bank.owner, [allowance(poor.bank, poor.bank.owner)]);
    await expect(poor.bank.pay({ amount: USD(5), to: payee })).rejects.toThrow(/0\.0010 SOL; a payment it sends itself needs about 0\.02 SOL.*Nothing was sent/);
  });

  it('relay fee rules: a missing payee account costs the surcharge or is refused; a fee that eats the payout is refused; above the free tier the agent wallet is named', async () => {
    const fresh = Keypair.generate().publicKey; // no USDG account
    const { bank } = await open({});
    const pay = holding(bank.owner, [allowance(bank, bank.owner, { lifetimeCap: USD(500) })]);
    await expect(bank.pay({ amount: USD(5), to: fresh })).rejects.toThrow(/has no USDG token account yet and the relayer .* does not create accounts.*Nothing was sent/);
    const surcharge = await open({ info: { solana: { ...RELAYER_INFO.solana, createAccountFees: { [MAINNET.usdg.mint]: '300000' } } } });
    holding(surcharge.bank.owner, [allowance(surcharge.bank, surcharge.bank.owner)]);
    expect((await surcharge.bank.pay({ amount: USD(5), to: fresh })).fee).toBe(350_000n);

    const payee = Keypair.generate().publicKey;
    const tiny = await open({ payees: [payee] });
    holding(tiny.bank.owner, [allowance(tiny.bank, tiny.bank.owner)]);
    await expect(tiny.bank.pay({ amount: 50_000n, to: payee })).rejects.toThrow(/the relay fee 0\.05 USDG is not below what the recipient would get \(0\.05 USDG\).*Nothing was sent/);
    expect(pay).not.toHaveBeenCalled();

    // above the 100 USDG free tier: no stake refuses before proving, a stake names the agent wallet as operator
    const big = await open({ payees: [payee] });
    const payB = holding(big.bank.owner, [allowance(big.bank, big.bank.owner, { lifetimeCap: USD(500) })]);
    await expect(big.bank.pay({ amount: USD(150), to: payee })).rejects.toThrow(/is more than the relayer takes with nothing staked \(up to 100 USDG per withdrawal; above that, H081 staked in capacity_stake sets a 30-day limit.*Nothing was sent\. Stake more H081 \(h081_stake\), pay at most 100 USDG at a time, or pass direct: true/);
    expect(payB).not.toHaveBeenCalled();
    const staked = await open({ payees: [payee], stake: { staked: 500_000_000n, pending: 0n, readyAt: 0n } });
    const payS = holding(staked.bank.owner, [allowance(staked.bank, staked.bank.owner, { lifetimeCap: USD(500) })]);
    const r = await staked.bank.pay({ amount: USD(150), to: payee });
    expect(r.operator).toBe(staked.signer.publicKey.toBase58());
    expect(payS.mock.calls[0][3]!.operator!.operator.equals(staked.signer.publicKey)).toBe(true);
  });

  it('a pledged allowance routes the lender share out of the amount; unpledged ones are preferred', async () => {
    const payee = Keypair.generate().publicKey;
    const { bank } = await open({ payees: [payee] });
    const pledged = allowance(bank, bank.owner, { lifetimeCap: USD(10), pledgeBps: 4000n, withLender: true });
    const plain = allowance(bank, bank.owner, { lifetimeCap: USD(50) });
    const pay = holding(bank.owner, [pledged, plain]);
    await bank.pay({ amount: USD(5), to: payee });
    expect(pay.mock.calls[0][0]).toBe(plain);
    // even named by id, a pledged allowance needs the opt-in: its loan slot and lender share would be public
    await expect(bank.pay({ amount: USD(5), to: payee, allowanceId: pledged.commitment })).rejects.toThrow(/pledged to a loan.*allowPledged: true.*/);
    expect(pay).toHaveBeenCalledTimes(1);
    const r = await bank.pay({ amount: USD(5), to: payee, allowanceId: pledged.commitment, allowPledged: true });
    expect(r).toMatchObject({ lenderShare: USD(2), fee: 50_000n, received: USD(3) - 50_000n, linkedToLoan: 3n });
    expect(r.privacy).toMatch(/loan slot 3.*links it to the borrower wallet.*gross amount 5 USDG/);
    // pledged but its lender details are missing: blocked, not sent
    const broken = allowance(bank, bank.owner, { pledgeBps: 4000n });
    expect(bank.payBlock(broken, USD(1), NOW)).toMatch(/lender details were not found/);
  });

  it('never picks a pledged allowance on its own: when only a pledged one could pay, it is refused and nothing is sent', async () => {
    const payee = Keypair.generate().publicKey;
    const { bank } = await open({ payees: [payee] });
    const pledged = allowance(bank, bank.owner, { lifetimeCap: USD(50), pledgeBps: 4000n, withLender: true });
    const pay = holding(bank.owner, [pledged]);
    await expect(runOp(bank, 'h081_pay', { usdg: '5', to: payee.toBase58() })).rejects.toThrow(/no allowance can pay 5 USDG now\. Nothing was sent\..*pledged to a loan.*allowPledged: true/);
    await expect(bank.pay({ amount: USD(5), to: decodeAddressCode(bank.codeContext, (await open()).bank.shieldedAddressCode()) })).rejects.toThrow(/pledged to a loan/);
    expect(pay).not.toHaveBeenCalled();
    expect(await runOp(bank, 'h081_pay', { usdg: '5', to: payee.toBase58(), allowPledged: true })).toMatchObject({ lenderShare: USD(2), linkedToLoan: 3n });
    expect(pay).toHaveBeenCalledTimes(1);
  });

  it('refuses relayer terms above the published ceilings (rate, minimum, account surcharge): nothing proven, never a direct send', async () => {
    const payee = Keypair.generate().publicKey;
    const greedy = (over: Record<string, unknown>) => ({ solana: { ...RELAYER_INFO.solana, ...over } });
    for (const [info, why] of [
      [greedy({ feeBps: 9000 }), /asks 90% of each operation \(at most 0\.25% is accepted\)/],
      [greedy({ minFees: { [MAINNET.usdg.mint]: '50000000' } }), /a minimum fee of 50 USDG/],
      [greedy({ createAccountFees: { [MAINNET.usdg.mint]: '90000000' } }), /90 USDG to create a recipient's token account/],
    ] as const) {
      const { bank } = await open({ info, payees: [payee] });
      const pay = holding(bank.owner, [allowance(bank, bank.owner, { lifetimeCap: USD(100) })]);
      await expect(bank.pay({ amount: USD(100), to: payee })).rejects.toThrow(why);
      await expect(bank.pay({ amount: USD(100), to: payee })).rejects.toThrow(/refused and nothing was signed.*The payment was not sent/);
      expect(pay).not.toHaveBeenCalled();
    }
    // the published terms (0.20%, 0.05 USDG) and a 2 USDG surcharge pass
    const ok = await open({ info: greedy({ createAccountFees: { [MAINNET.usdg.mint]: '2000000' } }) });
    expect(await ok.bank.relayTerms()).toMatchObject({ feeBps: 20, minFee: 50_000n, createAccountFee: 2_000_000n });
  });

  it('pays privately to an "h081-address:" code (agent key sends, no relayer), from a sub-account with agentIndex, under H081_MAX_PAY', async () => {
    const { bank, fetch } = await open({ maxPay: USD(20) });
    const other = await open({});
    const code = other.bank.shieldedAddressCode();
    expect(code.startsWith('h081-address:')).toBe(true);
    const to = decodeAddressCode(bank.codeContext, code);
    expect(to).toEqual(other.bank.account.address);

    const sub = bank.agent(2);
    const subA = allowance(bank, sub.wallet, { lifetimeCap: USD(30) });
    const paySub = holding(sub.wallet, [subA]);
    const payOwner = holding(bank.owner, [allowance(bank, bank.owner)]);
    const r = await runOp(bank, 'h081_pay', { usdg: '4', toAddressCode: code, agentIndex: 2 }) as Awaited<ReturnType<H081Bank['pay']>>;
    expect(r).toMatchObject({ private: true, to: 'shielded', via: 'direct', fee: 0n, received: USD(4), agentIndex: 2, allowanceId: subA.commitment, remaining: USD(26) });
    expect(paySub.mock.calls[0][2]).toEqual(other.bank.account.address);
    expect(paySub.mock.calls[0][3]).toEqual({});
    expect(payOwner).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled(); // a private payment never asks the relayer

    // a sub-account's allowance found by id without agentIndex (the sub-account is one this account granted to)
    vi.spyOn(bank.owner, 'grantedAllowances').mockReturnValue([{ ...subA, allowance: { ...subA.allowance, agentPk: sub.account.keys.pk } }]);
    const byId = await bank.pay({ amount: USD(1), to, allowanceId: subA.commitment });
    expect(byId.agentIndex).toBe(2);

    // the operator ceiling, before anything is read
    await expect(bank.pay({ amount: USD(21), to })).rejects.toThrow(/over the operator ceiling H081_MAX_PAY \(20 USDG per payment; asked 21 USDG\)\. Nothing was sent\./);
    // a code for another network is refused before the bank is asked
    const devnet = encodeAddressCode({ ...bank.codeContext, cluster: 'devnet' }, to);
    await expect(runOp(bank, 'h081_pay', { usdg: '1', toAddressCode: devnet })).rejects.toThrow(/another network/);
    expect(paySub).toHaveBeenCalledTimes(2);
    await expect(runOp(bank, 'h081_pay', { usdg: '1', toAddressCode: code, direct: true })).rejects.toThrow(/direct applies to a public payout/);
  });

  it('balance and protocolInfo carry the shielded address code and the operator ceilings', async () => {
    const { bank } = await open({ relayer: false, maxPay: USD(20) });
    const b = await bank.balance();
    expect(decodeAddressCode(bank.codeContext, b.shieldedAddressCode)).toEqual(bank.account.address);
    const info = await bank.protocolInfo();
    expect(info.shieldedAddressCode).toBe(b.shieldedAddressCode);
    expect(info.operatorCeilings).toEqual({ maxDeposit: null, maxPay: USD(20), maxGrant: null, maxLend: null });
  });

  it('a program error from the spend is explained', async () => {
    const payee = Keypair.generate().publicKey;
    const { bank } = await open({ payees: [payee] });
    const pay = holding(bank.owner, [allowance(bank, bank.owner)]);
    pay.mockRejectedValueOnce(new Error('Simulation failed. Logs: Program log: AnchorError occurred. Error Code: AlreadySpent. Error Number: 6005. custom program error: 0x1775'));
    await expect(bank.pay({ amount: USD(1), to: payee })).rejects.toMatchObject({ name: 'H081Error' });
  });
});
