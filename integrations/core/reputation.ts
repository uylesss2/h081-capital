// Private reputation for the bank (docs/REPUTATION-SPEC.md): request, prove, verify, attest, status.
//
// Rules this module keeps (each one closes a hole found in review):
//   - the borrower never signs an attest: its wallet as signer / fee payer would link the loan to it on chain. Attests
//     go through the relayer (POST /v1/rep/attest) or the lender (lendClose); `reputationAttest` refuses to self-sign
//     unless told `selfSign: true`, and then says what it links. The relayer only QUEUES a request (202): its sweep
//     attests every repaid loan together, in loanRef order, so the on-chain timing does not cluster one borrower's
//     loans. The relayer operator still sees one client name them (docs/REPUTATION-SPEC.md 3.3); requests go out in
//     random order.
//   - a proof is bound by default: bindTo = the verifier's own binding from the request, else a fresh session key whose
//     signature ("h081-rep-sig:" code) the prover hands over only when presenting. A code with bindTo 0 is a bearer
//     token and verifyReputation refuses it unless `allowBearer`.
//   - thresholds snap DOWN to the public ladder when proving (UP when asking), and the prover refuses more than
//     REP_MAX_SETS_PER_DAY distinct threshold sets per audience (and per bindTo key) per day, and more than
//     REP_MAX_SETS_PER_DAY_ALL across all audiences (fresh audience names do not reset it), so nobody can
//     binary-search the exact record. Without a cache dir the log lives in memory for the life of the process.
//   - every verifier-facing result carries `statement` (a lower bound on repaid loans; says nothing about defaults)
//     and `setup` (beta: single-party trusted setup until a multi-party ceremony runs).
//   - nothing proves remotely: the witness holds the account secret.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomInt } from 'node:crypto';
import * as snarkjs from 'snarkjs';
import { ed25519 } from '@noble/curves/ed25519';
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import { loanPk } from '../../src/crypto.js';
import type { Prover } from '../../src/prover.js';
import {
  REP_MAX_TTL_SEC, REP_MIN_PRINCIPAL, REP_SETUP_STATUS, REP_STATEMENT_NOTE, ReputationUnreachable, assertRequirementRange, audienceOf, isOnLadder, randomNonce,
  repPublicList, reputationInput, selectLoans, snapRequirement, snapRequirementUp, statsOf, type RepPublic, type RepRequirement,
} from '../../src/reputation.js';
import { encodeProof, fieldOf, fromBe } from '../../src/solana/field.js';
import { decodeSlot, slotPda } from '../../src/solana/lender.js';
import {
  REP_BLOCK_NOTE, REP_ERROR_NAME, attestIx, eventsOfSnapshot, fetchRepEvents, fetchRepTree, isAttested, isKnownRepRootIn, myRepLoans, rebuildRepTree,
  repBlockOf, verifyReputationIx, type RepAttestedEvent, type RepBlock, type RepSnapshot,
} from '../../src/solana/reputation.js';
import {
  CodeError, decodeRepCode, decodeRepRequest, decodeRepSig, encodeRepCode, encodeRepRequest, encodeRepSig, repPresentationMessage,
  type CodeContext, type RepCode, type RepThresholds,
} from './codes.js';
import { CIRCUIT_HASHES, type H081Config } from './constants.js';
import { fromUnits, toUnits } from './units.js';

/** Distinct threshold sets one account may prove to one audience (or one bindTo key) per day (limits binary-searching the volume). */
export const REP_MAX_SETS_PER_DAY = 4;
/** Distinct threshold sets one account may prove per day across ALL audiences: a verifier that knows the prover cannot reset the cap with fresh audience names. */
export const REP_MAX_SETS_PER_DAY_ALL = 8;
/** Default lifetime of a proof (and of a request). */
export const REP_DEFAULT_TTL_SEC = 600;
/** Base of the virtual sub-account indices that stand for loan keys in the bank (index = REP_LOAN_KEY_BASE + k). */
export const REP_LOAN_KEY_BASE = 1000;
/** How far past the highest known loan key recovery looks (gap limit). */
export const REP_GAP_LIMIT = 20;

/** What the bank lends this module. */
export interface RepEnv {
  connection: Connection;
  config: H081Config;
  signer: Keypair;
  accountSk: bigint;
  prover: Prover;
  fetch: typeof fetch;
  relayerUrl?: string;
  cacheDir?: string;
  log: (line: string) => void;
  /** loan key indices this account has used (bank cache) */
  loanKeys(): number[];
  /** remembers loan keys found on chain */
  rememberLoanKeys(ks: number[]): void;
  /** agent public keys of the HMAC sub-accounts 0..15 (loans under them never count) */
  legacyAgentPks(): bigint[];
}

export interface ThresholdArgs {
  minLoans?: number; minVolume?: string | bigint; minLenders?: number; minSpanDays?: number; minMonths?: number; monthFloor?: string | bigint;
}

const REP_THRESHOLD_KEYS = ['minLoans', 'minVolume', 'minLenders', 'minSpanDays', 'minMonths', 'monthFloor'] as const;

export interface RepView extends Omit<RepThresholds, 'minVolume' | 'monthFloor'> { minVolume: string; minVolumeUnits: string; monthFloor: string; monthFloorUnits: string }

