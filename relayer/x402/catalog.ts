// The paid services the relayer sells over x402 and how they are advertised: the 402 challenge
// (PaymentRequired with one `exact` requirement per accepted asset) and the CDP Bazaar discovery
// declaration (`extensions.bazaar`), plus the free catalog view.
import type { BazaarDeclaration, PaymentRequired, PaymentRequirements } from './types.js';

export const X402_SERVICE_IDS = ['relay-priority', 'preflight', 'loans-market', 'prove-disclose'] as const;
export type X402ServiceId = (typeof X402_SERVICE_IDS)[number];

/** Routes of the paid services (the server also needs them when the seller is disabled, to answer 503). */
export const X402_ROUTES: Record<X402ServiceId, { method: 'GET' | 'POST'; path: string }> = {
  'relay-priority': { method: 'POST', path: '/v1/x402/solana/relay-priority' },
  preflight: { method: 'POST', path: '/v1/x402/solana/preflight' },
  'loans-market': { method: 'GET', path: '/v1/x402/loans/market' },
  'prove-disclose': { method: 'POST', path: '/v1/x402/prove/disclose' },
};
export const X402_CATALOG_PATH = '/v1/x402/catalog';

/** The CDP facilitator refuses verify/settle when `resource.description` is longer than this (Bazaar listing text). */
export const MAX_DESCRIPTION_LENGTH = 500;

/** Default prices in 6-decimal base units (USDG/USDC): 0.25, 0.002, 0.001 and 0.02. Placeholders for the operator. */
export const DEFAULT_X402_PRICES: Record<X402ServiceId, bigint> = {
  'relay-priority': 250_000n, preflight: 2_000n, 'loans-market': 1_000n, 'prove-disclose': 20_000n,
};

export interface ServiceContext {
  /** the parsed JSON body (POST), undefined for GET */
  body: unknown;
  url: URL;
  clientKey: string;
  log: (line: string) => void;
}

/**
 * One paid service. `prepare` runs before the payment is settled and may refuse with a RelayError (the caller
 * is never charged for a refusal); `run` does the work. settle-first services run after settlement (the
 * charge buys the attempt); settle-after services run before it (no charge when the work fails).
 */
export interface X402Service<P = unknown> {
  id: X402ServiceId;
  method: 'GET' | 'POST';
  path: string;
  /** plain statement of what the call returns, at most MAX_DESCRIPTION_LENGTH characters (the seller refuses longer ones) */
  description: string;
  flow: 'settle-first' | 'settle-after';
  inputExample: unknown;
  /** JSON Schema 2020-12 of the POST body (additionalProperties false) */
  inputSchema: Record<string, unknown>;
  outputExample: unknown;
  outputSchema?: Record<string, unknown>;
  mimeType: 'application/json';
  prepare?(ctx: ServiceContext): Promise<P>;
  run(ctx: ServiceContext, prepared: P): Promise<unknown>;
  /** called when the payment fails after `prepare` (release what prepare reserved) */
  abort?(prepared: P): void;
}

export const JSON_SCHEMA_2020 = 'https://json-schema.org/draft/2020-12/schema';

/** The `extensions.bazaar` declaration of a service: the example input the Bazaar can replay and the schema it must satisfy. */
export function bazaarDeclaration(s: Pick<X402Service, 'method' | 'inputExample' | 'inputSchema' | 'outputExample' | 'outputSchema'>): BazaarDeclaration {
  const output = { type: 'object', required: ['type'], properties: { type: { const: 'json' }, example: s.outputSchema ?? { type: 'object' } } };
  if (s.method === 'POST') {
    return {
      info: {
        input: { type: 'http', method: 'POST', discoverable: true, bodyType: 'json', body: s.inputExample },
        output: { type: 'json', example: s.outputExample },
      },
      schema: {
        $schema: JSON_SCHEMA_2020, type: 'object', required: ['input'],
        properties: {
          input: {
            type: 'object', additionalProperties: false, required: ['type', 'method', 'bodyType', 'body'],
            properties: { type: { const: 'http' }, method: { const: 'POST' }, discoverable: { type: 'boolean' }, bodyType: { const: 'json' }, body: s.inputSchema },
          },
          output,
        },
      },
    };
  }
  return {
    info: { input: { type: 'http', method: 'GET', discoverable: true, queryParams: {} }, output: { type: 'json', example: s.outputExample } },
    schema: {
      $schema: JSON_SCHEMA_2020, type: 'object', required: ['input'],
      properties: {
        input: {
          type: 'object', additionalProperties: false, required: ['type', 'method'],
          properties: { type: { const: 'http' }, method: { const: 'GET' }, discoverable: { type: 'boolean' }, queryParams: { type: 'object', properties: {}, additionalProperties: false } },
        },
        output,
      },
    },
  };
}

export interface X402Asset {
  /** mint, base58 */
  mint: string;
  symbol?: string;
  decimals: number;
  /** the mint's token program, base58 */
  tokenProgram: string;
  /** ATA(payTo, mint): where the payment lands */
  payToTokenAccount: string;
}

export interface PaymentRequiredInput {
  service: X402Service;
  url: string;
  price: bigint;
  assets: X402Asset[];
  payTo: string;
  feePayer: string;
  network: string;
  maxTimeoutSeconds: number;
  serviceName: string;
  tags: string[];
  iconUrl?: string;
}

/** Our requirements for one service: one `exact` entry per accepted asset. The seller only ever sends these to the facilitator. */
export function paymentRequirements(i: Omit<PaymentRequiredInput, 'service' | 'url' | 'serviceName' | 'tags' | 'iconUrl'>): PaymentRequirements[] {
  return i.assets.map((a) => ({
    scheme: 'exact', network: i.network, amount: i.price.toString(), asset: a.mint, payTo: i.payTo, maxTimeoutSeconds: i.maxTimeoutSeconds,
    extra: { feePayer: i.feePayer },
  }));
}

/** The 402 challenge (PaymentRequired) of a service, with the Bazaar declaration. */
export function buildPaymentRequired(i: PaymentRequiredInput): PaymentRequired {
  return {
    x402Version: 2,
    error: 'PAYMENT-SIGNATURE header is required',
    resource: {
      url: i.url, description: i.service.description, mimeType: i.service.mimeType, serviceName: i.serviceName, tags: i.tags,
      ...(i.iconUrl ? { iconUrl: i.iconUrl } : {}),
    },
    accepts: paymentRequirements(i),
    extensions: { bazaar: bazaarDeclaration(i.service) },
  };
}

export interface CatalogInput {
  enabled: boolean;
  services: X402Service[];
  prices: Map<X402ServiceId, bigint>;
  assets: X402Asset[];
  payTo: string;
  network: string;
  resourceBase: string;
  feePayer?: string;
}

/** The free GET /v1/x402/catalog body. */
export function catalogView(i: CatalogInput) {
  return {
    x402Version: 2 as const,
    enabled: i.enabled,
    network: i.network,
    facilitator: 'cdp',
    payTo: i.payTo,
    ...(i.feePayer ? { feePayer: i.feePayer } : {}),
    assets: i.assets,
    services: i.services.map((s) => {
      const price = i.prices.get(s.id) ?? 0n;
      return {
        id: s.id, method: s.method, url: `${i.resourceBase}${s.path}`, description: s.description, flow: s.flow,
        price: { amount: price.toString(), decimals: 6 }, enabled: i.enabled && price > 0n,
        input: { example: s.inputExample, schema: s.inputSchema }, output: { example: s.outputExample },
      };
    }),
    ...(i.enabled ? {} : { note: 'x402_disabled' }),
  };
}
