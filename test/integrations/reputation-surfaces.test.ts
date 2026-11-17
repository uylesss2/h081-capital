// The one-call reputation API on every surface: proveReputation({ audience, minLoans, minVolume }) (and the verifier's
// nonce) through the operation schema, MCP, the Agent Kit plugin, @h081lll/agent and its local HTTP API, with the first
// release's minVolumeUsdg / monthFloorUsdg still accepted as aliases. A stub bank records what reaches it; no chain.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { KeypairWallet, SolanaAgentKit, type Action } from 'solana-agent-kit';
import { runOp } from '../../integrations/core/operations.js';
import { JSON_SCHEMA, ProveRepZ, RepRequestZ, VerifyRepZ } from '../../integrations/core/schemas.js';
import { createServer } from '../../integrations/mcp/src/index.js';
import H081Plugin, { H081_ACTIONS, resetBank, setBankProvider } from '../../integrations/solana-agent-kit/src/index.js';
import { makeAgent, startGateway, stubBank, type Gateway } from './agent-helpers.js';
import { mockBank } from './helpers.js';

const PROVED = { code: 'h081-rep:7Yk3LmQ9pR2', presentation: 'h081-rep-sig:3Df8Kq2', audience: '0x01', nonce: '0x1234', presNullifier: '0x02', expiresAt: 1, counted: { loans: 3 } };
const withRep = () => ({
  proveReputation: vi.fn(async () => PROVED),
  reputationRequest: vi.fn(async () => ({ code: 'h081-rep-ask:5Hq2Vb7Zr9KcTmW3xLpN4' })),
});
/** What the bank received for the volume and floor, aliases folded. */
const thresholdsSeen = (fn: ReturnType<typeof vi.fn>) => {
  const a = fn.mock.calls.at(-1)![0] as Record<string, unknown>;
  return { audience: a.audience, minLoans: a.minLoans, minVolume: a.minVolume, monthFloor: a.monthFloor, nonce: a.nonce };
};

describe('the operation schema: minVolume / monthFloor, their aliases, and the prover-side nonce', () => {
  it('accepts the one-call shape and the old names; refuses both of a pair, and a nonce or thresholds next to a request', () => {
    expect(ProveRepZ.safeParse({ audience: 'acme-desk', minLoans: 3, minVolume: '500' }).success).toBe(true);
    expect(ProveRepZ.safeParse({ audience: 'acme-desk', minLoans: 3, minVolumeUsdg: '500', monthFloorUsdg: '50', minMonths: 3 }).success).toBe(true);
    expect(ProveRepZ.safeParse({ audience: 'acme-desk', minVolume: '500', nonce: '0x1234' }).success).toBe(true);
    const both = ProveRepZ.safeParse({ audience: 'acme-desk', minVolume: '500', minVolumeUsdg: '500' });
    expect(both.success).toBe(false);
    expect(JSON.stringify(both.error)).toMatch(/not both/);
    expect(RepRequestZ.safeParse({ audience: 'a', monthFloor: '5', monthFloorUsdg: '5' }).success).toBe(false);
    expect(ProveRepZ.safeParse({ request: 'h081-rep-ask:x', nonce: '0x1' }).success).toBe(false);
    expect(ProveRepZ.safeParse({ request: 'h081-rep-ask:x', minVolume: '1' }).success).toBe(false);
    expect(ProveRepZ.safeParse({ audience: 'a', minVolume: '5 USDG' }).success).toBe(false);
    expect(ProveRepZ.safeParse({ audience: 'a', nonce: 'abc' }).success).toBe(false);
    expect(VerifyRepZ.safeParse({ code: 'c', audience: 'a', nonce: '0x' + 'f'.repeat(63) }).success).toBe(false);
    const props = (JSON_SCHEMA.h081_prove_reputation as { properties: Record<string, unknown> }).properties;
    for (const k of ['audience', 'minLoans', 'minVolume', 'monthFloor', 'minVolumeUsdg', 'monthFloorUsdg', 'nonce']) expect(props).toHaveProperty(k);
  });

  it('runOp folds an alias into minVolume / monthFloor before the bank sees it', async () => {
    const bank = { ...mockBank(), ...withRep() };
    await runOp(bank as never, 'h081_prove_reputation', { audience: 'acme-desk', minLoans: 3, minVolume: '500', nonce: '0x1234' });
    expect(thresholdsSeen(bank.proveReputation)).toEqual({ audience: 'acme-desk', minLoans: 3, minVolume: '500', monthFloor: undefined, nonce: '0x1234' });
    await runOp(bank as never, 'h081_prove_reputation', { audience: 'acme-desk', minVolumeUsdg: '250', monthFloorUsdg: '10' });
    expect(thresholdsSeen(bank.proveReputation)).toMatchObject({ minVolume: '250', monthFloor: '10' });
    await runOp(bank as never, 'h081_reputation_request', { audience: 'acme-desk', minVolume: '100' });
    expect(thresholdsSeen(bank.reputationRequest)).toMatchObject({ minVolume: '100' });
  });
});