export interface ReputationRequestResult { code: string; audience: string; nonce: string; expiresAt: number; thresholds: RepView; bindTo?: string; note: string }
export interface ProveReputationResult {
  code: string; presentation?: string;
  /** the verifier's name hashed (0x hex) and the challenge this code answers: a verifier without a request checks with { audience, nonce } */
  audience: string; nonce: string;
  /**
   * who chose the nonce: the verifier's request, a nonce the verifier gave (`nonce`), or one the prover drew itself. A
   * prover-drawn nonce proves no freshness to the verifier (it is copied out of the code): only the expiry and the
   * verifier's own list of nonces it accepted stop a replay. A verifier that needs a live answer issues a request code.
   */
  challenge: 'request' | 'verifier' | 'prover-chosen';
  presNullifier: string; expiresAt: number; thresholds: RepView; counted: { loans: number };
  binding: 'request' | 'given-key' | 'session-key'; setup: string; statement: string; next: string; snapped?: string;
}
export interface VerifyReputationResult {
  ok: boolean; reason?: string; thresholds?: RepView; asset?: string; presNullifier?: string; audience?: string; expiresAt?: number;
  presenter?: 'request-binding' | 'signed-session-key' | 'bearer';
  /** ran: false = the simulation could not run (a fee payer that cannot pay, a transaction the cluster rejected before the program ran, an RPC failure), which is not a refusal */
  onChain?: { ok: boolean; ran?: false; computeUnits?: number; error?: string };
  lowerBoundOnly: true; statement: string; setup: string;
}
export interface ReputationStatus {
  attested: { count: number; volume: string; lenders: number; spanDays: number; months: number };
  pending: Array<{ loanRef: string; principal: string }>;
  /**
   * repaid loans rep_registry refuses for good, as they can appear here: slashed or too small. (The reason type is shared
   * with the relayer and the lender close, which also see `backed` and `no_agent_key`: a backed loan has agent key 0, so
   * it never matches this account's loan keys and never shows up in a borrower's status at all.)
   */
  never: Array<{ loanRef: string; principal: string; reason: 'backed' | 'slashed' | 'no_agent_key' | 'too_small' }>;
  legacy: number; loanKeys: number;
  warnings: string[]; statement: string; setup: string;
}

const toBig = (x: string | bigint | undefined, d: number, what: string): bigint => {
  if (x === undefined) return 0n;
  if (typeof x === 'bigint') return x;
  try { return toUnits(x, d); } catch { throw new Error(`${what} must be an amount like "500" or "12.5"`); }
};

function requirementOf(a: ThresholdArgs, d: number): RepRequirement {
  return {
    minLoans: a.minLoans ?? 1, minVolume: toBig(a.minVolume, d, 'minVolume'), minLenders: a.minLenders ?? 0, minSpanDays: a.minSpanDays ?? 0,
    minMonths: a.minMonths ?? 0, monthFloor: toBig(a.monthFloor, d, 'monthFloor'),
  };
}

export function repView(t: RepThresholds, d: number): RepView {
  return { ...t, minVolume: fromUnits(t.minVolume, d), minVolumeUnits: t.minVolume.toString(), monthFloor: fromUnits(t.monthFloor, d), monthFloorUnits: t.monthFloor.toString() };
}

/** Only the six thresholds (never spread a decoded request or code into a code: its bindTo/audience would come along). */
const thresholdsOf = (t: RepThresholds): RepRequirement => ({ minLoans: t.minLoans, minVolume: t.minVolume, minLenders: t.minLenders, minSpanDays: t.minSpanDays, minMonths: t.minMonths, monthFloor: t.monthFloor });
const thresholdsKey = (t: RepThresholds) => `${t.minLoans}|${t.minVolume}|${t.minLenders}|${t.minSpanDays}|${t.minMonths}|${t.monthFloor}`;
const hex = (x: bigint) => '0x' + x.toString(16).padStart(64, '0');

function programOf(env: RepEnv): PublicKey {
  if (!env.config.repProgramId) throw new Error(`private reputation is not deployed on ${env.config.cluster} yet (no rep_registry program id). Nothing was sent.`);
  return env.config.repProgramId;
}

export function repContext(env: RepEnv): CodeContext {
  return { cluster: env.config.cluster, program: programOf(env).toBase58(), mint: env.config.usdgMint.toBase58() };
}

const setupLabel = (env: RepEnv) => (env.config.repDevSetup ? 'DEV setup (localnet): not trustworthy; ' : '') + REP_SETUP_STATUS;

/** The reputation verifying key, checked against the pinned hash (or allowed unpinned on a localnet dev setup). */
function vkeyOf(env: RepEnv): unknown {
  const file = env.prover.paths('reputation').vkey;
  if (!existsSync(file)) throw new Error(`the reputation verifying key is not in ${join(file, '..')}. Nothing was checked.`);
  const raw = readFileSync(file);
  const pinned = CIRCUIT_HASHES.reputation.vkey;
  if (!pinned) {
    if (!env.config.repDevSetup) throw new Error('reputation is not released: no ceremony verifying key is pinned in this package. (Localnet tests: H081_REP_DEV_SETUP=1.)');
  } else if (createHash('sha256').update(raw).digest('hex') !== pinned) {
    throw new Error('the reputation verifying key does not match the pinned hash; fetch the artifacts again.');
  }
  return JSON.parse(raw.toString('utf8'));
}

