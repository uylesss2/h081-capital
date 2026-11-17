// Prove solvency in one line (docs/SOLVENCY-SPEC.md) for the bank: request, prove, verify, reserve.
//
//   asker:  solvencyRequest({ min })           -> "h081-solvency-ask:..."   (sends nothing)
//   agent:  proveSolvency({ request })          -> "h081-solvency:..."       (plan unless confirm when the reserve needs a top-up)
//   asker:  verifySolvency(code, { request })   -> { ok, statement, assetSound, doesNotSay, ... }  (RPC reads only)
//
// Rules this module keeps (each closes a limit of the disclose circuit, spec section 0):
//   - proving is LOCAL only, over the account's own reserve note (an allowance granted by the main account to the
//     reserve key, keys.ts deriveReserveSk). disclose has no key check: anyone who knows a note's figures can prove for
//     it, so the reserve's figures never leave this process and nothing here calls the x402 prove-disclose service;
//   - the proof is bound to ONE request and ONE wallet: audience = H(requestDigest || wallet), and the wallet signs
//     H(requestDigest || args). A verifier recomputes the digest from its own request, never from the code;
//   - the root must be at most `maxRootAge` pool operations old (decodePool's root ring). That dates the PROOF only: the
//     tree is append-only and disclose checks no nullifier, so a spent or reclaimed note still proves at the current
//     root. Nothing here can show the note is unspent (doesNotSay item 1; spec section 0 fact 3);
//   - the asset is private in the circuit: the claim is reported asset-sound only when the bound is above what any
//     non-USDG vault could back (assetFloor). A read failure there is a failure, never a pass;
//   - bounds snap to the 1 / 2.5 / 5 ladder and the prover refuses a 5th distinct bound per verifier key per UTC day and
//     a 9th across all (probing cap), so a verifier cannot binary-search the reserve;
//   - every verify result carries `doesNotSay` (spec section 6) verbatim.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import * as snarkjs from 'snarkjs';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import { type Connection, type Keypair, LAMPORTS_PER_SOL, type ParsedInstruction, type ParsedTransactionWithMeta, type PartiallyDecodedInstruction, PublicKey, type TokenBalance } from '@solana/web3.js';
import type { Account } from '../../src/account.js';
import { FIELD } from '../../src/crypto.js';
import type { CircuitName, Prover, SolidityProof } from '../../src/prover.js';
import { encodeProof, fromBe } from '../../src/solana/field.js';
import { poolPda, vaultPda } from '../../src/solana/pda.js';
import { type DiscloseArgs, decodeAssetCaps, decodePool, encodeDiscloseArgs } from '../../src/solana/program.js';
import { simulateDisclosureCheck } from '../../src/solana/disclosure.js';
import type { SolanaPool, SolanaWallet, SolOwnedAllowance } from '../../src/solana/wallet.js';
import {
  SOLVENCY_DEFAULT_MAX_ROOT_AGE, SOLVENCY_DEFAULT_TTL_SEC, SOLVENCY_DISCLOSE_KIND, SOLVENCY_DOES_NOT_SAY, SOLVENCY_HANDSHAKE, SOLVENCY_MAX_TTL_SEC,
  type ProbeEntry, type VaultCapView, type VaultTx, assetFloor, presentationMessage, probeBlock, rootAge, snapUp, solvencyAudience, solvencyStatement, utcDay, vaultTxPeak,
} from '../../src/solvency.js';
import { type CodeContext, CodeError, type DecodedSolvencyRequest, decodeSolvencyCode, decodeSolvencyRequest, encodeSolvencyCode, encodeSolvencyRequest } from './codes.js';
import { FlatDirProver, fetchCircuits } from './circuits.js';
import { CIRCUIT_HASHES, MAINNET, type H081Config } from './constants.js';
import { fromUnits } from './units.js';

/** SOL a reserve top-up needs: a grant stages a large proof (as h081_allowance_grant), plus a reclaim when one is replaced. */
export const RESERVE_SOL_MIN = 0.1;

/** What the bank lends this module. */
export interface SolvencyHost {
  connection: Connection;
  config: H081Config;
  signer: Keypair;
  prover: Prover;
  pool: SolanaPool;
  owner: SolanaWallet;
  usdg: PublicKey;
  decimals: number;
  codeContext: CodeContext;
  /** the reserve account (deriveReserveSk) */
  reserve: Account;
  cacheDir?: string;
  fetch: typeof fetch;
  log(line: string): void;
  sync(): Promise<void>;
  saveCache(): void;
  requireArtifacts(name: CircuitName): Promise<void>;
  needSol(min: number, what: string): Promise<void>;
  grantCeiling(amount: bigint): void;
  /** the operator's program error explained */
  explain(e: unknown): Error;
  /** tests only (a dev-setup build tree): the sha256 the disclose vkey must have. The bank never sets it: the ceremony's hash is pinned */
  vkeyPin?: string;
}

// ---- small helpers

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const isZero = (b: Uint8Array) => b.every((x) => x === 0);
const nowSec = () => Math.floor(Date.now() / 1000);
const iso = (sec: bigint | number) => new Date(Number(sec) * 1000).toISOString();
const sym = MAINNET.usdg.symbol;