describe('MCP: h081_prove_reputation with the one-call arguments', () => {
  it('reaches the bank with minVolume; the alias still works; both at once is a tool error', async () => {
    const bank = { ...mockBank(), ...withRep() };
    const mcp = createServer({ bank: async () => bank as never });
    const call = async (args: Record<string, unknown>) => (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'h081_prove_reputation', arguments: args } }))!.result as { isError: boolean; content: Array<{ text: string }> };
    expect((await call({ audience: 'acme-desk', minLoans: 3, minVolume: '500' })).isError).toBe(false);
    expect(thresholdsSeen(bank.proveReputation)).toMatchObject({ minLoans: 3, minVolume: '500' });
    expect((await call({ audience: 'acme-desk', minVolumeUsdg: '700' })).isError).toBe(false);
    expect(thresholdsSeen(bank.proveReputation)).toMatchObject({ minVolume: '700' });
    const bad = await call({ audience: 'acme-desk', minVolume: '1', minVolumeUsdg: '1' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/not both/);
  });
});

describe('Agent Kit: H081_PROVE_REPUTATION', () => {
  let bank: ReturnType<typeof mockBank> & ReturnType<typeof withRep>;
  const kp = Keypair.generate();
  const agent = new SolanaAgentKit(new KeypairWallet(kp, 'http://127.0.0.1:1'), 'http://127.0.0.1:1', {}).use(H081Plugin);
  beforeEach(() => { bank = { ...mockBank(), ...withRep() }; setBankProvider(async () => bank as never); });
  afterEach(() => { setBankProvider(undefined); resetBank(agent); });

  it('the action and the method both take { audience, minLoans, minVolume }', async () => {
    const act = H081_ACTIONS.find((a) => a.name === 'H081_PROVE_REPUTATION') as Action;
    expect(await act.handler(agent, { audience: 'acme-desk', minLoans: 3, minVolume: '500' })).toMatchObject({ status: 'success', code: PROVED.code });
    expect(thresholdsSeen(bank.proveReputation)).toMatchObject({ minLoans: 3, minVolume: '500' });
    await (agent.methods as Record<string, (a: unknown, i: unknown) => Promise<unknown>>).h081ProveReputation(agent, { audience: 'acme-desk', minLoans: 2, minVolumeUsdg: '250', nonce: '0x99' });
    expect(thresholdsSeen(bank.proveReputation)).toMatchObject({ minLoans: 2, minVolume: '250', nonce: '0x99' });
  });
});

describe('@h081lll/agent: h.proveReputation({ audience, minLoans, minVolume }) and POST /v1/reputation/prove', () => {
  let g: Gateway;
  let a: Awaited<ReturnType<typeof makeAgent>>;
  beforeAll(async () => {
    a = await makeAgent({ bank: stubBank(withRep()) });
    g = await startGateway(a.h);
  });
  afterAll(async () => { await g.close(); });
  const prove = () => (a.bank as unknown as ReturnType<typeof withRep>).proveReputation;

  it('one call from the agent API; the old names fold in; both of a pair are refused before the bank', async () => {
    expect(await a.h.proveReputation({ audience: 'acme-desk', minLoans: 3, minVolume: '500' })).toMatchObject({ code: PROVED.code, nonce: '0x1234' });
    expect(thresholdsSeen(prove())).toMatchObject({ audience: 'acme-desk', minLoans: 3, minVolume: '500' });
    await a.h.proveReputation({ audience: 'acme-desk', minVolumeUsdg: '700', monthFloorUsdg: '50', minMonths: 2, nonce: '0x77' });
    expect(thresholdsSeen(prove())).toMatchObject({ minVolume: '700', monthFloor: '50', nonce: '0x77' });
    const n = prove().mock.calls.length;
    await expect(a.h.proveReputation({ audience: 'acme-desk', minVolume: '1', minVolumeUsdg: '1' })).rejects.toThrow(/not both/);
    expect(prove().mock.calls.length).toBe(n);
  });

  it('the local HTTP API takes the same body (and the alias)', async () => {
    const r = await g.api('POST', '/v1/reputation/prove', { audience: 'acme-desk', minLoans: 3, minVolume: '500', nonce: '0x1234' });
    expect(r.status).toBe(200);
    expect(thresholdsSeen(prove())).toMatchObject({ minLoans: 3, minVolume: '500', nonce: '0x1234' });
    expect((await g.api('POST', '/v1/reputation/prove', { audience: 'acme-desk', minVolumeUsdg: '250' })).status).toBe(200);
    expect(thresholdsSeen(prove())).toMatchObject({ minVolume: '250' });
    expect((await g.api('POST', '/v1/reputation/prove', { audience: 'acme-desk', minVolume: '1', minVolumeUsdg: '1' })).status).toBe(400);
  });
});
