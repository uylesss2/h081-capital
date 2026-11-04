// Small node:http helpers shared by the relay routes (server.ts) and the x402 seller (x402/seller.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RelayError } from './errors.js';

export const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  const text = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(text);
};

export const fail = (res: ServerResponse, e: RelayError, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
  json(res, e.status, { error: { code: e.code, message: e.message, ...extra } }, headers);

export function readBody(req: IncomingMessage, max: number): Promise<unknown> {
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
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new RelayError(400, 'bad_json', 'body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** The first value of a request header (node lower-cases names). */
export function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}
