// classify(): every error the bank, the relayer client, the RPC or the gateway throws maps to a stable code, an
// HTTP status and a retry flag (the table in the Agent API spec, section 5).
import { describe, expect, it } from 'vitest';
import { RelayerError } from '../../src/relayer-client.js';
import { SimulationError } from '../../src/solana/send.js';
import { RelayerUnavailableError } from '../../integrations/core/bank.js';
import { CodeError } from '../../integrations/core/codes.js';
import { MAINNET } from '../../integrations/core/constants.js';
import { CodedError, ERROR_CODES, RpcUnreachableError, classify, explained } from '../../integrations/core/errors.js';
import { InputError } from '../../integrations/core/operations.js';
import { makeAgent, startGateway, stubBank } from './agent-helpers.js';

const ids = { pool: MAINNET.programs.pool, loan: MAINNET.programs.loan, capacity: MAINNET.programs.capacity };
const poolLogs = (hex: string) => [`Program ${MAINNET.programs.pool} invoke [1]`, `Program ${MAINNET.programs.pool} failed: custom program error: ${hex}`];
const c = (e: unknown) => { const x = classify(e); return { code: x.code, status: x.status, retryable: x.retryable }; };

describe('classify', () => {
  it('the table: every code has the status and retry flag of the spec', () => {
    const want: Record<string, [number, boolean]> = {
      unauthorized: [401, false], forbidden_origin: [403, false], bad_request: [400, false], unsupported_media_type: [415, false], idempotency_key_required: [400, false],
      idempotency_key_reused: [422, false], in_progress: [409, true], outcome_unknown: [409, false], invalid_code: [400, false],
      insufficient_shielded: [409, false], insufficient_wallet_usdg: [409, false], needs_sol: [409, false], cap_per_deposit: [409, false], cap_total: [409, false],
      deposits_paused: [409, false], over_operator_ceiling: [409, false], needs_stake: [409, false], relayer_unavailable: [503, true], relayer_busy: [503, true],
      rate_limited: [429, true], busy: [503, true], stale_root: [409, true], in_flight: [409, true], already_spent: [409, false], simulation_failed: [422, false],
      program_error: [422, false], rpc_unreachable: [502, true], circuits_missing: [503, false], circuit_hash_mismatch: [503, false], not_available: [501, false], internal: [500, false],
    };
    for (const [code, [status, retryable]] of Object.entries(want)) {
      expect(ERROR_CODES[code as keyof typeof ERROR_CODES], code).toMatchObject({ status, retryable });
    }
  });

  it('relayer refusals: 503 busy, 429, 409 stale root / in flight / spent, 422, 403 capacity, other 503s', () => {
    expect(c(new RelayerError(503, 'busy', 'all lanes busy'))).toEqual({ code: 'relayer_busy', status: 503, retryable: true });
    expect(c(new RelayerError(429, 'rate_limited', 'slow down'))).toEqual({ code: 'rate_limited', status: 429, retryable: true });
    expect(c(new RelayerError(409, 'unknown_root', 'x'))).toEqual({ code: 'stale_root', status: 409, retryable: true });
    expect(c(new RelayerError(409, 'stale_timestamp', 'x'))).toEqual({ code: 'stale_root', status: 409, retryable: true });
    expect(c(new RelayerError(409, 'in_flight', 'x'))).toEqual({ code: 'in_flight', status: 409, retryable: true });
    expect(c(new RelayerError(409, 'already_spent', 'x'))).toEqual({ code: 'already_spent', status: 409, retryable: false });
    expect(c(new RelayerError(422, 'simulation_failed', 'x'))).toEqual({ code: 'simulation_failed', status: 422, retryable: false });
    expect(c(new RelayerError(403, 'capacity_required', 'x'))).toEqual({ code: 'needs_stake', status: 409, retryable: false });
    expect(classify(new RelayerError(503, 'relayer_underfunded', 'x'))).toMatchObject({ code: 'relayer_unavailable', details: { reason: 'relayer_underfunded', relayerStatus: 503 } });
    // inside the bank's readable error (explained / a wrapping Error with cause), the code survives
    expect(c(explained(new RelayerError(503, 'busy', 'x')))).toMatchObject({ code: 'relayer_busy' });
    expect(c(new Error('wrapped', { cause: new RelayerError(429, 'rate_limited', 'x') }))).toMatchObject({ code: 'rate_limited' });
    const unreachable = new Error('the relayer https://api.h081.xyz is unreachable (fetch failed). The withdrawal was not sent: retry later, or pass direct: true', { cause: new RelayerUnavailableError('unreachable', 'the relayer is unreachable') });
    expect(classify(unreachable)).toMatchObject({ code: 'relayer_unavailable', status: 503, retryable: true, details: { reason: 'unreachable' } });
    expect(classify(new RelayerUnavailableError('wrong_fee_account', 'names a wrong account'))).toMatchObject({ code: 'relayer_unavailable', details: { reason: 'wrong_fee_account' } });
  });

  it('the RPC fetch failure is rpc_unreachable (502, retryable), with the host only', () => {
    const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8899'), { code: 'ECONNREFUSED' }) });
    expect(c(refused)).toEqual({ code: 'rpc_unreachable', status: 502, retryable: true });
    const typed = new RpcUnreachableError('rpc.example.com', 'ENOTFOUND');
    expect(classify(typed)).toMatchObject({ code: 'rpc_unreachable', message: 'cannot reach the Solana RPC at rpc.example.com: ENOTFOUND. Set H081_RPC_URL.', details: { host: 'rpc.example.com' } });
    expect(c(new TypeError('fetch failed', { cause: new Error('bad port') }))).toMatchObject({ code: 'rpc_unreachable' });
  });

  it('caps, SOL, balances, ceilings, stake and circuits, as the bank words them', () => {
    expect(c(new Error('DepositTooLarge: at most 1000 USDG per deposit (asked 1500).'))).toMatchObject({ code: 'cap_per_deposit', status: 409 });
    expect(c(new Error('DepositCapExceeded: the bank holds at most 10000 USDG in total; 3 USDG of room left.'))).toMatchObject({ code: 'cap_total' });
    expect(c(new Error('DepositsPaused: new deposits are paused for now; withdrawals still work.'))).toMatchObject({ code: 'deposits_paused' });
    const sol = classify(new Error('the agent wallet holds 0.0100 SOL; a grant stages a large proof and needs about 0.1 SOL for buffer rent (refunded) and fees. Nothing was sent.'));
    expect(sol).toMatchObject({ code: 'needs_sol', status: 409, retryable: false, details: { needSol: '0.1', haveSol: '0.0100' } });
    expect(classify(new Error('the agent wallet holds 0.0010 SOL; a deposit needs about 0.02 SOL for buffer rent (refunded) and fees.')).details).toMatchObject({ needSol: '0.02' });
    expect(c(new Error('the shielded balance is 1 USDG, less than 2.'))).toMatchObject({ code: 'insufficient_shielded' });
    expect(c(new Error('the agent wallet 9xQe holds 1 USDG, less than 5.'))).toMatchObject({ code: 'insufficient_wallet_usdg' });
    for (const v of ['H081_MAX_DEPOSIT', 'H081_MAX_PAY', 'H081_MAX_GRANT', 'H081_MAX_LEND']) expect(c(new Error(`over the operator ceiling ${v} (30 USDG). Nothing was sent.`))).toMatchObject({ code: 'over_operator_ceiling' });
    expect(c(new Error('150 USDG is more than the relayer takes with nothing staked (up to 100 USDG per withdrawal; above that, H081 staked in capacity_stake sets a 30-day limit: the agent wallet has none staked). Nothing was sent. Stake more H081 (h081_stake), withdraw at most 100 USDG at a time, or pass direct: true'))).toMatchObject({ code: 'needs_stake' });
    expect(c(new Error('the transact proving artifacts are not in /x (download failed: HTTP 404): run fetch-circuits to download them. Nothing was sent.'))).toMatchObject({ code: 'circuits_missing', status: 503 });
    expect(c(new Error('https://www.h081.xyz/circuits/transact.zkey: sha256 ab does not match the pinned cd; refusing to use it'))).toMatchObject({ code: 'circuit_hash_mismatch' });
  });

  it('an Anchor error: the named caps get their own code, others are program_error with the name in details', () => {
    const cap = classify(explained(new SimulationError({}, poolLogs('0x1795')), { ids }));
    expect(cap).toMatchObject({ code: 'cap_total', status: 409, details: { anchor: 'DepositCapExceeded', errorCode: 6037, program: 'stipend_pool' } });
    expect(classify(explained(new SimulationError({}, poolLogs('0x1782')), { ids }))).toMatchObject({ code: 'already_spent', details: { anchor: 'AlreadySpent' } });
    expect(classify(explained(new SimulationError({}, poolLogs('0x1777')), { ids }))).toMatchObject({ code: 'stale_root', retryable: true });
    const proof = classify(explained(new SimulationError({}, poolLogs('0x1774')), { ids }));
    expect(proof).toMatchObject({ code: 'program_error', status: 422, retryable: false, details: { anchor: 'InvalidProof', program: 'stipend_pool' } });
    expect(classify(new Error('custom program error: 0x2'))).toMatchObject({ code: 'program_error', details: { errorCode: 2 } });
    expect(c(new SimulationError({ err: 'BlockhashNotFound' }, ['Program log: nope']))).toMatchObject({ code: 'simulation_failed' });
  });

  it('input, codes, typed gateway errors and the rest', () => {
    expect(c(new InputError('usdg: a decimal amount like "12.5". Nothing was sent.'))).toMatchObject({ code: 'bad_request', status: 400 });
    expect(c(new CodeError('That shielded address code does not pass its built-in check'))).toMatchObject({ code: 'invalid_code', status: 400 });
    expect(c(new Error('give "amount" (base units) or "usdg" (decimal)'))).toMatchObject({ code: 'bad_request' });
    expect(c(new CodedError('busy', 'queue full', { retryAfter: 5 }))).toEqual({ code: 'busy', status: 503, retryable: true });
    expect(c(new CodedError('not_available', 'close'))).toEqual({ code: 'not_available', status: 501, retryable: false });
    expect(c(new Error('no agent key: run npx -y @h081lll/agent init'))).toMatchObject({ code: 'no_key' });
    expect(c(new Error('something nobody expected'))).toEqual({ code: 'internal', status: 500, retryable: false });
    expect(c('a string')).toEqual({ code: 'internal', status: 500, retryable: false });
  });

  it('the gateway answers with the code\'s HTTP status, Retry-After when it has one, and the RPC host instead of its URL', async () => {
    const bank = stubBank();
    const a = await makeAgent({ bank, env: { H081_RPC_URL: 'https://rpc.example.com/v2/SECRET-API-KEY' } });
    const g = await startGateway(a.h);
    try {
      bank.deposit.mockRejectedValueOnce(new Error('the agent wallet holds 0.0010 SOL; a deposit needs about 0.02 SOL for buffer rent (refunded) and fees.'));
      const r = await g.api('POST', '/v1/deposit', { usdg: '1', confirm: true }, { 'idempotency-key': 'e-1' });
      expect(r.status).toBe(409);
      expect(r.json).toMatchObject({ ok: false, network: 'mainnet-beta', error: { code: 'needs_sol', retryable: false, details: { needSol: '0.02' } } });
      bank.balance.mockRejectedValueOnce(new Error('failed to get info about account: https://rpc.example.com/v2/SECRET-API-KEY returned 500'));
      const leak = await g.api('GET', '/v1/balance?fresh=1');
      expect(leak.status).toBe(500);
      expect(leak.text).not.toContain('SECRET-API-KEY');
      expect(leak.text).toContain('rpc.example.com');
      expect(g.logs.join('\n')).not.toContain('SECRET-API-KEY');
      bank.withdraw.mockRejectedValue(new RelayerError(429, 'rate_limited', 'slow down'));
      const limited = await g.api('POST', '/v1/withdraw', { usdg: '2', to: 'self', confirm: true }, { 'idempotency-key': 'e-2' });
      expect(limited.status).toBe(429);
      expect(limited.json.error).toMatchObject({ code: 'rate_limited', retryable: true });
      expect(bank.withdraw).toHaveBeenCalledTimes(2);
      expect(a.h.events.since(0).filter((e) => e.type === 'op.failed').map((e) => e.data.code)).toEqual(['needs_sol', 'rate_limited']);
    } finally { await g.close(); }
  });
});
