// x402 v2 shapes the seller side of the relayer uses (we are the seller; an agent pays per call). The generic
// shapes come from src/x402.ts (the SDK's client/vendor module for the custom `stipend-shielded` scheme); the
// Solana `exact` scheme and the facilitator (CDP) shapes are added here. Spec: https://docs.x402.org.
export {
  X402_HEADERS, decodeHeader, encodeHeader, type PaymentRequired, type PaymentRequirements, type SettlementResponse, type VerifyResponse,
  type X402ResourceInfo,
} from '../../src/x402.js';

/** CAIP-2 identifier of Solana mainnet: `solana:` + the first 32 characters of the genesis hash. */
export const SOLANA_MAINNET_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

/** The CAIP-2 network id of a Solana cluster from its genesis hash (as `getGenesisHash` returns it). */
export const caip2OfGenesis = (genesisHash: string): string => `solana:${genesisHash.slice(0, 32)}`;

/** `payload` of the `exact` scheme on Solana: a partially signed v0 transaction (base64) the facilitator co-signs and sends. */
export interface ExactSvmPayload { transaction: string }

/** The PAYMENT-SIGNATURE header, decoded (x402 v2 only; v1 `X-PAYMENT` is not served). */
export interface PaymentPayloadV2 {
  x402Version: 2;
  resource?: import('../../src/x402.js').X402ResourceInfo;
  /** the requirement the client chose from `accepts` (never trusted for amount or payTo: the seller rebuilds its own) */
  accepted: import('../../src/x402.js').PaymentRequirements;
  payload: ExactSvmPayload;
  extensions?: Record<string, unknown>;
}

/** GET /supported of a facilitator. */
export interface SupportedResponse {
  kinds: Array<{ x402Version: number; scheme: string; network: string; extra?: { feePayer?: string; [k: string]: unknown } }>;
  extensions?: string[];
  signers?: Record<string, string[]>;
}

export type SettleResponse = import('../../src/x402.js').SettlementResponse;

/** Facilitator (CDP) header carrying per-extension outcomes, base64 JSON keyed by extension name (`bazaar`). */
export const EXTENSION_RESPONSES_HEADER = 'EXTENSION-RESPONSES';

/** What the facilitator reports for the bazaar extension on verify/settle. */
export interface BazaarExtensionResponse { status: 'success' | 'processing' | 'rejected'; rejectedReason?: string; [k: string]: unknown }

/** The `extensions.bazaar` declaration of a resource (CDP x402 Bazaar discovery). */
export interface BazaarDeclaration {
  info: { input: Record<string, unknown>; output?: Record<string, unknown> };
  schema: Record<string, unknown>;
}

/** `invalidReason` values a facilitator may return on /verify (the spec's list; the facilitator may add its own). */
export type InvalidReason =
  | 'insufficient_funds' | 'invalid_exact_evm_payload_authorization_valid_after' | 'invalid_exact_evm_payload_authorization_valid_before'
  | 'invalid_exact_evm_payload_authorization_value' | 'invalid_exact_evm_payload_signature' | 'invalid_exact_evm_payload_recipient_mismatch'
  | 'invalid_exact_svm_payload_transaction' | 'invalid_network' | 'invalid_payload' | 'invalid_payment_requirements' | 'invalid_scheme'
  | 'invalid_transaction_state' | 'invalid_x402_version' | 'unsupported_scheme' | 'settlement_pending' | (string & {});

/** `errorReason` values on /settle; `settlement_pending` means the transaction was sent and not yet confirmed. */
export type ErrorReason = InvalidReason;