function requireProvingArtifacts(env: RepEnv): void {
  const p = env.prover.paths('reputation');
  if (!existsSync(p.wasm) || !existsSync(p.zkey)) throw new Error(`the reputation proving artifacts are not in ${join(p.wasm, '..')}. Nothing was proven.`);
  if (!CIRCUIT_HASHES.reputation.zkey && !env.config.repDevSetup) throw new Error('reputation is not released: no ceremony proving key is pinned in this package.');
}

// ---- the leaf set: the relayer snapshot when there is one (checked against the chain), else the chain itself

async function leaves(env: RepEnv): Promise<{ events: RepAttestedEvent[]; tree: ReturnType<typeof rebuildRepTree>; version: number }> {
  const program = programOf(env);
  const onChain = await fetchRepTree(env.connection, program, 0);
  if (!onChain) throw new Error(`rep_registry is not initialized on ${env.config.cluster}.`);
  let events: RepAttestedEvent[] | undefined;
  if (env.relayerUrl) {
    try {
      const res = await env.fetch(`${env.relayerUrl.replace(/\/$/, '')}/v1/rep/leaves`, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        const snap = (await res.json()) as RepSnapshot;
        if (snap.program === program.toBase58()) events = eventsOfSnapshot(snap);
      }
    } catch (e) { env.log(`no reputation snapshot from the relayer (${(e as Error).message}); reading the chain`); }
  }
  if (!events || events.length < onChain.nextIndex) events = await fetchRepEvents(env.connection, program, 0);
  // every leaf is re-hashed and the rebuilt root must be the chain's: a lying snapshot fails here
  const tree = rebuildRepTree(events.filter((e) => e.index < onChain.nextIndex), onChain);
  return { events, tree, version: onChain.version };
}

// ---- request (verifier side)

export function reputationRequest(env: RepEnv, req: ThresholdArgs & { audience: string; ttlSec?: number; bindTo?: string; label?: string }): ReputationRequestResult {
  const d = env.config.decimals;
  const want = requirementOf(req, d);
  assertRequirementRange(want);
  const t = snapRequirementUp(want, d);
  const ttl = req.ttlSec ?? REP_DEFAULT_TTL_SEC;
  if (!(ttl > 0) || ttl > REP_MAX_TTL_SEC) throw new Error(`ttlSec must be 1..${REP_MAX_TTL_SEC}`);
  const nonce = randomNonce();
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  let bindTo = 0n;
  if (req.bindTo) { try { bindTo = fieldOf(new PublicKey(req.bindTo)); } catch { throw new Error('bindTo must be a base58 Solana public key'); } }
  const audience = audienceOf(req.audience);
  const code = encodeRepRequest(repContext(env), { audience, nonce, expiry: BigInt(expiresAt), bindTo, label: (req.label ?? req.audience).slice(0, 32), ...t });
  return {
    code, audience: hex(audience), nonce: hex(nonce), expiresAt, thresholds: repView(t, d), ...(req.bindTo ? { bindTo: req.bindTo } : {}),
    note: `thresholds are rounded UP to the public ladder; keep this code: verify the answer with h081_verify_reputation and this request (it checks audience, nonce, thresholds and binding). Accept each nonce once.${bindTo === 0n ? ' Without bindTo the prover binds the proof to a session key and must also hand over its presenter signature (h081-rep-sig:).' : ''}`,
  };
}

// ---- prove (prover side; local only)

function presentationsFile(env: RepEnv): string | undefined {
  return env.cacheDir ? join(env.cacheDir, `${env.config.cluster}-rep-presentations-${env.signer.publicKey.toBase58()}.json`) : undefined;
}

interface ProbeEntry { nf: string; day: number; key: string; bind?: string }
/** The presentation log when there is no cache dir: kept for the life of the process, never skipped. */
const probeLogs = new Map<string, ProbeEntry[]>();

/**
 * The probing cap. Refuses, in one UTC day: a 5th distinct threshold set for one audience (presNullifier), a 5th for one
 * bindTo key (when the request or the caller names one), and a 9th across all audiences. A set already proven today
 * costs nothing again. Records the set otherwise. Exported for tests.
 */
