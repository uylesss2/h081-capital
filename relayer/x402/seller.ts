// The x402 seller: answers a paid route with a 402 challenge until the request carries a PAYMENT-SIGNATURE,
// then has the facilitator verify the payment, settles it (before or after the work, per service) and
// answers with the result and a PAYMENT-RESPONSE header. The requirements sent to the facilitator are always
// our own (price, asset, payTo = the treasury); the client's `accepted` is only matched against them.
//
// Without CDP credentials no seller exists (relayer/app.ts leaves it undefined) and the routes answer 503
// x402_disabled: nothing ever pretends to settle.
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PublicKey } from '@solana/web3.js';
import { isDenyListed } from '../config.js';
import { RelayError, toRelayError } from '../errors.js';
import { fail, header, json, readBody } from '../http.js';
import {
  type X402Asset, type X402Service, type X402ServiceId, buildPaymentRequired, catalogView, paymentRequirements,
} from './catalog.js';
import { type Facilitator, FacilitatorError, type Settled, feePayerFor } from './facilitator.js';
import { type PaymentPayloadV2, type PaymentRequired, type PaymentRequirements, X402_HEADERS, decodeHeader, encodeHeader } from './types.js';

export interface X402SellerOptions {
  facilitator: Facilitator;
  network: string;
  /** owner of the payment token accounts: the platform treasury; never a launch wallet */
  payTo: PublicKey;
  /** the treasury's own key as configured (payTo must equal it) */
  treasury?: PublicKey;
  assets: X402Asset[];
  prices: Map<X402ServiceId, bigint>;
  services: X402Service[];
  resourceBase: string;
  maxTimeoutSeconds: number;
  serviceName: string;
  tags: string[];
  iconUrl?: string;
  log?: (line: string) => void;
  /** the request body limit (bytes); default 256 KiB */
  maxBodyBytes?: number;
  now?: () => number;
  /** how long the facilitator's fee payer is cached (ms); default 10 minutes */
  feePayerTtlMs?: number;
}

/** Payments this instance has seen (sha256 of the transaction), so one signed payment buys one call. */
const REPLAY_SET_MAX = 10_000;
const MAX_TRANSACTION_B64 = 2 * 1024;

export class X402Seller {
  readonly services: X402Service[];
  private readonly seen = new Set<string>();
  private feePayer?: { at: number; value: string };
  private readonly log: (line: string) => void;

  constructor(readonly opts: X402SellerOptions) {
    if (isDenyListed(opts.payTo)) throw new Error(`x402 payTo ${opts.payTo.toBase58()} is an H081 launch wallet; paid services never pay a launch wallet`);
    if (opts.treasury && !opts.treasury.equals(opts.payTo)) throw new Error('x402 payTo must be the platform treasury');
    if (opts.assets.length === 0) throw new Error('x402: at least one payment asset is required');
    for (const a of opts.assets) if (a.decimals !== 6) throw new Error(`x402 asset ${a.mint} has ${a.decimals} decimals; prices are in 6-decimal base units`);
    // a service priced at 0 is disabled: not advertised, not served
    this.services = opts.services.filter((s) => (opts.prices.get(s.id) ?? 0n) > 0n);
    this.log = opts.log ?? (() => undefined);
  }

  /** The service behind a route, or undefined (disabled services are undefined too). */
  find(method: string | undefined, path: string): X402Service | undefined {
    return this.services.find((s) => s.path === path && s.method === method);
  }

  /** Any configured service at `path`, enabled or not, to answer 405 / 503 correctly. */
  routeAt(path: string): X402Service | undefined {
    return this.opts.services.find((s) => s.path === path);
  }

