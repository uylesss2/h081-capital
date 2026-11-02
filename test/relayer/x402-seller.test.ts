// The x402 seller over the relayer HTTP layer, with a scripted facilitator and stub services (no RPC, no
// keys, no network): the catalog, the 402 challenge and its Bazaar declaration, payment matching against
// OUR requirements, verify/settle ordering per flow, pending and failed settlements, replays, CORS.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Keypair, PublicKey } from '@solana/web3.js';
import { LAUNCH_WALLET_DENYLIST } from '../../relayer/config.js';
import { RelayError } from '../../relayer/errors.js';
import { RateLimiter } from '../../relayer/ratelimit.js';
import { createRelayerServer } from '../../relayer/server.js';
import { X402_ROUTES, type X402Asset, type X402Service } from '../../relayer/x402/catalog.js';
import { X402Seller } from '../../relayer/x402/seller.js';
import { type PaymentRequired, type PaymentRequirements, SOLANA_MAINNET_NETWORK, decodeHeader, encodeHeader } from '../../relayer/x402/types.js';
import { FEE_PAYER, MockFacilitator, makePayment, paymentHeader } from './helpers/x402.js';

const treasury = new PublicKey('EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq');
const USDG = '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const assets: X402Asset[] = [
  { mint: USDG, symbol: 'USDG', decimals: 6, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', payToTokenAccount: 'DxpmCZYAoDKpHmA5vWuopUrf3UVuGnPvditVrN9xDwDo' },
  { mint: USDC, symbol: 'USDC', decimals: 6, tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', payToTokenAccount: Keypair.generate().publicKey.toBase58() },
];
const BASE = 'https://relayer.example';
const site = 'https://www.h081.xyz';

/** What the stub services do, scripted per test. */
const behaviour = { run: async (_id: string, body: unknown): Promise<unknown> => ({ echoed: body ?? null }) };
const events: string[] = [];
const logs: string[] = [];

const stub = (id: X402Service['id'], flow: X402Service['flow']): X402Service => ({
  id, ...X402_ROUTES[id], flow, mimeType: 'application/json', description: `stub ${id}`,
  inputExample: { a: 1 }, inputSchema: { type: 'object', properties: { a: { type: 'integer' } } }, outputExample: { echoed: { a: 1 } },
  async prepare(ctx) { events.push(`prepare ${id}`); return ctx.body; },
  async run(_ctx, prepared) { events.push(`run ${id}`); return behaviour.run(id, prepared); },
  abort() { events.push(`abort ${id}`); },
});

const facilitator = new MockFacilitator();
const prices = new Map<X402Service['id'], bigint>([['loans-market', 1_000n], ['relay-priority', 250_000n], ['preflight', 2_000n], ['prove-disclose', 0n]]);
const sellerOptions = () => ({
  facilitator, network: SOLANA_MAINNET_NETWORK, payTo: treasury, treasury, assets, prices, resourceBase: BASE, maxTimeoutSeconds: 120,
  serviceName: 'H081 Capital', tags: ['solana', 'bank'], log: (l: string) => logs.push(l),
  services: [stub('loans-market', 'settle-after'), stub('relay-priority', 'settle-first'), stub('preflight', 'settle-after'), stub('prove-disclose', 'settle-after')],
});

let server: Server;
let url: string;
let disabled: Server;
let disabledUrl: string;
beforeAll(async () => {
  server = createRelayerServer({ x402: new X402Seller(sellerOptions()), limiter: new RateLimiter({ perMinute: 600, burst: 100 }), corsOrigins: [site] });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  disabled = createRelayerServer({ limiter: new RateLimiter({ perMinute: 600, burst: 100 }) });
  await new Promise<void>((r) => disabled.listen(0, '127.0.0.1', r));
  disabledUrl = `http://127.0.0.1:${(disabled.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => disabled.close(() => r()));
});
beforeEach(() => {
  facilitator.reset();
  facilitator.verifyResult = { isValid: true, payer: 'payer' };
  facilitator.settleResults = [{ success: true, transaction: 'sig', network: SOLANA_MAINNET_NETWORK, payer: 'payer' }];
  behaviour.run = async (_id, body) => ({ echoed: body ?? null });
  events.length = 0;
  logs.length = 0;
});

const market = () => `${url}${X402_ROUTES['loans-market'].path}`;
const priority = () => `${url}${X402_ROUTES['relay-priority'].path}`;
const preflight = () => `${url}${X402_ROUTES.preflight.path}`;
const challengeOf = async (res: Response): Promise<PaymentRequired> => {
  const h = res.headers.get('PAYMENT-REQUIRED');
  expect(h, 'PAYMENT-REQUIRED header').toBeTruthy();
  return decodeHeader<PaymentRequired>(h!);
};
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; reason?: string } }).error;
const settlementOf = (res: Response) => decodeHeader<{ success: boolean; transaction: string; network: string; errorReason?: string }>(res.headers.get('PAYMENT-RESPONSE')!);

describe('catalog and disabled seller', () => {
  it('lists the enabled services with prices, bazaar input and schema; /v1/info points at it', async () => {
    const cat = (await (await fetch(`${url}/v1/x402/catalog`)).json()) as { enabled: boolean; payTo: string; services: Array<{ id: string; url: string; price: { amount: string }; enabled: boolean }> };
    expect(cat.enabled).toBe(true);
    expect(cat.payTo).toBe(treasury.toBase58());
    expect(cat.services.map((s) => s.id).sort()).toEqual(['loans-market', 'preflight', 'relay-priority']); // prove-disclose priced 0 is absent
    expect(cat.services.find((s) => s.id === 'loans-market')).toMatchObject({ url: `${BASE}/v1/x402/loans/market`, price: { amount: '1000', decimals: 6 }, enabled: true, input: { example: { a: 1 } } });
    expect(await (await fetch(`${url}/v1/info`)).json()).toMatchObject({ x402: { enabled: true, catalog: `${BASE}/v1/x402/catalog` } });
    expect((await fetch(`${url}${X402_ROUTES['prove-disclose'].path}`, { method: 'POST' })).status).toBe(503);
    expect((await fetch(market(), { method: 'POST' })).status).toBe(405);
  });

  it('without a seller the catalog says enabled:false and every paid route is 503 x402_disabled', async () => {
    const cat = (await (await fetch(`${disabledUrl}/v1/x402/catalog`)).json()) as { enabled: boolean; note: string; services: unknown[] };
    expect(cat).toMatchObject({ enabled: false, note: 'x402_disabled', services: [] });
    for (const r of Object.values(X402_ROUTES)) {
      const res = await fetch(`${disabledUrl}${r.path}`, { method: r.method, headers: paymentHeader({ x402Version: 2 }) });
      expect(res.status).toBe(503);
      expect((await errorOf(res)).code).toBe('x402_disabled');
    }
    expect(await (await fetch(`${disabledUrl}/v1/info`)).json()).toMatchObject({ x402: { enabled: false } });
  });
});

describe('the 402 challenge', () => {
  it('carries our requirements (one per asset, feePayer from /supported) and the bazaar declaration in header and body', async () => {
    const res = await fetch(market());
    expect(res.status).toBe(402);
    const pr = await challengeOf(res);
    expect(await res.json()).toEqual(pr);
    expect(pr.x402Version).toBe(2);
    expect(pr.resource).toEqual({ url: `${BASE}/v1/x402/loans/market`, description: 'stub loans-market', mimeType: 'application/json', serviceName: 'H081 Capital', tags: ['solana', 'bank'] });
    expect(pr.accepts).toHaveLength(2);
    expect(pr.accepts[0]).toEqual({ scheme: 'exact', network: SOLANA_MAINNET_NETWORK, amount: '1000', asset: USDG, payTo: treasury.toBase58(), maxTimeoutSeconds: 120, extra: { feePayer: FEE_PAYER } });
    expect(pr.accepts[1]).toMatchObject({ asset: USDC, amount: '1000', payTo: treasury.toBase58() });
    const bazaar = pr.extensions!.bazaar as { info: { input: Record<string, unknown>; output: Record<string, unknown> }; schema: Record<string, unknown> };
    expect(bazaar.info.input).toEqual({ type: 'http', method: 'GET', discoverable: true, queryParams: {} });
    expect(bazaar.info.output).toEqual({ type: 'json', example: { echoed: { a: 1 } } });
    expect(bazaar.schema).toMatchObject({ $schema: 'https://json-schema.org/draft/2020-12/schema', required: ['input'] });
    // a POST service declares its body and schema
    const post = await challengeOf(await fetch(preflight(), { method: 'POST' }));
    const pb = post.extensions!.bazaar as { info: { input: Record<string, unknown> }; schema: { properties: { input: { properties: { body: unknown } } } } };
    expect(pb.info.input).toEqual({ type: 'http', method: 'POST', discoverable: true, bodyType: 'json', body: { a: 1 } });
    expect(pb.schema.properties.input.properties.body).toEqual({ type: 'object', properties: { a: { type: 'integer' } } });
    expect(post.accepts[0]).toMatchObject({ amount: '2000' });
    expect(facilitator.count('supported')).toBe(1); // cached across requests
  });

  it('answers 503 facilitator_unavailable when /supported fails', async () => {
    const seller = new X402Seller({ ...sellerOptions(), facilitator: Object.assign(new MockFacilitator(), { supportedResult: new Error('down') }) });
    const s = createRelayerServer({ x402: seller, limiter: new RateLimiter({ perMinute: 60, burst: 10 }) });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    try {
      const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}${X402_ROUTES['loans-market'].path}`);
      expect(res.status).toBe(503);
      expect((await errorOf(res)).code).toBe('facilitator_unavailable');
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});

