// Relayer payload validation for stipend_pool (in-process): decoding the staged payload of each operation,
// the extDataHash check, and the fee rules (who is paid, in which mint, how much, which operations).
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  DELEGATE_OUTPUTS, GRANT_OUTPUTS, PayloadError, SPEND_ARGS_BYTES, TRANSACT_ARGS_BYTES, checkFee, concatBytes, decodeRelayPayload, encodeDelegateArgs,
  encodeDelegateExt, encodeGrantArgs, encodeGrantExt, encodeSpendArgs, encodeSpendExt, encodeTransactArgs, encodeTransactExt, extDataHash, fromB64,
  nullifiersOf, toB64, type FeeTerms, type SpendArgs,
} from '../../src/solana/index.js';

const proof = new Uint8Array(256).fill(7);
const relayer = Keypair.generate().publicKey;
const usd = Keypair.generate().publicKey;
const other = Keypair.generate().publicKey;
const feeAta = getAssociatedTokenAddressSync(usd, relayer, true, TOKEN_PROGRAM_ID);
const terms = (o: Partial<FeeTerms> = {}): FeeTerms => ({
  relayer, minFees: new Map([[usd.toBase58(), 1_000n]]), feeAccount: (m) => getAssociatedTokenAddressSync(m, relayer, true, TOKEN_PROGRAM_ID), ...o,
});

function transactPayload(o: { extAmount?: bigint; fee?: bigint; relayer?: PublicKey; feeRecipient?: PublicKey; tamper?: boolean } = {}) {
  const ext = encodeTransactExt({
    recipient: Keypair.generate().publicKey, relayer: o.relayer ?? relayer, feeRecipient: o.feeRecipient ?? feeAta,
    extAmount: o.extAmount ?? -5_000n, fee: o.fee ?? 1_000n, encryptedOutputs: [new Uint8Array(120).fill(1), new Uint8Array(120).fill(2)],
  });
  const h = o.tamper ? 5n : extDataHash(ext);
  const args = encodeTransactArgs({ root: 11n, publicAmount: 0n, extDataHash: h, inputNullifiers: [21n, 22n], outputCommitments: [31n, 32n] });
  return concatBytes(proof, args, ext);
}

function spendPayload(o: Partial<SpendArgs> & { relayer?: PublicKey; feeRecipient?: PublicKey } = {}) {
  const ext = encodeSpendExt({
    relayer: o.relayer ?? relayer, feeRecipient: o.feeRecipient ?? feeAta, encryptedAllowance: new Uint8Array(300).fill(3),
    encryptedPayment: new Uint8Array(), encryptedLender: new Uint8Array(),
  });
  const args: SpendArgs = {
    root: 11n, nullifier: 41n, newAllowanceCommitment: 42n, payCommitment: 0n, publicAmount: 50_000n, publicRecipient: other, publicAsset: usd, fee: 2_000n,
    timestamp: 1_700_000_000n, receipt: 43n, lenderAmount: 0n, lenderAddr: 0n, loanRef: 0n, isLenderClaim: false, extDataHash: extDataHash(ext), ...o,
  };
  if (o.extDataHash === undefined) args.extDataHash = extDataHash(ext);
  return concatBytes(proof, encodeSpendArgs(args), ext);
}

function grantPayload() {
  const ext = encodeGrantExt({ encryptedAllowances: Array.from({ length: GRANT_OUTPUTS }, (_, i) => new Uint8Array(i < 3 ? 200 : 0)), encryptedChange: new Uint8Array(90) });
  const args = encodeGrantArgs({
    root: 11n, inputNullifiers: [51n, 52n], allowanceCommitments: Array.from({ length: GRANT_OUTPUTS }, (_, i) => BigInt(100 + i)), changeCommitment: 60n,
    totalCommitment: 61n, extDataHash: extDataHash(ext),
  });
  return concatBytes(proof, args, ext);
}

function delegatePayload() {
  const ext = encodeDelegateExt({ encryptedSubs: Array.from({ length: DELEGATE_OUTPUTS }, () => new Uint8Array(150)), encryptedResidual: new Uint8Array(150) });
  const args = encodeDelegateArgs({ root: 11n, nullifier: 71n, subCommitments: [1n, 2n, 3n, 4n], residualCommitment: 5n, timestamp: 1_700_000_000n, extDataHash: extDataHash(ext) });
  return concatBytes(proof, args, ext);
}

const code = (f: () => unknown) => {
  try { f(); } catch (e) { if (e instanceof PayloadError) return e.code; throw e; }
  return 'ok';
};

