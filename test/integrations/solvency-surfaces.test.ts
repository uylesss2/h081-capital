// The four solvency operations on every surface, over a mocked bank: the operation table (argument parsing and
// refusals), MCP (tools, send classification, the default pre-deal wording), the Agent Kit plugin, the @h081lll/agent
// SDK (plan vs done vs sent), the local API routes and the CLI. Codes are checked by kind and network.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { encodeSolvencyCode, encodeSolvencyRequest } from '../../integrations/core/codes.js';
import { MAINNET } from '../../integrations/core/constants.js';
import { runOp, validateArgs } from '../../integrations/core/operations.js';
import { DESCRIPTIONS, OPS } from '../../integrations/core/schemas.js';
import { SOLVENCY_DOES_NOT_SAY } from '../../src/solvency.js';
import { INSTRUCTIONS, createServer } from '../../integrations/mcp/src/index.js';
import { sends } from '../../integrations/mcp/src/server.js';
import H081Plugin from '../../integrations/solana-agent-kit/src/index.js';
import { checkCode } from '../../integrations/agent/src/h081.js';
import { main } from '../../integrations/agent/src/cli.js';
import { configFromEnv } from '../../integrations/core/constants.js';
import { mockBank } from './helpers.js';
import { makeAgent, startGateway, stubBank, tempHome, type AgentSetup, type Gateway } from './agent-helpers.js';

const POOL_CTX = { cluster: 'mainnet-beta', program: MAINNET.programs.pool, mint: MAINNET.usdg.mint };
const ask = encodeSolvencyRequest(POOL_CTX, {
  verifierKey: new Uint8Array(32).fill(7), nonce: new Uint8Array(16).fill(9), expiry: 1_900_000_600n, min: 2_500_000_000n, maxRootAge: 32, expectWallet: new Uint8Array(32), label: 'acme',
}).code;
const code = encodeSolvencyCode(POOL_CTX, { requestDigest: new Uint8Array(32), proof: new Uint8Array(256), args: new Uint8Array(192), wallet: new Uint8Array(32).fill(1), signature: new Uint8Array(64) });
const NEW = ['h081_solvency_request', 'h081_prove_solvency', 'h081_verify_solvency', 'h081_solvency_reserve'] as const;

