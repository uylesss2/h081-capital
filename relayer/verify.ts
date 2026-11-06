// Off-chain Groth16 verification of a relay payload's proof, before the relayer pays for anything. The
// relayer re-derives the public inputs exactly as the program does (solana/programs/stipend_pool/src/ops.rs:
// transact, grant, spend, delegate; pubkeys mapped with fieldOf, integers as field elements) and verifies the
// 256-byte proof with snarkjs against the same verifying keys the program embeds (build/circuits/<name>/
// <name>.vkey.json, generated into vk.rs by scripts/gen-solana-vk.mjs). A proof that does not verify here
// would not verify on chain either; refusing it costs the relayer nothing instead of the staging transactions.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import * as snarkjs from 'snarkjs';
import { FIELD_Q, FIELD_R, fieldOf, fromBe } from '../src/solana/field.js';
import { type DecodedOp, PROOF_BYTES } from '../src/solana/relay.js';

/** The circuits whose proofs the relayer relays (verify_disclosure / verify_stream are not relay operations). */
export const RELAY_CIRCUITS = ['transact', 'grant', 'spend', 'delegate'] as const;
export type RelayCircuit = (typeof RELAY_CIRCUITS)[number];

/** Public-input counts, as scripts/gen-solana-vk.mjs asserts them for the program. */
export const NPUBLIC: Record<RelayCircuit, number> = { transact: 8, grant: 22, spend: 15, delegate: 9 };

/** Environment variable that pins a circuit's verifying key: RELAYER_VKEY_SHA256_<NAME>. */
export const vkeyPinEnv = (name: RelayCircuit) => `RELAYER_VKEY_SHA256_${name.toUpperCase()}`;

/** The verifying-key file of a circuit in a build/circuits-style directory (Prover.paths layout). */
export const vkeyPath = (circuitsDir: string, name: RelayCircuit) => join(circuitsDir, name, `${name}.vkey.json`);

/** snarkjs's proof object (affine G1 points with z = 1, G2 as [[c0, c1], ...] with z = [1, 0]). */
export interface SnarkjsProof {
  pi_a: [string, string, string];
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
  protocol: 'groth16';
  curve: 'bn128';
}

/**
 * The payload's 256 proof bytes back into snarkjs form, undoing encodeProof (src/solana/field.ts): a travels
 * negated (x, q - y) for the on-chain pairing, b in EIP-197 (c1, c0) order. Throws when a coordinate is not a
 * base-field element (the pairing syscall would refuse it too).
 */
export function decodeProofBytes(bytes: Uint8Array): SnarkjsProof {
  if (bytes.length !== PROOF_BYTES) throw new Error(`proof must be ${PROOF_BYTES} bytes`);
  const at = (i: number) => {
    const x = fromBe(bytes.subarray(32 * i, 32 * (i + 1)));
    if (x >= FIELD_Q) throw new Error(`proof coordinate ${i} is not a base-field element`);
    return x;
  };
  const ax = at(0), negY = at(1);
  const ay = negY === 0n ? 0n : FIELD_Q - negY;
  // b: bytes [b00 = x.c1, b01 = x.c0, b10 = y.c1, b11 = y.c0]; snarkjs pi_b = [[x.c0, x.c1], [y.c0, y.c1], [1, 0]]
  const b00 = at(2), b01 = at(3), b10 = at(4), b11 = at(5);
  const cx = at(6), cy = at(7);
  const s = (x: bigint) => x.toString();
  return {
    pi_a: [s(ax), s(ay), '1'],
    pi_b: [[s(b01), s(b00)], [s(b11), s(b10)], ['1', '0']],
    pi_c: [s(cx), s(cy), '1'],
    protocol: 'groth16', curve: 'bn128',
  };
}

const modR = (x: bigint) => ((x % FIELD_R) + FIELD_R) % FIELD_R;
/** fieldOf, with the all-zero pubkey standing for "no address" (0), as the program's field_of_opt. */
const fieldOfOpt = (k: PublicKey) => (k.equals(PublicKey.default) ? 0n : fieldOf(k));

/**
 * The public inputs of a decoded operation in the program's order (ops.rs require_proof calls). For a
 * transact that moves tokens the mint is the request's `mint` (the program takes it from the mint account);
 * one that moves nothing has publicAsset 0.
 */