function walletBytes(text: string, what: string): Uint8Array {
  try { return new PublicKey(text.trim()).toBytes(); } catch { throw new Error(`${what} must be a base58 Solana wallet address`); }
}

/** The 256-byte program encoding of a proof back to the SDK's SolidityProof (encodeProof stores `a` negated). */
export function decodeProofBytes(b: Uint8Array): SolidityProof {
  const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
  const f = (o: number) => fromBe(b.subarray(o, o + 32));
  const negY = f(32);
  return { a: [f(0), negY === 0n ? 0n : Q - negY], b: [[f(64), f(96)], [f(128), f(160)]], c: [f(192), f(224)] };
}

/** snarkjs JSON of a SolidityProof (b is stored in EIP-197 c1,c0 order). */
const snarkProof = (p: SolidityProof) => ({
  pi_a: [p.a[0].toString(), p.a[1].toString(), '1'],
  pi_b: [[p.b[0][1].toString(), p.b[0][0].toString()], [p.b[1][1].toString(), p.b[1][0].toString()], ['1', '0']],
  pi_c: [p.c[0].toString(), p.c[1].toString(), '1'], protocol: 'groth16', curve: 'bn128',
});

export function decodeDiscloseArgs(b: Uint8Array): DiscloseArgs {
  const f = (i: number) => fromBe(b.subarray(32 * i, 32 * i + 32));
  return { root: f(0), kind: f(1), bound: f(2), windowId: f(3), agentPk: f(4), audience: f(5) };
}

/** A reserve note as this account sees it: plain by construction (no caps, expiry, allow-list, stream or pledge). */
const isPlain = (a: SolOwnedAllowance) => {
  const P = a.allowance.policy;
  return P.windowCap === 0n && P.maxPerTx === 0n && P.expiry === 0n && P.recipientRoot === 0n && P.streamRate === 0n && P.pledgeBps === 0n && P.lender === 0n;
};

/** The reserve notes this account granted (USDG, to the reserve key), largest first. */
export function reserveNotes(host: Pick<SolvencyHost, 'owner' | 'reserve' | 'usdg'>): SolOwnedAllowance[] {
  const asset = host.owner.registerMint(host.usdg);
  return host.owner.grantedAllowances()
    .filter((a) => a.allowance.agentPk === host.reserve.keys.pk && a.allowance.asset === asset && a.allowance.remaining > 0n)
    .sort((x, y) => (x.allowance.remaining > y.allowance.remaining ? -1 : x.allowance.remaining < y.allowance.remaining ? 1 : 0));
}

// ---- small JSON stores in the cache dir (in memory without one; a deleted cache dir never resets the in-process log)

const memory = new Map<string, unknown[]>();

function storeFile(host: SolvencyHost, name: string): string | undefined {
  return host.cacheDir ? join(host.cacheDir, `${host.config.cluster}-${host.config.poolProgramId.toBase58()}.solvency-${name}-${host.signer.publicKey.toBase58()}.json`) : undefined;
}

function readStore<T>(host: SolvencyHost, name: string): T[] {
  const file = storeFile(host, name);
  const key = `${host.config.cluster}|${host.signer.publicKey.toBase58()}|${name}`;
  let saved: T[] = [];
  if (file && existsSync(file)) { try { const j = JSON.parse(readFileSync(file, 'utf8')); if (Array.isArray(j)) saved = j as T[]; } catch { /* unreadable: memory still counts */ } }
  const seen = new Set<string>();
  return [...saved, ...((memory.get(key) as T[] | undefined) ?? [])].filter((e) => { const k = JSON.stringify(e); if (seen.has(k)) return false; seen.add(k); return true; });
}

function writeStore<T>(host: SolvencyHost, name: string, entries: T[]): void {
  const file = storeFile(host, name);
  memory.set(`${host.config.cluster}|${host.signer.publicKey.toBase58()}|${name}`, entries);
  if (file) {
    try { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(entries)); } catch (e) { host.log(`could not save the solvency ${name} log (kept in memory): ${(e as Error).message}`); }
  }
}

/** The probing cap, checked (and with `record`, recorded) for one bound to one verifier key. Exported for tests. */
export function checkSolvencyProbe(host: SolvencyHost, verifierKey: Uint8Array, bound: bigint, record: boolean, nowMs = Date.now()): void {
  const day = utcDay(nowMs);
  const log = readStore<ProbeEntry>(host, 'probes').filter((e) => e.day >= day - 1);
  const verifier = bs58.encode(verifierKey);
  const why = probeBlock(log, verifier, bound, nowMs);
  if (why) throw new Error(why);
  if (record && !log.some((e) => e.day === day && e.verifier === verifier && e.bound === bound.toString())) writeStore(host, 'probes', [...log, { day, verifier, bound: bound.toString() }]);
}

interface SeenNonce { nonce: string; expiry: number }

/** Whether this verifier already accepted `nonce` (entries are dropped once their request expired). */
function nonceSeen(host: SolvencyHost, nonce: Uint8Array, now: number): boolean {
  return readStore<SeenNonce>(host, 'nonces').some((e) => e.nonce === hex(nonce) && e.expiry >= now);
}