describe('solvency operations', () => {
  it('are in the operation table; every description says what a proof does not say', () => {
    for (const op of NEW) expect(OPS).toContain(op);
    for (const op of ['h081_solvency_request', 'h081_prove_solvency', 'h081_verify_solvency'] as const) {
      for (const x of SOLVENCY_DOES_NOT_SAY) expect(DESCRIPTIONS[op]).toContain(x);
    }
    expect(DESCRIPTIONS.h081_solvency_request).toMatch(/Default first step before any deal/);
    expect(DESCRIPTIONS.h081_prove_solvency).toMatch(/WITHOUT `confirm: true` NOTHING IS SENT/);
    expect(DESCRIPTIONS.h081_prove_solvency).toMatch(/LOCALLY/);
    expect(DESCRIPTIONS.h081_solvency_reserve).toMatch(/WITHOUT `confirm: true` NOTHING IS SENT/);
  });

  it('parse their arguments and refuse what they should', async () => {
    const bank = mockBank();
    await runOp(bank, 'h081_solvency_request', { minUsdg: '2500', label: 'acme' });
    expect(bank.solvencyRequest).toHaveBeenCalledWith(expect.objectContaining({ min: 2_500_000_000n, label: 'acme' }));
    await runOp(bank, 'h081_prove_solvency', { request: ask, amountUsdg: '5000' });
    expect(bank.proveSolvency).toHaveBeenCalledWith({ request: ask, amount: 5_000_000_000n, confirm: false });
    await runOp(bank, 'h081_verify_solvency', { code, request: ask, onChain: 'simulate', feePayer: 'E1ZAVTjMEAtPoUPAfsLrfJHpTXNtdmzgBWuZtUM1uKKv' });
    expect(bank.verifySolvency).toHaveBeenCalledWith(code, { request: ask, onChain: 'simulate', allowUnboundAsset: false, feePayer: 'E1ZAVTjMEAtPoUPAfsLrfJHpTXNtdmzgBWuZtUM1uKKv' });
    await runOp(bank, 'h081_solvency_reserve', { release: true });
    expect(bank.solvencyReserve).toHaveBeenLastCalledWith({ release: true });
    expect(() => validateArgs('h081_solvency_request', { min: '1', minUsdg: '1' })).toThrow(/exactly one/);
    expect(() => validateArgs('h081_solvency_request', { minUsdg: '1', ttlMinutes: 2000 })).toThrow(/at most a day/);
    expect(() => validateArgs('h081_prove_solvency', {})).toThrow(/request/);
    expect(() => validateArgs('h081_verify_solvency', { code })).toThrow(/request/);
    expect(() => validateArgs('h081_verify_solvency', { code, request: ask, feePayer: 'E1ZAVTjMEAtPoUPAfsLrfJHpTXNtdmzgBWuZtUM1uKKv' })).toThrow(/simulate/);
    expect(() => validateArgs('h081_solvency_reserve', { confirm: true })).toThrow(/release/);
  });

  it('MCP: four tools; only a confirmed top-up/release or an on-chain send counts as a send; the instructions make it the default pre-deal step', async () => {
    const bank = mockBank();
    const mcp = createServer({ bank: async () => bank });
    const list = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))!.result as { tools: Array<{ name: string }> };
    for (const op of NEW) expect(list.tools.map((t) => t.name)).toContain(op);
    const r = (await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'h081_prove_solvency', arguments: { request: ask } } }))!.result as { isError: boolean; structuredContent: Record<string, unknown> };
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({ sent: false, dryRun: true });
    expect(sends('h081_solvency_request')).toBe(false);
    expect(sends('h081_prove_solvency', { request: ask })).toBe(false);
    expect(sends('h081_prove_solvency', { request: ask, confirm: true })).toBe(true);
    expect(sends('h081_verify_solvency', { code, request: ask, onChain: 'simulate' })).toBe(false);
    expect(sends('h081_verify_solvency', { code, request: ask, onChain: 'send' })).toBe(true);
    expect(sends('h081_solvency_reserve', {})).toBe(false);
    expect(sends('h081_solvency_reserve', { release: true, confirm: true })).toBe(true);
    expect(INSTRUCTIONS).toMatch(/default first step is a solvency check/);
  });

  it('Agent Kit: four actions and methods', () => {
    const names = H081Plugin.actions.map((a) => a.name);
    for (const n of ['H081_SOLVENCY_REQUEST', 'H081_PROVE_SOLVENCY', 'H081_VERIFY_SOLVENCY', 'H081_SOLVENCY_RESERVE']) expect(names).toContain(n);
    for (const m of ['h081SolvencyRequest', 'h081ProveSolvency', 'h081VerifySolvency', 'h081SolvencyReserve']) expect(typeof (H081Plugin.methods as Record<string, unknown>)[m]).toBe('function');
  });

  it('checkCode reads kinds 10 and 11 and names the network', () => {
    const cfg = configFromEnv({});
    expect(checkCode(cfg, ask)).toEqual({ kind: 'solvency-request', network: 'mainnet-beta', valid: true });
    expect(checkCode(cfg, code)).toEqual({ kind: 'solvency', network: 'mainnet-beta', valid: true });
    const local = encodeSolvencyRequest({ ...POOL_CTX, cluster: 'localnet' }, {
      verifierKey: new Uint8Array(32), nonce: new Uint8Array(16), expiry: 1n, min: 1n, maxRootAge: 1, expectWallet: new Uint8Array(32), label: '',
    }).code;
    expect(checkCode(cfg, local)).toMatchObject({ kind: 'solvency-request', valid: false, network: 'unknown' });
  });
});