export function publicInputsOf(d: DecodedOp, mint?: PublicKey): bigint[] {
  if (d.op === 'transact') {
    const moves = d.extAmount !== 0n || d.fee !== 0n;
    if (moves && !mint) throw new Error('a transact that moves tokens needs the mint for its public inputs');
    const publicAsset = moves ? fieldOf(mint!) : 0n;
    return [d.root, d.publicAmount, publicAsset, d.extDataHash, d.nullifiers[0], d.nullifiers[1], d.commitments[0], d.commitments[1]];
  }
  if (d.op === 'grant') return [d.root, d.nullifiers[0], d.nullifiers[1], ...d.allowanceCommitments, d.changeCommitment, d.totalCommitment, d.extDataHash];
  if (d.op === 'spend') {
    return [
      d.root, d.nullifier, d.newAllowanceCommitment, d.payCommitment, d.publicAmount, fieldOfOpt(d.publicRecipient), fieldOfOpt(d.publicAsset), d.fee,
      d.timestamp, d.receipt, d.lenderAmount, d.lenderAddr, d.loanRef, d.isLenderClaim ? 1n : 0n, d.extDataHash,
    ];
  }
  return [d.root, d.nullifier, ...d.subCommitments, d.residualCommitment, d.timestamp, d.extDataHash];
}

/**
 * The cheap consistency the program checks before the pairing, so a payload that would fail there is refused
 * here: a transact's publicAmount must be extAmount - fee mod r (ops.rs field::public_amount).
 */
export function payloadConsistency(d: DecodedOp): string | undefined {
  if (d.op === 'transact' && d.publicAmount !== modR(d.extAmount - d.fee)) return 'publicAmount is not extAmount - fee (mod r)';
  return undefined;
}

/** What SolanaRelayer needs from a verifier; ProofVerifier is the real one, tests may stub it. */
export interface RelayProofVerifier {
  /** true when the proof in `payload` verifies for the decoded operation's public inputs */
  verify(payload: Uint8Array, decoded: DecodedOp, mint?: PublicKey): Promise<boolean>;
}

export interface ProofVerifierOptions {
  /** build/circuits-style directory holding <name>/<name>.vkey.json for every RELAY_CIRCUITS entry */
  circuitsDir: string;
  /** pinned sha256 (hex) per circuit; a key that does not match refuses to start */
  vkeySha256?: Partial<Record<RelayCircuit, string>>;
}

/** Loads and pins the four relay circuits' verifying keys; verifies payload proofs with snarkjs. */
export class ProofVerifier implements RelayProofVerifier {
  readonly vkeySha256: Record<RelayCircuit, string>;
  private readonly vkeys: Record<RelayCircuit, unknown>;

  constructor(readonly opts: ProofVerifierOptions) {
    const sha = {} as Record<RelayCircuit, string>;
    const vkeys = {} as Record<RelayCircuit, unknown>;
    for (const name of RELAY_CIRCUITS) {
      const path = vkeyPath(opts.circuitsDir, name);
      if (!existsSync(path)) throw new Error(`verifying key missing: ${path} (the relayer verifies every proof before staging it)`);
      const bytes = readFileSync(path);
      let vk: { protocol?: string; curve?: string; nPublic?: number; IC?: unknown[] };
      try { vk = JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`${path} is not JSON`); }
      if (vk.protocol !== 'groth16' || vk.curve !== 'bn128') throw new Error(`${path}: not a bn128 groth16 verifying key`);
      if (vk.nPublic !== NPUBLIC[name] || !Array.isArray(vk.IC) || vk.IC.length !== NPUBLIC[name] + 1) {
        throw new Error(`${path}: expected ${NPUBLIC[name]} public inputs, got ${vk.nPublic}`);
      }
      sha[name] = createHash('sha256').update(bytes).digest('hex');
      const pin = opts.vkeySha256?.[name]?.toLowerCase();
      if (pin && pin !== sha[name]) throw new Error(`${name}.vkey.json sha256 ${sha[name]} does not match ${vkeyPinEnv(name)} ${pin}`);
      vkeys[name] = vk;
    }
    this.vkeySha256 = sha;
    this.vkeys = vkeys;
  }

  async verify(payload: Uint8Array, decoded: DecodedOp, mint?: PublicKey): Promise<boolean> {
    if (payloadConsistency(decoded)) return false;
    let proof: SnarkjsProof;
    let inputs: bigint[];
    try {
      proof = decodeProofBytes(payload.subarray(0, PROOF_BYTES));
      inputs = publicInputsOf(decoded, mint);
    } catch {
      return false;
    }
    if (inputs.some((x) => x < 0n || x >= FIELD_R)) return false;
    try {
      return await snarkjs.groth16.verify(this.vkeys[decoded.op], inputs.map((x) => x.toString()), proof);
    } catch {
      return false;
    }
  }
}
