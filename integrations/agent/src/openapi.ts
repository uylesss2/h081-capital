// The OpenAPI 3.1 document of the local API, generated from the route table (server.ts ROUTES), the operation
// schemas (core/schemas.ts) and ERROR_CODES (core/errors.ts). `npm run openapi` writes openapi.json; the gateway
// serves the same document at GET /v1/openapi.json and `h081 openapi` prints it.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES } from '../../core/errors.js';
import type { RouteDef } from './server.js';
import { VERSION } from './h081.js';

type Json = Record<string, unknown>;

const errorCodes = Object.keys(ERROR_CODES);
const statusText: Record<number, string> = {
  400: 'Bad request', 401: 'Missing or wrong token', 403: 'Host or Origin not allowed', 404: 'Not found', 409: 'Conflict', 415: 'Not JSON',
  422: 'Refused', 429: 'Too many requests', 500: 'Internal error', 501: 'Not available', 502: 'RPC unreachable', 503: 'Unavailable',
};

const PLAN: Json = {
  type: 'object',
  description: 'What a write would do. Returned (status "plan") when confirm is missing or false; nothing is proven, signed or sent.',
  properties: {
    op: { type: 'string' }, usdg: { type: 'string' }, to: { type: 'string' },
    fee: { type: 'string', description: 'USDG taken out of the amount' }, payout: { type: 'string', description: 'USDG the recipient gets' },
    solNeeded: { type: 'string', description: 'SOL the agent wallet needs for this' },
    circuit: { type: ['string', 'null'] }, download: { type: 'string', description: 'what the first proof downloads, once' },
    publicOnChain: { type: 'array', items: { type: 'string' } }, sentBy: { type: 'string', enum: ['relayer', 'agent key'] },
    warnings: { type: 'array', items: { type: 'string' } }, details: {}, next: { type: 'string' },
  },
  required: ['op', 'fee', 'solNeeded', 'circuit', 'download', 'publicOnChain', 'sentBy', 'warnings', 'next'],
};

