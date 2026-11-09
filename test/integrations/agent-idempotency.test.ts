// Idempotency of confirmed writes: replay, key reuse, in progress, a restart with a pending record, no key, and a
// retryable failure that releases its key.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayerError } from '../../src/relayer-client.js';
import { RelayerUnavailableError } from '../../integrations/core/bank.js';
import { H081Error, RpcUnreachableError } from '../../integrations/core/errors.js';
import { bodyHash, OpStore, RETENTION_MS } from '../../integrations/agent/src/idempotency.js';
import { FRESH, makeAgent, startGateway, stubBank, tempHome, type Gateway } from './agent-helpers.js';

const gateways: Gateway[] = [];
afterEach(async () => { while (gateways.length) await gateways.pop()!.close(); });
const gw = async (...args: Parameters<typeof startGateway>) => { const g = await startGateway(...args); gateways.push(g); return g; };

describe('idempotency (ops.jsonl)', () => {
  it('the same key and body replays the stored result and sends once', async () => {
    const a = await makeAgent();
    const g = await gw(a.h);
    const first = await g.api('POST', '/v1/deposit', { usdg: '5', confirm: true }, { 'idempotency-key': 'dep-1' });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ ok: true, status: 'sent', result: { signature: 'sigDeposit', amount: '5000000' } });
    expect(first.json.replayed).toBeUndefined();
    const again = await g.api('POST', '/v1/deposit', { usdg: '5', confirm: true }, { 'idempotency-key': 'dep-1' });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ status: 'sent', replayed: true, result: { signature: 'sigDeposit' } });
    // base units are the same request
    const base = await g.api('POST', '/v1/deposit', { amount: '5000000', confirm: true }, { 'idempotency-key': 'dep-1' });
    expect(base.json).toMatchObject({ status: 'sent', replayed: true });
    expect(a.bank.deposit).toHaveBeenCalledTimes(1);
    // the history lists it once, from ops.jsonl
    const hist = await g.api('GET', '/v1/history');
    expect(hist.json.result.items).toEqual([expect.objectContaining({ id: 'dep-1', kind: 'deposit', usdg: '5', signature: 'sigDeposit', state: 'done' })]);
  });

  it('the same key with a different body gives 422 idempotency_key_reused', async () => {
    const a = await makeAgent();
    const g = await gw(a.h);
    await g.api('POST', '/v1/deposit', { usdg: '5', confirm: true }, { 'idempotency-key': 'k-1' });
    const other = await g.api('POST', '/v1/deposit', { usdg: '6', confirm: true }, { 'idempotency-key': 'k-1' });
    expect(other.status).toBe(422);
    expect(other.json.error).toMatchObject({ code: 'idempotency_key_reused', retryable: false });
    const otherRoute = await g.api('POST', '/v1/withdraw', { usdg: '5', to: FRESH, confirm: true }, { 'idempotency-key': 'k-1' });
    expect(otherRoute.status).toBe(422);
    expect(a.bank.deposit).toHaveBeenCalledTimes(1);
    expect(a.bank.withdraw).not.toHaveBeenCalled();
  });

  it('a call still running gives 409 in_progress with Retry-After: 5', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const bank = stubBank({ deposit: vi.fn(async (amount: bigint) => { await gate; return { signature: 'sigSlow', amount }; }) });
    const a = await makeAgent({ bank });
    const g = await gw(a.h);
    const running = g.api('POST', '/v1/deposit', { usdg: '1', confirm: true }, { 'idempotency-key': 'slow-1' });
    await vi.waitFor(() => expect(bank.deposit).toHaveBeenCalled());
    const busy = await g.api('POST', '/v1/deposit', { usdg: '1', confirm: true }, { 'idempotency-key': 'slow-1' });
    expect(busy.status).toBe(409);
    expect(busy.json.error).toMatchObject({ code: 'in_progress', retryable: true });
    expect(busy.headers['retry-after']).toBe('5');
    const status = await g.api('GET', '/v1/status');
    expect(status.json.result.queue.depth).toBe(1);
    release();
    expect((await running).json).toMatchObject({ status: 'sent', result: { signature: 'sigSlow' } });
    expect((await g.api('POST', '/v1/deposit', { usdg: '1', confirm: true }, { 'idempotency-key': 'slow-1' })).json.replayed).toBe(true);
    expect(bank.deposit).toHaveBeenCalledTimes(1);
  });

  it('after a restart, a pending record with no signature gives 409 outcome_unknown and is never retried', async () => {
    const first = await makeAgent();
    const body = { usdg: '2', to: FRESH };
    // a process that stopped mid-send left this behind
    writeFileSync(join(first.home, 'ops.jsonl'), JSON.stringify({ key: 'wd-9', route: 'withdraw', bodyHash: bodyHash('withdraw', body), state: 'pending', at: Date.now(), kind: 'withdraw', usdg: '2', to: FRESH }) + '\n');
    const again = await makeAgent({ home: first.home, signer: first.signer });
    const g = await gw(again.h);
    const r = await g.api('POST', '/v1/withdraw', { ...body, confirm: true }, { 'idempotency-key': 'wd-9' });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({ code: 'outcome_unknown', retryable: false });
    expect(r.json.error.message).toMatch(/check \/v1\/balance before retrying with a new key/);
    expect(again.bank.withdraw).not.toHaveBeenCalled();
    // still unknown on the next try: nothing is ever sent for it
    expect((await g.api('POST', '/v1/withdraw', { ...body, confirm: true }, { 'idempotency-key': 'wd-9' })).json.error.code).toBe('outcome_unknown');
    expect(again.bank.withdraw).not.toHaveBeenCalled();
    // a new key sends
    expect((await g.api('POST', '/v1/withdraw', { ...body, confirm: true }, { 'idempotency-key': 'wd-10' })).json.status).toBe('sent');
  });

  it('after a restart, a pending record with a signature is confirmed over RPC and replayed', async () => {
    const first = await makeAgent();
    writeFileSync(join(first.home, 'ops.jsonl'), JSON.stringify({ key: 'dep-7', route: 'deposit', bodyHash: bodyHash('deposit', { usdg: '3' }), state: 'pending', signature: 'sigSeen', at: Date.now(), kind: 'deposit' }) + '\n');
    const bank = stubBank({ connection: { getSignatureStatuses: vi.fn(async () => ({ value: [{ err: null, confirmationStatus: 'confirmed' }] })) } });
    const again = await makeAgent({ home: first.home, signer: first.signer, bank });
    const g = await gw(again.h);
    const r = await g.api('POST', '/v1/deposit', { usdg: '3', confirm: true }, { 'idempotency-key': 'dep-7' });
    expect(r.json).toMatchObject({ status: 'sent', replayed: true, result: { signature: 'sigSeen', recovered: true } });
    expect(bank.connection.getSignatureStatuses).toHaveBeenCalledWith(['sigSeen'], { searchTransactionHistory: true });
    expect(bank.deposit).not.toHaveBeenCalled();
  });

  it('a confirmed write with no Idempotency-Key gives 400; a malformed key too; a plan needs none', async () => {
    const a = await makeAgent();
    const g = await gw(a.h);
    const none = await g.api('POST', '/v1/deposit', { usdg: '1', confirm: true });
    expect(none.status).toBe(400);
    expect(none.json.error).toMatchObject({ code: 'idempotency_key_required', retryable: false });
    const bad = await g.api('POST', '/v1/deposit', { usdg: '1', confirm: true }, { 'idempotency-key': 'has space' });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('idempotency_key_required');
    expect((await g.api('POST', '/v1/deposit', { usdg: '1', confirm: true }, { 'idempotency-key': 'x'.repeat(129) })).status).toBe(400);
    expect((await g.api('POST', '/v1/deposit', { usdg: '1' })).json.status).toBe('plan');
    expect(a.bank.deposit).not.toHaveBeenCalled();
  });

  it('a busy relayer is retried once; a retryable failure releases the key, a final one is stored and replayed', async () => {
    const withdraw = vi.fn(async () => { throw new RelayerError(503, 'busy', 'all lanes busy'); });
    const a = await makeAgent({ bank: stubBank({ withdraw }) });
    const g = await gw(a.h);
    const r = await g.api('POST', '/v1/withdraw', { usdg: '2', to: FRESH, confirm: true }, { 'idempotency-key': 'wd-busy' });
    expect(r.status).toBe(503);
    expect(r.json.error).toMatchObject({ code: 'relayer_busy', retryable: true });
    expect(withdraw).toHaveBeenCalledTimes(2); // the gateway's one retry
    // nothing was sent: the same key may run again
    withdraw.mockImplementation(async () => ({ signature: 'sigW2', amount: 2_000_000n }) as never);
    const ok = await g.api('POST', '/v1/withdraw', { usdg: '2', to: FRESH, confirm: true }, { 'idempotency-key': 'wd-busy' });
    expect(ok.json).toMatchObject({ status: 'sent', result: { signature: 'sigW2' } });
    // a final error is stored: the same key answers the same error without sending
    a.bank.deposit.mockRejectedValueOnce(new Error('DepositTooLarge: at most 1000 USDG per deposit (asked 1500).'));
    const capped = await g.api('POST', '/v1/deposit', { usdg: '1500', confirm: true }, { 'idempotency-key': 'dep-big' });
    expect(capped.status).toBe(409);
    expect(capped.json.error.code).toBe('cap_per_deposit');
    const replay = await g.api('POST', '/v1/deposit', { usdg: '1500', confirm: true }, { 'idempotency-key': 'dep-big' });
    expect(replay.status).toBe(409);
    expect(replay.json.error).toMatchObject({ code: 'cap_per_deposit', details: { replayed: true } });
    expect(a.bank.deposit).toHaveBeenCalledTimes(1);
  });

  it('records survive a restart, expire after 7 days, and ops.jsonl holds no key material', async () => {
    const a = await makeAgent();
    const g = await gw(a.h);
    await g.api('POST', '/v1/deposit', { usdg: '4', confirm: true }, { 'idempotency-key': 'keep-1' });
    const b = await makeAgent({ home: a.home, signer: a.signer });
    expect(b.h.ops.get('keep-1')).toMatchObject({ state: 'done', signature: 'sigDeposit' });
    const text = readFileSync(join(a.home, 'ops.jsonl'), 'utf8');
    expect(text).not.toContain(JSON.stringify(Array.from(a.signer.secretKey)).slice(1, 40));
    expect(text).not.toContain(Buffer.from(a.signer.secretKey).toString('hex').slice(0, 32));
    let now = Date.now();
    const store = new OpStore(join(a.home, 'ops.jsonl'), () => {}, () => now);
    expect(store.get('keep-1')).toBeDefined();
    now += RETENTION_MS + 1000;
    const later = new OpStore(join(a.home, 'ops.jsonl'), () => {}, () => now);
    expect(later.get('keep-1')).toBeUndefined();
  });
});

