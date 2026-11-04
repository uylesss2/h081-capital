// Disclosure proving as a service (x402 `prove-disclose`): an agent without a prover sends its allowance,
// its Merkle path and the bound it wants to show, and gets a Groth16 proof of the `disclose` circuit back,
// ready for stipend_pool's verify_disclosure. The inputs hold the allowance's figures and policy, never a
// spending key (disclose proofs need none; spend proofs would, and are not offered), so the prover learns
// what the note holds but cannot spend it. Cheap checks (field range, path, known root) run before any
// proving and before the payment is settled.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Connection } from '@solana/web3.js';
import { type Allowance, FIELD, type Policy, allowanceCommitment, poseidon } from '../../src/crypto.js';
import { type DisclosureKind, LEVELS, discloseInput } from '../../src/inputs.js';
import { type ProofResult, Prover } from '../../src/prover.js';
import { concatBytes, encodeProof } from '../../src/solana/field.js';
import { encodeDiscloseArgs } from '../../src/solana/program.js';
import { RelayError } from '../errors.js';
import { Mutex } from '../ratelimit.js';

export const DISCLOSURE_KINDS: readonly DisclosureKind[] = ['remainingAtLeast', 'spentAtMost', 'windowSpentAtMost'];

const POLICY_FIELDS: Array<keyof Policy> = ['lifetimeCap', 'windowCap', 'windowLen', 'maxPerTx', 'expiry', 'recipientRoot', 'ownerPk', 'streamRate', 'streamStart', 'lender', 'pledgeBps'];
const ALLOWANCE_FIELDS = ['asset', 'remaining', 'agentPk', 'windowId', 'windowSpent', 'rho', 'pledgePaid'] as const;

const bad = (message: string) => new RelayError(400, 'bad_input', message);

/** A field element from a decimal or 0x string (or a safe integer); rejects anything outside the BN254 scalar field. */
export function fieldFrom(v: unknown, what: string): bigint {
  let x: bigint;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) throw bad(`${what} must be a non-negative integer`);
    x = BigInt(v);
  } else if (typeof v === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(v)) {
    x = BigInt(v);
  } else {
    throw bad(`${what} must be a decimal or 0x string`);
  }
  if (x >= FIELD) throw bad(`${what} is not in the field`);
  return x;
}

export interface DiscloseRequest {
  root: bigint;
  kind: DisclosureKind;
  bound: bigint;
  audience: bigint;
  windowId?: bigint;
  allowance: Allowance;
  path: { pathIndices: number[]; pathElements: bigint[] };
}

/** Validates the service body; every number is a field element, the path has LEVELS entries. */
export function parseDiscloseRequest(body: unknown): DiscloseRequest {
  if (!body || typeof body !== 'object') throw bad('body must be a JSON object');
  const b = body as Record<string, unknown>;
  if (!DISCLOSURE_KINDS.includes(b.kind as DisclosureKind)) throw bad(`kind must be one of ${DISCLOSURE_KINDS.join(', ')}`);
  const kind = b.kind as DisclosureKind;
  const a = b.allowance as Record<string, unknown> | undefined;
  if (!a || typeof a !== 'object') throw bad('allowance must be an object');
  const p = a.policy as Record<string, unknown> | undefined;
  if (!p || typeof p !== 'object') throw bad('allowance.policy must be an object');
  const policy = Object.fromEntries(POLICY_FIELDS.map((k) => [k, fieldFrom(p[k], `allowance.policy.${k}`)])) as unknown as Policy;
  const fields = Object.fromEntries(ALLOWANCE_FIELDS.map((k) => [k, fieldFrom(a[k], `allowance.${k}`)])) as Record<(typeof ALLOWANCE_FIELDS)[number], bigint>;
  const allowance: Allowance = { ...fields, policy };
  const path = b.path as Record<string, unknown> | undefined;
  if (!path || typeof path !== 'object' || !Array.isArray(path.pathIndices) || !Array.isArray(path.pathElements)) throw bad('path must hold pathIndices[] and pathElements[]');
  if (path.pathIndices.length !== LEVELS || path.pathElements.length !== LEVELS) throw bad(`path must have ${LEVELS} levels`);
  const pathIndices = path.pathIndices.map((i, n) => {
    if (i !== 0 && i !== 1) throw bad(`path.pathIndices[${n}] must be 0 or 1`);
    return i as number;
  });
  const pathElements = path.pathElements.map((e, n) => fieldFrom(e, `path.pathElements[${n}]`));
  return {
    root: fieldFrom(b.root, 'root'), kind, bound: fieldFrom(b.bound, 'bound'), audience: fieldFrom(b.audience, 'audience'),
    windowId: b.windowId === undefined ? undefined : fieldFrom(b.windowId, 'windowId'), allowance, path: { pathIndices, pathElements },
  };
}

/** The root a path leads to from `leaf` (the circuit's MerkleProof, src/merkle.ts path order). */
export function rootOfPath(leaf: bigint, path: DiscloseRequest['path']): bigint {
  let h = leaf;
  for (let i = 0; i < path.pathIndices.length; i++) {
    const s = path.pathElements[i];
    h = path.pathIndices[i] === 0 ? poseidon([h, s]) : poseidon([s, h]);
  }
  return h;
}