export function checkProbeCap(env: RepEnv, nf: bigint, t: RepThresholds, bindTo?: bigint, now = Date.now()): void {
  const file = presentationsFile(env);
  const mem = `${env.config.cluster}|${env.signer.publicKey.toBase58()}`;
  const day = Math.floor(now / 86_400_000);
  // the saved log and this process's own log, merged: a deleted or unwritable cache dir never resets the cap
  let saved: ProbeEntry[] = [];
  if (file && existsSync(file)) { try { const j = JSON.parse(readFileSync(file, 'utf8')); if (Array.isArray(j)) saved = j; } catch { /* unreadable: the in-memory log still counts */ } }
  const seen = new Set<string>();
  const log = [...saved, ...(probeLogs.get(mem) ?? [])].filter((e) => {
    const k = `${e.nf}|${e.day}|${e.key}|${e.bind ?? ''}`;
    if (e.day < day - 1 || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const today = log.filter((e) => e.day === day);
  const key = thresholdsKey(t), id = nf.toString(16), bind = bindTo ? bindTo.toString(16) : undefined;
  const over = (entries: ProbeEntry[], cap: number) => { const sets = new Set(entries.map((e) => e.key)); return !sets.has(key) && sets.size >= cap; };
  if (over(today.filter((e) => e.nf === id), REP_MAX_SETS_PER_DAY)) {
    throw new Error(`this audience already received ${REP_MAX_SETS_PER_DAY} different reputation thresholds from this account today; proving another set would let it narrow down your exact volume. Nothing was proven.`);
  }
  if (bind && over(today.filter((e) => e.bind === bind), REP_MAX_SETS_PER_DAY)) {
    throw new Error(`the key this proof would be bound to already received ${REP_MAX_SETS_PER_DAY} different reputation thresholds from this account today (under any audience name); proving another set would let it narrow down your exact volume. Nothing was proven.`);
  }
  if (over(today, REP_MAX_SETS_PER_DAY_ALL)) {
    throw new Error(`this account already proved ${REP_MAX_SETS_PER_DAY_ALL} different reputation thresholds today across all audiences; one verifier asking under several audience names could narrow down your exact volume. Try again tomorrow, or repeat a set already proven today. Nothing was proven.`);
  }
  log.push({ nf: id, day, key, ...(bind ? { bind } : {}) });
  probeLogs.set(mem, log);
  if (file) { try { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(log)); } catch (e) { env.log(`could not save the presentation log (kept in memory): ${(e as Error).message}`); } }
}

export async function proveReputation(env: RepEnv, req: ThresholdArgs & { audience?: string; request?: string; nonce?: string; bindTo?: string; expiresInSec?: number }): Promise<ProveReputationResult> {
  const d = env.config.decimals, ctx = repContext(env);
  requireProvingArtifacts(env);
  let audience: bigint, nonce: bigint, expiry: bigint, bindTo = 0n, binding: ProveReputationResult['binding'] = 'session-key';
  let challenge: ProveReputationResult['challenge'] = 'request';
  let asked: RepRequirement, snappedNote: string | undefined;
  const now = Math.floor(Date.now() / 1000);
  if (req.request) {
    const q = decodeRepRequest(ctx, req.request);
    if (Number(q.expiry) < now) throw new CodeError('That reputation request has expired; ask the verifier for a new one.');
    if (!isOnLadder(q, d)) throw new CodeError('That reputation request asks for thresholds off the public ladder; ask the verifier for a new one.');
    audience = q.audience; nonce = q.nonce; expiry = q.expiry; asked = thresholdsOf(q);
    if (q.bindTo !== 0n) { bindTo = q.bindTo; binding = 'request'; }
  } else {
    if (!req.audience) throw new Error('give the verifier\'s request code (request) or its audience name (audience)');
    audience = audienceOf(req.audience);
    // the verifier's own challenge when it gave one out of band (it then checks with { audience, nonce }); else a fresh one
    nonce = req.nonce === undefined ? randomNonce() : nonceOf(req.nonce);
    challenge = req.nonce === undefined ? 'prover-chosen' : 'verifier';
    const ttl = req.expiresInSec ?? REP_DEFAULT_TTL_SEC;
    if (!(ttl > 0) || ttl > REP_MAX_TTL_SEC) throw new Error(`expiresInSec must be 1..${REP_MAX_TTL_SEC}`);
    expiry = BigInt(now + ttl);
    const want = requirementOf(req, d);
    assertRequirementRange(want);
    asked = snapRequirement(want, d);
    if (thresholdsKey(asked) !== thresholdsKey(want)) snappedNote = 'thresholds were rounded DOWN to the public ladder; the code states the rounded values';
  }
  let session: Uint8Array | undefined;
  if (binding !== 'request') {
    if (req.bindTo) {
      try { bindTo = fieldOf(new PublicKey(req.bindTo)); } catch { throw new Error('bindTo must be a base58 Solana public key'); }
      binding = 'given-key';
    } else {
      session = ed25519.utils.randomPrivateKey();
      bindTo = fieldOf(ed25519.getPublicKey(session));
    }
  }

  const { events, tree, version } = await leaves(env);
  const assetF = fieldOf(env.config.usdgMint);
  const maxKey = Math.max(-1, ...env.loanKeys());
  const mine = myRepLoans(events, env.accountSk, { maxKey, gap: REP_GAP_LIMIT, assetF });
  env.rememberLoanKeys([...new Set(mine.map((l) => l.keyIndex))]);
  let chosen;
  try { chosen = selectLoans(mine, asked); } catch (e) {
    if (e instanceof ReputationUnreachable) {
      const h = e.have;
      throw new Error(`${e.message}. Attested so far: ${h.loans} loans, ${fromUnits(h.volume, d)} volume, ${h.lenders} lenders, ${h.spanDays} days, ${h.months} periods. Nothing was proven.`);
    }
    throw e;
  }
  const { input, publicSignals } = reputationInput({ masterSk: env.accountSk, loans: chosen, tree, req: asked, assetF, audience, nonce, expiry, bindTo });
  // a session key is fresh per proof and says nothing; a key from the request or the caller is capped like an audience
  checkProbeCap(env, publicSignals.presNullifier, asked, binding === 'session-key' ? undefined : bindTo);
  env.log(`proving reputation over ${chosen.length} loans (about 3-15 s)`);
  const result = await env.prover.prove('reputation', input as never);
  const vkey = vkeyOf(env);
  if (!(await snarkjs.groth16.verify(vkey as never, result.raw.publicSignals, result.raw.proof as never))) throw new Error('the reputation proof did not verify locally; the proving artifacts may be corrupt. Nothing was handed out.');
  const code = encodeRepCode(ctx, {
    treeVersion: version, proof: encodeProof(result.proof), repRoot: publicSignals.repRoot, presNullifier: publicSignals.presNullifier,
    audience, nonce, expiry, bindTo, ...thresholdsOf(asked),
  });
  const presentation = session
    ? encodeRepSig(ctx, { pub: ed25519.getPublicKey(session), sig: ed25519.sign(repPresentationMessage(audience, nonce, publicSignals.presNullifier), session) })
    : undefined;
  return {
    code, ...(presentation ? { presentation } : {}), audience: hex(audience), nonce: hex(nonce), challenge, presNullifier: hex(publicSignals.presNullifier), expiresAt: Number(expiry), thresholds: repView(asked, d),
    counted: { loans: chosen.length }, binding, setup: setupLabel(env), statement: REP_STATEMENT_NOTE,
    ...(snappedNote ? { snapped: snappedNote } : {}),
    next: (presentation
      ? 'give the verifier the code, and the presentation (h081-rep-sig:) only when you present it, over the channel the verifier knows you by; whoever holds both can present it until it expires'
      : 'give the verifier the code; it is bound to the key in the request (or bindTo), so only that key\'s holder can use it')
      + (challenge === 'prover-chosen'
        ? '. The nonce was drawn here, not by the verifier: it proves no freshness (only the expiry and the verifier\'s list of accepted nonces stop a replay), and the verifier must check the thresholds itself; a verifier that needs a live answer sends a request code'
        : ''),
  };
}

/** A challenge given as 0x hex or decimal: nonzero and below 2^248 (what a request's random nonce is). */
function nonceOf(s: string): bigint {
  let n: bigint;
  try { n = BigInt(s); } catch { throw new Error('nonce must be a number (0x hex or decimal)'); }
  if (n <= 0n || n >= 1n << 248n) throw new Error('nonce must be between 1 and 2^248 - 1');
  return n;
}

// ---- verify (verifier side)

/**
 * opts: the request code you issued, or `audience` + `nonce` (the nonce you gave the prover, or, when the prover drew
 * it, the one it handed you: that proves no freshness, only the expiry plus your own record of accepted nonces). On the
 * `audience` path the thresholds you require (`minLoans`, `minVolume`, ...) are checked when given: without them any
 * claim the prover chose passes, and `thresholds` in the result is what you must compare yourself.
 */
export async function verifyReputation(env: RepEnv, code: string, opts: ThresholdArgs & { request?: string; audience?: string; nonce?: string; presentation?: string; allowBearer?: boolean; onChain?: boolean; now?: number } = {}): Promise<VerifyReputationResult> {
  const d = env.config.decimals, ctx = repContext(env);
  const base = { lowerBoundOnly: true as const, statement: REP_STATEMENT_NOTE, setup: setupLabel(env) };
  const fail = (reason: string, extra: Partial<VerifyReputationResult> = {}): VerifyReputationResult => ({ ok: false, reason, ...base, ...extra });
  let c: RepCode;
  try { c = decodeRepCode(ctx, code); } catch (e) { return fail((e as Error).message); }
  const view = { thresholds: repView(c, d), asset: env.config.usdgMint.toBase58(), presNullifier: hex(c.presNullifier), audience: hex(c.audience), expiresAt: Number(c.expiry) };
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  // 1. the code answers this verifier's challenge
  let requestBind = 0n;
  if (opts.request) {
    if (REP_THRESHOLD_KEYS.some((k) => opts[k] !== undefined)) return fail('a request code carries the thresholds it asks for; do not add any next to it', view);
    let q;
    try { q = decodeRepRequest(ctx, opts.request); } catch (e) { return fail(`the request: ${(e as Error).message}`, view); }
    if (c.audience !== q.audience) return fail('the code was made for another audience', view);
    if (c.nonce !== q.nonce) return fail('the code answers another challenge (nonce)', view);
    const short = (['minLoans', 'minVolume', 'minLenders', 'minSpanDays', 'minMonths'] as const).filter((k) => c[k] < q[k]);
    if (short.length) return fail(`the code proves less than the request asks (${short.join(', ')})`, view);
    if (q.minMonths > 0 && c.monthFloor < q.monthFloor) return fail('the code counts periods with a lower per-loan floor than the request asks', view);
    requestBind = q.bindTo;
  } else {
    if (!opts.audience) return fail('give the request code you issued (request), or your audience name and the nonce (audience, nonce)', view);
    if (c.audience !== audienceOf(opts.audience)) return fail('the code was made for another audience', view);
    if (!opts.nonce) return fail('give the nonce: the one you gave the prover, or the one it handed you with the code (a nonce the prover drew proves no freshness: only the expiry and your list of accepted nonces stop a replay; a request code gives a live challenge)', view);
    let n: bigint;
    try { n = BigInt(opts.nonce); } catch { return fail('the nonce must be a number (0x hex or decimal)', view); }
    if (c.nonce !== n) return fail('the code answers another challenge (nonce)', view);
    // the thresholds this verifier requires, when it states them (without a request nothing else does)
    let want: RepRequirement;
    try { want = requirementOf(opts, d); } catch (e) { return fail((e as Error).message, view); }
    if (opts.minLoans === undefined) want.minLoans = 0;
    const short = (['minLoans', 'minVolume', 'minLenders', 'minSpanDays', 'minMonths'] as const).filter((k) => c[k] < want[k]);
    if (short.length) return fail(`the code proves less than you ask (${short.join(', ')})`, view);
    if (want.minMonths > 0 && c.monthFloor < want.monthFloor) return fail('the code counts periods with a lower per-loan floor than you ask', view);
  }
  // 2. who may present it
  let presenter: VerifyReputationResult['presenter'];
  if (requestBind !== 0n) {
    if (c.bindTo !== requestBind) return fail('the code is bound to another key than the request names', view);
    presenter = 'request-binding';
  } else if (c.bindTo !== 0n) {
    if (!opts.presentation) return fail('the code is bound to a session key: the presenter must also give its signature (an "h081-rep-sig:" code)', view);
    let s;
    try { s = decodeRepSig(ctx, opts.presentation); } catch (e) { return fail(`the presentation: ${(e as Error).message}`, view); }
    if (fieldOf(s.pub) !== c.bindTo) return fail('the presentation is signed by another key than the one the code is bound to', view);
    let good = false;
    try { good = ed25519.verify(s.sig, repPresentationMessage(c.audience, c.nonce, c.presNullifier), s.pub); } catch { good = false; }
    if (!good) return fail('the presentation signature does not verify', view);
    presenter = 'signed-session-key';
  } else {
    if (!opts.allowBearer) return fail('the code is not bound to any key (a bearer code anyone who saw it could replay); refused unless allowBearer', view);
    presenter = 'bearer';
  }
  // 3. time
  if (Number(c.expiry) < now) return fail('the code has expired', view);
  if (Number(c.expiry) > now + REP_MAX_TTL_SEC) return fail('the code claims to stay valid for more than a day', view);
  // 4. the root is one the chain had recently
  const program = programOf(env);
  const tree = await fetchRepTree(env.connection, program, c.treeVersion);
  if (!tree) return fail(`reputation tree ${c.treeVersion} does not exist on ${env.config.cluster}`, view);
  if (!isKnownRepRootIn(tree, c.repRoot)) return fail('the code was made on a reputation root this chain does not know (or one too old)', view);
  // 5. Groth16
  const pub: RepPublic = {
    repRoot: c.repRoot, asset: fieldOf(env.config.usdgMint), minLoans: BigInt(c.minLoans), minVolume: c.minVolume, minLenders: BigInt(c.minLenders),
    minSpanDays: BigInt(c.minSpanDays), minMonths: BigInt(c.minMonths), monthFloor: c.monthFloor, audience: c.audience, nonce: c.nonce,
    expiry: c.expiry, bindTo: c.bindTo, presNullifier: c.presNullifier,
  };
  let vkey: unknown;
  try { vkey = vkeyOf(env); } catch (e) { return fail((e as Error).message, view); }
  const ok = await snarkjs.groth16.verify(vkey as never, repPublicList(pub).map(String), proofJson(c.proof) as never).catch(() => false);
  if (!ok) return fail('the proof does not verify', view);
  let onChain: VerifyReputationResult['onChain'];
  if (opts.onChain) onChain = await simulateOnChain(env, c, pub);
  // a simulation that could not run is not a refusal: say which one it was
  const why = onChain && !onChain.ok ? (onChain.ran === false ? `the on-chain check could not run: ${onChain.error}` : `verify_reputation refused it: ${onChain.error}`) : undefined;
  return { ok: !onChain || onChain.ok, ...(why ? { reason: why } : {}), ...view, presenter, ...(onChain ? { onChain } : {}), ...base };
}

/** The 256-byte program encoding back to snarkjs JSON (a is stored negated). */
function proofJson(b: Uint8Array) {
  const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
  const f = (o: number) => fromBe(b.subarray(o, o + 32));
  const ay = f(32);
  return {
    pi_a: [f(0).toString(), (ay === 0n ? 0n : Q - ay).toString(), '1'],
    pi_b: [[f(96).toString(), f(64).toString()], [f(160).toString(), f(128).toString()], ['1', '0']],
    pi_c: [f(192).toString(), f(224).toString(), '1'], protocol: 'groth16', curve: 'bn128',
  };
}

/** Simulates verify_reputation (read-only: nothing is signed or sent). */
async function simulateOnChain(env: RepEnv, c: RepCode, pub: RepPublic): Promise<NonNullable<VerifyReputationResult['onChain']>> {
  // Only an error raised while an instruction ran is the program's answer. Everything else says nothing about the proof
  // and is "could not run": a fee payer that cannot pay (a fresh verifier wallet comes back AccountNotFound, one with
  // dust InsufficientFundsForFee), a transaction the cluster rejects before executing it, or an RPC that fails.
  const couldNot = (why: string, then = 'Retry') => ({ ok: false, ran: false as const, error: `${why}; the proof passed every off-chain check. ${then}, or verify without onChain` });
  const who = `this wallet (${env.signer.publicKey.toBase58()}), the fee payer of the read-only simulation,`;
  let msg;
  try {
    const { blockhash } = await env.connection.getLatestBlockhash('confirmed');
    msg = new TransactionMessage({
      payerKey: env.signer.publicKey, recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), verifyReputationIx(c.proof, pub, programOf(env), c.treeVersion)],
    }).compileToV0Message();
    let fee = 5000;
    try { fee = (await env.connection.getFeeForMessage(msg, 'confirmed')).value ?? fee; } catch { /* the usual one-signature fee */ }
    const balance = await env.connection.getBalance(env.signer.publicKey, 'confirmed');
    if (balance < fee) {
      return couldNot(`${who} has ${balance === 0 ? 'no SOL' : `${balance} lamports`} on ${env.config.cluster}, less than the ${fee}-lamport fee`, `Fund it with at least ${fee} lamports`);
    }
  } catch (e) { return couldNot(`the RPC failed before the simulation (${(e as Error).message})`); }
  let sim;
  try {
    sim = await env.connection.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
  } catch (e) { return couldNot(`the RPC failed during the simulation (${(e as Error).message})`); }
  const err = sim.value.err;
  if (!err) return { ok: true, computeUnits: sim.value.unitsConsumed };
  if (!(typeof err === 'object' && 'InstructionError' in err)) return couldNot(`the cluster rejected the transaction before the program ran (${typeof err === 'string' ? err : JSON.stringify(err)})`);
  const m = /custom program error: 0x([0-9a-f]+)/i.exec((sim.value.logs ?? []).join('\n'));
  return { ok: false, computeUnits: sim.value.unitsConsumed, error: m ? REP_ERROR_NAME[parseInt(m[1], 16)] ?? m[0] : JSON.stringify(err) };
}