function recordNonce(host: SolvencyHost, nonce: Uint8Array, expiry: bigint, now: number): void {
  const live = readStore<SeenNonce>(host, 'nonces').filter((e) => e.expiry >= now);
  writeStore(host, 'nonces', [...live, { nonce: hex(nonce), expiry: Number(expiry) }]);
}

// ---- request (asker)

export interface SolvencyRequestArgs { min: bigint; label?: string; expectWallet?: string; maxRootAge?: number; ttlMinutes?: number }

export interface SolvencyRequestResult {
  code: string; min: bigint; minUsdg: string; snappedFrom?: string; expiresAt: string; maxRootAge: number; expectWallet: string | null; label: string;
  verifierKey: string; next: string; handshake: string;
}

export function solvencyRequest(host: SolvencyHost, req: SolvencyRequestArgs): SolvencyRequestResult {
  const d = host.decimals;
  if (req.min <= 0n) throw new Error('min must be positive');
  const min = snapUp(req.min, d);
  const ttl = req.ttlMinutes === undefined ? SOLVENCY_DEFAULT_TTL_SEC : Math.round(req.ttlMinutes * 60);
  if (!(ttl >= 60) || ttl > SOLVENCY_MAX_TTL_SEC) throw new Error('ttlMinutes must be 1..1440 (a request lives at most a day)');
  const maxRootAge = req.maxRootAge ?? SOLVENCY_DEFAULT_MAX_ROOT_AGE;
  if (!Number.isInteger(maxRootAge) || maxRootAge < 1 || maxRootAge > 1023) throw new Error('maxRootAge must be 1..1023 pool operations');
  const label = req.label ?? '';
  if (new TextEncoder().encode(label).length > 32) throw new Error('label must be at most 32 bytes');
  const expectWallet = req.expectWallet ? walletBytes(req.expectWallet, 'expectWallet') : new Uint8Array(32);
  const expiry = BigInt(nowSec() + ttl);
  const { code } = encodeSolvencyRequest(host.codeContext, {
    verifierKey: host.signer.publicKey.toBytes(), nonce: randomBytes(16), expiry, min, maxRootAge, expectWallet, label,
  });
  return {
    code, min, minUsdg: fromUnits(min, d), ...(min !== req.min ? { snappedFrom: fromUnits(req.min, d) } : {}), expiresAt: iso(expiry), maxRootAge,
    expectWallet: isZero(expectWallet) ? null : new PublicKey(expectWallet).toBase58(), label, verifierKey: host.signer.publicKey.toBase58(),
    next: 'send this code to the counterparty; it answers with h081_prove_solvency (an "h081-solvency:" code); check that with h081_verify_solvency and this same request, then deal only with the wallet it names',
    handshake: SOLVENCY_HANDSHAKE,
  };
}

// ---- verify (asker)

export type SolvencyReason =
  | 'bad_code' | 'bad_request' | 'other_request' | 'expired' | 'nonce_reused' | 'wrong_wallet' | 'not_in_field' | 'wrong_kind' | 'wrong_window'
  | 'below_min' | 'wrong_audience' | 'zero_agent' | 'bad_signature' | 'vkey_missing' | 'vkey_not_pinned' | 'bad_proof' | 'unknown_root' | 'stale_root'
  | 'asset_floor_unavailable' | 'asset_not_bound' | 'on_chain_rejected' | 'on_chain_unavailable' | 'pool_unavailable';

export interface SolvencyVerifyOptions {
  /** the asker's own "h081-solvency-ask:" code (required: the digest is recomputed from it) */
  request: string;
  /** 'none' (default), 'simulate' (one read-only simulated transaction) or 'send' (puts agentPk, bound and audience on chain for good) */
  onChain?: 'none' | 'simulate' | 'send';
  /** accept a bound at or below the asset floor (then the statement says "SOME asset") */
  allowUnboundAsset?: boolean;
  /** simulate: any funded system account (default this agent's wallet); its key is never used */
  feePayer?: string;
  /** tests: unix seconds */
  now?: number;
  /** internal (the prover's self-check): skip the seen-nonce store and do not record */
  selfCheck?: boolean;
}

export interface SolvencyVerifyResult {
  ok: boolean;
  reason?: SolvencyReason;
  message?: string;
  statement?: string;
  wallet?: string;
  bound?: bigint;
  boundUsdg?: string;
  root?: string;
  rootAge?: number;
  maxRootAge?: number;
  assetSound?: boolean;
  assetFloor?: bigint;
  assetFloorUsdg?: string;
  reserveKey?: string;
  request?: { label: string; min: bigint; minUsdg: string; expiresAt: string; askedByThisWallet: boolean };
  onChain?: { mode: 'simulate' | 'send'; ok: boolean; computeUnits?: number; txBytes?: number; error?: string; note: string };
  /** set when the request was not made by this wallet: whoever supplied it chose its nonce, expiry and root age */
  warning?: string;
  doesNotSay: readonly string[];
}

