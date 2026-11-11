// The Solana Agent Kit plugin: shape (satisfies Plugin), action schemas, methods, handlers against a mocked
// bank through a real SolanaAgentKit + KeypairWallet, and the documented error for other wallets.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { KeypairWallet, SolanaAgentKit, type Action, type BaseWallet } from 'solana-agent-kit';
import H081Plugin, { H081_ACTIONS, UNSUPPORTED_WALLET, keypairOfWallet, resetBank, setBankProvider, signerFromAgent } from '../../integrations/solana-agent-kit/src/index.js';
import { encodeAddressCode } from '../../integrations/core/codes.js';
import { EXAMPLE_INPUTS, OPS } from '../../integrations/core/schemas.js';
import { mockBank } from './helpers.js';

const RPC = 'http://127.0.0.1:1';

describe('H081 Agent Kit plugin', () => {
  let bank: ReturnType<typeof mockBank>;
  const kp = Keypair.generate();
  const makeAgent = () => new SolanaAgentKit(new KeypairWallet(kp, RPC), RPC, {}).use(H081Plugin);
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(() => {
    bank = mockBank();
    setBankProvider(async () => bank);
    agent = makeAgent();
  });
  afterEach(() => { setBankProvider(undefined); resetBank(agent); });

  it('has the upstream Plugin shape: name, one unique UPPER_SNAKE action per operation with snake-case similes, methods, initialize', () => {
    expect(H081Plugin.name).toBe('h081');
    expect(typeof H081Plugin.initialize).toBe('function');
    expect(H081_ACTIONS).toHaveLength(OPS.length);
    const names = H081_ACTIONS.map((a) => a.name);
    expect(new Set(names).size).toBe(OPS.length);
    expect(names).toEqual(['H081_BANK_DEPOSIT', 'H081_BANK_WITHDRAW', 'H081_BANK_BALANCE', 'H081_LOAN_QUOTE', 'H081_LOAN_BORROW', 'H081_STAKE', 'H081_PROTOCOL_INFO', 'H081_PAY', 'H081_ALLOWANCE_GRANT', 'H081_ALLOWANCE_DELEGATE', 'H081_ALLOWANCE_RECLAIM', 'H081_LEND', 'H081_TRANSFER']);
    for (const [i, a] of H081_ACTIONS.entries()) {
      expect(a.similes[0]).toBe(OPS[i]);
      expect(a.similes.length).toBeGreaterThan(2);
      expect(a.description.length).toBeGreaterThan(40);
      expect(Array.isArray(a.examples[0])).toBe(true);
      for (const group of a.examples) for (const ex of group) {
        expect(a.schema.safeParse(ex.input).success, `${a.name} example ${JSON.stringify(ex.input)}`).toBe(true);
        expect(ex.output).toHaveProperty('status');
        expect(ex.explanation.length).toBeGreaterThan(10);
      }
      for (const ex of EXAMPLE_INPUTS[OPS[i]]) expect(a.schema.safeParse(ex).success).toBe(true);
      expect(typeof a.handler).toBe('function');
    }
    expect(Object.keys(H081Plugin.methods).sort()).toEqual(['h081AllowanceDelegate', 'h081AllowanceGrant', 'h081AllowanceReclaim', 'h081BankBalance', 'h081BankDeposit', 'h081BankWithdraw', 'h081Lend', 'h081LoanBorrow', 'h081LoanQuote', 'h081Pay', 'h081ProtocolInfo', 'h081Stake', 'h081Transfer']);
    for (const m of Object.values(H081Plugin.methods)) expect(typeof m).toBe('function');
    expect(agent.actions.map((a) => a.name)).toEqual(names);
    expect(Object.keys(agent.methods).sort()).toEqual(Object.keys(H081Plugin.methods).sort());
  });

  it('handlers run the operations against the bank and return plain JSON (no bigints)', async () => {
    const by = Object.fromEntries(H081_ACTIONS.map((a) => [a.name, a])) as Record<string, Action>;
    const dep = await by.H081_BANK_DEPOSIT.handler(agent, { usdg: '25' });
    expect(dep).toMatchObject({ status: 'success', signature: 'sigDeposit', amount: '25000000', amountUsdg: '25' });
    expect(bank.deposit).toHaveBeenCalledWith(25_000_000n);
    expect(() => JSON.stringify(dep)).not.toThrow();

    const to = Keypair.generate().publicKey.toBase58();
    const wd = await by.H081_BANK_WITHDRAW.handler(agent, { amount: '5000000', to, direct: true });
    expect(wd).toMatchObject({ status: 'success', via: 'direct', fee: '0', to });
    expect(bank.withdraw.mock.calls[0][0]).toBe(5_000_000n);
    expect((bank.withdraw.mock.calls[0][1] as PublicKey).toBase58()).toBe(to);
    expect(bank.withdraw.mock.calls[0][2]).toBe(true);

    expect(await by.H081_BANK_BALANCE.handler(agent, {})).toMatchObject({ status: 'success', shieldedUsdg: '25', caps: { perDeposit: '1000000000' } });
    expect(await by.H081_LOAN_QUOTE.handler(agent, { pledgeBps: 4000, minRemainingUsdg: '100' })).toMatchObject({ status: 'success', maxPrincipal: '40000000', payout: '39900000' });
    expect(bank.loanQuote).toHaveBeenCalledWith({ termsCode: undefined, minRemaining: 100_000_000n, pledgeBps: 4000, principal: undefined, loanRef: undefined });
    expect(await by.H081_LOAN_BORROW.handler(agent, { termsCode: 'h081-loan-terms:eyJ2IjoxfQ', budgetUsdg: '100', dailyCapUsdg: '20', days: 30, unlockDays: 10 })).toMatchObject({ status: 'success', proofCode: 'h081-loan-proof:eyJ2IjoxfQ', pledgeBps: '4000' });
    expect(bank.borrow).toHaveBeenCalledWith('h081-loan-terms:eyJ2IjoxfQ', { budget: 100_000_000n, dailyCap: 20_000_000n, maxPerTx: undefined, days: 30, unlockDays: 10, agentIndex: undefined });
    expect(await by.H081_STAKE.handler(agent, { action: 'stake', h081: '100' })).toMatchObject({ status: 'success', signature: 'sigStake', staked: '100000000' });
    expect(await by.H081_STAKE.handler(agent, { action: 'view' })).toMatchObject({ status: 'success', cooldownDays: 30 });
    expect(await by.H081_STAKE.handler(agent, { action: 'request_unstake', amount: '7' })).toMatchObject({ status: 'success', pending: '7' });
    expect(await by.H081_STAKE.handler(agent, { action: 'unstake' })).toMatchObject({ status: 'success', signature: 'sigUnstake' });
    expect(await by.H081_PROTOCOL_INFO.handler(agent, {})).toMatchObject({ status: 'success', cluster: 'mainnet-beta' });

    // h081_pay: a public payout to a wallet, a private one to an address code, and refusals before the bank is asked
    const payTo = Keypair.generate().publicKey.toBase58();
    expect(await by.H081_PAY.handler(agent, { usdg: '2.5', to: payTo })).toMatchObject({ status: 'success', signature: 'sigPay', amount: '2500000', fee: '50000', received: '2450000', to: payTo, private: false, via: 'relayer', remaining: '1000000' });
    expect(bank.pay.mock.calls[0][0]).toMatchObject({ amount: 2_500_000n, allowanceId: undefined, agentIndex: undefined, direct: false });
    expect((bank.pay.mock.calls[0][0].to as PublicKey).toBase58()).toBe(payTo);
    const addr = { pk: 123456789n, viewPub: Uint8Array.from({ length: 32 }, (_, i) => i + 1) };
    const code = encodeAddressCode(bank.codeContext, addr);
    expect(await by.H081_PAY.handler(agent, { amount: '1000000', toAddressCode: code, agentIndex: 2, allowanceId: '42' })).toMatchObject({ status: 'success', private: true, to: 'shielded', via: 'direct', agentIndex: 2 });
    expect(bank.pay.mock.calls[1][0]).toMatchObject({ amount: 1_000_000n, to: addr, allowanceId: 42n, agentIndex: 2, direct: false });
    const devnetCode = encodeAddressCode({ ...bank.codeContext, cluster: 'devnet' }, addr);
    expect(await by.H081_PAY.handler(agent, { usdg: '1', toAddressCode: devnetCode })).toMatchObject({ status: 'error', message: expect.stringMatching(/another network, program or asset/) });
    expect(await by.H081_PAY.handler(agent, { usdg: '1', to: payTo, toAddressCode: code })).toMatchObject({ status: 'error', message: expect.stringMatching(/exactly one recipient/) });
    expect(await by.H081_PAY.handler(agent, { usdg: '1', toAddressCode: code, direct: true })).toMatchObject({ status: 'error', message: expect.stringMatching(/direct applies to a public payout/) });
    expect(bank.pay).toHaveBeenCalledTimes(2);

    // allowances: a plan by default, the send with confirm, and refusals before the bank is asked
    expect(await by.H081_ALLOWANCE_GRANT.handler(agent, { usdg: '50', agentIndex: 1, windowCapUsdg: '10', maxPerTxUsdg: '2', days: 30 })).toMatchObject({ status: 'success', sent: false, dryRun: true });
    expect(bank.allowanceGrant.mock.calls[0][0]).toMatchObject({ amount: 50_000_000n, agentIndex: 1, windowCap: 10_000_000n, maxPerTx: 2_000_000n, days: 30, confirm: false });
    expect(await by.H081_ALLOWANCE_GRANT.handler(agent, { usdg: '20', toAddressCode: code, unlockDays: 10, confirm: true })).toMatchObject({ status: 'success', sent: true, allowanceId: '11' });
    expect(bank.allowanceGrant.mock.calls[1][0]).toMatchObject({ amount: 20_000_000n, to: addr, unlockDays: 10, confirm: true });
    expect(await by.H081_ALLOWANCE_GRANT.handler(agent, { usdg: '1', toAddressCode: devnetCode })).toMatchObject({ status: 'error', message: expect.stringMatching(/another network/) });
    expect(await by.H081_ALLOWANCE_GRANT.handler(agent, { usdg: '1', agentIndex: 1, toAddressCode: code })).toMatchObject({ status: 'error', message: expect.stringMatching(/not both/) });
    expect(await by.H081_ALLOWANCE_GRANT.handler(agent, { usdg: '1', days: 2, unlockDays: 3 })).toMatchObject({ status: 'error', message: expect.stringMatching(/unlockDays must not exceed days/) });
    expect(await by.H081_ALLOWANCE_GRANT.handler(agent, { usdg: '1', windowCapUsdg: '0' })).toMatchObject({ status: 'error', message: expect.stringMatching(/positive/) });
    expect(bank.allowanceGrant).toHaveBeenCalledTimes(2);
    expect(await by.H081_ALLOWANCE_DELEGATE.handler(agent, { allowanceId: '42', agentIndex: 1, toAgentIndex: 2, usdg: '10', confirm: true })).toMatchObject({ status: 'success', sent: true, parentId: '42', allowanceId: '12' });
    expect(bank.allowanceDelegate.mock.calls[0][0]).toMatchObject({ allowanceId: 42n, agentIndex: 1, toAgentIndex: 2, amount: 10_000_000n, confirm: true });
    expect(await by.H081_ALLOWANCE_DELEGATE.handler(agent, { allowanceId: '42', toAgentIndex: 2, toAddressCode: code, usdg: '1' })).toMatchObject({ status: 'error', message: expect.stringMatching(/exactly one recipient for the child/) });
    expect(bank.allowanceDelegate).toHaveBeenCalledTimes(1);
    expect(await by.H081_ALLOWANCE_RECLAIM.handler(agent, { allowanceId: '11' })).toMatchObject({ status: 'success', sent: false, dryRun: true });
    expect(await by.H081_ALLOWANCE_RECLAIM.handler(agent, { allowanceId: '11', confirm: true })).toMatchObject({ status: 'success', sent: true, reclaimedUsdg: '5' });
  });

  it('H081_LEND runs each lender action against the bank, a plan unless confirm, and refuses fields another action takes', async () => {
    const by = Object.fromEntries(H081_ACTIONS.map((a) => [a.name, a])) as Record<string, Action>;
    expect(await by.H081_LEND.handler(agent, { action: 'open', pledgeBps: 4000 })).toMatchObject({ status: 'success', sent: false, dryRun: true });
    expect(await by.H081_LEND.handler(agent, { action: 'open', pledgeBps: 4000, confirm: true })).toMatchObject({ status: 'success', sent: true, termsCode: 'h081-loan-terms:4mD9q' });
    expect(await by.H081_LEND.handler(agent, { action: 'fund', proofCode: 'h081-loan-proof:abc', confirm: true })).toMatchObject({ status: 'success', sent: true, borrowerReceivesUsdg: '39.9' });
    expect(bank.lendFund).toHaveBeenLastCalledWith({ proofCode: 'h081-loan-proof:abc', loanRef: undefined, principal: undefined, pledgeBps: undefined, confirm: true });
    expect(await by.H081_LEND.handler(agent, { action: 'status', loanRef: '3' })).toMatchObject({ status: 'success', slots: [{ loanRef: '3' }] });
    expect(await by.H081_LEND.handler(agent, { action: 'claim', loanRef: '3' })).toMatchObject({ status: 'success', action: 'claim' });
    expect(await by.H081_LEND.handler(agent, { action: 'settle', loanRef: '3', proofCode: 'h081-loan-proof:abc' })).toMatchObject({ status: 'error', message: expect.stringMatching(/each action takes only its own fields/) });
    expect(await by.H081_LEND.handler(agent, { action: 'open' })).toMatchObject({ status: 'error', message: expect.stringMatching(/open needs pledgeBps/) });
    expect(await by.H081_LEND.handler(agent, { action: 'collect' })).toMatchObject({ status: 'error', message: expect.stringMatching(/need loanRef/) });
    expect(bank.lendSettle).not.toHaveBeenCalled();
    expect(await agent.methods.h081Lend(agent, { action: 'status' })).toMatchObject({ slots: [{ loanRef: '3' }] });
  });

  it('handlers never throw: a schema violation or a bank error is {status: "error", message}', async () => {
    const by = Object.fromEntries(H081_ACTIONS.map((a) => [a.name, a])) as Record<string, Action>;
    expect(await by.H081_BANK_DEPOSIT.handler(agent, { usdg: '1', amount: '1' })).toMatchObject({ status: 'error', message: expect.stringMatching(/exactly one of "amount"/) });
    expect(await by.H081_BANK_DEPOSIT.handler(agent, { usdg: 'lots' })).toMatchObject({ status: 'error', message: expect.stringMatching(/usdg: a decimal amount/) });
    expect(bank.deposit).not.toHaveBeenCalled();
    bank.deposit.mockRejectedValueOnce(new Error('DepositCapExceeded (6037, stipend_pool): the bank holds at most 10,000 USDG in total'));
    expect(await by.H081_BANK_DEPOSIT.handler(agent, { usdg: '1' })).toEqual({ status: 'error', message: expect.stringMatching(/DepositCapExceeded/) });
    expect(await by.H081_STAKE.handler(agent, { action: 'stake' })).toMatchObject({ status: 'error' });
  });

  it('plugin.methods take the agent first (upstream convention) and are what agent.methods exposes', async () => {
    const r = await agent.methods.h081BankDeposit(agent, { amount: '1000000' });
    expect(r).toMatchObject({ signature: 'sigDeposit', amount: '1000000' });
    await expect(agent.methods.h081BankWithdraw(agent, { usdg: 'x' })).rejects.toThrow(/usdg/);
    expect(await H081Plugin.methods.h081ProtocolInfo(agent)).toMatchObject({ cluster: 'mainnet-beta' });
  });

  it('the bank is opened once per agent and a failed open is retried', async () => {
    let n = 0;
    setBankProvider(async () => { n++; if (n === 1) throw new Error('rpc down'); return bank; });
    const by = Object.fromEntries(H081_ACTIONS.map((a) => [a.name, a])) as Record<string, Action>;
    expect(await by.H081_BANK_BALANCE.handler(agent, {})).toMatchObject({ status: 'error', message: 'rpc down' });
    expect(await by.H081_BANK_BALANCE.handler(agent, {})).toMatchObject({ status: 'success' });
    expect(await by.H081_PROTOCOL_INFO.handler(agent, {})).toMatchObject({ status: 'success' });
    expect(n).toBe(2);
  });

  it('signer: env key first, then the KeypairWallet\'s Keypair, else the documented error for other wallets', () => {
    expect(keypairOfWallet(agent.wallet)!.publicKey.equals(kp.publicKey)).toBe(true);
    expect(signerFromAgent(agent, {}).publicKey.equals(kp.publicKey)).toBe(true);
    const other = Keypair.generate();
    expect(signerFromAgent(agent, { H081_SOLANA_KEY: JSON.stringify(Array.from(other.secretKey)) }).publicKey.equals(other.publicKey)).toBe(true);
    const signerOnly: BaseWallet = {
      publicKey: Keypair.generate().publicKey,
      signTransaction: async (t) => t, signAllTransactions: async (t) => t, signMessage: async (m) => m,
      signAndSendTransaction: async () => ({ signature: 'x' }),
    };
    expect(keypairOfWallet(signerOnly)).toBeUndefined();
    expect(() => signerFromAgent({ wallet: signerOnly }, {})).toThrow(UNSUPPORTED_WALLET);
    expect(UNSUPPORTED_WALLET).toMatch(/Privy, Turnkey, Crossmint/);
  });

  it('the default bank provider reports a missing key readably (no network is touched)', async () => {
    setBankProvider(undefined);
    const signerOnly: BaseWallet = {
      publicKey: Keypair.generate().publicKey,
      signTransaction: async (t) => t, signAllTransactions: async (t) => t, signMessage: async (m) => m,
      signAndSendTransaction: async () => ({ signature: 'x' }),
    };
    const saved = { ...process.env };
    delete process.env.H081_SOLANA_KEYPAIR; delete process.env.H081_SOLANA_KEY;
    try {
      const a2 = new SolanaAgentKit(signerOnly, RPC, {}).use(H081Plugin);
      const r = await H081_ACTIONS[2].handler(a2, {});
      expect(r).toMatchObject({ status: 'error', message: UNSUPPORTED_WALLET });
    } finally {
      process.env.H081_SOLANA_KEYPAIR = saved.H081_SOLANA_KEYPAIR; process.env.H081_SOLANA_KEY = saved.H081_SOLANA_KEY;
      if (saved.H081_SOLANA_KEYPAIR === undefined) delete process.env.H081_SOLANA_KEYPAIR;
      if (saved.H081_SOLANA_KEY === undefined) delete process.env.H081_SOLANA_KEY;
    }
    vi.restoreAllMocks();
  });
});
