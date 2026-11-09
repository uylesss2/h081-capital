// The gateway's local security: token, Host, Origin, Content-Type, the 127.0.0.1 bind, file modes, open routes.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostAllowed, originAllowed, SendLimiter, tokenMatches } from '../../integrations/agent/src/auth.js';
import { ensureToken, rotateToken, writePrivate } from '../../integrations/agent/src/home.js';
import { startServer } from '../../integrations/agent/src/server.js';
import { call, makeAgent, startGateway, tempHome, type AgentSetup, type Gateway } from './agent-helpers.js';

describe('gateway auth and local security', () => {
  let a: AgentSetup;
  let g: Gateway;
  beforeAll(async () => { a = await makeAgent(); g = await startGateway(a.h); });
  afterAll(async () => { await g.close(); });

  it('binds 127.0.0.1 only; any other host is refused before listening', async () => {
    expect((g.srv.server.address() as { address: string }).address).toBe('127.0.0.1');
    expect(g.srv.url).toBe(`http://127.0.0.1:${g.port}/v1`);
    await expect(startServer({ h081: a.h, token: g.token, port: 0, host: '0.0.0.0' })).rejects.toThrow(/127\.0\.0\.1 only/);
    await expect(startServer({ h081: a.h, token: g.token, port: 0, host: '::' })).rejects.toThrow(/127\.0\.0\.1 only/);
    await expect(startServer({ h081: a.h, token: 'short', port: 0 })).rejects.toThrow(/token/);
  });

  it('no token or a wrong token gives 401 unauthorized; the right one passes', async () => {
    const host = { host: `127.0.0.1:${g.port}` };
    const none = await call(g.port, 'GET', '/v1/balance', { headers: host });
    expect(none.status).toBe(401);
    expect(none.json).toMatchObject({ ok: false, network: 'mainnet-beta', error: { code: 'unauthorized', retryable: false } });
    expect(none.json.requestId).toMatch(/^req_/);
    const wrong = await call(g.port, 'GET', '/v1/balance', { headers: { ...host, authorization: `Bearer ${g.token.slice(0, -1)}x` } });
    expect(wrong.status).toBe(401);
    const basic = await call(g.port, 'GET', '/v1/balance', { headers: { ...host, authorization: `Basic ${g.token}` } });
    expect(basic.status).toBe(401);
    const empty = await call(g.port, 'GET', '/v1/balance', { headers: { ...host, authorization: 'Bearer ' } });
    expect(empty.status).toBe(401);
    const ok = await g.api('GET', '/v1/balance');
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true, network: 'mainnet-beta', status: 'done', result: { shielded: '25' } });
    // writes need the token too
    expect((await call(g.port, 'POST', '/v1/deposit', { headers: { ...host, 'content-type': 'application/json' }, body: { usdg: '1' } })).status).toBe(401);
  });

  it('a wrong Host gives 403 forbidden_origin (DNS rebinding); localhost:<port> is allowed', async () => {
    const evil = await call(g.port, 'GET', '/v1/health', { headers: { host: `evil.example:${g.port}` } });
    expect(evil.status).toBe(403);
    expect(evil.json.error.code).toBe('forbidden_origin');
    expect((await call(g.port, 'GET', '/v1/health', { headers: { host: `127.0.0.1:${g.port + 1}` } })).status).toBe(403);
    expect((await call(g.port, 'GET', '/v1/health', { headers: { host: `localhost:${g.port}` } })).status).toBe(200);
    expect((await g.api('GET', '/v1/balance', undefined, { host: `evil.example:${g.port}` })).status).toBe(403);
  });

  it('an Origin that is not allowed gives 403; no CORS headers by default; --allow-origin allows exactly one', async () => {
    const r = await g.api('GET', '/v1/balance', undefined, { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('forbidden_origin');
    const plain = await g.api('GET', '/v1/balance');
    expect(plain.headers['access-control-allow-origin']).toBeUndefined();
    const g2 = await startGateway(a.h, { allowOrigin: 'http://localhost:3000' });
    try {
      const ok = await g2.api('GET', '/v1/balance', undefined, { origin: 'http://localhost:3000' });
      expect(ok.status).toBe(200);
      expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3000');
      expect((await g2.api('GET', '/v1/balance', undefined, { origin: 'http://localhost:3001' })).status).toBe(403);
      const pre = await call(g2.port, 'OPTIONS', '/v1/deposit', { headers: { host: `127.0.0.1:${g2.port}`, origin: 'http://localhost:3000' } });
      expect(pre.status).toBe(204);
      expect(String(pre.headers['access-control-allow-headers'])).toMatch(/Idempotency-Key/);
    } finally { await g2.close(); }
  });

  it('a POST that is not JSON gives 415 (blocks cross-site form posts); bad JSON gives 400', async () => {
    const form = await g.api('POST', '/v1/deposit', undefined, { 'content-type': 'application/x-www-form-urlencoded' });
    expect(form.status).toBe(415);
    expect(form.json.error.code).toBe('unsupported_media_type');
    const text = await call(g.port, 'POST', '/v1/deposit', { headers: { host: `127.0.0.1:${g.port}`, authorization: `Bearer ${g.token}`, 'content-type': 'text/plain' }, raw: '{"usdg":"1"}' });
    expect(text.status).toBe(415);
    const broken = await call(g.port, 'POST', '/v1/deposit', { headers: { host: `127.0.0.1:${g.port}`, authorization: `Bearer ${g.token}`, 'content-type': 'application/json' }, raw: '{"usdg":' });
    expect(broken.status).toBe(400);
    expect(broken.json.error.code).toBe('bad_request');
    const arr = await call(g.port, 'POST', '/v1/deposit', { headers: { host: `127.0.0.1:${g.port}`, authorization: `Bearer ${g.token}`, 'content-type': 'application/json; charset=utf-8' }, raw: '[1]' });
    expect(arr.status).toBe(400);
    expect(a.bank.deposit).not.toHaveBeenCalled();
  });

  it('health and the OpenAPI document need no token; unknown routes are 404', async () => {
    const host = { host: `127.0.0.1:${g.port}` };
    const health = await call(g.port, 'GET', '/v1/health', { headers: host });
    expect(health.status).toBe(200);
    expect(health.json).toMatchObject({ ok: true, network: 'mainnet-beta', result: { version: '0.1.0', network: 'mainnet-beta' } });
    const doc = await call(g.port, 'GET', '/v1/openapi.json', { headers: host });
    expect(doc.status).toBe(200);
    expect(doc.json.openapi).toBe('3.1.0');
    expect((await g.api('GET', '/v1/nope')).status).toBe(404);
    expect((await g.api('GET', '/v1/deposit')).json.error.code).toBe('not_found');
  });

  it('the token check is constant-time over digests and exact; the send limiter caps writes per minute', () => {
    expect(tokenMatches('Bearer abcdefghijklmnopq', 'abcdefghijklmnopq')).toBe(true);
    expect(tokenMatches('bearer abcdefghijklmnopq', 'abcdefghijklmnopq')).toBe(true);
    expect(tokenMatches('Bearer abcdefghijklmnop', 'abcdefghijklmnopq')).toBe(false);
    expect(tokenMatches(undefined, 'abcdefghijklmnopq')).toBe(false);
    expect(hostAllowed('LOCALHOST:8081', 8081)).toBe(true);
    expect(hostAllowed('[::1]:8081', 8081)).toBe(false);
    expect(hostAllowed(undefined, 8081)).toBe(false);
    expect(originAllowed(undefined)).toBe(true);
    expect(originAllowed('null')).toBe(false);
    let t = 0;
    const l = new SendLimiter(2, 60_000, () => t);
    expect(l.take().ok).toBe(true);
    expect(l.take().ok).toBe(true);
    const third = l.take();
    expect(third).toEqual({ ok: false, retryAfter: 60 });
    t = 60_001;
    expect(l.take().ok).toBe(true);
  });

  it('the local send limit answers 429 rate_limited with Retry-After', async () => {
    const lim = await makeAgent({ maxSendsPerMin: 1 });
    const g3 = await startGateway(lim.h);
    try {
      expect((await g3.api('POST', '/v1/deposit', { usdg: '1', confirm: true }, { 'idempotency-key': 'a-1' })).status).toBe(200);
      const r = await g3.api('POST', '/v1/deposit', { usdg: '1', confirm: true }, { 'idempotency-key': 'a-2' });
      expect(r.status).toBe(429);
      expect(r.json.error).toMatchObject({ code: 'rate_limited', retryable: true });
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      expect(lim.bank.deposit).toHaveBeenCalledTimes(1);
      // plans are not sends: never limited
      expect((await g3.api('POST', '/v1/deposit', { usdg: '1' })).json.status).toBe('plan');
    } finally { await g3.close(); }
  });

  it.skipIf(process.platform === 'win32')('the token file, the key file and the home directory are private (0600 / 0700)', () => {
    const home = tempHome();
    const warn: string[] = [];
    const path = join(home, 'api-token');
    const { token, created } = ensureToken(path, (l) => warn.push(l));
    expect(created).toBe(true);
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(ensureToken(path, () => {}).token).toBe(token);
    const next = rotateToken(path, () => {});
    expect(next).not.toBe(token);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    writePrivate(join(home, 'agent.json'), '[]', () => {}, { exclusive: true });
    expect(statSync(join(home, 'agent.json')).mode & 0o777).toBe(0o600);
    expect(() => writePrivate(join(home, 'agent.json'), '[]', () => {}, { exclusive: true })).toThrow(/EEXIST/);
    expect(statSync(a.home).mode & 0o777).toBe(0o700);
    expect(warn).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('on Windows the token file is limited to the current user without a warning', () => {
    const home = tempHome();
    const warn: string[] = [];
    const path = join(home, 'api-token');
    ensureToken(path, (l) => warn.push(l));
    expect(warn).toEqual([]);
  });
});

describe('gateway: malformed requests are 400s, never 500s or a reset connection', () => {
  it('a bad percent-escape in a path parameter and a body over 64 KB', async () => {
    const a = await makeAgent();
    const g = await startGateway(a.h);
    try {
      const pct = await g.api('POST', '/v1/allowances/%E0%A4%A/reclaim', { confirm: false });
      expect(pct.status).toBe(400);
      expect(pct.json.error.code).toBe('bad_request');
      const big = await call(g.port, 'POST', '/v1/deposit', { raw: JSON.stringify({ usdg: 'x'.repeat(70_000) }), headers: { host: `127.0.0.1:${g.port}`, authorization: `Bearer ${g.token}`, 'content-type': 'application/json' } });
      expect(big.status).toBe(400);
      expect(big.json.error).toMatchObject({ code: 'bad_request', message: expect.stringMatching(/larger than 65536 bytes/) });
      expect((await g.api('GET', '/v1/health')).status).toBe(200);
      expect(a.bank.deposit).not.toHaveBeenCalled();
    } finally { await g.close(); }
  });
});