// ---- status and attest (borrower side)

interface MySlot { loanRef: bigint; principal: bigint; repaid: bigint; funded: boolean; pledgeBps: bigint; agentPk: bigint; keyIndex?: number; legacy: boolean }

/** Live stream_loan slots whose agent key is one of this account's loan keys or legacy sub-accounts (matched locally). */
async function mySlots(env: RepEnv): Promise<{ slots: MySlot[]; scanned: boolean }> {
  const loanProgram = env.config.loanProgramId;
  let accts: Awaited<ReturnType<Connection['getProgramAccounts']>>;
  try {
    accts = await env.connection.getProgramAccounts(loanProgram, { commitment: 'confirmed', filters: [{ dataSize: 253 }] });
  } catch (e) {
    env.log(`could not list loan slots (${(e as Error).message}); pending and legacy counts are unknown`);
    return { slots: [], scanned: false };
  }
  const maxKey = Math.max(-1, ...env.loanKeys());
  const pks = new Map<bigint, number>();
  for (let k = 0; k <= maxKey + REP_GAP_LIMIT; k++) pks.set(loanPk(env.accountSk, k), k);
  const legacy = new Set(env.legacyAgentPks());
  const out: MySlot[] = [];
  for (const a of accts) {
    let s;
    try { s = decodeSlot(a.account.data); } catch { continue; }
    if (!slotPda(s.loanRef, loanProgram).equals(a.pubkey)) continue;
    const k = pks.get(s.agentPk);
    const base = { loanRef: s.loanRef, principal: s.principal, repaid: s.repaid, funded: s.funded, pledgeBps: s.pledgeBps, agentPk: s.agentPk };
    if (k !== undefined) out.push({ ...base, keyIndex: k, legacy: false });
    else if (legacy.has(s.agentPk)) out.push({ ...base, legacy: true });
  }
  env.rememberLoanKeys(out.filter((s) => s.keyIndex !== undefined).map((s) => s.keyIndex!));
  return { slots: out, scanned: true };
}

