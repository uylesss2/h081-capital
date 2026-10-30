// The relayer's HTTP JSON API (node:http, no framework). Routes:
//   GET  /v1/health            liveness
//   GET  /v1/info              what this relayer accepts: chains, its addresses, minimum fees, fee accounts
//   POST /v1/evm/relay         { to, data }                          -> { hash, fn, fee }
//   POST /v1/solana/relay      { op, payload, mint?, recipientOwner?, lenderToken? } -> { signature, computeUnits, op, fee }
// Errors: { error: { code, message } } with 400 (malformed), 402 (fee not acceptable), 404, 409 (stale or
// already spent), 413 (body too large), 422 (simulation failed), 429 (rate limited, Retry-After), 5xx.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { RelayError, toRelayError } from './errors.js';
import { RateLimiter } from './ratelimit.js';

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
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  const text = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(text);
};

const fail = (res: ServerResponse, e: RelayError, headers: Record<string, string> = {}) => json(res, e.status, { error: { code: e.code, message: e.message } }, headers);

function readBody(req: IncomingMessage, max: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new RelayError(413, 'body_too_large', `body exceeds ${max} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new RelayError(400, 'bad_json', 'body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function clientKey(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function createRelayerServer(opts: RelayerServerOptions): Server {
  const max = opts.maxBodyBytes ?? 256 * 1024;
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://relayer');
    const path = url.pathname.replace(/\/+$/, '');
    try {
      if (req.method === 'GET' && path === '/v1/health') return json(res, 200, { ok: true });
      if (req.method === 'GET' && path === '/v1/info') {
        return json(res, 200, { ...(opts.evm ? { evm: opts.evm.info() } : {}), ...(opts.solana ? { solana: opts.solana.info() } : {}) });
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
  });
}