/** The disclose verifying key, refused unless its sha256 is the pinned ceremony hash. Only the 4 KB vkey is fetched when missing. */
async function discloseVkey(host: SolvencyHost): Promise<{ vkey?: unknown; reason?: SolvencyReason; message?: string }> {
  const file = host.prover.paths('disclose').vkey;
  if (!existsSync(file)) {
    const dir = join(file, '..');
    try {
      // a flat artifact directory (the packages): fetch only the vkey, hash-checked; a build tree is never written to
      if (host.prover instanceof FlatDirProver) await fetchCircuits({ dir, names: ['disclose'], kinds: ['vkey'], url: host.config.circuitsUrl, fetch: host.fetch, log: host.log });
    } catch (e) { return { reason: 'vkey_missing', message: `the disclose verifying key is not in ${dir} and could not be fetched (${(e as Error).message})` }; }
    if (!existsSync(file)) return { reason: 'vkey_missing', message: `the disclose verifying key is not in ${dir}` };
  }
  const raw = readFileSync(file);
  if (hex(sha256(raw)) !== (host.vkeyPin ?? CIRCUIT_HASHES.disclose.vkey)) return { reason: 'vkey_not_pinned', message: `${file} is not the ceremony's disclose verifying key (sha256 differs from the pinned one); fetch the artifacts again` };
  return { vkey: JSON.parse(raw.toString('utf8')) };
}

/** Most signatures one verify reads for one vault's new history; beyond it the floor is unknown (fails closed). */
export const VAULT_HISTORY_MAX = 10_000;

interface VaultPeak { vault: string; newest: string; peak: string }

/** A jsonParsed transaction as the pure vaultTxPeak reads it. */
function vaultTxOf(tx: ParsedTransactionWithMeta | null, sig: string): VaultTx {
  if (!tx?.meta) throw new Error(`the RPC did not return transaction ${sig} with its metadata`);
  if (tx.meta.innerInstructions == null) throw new Error(`the RPC did not return the inner instructions of ${sig}`);
  const ixOf = (ix: ParsedInstruction | PartiallyDecodedInstruction) =>
    'parsed' in ix ? { programId: ix.programId.toBase58(), parsed: ix.parsed } : { programId: ix.programId.toBase58(), accounts: ix.accounts.map((a) => a.toBase58()) };
  const bal = (xs: TokenBalance[] | null | undefined) =>
    (xs ?? []).map((b) => ({ accountIndex: b.accountIndex, amount: b.uiTokenAmount.amount }));
  return {
    keys: tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58()),
    pre: bal(tx.meta.preTokenBalances), post: bal(tx.meta.postTokenBalances),
    ixs: [...tx.transaction.message.instructions, ...tx.meta.innerInstructions.flatMap((x) => x.instructions)].map(ixOf),
  };
}

/**
 * The most `vault` ever held (spec 2.1): every transaction since its creation, read once and remembered (the history
 * is append-only, so later calls read only what is new). Throws when the history cannot be read in full or does not
 * reach the vault's creation (a pruned RPC): the caller fails closed.
 */
