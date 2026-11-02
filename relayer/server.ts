// The relayer's HTTP JSON API (node:http, no framework). Routes:
//   GET  /v1/health            liveness
//   GET  /v1/info              what this relayer accepts: chains, its addresses, minimum fees, fee accounts, x402 status
//   POST /v1/evm/relay         { to, data }                          -> { hash, fn, fee }
//   POST /v1/solana/relay      { op, payload, mint?, recipientOwner?, lenderToken? } -> { signature, computeUnits, op, fee }
//   GET  /v1/x402/catalog      the paid services (free)
//   POST /v1/x402/solana/relay-priority, POST /v1/x402/solana/preflight, GET /v1/x402/loans/market,
//   POST /v1/x402/prove/disclose   paid (x402): 402 + PAYMENT-REQUIRED without a PAYMENT-SIGNATURE header
// Errors: { error: { code, message } } with 400 (malformed), 402 (fee not acceptable, or payment required /
// invalid / not settled), 404, 405, 409 (stale or already spent, payment replayed), 413 (body too large),
// 422 (simulation failed), 429 (rate limited, Retry-After), 503 (chain disabled, busy, x402_disabled,
// facilitator_unavailable, service_disabled), other 5xx.
import { createServer, type RequestListener, type Server } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { RelayError, toRelayError } from './errors.js';
import { fail, json, readBody } from './http.js';
import { RateLimiter } from './ratelimit.js';
import { X402_CATALOG_PATH, X402_ROUTES, type X402ServiceId, catalogView } from './x402/catalog.js';
import type { X402Seller } from './x402/seller.js';
import { SOLANA_MAINNET_NETWORK } from './x402/types.js';

export interface ChainBackend {
  info(): unknown;
  relay(body: unknown): Promise<unknown>;
}

export interface RelayerServerOptions {
  evm?: ChainBackend;
  solana?: ChainBackend;
  limiter: RateLimiter;
  /** default 256 KiB (a Solana payload is at most 96 KiB, about 128 KiB in base64) */
  maxBodyBytes?: number;
  /** take the client key from the first X-Forwarded-For hop (only behind a proxy you run) */
  trustProxy?: boolean;
  /** one line per relay request; default: none */
  log?: (line: string) => void;
  /** browser origins allowed to call the API (CORS); default: none */
  corsOrigins?: string[];
  /** the x402 seller; undefined = paid routes answer 503 x402_disabled */
  x402?: X402Seller;
  /** the public origin of this relayer (catalog URLs when x402 is disabled); default https://h081-relayer.vercel.app */
  publicBase?: string;
}

export function clientKey(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

const X402_PATHS = new Map<string, { id: X402ServiceId; method: 'GET' | 'POST' }>(
  (Object.entries(X402_ROUTES) as Array<[X402ServiceId, { method: 'GET' | 'POST'; path: string }]>).map(([id, r]) => [r.path, { id, method: r.method }]),
);

/** The request handler alone, for hosts that bring their own HTTP server (e.g. a serverless function). */
export function createRelayerHandler(opts: RelayerServerOptions): RequestListener {
  const max = opts.maxBodyBytes ?? 256 * 1024;
  const cors = new Set(opts.corsOrigins ?? []);
  const publicBase = (opts.publicBase ?? 'https://h081-relayer.vercel.app').replace(/\/+$/, '');
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://relayer');
    const path = url.pathname.replace(/\/+$/, '');
    const origin = req.headers.origin;
    if (origin && cors.has(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-expose-headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE');
      res.setHeader('vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      if (!origin || !cors.has(origin)) return fail(res, new RelayError(403, 'origin', 'origin not allowed'));
      res.writeHead(204, { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type, payment-signature', 'access-control-max-age': '600' });
      return res.end();
    }
    try {
      if (req.method === 'GET' && path === '/v1/health') return json(res, 200, { ok: true });
      if (req.method === 'GET' && path === '/v1/info') {
        return json(res, 200, {
          ...(opts.evm ? { evm: opts.evm.info() } : {}), ...(opts.solana ? { solana: opts.solana.info() } : {}),
          x402: { enabled: !!opts.x402, catalog: `${opts.x402?.opts.resourceBase ?? publicBase}${X402_CATALOG_PATH}` },
        });
      }
      if (path === X402_CATALOG_PATH) {
        if (req.method !== 'GET') return fail(res, new RelayError(405, 'method', 'GET only'), { allow: 'GET' });
        if (opts.x402) return json(res, 200, opts.x402.catalog());
        return json(res, 200, catalogView({
          enabled: false, services: [], prices: new Map(), assets: [], payTo: '', network: SOLANA_MAINNET_NETWORK, resourceBase: publicBase,
        }));
      }
      const x402Route = X402_PATHS.get(path);
      if (x402Route) {
        if (req.method !== x402Route.method) return fail(res, new RelayError(405, 'method', `${x402Route.method} only`), { allow: x402Route.method });
        if (!opts.x402) return fail(res, new RelayError(503, 'x402_disabled', 'paid x402 endpoints are not enabled on this relayer (no facilitator credentials)'));
        const service = opts.x402.find(req.method, path);
        if (!service) return fail(res, new RelayError(503, 'service_disabled', 'this paid service is disabled (price 0)'));
        const key = clientKey(req, !!opts.trustProxy);
        // the unpaid challenge is free; a paid call takes a limiter token, except on the priority lane (its own capacity)
        if (req.headers['payment-signature'] && service.id !== 'relay-priority') {
          const wait = opts.limiter.take(key);
          if (wait > 0) return fail(res, new RelayError(429, 'rate_limited', `retry in ${Math.ceil(wait / 1000)} s`), { 'retry-after': String(Math.ceil(wait / 1000)) });
        }
        return opts.x402.handle(req, res, service, url, key);
      }
      const chain = path === '/v1/evm/relay' ? 'evm' : path === '/v1/solana/relay' ? 'solana' : undefined;
      if (!chain) return fail(res, new RelayError(404, 'not_found', `${req.method} ${path} is not a route`));
      if (req.method !== 'POST') return fail(res, new RelayError(405, 'method', 'POST only'), { allow: 'POST' });
      const backend = opts[chain];
      if (!backend) return fail(res, new RelayError(503, 'chain_disabled', `this relayer does not relay ${chain} operations`));
      const wait = opts.limiter.take(clientKey(req, !!opts.trustProxy));
      if (wait > 0) return fail(res, new RelayError(429, 'rate_limited', `retry in ${Math.ceil(wait / 1000)} s`), { 'retry-after': String(Math.ceil(wait / 1000)) });
      const body = await readBody(req, max);
      const started = Date.now();
      try {
        const out = await backend.relay(body);
        opts.log?.(`${chain} ok ${Date.now() - started}ms ${JSON.stringify(out)}`);
        return json(res, 200, out);
      } catch (e) {
        const err = toRelayError(e);
        opts.log?.(`${chain} ${err.status} ${err.code} ${err.message.slice(0, 200)}`);
        return fail(res, err);
      }
    } catch (e) {
      return fail(res, toRelayError(e));
    }
  };
}

export function createRelayerServer(opts: RelayerServerOptions): Server {
  return createServer(createRelayerHandler(opts));
}