  private price(service: X402Service): bigint {
    return this.opts.prices.get(service.id) ?? 0n;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** The facilitator's fee payer for our network, cached (one /supported call per 10 minutes per instance). */
  async feePayerFor(): Promise<string> {
    const ttl = this.opts.feePayerTtlMs ?? 10 * 60_000;
    if (this.feePayer && this.now() - this.feePayer.at < ttl) return this.feePayer.value;
    const value = feePayerFor(await this.opts.facilitator.supported(), this.opts.network);
    this.feePayer = { at: this.now(), value };
    return value;
  }

  private requirements(service: X402Service, feePayer: string): PaymentRequirements[] {
    return paymentRequirements({
      price: this.price(service), assets: this.opts.assets, payTo: this.opts.payTo.toBase58(), feePayer, network: this.opts.network,
      maxTimeoutSeconds: this.opts.maxTimeoutSeconds,
    });
  }

  private paymentRequired(service: X402Service, feePayer: string): PaymentRequired {
    const o = this.opts;
    return buildPaymentRequired({
      service, url: `${o.resourceBase}${service.path}`, price: this.price(service), assets: o.assets, payTo: o.payTo.toBase58(), feePayer,
      network: o.network, maxTimeoutSeconds: o.maxTimeoutSeconds, serviceName: o.serviceName, tags: o.tags, iconUrl: o.iconUrl,
    });
  }

  /** The free catalog (GET /v1/x402/catalog). */
  catalog() {
    const o = this.opts;
    return catalogView({
      enabled: true, services: this.services, prices: o.prices, assets: o.assets, payTo: o.payTo.toBase58(), network: o.network,
      resourceBase: o.resourceBase, feePayer: this.feePayer?.value,
    });
  }

  /** Answers one request to a paid route. */
  async handle(req: IncomingMessage, res: ServerResponse, service: X402Service, url: URL, clientKey: string): Promise<void> {
    const paymentHeader = header(req, X402_HEADERS.v2.payment);
    let feePayer: string;
    try {
      feePayer = await this.feePayerFor();
    } catch (e) {
      this.log(`x402 ${service.id} facilitator unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return fail(res, new RelayError(503, 'facilitator_unavailable', 'the payment facilitator is not reachable; retry shortly'));
    }
    const required = this.paymentRequired(service, feePayer);
    // a refused payment: the error, and the challenge again (header and body) so the client can pay properly
    const challenge = (code: string, message: string, extra: Record<string, unknown> = {}) =>
      json(res, 402, { error: { code, message, ...extra }, paymentRequired: required }, { [X402_HEADERS.v2.required]: encodeHeader(required) });
    if (!paymentHeader) return json(res, 402, required, { [X402_HEADERS.v2.required]: encodeHeader(required) });
    // our requirements are v2 (the seller builds them); the shared PaymentRequired type also allows v1 entries
    const accepts = required.accepts as PaymentRequirements[];

    // ---- decode and match the payment against OUR requirements
    let payment: PaymentPayloadV2;
    try {
      payment = decodeHeader<PaymentPayloadV2>(paymentHeader);
      if (!payment || typeof payment !== 'object') throw new Error('not an object');
    } catch {
      return challenge('invalid_payload', 'PAYMENT-SIGNATURE is not base64 JSON');
    }
    if (Number(payment.x402Version) !== 2) return challenge('invalid_x402_version', 'only x402 v2 (PAYMENT-SIGNATURE) payments are accepted');
    const accepted = payment.accepted;
    const ours = accepted && typeof accepted === 'object'
      ? accepts.find((r) => r.scheme === accepted.scheme && r.network === accepted.network && r.asset === accepted.asset)
      : undefined;
    const amountOk = ours && typeof accepted.amount === 'string' && /^\d+$/.test(accepted.amount) && BigInt(accepted.amount) >= BigInt(ours.amount);
    if (!ours || !amountOk || accepted.payTo !== ours.payTo) {
      return challenge('invalid_payment_requirements', 'the accepted requirement does not match this service (scheme, network, asset, amount, payTo)');
    }
    const tx = payment.payload?.transaction;
    if (typeof tx !== 'string' || tx.length === 0 || tx.length > MAX_TRANSACTION_B64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(tx)) {
      return challenge('invalid_payload', 'payload.transaction must be a base64 transaction of at most 2 KiB');
    }
    // the requirement we verify and settle against is ours, never the client's copy
    const requirement: PaymentRequirements = { ...ours, extra: { ...(ours.extra ?? {}), feePayer } };
    const payload: PaymentPayloadV2 = { ...payment, accepted: requirement };

    // ---- the body (a malformed body is refused before any payment is touched)
    let body: unknown;
    try {
      body = service.method === 'POST' ? await readBody(req, this.opts.maxBodyBytes ?? 256 * 1024) : undefined;
    } catch (e) {
      return fail(res, toRelayError(e));
    }

    // ---- replay guard (per instance; the facilitator / chain is the authority across instances)
    const key = createHash('sha256').update(tx).digest('hex');
    if (this.seen.has(key)) return fail(res, new RelayError(409, 'payment_replayed', 'this payment was already presented to this relayer'));
    this.remember(key);

    // ---- verify
    const facilitator = this.opts.facilitator;
    let verified;
    try {
      verified = await facilitator.verify(payload, requirement);
    } catch (e) {
      this.seen.delete(key);
      return this.facilitatorFailed(res, service, 'verify', e);
    }
    this.logExtensions(service, 'verify', verified.extensionResponses);
    if (!verified.isValid) {
      this.log(`x402 ${service.id} payment invalid: ${verified.invalidReason ?? 'unknown'}`);
      return challenge('payment_invalid', `the payment did not verify: ${verified.invalidReason ?? 'unknown'}`, { reason: verified.invalidReason });
    }

    // ---- the work and the settlement, in the service's order
    const ctx = { body, url, clientKey, log: this.log };
    const started = this.now();
    let prepared: unknown;
    try {
      prepared = service.prepare ? await service.prepare(ctx) : undefined;
    } catch (e) {
      const err = toRelayError(e);
      this.log(`x402 ${service.id} refused before payment ${err.status} ${err.code} ${err.message.slice(0, 200)}`);
      return fail(res, err);
    }
    if (service.flow === 'settle-after') {
      let out: unknown;
      try {
        out = await service.run(ctx, prepared);
      } catch (e) {
        const err = toRelayError(e);
        this.log(`x402 ${service.id} failed unsettled ${err.status} ${err.code} ${err.message.slice(0, 200)}`);
        return fail(res, err);
      }
      const settled = await this.settle(payload, requirement, service);
      if (settled instanceof FacilitatorError) return this.facilitatorFailed(res, service, 'settle', settled);
      const responseHeader = { [X402_HEADERS.v2.response]: encodeHeader(settlementOf(settled)) };
      if (!settled.success && settled.errorReason !== 'settlement_pending') {
        return fail(res, new RelayError(402, 'settlement_failed', `the payment did not settle: ${settled.errorReason ?? 'unknown'}`), responseHeader, { reason: settled.errorReason });
      }
      this.log(`x402 ${service.id} ok ${this.now() - started}ms ${settled.success ? 'settled' : 'pending'} ${settled.transaction}`);
      return json(res, 200, out, responseHeader);
    }
    // settle-first: the charge buys the attempt
    const settled = await this.settle(payload, requirement, service);
    if (settled instanceof FacilitatorError) {
      service.abort?.(prepared);
      return this.facilitatorFailed(res, service, 'settle', settled);
    }
    const responseHeader = { [X402_HEADERS.v2.response]: encodeHeader(settlementOf(settled)) };
    if (!settled.success && settled.errorReason !== 'settlement_pending') {
      service.abort?.(prepared);
      return fail(res, new RelayError(402, 'settlement_failed', `the payment did not settle: ${settled.errorReason ?? 'unknown'}`), responseHeader, { reason: settled.errorReason });
    }
    try {
      const out = await service.run(ctx, prepared);
      this.log(`x402 ${service.id} ok ${this.now() - started}ms ${settled.success ? 'settled' : 'pending'} ${settled.transaction}`);
      return json(res, 200, out, responseHeader);
    } catch (e) {
      const err = toRelayError(e);
      this.log(`x402 ${service.id} failed after settlement ${settled.transaction}: ${err.status} ${err.code} ${err.message.slice(0, 200)} (charged)`);
      return fail(res, err, responseHeader, { charged: true, settlement: settlementOf(settled) });
    }
  }

  /** Settles; a `settlement_pending` answer is retried once with identical inputs and then reported as pending. */
  private async settle(payload: PaymentPayloadV2, requirement: PaymentRequirements, service: X402Service): Promise<Settled | FacilitatorError> {
    let settled: Settled;
    try {
      settled = await this.opts.facilitator.settle(payload, requirement);
      this.logExtensions(service, 'settle', settled.extensionResponses);
      if (!settled.success && settled.errorReason === 'settlement_pending') {
        settled = await this.opts.facilitator.settle(payload, requirement);
        this.logExtensions(service, 'settle', settled.extensionResponses);
      }
    } catch (e) {
      return e instanceof FacilitatorError ? e : new FacilitatorError(0, e instanceof Error ? e.message : String(e));
    }
    if (!settled.success && settled.errorReason === 'settlement_pending') {
      this.log(`x402 pending ${settled.transaction} ${service.id} (reconcile on chain: payTo ${this.opts.payTo.toBase58()})`);
    } else if (!settled.success) {
      this.log(`x402 ${service.id} settlement failed: ${settled.errorReason ?? 'unknown'}`);
    }
    return settled;
  }

  private facilitatorFailed(res: ServerResponse, service: X402Service, step: string, e: unknown) {
    this.log(`x402 ${service.id} facilitator ${step} failed: ${e instanceof Error ? e.message : String(e)}`);
    return fail(res, new RelayError(503, 'facilitator_unavailable', `the payment facilitator did not answer ${step}; nothing was charged`));
  }

  private logExtensions(service: X402Service, step: string, ext?: Record<string, unknown>) {
    if (!ext) return;
    const bazaar = ext.bazaar as { status?: string; rejectedReason?: string } | undefined;
    if (bazaar) this.log(`x402 ${service.id} ${step} bazaar ${bazaar.status ?? '?'}${bazaar.rejectedReason ? `: ${bazaar.rejectedReason}` : ''}`);
    else this.log(`x402 ${service.id} ${step} extensions ${JSON.stringify(ext).slice(0, 300)}`);
  }

  private remember(key: string) {
    if (this.seen.size >= REPLAY_SET_MAX) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.add(key);
  }
}

/** The PAYMENT-RESPONSE body: the facilitator's settlement without our transport extras. */
function settlementOf(s: Settled) {
  const { extensionResponses: _x, ...rest } = s;
  return rest;
}
