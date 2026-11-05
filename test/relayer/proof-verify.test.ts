// The relayer verifies every Groth16 proof off-chain, against the program's public inputs and verifying keys,
// before it stages (and pays for) anything. Fixtures: real withdrawal and spend payloads proven once with the
// ceremony build (fixtures/make-relay-fixtures.mts) and the matching verifying keys (fixtures/circuits/).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { toRelayError } from '../../relayer/errors.js';
import { type RelayIo, SolanaRelayer } from '../../relayer/solana.js';
import { NPUBLIC, ProofVerifier, RELAY_CIRCUITS, decodeProofBytes, payloadConsistency, publicInputsOf, vkeyPinEnv } from '../../relayer/verify.js';
import type { SolidityProof } from '../../src/prover.js';
import { FIELD_Q, encodeProof, fromBe } from '../../src/solana/field.js';
import { vaultPda } from '../../src/solana/pda.js';
import { type DecodedSpend, type DecodedTransact, PROOF_BYTES, type SolanaOp, decodeRelayPayload, fromB64, toB64 } from '../../src/solana/relay.js';
import { stubCluster } from './helpers/cluster.js';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');
const circuitsDir = resolve(fixturesDir, 'circuits');
interface Fixture {
  payerSecretKey: string; treasury: string; mint: string; recipientOwner: string; amount: string; fee: string;
  transact: { root: string; nullifiers: string[]; payload: string; publicSignals: string[] };
  spend: { root: string; nullifier: string; timestamp: string; payload: string; publicSignals: string[] };
}
const fx: Fixture = JSON.parse(readFileSync(resolve(fixturesDir, 'relay-payloads.json'), 'utf8'));
const payer = Keypair.fromSecretKey(Buffer.from(fx.payerSecretKey, 'base64'));
const treasury = new PublicKey(fx.treasury);
const mint = new PublicKey(fx.mint);
const recipientOwner = new PublicKey(fx.recipientOwner);
const programId = Keypair.generate().publicKey;
const transact = fromB64(fx.transact.payload);
const spend = fromB64(fx.spend.payload);
const withProof = (payload: Uint8Array, proof: Uint8Array) => { const p = Uint8Array.from(payload); p.set(proof.subarray(0, PROOF_BYTES), 0); return p; };
const flipped = (payload: Uint8Array, at = 40) => { const p = Uint8Array.from(payload); p[at] ^= 1; return p; };

describe('proof bytes and public inputs', () => {
  it('decodes the 256-byte on-chain proof encoding back into snarkjs form (a un-negated, b in c0,c1 order)', () => {
    const rnd = () => fromBe(randomBytes(32)) % FIELD_Q;
    const raw = { pi_a: [rnd(), rnd()], pi_b: [[rnd(), rnd()], [rnd(), rnd()]], pi_c: [rnd(), rnd()] };
    // as Prover.prove formats a snarkjs proof for the Solidity verifier (swapped G2 coordinates)
    const sol: SolidityProof = {
      a: [raw.pi_a[0], raw.pi_a[1]], b: [[raw.pi_b[0][1], raw.pi_b[0][0]], [raw.pi_b[1][1], raw.pi_b[1][0]]], c: [raw.pi_c[0], raw.pi_c[1]],
    };
    const back = decodeProofBytes(encodeProof(sol));
    const s = (x: bigint) => x.toString();
    expect(back).toEqual({
      pi_a: [s(raw.pi_a[0]), s(raw.pi_a[1]), '1'], pi_b: [[s(raw.pi_b[0][0]), s(raw.pi_b[0][1])], [s(raw.pi_b[1][0]), s(raw.pi_b[1][1])], ['1', '0']],
      pi_c: [s(raw.pi_c[0]), s(raw.pi_c[1]), '1'], protocol: 'groth16', curve: 'bn128',
    });
    expect(() => decodeProofBytes(new Uint8Array(255))).toThrow(/256/);
    expect(() => decodeProofBytes(new Uint8Array(256).fill(0xff))).toThrow(/base-field/);
  });

  it('derives the public inputs in the program\'s order: the fixtures\' circuit signals, from the payload alone', () => {
    const t = decodeRelayPayload('transact', transact) as DecodedTransact;
    expect(publicInputsOf(t, mint).map(String)).toEqual(fx.transact.publicSignals);
    expect(publicInputsOf(t, mint)).toHaveLength(NPUBLIC.transact);
    const s = decodeRelayPayload('spend', spend) as DecodedSpend;
    expect(publicInputsOf(s).map(String)).toEqual(fx.spend.publicSignals);
    expect(publicInputsOf(s)).toHaveLength(NPUBLIC.spend);
    // a transact that moves tokens cannot be verified without its mint
    expect(() => publicInputsOf(t)).toThrow(/mint/);
    expect(payloadConsistency(t)).toBeUndefined();
    expect(payloadConsistency({ ...t, publicAmount: 5n })).toMatch(/publicAmount/);
  });
});

