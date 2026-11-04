// The MCP server: initialize, tools/list (7 tools with schemas), tools/call success and isError paths,
// unknown tool / method, parse error, batch, stdio framing, lazy bank open, and the cap refusal happening
// before the wallet proves anything (a real H081Bank over a fake connection).
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { Connection, Keypair } from '@solana/web3.js';
import { Prover } from '../../src/prover.js';
import { H081Bank } from '../../integrations/core/bank.js';
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

  it('initializes (version negotiation, instructions) and lists the seven tools with input schemas', async () => {
    const init = await mcp.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    expect(init!.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: SERVER_NAME, version: '0.1.0' }, instructions: INSTRUCTIONS });
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
  });

  it('a bad argument or a bank refusal is a tool result with isError, not a protocol error', async () => {
    const both = await call('h081_bank_deposit', { usdg: '1', amount: '1' });
    expect(both.isError).toBe(true);
    expect(both.content[0].text).toMatch(/not both/);
    expect((await call('h081_bank_withdraw', { usdg: '1', to: 'nope' })).content[0].text).toMatch(/base58/);
    expect((await call('h081_stake', { action: 'melt' })).content[0].text).toMatch(/action must be one of/);
    expect((await call('h081_loan_borrow', { budget: '1', days: 1, unlockDays: 1 })).content[0].text).toMatch(/termsCode/);
    bank.withdraw.mockRejectedValueOnce(new Error('the relayer refused it (402 fee_too_low): fee 1 is below 50000'));
    const refused = await call('h081_bank_withdraw', { usdg: '1' });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content[0].text).toMatch(/fee_too_low/);
  });

  it('the bank opens lazily: tools/list works without a key and a missing key is a readable tool error', async () => {
    let opened = 0;
    const lazy = createServer({ bank: async () => { opened++; throw new Error(`no agent key: ${KEY_HELP}`); } });
    const list = (await lazy.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))!.result as { tools: unknown[] };
    expect(list.tools).toHaveLength(7);
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
    // the tools of a real bank are the same seven
    expect(h081Tools({ bank: async () => real }).map((t) => t.name)).toEqual([...OPS]);
  });
});
