// Errors the relayer reports to clients: an HTTP status, a stable machine code and a message.
import { PayloadError } from '../src/solana/relay.js';

export class RelayError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** Codes that mean "the fee is not acceptable" (HTTP 402); every other payload refusal is a 400. */
export const FEE_CODES = new Set(['fee_required', 'fee_too_low', 'asset_not_accepted', 'wrong_fee_account', 'wrong_relayer']);

export function badRequest(code: string, message: string): RelayError {
  return new RelayError(FEE_CODES.has(code) ? 402 : 400, code, message);
}

/** Maps a thrown value to a RelayError (unknown errors become 500 internal). */
export function toRelayError(e: unknown): RelayError {
  if (e instanceof RelayError) return e;
  if (e instanceof PayloadError) return badRequest(e.code, e.message);
  return new RelayError(500, 'internal', e instanceof Error ? e.message : String(e));
}