async function vaultPeak(host: SolvencyHost, vault: PublicKey): Promise<bigint> {
  const key = vault.toBase58();
  const saved = readStore<VaultPeak>(host, 'vault-peaks').filter((e) => e.vault === key).at(-1);
  const sigs: string[] = [];
  for (let before: string | undefined; ;) {
    const page = await host.connection.getSignaturesForAddress(vault, { limit: 1000, ...(before ? { before } : {}), ...(saved ? { until: saved.newest } : {}) }, 'confirmed');
    sigs.push(...page.map((s) => s.signature));
    if (sigs.length > VAULT_HISTORY_MAX) throw new Error(`the vault ${key} has more than ${VAULT_HISTORY_MAX} new transactions to read`);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  if (!sigs.length) {
    if (saved) return BigInt(saved.peak);
    throw new Error(`the RPC returned no history for the vault ${key}`);
  }
  let peak = saved ? BigInt(saved.peak) : 0n;
  let oldestCreated = false;
  for (let i = 0; i < sigs.length; i += 50) {
    const chunk = sigs.slice(i, i + 50);
    const txs = await host.connection.getParsedTransactions(chunk, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    chunk.forEach((sig, j) => {
      const r = vaultTxPeak(key, vaultTxOf(txs[j] ?? null, sig));
      if (r.peak > peak) peak = r.peak;
      if (i + j === sigs.length - 1) oldestCreated = r.createdHere;
    });
  }
  // newest first: the last one read must be the vault's creation, or the history was cut short
  if (!saved && !oldestCreated) throw new Error(`the RPC's history of the vault ${key} does not reach its creation`);
  const others = readStore<VaultPeak>(host, 'vault-peaks').filter((e) => e.vault !== key);
  writeStore(host, 'vault-peaks', [...others, { vault: key, newest: sigs[0], peak: peak.toString() }]);
  return peak;
}

/** Every AssetCap with its vault balance and (non-USDG) historical peak; throws on any read failure (the caller fails closed). */
async function vaultCaps(host: SolvencyHost): Promise<VaultCapView[]> {
  const pid = host.config.poolProgramId;
  const disc = sha256(new TextEncoder().encode('account:AssetCap')).subarray(0, 8);
  const caps = await host.connection.getProgramAccounts(pid, { commitment: 'confirmed', filters: [{ dataSize: 57 }, { memcmp: { offset: 0, bytes: bs58.encode(disc) } }] });
  const decoded = caps.map((c) => decodeAssetCaps(c.account.data));
  const out: VaultCapView[] = [];
  for (let i = 0; i < decoded.length; i += 100) {
    const chunk = decoded.slice(i, i + 100);
    const vaults = await host.connection.getMultipleAccountsInfo(chunk.map((c) => vaultPda(pid, c.mint)), 'confirmed');
    chunk.forEach((c, j) => {
      const v = vaults[j];
      const vaultBalance = v && v.data.length >= 72 ? Buffer.from(v.data).readBigUInt64LE(64) : 0n;
      out.push({ mint: c.mint.toBase58(), maxTotal: c.maxTotal, vaultBalance, peak: 0n });
    });
  }
  for (const v of out) if (v.mint !== host.usdg.toBase58()) v.peak = await vaultPeak(host, vaultPda(pid, new PublicKey(v.mint)));
  return out;
}

/** Checks a presentation against the asker's own request, in the spec's order (3.1); the first failure is `reason`. */
export async function verifySolvency(host: SolvencyHost, code: string, opts: SolvencyVerifyOptions): Promise<SolvencyVerifyResult> {
  const d = host.decimals;
  const doesNotSay = SOLVENCY_DOES_NOT_SAY;
  const fail = (reason: SolvencyReason, message: string, extra: Partial<SolvencyVerifyResult> = {}): SolvencyVerifyResult => ({ ok: false, reason, message, ...extra, doesNotSay });
  const now = opts.now ?? nowSec();
  // frame, kind 11, network tag
  let p;
  try { p = decodeSolvencyCode(host.codeContext, code); } catch (e) { return fail('bad_code', (e as Error).message); }
  // the request: decodes, and its digest (recomputed here) is the one the presentation commits to
  let r: DecodedSolvencyRequest;
  try { r = decodeSolvencyRequest(host.codeContext, opts.request); } catch (e) { return fail('bad_request', (e as Error).message); }
  const request = { label: r.label, min: r.min, minUsdg: fromUnits(r.min, d), expiresAt: iso(r.expiry), askedByThisWallet: new PublicKey(r.verifierKey).equals(host.signer.publicKey) };
  const wallet = new PublicKey(p.wallet).toBase58();
  const base = { request, wallet, maxRootAge: r.maxRootAge };
  if (hex(p.requestDigest) !== hex(r.digest)) return fail('other_request', 'this proof answers another request, not this one', base);
  if (BigInt(now) > r.expiry) return fail('expired', `the request expired at ${iso(r.expiry)}`, base);
  if (!opts.selfCheck && nonceSeen(host, r.nonce, now)) return fail('nonce_reused', 'this request was already answered and accepted once; a presentation counts once per request (ask again for a fresh one)', base);
  if (!isZero(r.expectWallet) && hex(r.expectWallet) !== hex(p.wallet)) return fail('wrong_wallet', `the request expects ${new PublicKey(r.expectWallet).toBase58()}, the proof is presented by ${wallet}`, base);
  // args
  const fields = Array.from({ length: 6 }, (_, i) => fromBe(p.args.subarray(32 * i, 32 * i + 32)));
  if (fields.some((x) => x >= FIELD)) return fail('not_in_field', 'a public input of the proof is not a field element', base);
  const args = decodeDiscloseArgs(p.args);
  if (args.kind !== SOLVENCY_DISCLOSE_KIND) return fail('wrong_kind', `the proof is disclose kind ${args.kind}, not 0 (remaining at least)`, base);
  if (args.windowId !== 0n) return fail('wrong_window', 'a remaining-at-least proof has windowId 0', base);
  const bound = args.bound;
  const more = { ...base, bound, boundUsdg: fromUnits(bound, d), root: args.root.toString(), reserveKey: args.agentPk.toString() };
  if (bound < r.min) return fail('below_min', `the proof shows at least ${fromUnits(bound, d)} ${sym}, less than the ${fromUnits(r.min, d)} ${sym} asked`, more);
  if (args.audience !== solvencyAudience(r.digest, p.wallet)) return fail('wrong_audience', 'the proof is bound to another request or another wallet', more);
  if (args.agentPk === 0n) return fail('zero_agent', 'the proof names no reserve key', more);
  // the wallet signed this presentation for this request
  let sigOk = false;
  try { sigOk = ed25519.verify(p.signature, presentationMessage(r.digest, p.args), p.wallet); } catch { sigOk = false; }
  if (!sigOk) return fail('bad_signature', `the presentation is not signed by ${wallet}`, more);
  // Groth16 against the pinned ceremony key
  const vk = await discloseVkey(host);
  if (!vk.vkey) return fail(vk.reason!, vk.message!, more);
  const proof = decodeProofBytes(p.proof);
  let proofOk = false;
  try { proofOk = await snarkjs.groth16.verify(vk.vkey as never, fields.map(String), snarkProof(proof) as never); } catch { proofOk = false; }
  if (!proofOk) return fail('bad_proof', 'the zero-knowledge proof does not verify', more);
  // root recency
  let age: number | undefined;
  try {
    const info = await host.connection.getAccountInfo(poolPda(host.config.poolProgramId), 'confirmed');
    if (!info) return fail('pool_unavailable', 'the pool account was not found on this network', more);
    const pool = decodePool(info.data);
    age = rootAge(pool.roots, pool.currentRootIndex, args.root);
  } catch (e) { return fail('pool_unavailable', `could not read the pool's root history: ${(e as Error).message}`, more); }
  if (age === undefined) return fail('unknown_root', 'the proof\'s pool root is not in the pool\'s root history (too old, or never a root)', more);
  if (age > r.maxRootAge) return fail('stale_root', `the proof's pool root is ${age} operations old; the request allows ${r.maxRootAge}`, { ...more, rootAge: age });
  // asset floor (fails closed)
  let floor: bigint;
  try { floor = assetFloor(await vaultCaps(host), host.usdg.toBase58()); } catch (e) {
    return fail('asset_floor_unavailable', `could not read the pool's vault caps, so the asset cannot be bounded (${(e as Error).message}); retry with an RPC that serves getProgramAccounts`, { ...more, rootAge: age });
  }
  const assetSound = bound > floor;
  const sound = { ...more, rootAge: age, assetSound, assetFloor: floor, assetFloorUsdg: fromUnits(floor, d) };
  const statement = solvencyStatement({ bound: fromUnits(bound, d), symbol: sym, rootAge: age, wallet, assetSound });
  if (!assetSound && !opts.allowUnboundAsset) {
    return fail('asset_not_bound', `a vault of another asset held up to ${fromUnits(floor, d)} units at some point (or may take that much under its cap), so a bound of ${fromUnits(bound, d)} does not show ${sym}; ask for more than that, or pass allowUnboundAsset to accept "some asset"`, { ...sound, statement });
  }
  // optional on-chain check: the deployed verifier agrees (known root + Groth16 only)
  let onChain: SolvencyVerifyResult['onChain'];
  const mode = opts.onChain ?? 'none';
  if (mode === 'simulate') {
    let payer: PublicKey;
    try { payer = opts.feePayer ? new PublicKey(opts.feePayer) : host.signer.publicKey; } catch { return fail('on_chain_unavailable', 'feePayer must be a base58 Solana address', sound); }
    try {
      const lamports = await host.connection.getBalance(payer, 'confirmed');
      if (lamports < 0.01 * LAMPORTS_PER_SOL) return fail('on_chain_unavailable', `the simulated check needs a fee payer holding SOL; ${payer.toBase58()} has ${lamports / LAMPORTS_PER_SOL} SOL (pass feePayer: any funded wallet; no key is used)`, sound);
      const sim = await simulateDisclosureCheck(host.connection, host.config.poolProgramId, payer, new Uint8Array([...p.proof, ...p.args]));
      onChain = { mode, ok: sim.ok, computeUnits: sim.computeUnits, txBytes: sim.txBytes, ...(sim.error ? { error: sim.error } : {}), note: 'one simulated transaction (sigVerify off): nothing was signed or sent' };
    } catch (e) { return fail('on_chain_unavailable', `the simulated check could not run: ${(e as Error).message}`, sound); }
    if (!onChain.ok) return fail('on_chain_rejected', `the deployed verify_disclosure refused it: ${onChain.error}`, { ...sound, onChain });
  } else if (mode === 'send') {
    try {
      const sent = await host.pool.verifyDisclosure(host.signer, { proof, publicSignals: fields, raw: { proof: snarkProof(proof), publicSignals: fields.map(String) } }, args, 'send');
      onChain = { mode, ok: sent, note: 'sent: the reserve key, the bound and the audience are now on chain for good' };
    } catch (e) { return fail('on_chain_unavailable', `the on-chain check could not be sent: ${(e as Error).message}`, sound); }
    if (!onChain.ok) return fail('on_chain_rejected', 'the deployed verify_disclosure refused it', { ...sound, onChain });
  }
  if (!opts.selfCheck) recordNonce(host, r.nonce, r.expiry, now);
  const warning = request.askedByThisWallet || opts.selfCheck ? undefined
    : `this request was not made by this wallet (its verifierKey is ${new PublicKey(r.verifierKey).toBase58()}): whoever supplied it chose its nonce, its expiry (${request.expiresAt}) and its root age (${r.maxRootAge}), so whether this proof was made for you, and recently, rests on them. Ask with h081_solvency_request yourself for a check you control.`;
  return { ok: true, statement, ...sound, ...(onChain ? { onChain } : {}), ...(warning ? { warning } : {}), doesNotSay };
}

// ---- prove (agent)

export interface ProveSolvencyArgs { request: string; amount?: bigint; confirm?: boolean }

export interface SolvencyPlan {
  sent: false; dryRun: true;
  plan: {
    action: 'reserve top-up'; topUp: bigint; topUpUsdg: string; reclaimFirst?: string[]; shielded: bigint; shieldedUsdg: string; shieldedAfter: bigint; shieldedAfterUsdg: string;
    bound: bigint; boundUsdg: string; solNeeded: number; sender: string; privacy: string;
  };
  next: string;
}

export interface ProveSolvencyResult {
  code: string; bound: bigint; boundUsdg: string; snappedFrom?: string; wallet: string; root: string; reserveId: bigint; reserveRemaining: bigint; reserveRemainingUsdg: string;
  request: { label: string; verifierKey: string; expiresAt: string };
  topUp?: { reclaimed: string[]; signatures: string[]; granted: bigint; grantedUsdg: string };
  selfCheck: { ok: boolean; assetSound?: boolean; reason?: string };
  statement?: string;
  doesNotSay: readonly string[];
  next: string;
}

const PRIVACY = 'a reserve top-up is an ordinary grant: the agent wallet is visible on chain as its sender; the amount and the recipient are not. The proof itself is made locally and sends nothing; it reveals the bound (a lower bound only), the reserve key (used for nothing else), an approximate time (the root) and your wallet to the asker.';

export async function proveSolvency(host: SolvencyHost, req: ProveSolvencyArgs): Promise<ProveSolvencyResult | SolvencyPlan> {
  const d = host.decimals;
  const u = (x: bigint) => `${fromUnits(x, d)} ${sym}`;
  let r: DecodedSolvencyRequest;
  try { r = decodeSolvencyRequest(host.codeContext, req.request); } catch (e) { throw e instanceof CodeError ? e : new CodeError((e as Error).message); }
  const now = nowSec();
  if (BigInt(now) >= r.expiry) throw new Error(`that solvency request expired at ${iso(r.expiry)}; ask for a fresh one. Nothing was sent.`);
  if (r.expiry > BigInt(now + SOLVENCY_MAX_TTL_SEC + 300)) throw new Error('that solvency request lives longer than a day, which this bank does not answer (a long-lived request is a standing bearer claim). Nothing was sent.');
  const me = host.signer.publicKey;
  if (!isZero(r.expectWallet) && !new PublicKey(r.expectWallet).equals(me)) throw new Error(`that request is for the wallet ${new PublicKey(r.expectWallet).toBase58()}, not this agent's ${me.toBase58()}. Nothing was sent.`);
  // the bound: the request's minimum on the ladder (a hostile asker cannot pick a fine-grained bound)
  const bound = snapUp(r.min, d);
  checkSolvencyProbe(host, r.verifierKey, bound, false);
  await host.sync();
  const notes = reserveNotes(host).filter(isPlain);
  let reserve = notes.filter((n) => n.allowance.remaining >= bound).at(-1); // the smallest that suffices
  let topUp: ProveSolvencyResult['topUp'];
  if (!reserve) {
    const reclaim = notes; // every smaller reserve goes back first: one reserve per account (D4)
    const back = reclaim.reduce((s, n) => s + n.allowance.remaining, 0n);
    const shielded = host.owner.balance(host.usdg);
    const amount = req.amount ?? snapUp(bound, d);
    if (amount < bound) throw new Error(`the reserve amount ${u(amount)} is below the bound ${u(bound)} the request needs. Nothing was sent.`);
    if (amount > shielded + back) throw new Error(`the reserve needs ${u(amount)}; the shielded balance is ${u(shielded)}${back ? ` plus ${u(back)} in the current reserve` : ''}. Deposit first (h081_bank_deposit). Nothing was sent.`);
    host.grantCeiling(amount);
    if (!req.confirm) {
      return {
        sent: false, dryRun: true,
        plan: {
          action: 'reserve top-up', topUp: amount, topUpUsdg: fromUnits(amount, d), ...(reclaim.length ? { reclaimFirst: reclaim.map((n) => n.commitment.toString()) } : {}),
          shielded, shieldedUsdg: fromUnits(shielded, d), shieldedAfter: shielded + back - amount, shieldedAfterUsdg: fromUnits(shielded + back - amount, d),
          bound, boundUsdg: fromUnits(bound, d), solNeeded: RESERVE_SOL_MIN, sender: me.toBase58(), privacy: PRIVACY,
        },
        next: 'nothing was sent. Call h081_prove_solvency again with the same request and confirm: true to set the reserve aside and prove; the reserve stays yours (h081_solvency_reserve release takes it back)',
      };
    }
    if (reclaim.length) await host.requireArtifacts('spend');
    await host.requireArtifacts('grant');
    await host.requireArtifacts('disclose');
    await host.needSol(RESERVE_SOL_MIN, 'a reserve top-up stages a large proof and');
    const signatures: string[] = [];
    try {
      for (const n of reclaim) signatures.push((await host.owner.reclaim(n)).tx.signature);
      const g = await host.owner.grant(host.usdg, [{ to: host.reserve.address, amount, windowCap: 0n, windowLen: 86400n, maxPerTx: 0n, expiry: 0n, streamRate: 0n }]);
      signatures.push(g.tx.signature);
    } catch (e) { throw host.explain(e); } finally { host.saveCache(); }
    topUp = { reclaimed: reclaim.map((n) => n.commitment.toString()), signatures, granted: amount, grantedUsdg: fromUnits(amount, d) };
    await host.sync();
    reserve = reserveNotes(host).filter(isPlain).filter((n) => n.allowance.remaining >= bound).at(-1);
    if (!reserve) throw new Error('the reserve was granted but is not visible yet; call h081_prove_solvency again in a moment (nothing more will be sent)');
  }
  await host.requireArtifacts('disclose');
  const audience = solvencyAudience(r.digest, me.toBytes());
  let made: Awaited<ReturnType<SolanaWallet['prove']>>;
  try { made = await host.owner.prove(reserve, 'remainingAtLeast', bound, audience); } catch (e) { throw new Error(`the solvency proof could not be made: ${(e as Error).message}. ${topUp ? 'The reserve top-up was sent; ' : ''}Nothing else was sent.`); }
  const argsBytes = encodeDiscloseArgs(made.args);
  const signature = ed25519.sign(presentationMessage(r.digest, argsBytes), host.signer.secretKey.subarray(0, 32));
  const code = encodeSolvencyCode(host.codeContext, { requestDigest: r.digest, proof: encodeProof(made.proof.proof), args: argsBytes, wallet: me.toBytes(), signature });
  checkSolvencyProbe(host, r.verifierKey, bound, true);
  // verify it as the asker would, before handing it over (no nonce store: that is the asker's)
  const self = await verifySolvency(host, code, { request: req.request, selfCheck: true, allowUnboundAsset: true, now });
  // an RPC that refuses getProgramAccounts leaves the asset floor unknown: the proof is still good, the asker's check decides
  const soft = !self.ok && self.reason === 'asset_floor_unavailable';
  if (!self.ok && !soft) throw new Error(`the solvency proof did not pass its own check (${self.reason}: ${self.message}); it was not handed out. ${topUp ? 'The reserve top-up was sent. ' : ''}`);
  return {
    code, bound, boundUsdg: fromUnits(bound, d), ...(bound !== r.min ? { snappedFrom: fromUnits(r.min, d) } : {}), wallet: me.toBase58(), root: made.args.root.toString(),
    reserveId: reserve.commitment, reserveRemaining: reserve.allowance.remaining, reserveRemainingUsdg: fromUnits(reserve.allowance.remaining, d),
    request: { label: r.label, verifierKey: new PublicKey(r.verifierKey).toBase58(), expiresAt: iso(r.expiry) },
    ...(topUp ? { topUp } : {}),
    selfCheck: soft ? { ok: true, reason: self.reason } : { ok: true, assetSound: self.assetSound },
    statement: self.statement, doesNotSay: SOLVENCY_DOES_NOT_SAY,
    next: `hand this code to the asker now (it passes their check for about ${r.maxRootAge} pool operations and until ${iso(r.expiry)}); they check it with h081_verify_solvency and their request. The reserve stays set aside until you release it (h081_solvency_reserve release); the proof cannot show that it still is.`,
  };
}

// ---- the reserve (agent)

export interface ReserveView { id: bigint; remaining: bigint; remainingUsdg: string }

export interface SolvencyReserveResult {
  reserve: ReserveView | null;
  others: ReserveView[];
  totalUsdg: string;
  note: string;
}

export type SolvencyReleasePlan = { sent: false; dryRun: true; plan: { action: 'release reserve'; reclaim: ReserveView[]; backToShieldedUsdg: string; sender: string }; next: string };
export type SolvencyReleaseResult = { sent: true; signatures: string[]; released: ReserveView[]; shielded: bigint; shieldedUsdg: string };

const viewOf = (n: SolOwnedAllowance, d: number): ReserveView => ({ id: n.commitment, remaining: n.allowance.remaining, remainingUsdg: fromUnits(n.allowance.remaining, d) });

export async function solvencyReserve(host: SolvencyHost, req: { release?: boolean; confirm?: boolean } = {}): Promise<SolvencyReserveResult | SolvencyReleasePlan | SolvencyReleaseResult> {
  const d = host.decimals;
  await host.sync();
  const notes = reserveNotes(host);
  const views = notes.map((n) => viewOf(n, d));
  const total = notes.reduce((s, n) => s + n.allowance.remaining, 0n);
  if (!req.release) {
    if (req.confirm !== undefined) throw new Error('confirm applies to release only. Nothing was sent.');
    return {
      reserve: views[0] ?? null, others: views.slice(1), totalUsdg: fromUnits(total, d),
      note: 'the solvency reserve: an allowance this account granted to its own reserve key. h081_pay never spends it; h081_prove_solvency proves "at least X" over it; release (or h081_allowance_reclaim with its id) takes it back into the shielded balance',
    };
  }
  if (!notes.length) throw new Error('there is no solvency reserve to release. Nothing was sent.');
  if (!req.confirm) {
    return {
      sent: false, dryRun: true, plan: { action: 'release reserve', reclaim: views, backToShieldedUsdg: fromUnits(total, d), sender: host.signer.publicKey.toBase58() },
      next: 'nothing was sent. Call h081_solvency_reserve again with release: true and confirm: true to take it back; proofs already handed out keep verifying until their root is older than the asker allows, and the released note stays in the pool\'s tree (a proof over it cannot show it was released)',
    };
  }
  await host.requireArtifacts('spend');
  await host.needSol(0.02, 'a reclaim the agent key sends');
  const signatures: string[] = [];
  try { for (const n of notes) signatures.push((await host.owner.reclaim(n)).tx.signature); } catch (e) { throw host.explain(e); } finally { host.saveCache(); }
  const left = host.owner.balance(host.usdg);
  return { sent: true, signatures, released: views, shielded: left, shieldedUsdg: fromUnits(left, d) };
}