describe('ProofVerifier', () => {
  it('loads and pins the four relay circuits\' verifying keys', () => {
    const v = new ProofVerifier({ circuitsDir });
    for (const name of RELAY_CIRCUITS) expect(v.vkeySha256[name]).toMatch(/^[0-9a-f]{64}$/);
    expect(() => new ProofVerifier({ circuitsDir, vkeySha256: { spend: v.vkeySha256.spend, transact: 'f'.repeat(64) } })).toThrow(new RegExp(vkeyPinEnv('transact')));
    expect(new ProofVerifier({ circuitsDir, vkeySha256: { ...v.vkeySha256 } }).vkeySha256).toEqual(v.vkeySha256);
    expect(() => new ProofVerifier({ circuitsDir: resolve(fixturesDir, 'nowhere') })).toThrow(/verifying key missing/);
  });

  it('accepts the real withdrawal and spend proofs and refuses random, altered or misattributed ones', async () => {
    const v = new ProofVerifier({ circuitsDir });
    const t = decodeRelayPayload('transact', transact) as DecodedTransact;
    const s = decodeRelayPayload('spend', spend) as DecodedSpend;
    expect(await v.verify(transact, t, mint)).toBe(true);
    expect(await v.verify(spend, s)).toBe(true);
    // random proof bytes, the test suites' placeholder proof, one flipped proof byte, one flipped public input
    expect(await v.verify(withProof(transact, randomBytes(256)), t, mint)).toBe(false);
    expect(await v.verify(withProof(transact, new Uint8Array(256).fill(7)), t, mint)).toBe(false);
    expect(await v.verify(flipped(transact), t, mint)).toBe(false);
    expect(await v.verify(transact, { ...t, root: t.root ^ 1n }, mint)).toBe(false);
    // the proof binds the mint (publicAsset = fieldOf(mint)) and the recipient
    expect(await v.verify(transact, t, Keypair.generate().publicKey)).toBe(false);
    expect(await v.verify(spend, { ...s, publicRecipient: Keypair.generate().publicKey })).toBe(false);
    expect(await v.verify(spend, { ...s, fee: s.fee + 1n })).toBe(false);
  }, 60_000);
});

describe('SolanaRelayer: nothing is staged for a proof that does not verify', () => {
  const treasuryAta = getAssociatedTokenAddressSync(mint, treasury, true, TOKEN_PROGRAM_ID);
  const recipientAta = getAssociatedTokenAddressSync(mint, recipientOwner, true, TOKEN_PROGRAM_ID);
  const verifier = new ProofVerifier({ circuitsDir });
  const body = (op: SolanaOp, payload: Uint8Array) => ({ op, payload: toB64(payload), ...(op === 'transact' ? { mint: fx.mint, recipientOwner: fx.recipientOwner } : {}) });
  /** a transport that records what the hot wallet would have paid for */
  function spyIo() {
    const calls: string[] = [];
    const io: RelayIo = {
      stagePlan: async () => { calls.push('stage'); return []; },
      simulateV0: async () => { calls.push('simulate'); return { err: null, logs: [], computeUnits: 1 }; },
      sendV0: async () => { calls.push('send'); return { signature: 'sig', computeUnits: 7, logs: [] }; },
      abandonPlan: async () => { calls.push('abandon'); return { closed: true, attempts: 1 }; },
    };
    return { io, calls };
  }
  /** `v: null` builds a relayer without a verifier */
  const relayer = (io: RelayIo, v: ProofVerifier | null = verifier) => new SolanaRelayer({
    connection: stubCluster({ programId, mints: [mint], roots: [BigInt(fx.transact.root), BigInt(fx.spend.root)], now: BigInt(fx.spend.timestamp) + 10n, existing: [recipientAta, vaultPda(programId, mint)] }),
    payer, treasury, programId, minFees: new Map([[fx.mint, 1_000n]]), verifier: v ?? undefined, io,
  }).init();

  it('relays the real withdrawal and spend (fee account = treasury ATA, fee 20 bps)', async () => {
    const { io, calls } = spyIo();
    const r = await relayer(io);
    expect(r.feeAccount(mint).equals(treasuryAta)).toBe(true);
    expect(await r.relay(body('transact', transact))).toMatchObject({ signature: 'sig', op: 'transact', fee: fx.fee });
    expect(await r.relay(body('spend', spend))).toMatchObject({ signature: 'sig', op: 'spend', fee: fx.fee });
    expect(calls).toEqual(['stage', 'simulate', 'send', 'stage', 'simulate', 'send']);
    expect((await r.inspect(body('spend', spend))).proof).toEqual({ verified: true });
  });

  it('refuses random or placeholder proof bytes with 400 invalid_proof before any transaction', async () => {
    const { io, calls } = spyIo();
    const r = await relayer(io);
    for (const p of [withProof(transact, randomBytes(256)), withProof(transact, new Uint8Array(256).fill(7)), flipped(transact)]) {
      const err = await r.relay(body('transact', p)).catch((e) => toRelayError(e));
      expect(err).toMatchObject({ status: 400, code: 'invalid_proof' });
    }
    const err = await r.relay(body('spend', withProof(spend, randomBytes(256)))).catch((e) => toRelayError(e));
    expect(err).toMatchObject({ status: 400, code: 'invalid_proof' });
    expect(calls).toEqual([]);
    // the preflight reports the same
    const insp = await r.inspect(body('transact', flipped(transact)));
    expect(insp.proof).toEqual({ verified: false });
    expect(insp.refusals.map((x) => x.code)).toEqual(['invalid_proof']);
    expect(calls).toEqual([]);
  }, 60_000);

  it('a relayer without verifying keys relays nothing (503 proof_verifier_unavailable)', async () => {
    const { io, calls } = spyIo();
    const r = await relayer(io, null);
    await expect(r.relay(body('transact', transact))).rejects.toMatchObject({ status: 503, code: 'proof_verifier_unavailable' });
    expect(calls).toEqual([]);
    expect((await r.inspect(body('transact', transact))).refusals.map((x) => x.code)).toEqual(['proof_verifier_unavailable']);
  });
});