describe('@h081lll/agent: SDK, local API and CLI', () => {
  let a: AgentSetup;
  let g: Gateway;
  beforeAll(async () => { a = await makeAgent(); g = await startGateway(a.h); });
  afterAll(async () => { await g.close(); });

  it('balance shows the reserve (and null without one)', async () => {
    expect((await a.h.balance({ fresh: true })).reserve).toBeNull();
    const withReserve = await makeAgent({ bank: stubBank({ balance: async () => ({ shielded: 1n, shieldedUsdg: '0.000001', walletUsdg: 0n, walletUsdgHuman: '0', walletSol: 0.1, subAccounts: [], agentAllowances: [], grantedToOthers: [], heldBySubAccounts: [], reserve: { id: 5n, remaining: 2_500_000_000n, remainingUsdg: '2500' }, caps: null }) }) });
    expect((await withReserve.h.balance({ fresh: true })).reserve).toEqual({ id: '5', remaining: '2500' });
  });

  it('the SDK: a request, a plan when the reserve needs a top-up, the code once confirmed, a verify', async () => {
    expect(await a.h.solvencyRequest({ min: '2500', label: 'acme' })).toMatchObject({ code: expect.stringMatching(/^h081-solvency-ask:/) });
    const plan = await a.h.proveSolvency(ask);
    expect(plan.status).toBe('plan');
    expect(plan.result).toMatchObject({ op: 'solvency reserve top-up', sentBy: 'agent key' });
    const sent = await a.h.proveSolvency(ask, { confirm: true, idempotencyKey: 'solv-1' });
    expect(sent).toMatchObject({ status: 'sent', result: { code: 'h081-solvency:7Yk3LmQ9pR2' } });
    expect(await a.h.verifySolvency(code, { request: ask })).toMatchObject({ ok: true });
    await expect(a.h.verifySolvency(code, { request: ask, onChain: 'send' })).rejects.toThrow(/confirm: true/);
    await expect(a.h.proveSolvency(code)).rejects.toThrow(/h081-solvency-ask:/);
    expect(await a.h.releaseReserve()).toMatchObject({ status: 'plan' });
  });

  it('the local API: request, prove (plan), verify, reserve, release (plan)', async () => {
    const r1 = await g.api('POST', '/v1/solvency/request', { min: '2500' });
    expect(r1.json).toMatchObject({ ok: true, status: 'done', result: { minUsdg: '2500' } });
    const r2 = await g.api('POST', '/v1/solvency/prove', { request: ask });
    expect(r2.json).toMatchObject({ ok: true, status: 'plan' });
    const r3 = await g.api('POST', '/v1/solvency/prove', { request: ask, confirm: true });
    expect(r3.json.error.code).toBe('idempotency_key_required');
    const r4 = await g.api('POST', '/v1/solvency/verify', { code, request: ask, onChain: 'simulate' });
    expect(r4.json).toMatchObject({ ok: true, status: 'done', result: { ok: true, onChain: { mode: 'simulate' } } });
    const r5 = await g.api('POST', '/v1/solvency/verify', { code, request: ask, onChain: 'send' });
    expect(r5.status).toBe(400);
    expect((await g.api('GET', '/v1/solvency/reserve')).json).toMatchObject({ ok: true, result: { reserve: { remainingUsdg: '2500' } } });
    expect((await g.api('POST', '/v1/solvency/reserve/release', {})).json).toMatchObject({ ok: true, status: 'plan' });
    expect((await g.api('POST', '/v1/codes/check', { code: ask })).json.result).toMatchObject({ kind: 'solvency-request', valid: true });
  });

  it('the CLI: solvency ask | prove | verify | reserve', async () => {
    const out: string[] = [];
    const run = (argv: string[]) => main([...argv, '--json'], { env: { H081_HOME: tempHome() }, stdout: (s) => out.push(s), stderr: () => {}, open: async () => a.h, platform: 'linux' });
    expect(await run(['solvency', 'ask', '2500', '--label', 'acme'])).toBe(0);
    expect(JSON.parse(out.pop()!).result.minUsdg).toBe('2500');
    expect(await run(['solvency', 'prove', ask])).toBe(0);
    expect(JSON.parse(out.pop()!).status).toBe('plan');
    expect(await run(['solvency', 'verify', code, '--ask', ask, '--simulate'])).toBe(0);
    expect(JSON.parse(out.pop()!).result).toMatchObject({ ok: true, onChain: { mode: 'simulate' } });
    expect(await run(['solvency', 'verify', code])).toBe(2);
    expect(await run(['solvency', 'reserve'])).toBe(0);
    expect(JSON.parse(out.pop()!).result.reserve.remainingUsdg).toBe('2500');
    expect(await run(['solvency', 'reserve', '--release'])).toBe(0);
    expect(JSON.parse(out.pop()!).status).toBe('plan');
    expect(Keypair).toBeDefined();
  });
});