type NeverReason = RepBlock | 'too_small';
const NEVER_NOTE: Record<NeverReason, string> = { ...REP_BLOCK_NOTE, too_small: 'the principal is below the 1 USDG minimum that counts' };

/** Why a repaid loan can never be attested (rep_registry would refuse it), or undefined. */
async function neverCounts(env: RepEnv, x: MySlot): Promise<NeverReason | undefined> {
  const block = await repBlockOf(env.connection, x, env.config.loanProgramId);
  if (block) return block;
  return x.principal < REP_MIN_PRINCIPAL ? 'too_small' : undefined;
}

export async function reputationStatus(env: RepEnv): Promise<ReputationStatus> {
  const d = env.config.decimals, program = programOf(env);
  const { events } = await leaves(env);
  const mine = myRepLoans(events, env.accountSk, { maxKey: Math.max(-1, ...env.loanKeys()), gap: REP_GAP_LIMIT, assetF: fieldOf(env.config.usdgMint) });
  const s = statsOf(mine);
  const { slots, scanned } = await mySlots(env);
  const pending: ReputationStatus['pending'] = [], never: ReputationStatus['never'] = [];
  for (const x of slots) {
    if (x.legacy || !x.funded || x.repaid < x.principal) continue;
    if (await isAttested(env.connection, x.loanRef, program)) continue;
    // repaid but refused by rep_registry for good: backed (a backer's fee, not a slash), slashed, or below the minimum
    const why = await neverCounts(env, x);
    if (why) never.push({ loanRef: x.loanRef.toString(), principal: fromUnits(x.principal, d), reason: why });
    else pending.push({ loanRef: x.loanRef.toString(), principal: fromUnits(x.principal, d) });
  }
  const legacy = slots.filter((x) => x.legacy && x.funded).length;
  const warnings: string[] = [];
  if (legacy > 0) warnings.push(`${legacy} loan(s) were taken under legacy sub-account keys (agentIndex 0..15): they can never count toward reputation. Borrow without agentIndex (this package version uses fresh loan keys) so future loans count.`);
  if (!scanned) warnings.push('the RPC would not list loan slots (getProgramAccounts): pending and legacy counts are unknown; use a private RPC.');
  if (never.length) warnings.push(`${never.length} repaid loan(s) can never count: ${[...new Set(never.map((x) => x.reason))].map((r) => `${r} (${NEVER_NOTE[r]})`).join('; ')}.`);
  if (pending.length) warnings.push(`${pending.length} repaid loan(s) are not attested yet: h081_reputation_attest asks the relayer to attest them (never from your wallet, which would link them to you). A lender that closes a loan before it is attested erases it for good.`);
  warnings.push('loans whose principal was paid to this wallet\'s public token account are linked to this wallet on chain by their payout_to; a verifier who knows the wallet can estimate your record without the proof. Never use this wallet as bindTo.');
  return {
    attested: { count: s.loans, volume: fromUnits(s.volume, d), lenders: s.lenders, spanDays: s.spanDays, months: s.months },
    pending, never, legacy, loanKeys: env.loanKeys().length, warnings, statement: REP_STATEMENT_NOTE, setup: setupLabel(env),
  };
}

