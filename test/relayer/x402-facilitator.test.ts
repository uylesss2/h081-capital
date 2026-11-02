// The CDP facilitator client against a local HTTP stub: paths, auth, bodies, how non-OK verdicts and real
// failures are told apart, the fee-payer lookup and its cache, the 429 retry and the timeout.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { type IncomingMessage, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CdpFacilitator, FacilitatorError, feePayerFor } from '../../relayer/x402/facilitator.js';
import { type PaymentPayloadV2, type PaymentRequirements, SOLANA_MAINNET_NETWORK, encodeHeader } from '../../relayer/x402/types.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const secret = Buffer.concat([privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32), publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)]).toString('base64');

interface Seen { method: string; path: string; headers: IncomingMessage['headers']; body: unknown }
let seen: Seen[] = [];
let script: Array<{ status: number; body: unknown; headers?: Record<string, string>; delayMs?: number }> = [];
let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method!, path: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
      const next = script.shift() ?? { status: 200, body: {} };
      const answer = () => {
        res.writeHead(next.status, { 'content-type': 'application/json', ...(next.headers ?? {}) });
        res.end(typeof next.body === 'string' ? next.body : JSON.stringify(next.body));
      };
      if (next.delayMs) setTimeout(answer, next.delayMs); else answer();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/platform/v2/x402/`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { seen = []; script = []; });

const payload = { x402Version: 2, accepted: { scheme: 'exact', network: SOLANA_MAINNET_NETWORK, amount: '1', asset: 'M', payTo: 'T', maxTimeoutSeconds: 60 }, payload: { transaction: 'AAAA' } } as PaymentPayloadV2;
const requirements: PaymentRequirements = payload.accepted;
const claims = (h: IncomingMessage['headers']) => JSON.parse(Buffer.from(String(h.authorization).replace('Bearer ', '').split('.')[1], 'base64url').toString());

describe('CdpFacilitator', () => {
  it('posts verify and settle with a JWT bound to each call and the x402 body', async () => {
    const f = new CdpFacilitator({ url, apiKeyId: 'kid', apiKeySecret: secret, timeoutMs: 2_000 });
    expect(f.base.pathname).toBe('/platform/v2/x402');
    script.push({ status: 200, body: { isValid: true, payer: 'P' }, headers: { 'extension-responses': encodeHeader({ bazaar: { status: 'processing' } }) } });
    expect(await f.verify(payload, requirements)).toEqual({ isValid: true, payer: 'P', extensionResponses: { bazaar: { status: 'processing' } } });
    script.push({ status: 200, body: { success: true, transaction: 'sig', network: SOLANA_MAINNET_NETWORK } });
    expect(await f.settle(payload, requirements)).toEqual({ success: true, transaction: 'sig', network: SOLANA_MAINNET_NETWORK });
    expect(seen.map((s) => [s.method, s.path])).toEqual([['POST', '/platform/v2/x402/verify'], ['POST', '/platform/v2/x402/settle']]);
    for (const s of seen) {
      expect(s.headers['content-type']).toBe('application/json');
      expect(s.body).toEqual({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements });
      expect(claims(s.headers)).toMatchObject({ sub: 'kid', iss: 'cdp', uris: [`${s.method} 127.0.0.1:${(server.address() as AddressInfo).port}${s.path}`] });
    }
  });

  it('returns facilitator verdicts carried by non-OK statuses, and throws on real failures', async () => {
    const f = new CdpFacilitator({ url, apiKeyId: 'kid', apiKeySecret: secret, timeoutMs: 2_000 });
    script.push({ status: 400, body: { isValid: false, invalidReason: 'invalid_payload' } });
    expect(await f.verify(payload, requirements)).toEqual({ isValid: false, invalidReason: 'invalid_payload' });
    script.push({ status: 500, body: { success: false, errorReason: 'settlement_pending', transaction: 'sig', network: SOLANA_MAINNET_NETWORK } });
    expect(await f.settle(payload, requirements)).toMatchObject({ success: false, errorReason: 'settlement_pending', transaction: 'sig' });
    script.push({ status: 401, body: 'Unauthorized' });
    const err = await f.verify(payload, requirements).catch((e) => e);
    expect(err).toBeInstanceOf(FacilitatorError);
    expect(err.status).toBe(401);
    script.push({ status: 200, body: 'not json' });
    await expect(f.settle(payload, requirements)).rejects.toThrow(/non-JSON/);
  });

  it('reads the fee payer from GET /supported (exact, v2, our network), caches it and retries once on 429', async () => {
    const f = new CdpFacilitator({ url, apiKeyId: 'kid', apiKeySecret: secret, timeoutMs: 2_000 });
    const kinds = [
      { x402Version: 1, scheme: 'exact', network: 'solana', extra: { feePayer: 'old' } },
      { x402Version: 2, scheme: 'exact', network: SOLANA_MAINNET_NETWORK, extra: { feePayer: 'FP' } },
    ];
    script.push({ status: 429, body: { error: 'slow down' }, headers: { 'retry-after': '0' } }, { status: 200, body: { kinds, extensions: ['bazaar'] } });
    expect(await f.feePayerFor(SOLANA_MAINNET_NETWORK)).toBe('FP');
    expect(seen.map((s) => [s.method, s.path])).toEqual([['GET', '/platform/v2/x402/supported'], ['GET', '/platform/v2/x402/supported']]);
    expect(seen[0].body).toBeUndefined();
    expect(await f.feePayerFor(SOLANA_MAINNET_NETWORK)).toBe('FP');
    expect(seen).toHaveLength(2); // cached
    expect(() => feePayerFor({ kinds }, 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')).toThrow(FacilitatorError);
    expect(() => feePayerFor({ kinds: [{ x402Version: 2, scheme: 'exact', network: SOLANA_MAINNET_NETWORK }] }, SOLANA_MAINNET_NETWORK)).toThrow(/no exact kind/);
  });

  it('gives up after the configured timeout', async () => {
    const f = new CdpFacilitator({ url, apiKeyId: 'kid', apiKeySecret: secret, timeoutMs: 200 });
    script.push({ status: 200, body: { isValid: true }, delayMs: 1_500 });
    const err = await f.verify(payload, requirements).catch((e) => e);
    expect(err).toBeInstanceOf(FacilitatorError);
    expect(err.status).toBe(0);
  });
});
