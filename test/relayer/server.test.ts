// In-process checks of the relayer HTTP layer with stub chain backends (no RPC, no keys).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRelayerServer } from '../../relayer/server.js';
import { RateLimiter } from '../../relayer/ratelimit.js';
import { badRequest } from '../../relayer/errors.js';
import { RelayerClient, RelayerError } from '../../src/relayer-client.js';

describe('relayer HTTP server', () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    server = createRelayerServer({
      solana: {
        info: () => ({ programId: 'P', relayer: 'R', minFees: { M: '1000' }, feeAccounts: {}, lookupTables: [], allowUnpaid: false }),
        relay: async (body) => {
          const fee = BigInt((body as { fee?: string }).fee ?? '0');
          if (fee < 1000n) throw badRequest('fee_too_low', `fee ${fee} below 1000`);
          return { signature: 'sig', computeUnits: 1, op: 'transact', fee };
        },
      },
      limiter: new RateLimiter({ perMinute: 60, burst: 3 }),
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('serves health and info; unknown routes are 404, disabled chains 503', async () => {
    expect(await (await fetch(`${url}/v1/health`)).json()).toEqual({ ok: true });
    expect(await new RelayerClient(url).info()).toHaveProperty('solana.relayer', 'R');
    expect((await fetch(`${url}/nope`)).status).toBe(404);
    expect((await fetch(`${url}/v1/evm/relay`, { method: 'POST', body: '{}' })).status).toBe(503);
  });

  it('maps a low fee to 402, bad JSON to 400, and rate limits with 429', async () => {
    const post = (body: string) => fetch(`${url}/v1/solana/relay`, { method: 'POST', body });
    const low = await post(JSON.stringify({ fee: '999' }));
    expect(low.status).toBe(402);
    expect(((await low.json()) as { error: { code: string } }).error.code).toBe('fee_too_low');
    expect((await post('not json')).status).toBe(400);
    const ok = await post(JSON.stringify({ fee: '1000' }));
    expect(ok.status).toBe(200);
    // burst of 3 relay requests used up above
    const limited = await post(JSON.stringify({ fee: '1000' }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });

  it('the SDK client surfaces refusals as RelayerError', async () => {
    const client = new RelayerClient(url);
    await expect(client.relaySolana({ op: 'transact', payload: '' })).rejects.toBeInstanceOf(RelayerError);
  });
});

describe('relayer CORS', () => {
  let server: Server;
  let url: string;
  const site = 'https://www.h081.xyz';
  beforeAll(async () => {
    server = createRelayerServer({ solana: { info: () => ({}), relay: async () => ({}) }, limiter: new RateLimiter({ perMinute: 60, burst: 5 }), corsOrigins: [site] });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('answers preflight and tags responses only for the allowed origin', async () => {
    const pre = await fetch(`${url}/v1/solana/relay`, { method: 'OPTIONS', headers: { origin: site } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(site);
    expect(pre.headers.get('access-control-allow-headers')).toBe('content-type');
    expect((await fetch(`${url}/v1/info`, { headers: { origin: site } })).headers.get('access-control-allow-origin')).toBe(site);
    const other = await fetch(`${url}/v1/solana/relay`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    expect(other.status).toBe(403);
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    expect((await fetch(`${url}/v1/info`, { headers: { origin: 'https://evil.example' } })).headers.get('access-control-allow-origin')).toBeNull();
  });
});