/** The document for `routes` (deterministic: the same routes always give the same JSON). */
export function buildOpenApi(routes: RouteDef[]): Json {
  const paths: Record<string, Record<string, Json>> = {};
  for (const r of routes) {
    const statuses = new Set<number>();
    if (r.auth) statuses.add(401);
    statuses.add(403);
    if (r.method === 'POST') { statuses.add(400); statuses.add(415); }
    if (r.query?.length) statuses.add(400);
    if (r.write) for (const s of [409, 422, 429, 500, 501, 502, 503]) statuses.add(s);
    else if (r.auth && !['/v1/status', '/v1/address'].includes(r.path)) for (const s of [500, 502, 503]) statuses.add(s);
    const responses: Json = {
      200: r.stream
        ? { description: r.result, content: { 'text/event-stream': { schema: { type: 'string' } } } }
        : r.path === '/v1/openapi.json'
          ? { description: r.result, content: { 'application/json': { schema: { type: 'object' } } } }
          : {
            description: `ok: ${r.result}`,
            content: {
              'application/json': {
                schema: r.write
                  ? { allOf: [{ $ref: '#/components/schemas/Success' }, { properties: { status: { enum: ['plan', 'sent'] }, result: { oneOf: [{ $ref: '#/components/schemas/Plan' }, { type: 'object' }] } } }] }
                  : { $ref: '#/components/schemas/Success' },
              },
            },
          },
    };
    for (const s of [...statuses].sort((a, b) => a - b)) responses[s] = { $ref: `#/components/responses/E${s}` };
    const params: Json[] = [];
    for (const m of r.path.matchAll(/\{(\w+)\}/g)) params.push({ name: m[1], in: 'path', required: true, schema: { type: 'string', pattern: '^\\d+$' }, description: 'the allowance id /v1/balance shows' });
    for (const q of r.query ?? []) params.push({ name: q.name, in: 'query', required: q.required ?? false, schema: q.schema, description: q.description });
    if (r.write) params.push({ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', pattern: '^[A-Za-z0-9_.:-]{1,128}$' }, description: 'required with confirm: true; a retry with the same key and body returns the first result' });
    if (r.stream) params.push({ name: 'Last-Event-ID', in: 'header', required: false, schema: { type: 'string' }, description: 'resume after this event id' });
    const op: Json = {
      operationId: `${r.method.toLowerCase()}${r.path.replace(/^\/v1/, '').replace(/\{(\w+)\}/g, 'By_$1').replace(/[/._-](\w)/g, (_m, c: string) => c.toUpperCase())}`,
      summary: r.summary,
      ...(r.description ? { description: r.description } : {}),
      ...(r.auth ? {} : { security: [] }),
      ...(params.length ? { parameters: params } : {}),
      ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: r.body } } } } : {}),
      responses,
    };
    (paths[r.path] ??= {})[r.method.toLowerCase()] = op;
  }
  const errorResponses: Json = {};
  for (const s of Object.keys(statusText).map(Number)) {
    const codes = errorCodes.filter((c) => ERROR_CODES[c as keyof typeof ERROR_CODES].status === s);
    if (!codes.length) continue;
    errorResponses[`E${s}`] = {
      description: `${statusText[s]}: ${codes.join(', ')}`,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'H081 Agent API',
      version: VERSION,
      description:
        'The H081 private bank on your own machine. `h081 serve` (npm package @h081lll/agent) runs it on 127.0.0.1:8081. ' +
        'The agent key, notes and viewing keys stay on this machine; the gateway talks only to your Solana RPC, the H081 relayer ' +
        '(already-proven payloads) and the circuit downloads (checked against pinned sha256 hashes). Every write returns a plan ' +
        'and sends nothing unless the body has "confirm": true and the request has an Idempotency-Key header. ' +
        'Live on Solana mainnet; not audited yet; use at your own risk.\n\nError codes:\n' +
        errorCodes.map((c) => { const e = ERROR_CODES[c as keyof typeof ERROR_CODES]; return `- ${c} (${e.status}${e.retryable ? ', retryable' : ''}): ${e.description}`; }).join('\n'),
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: 'http://127.0.0.1:8081', description: 'h081 serve (local only)' }],
    security: [{ bearer: [] }],
    paths,
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'the token in ~/.h081/api-token (h081 token prints it)' } },
      schemas: {
        Success: {
          type: 'object',
          properties: {
            ok: { const: true }, network: { type: 'string', enum: ['mainnet-beta', 'localnet'] }, status: { type: 'string', enum: ['done', 'plan', 'sent'] },
            result: {}, replayed: { type: 'boolean', description: 'true when an Idempotency-Key replay returned the stored result' }, requestId: { type: 'string' },
          },
          required: ['ok', 'network', 'status', 'result', 'requestId'],
        },
        Error: {
          type: 'object',
          properties: {
            ok: { const: false }, network: { type: 'string' },
            error: {
              type: 'object',
              properties: { code: { type: 'string', enum: errorCodes }, message: { type: 'string' }, retryable: { type: 'boolean' }, details: { type: 'object' } },
              required: ['code', 'message', 'retryable'],
            },
            requestId: { type: 'string' },
          },
          required: ['ok', 'network', 'error', 'requestId'],
        },
        Plan: PLAN,
      },
      responses: errorResponses,
    },
  };
}

/** `npm run openapi`: writes openapi.json next to package.json. */
async function main(): Promise<void> {
  const { ROUTES } = await import('./server.js');
  const file = fileURLToPath(new URL('../openapi.json', import.meta.url));
  writeFileSync(file, JSON.stringify(buildOpenApi(ROUTES), null, 2) + '\n');
  process.stdout.write(`wrote ${file}\n`);
}

if (process.argv[1] && /[\\/]src[\\/]openapi\.ts$/.test(process.argv[1])) void main();
