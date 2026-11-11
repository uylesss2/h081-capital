// The MCP server: initialize, tools/list (one tool per operation, with schemas), tools/call success and isError paths,
// unknown tool / method, parse error, batch, stdio framing, lazy bank open, and the cap refusal happening
// before the wallet proves anything (a real H081Bank over a fake connection).
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { Connection, Keypair } from '@solana/web3.js';
import { Prover } from '../../src/prover.js';
import { H081Bank } from '../../integrations/core/bank.js';
import { encodeAddressCode } from '../../integrations/core/codes.js';
import { deriveAccountSk } from '../../integrations/core/keys.js';
import { KEY_HELP } from '../../integrations/core/keys.js';
import { OPS } from '../../integrations/core/schemas.js';
import { INSTRUCTIONS, SERVER_NAME, createServer, h081Tools } from '../../integrations/mcp/src/index.js';
import { fakeConnection, mockBank, testConfig } from './helpers.js';

type CallResult = { isError: boolean; content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> };

describe('h081 MCP server', () => {
  const bank = mockBank();
  const mcp = createServer({ bank: async () => bank });
  const call = async (name: string, args: Record<string, unknown> = {}, id = 1) => {
    const r = await mcp.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    return r!.result as CallResult;
  };

  it('initializes (version negotiation, instructions) and lists one tool per operation with input schemas', async () => {
    const init = await mcp.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    expect(init!.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: SERVER_NAME, version: '0.2.2' }, instructions: INSTRUCTIONS });
    expect(INSTRUCTIONS).toMatch(/not audited yet/);
    const newer = await mcp.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
    expect(newer!.result).toMatchObject({ protocolVersion: '2025-11-25' });
    expect(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
    expect((await mcp.handle({ jsonrpc: '2.0', id: 9, method: 'ping' }))!.result).toEqual({});
    const list = (await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))!.result as { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> };
    expect(list.tools.map((t) => t.name)).toEqual([...OPS]);
    for (const t of list.tools) {
      expect(t.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(t.description.length).toBeGreaterThan(40);
      expect(t).not.toHaveProperty('handler');
    }
    expect(list.tools.find((t) => t.name === 'h081_bank_deposit')!.description).toMatch(/1,000 USDG per deposit/);
    expect((await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'nope' }))!.error!.code).toBe(-32601);
    expect((await mcp.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } }))!.error!.code).toBe(-32602);
    expect((await mcp.handle({ foo: 'bar' }))!.error!.code).toBe(-32600);
  });

  it('tools/call returns structured JSON with amounts as decimal strings', async () => {
    const r = await call('h081_bank_deposit', { usdg: '25' });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({ signature: 'sigDeposit', amount: '25000000', amountUsdg: '25', shielded: '25000000' });
    expect(JSON.parse(r.content[0].text)).toEqual(r.structuredContent);
    expect(bank.deposit).toHaveBeenLastCalledWith(25_000_000n);

    const to = Keypair.generate().publicKey.toBase58();
    expect((await call('h081_bank_withdraw', { amount: '5000000', to })).structuredContent).toMatchObject({ amount: '5000000', fee: '50000', via: 'relayer', to });
    expect((await call('h081_bank_withdraw', { usdg: '5', direct: true })).structuredContent).toMatchObject({ fee: '0', via: 'direct' });
    expect((await call('h081_bank_balance')).structuredContent).toMatchObject({ shieldedUsdg: '25', caps: { total: '10000000000' } });
    expect((await call('h081_loan_quote', { pledgeBps: 4000, minRemaining: '100000000', loanRef: '3' })).structuredContent).toMatchObject({ maxPrincipal: '40000000', originationFee: '100000', loanRef: '3' });
    expect((await call('h081_loan_borrow', { termsCode: 'h081-loan-terms:eyJ2IjoxfQ', budget: '100000000', days: 30, unlockDays: 30 })).structuredContent).toMatchObject({ proofCode: 'h081-loan-proof:eyJ2IjoxfQ', agentIndex: 0 });
    expect((await call('h081_stake', { action: 'stake', amount: '100000000' })).structuredContent).toMatchObject({ signature: 'sigStake', staked: '100000000' });
    expect((await call('h081_stake', { action: 'view' })).structuredContent).toMatchObject({ cooldownDays: 30 });
    expect((await call('h081_protocol_info')).structuredContent).toMatchObject({ cluster: 'mainnet-beta' });
    expect((await call('h081_pay', { usdg: '1', to })).structuredContent).toMatchObject({ signature: 'sigPay', fee: '50000', to, private: false, via: 'relayer', allowanceId: '7', nextAllowanceId: '8', remaining: '1000000' });
    const code = encodeAddressCode(bank.codeContext, { pk: 99n, viewPub: new Uint8Array(32).fill(7) });
    expect((await call('h081_pay', { amount: '1000000', toAddressCode: code })).structuredContent).toMatchObject({ private: true, to: 'shielded', fee: '0' });
    expect(bank.pay).toHaveBeenLastCalledWith({ amount: 1_000_000n, to: { pk: 99n, viewPub: new Uint8Array(32).fill(7) }, allowanceId: undefined, agentIndex: undefined, direct: false, allowPledged: false });

    // allowances: a plan without confirm, the send with it; ids as decimal strings
    expect((await call('h081_allowance_grant', { usdg: '50', agentIndex: 1, windowCapUsdg: '10', days: 30 })).structuredContent).toMatchObject({ sent: false, dryRun: true, plan: { rules: { amount: '50000000' } } });
    expect(bank.allowanceGrant).toHaveBeenLastCalledWith({ amount: 50_000_000n, to: undefined, agentIndex: 1, windowCap: 10_000_000n, windowLen: undefined, maxPerTx: undefined, days: 30, unlockDays: undefined, confirm: false });
    expect((await call('h081_allowance_grant', { usdg: '5', toAddressCode: code, confirm: true })).structuredContent).toMatchObject({ sent: true, signature: 'sigGrant', allowanceId: '11' });
    expect(bank.allowanceGrant.mock.lastCall![0]).toMatchObject({ to: { pk: 99n }, agentIndex: undefined, confirm: true });
    expect((await call('h081_allowance_delegate', { allowanceId: '7', agentIndex: 1, toAgentIndex: 2, usdg: '1', maxPerTxUsdg: '0.5', confirm: true })).structuredContent).toMatchObject({ sent: true, parentId: '7', allowanceId: '12', residualId: '13' });
    expect(bank.allowanceDelegate).toHaveBeenLastCalledWith({ allowanceId: 7n, agentIndex: 1, toAgentIndex: 2, to: undefined, amount: 1_000_000n, windowCap: undefined, maxPerTx: 500_000n, days: undefined, unlockDays: undefined, confirm: true });
    expect((await call('h081_allowance_reclaim', { allowanceId: '11' })).structuredContent).toMatchObject({ sent: false, dryRun: true, plan: { allowanceId: '11' } });
    expect((await call('h081_allowance_reclaim', { allowanceId: '11', confirm: true })).structuredContent).toMatchObject({ sent: true, reclaimed: '5000000' });
  });

  it('allowance tools refuse bad arguments as readable tool errors, and their descriptions say nothing is sent without confirm', async () => {
    expect((await call('h081_allowance_delegate', { allowanceId: '7', usdg: '1' })).content[0].text).toMatch(/exactly one recipient for the child/);
    expect((await call('h081_allowance_delegate', { allowanceId: '0x7', toAgentIndex: 1, usdg: '1' })).content[0].text).toMatch(/decimal id/);
    expect((await call('h081_allowance_grant', { usdg: '1', toAddressCode: 'h081-loan-terms:eyJ2IjoxfQ' })).content[0].text).toMatch(/not a shielded address code/);
    expect((await call('h081_allowance_grant', { usdg: '1', agentIndex: 16 })).content[0].text).toMatch(/agentIndex must be 0\.\.15/);
    expect((await call('h081_allowance_reclaim', {})).content[0].text).toMatch(/allowanceId is required/);
    bank.allowanceDelegate.mockRejectedValueOnce(new Error('the parent has 5 USDG left; a child can never get more than its parent has. Nothing was sent.'));
    const looser = await call('h081_allowance_delegate', { allowanceId: '7', toAgentIndex: 1, usdg: '6', confirm: true });
    expect(looser).toMatchObject({ isError: true });
    expect(looser.content[0].text).toMatch(/never get more than its parent.*Nothing was sent/);
    const list = (await mcp.handle({ jsonrpc: '2.0', id: 5, method: 'tools/list' }))!.result as { tools: Array<{ name: string; description: string }> };
    for (const name of ['h081_allowance_grant', 'h081_allowance_delegate', 'h081_allowance_reclaim']) {
      const d = list.tools.find((t) => t.name === name)!.description;
      expect(d).toMatch(/WITHOUT `confirm: true` NOTHING IS SENT/);
      expect(d).toMatch(/not audited yet/);
    }
    expect(list.tools.find((t) => t.name === 'h081_allowance_grant')!.description).toMatch(/H081_MAX_GRANT/);
    expect(list.tools.find((t) => t.name === 'h081_allowance_delegate')!.description).toMatch(/never be looser than its parent/);
  });

  it('h081_lend: open and fund return a plan unless confirm; status, claim, collect, settle reach the bank; bad arguments are tool errors', async () => {
    expect((await call('h081_lend', { action: 'open', pledgeBps: 4000 })).structuredContent).toMatchObject({ sent: false, dryRun: true, plan: { loanRef: '3', pledgeBps: '4000' } });
    expect(bank.lendOpen).toHaveBeenLastCalledWith({ pledgeBps: 4000n, confirm: false });
    expect((await call('h081_lend', { action: 'open', pledgeBps: 4000, confirm: true })).structuredContent).toMatchObject({ sent: true, loanRef: '3', termsCode: 'h081-loan-terms:4mD9q' });
    expect((await call('h081_lend', { action: 'fund', proofCode: 'h081-loan-proof:abc', principalUsdg: '40' })).structuredContent).toMatchObject({ sent: false, plan: { principal: '40000000' } });
    expect(bank.lendFund).toHaveBeenLastCalledWith({ proofCode: 'h081-loan-proof:abc', loanRef: undefined, principal: 40_000_000n, pledgeBps: undefined, confirm: false });
    expect((await call('h081_lend', { action: 'fund', proofCode: 'h081-loan-proof:abc', loanRef: '3', pledgeBps: 4000, confirm: true })).structuredContent).toMatchObject({ sent: true, signature: 'sigFund' });
    expect(bank.lendFund).toHaveBeenLastCalledWith({ proofCode: 'h081-loan-proof:abc', loanRef: 3n, principal: undefined, pledgeBps: 4000n, confirm: true });
    expect((await call('h081_lend', { action: 'status' })).structuredContent).toMatchObject({ slots: [{ loanRef: '3', claimable: '1000000' }] });
    expect(bank.lendStatus).toHaveBeenLastCalledWith({ loanRef: undefined, pledgeBps: undefined });
    expect((await call('h081_lend', { action: 'claim', loanRef: '3', usdg: '0.5' })).structuredContent).toMatchObject({ sent: true, collected: '500000' });
    expect((await call('h081_lend', { action: 'collect', loanRef: '3' })).structuredContent).toMatchObject({ signatures: ['sigSync'] });
    expect((await call('h081_lend', { action: 'settle', loanRef: '3' })).structuredContent).toMatchObject({ sent: false, dryRun: true });
    expect((await call('h081_lend', { action: 'close', loanRef: '3', confirm: true })).structuredContent).toMatchObject({ sent: true, action: 'close' });
    expect((await call('h081_lend', { action: 'fund' })).content[0].text).toMatch(/proofCode .* is required/);
    expect((await call('h081_lend', { action: 'open', pledgeBps: 9500 })).content[0].text).toMatch(/100\.\.9000/);
    expect((await call('h081_lend', { action: 'settle' })).content[0].text).toMatch(/loanRef is required/);
    bank.lendFund.mockRejectedValueOnce(new Error('over the operator ceiling H081_MAX_LEND (30 USDG per loan; this proof asks for 40 USDG). Nothing was sent.'));
    const capped = await call('h081_lend', { action: 'fund', proofCode: 'h081-loan-proof:abc', confirm: true });
    expect(capped).toMatchObject({ isError: true });
    expect(capped.content[0].text).toMatch(/H081_MAX_LEND.*Nothing was sent/);
    // the same stable code and retry flag as the local API
    expect(capped.structuredContent).toMatchObject({ error: { code: 'over_operator_ceiling', retryable: false } });
    expect((await call('h081_lend', { action: 'fund' })).structuredContent).toMatchObject({ error: { code: 'bad_request', retryable: false } });
    expect((await call('h081_transfer', { usdg: '1', toAddressCode: 'h081-address:abc' })).structuredContent).toMatchObject({ amount: '1000000', to: 'shielded' });
    expect(bank.transfer).toHaveBeenLastCalledWith(1_000_000n, 'h081-address:abc');
    const d = ((await mcp.handle({ jsonrpc: '2.0', id: 6, method: 'tools/list' }))!.result as { tools: Array<{ name: string; description: string }> }).tools.find((t) => t.name === 'h081_lend')!.description;
    expect(d).toMatch(/WITHOUT `confirm: true` open, fund, settle and close send NOTHING/);
    expect(d).toMatch(/H081_MAX_LEND/);
    expect(d).toMatch(/agent wallet is public as the lender/);
    expect(d).toMatch(/not audited yet/);
    expect(INSTRUCTIONS).toMatch(/h081_lend/);
  });

  it('MCP validates arguments with the same schema as the Agent Kit: stray or misplaced fields are refused before the bank is called', async () => {
    const calls = () => bank.lendFund.mock.calls.length + bank.lendClaim.mock.calls.length + bank.pay.mock.calls.length;
    const before = calls();
    // a stated loan amount as usdg/amount on fund is not silently dropped
    const fund = await call('h081_lend', { action: 'fund', proofCode: 'h081-loan-proof:abc', usdg: '10', confirm: true });
    expect(fund.isError).toBe(true);
    expect(fund.content[0].text).toMatch(/each action takes only its own fields.*Nothing was sent/);
    // claim has no plan step: confirm is refused, not ignored
    expect((await call('h081_lend', { action: 'claim', loanRef: '3', confirm: false })).content[0].text).toMatch(/each action takes only its own fields/);
    // pay has no plan step: confirm: false does not quietly pay
    const pay = await call('h081_pay', { usdg: '50', to: Keypair.generate().publicKey.toBase58(), confirm: false });
    expect(pay.isError).toBe(true);
    expect(pay.content[0].text).toMatch(/Unrecognized key.*confirm.*Nothing was sent/);
    expect((await call('h081_bank_deposit', { usdg: '1', extra: 1 })).content[0].text).toMatch(/Unrecognized key/);
    expect(calls()).toBe(before);
  });

  it('a send that fails mid-way is outcome_unknown (not retryable) so the model does not pay twice; a read stays retryable', async () => {
    const reset = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
    const b = mockBank({ withdraw: vi.fn(async () => { throw reset(); }), balance: vi.fn(async () => { throw reset(); }) } as never);
    const server = createServer({ bank: async () => b });
    const run = async (name: string, args: Record<string, unknown>) => (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }))!.result as CallResult;
    const w = await run('h081_bank_withdraw', { usdg: '2', to: Keypair.generate().publicKey.toBase58() });
    expect(w.isError).toBe(true);
    expect(w.structuredContent).toMatchObject({ error: { code: 'outcome_unknown', retryable: false } });
    expect(w.structuredContent).not.toHaveProperty('text');
    expect(w.content[0].text).toMatch(/outcome is unknown: check the balance .* before retrying/);
    const r = await run('h081_bank_balance', {});
    expect(r.structuredContent).toMatchObject({ error: { code: 'rpc_unreachable', retryable: true } });
    expect(r.content[0].text).toBe('fetch failed');
  });

  it('a bad argument or a bank refusal is a tool result with isError, not a protocol error', async () => {
    const both = await call('h081_bank_deposit', { usdg: '1', amount: '1' });
    expect(both.isError).toBe(true);
    expect(both.content[0].text).toMatch(/not both/);
    expect((await call('h081_bank_withdraw', { usdg: '1', to: 'nope' })).content[0].text).toMatch(/base58/);
    expect((await call('h081_stake', { action: 'melt' })).content[0].text).toMatch(/action must be one of/);
    expect((await call('h081_loan_borrow', { budget: '1', days: 1, unlockDays: 1 })).content[0].text).toMatch(/termsCode/);
    expect((await call('h081_pay', { usdg: '1', toAddressCode: 'h081-address:3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy' })).content[0].text).toMatch(/does not pass its built-in check|too short/);
    expect((await call('h081_pay', { usdg: '1', toAddressCode: 'h081-loan-terms:eyJ2IjoxfQ' })).content[0].text).toMatch(/not a shielded address code/);
    expect((await call('h081_pay', { usdg: '1' })).content[0].text).toMatch(/exactly one recipient/);
    bank.pay.mockRejectedValueOnce(new Error('no allowance can pay 1 USDG now. Nothing was sent. allowance 7: over its per-payment cap (maxPerTx 0.5 USDG)'));
    const capped = await call('h081_pay', { usdg: '1', to: Keypair.generate().publicKey.toBase58() });
    expect(capped).toMatchObject({ isError: true });
    expect(capped.content[0].text).toMatch(/Nothing was sent.*maxPerTx/);
    bank.withdraw.mockRejectedValueOnce(new Error('the relayer refused it (402 fee_too_low): fee 1 is below 50000'));
    const refused = await call('h081_bank_withdraw', { usdg: '1' });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content[0].text).toMatch(/fee_too_low/);
  });

  it('the bank opens lazily: tools/list works without a key and a missing key is a readable tool error', async () => {
    let opened = 0;
    const lazy = createServer({ bank: async () => { opened++; throw new Error(`no agent key: ${KEY_HELP}`); } });
    const list = (await lazy.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))!.result as { tools: unknown[] };
    expect(list.tools).toHaveLength(OPS.length);
    expect(opened).toBe(0);
    const r = (await lazy.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'h081_bank_balance', arguments: {} } }))!.result as CallResult;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/H081_SOLANA_KEYPAIR/);
    expect(opened).toBe(1);
  });

  it('serves newline-delimited JSON-RPC over stdio streams: parse errors, notifications, batches', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on('data', (d: Buffer) => lines.push(...d.toString().split('\n').filter(Boolean)));
    const done = mcp.serveStdio(input, output);
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    input.write('{not json\n');
    input.write('\n');
    input.write(JSON.stringify([{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'h081_bank_balance', arguments: {} } }, { jsonrpc: '2.0', id: 3, method: 'ping' }]) + '\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'h081_bank_deposit', arguments: { amount: '1000000' } } }) + '\n');
    input.end();
    await done;
    const msgs = lines.map((l) => JSON.parse(l));
    expect(msgs).toHaveLength(4);
    expect(msgs[0]).toMatchObject({ id: 1, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'h081' } } });
    expect(msgs[1]).toMatchObject({ id: null, error: { code: -32700 } });
    expect(msgs[2]).toEqual([expect.objectContaining({ id: 2, result: expect.objectContaining({ isError: false }) }), { jsonrpc: '2.0', id: 3, result: {} }]);
    expect(msgs[3]).toMatchObject({ id: 4, result: { isError: false, structuredContent: { amount: '1000000', amountUsdg: '1' } } });
  });

  it('h081_bank_deposit over the cap is refused by the real bank before any proof (fake chain, no wallet call)', async () => {
    const signer = Keypair.generate();
    const conn = fakeConnection(signer, { inVault: 9_900_000_000n, walletUsdg: 5_000_000_000n, paused: false });
    const real = await H081Bank.open({
      config: testConfig(), signer, accountSk: deriveAccountSk(signer), connection: conn as unknown as Connection, prover: new Prover('C:/nonexistent'), cacheDir: null,
    });
    const spy = vi.spyOn(real.owner, 'deposit');
    const server = createServer({ bank: async () => real });
    const callReal = async (args: Record<string, unknown>) => (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'h081_bank_deposit', arguments: args } }))!.result as CallResult;
    const big = await callReal({ usdg: '1000.000001' });
    expect(big.isError).toBe(true);
    expect(big.content[0].text).toMatch(/DepositTooLarge/);
    const full = await callReal({ usdg: '200' });
    expect(full.isError).toBe(true);
    expect(full.content[0].text).toMatch(/DepositCapExceeded.*100 USDG of room left/);
    expect(spy).not.toHaveBeenCalled();
    expect(conn.simulateTransaction).not.toHaveBeenCalled();
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
    // the tools of a real bank are the same ones
    expect(h081Tools({ bank: async () => real }).map((t) => t.name)).toEqual([...OPS]);
  });
});
