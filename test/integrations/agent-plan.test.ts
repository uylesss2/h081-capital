// Every write without confirm returns status "plan" and the bank sees no send and no prove call; the withdraw plan
// warns when the money goes back to the agent wallet; `to` is required.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { encodeAddressCode, encodeLoanProof, encodeLoanTerms } from '../../integrations/core/codes.js';
import { MAINNET } from '../../integrations/core/constants.js';
import { FRESH, makeAgent, startGateway, type AgentSetup, type Gateway } from './agent-helpers.js';

const pool = { cluster: 'mainnet-beta', program: MAINNET.programs.pool, mint: MAINNET.usdg.mint };
const loan = { cluster: 'mainnet-beta', program: MAINNET.programs.loan, mint: MAINNET.usdg.mint };
const addressCode = encodeAddressCode(pool, { pk: 99n, viewPub: new Uint8Array(32).fill(7) });
const termsCode = encodeLoanTerms(loan, { loanRef: 3n, pledgeBps: 4000n, lenderViewPub: new Uint8Array(32).fill(1) });
const proofCode = encodeLoanProof(loan, {
  ref: 3n, payout: Keypair.generate().publicKey, proof: { a: [1n, 2n], b: [[1n, 2n], [3n, 4n]], c: [5n, 6n] } as never,
  args: { lender: Keypair.generate().publicKey, asset: new PublicKey(MAINNET.usdg.mint), minRemaining: 1n, loanRef: 3n, pledgeBps: 4000, audience: 1n, expiry: 1n } as never,
});

/** Bank methods that send (or prove) when called at all. */
const SENDS = ['deposit', 'withdraw', 'pay', 'transfer', 'borrow', 'stake', 'requestUnstake', 'unstake', 'lendCollect', 'lendClaim', 'allowanceDelegate', 'lendClose'] as const;
/** Bank methods that have their own plan step: allowed only with confirm false. */
const PLANNED = ['allowanceGrant', 'allowanceReclaim', 'lendOpen', 'lendFund', 'lendSettle'] as const;