describe('payment matching (before the facilitator is asked)', () => {
  it('refuses a malformed header, a v1 payment, and a requirement that is not ours', async () => {
    const pr = await challengeOf(await fetch(market()));
    const bad = await fetch(market(), { headers: { 'payment-signature': '%%%not-base64-json' } });
    expect(bad.status).toBe(402);
    expect((await errorOf(bad)).code).toBe('invalid_payload');
    expect(bad.headers.get('PAYMENT-REQUIRED')).toBeTruthy();
    const v1 = await fetch(market(), { headers: paymentHeader({ ...makePayment(pr), x402Version: 1 }) });
    expect((await errorOf(v1)).code).toBe('invalid_x402_version');
    for (const accepted of [{ amount: '1' }, { payTo: Keypair.generate().publicKey.toBase58() }, { asset: Keypair.generate().publicKey.toBase58() }, { network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' }]) {
      const res = await fetch(market(), { headers: paymentHeader(makePayment(pr, { accepted })) });
      expect(res.status).toBe(402);
      expect((await errorOf(res)).code).toBe('invalid_payment_requirements');
    }
    const noTx = await fetch(market(), { headers: paymentHeader(makePayment(pr, { payload: { transaction: 'x'.repeat(3000) } })) });
    expect((await errorOf(noTx)).code).toBe('invalid_payload');
    expect(facilitator.count('verify')).toBe(0);
    expect(events).toEqual([]);
  });

  it('an overpaying client is accepted; the second asset is accepted too', async () => {
    const pr = await challengeOf(await fetch(market()));
    const more = await fetch(market(), { headers: paymentHeader(makePayment(pr, { accepted: { amount: '5000' } })) });
    expect(more.status).toBe(200);
    const usdc = await fetch(market(), { headers: paymentHeader(makePayment(pr, {}, 1)) });
    expect(usdc.status).toBe(200);
    // the requirement sent to the facilitator is always ours
    const sent = facilitator.calls.filter((c) => c.name === 'verify').map((c) => c.requirements as PaymentRequirements);
    expect(sent[0]).toMatchObject({ amount: '1000', asset: USDG, payTo: treasury.toBase58(), extra: { feePayer: FEE_PAYER } });
    expect(sent[1]).toMatchObject({ amount: '1000', asset: USDC, payTo: treasury.toBase58() });
  });
});

describe('verify and settle', () => {
  it('an invalid payment is a 402 payment_invalid with the reason and the challenge again', async () => {
    const pr = await challengeOf(await fetch(market()));
    facilitator.verifyResult = { isValid: false, invalidReason: 'insufficient_funds' };
    const res = await fetch(market(), { headers: paymentHeader(makePayment(pr)) });
    expect(res.status).toBe(402);
    expect(await errorOf(res)).toMatchObject({ code: 'payment_invalid', reason: 'insufficient_funds' });
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeTruthy();
    expect(facilitator.count('settle')).toBe(0);
    expect(events).toEqual([]);
  });

  it('settle-after: runs the handler, then settles with our requirements; a failing handler is not charged', async () => {
    const pr = await challengeOf(await fetch(market()));
    const res = await fetch(market(), { headers: paymentHeader(makePayment(pr)) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echoed: null });
    expect(events).toEqual(['prepare loans-market', 'run loans-market']);
    expect(facilitator.calls.map((c) => c.name)).toEqual(['verify', 'settle']);
    expect(facilitator.calls[1].requirements).toMatchObject({ amount: '1000', payTo: treasury.toBase58(), asset: USDG });
    expect(facilitator.calls[1].payload?.payload.transaction).toBeTruthy();
    expect(settlementOf(res)).toEqual({ success: true, transaction: 'sig', network: SOLANA_MAINNET_NETWORK, payer: 'payer' });
    // a POST settle-after service gets its body; a refusal from the handler is returned unsettled
    facilitator.reset();
    behaviour.run = async () => { throw new RelayError(422, 'simulation_failed', 'nope'); };
    const pp = await challengeOf(await fetch(preflight(), { method: 'POST' }));
    const fail = await fetch(preflight(), { method: 'POST', headers: { ...paymentHeader(makePayment(pp)), 'content-type': 'application/json' }, body: JSON.stringify({ a: 2 }) });
    expect(fail.status).toBe(422);
    expect((await errorOf(fail)).code).toBe('simulation_failed');
    expect(facilitator.count('settle')).toBe(0);
    expect(fail.headers.get('PAYMENT-RESPONSE')).toBeNull();
    // a body that is not JSON is a 400 before any payment is touched
    facilitator.reset();
    const badJson = await fetch(preflight(), { method: 'POST', headers: paymentHeader(makePayment(pp)), body: 'not json' });
    expect(badJson.status).toBe(400);
    expect(facilitator.count('verify')).toBe(0);
  });

  it('settle-first: settles before the handler; a prepare refusal is not charged; a failure after settlement is answered with the receipt', async () => {
    const pr = await challengeOf(await fetch(priority(), { method: 'POST' }));
    const ok = await fetch(priority(), { method: 'POST', headers: paymentHeader(makePayment(pr)), body: JSON.stringify({ op: 'transact' }) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ echoed: { op: 'transact' } });
    expect(events).toEqual(['prepare relay-priority', 'run relay-priority']);
    expect(facilitator.calls.map((c) => c.name)).toEqual(['verify', 'settle']);
    expect(settlementOf(ok).success).toBe(true);
    // refused in prepare (fee too low etc.): nothing settled
    facilitator.reset(); events.length = 0;
    const refusing = { ...stub('relay-priority', 'settle-first'), prepare: async () => { throw new RelayError(402, 'fee_too_low', 'low'); } };
    const s2 = new X402Seller({ ...sellerOptions(), services: [refusing] });
    const srv = createRelayerServer({ x402: s2, limiter: new RateLimiter({ perMinute: 60, burst: 10 }) });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const u2 = `http://127.0.0.1:${(srv.address() as AddressInfo).port}${X402_ROUTES['relay-priority'].path}`;
    try {
      const refused = await fetch(u2, { method: 'POST', headers: paymentHeader(makePayment(pr)), body: '{}' });
      expect(refused.status).toBe(402);
      expect((await errorOf(refused)).code).toBe('fee_too_low');
      // (a fresh seller asks /supported once for its fee payer)
      expect(facilitator.calls.map((c) => c.name).filter((n) => n !== 'supported')).toEqual(['verify']);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
    // the handler fails after the settlement: its status, the receipt attached, a log line
    facilitator.reset(); events.length = 0; logs.length = 0;
    behaviour.run = async () => { throw new RelayError(502, 'send_failed', 'expired'); };
    const failed = await fetch(priority(), { method: 'POST', headers: paymentHeader(makePayment(pr)), body: '{}' });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: { code: 'send_failed', charged: true, settlement: { success: true, transaction: 'sig' } } });
    expect(settlementOf(failed).success).toBe(true);
    expect(facilitator.calls.map((c) => c.name)).toEqual(['verify', 'settle']);
    expect(logs.some((l) => l.includes('failed after settlement') && l.includes('charged'))).toBe(true);
  });

  it('settlement_pending is retried once, then served with a pending receipt and a log line; other failures are 402 settlement_failed', async () => {
    const pr = await challengeOf(await fetch(market()));
    const pending = { success: false, errorReason: 'settlement_pending', transaction: 'sigP', network: SOLANA_MAINNET_NETWORK };
    facilitator.settleResults = [pending, pending];
    const res = await fetch(market(), { headers: paymentHeader(makePayment(pr)) });
    expect(res.status).toBe(200);
    expect(facilitator.count('settle')).toBe(2);
    expect(settlementOf(res)).toMatchObject({ success: false, errorReason: 'settlement_pending', transaction: 'sigP' });
    expect(logs.some((l) => l.includes('x402 pending sigP'))).toBe(true);
    // pending, then success on the retry
    facilitator.reset();
    facilitator.settleResults = [pending, { success: true, transaction: 'sigP', network: SOLANA_MAINNET_NETWORK }];
    const ok = await fetch(market(), { headers: paymentHeader(makePayment(pr)) });
    expect(settlementOf(ok).success).toBe(true);
    // a definite failure (settle-first: the work is not done)
    facilitator.reset(); events.length = 0;
    facilitator.settleResults = [{ success: false, errorReason: 'invalid_transaction_state', transaction: '', network: SOLANA_MAINNET_NETWORK }];
    const pp = await challengeOf(await fetch(priority(), { method: 'POST' }));
    const failed = await fetch(priority(), { method: 'POST', headers: paymentHeader(makePayment(pp)), body: '{}' });
    expect(failed.status).toBe(402);
    expect(await errorOf(failed)).toMatchObject({ code: 'settlement_failed', reason: 'invalid_transaction_state' });
    expect(settlementOf(failed).success).toBe(false);
    expect(events).toEqual(['prepare relay-priority', 'abort relay-priority']);
    // the facilitator itself failing on settle is a 503 (settle-first: aborted, nothing charged)
    facilitator.reset(); events.length = 0;
    facilitator.settleResults = [new Error('boom')];
    const down = await fetch(priority(), { method: 'POST', headers: paymentHeader(makePayment(pp)), body: '{}' });
    expect(down.status).toBe(503);
    expect((await errorOf(down)).code).toBe('facilitator_unavailable');
    expect(events).toEqual(['prepare relay-priority', 'abort relay-priority']);
  });

  it('a replayed payment is refused 409 without asking the facilitator again', async () => {
    const pr = await challengeOf(await fetch(market()));
    const payment = makePayment(pr);
    expect((await fetch(market(), { headers: paymentHeader(payment) })).status).toBe(200);
    const again = await fetch(market(), { headers: paymentHeader(payment) });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe('payment_replayed');
    expect(facilitator.count('verify')).toBe(1);
    // the same transaction inside a re-encoded header is still the same payment
    const reencoded = { 'payment-signature': encodeHeader({ ...payment, extensions: { other: 1 } }) };
    expect((await fetch(market(), { headers: reencoded })).status).toBe(409);
  });

  it('logs the bazaar status the facilitator reports in EXTENSION-RESPONSES', async () => {
    const pr = await challengeOf(await fetch(market()));
    facilitator.settleResults = [{ success: true, transaction: 'sig', network: SOLANA_MAINNET_NETWORK, extensionResponses: { bazaar: { status: 'rejected', rejectedReason: 'x' } } }];
    const res = await fetch(market(), { headers: paymentHeader(makePayment(pr)) });
    expect(res.status).toBe(200);
    expect(logs.some((l) => l.includes('bazaar rejected: x'))).toBe(true);
    // the transport extra never reaches the client
    expect(settlementOf(res)).not.toHaveProperty('extensionResponses');
  });
});

describe('guards', () => {
  it('refuses a launch wallet or a non-treasury payTo, and assets that are not 6-decimal', () => {
    for (const w of LAUNCH_WALLET_DENYLIST) expect(() => new X402Seller({ ...sellerOptions(), payTo: new PublicKey(w), treasury: new PublicKey(w) })).toThrow(/launch wallet/);
    expect(() => new X402Seller({ ...sellerOptions(), payTo: Keypair.generate().publicKey })).toThrow(/platform treasury/);
    expect(() => new X402Seller({ ...sellerOptions(), assets: [{ ...assets[0], decimals: 9 }] })).toThrow(/6-decimal/);
  });

  it('CORS: the site may send payment-signature and read PAYMENT-REQUIRED / PAYMENT-RESPONSE', async () => {
    const pre = await fetch(market(), { method: 'OPTIONS', headers: { origin: site } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toContain('payment-signature');
    const res = await fetch(market(), { headers: { origin: site } });
    expect(res.status).toBe(402);
    expect(res.headers.get('access-control-expose-headers')).toBe('PAYMENT-REQUIRED, PAYMENT-RESPONSE');
  });

  it('paid calls take a rate-limit token; the unpaid challenge does not', async () => {
    const seller = new X402Seller(sellerOptions());
    const s = createRelayerServer({ x402: seller, limiter: new RateLimiter({ perMinute: 1, burst: 1 }) });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const u = `http://127.0.0.1:${(s.address() as AddressInfo).port}${X402_ROUTES['loans-market'].path}`;
    try {
      const pr = await challengeOf(await fetch(u));
      expect((await fetch(u)).status).toBe(402);
      expect((await fetch(u, { headers: paymentHeader(makePayment(pr)) })).status).toBe(200);
      const limited = await fetch(u, { headers: paymentHeader(makePayment(pr)) });
      expect(limited.status).toBe(429);
      expect((await fetch(u)).status).toBe(402);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});
