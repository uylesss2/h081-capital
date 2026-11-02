// Test doubles for the x402 seller: a scripted facilitator, payment builders and stream_loan account fixtures.
import { randomBytes } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import type { Facilitator, Settled, Verified } from '../../../relayer/x402/facilitator.js';
import {
  type PaymentPayloadV2, type PaymentRequired, type PaymentRequirements, type SupportedResponse, SOLANA_MAINNET_NETWORK, encodeHeader,
} from '../../../relayer/x402/types.js';
import type { SlotAccount } from '../../../src/solana/lender.js';

export const FEE_PAYER = Keypair.generate().publicKey.toBase58();

export class MockFacilitator implements Facilitator {
  calls: Array<{ name: 'supported' | 'verify' | 'settle'; payload?: PaymentPayloadV2; requirements?: PaymentRequirements }> = [];
  supportedResult: SupportedResponse | Error = {
    kinds: [
      { x402Version: 1, scheme: 'exact', network: 'solana', extra: { feePayer: 'v1-fee-payer' } },
      { x402Version: 2, scheme: 'exact', network: SOLANA_MAINNET_NETWORK, extra: { feePayer: FEE_PAYER } },
      { x402Version: 2, scheme: 'exact', network: 'eip155:8453' },
    ],
    extensions: ['bazaar'], signers: { 'solana:*': [FEE_PAYER] },
  };
  verifyResult: Verified | Error = { isValid: true, payer: 'payer' };
  /** one result per settle call (the last one repeats) */
  settleResults: Array<Settled | Error> = [{ success: true, transaction: 'sig', network: SOLANA_MAINNET_NETWORK, payer: 'payer' }];
  private settleIndex = 0;

  private take<T>(r: T | Error): T {
    if (r instanceof Error) throw r;
    return r;
  }

  async supported(): Promise<SupportedResponse> {
    this.calls.push({ name: 'supported' });
    return this.take(this.supportedResult);
  }

  async verify(payload: PaymentPayloadV2, requirements: PaymentRequirements): Promise<Verified> {
    this.calls.push({ name: 'verify', payload, requirements });
    return this.take(this.verifyResult);
  }

  async settle(payload: PaymentPayloadV2, requirements: PaymentRequirements): Promise<Settled> {
    this.calls.push({ name: 'settle', payload, requirements });
    const r = this.settleResults[Math.min(this.settleIndex, this.settleResults.length - 1)];
    this.settleIndex++;
    return this.take(r);
  }

  count(name: 'supported' | 'verify' | 'settle'): number {
    return this.calls.filter((c) => c.name === name).length;
  }

  reset() {
    this.calls = [];
    this.settleIndex = 0;
  }
}

/** A syntactically valid PaymentPayload for one of the requirements (a random "transaction"). */
export function makePayment(required: PaymentRequired, over: Omit<Partial<PaymentPayloadV2>, 'accepted'> & { accepted?: Partial<PaymentRequirements> } = {}, index = 0): PaymentPayloadV2 {
  const base = required.accepts[index] as PaymentRequirements;
  return {
    x402Version: 2, resource: required.resource, ...over,
    accepted: { ...base, ...(over.accepted ?? {}) },
    payload: over.payload ?? { transaction: randomBytes(300).toString('base64') },
    extensions: over.extensions ?? required.extensions,
  };
}

export const paymentHeader = (p: unknown) => ({ 'payment-signature': encodeHeader(p) });

/** Encodes a stream_loan Slot account (discriminator + the layout decodeSlot reads). */
export function encodeSlot(s: Partial<SlotAccount> & { loanRef: bigint }): Buffer {
  const b = Buffer.alloc(253);
  let o = 0;
  const key = (k?: PublicKey) => { (k ?? PublicKey.default).toBuffer().copy(b, o); o += 32; };
  const u8 = (v: number) => { b.writeUInt8(v, o); o += 1; };
  const u16 = (v: number) => { b.writeUInt16LE(v, o); o += 2; };
  const u64 = (v: bigint) => { b.writeBigUInt64LE(v, o); o += 8; };
  const i64 = (v: bigint) => { b.writeBigInt64LE(v, o); o += 8; };
  const u128 = (v: bigint) => { b.writeBigUInt64LE(v & ((1n << 64n) - 1n), o); b.writeBigUInt64LE(v >> 64n, o + 8); o += 16; };
  const be32 = (v: bigint) => { Buffer.from(v.toString(16).padStart(64, '0'), 'hex').copy(b, o); o += 32; };
  randomBytes(8).copy(b, o); o += 8; // discriminator
  u64(s.loanRef); key(s.lender); u8(s.bump ?? 255); u8(s.funded ? 1 : 0); u8(s.settled ? 1 : 0); key(s.asset); key(s.tokenProgram);
  u64(s.principal ?? 0n); u64(s.repaid ?? 0n); u128(s.minRemaining ?? 0n); u128(s.minRate ?? 0n); u16(Number(s.pledgeBps ?? 0n)); u64(s.expiry ?? 0n);
  be32(s.agentPk ?? 0n); i64(s.fundedAt ?? 0n); key(s.payoutTo); u64(s.streamStart ?? 0n);
  if (o !== b.length) throw new Error(`slot encoder wrote ${o} of ${b.length} bytes`);
  return b;
}

/** Encodes a stream_loan Registry account. */
export function encodeRegistry(nextLoanRef: bigint): Buffer {
  const b = Buffer.alloc(17);
  b.writeBigUInt64LE(nextLoanRef, 8);
  return b;
}

/** A clock sysvar account whose unix_timestamp (offset 32) is `now`. */
export function clockAccount(now: bigint) {
  const data = Buffer.alloc(40);
  data.writeBigInt64LE(now, 32);
  return { data, owner: PublicKey.default, lamports: 1, executable: false };
}