describe('plans: nothing is proven or sent without confirm', () => {
  let a: AgentSetup;
  let g: Gateway;
  beforeAll(async () => { a = await makeAgent(); g = await startGateway(a.h); });
  afterAll(async () => { await g.close(); });

  const writes: Array<[string, Record<string, unknown>]> = [
    ['/v1/deposit', { usdg: '5' }],
    ['/v1/withdraw', { usdg: '2', to: FRESH }],
    ['/v1/withdraw', { amount: '2000000', to: FRESH, direct: true }],
    ['/v1/pay', { usdg: '1', to: FRESH }],
    ['/v1/pay', { usdg: '1', toAddressCode: addressCode }],
    ['/v1/transfer', { usdg: '1', toAddressCode: addressCode }],
    ['/v1/allowances', { budget: '10', dailyCap: '2', maxPerTx: '1', days: 30, agentIndex: 1 }],
    ['/v1/allowances/12345/reclaim', {}],
    ['/v1/loans/borrow', { termsCode, days: 30, unlockDays: 30, principal: '10' }],
    ['/v1/loans/lend', { action: 'open', pledgeBps: 4000 }],
    ['/v1/loans/lend', { action: 'fund', proofCode }],
    ['/v1/loans/lend', { action: 'collect', loanRef: '3' }],
    ['/v1/loans/lend', { action: 'claim', loanRef: '3' }],
    ['/v1/loans/lend', { action: 'settle', loanRef: '3' }],
    ['/v1/stake', { action: 'stake', h081: '100' }],
    ['/v1/stake', { action: 'request_unstake', h081: '100' }],
    ['/v1/stake', { action: 'unstake' }],
  ];

  it.each(writes)('POST %s %j without confirm returns status plan, HTTP 200, and sends nothing', async (path, body) => {
    for (const confirm of [undefined, false]) {
      const r = await g.api('POST', path, confirm === undefined ? body : { ...body, confirm });
      expect(r.status, r.text).toBe(200);
      expect(r.json).toMatchObject({ ok: true, network: 'mainnet-beta', status: 'plan' });
      const p = r.json.result;
      for (const k of ['op', 'fee', 'solNeeded', 'circuit', 'download', 'publicOnChain', 'sentBy', 'warnings', 'next']) expect(p, `${path} plan.${k}`).toHaveProperty(k);
      expect(p.next).toMatch(/Nothing was sent/);
    }
    for (const m of SENDS) expect(a.bank[m as keyof typeof a.bank], `${m} after ${path}`).not.toHaveBeenCalled();
    for (const m of PLANNED) for (const call of (a.bank[m as keyof typeof a.bank] as unknown as { mock: { calls: Array<[{ confirm?: boolean }]> } }).mock.calls) expect(call[0].confirm, `${m} after ${path}`).toBe(false);
  });

  it('the withdraw plan shows the relayer fee, what arrives, the circuit and what is public', async () => {
    const r = await g.api('POST', '/v1/withdraw', { usdg: '2', to: FRESH });
    expect(r.json.result).toMatchObject({
      op: 'withdraw', usdg: '2', to: FRESH, fee: '0.05', payout: '1.95', solNeeded: '0', circuit: 'transact', download: '15 MB',
      publicOnChain: ['recipient', 'amount received'], sentBy: 'relayer',
    });
    expect(r.json.result.warnings.join(' ')).not.toMatch(/links the two/);
    const big = await g.api('POST', '/v1/withdraw', { usdg: '150', to: FRESH });
    expect(big.json.result.warnings.join(' ')).toMatch(/needs H081 staked/);
  });

  it('withdraw to "self" or to the agent wallet carries the privacy warning; a missing or bad `to` gives 400', async () => {
    const me = a.signer.publicKey.toBase58();
    for (const to of ['self', me]) {
      const r = await g.api('POST', '/v1/withdraw', { usdg: '2', to });
      expect(r.json.result.to).toBe(me);
      expect(r.json.result.warnings).toContain('Sending back to the wallet that deposited links the two.');
    }
    const missing = await g.api('POST', '/v1/withdraw', { usdg: '2' });
    expect(missing.status).toBe(400);
    expect(missing.json.error).toMatchObject({ code: 'bad_request', retryable: false });
    expect(missing.json.error.message).toMatch(/to is required/);
    expect((await g.api('POST', '/v1/withdraw', { usdg: '2', to: '' })).status).toBe(400);
    expect((await g.api('POST', '/v1/withdraw', { usdg: '2', to: 'not-a-wallet' })).status).toBe(400);
    // the SDK refuses the same
    await expect(a.h.withdraw('2', { to: undefined as unknown as string })).rejects.toThrow(/to is required/);
    expect(a.bank.withdraw).not.toHaveBeenCalled();
  });

  it('payments to a code and transfers say the agent key sends them; bad input is 400; lend close is 501', async () => {
    const pay = await g.api('POST', '/v1/pay', { usdg: '1', toAddressCode: addressCode });
    expect(pay.json.result).toMatchObject({ sentBy: 'agent key', circuit: 'spend' });
    expect(pay.json.result.warnings.join(' ')).toMatch(/sent by the agent key/);
    const tr = await g.api('POST', '/v1/transfer', { usdg: '1', toAddressCode: addressCode });
    expect(tr.json.result).toMatchObject({ sentBy: 'agent key', fee: '0', circuit: 'transact' });
    expect(tr.json.result.warnings.join(' ')).toMatch(/visible on chain as a bank user/);
    expect((await g.api('POST', '/v1/deposit', { usdg: '1', amount: '1' })).status).toBe(400);
    expect((await g.api('POST', '/v1/deposit', { usdg: 'lots' })).status).toBe(400);
    expect((await g.api('POST', '/v1/deposit', { usdg: '1', extra: 1 })).json.error.message).toMatch(/unknown field/);
    expect((await g.api('POST', '/v1/deposit', { usdg: '1', confirm: 'yes' })).status).toBe(400);
    expect((await g.api('POST', '/v1/pay', { usdg: '1' })).status).toBe(400);
    const close = await g.api('POST', '/v1/loans/lend', { action: 'close', loanRef: '3' });
    expect(close.status).toBe(501);
    expect(close.json.error).toMatchObject({ code: 'not_available', retryable: false });
    expect((await g.api('POST', '/v1/loans/lend', { action: 'status' })).status).toBe(400);
  });

  it('confirmed writes call the bank exactly once with the mapped arguments', async () => {
    const b = await makeAgent();
    const g2 = await startGateway(b.h);
    try {
      const dep = await g2.api('POST', '/v1/deposit', { usdg: '5', confirm: true }, { 'idempotency-key': 'c-1' });
      expect(dep.json).toMatchObject({ status: 'sent', result: { signature: 'sigDeposit' } });
      expect(b.bank.deposit).toHaveBeenCalledWith(5_000_000n);
      await g2.api('POST', '/v1/withdraw', { usdg: '2', to: FRESH, confirm: true }, { 'idempotency-key': 'c-2' });
      expect(b.bank.withdraw).toHaveBeenCalledWith(2_000_000n, new PublicKey(FRESH), false);
      await g2.api('POST', '/v1/transfer', { usdg: '1', toAddressCode: addressCode, confirm: true }, { 'idempotency-key': 'c-3' });
      expect(b.bank.transfer).toHaveBeenCalledWith(1_000_000n, addressCode);
      await g2.api('POST', '/v1/allowances', { budget: '10', dailyCap: '2', days: 30, agentIndex: 1, confirm: true }, { 'idempotency-key': 'c-4' });
      expect(b.bank.allowanceGrant).toHaveBeenLastCalledWith(expect.objectContaining({ amount: 10_000_000n, agentIndex: 1, windowCap: 2_000_000n, days: 30, confirm: true }));
      await g2.api('POST', '/v1/allowances/77/reclaim', { confirm: true }, { 'idempotency-key': 'c-5' });
      expect(b.bank.allowanceReclaim).toHaveBeenLastCalledWith({ allowanceId: 77n, confirm: true });
      await g2.api('POST', '/v1/stake', { action: 'stake', h081: '100', confirm: true }, { 'idempotency-key': 'c-6' });
      expect(b.bank.stake).toHaveBeenCalledWith(100_000_000n);
      await g2.api('POST', '/v1/loans/lend', { action: 'claim', loanRef: '3', confirm: true }, { 'idempotency-key': 'c-7' });
      expect(b.bank.lendClaim).toHaveBeenCalledWith({ loanRef: 3n, amount: undefined });
      const events = b.h.events.since(0).map((e) => e.type);
      expect(events.filter((t) => t === 'op.completed')).toHaveLength(7);
    } finally { await g2.close(); }
  });

  it('reads: status, address, balance (cached 15 s), fees, history, quote, lent, stake', async () => {
    const st = await g.api('GET', '/v1/status');
    expect(st.json.result).toMatchObject({ network: 'mainnet-beta', agent: a.signer.publicKey.toBase58(), rpcHost: 'api.mainnet-beta.solana.com', relayer: 'api.h081.xyz', fundingNeeded: { deposit: '0.05', withdraw: '0.05', allow: '0.15', lend: '0.15' } });
    expect(st.json.result.circuits.missing).toContain('transact');
    expect((await g.api('GET', '/v1/address')).json.result).toEqual({ wallet: a.signer.publicKey.toBase58(), addressCode: a.h.address().addressCode });
    const calls = a.bank.balance.mock.calls.length;
    const b1 = await g.api('GET', '/v1/balance');
    expect(b1.json.result).toMatchObject({ shielded: '25', wallet: { usdg: '100', sol: '0.2' }, caps: { perDeposit: '1000', total: '10000', paused: false }, allowances: [], addressCode: a.h.address().addressCode });
    await g.api('GET', '/v1/balance');
    expect(a.bank.balance.mock.calls.length).toBe(calls + 1);
    await g.api('GET', '/v1/balance?fresh=1');
    expect(a.bank.balance.mock.calls.length).toBe(calls + 2);
    const fee = await g.api('GET', '/v1/fees/withdraw?usdg=2');
    expect(fee.json.result).toMatchObject({ fee: '0.05', feeBps: 20, minFee: '0.05', payout: '1.95', freeTierMax: '100', needsStake: false, relayer: MAINNET.relayer });
    expect((await g.api('GET', '/v1/fees/withdraw?usdg=150')).json.result.needsStake).toBe(true);
    expect((await g.api('GET', '/v1/fees/withdraw')).status).toBe(400);
    expect((await g.api('GET', '/v1/history?limit=0')).status).toBe(400);
    expect((await g.api('GET', `/v1/loans/quote?termsCode=${encodeURIComponent(termsCode)}`)).json.result).toMatchObject({ maxPrincipal: '40000000' });
    expect((await g.api('GET', '/v1/loans/quote?termsCode=h081-loan-terms:abc')).json.error.code).toBe('invalid_code');
    expect((await g.api('GET', '/v1/loans/lent?loanRef=3')).json.result).toMatchObject({ slots: [{ loanRef: '3' }] });
    expect((await g.api('GET', '/v1/stake')).json.result).toMatchObject({ cooldownDays: 30 });
  });
});