/**
 * Everything checked before proving (and before the payment is settled): the body parses, every value is a
 * field element, the path leads from the allowance commitment to `root`, and the pool knows `root`.
 * Throws 400 bad_input / bad_path, 409 unknown_root, 503 pool_unreadable.
 */
export async function checkDiscloseRequest(body: unknown, knownRoots: () => Promise<bigint[]>): Promise<DiscloseRequest> {
  const r = parseDiscloseRequest(body);
  if (rootOfPath(allowanceCommitment(r.allowance), r.path) !== r.root) throw new RelayError(400, 'bad_path', 'the Merkle path does not lead from this allowance to root');
  if (r.kind === 'windowSpentAtMost' && r.windowId !== undefined && r.windowId !== r.allowance.windowId) {
    throw bad('windowId must equal the allowance\'s current window');
  }
  let roots: bigint[];
  try {
    roots = await knownRoots();
  } catch (e) {
    throw new RelayError(503, 'pool_unreadable', `pool state not readable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!roots.includes(r.root)) throw new RelayError(409, 'unknown_root', 'the pool does not know this root; sync and ask again');
  return r;
}

export interface DiscloseResult {
  proof: unknown;
  publicSignals: string[];
  args: { root: string; kind: string; bound: string; windowId: string; agentPk: string; audience: string };
  /** base64 borsh (Proof, DiscloseArgs): the buffer contents for stipend_pool verify_disclosure */
  payload: string;
  policyHash: string;
}

export interface DiscloseProverOptions {
  /** build/circuits-style directory holding disclose/ (Prover.paths layout) */
  circuitsDir: string;
  /** pinned sha256 of disclose.vkey.json; when set, startup refuses other artifacts */
  vkeySha256?: string;
  /** the pool's known roots (decodePool(pool).roots); injectable for tests */
  knownRoots: () => Promise<bigint[]>;
}

/** The artifact paths the service needs (Prover.paths layout plus the witness calculator). */
export function discloseArtifacts(circuitsDir: string) {
  const p = new Prover(circuitsDir).paths('disclose');
  return { ...p, witnessCalculator: p.wasm.replace(/disclose\.wasm$/, 'witness_calculator.js') };
}

export class DiscloseProver {
  private readonly prover: Prover;
  private readonly mutex = new Mutex();
  readonly vkeySha256: string;

  constructor(readonly opts: DiscloseProverOptions) {
    const a = discloseArtifacts(opts.circuitsDir);
    for (const f of [a.zkey, a.wasm, a.vkey, a.witnessCalculator]) if (!existsSync(f)) throw new Error(`disclose circuit artifact missing: ${f}`);
    this.vkeySha256 = createHash('sha256').update(readFileSync(a.vkey)).digest('hex');
    if (opts.vkeySha256 && opts.vkeySha256.toLowerCase() !== this.vkeySha256) {
      throw new Error(`disclose.vkey.json sha256 ${this.vkeySha256} does not match RELAYER_X402_DISCLOSE_VKEY_SHA256`);
    }
    this.prover = new Prover(opts.circuitsDir);
  }

  /** The cheap checks: input shape and ranges, the path reaches the root, the pool knows the root. Throws 400/409. */
  check(body: unknown): Promise<DiscloseRequest> {
    return checkDiscloseRequest(body, this.opts.knownRoots);
  }

  /** Proves one checked request (one proof at a time per instance). */
  async prove(r: DiscloseRequest): Promise<DiscloseResult> {
    const built = discloseInput({ root: r.root, allowance: r.allowance, path: { ...r.path, root: r.root, index: -1 }, kind: r.kind, bound: r.bound, windowId: r.windowId, audience: r.audience });
    let result: ProofResult;
    try {
      result = await this.mutex.run(() => this.prover.prove('disclose', built.input));
    } catch (e) {
      // the circuit refused the statement (the bound does not hold): the inputs were well formed, so this is the caller's claim failing
      throw new RelayError(422, 'statement_false', `the disclose circuit rejected the statement: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    }
    const [root, kind, bound, windowId, agentPk, audience] = built.publicSignals;
    const args = { root, kind, bound, windowId, agentPk, audience };
    const payload = Buffer.from(concatBytes(encodeProof(result.proof), encodeDiscloseArgs(args))).toString('base64');
    return {
      proof: result.raw.proof, publicSignals: result.raw.publicSignals,
      args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, v.toString()])) as DiscloseResult['args'],
      payload, policyHash: built.policyHash.toString(),
    };
  }
}

/** Reads the pool's known roots through a Connection (relayer/app.ts wires this). */
export function poolRootsReader(connection: Connection, poolAccount: import('@solana/web3.js').PublicKey): () => Promise<bigint[]> {
  return async () => {
    const { decodePool } = await import('../../src/solana/program.js');
    const info = await connection.getAccountInfo(poolAccount, 'confirmed');
    if (!info) throw new Error('pool account missing');
    return decodePool(info.data).roots;
  };
}
