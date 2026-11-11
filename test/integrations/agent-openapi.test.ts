// openapi.json is committed and must equal what the route table generates; every route in server.ts is in the
// document and the reverse; every route answers on a running gateway (not 404).
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../../integrations/core/errors.js';
import { buildOpenApi } from '../../integrations/agent/src/openapi.js';
import { ROUTES } from '../../integrations/agent/src/server.js';
import { makeAgent, startGateway, type Gateway } from './agent-helpers.js';

const committed = JSON.parse(readFileSync('integrations/agent/openapi.json', 'utf8'));
const routesOf = (doc: { paths: Record<string, Record<string, unknown>> }) => Object.entries(doc.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)).sort();

describe('OpenAPI', () => {
  let g: Gateway;
  beforeAll(async () => { g = await startGateway((await makeAgent()).h); });
  afterAll(async () => { await g.close(); });

  it('the committed openapi.json equals freshly generated output (run npm run openapi --prefix integrations/agent)', () => {
    expect(committed).toEqual(buildOpenApi(ROUTES));
    expect(committed.openapi).toBe('3.1.0');
    expect(committed.info.version).toBe(JSON.parse(readFileSync('integrations/agent/package.json', 'utf8')).version);
  });

  it('every route in server.ts is in the document, and every route in the document is in server.ts', () => {
    const table = ROUTES.map((r) => `${r.method} ${r.path}`).sort();
    expect(new Set(table).size).toBe(table.length);
    expect(routesOf(committed)).toEqual(table);
    // the spec's endpoint list
    expect(table).toEqual([
      'GET /v1/address', 'GET /v1/balance', 'GET /v1/events', 'GET /v1/fees/withdraw', 'GET /v1/health', 'GET /v1/history', 'GET /v1/loans/lent', 'GET /v1/loans/quote',
      'GET /v1/openapi.json', 'GET /v1/stake', 'GET /v1/status', 'POST /v1/allowances', 'POST /v1/allowances/{id}/reclaim', 'POST /v1/codes/check', 'POST /v1/deposit',
      'POST /v1/loans/borrow', 'POST /v1/loans/lend', 'POST /v1/pay', 'POST /v1/stake', 'POST /v1/transfer', 'POST /v1/withdraw',
    ]);
    expect(table.some((r) => /\/ops\/|delegate/.test(r))).toBe(false);
  });

  it('every documented route answers on the gateway (not 404); an undocumented one is 404; the served document is the committed one', async () => {
    for (const key of routesOf(committed)) {
      const [method, path] = key.split(' ');
      if (path === '/v1/events') continue; // a stream: tested with the events test
      const concrete = path.replace('{id}', '12345');
      const r = await g.api(method, concrete, method === 'POST' ? {} : undefined);
      expect(r.status, `${key}: ${r.text}`).not.toBe(404);
    }
    expect((await g.api('GET', '/v1/ops/h081_bank_deposit')).status).toBe(404);
    expect((await g.api('POST', '/v1/delegate', {})).status).toBe(404);
    const served = await g.api('GET', '/v1/openapi.json');
    expect(served.json).toEqual(committed);
  });

  it('documents every error code, the envelope, the plan, bearer auth and the Idempotency-Key header', () => {
    expect(committed.components.schemas.Error.properties.error.properties.code.enum.sort()).toEqual(Object.keys(ERROR_CODES).sort());
    for (const code of Object.keys(ERROR_CODES)) expect(committed.info.description).toContain(`- ${code} (`);
    expect(committed.components.securitySchemes.bearer).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(committed.paths['/v1/health'].get.security).toEqual([]);
    expect(committed.paths['/v1/withdraw'].post.requestBody.content['application/json'].schema.required).toEqual(['to']);
    expect(committed.paths['/v1/withdraw'].post.parameters).toContainEqual(expect.objectContaining({ name: 'Idempotency-Key', in: 'header' }));
    expect(committed.components.schemas.Plan.required).toEqual(expect.arrayContaining(['op', 'fee', 'solNeeded', 'circuit', 'download', 'publicOnChain', 'warnings']));
    expect(committed.servers[0].url).toBe('http://127.0.0.1:8081');
  });
});