describe('decoding staged payloads', () => {
  it('reads a transact payload back field by field', () => {
    const d = decodeRelayPayload('transact', transactPayload());
    expect(d.op).toBe('transact');
    if (d.op !== 'transact') return;
    expect(d.root).toBe(11n);
    expect(d.nullifiers).toEqual([21n, 22n]);
    expect(d.commitments).toEqual([31n, 32n]);
    expect(d.extAmount).toBe(-5_000n);
    expect(d.fee).toBe(1_000n);
    expect(d.relayer.equals(relayer)).toBe(true);
    expect(d.feeRecipient.equals(feeAta)).toBe(true);
    expect(nullifiersOf(d)).toEqual([21n, 22n]);
  });

  it('reads a spend payload back, including the u128 and pubkey fields', () => {
    const d = decodeRelayPayload('spend', spendPayload({ lenderAmount: 9n, lenderAddr: 123n, loanRef: 4n }));
    if (d.op !== 'spend') throw new Error('not a spend');
    expect(SPEND_ARGS_BYTES).toBe(353);
    expect(d.nullifier).toBe(41n);
    expect(d.publicAmount).toBe(50_000n);
    expect(d.publicRecipient.equals(other)).toBe(true);
    expect(d.publicAsset.equals(usd)).toBe(true);
    expect(d.fee).toBe(2_000n);
    expect(d.timestamp).toBe(1_700_000_000n);
    expect([d.lenderAmount, d.lenderAddr, d.loanRef, d.isLenderClaim]).toEqual([9n, 123n, 4n, false]);
    expect(nullifiersOf(d)).toEqual([41n]);
  });

  it('reads grant and delegate payloads (nullifiers, timestamp)', () => {
    const g = decodeRelayPayload('grant', grantPayload());
    expect(nullifiersOf(g)).toEqual([51n, 52n]);
    const d = decodeRelayPayload('delegate', delegatePayload());
    if (d.op !== 'delegate') throw new Error('not a delegate');
    expect(d.nullifier).toBe(71n);
    expect(d.timestamp).toBe(1_700_000_000n);
  });

  it('refuses truncated, padded, mislabelled and hash-mismatched payloads', () => {
    const p = transactPayload();
    expect(code(() => decodeRelayPayload('transact', p.subarray(0, p.length - 1)))).toBe('payload_truncated');
    expect(code(() => decodeRelayPayload('transact', concatBytes(p, Uint8Array.of(0))))).toBe('payload_trailing');
    expect(code(() => decodeRelayPayload('transact', transactPayload({ tamper: true })))).toBe('ext_data_hash');
    // a spend payload read as a transact does not line up
    expect(code(() => decodeRelayPayload('transact', spendPayload()))).not.toBe('ok');
    expect(code(() => decodeRelayPayload('spend', p.subarray(0, 256 + TRANSACT_ARGS_BYTES)))).toBe('payload_truncated');
    // one flipped memo byte breaks the hash binding
    const q = Uint8Array.from(p);
    q[q.length - 1] ^= 1;
    expect(code(() => decodeRelayPayload('transact', q))).toBe('ext_data_hash');
  });

  it('round-trips base64 and refuses non-base64', () => {
    const p = spendPayload();
    expect(fromB64(toB64(p))).toEqual(p);
    expect(code(() => fromB64('not base64!'))).toBe('bad_payload');
  });
});

describe('fee rules', () => {
  it('accepts a withdrawal that pays at least the minimum to the relayer fee account', () => {
    const fc = checkFee(decodeRelayPayload('transact', transactPayload({ fee: 1_000n })), terms(), usd);
    expect(fc).toEqual({ paid: true, mint: usd, fee: 1_000n });
  });

  it('accepts a public spend paying the fee in its asset; the request mint, when given, must match', () => {
    expect(checkFee(decodeRelayPayload('spend', spendPayload()), terms()).fee).toBe(2_000n);
    expect(code(() => checkFee(decodeRelayPayload('spend', spendPayload()), terms(), other))).toBe('mint_mismatch');
  });

  it('refuses a fee below the minimum, in an unlisted mint, to another relayer or another account', () => {
    expect(code(() => checkFee(decodeRelayPayload('transact', transactPayload({ fee: 999n })), terms(), usd))).toBe('fee_too_low');
    expect(code(() => checkFee(decodeRelayPayload('transact', transactPayload()), terms(), other))).toBe('asset_not_accepted');
    expect(code(() => checkFee(decodeRelayPayload('transact', transactPayload({ relayer: other })), terms(), usd))).toBe('wrong_relayer');
    expect(code(() => checkFee(decodeRelayPayload('transact', transactPayload({ feeRecipient: other })), terms(), usd))).toBe('wrong_fee_account');
    expect(code(() => checkFee(decodeRelayPayload('spend', spendPayload({ fee: 10n })), terms()))).toBe('fee_too_low');
    expect(code(() => checkFee(decodeRelayPayload('spend', spendPayload({ feeRecipient: other })), terms()))).toBe('wrong_fee_account');
    expect(code(() => checkFee(decodeRelayPayload('transact', transactPayload()), terms()))).toBe('mint_required');
  });

  it('never relays a deposit or a lender claim', () => {
    expect(code(() => checkFee(decodeRelayPayload('transact', transactPayload({ extAmount: 10_000n })), terms({ allowUnpaid: true }), usd))).toBe('deposit_not_relayable');
    expect(code(() => checkFee(decodeRelayPayload('spend', spendPayload({ isLenderClaim: true })), terms({ allowUnpaid: true })))).toBe('claim_not_relayable');
  });

  it('unpaid operations (grant, delegate, shielded transfer, shielded payout) only when allowed', () => {
    const unpaid = [
      decodeRelayPayload('grant', grantPayload()),
      decodeRelayPayload('delegate', delegatePayload()),
      decodeRelayPayload('transact', transactPayload({ extAmount: 0n, fee: 0n })),
      decodeRelayPayload('spend', spendPayload({ publicAmount: 0n, fee: 0n, publicRecipient: PublicKey.default })),
    ];
    for (const d of unpaid) {
      expect(code(() => checkFee(d, terms()))).toBe('fee_required');
      expect(checkFee(d, terms({ allowUnpaid: true }))).toEqual({ paid: false, fee: 0n });
    }
  });
});
