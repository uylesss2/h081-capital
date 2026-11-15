// The relayer's private-reputation routes with a stub backend (no RPC): enabled/disabled, methods, rate limit, the
// config floor that keeps wash loans from draining the hot wallet, and that there is no proving route.
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, ConfigError } from '../../relayer/config.js';
import { RelayError } from '../../relayer/errors.js';
import { RateLimiter } from '../../relayer/ratelimit.js';
import { createRelayerServer } from '../../relayer/server.js';

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function start(rep?: Parameters<typeof createRelayerServer>[0]['rep'], burst = 5): Promise<string> {
  server = createRelayerServer({ solana: { info: () => ({}), relay: async () => ({}) }, limiter: new RateLimiter({ perMinute: 60, burst }), rep });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const a = server.address() as { port: number };
  return `http://127.0.0.1:${a.port}`;
}

describe('relayer /v1/rep routes', () => {
  it('answer 503 rep_disabled when reputation is off; info says so', async () => {
    const url = await start();
    for (const [m, p] of [['GET', '/v1/rep/leaves'], ['GET', '/v1/rep/roots'], ['POST', '/v1/rep/attest']]) {
      const r = await fetch(`${url}${p}`, { method: m, ...(m === 'POST' ? { body: '{}' } : {}) });
      expect(r.status).toBe(503);
      expect(((await r.json()) as any).error.code).toBe('rep_disabled');
    }
    expect(((await (await fetch(`${url}/v1/info`)).json()) as any).rep).toEqual({ enabled: false });
  });

  it('serve leaves and roots, relay an attest, map refusals, rate limit attests, and offer no proving route', async () => {
    const calls: unknown[] = [];
    const url = await start({
      info: () => ({ program: 'P', attester: 'A', minPrincipal: '10000000', proving: false }),
      leaves: async () => ({ version: 0, program: 'P', events: [] }),
      roots: async () => ({ version: 0, nextIndex: 0, root: '1', roots: ['1'] }),
      attest: async (b: unknown) => {
        calls.push(b);
        if ((b as { loanRef: string }).loanRef === '9') throw new RelayError(402, 'below_floor', 'too small');
        return { signature: 'sig', loanRef: (b as { loanRef: string }).loanRef };
      },
    } as never, 2);
    expect(await (await fetch(`${url}/v1/rep/leaves`)).json()).toEqual({ version: 0, program: 'P', events: [] });
    expect(((await (await fetch(`${url}/v1/rep/roots`)).json()) as any).nextIndex).toBe(0);
    expect((await fetch(`${url}/v1/rep/leaves`, { method: 'POST', body: '{}' })).status).toBe(405);
    expect((await fetch(`${url}/v1/rep/attest`)).status).toBe(405);
    const ok = await fetch(`${url}/v1/rep/attest`, { method: 'POST', body: JSON.stringify({ loanRef: '7' }) });
    expect(await ok.json()).toEqual({ signature: 'sig', loanRef: '7' });
    const small = await fetch(`${url}/v1/rep/attest`, { method: 'POST', body: JSON.stringify({ loanRef: '9' }) });
    expect(small.status).toBe(402);
    expect(((await small.json()) as any).error.code).toBe('below_floor');
    // burst 2: the third attest in a row is refused before the backend runs
    const third = await fetch(`${url}/v1/rep/attest`, { method: 'POST', body: JSON.stringify({ loanRef: '8' }) });
    expect(third.status).toBe(429);
    expect(calls).toHaveLength(2);
    expect((await fetch(`${url}/v1/rep/prove`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect(((await (await fetch(`${url}/v1/info`)).json()) as any).rep).toMatchObject({ enabled: true, proving: false });
  });
});

describe('relayer reputation config', () => {
  const base = {
    RELAYER_SOLANA_RPC: 'http://127.0.0.1:8899', RELAYER_SOLANA_KEYPAIR_JSON: '[1]', RELAYER_SOLANA_MIN_FEES: '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH=50000',
    RELAYER_SOLANA_TREASURY: 'EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq',
  };
  it('is off without RELAYER_REP_PROGRAM_ID; on with a 10 USDG default floor; a floor under 1 USDG is refused', () => {
    expect(loadConfig(base).solana?.rep).toBeUndefined();
    const on = loadConfig({ ...base, RELAYER_REP_PROGRAM_ID: '8w59GKraS4JrmDqYnqXcvjHTubnj7udMsuLXnscd3KEL' }).solana?.rep;
    expect(on).toMatchObject({ programId: '8w59GKraS4JrmDqYnqXcvjHTubnj7udMsuLXnscd3KEL', loanProgramId: '8JBd7epQXxdcKRMaWM1S5PC7nsQKoZq3uCetpiJ684g4', minPrincipal: 10_000_000n });
    expect(() => loadConfig({ ...base, RELAYER_REP_PROGRAM_ID: '8w59GKraS4JrmDqYnqXcvjHTubnj7udMsuLXnscd3KEL', RELAYER_REP_MIN_PRINCIPAL: '999999' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, RELAYER_REP_PROGRAM_ID: 'nope' })).toThrow(/not a public key/);
  });
});
