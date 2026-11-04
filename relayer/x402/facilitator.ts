// The x402 facilitator the seller settles through: Coinbase's CDP facilitator (verify, settle and supported,
// each behind a per-request CDP JWT). A thin client over global fetch, no SDK. Tests bring their own
// Facilitator (test/relayer/helpers/x402.ts).
import { type CdpKey, cdpJwt, parseCdpSecret } from './cdp-auth.js';
import {
  EXTENSION_RESPONSES_HEADER, type PaymentPayloadV2, type PaymentRequirements, type SettleResponse, type SupportedResponse, type VerifyResponse,
} from './types.js';

export const DEFAULT_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';
export const DEFAULT_FACILITATOR_TIMEOUT_MS = 30_000;

/** Per-extension outcomes the facilitator reports in the EXTENSION-RESPONSES header (bazaar status etc.). */
export type ExtensionResponses = Record<string, unknown>;

export type Verified = VerifyResponse & { extensionResponses?: ExtensionResponses };
export type Settled = SettleResponse & { extensionResponses?: ExtensionResponses };

export interface Facilitator {
  supported(): Promise<SupportedResponse>;
  verify(paymentPayload: PaymentPayloadV2, paymentRequirements: PaymentRequirements): Promise<Verified>;
  settle(paymentPayload: PaymentPayloadV2, paymentRequirements: PaymentRequirements): Promise<Settled>;
}

/** A transport or protocol failure talking to the facilitator (not a verdict about the payment). */
export class FacilitatorError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** The fee payer of the `exact` scheme on `network` from a /supported response (x402 v2 kinds only). */
export function feePayerFor(supported: SupportedResponse, network: string): string {
  const kind = (supported.kinds ?? []).find((k) => k.scheme === 'exact' && Number(k.x402Version) === 2 && k.network === network);
  const feePayer = kind?.extra?.feePayer;
  if (typeof feePayer !== 'string' || !feePayer) throw new FacilitatorError(0, `the facilitator has no exact kind for ${network}`);
  return feePayer;
}

export interface CdpFacilitatorOptions {
  url?: string;
  apiKeyId: string;
  apiKeySecret: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** unix seconds (JWT nbf/exp); default: wall clock */
  now?: () => number;
}

const FEE_PAYER_TTL_MS = 10 * 60_000;

export class CdpFacilitator implements Facilitator {
  readonly base: URL;
  private readonly key: CdpKey;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;
  private feePayers = new Map<string, { at: number; value: string }>();

  constructor(readonly opts: CdpFacilitatorOptions) {
    this.base = new URL((opts.url ?? DEFAULT_FACILITATOR_URL).replace(/\/+$/, ''));
    this.key = parseCdpSecret(opts.apiKeySecret);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_FACILITATOR_TIMEOUT_MS;
    this.doFetch = opts.fetch ?? fetch;
  }

  private async call<T>(method: 'GET' | 'POST', name: 'verify' | 'settle' | 'supported', body?: unknown, retry = true): Promise<T & { extensionResponses?: ExtensionResponses }> {
    const url = new URL(`${this.base.pathname}/${name}`, this.base);
    const jwt = cdpJwt({ keyId: this.opts.apiKeyId, secret: this.key, method, host: url.host, path: url.pathname, now: this.opts.now?.() });
    let res: Response;
    try {
      res = await this.doFetch(url, {
        method, headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json', accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new FacilitatorError(0, `facilitator ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 429 && retry && method === 'GET') {
      const after = Number(res.headers.get('retry-after') ?? '1');
      await new Promise((r) => setTimeout(r, Math.min(5_000, Math.max(0, after) * 1000)));
      return this.call<T>(method, name, body, false);
    }
    const text = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    const obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
    const extensionResponses = decodeExtensionResponses(res.headers.get(EXTENSION_RESPONSES_HEADER));
    if (!res.ok) {
      // the facilitator reports an invalid payment or a pending settlement with a 4xx/5xx and the regular body
      const verdict = obj && ((name === 'verify' && 'isValid' in obj) || (name === 'settle' && 'success' in obj));
      if (!verdict) throw new FacilitatorError(res.status, `facilitator ${name} answered ${res.status}: ${text.slice(0, 300)}`);
    } else if (!obj) {
      throw new FacilitatorError(res.status, `facilitator ${name} answered non-JSON: ${text.slice(0, 300)}`);
    }
    return { ...(obj as T), ...(extensionResponses ? { extensionResponses } : {}) };
  }

  supported(): Promise<SupportedResponse> {
    return this.call<SupportedResponse>('GET', 'supported');
  }

  verify(paymentPayload: PaymentPayloadV2, paymentRequirements: PaymentRequirements): Promise<Verified> {
    return this.call<VerifyResponse>('POST', 'verify', { x402Version: 2, paymentPayload, paymentRequirements });
  }

  settle(paymentPayload: PaymentPayloadV2, paymentRequirements: PaymentRequirements): Promise<Settled> {
    return this.call<SettleResponse>('POST', 'settle', { x402Version: 2, paymentPayload, paymentRequirements });
  }

  /** The facilitator's fee payer for the exact scheme on `network`, cached for 10 minutes. */
  async feePayerFor(network: string): Promise<string> {
    const hit = this.feePayers.get(network);
    if (hit && Date.now() - hit.at < FEE_PAYER_TTL_MS) return hit.value;
    const value = feePayerFor(await this.supported(), network);
    this.feePayers.set(network, { at: Date.now(), value });
    return value;
  }
}

/** Decodes an EXTENSION-RESPONSES header (base64 JSON); undefined when absent or unreadable. */
export function decodeExtensionResponses(header: string | null | undefined): ExtensionResponses | undefined {
  if (!header) return undefined;
  try {
    const v = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    return v && typeof v === 'object' ? (v as ExtensionResponses) : undefined;
  } catch {
    return undefined;
  }
}