describe('a send whose outcome is unknown is never sent again', () => {
  // the relayer or the RPC may already have sent it: a dropped connection mid-send, or a relayer 5xx such as a proxy 504
  const reset = () => new H081Error('fetch failed', Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }));
  const cases: Array<[string, () => Error]> = [
    ['a connection reset while the relayer has the request', reset],
    ['a relayer 504 from a proxy', () => new H081Error('relayer 504 error: gateway timeout', new RelayerError(504, 'error', 'gateway timeout'))],
    ['a relayer 500', () => new RelayerError(500, 'error', 'confirm timed out')],
    ['an RPC that stops answering while confirming a direct send', () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }) })],
  ];
  for (const [name, make] of cases) {
    it(`${name}: 409 outcome_unknown, stored, and the same key never sends again`, async () => {
      const withdraw = vi.fn(async () => { throw make(); });
      const a = await makeAgent({ bank: stubBank({ withdraw }) });
      const g = await gw(a.h);
      const body = { usdg: '2', to: FRESH, confirm: true };
      const first = await g.api('POST', '/v1/withdraw', body, { 'idempotency-key': 'wd-u' });
      expect(first.status).toBe(409);
      expect(first.json.error).toMatchObject({ code: 'outcome_unknown', retryable: false, details: { idempotencyKey: 'wd-u' } });
      expect(first.json.error.message).toMatch(/before retrying with a new key/);
      withdraw.mockImplementation(async () => ({ signature: 'sigAgain', amount: 2_000_000n }) as never);
      const again = await g.api('POST', '/v1/withdraw', body, { 'idempotency-key': 'wd-u' });
      expect(again.status).toBe(409);
      expect(again.json.error).toMatchObject({ code: 'outcome_unknown', retryable: false, details: { replayed: true } });
      expect(withdraw).toHaveBeenCalledTimes(1);
      // and it stays so after a restart
      const b = await makeAgent({ home: a.home, signer: a.signer, bank: stubBank({ withdraw }) });
      await expect(b.h.withdraw('2', { to: FRESH, confirm: true, idempotencyKey: 'wd-u' })).rejects.toMatchObject({ code: 'outcome_unknown' });
      expect(withdraw).toHaveBeenCalledTimes(1);
    });
  }

  it('a refusal before anything was sent still frees the key: the relayer terms check, a 4xx, the RPC down at open', async () => {
    const refusals: Array<() => Error> = [
      () => new Error('the relayer https://api.h081.xyz is unreachable (fetch failed). The withdrawal was not sent', { cause: new RelayerUnavailableError('unreachable', 'the relayer https://api.h081.xyz is unreachable (fetch failed)') }),
      () => new RelayerError(409, 'in_flight', 'a note is being spent'),
    ];
    for (const [i, make] of refusals.entries()) {
      const withdraw = vi.fn(async () => { throw make(); });
      const a = await makeAgent({ bank: stubBank({ withdraw }) });
      const g = await gw(a.h);
      const r = await g.api('POST', '/v1/withdraw', { usdg: '2', to: FRESH, confirm: true }, { 'idempotency-key': `wd-r${i}` });
      expect(r.json.error.retryable).toBe(true);
      withdraw.mockImplementation(async () => ({ signature: 'sigOk', amount: 2_000_000n }) as never);
      expect((await g.api('POST', '/v1/withdraw', { usdg: '2', to: FRESH, confirm: true }, { 'idempotency-key': `wd-r${i}` })).json.status).toBe('sent');
    }
    // the bank could not be opened at all: nothing was sent
    const signer = (await makeAgent()).signer;
    let fail = true;
    const ok = stubBank();
    const { H081 } = await import('../../integrations/agent/src/h081.js');
    const h = await H081.open({ env: { H081_HOME: tempHome() }, signer, log: () => {}, bank: async () => { if (fail) throw new RpcUnreachableError('127.0.0.1:9', 'ECONNREFUSED'); return ok as never; } });
    await expect(h.deposit('1', { confirm: true, idempotencyKey: 'dep-open' })).rejects.toMatchObject({ code: 'rpc_unreachable' });
    fail = false;
    expect((await h.deposit('1', { confirm: true, idempotencyKey: 'dep-open' })).status).toBe('sent');
  });
});