export interface RepAttestPlan { sent: false; dryRun: true; plan: { action: 'attest'; loans: string[]; via: string; note: string }; next: string }
export interface RepAttestResult {
  sent: true;
  /** handed to the relayer's queue: its next sweep attests them together with every other repaid loan */
  queued: string[];
  /** attested now (selfSign, or a relayer that still attests on request) */
  attested: string[];
  failed: Array<{ loanRef: string; error: string }>; via: string; signatures: string[]; note?: string;
}

/**
 * Asks for this account's repaid, unattested loans to be attested. Via the relayer by default: it queues them and its
 * sweep attests them with every other repaid loan, signing and paying itself (your wallet never appears, and the attests
 * are not timed by your request). `selfSign: true` sends from this wallet now instead and links each loan to it on chain.
 */
export async function reputationAttest(env: RepEnv, opts: { confirm?: boolean; selfSign?: boolean; loanRefs?: bigint[] } = {}): Promise<RepAttestPlan | RepAttestResult> {
  const program = programOf(env);
  let refs = opts.loanRefs;
  if (!refs) {
    const { slots } = await mySlots(env);
    refs = [];
    for (const x of slots) {
      if (x.legacy || !x.funded || x.repaid < x.principal || (await isAttested(env.connection, x.loanRef, program))) continue;
      if (!(await neverCounts(env, x))) refs.push(x.loanRef); // backed, slashed or tiny: rep_registry refuses it; never asked for
    }
  }
  const via = opts.selfSign
    ? 'this wallet (links each loan to it on chain)'
    : env.relayerUrl ? "the relayer's queue (its next sweep attests them with every other repaid loan; it signs and pays; your wallet does not appear)" : 'none';
  if (!opts.selfSign && !env.relayerUrl) throw new Error('no relayer is configured, and attesting from this wallet would link each loan to it on chain. Configure H081_RELAYER_URL, ask the lender to close the loan (it attests first), or pass selfSign: true to accept the link. Nothing was sent.');
  if (!opts.confirm) {
    return {
      sent: false, dryRun: true,
      plan: { action: 'attest', loans: refs.map(String), via, note: refs.length ? 'each repaid loan gets one leaf in the reputation tree, once' : 'nothing to attest: no repaid, unattested loan under this account\'s loan keys' },
      next: 'nothing was sent. Call again with confirm: true to attest.',
    };
  }
  const queued: string[] = [], attested: string[] = [], failed: RepAttestResult['failed'] = [], signatures: string[] = [];
  // random order: the order of the requests says nothing about the order the loans were taken in
  const order = [...refs];
  for (let i = order.length - 1; i > 0; i--) { const j = randomInt(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
  for (const ref of order) {
    try {
      if (opts.selfSign) {
        const { sendLegacy } = await import('../../src/solana/send.js');
        signatures.push(await sendLegacy(env.connection, env.signer, [env.signer], [attestIx(env.signer.publicKey, ref, { rep: program, loan: env.config.loanProgramId })]));
      } else {
        const res = await env.fetch(`${env.relayerUrl!.replace(/\/$/, '')}/v1/rep/attest`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loanRef: ref.toString() }), signal: AbortSignal.timeout(60_000),
        });
        const body = (await res.json().catch(() => ({}))) as { signature?: string; queued?: boolean; error?: string | { message?: string } };
        if (!res.ok) throw new Error((typeof body.error === 'object' ? body.error?.message : body.error) ?? `relayer answered HTTP ${res.status}`);
        if (body.queued) { queued.push(ref.toString()); continue; }
        if (body.signature) signatures.push(body.signature);
      }
      attested.push(ref.toString());
    } catch (e) { failed.push({ loanRef: ref.toString(), error: (e as Error).message }); }
  }
  return {
    sent: true, queued, attested, failed, via, signatures,
    ...(queued.length ? { note: "queued loans are attested by the relayer's next sweep (h081_reputation_status shows them as pending until then); a lender closing one first still erases it" } : {}),
  };
}
