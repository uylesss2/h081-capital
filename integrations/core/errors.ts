// Readable program errors. A failed Solana transaction surfaces as "custom program error: 0x1795" (in a
// simulation's logs, a SendTransactionError, or the "{"Custom":6037}" of a confirmed failure); this maps the
// code back to the Anchor variant name of the program that failed and a sentence an agent can act on.
import { SendTransactionError } from '@solana/web3.js';
import { RelayerError } from '../../src/relayer-client.js';
import { POOL_ERROR } from '../../src/solana/program.js';
import { LOAN_ERROR } from '../../src/solana/lender.js';
import { CAPACITY_ERROR, SAFETY_ERROR } from '../../src/solana/token.js';
import { SimulationError } from '../../src/solana/send.js';

export type ProgramKind = 'pool' | 'loan' | 'capacity' | 'safety';

const invert = (t: Record<string, number>): Map<number, string> => new Map(Object.entries(t).map(([k, v]) => [v, k]));
export const ERROR_NAMES: Record<ProgramKind, Map<number, string>> = {
  pool: invert(POOL_ERROR), loan: invert(LOAN_ERROR), capacity: invert(CAPACITY_ERROR), safety: invert(SAFETY_ERROR),
};

/** What to do about the errors an agent is likely to hit. */
export const ERROR_TEXT: Record<ProgramKind, Partial<Record<number, string>>> = {
  pool: {
    [POOL_ERROR.DepositsPaused]: 'new deposits are paused by the config authority; withdrawals still work',
    [POOL_ERROR.DepositTooLarge]: 'the deposit is over the per-deposit cap (1,000 USDG on mainnet)',
    [POOL_ERROR.DepositCapExceeded]: 'the bank holds at most 10,000 USDG in total on mainnet and this deposit would exceed it',
    [POOL_ERROR.DepositShortfall]: "the signer's USDG token account holds less than the deposit",
    [POOL_ERROR.UnknownRoot]: 'the proof was made against a Merkle root the pool no longer remembers; sync and try again',
    [POOL_ERROR.AlreadySpent]: 'a note in this operation was already spent (a concurrent operation from the same account?)',
    [POOL_ERROR.StaleTimestamp]: 'the proof timestamp is stale; try again',
    [POOL_ERROR.Recipient]: 'the recipient must be a wallet address (payouts go to its associated token account)',
    [POOL_ERROR.InvalidProof]: 'the program rejected the proof (wrong proving key? run fetch-circuits to refresh the artifacts)',
    [POOL_ERROR.FeeExceedsAmount]: 'the relay fee is larger than the amount',
    [POOL_ERROR.WrongMint]: 'the token account is for another mint',
    [POOL_ERROR.Lender]: 'the lender account does not match the pledge',
  },
  loan: {
    [LOAN_ERROR.AlreadyFunded]: 'this loan slot is already funded',
    [LOAN_ERROR.NotTheLender]: 'only the slot owner (the lender) may do this',
    [LOAN_ERROR.NoLoan]: 'this slot has no funded loan',
    [LOAN_ERROR.PayoutNotProven]: 'the stream proof audience is not the payout account',
    [LOAN_ERROR.PrincipalTooLarge]: 'the principal is more than the pledged share of the proven stream can repay',
    [LOAN_ERROR.BadTreasury]: 'the fee treasury account is wrong (it must be the treasury owner\'s token account)',
    [LOAN_ERROR.StreamNotStarted]: 'the pledged stream has not started yet',
  },
  capacity: {
    [CAPACITY_ERROR.StakingPaused]: 'staking is paused by the config authority; unstaking still works',
    [CAPACITY_ERROR.StakeCap]: 'over a staking cap (100,000 H081 per stake, 1,000,000 H081 total on mainnet)',
    [CAPACITY_ERROR.MoreThanStaked]: 'you asked to unstake more than is staked',
    [CAPACITY_ERROR.NothingPending]: 'nothing is waiting to unstake; call request_unstake first',
    [CAPACITY_ERROR.Cooldown]: 'the 30-day cooldown has not passed yet',
    [CAPACITY_ERROR.Amount]: 'the amount must be positive',
  },
  safety: {
    [SAFETY_ERROR.DepositsPaused]: 'safety pool deposits are paused',
    [SAFETY_ERROR.DepositCap]: 'over a safety pool deposit cap',
    [SAFETY_ERROR.Cooldown]: 'the 14-day cooldown has not passed yet',
  },
};

/** The Anchor custom error code in an error's message or logs, if any. */
export function programErrorCode(e: unknown): number | undefined {
  const text = errorText(e);
  const m = /custom program error: 0x([0-9a-fA-F]+)/.exec(text);
  if (m) return parseInt(m[1], 16);
  const n = /Error Number: (\d+)/.exec(text) ?? /"Custom":\s*(\d+)/.exec(text);
  return n ? parseInt(n[1], 10) : undefined;
}

/** Message plus logs of a failed transaction (SimulationError, SendTransactionError, or anything with `.logs`). */
export function errorText(e: unknown): string {
  if (e instanceof SimulationError) return `${e.message}\n${e.logs.join('\n')}`;
  if (e instanceof SendTransactionError) return `${e.message}\n${(e.logs ?? []).join('\n')}`;
  const o = e as { message?: unknown; logs?: unknown };
  if (o && typeof o === 'object') {
    const logs = Array.isArray(o.logs) ? (o.logs as unknown[]).map(String).join('\n') : '';
    return `${o.message !== undefined ? String(o.message) : String(e)}\n${logs}`;
  }
  return String(e);
}

/** Which known program failed, from the "Program <id> failed" log line, when `ids` is given. */
export function programOf(e: unknown, ids: Partial<Record<ProgramKind, string>>): ProgramKind | undefined {
  const text = errorText(e);
  const failed = [...text.matchAll(/Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed/g)].map((m) => m[1]);
  for (const id of failed.reverse()) {
    for (const [kind, known] of Object.entries(ids) as Array<[ProgramKind, string | undefined]>) if (known && known === id) return kind;
  }
  return undefined;
}

export interface ExplainOptions {
  /** the program the caller was talking to (used when the logs do not name one) */
  program?: ProgramKind;
  /** program ids, to recognize which one failed from the logs */
  ids?: Partial<Record<ProgramKind, string>>;
}

/**
 * A one-line explanation: "DepositCapExceeded (6037, stipend_pool): the bank holds at most 10,000 USDG…".
 * Relayer refusals pass through with their stable code; anything else is the original message.
 */
export function explainProgramError(e: unknown, opts: ExplainOptions = {}): string {
  if (e instanceof RelayerError) return `the relayer refused it (${e.status} ${e.code}): ${e.message.replace(/^relayer \d+ \S+: /, '')}`;
  const code = programErrorCode(e);
  if (code === undefined) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/expired before it was confirmed/.test(msg)) return `${msg} (the network dropped the transaction; nothing was spent)`;
    return msg;
  }
  const kind = (opts.ids && programOf(e, opts.ids)) ?? opts.program;
  const label = { pool: 'stipend_pool', loan: 'stream_loan', capacity: 'capacity_stake', safety: 'safety_pool' };
  if (kind) {
    const name = ERROR_NAMES[kind].get(code);
    if (name) {
      const text = ERROR_TEXT[kind][code];
      return `${name} (${code}, ${label[kind]})${text ? `: ${text}` : ''}`;
    }
  }
  // not an Anchor error of a known program (a token program error, or a code outside the tables)
  const guesses = (['pool', 'loan', 'capacity'] as ProgramKind[]).filter((k) => ERROR_NAMES[k].has(code) && (!kind || k === kind)).map((k) => `${ERROR_NAMES[k].get(code)} (${label[k]})`);
  return `program error ${code}${guesses.length ? `: ${guesses.join(' or ')}` : ''}`;
}

/** An error whose message is the explanation; `cause` keeps the original. */
export class H081Error extends Error {
  readonly code?: number;
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'H081Error';
    this.code = programErrorCode(cause);
  }
}

/** Rethrows `e` explained. */
export function explained(e: unknown, opts: ExplainOptions = {}): H081Error {
  if (e instanceof H081Error) return e;
  return new H081Error(explainProgramError(e, opts), e);
}

// ------------------------------------------------------------------ stable error codes (the local API, the CLI, MCP)

/** A stable code, its HTTP status, and whether the same call may simply be tried again later. */
export interface ErrorCodeInfo { status: number; retryable: boolean; description: string }

export const ERROR_CODES = {
  unauthorized: { status: 401, retryable: false, description: 'missing or wrong bearer token' },
  forbidden_origin: { status: 403, retryable: false, description: 'the Host or Origin header is not allowed (the gateway answers 127.0.0.1 and localhost only)' },
  not_found: { status: 404, retryable: false, description: 'no such route' },
  bad_request: { status: 400, retryable: false, description: 'the request body or query is invalid; the message says which field' },
  unsupported_media_type: { status: 415, retryable: false, description: 'a POST body must be Content-Type: application/json' },
  idempotency_key_required: { status: 400, retryable: false, description: 'a confirmed write needs an Idempotency-Key header (1-128 of A-Z a-z 0-9 _ . : -)' },
  idempotency_key_reused: { status: 422, retryable: false, description: 'this Idempotency-Key was used for a different request' },
  in_progress: { status: 409, retryable: true, description: 'a request with this Idempotency-Key is still running' },
  outcome_unknown: { status: 409, retryable: false, description: 'the gateway stopped while this request was running; check /v1/balance before retrying with a new key' },
  invalid_code: { status: 400, retryable: false, description: 'an h081-* code failed its checksum, kind or network check' },
  insufficient_shielded: { status: 409, retryable: false, description: 'the shielded balance is too low' },
  insufficient_wallet_usdg: { status: 409, retryable: false, description: 'the agent wallet holds too little USDG' },
  needs_sol: { status: 409, retryable: false, description: 'the agent wallet needs more SOL (details.needSol)' },
  cap_per_deposit: { status: 409, retryable: false, description: 'over the per-deposit cap' },
  cap_total: { status: 409, retryable: false, description: 'the bank is at its total deposit cap' },
  deposits_paused: { status: 409, retryable: false, description: 'deposits are paused; withdrawals still work' },
  over_operator_ceiling: { status: 409, retryable: false, description: 'over an H081_MAX_* ceiling set on this machine' },
  needs_stake: { status: 409, retryable: false, description: 'above what the relayer relays with nothing staked; stake H081 or split the amount' },
  allowance_blocked: { status: 409, retryable: false, description: 'no allowance can pay this amount now (the message names the cap)' },
  relayer_unavailable: { status: 503, retryable: true, description: 'the relayer is unreachable or refused; nothing was sent (reason in details)' },
  relayer_busy: { status: 503, retryable: true, description: 'the relayer is busy; nothing was sent' },
  rate_limited: { status: 429, retryable: true, description: 'too many requests (relayer 429, or the local send limit); see Retry-After' },
  busy: { status: 503, retryable: true, description: 'the local queue is full; see Retry-After' },
  stale_root: { status: 409, retryable: true, description: 'the proof used a Merkle root or timestamp that is no longer current; try again' },
  in_flight: { status: 409, retryable: true, description: 'a note in this operation is already being spent; try again shortly' },
  already_spent: { status: 409, retryable: false, description: 'a note in this operation was already spent' },
  simulation_failed: { status: 422, retryable: false, description: 'the transaction failed in simulation; nothing was sent' },
  program_error: { status: 422, retryable: false, description: 'an on-chain program refused it (Anchor name in details)' },
  rpc_unreachable: { status: 502, retryable: true, description: 'the Solana RPC cannot be reached; set H081_RPC_URL' },
  circuits_missing: { status: 503, retryable: false, description: 'the proving files are missing; run h081 fetch-circuits' },
  circuit_hash_mismatch: { status: 503, retryable: false, description: 'a proving file does not match its pinned sha256' },
  not_available: { status: 501, retryable: false, description: 'not available in this version' },
  no_key: { status: 500, retryable: false, description: 'no agent key; run h081 init' },
  internal: { status: 500, retryable: false, description: 'an unexpected error' },
} as const satisfies Record<string, ErrorCodeInfo>;

export type ErrorCode = keyof typeof ERROR_CODES;

/** An error with a stable code (the gateway and the CLI throw these; `classify` keeps them as they are). */
export class CodedError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly details?: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CodedError';
  }
}

/** The RPC could not be reached at all (fetch failed, refused, DNS). Only the host is ever named. */
export class RpcUnreachableError extends CodedError {
  constructor(host: string, cause: string, options?: { cause?: unknown }) {
    super('rpc_unreachable', `cannot reach the Solana RPC at ${host}: ${cause}. Set H081_RPC_URL.`, { host }, options);
    this.name = 'RpcUnreachableError';
  }
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

/** Why a request failed at the network level (undefined: it reached a server). */
export function networkFailure(e: unknown): string | undefined {
  for (let x: unknown = e, i = 0; x && i < 6; x = (x as { cause?: unknown }).cause, i++) {
    const o = x as { code?: unknown; message?: unknown; errors?: unknown[] };
    if (typeof o.code === 'string' && NETWORK_CODES.has(o.code)) return o.code;
    if (Array.isArray(o.errors)) for (const sub of o.errors) { const c = (sub as { code?: unknown })?.code; if (typeof c === 'string' && NETWORK_CODES.has(c)) return c; }
    const m = typeof o.message === 'string' ? o.message : '';
    const known = /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH)\b/.exec(m);
    if (known) return known[1];
    if (/fetch failed|failed to fetch|getaddrinfo|socket hang up/i.test(m) && !(x as { cause?: unknown }).cause) return 'fetch failed';
  }
  return undefined;
}

export interface Classified {
  code: ErrorCode; status: number; retryable: boolean; message: string; details?: Record<string, unknown>;
}

const ANCHOR_CODE: Partial<Record<string, ErrorCode>> = {
  DepositsPaused: 'deposits_paused', DepositTooLarge: 'cap_per_deposit', DepositCapExceeded: 'cap_total', DepositShortfall: 'insufficient_wallet_usdg',
  AlreadySpent: 'already_spent', UnknownRoot: 'stale_root', StaleTimestamp: 'stale_root',
};

function relayerCode(e: RelayerError): { code: ErrorCode; details: Record<string, unknown> } {
  const details: Record<string, unknown> = { relayerStatus: e.status, reason: e.code };
  if (e.status === 503 && e.code === 'busy') return { code: 'relayer_busy', details };
  if (e.status === 429) return { code: 'rate_limited', details };
  if (e.status === 409) {
    if (e.code === 'in_flight') return { code: 'in_flight', details };
    if (e.code === 'already_spent') return { code: 'already_spent', details };
    return { code: 'stale_root', details }; // unknown_root, stale_timestamp
  }
  if (e.status === 422) return { code: 'simulation_failed', details };
  if (e.status === 403 && /capacity/.test(e.code)) return { code: 'needs_stake', details };
  return { code: 'relayer_unavailable', details };
}

const make = (code: ErrorCode, message: string, details?: Record<string, unknown>): Classified => ({
  code, status: ERROR_CODES[code].status, retryable: ERROR_CODES[code].retryable, message, ...(details ? { details } : {}),
});

const INPUT = /^(give |`?\w+`? must be|enter an amount|at most \d+ decimals|the amount must be positive|"\w+" must be|\w+ is required|\w+ \(the [a-z' ]+ "h081-[a-z-]+:" code\) is required|action must be one of|action "\w+" does not take|days and unlockDays|unlockDays must not|days must be|pledgeBps must|agentIndex must|allowanceId must|loanRef must|direct applies|windowLen must|H081_[A-Z_]+ must)/;

/**
 * The stable code of any error the bank, the relayer client, the RPC or the gateway throws: its HTTP status,
 * whether the same call may be retried, and a plain message. Walks `cause` chains (a refused relayer inside a
 * readable bank error keeps its code). Unknown errors are `internal`.
 */
export function classify(e: unknown): Classified {
  const top = e instanceof Error ? e.message : String(e);
  // typed errors anywhere in the cause chain first
  for (let x: unknown = e, i = 0; x && i < 6; x = (x as { cause?: unknown }).cause, i++) {
    if (x instanceof CodedError) return make(x.code, x === e ? x.message : top, x.details);
    if (x instanceof RelayerError) { const r = relayerCode(x); return make(r.code, top, r.details); }
    const o = x as { name?: unknown; reason?: unknown };
    if (o.name === 'RelayerUnavailableError') return make('relayer_unavailable', top, { reason: o.reason });
    if (o.name === 'CodeError') return make('invalid_code', top);
    if (o.name === 'InputError' || o.name === 'ZodError') return make('bad_request', top);
  }
  const net = networkFailure(e);
  if (net && !/relayer/i.test(top)) return make('rpc_unreachable', /cannot reach the Solana RPC/.test(top) ? top : `cannot reach the Solana RPC: ${net}. Set H081_RPC_URL.`);
  // an on-chain program error, as explainProgramError words it, or an Anchor code in the cause's logs
  const anchor = /^([A-Z][A-Za-z]+) \((\d+), (stipend_pool|stream_loan|capacity_stake|safety_pool)\)/.exec(top);
  if (anchor) return make(ANCHOR_CODE[anchor[1]] ?? 'program_error', top, { anchor: anchor[1], errorCode: Number(anchor[2]), program: anchor[3] });
  for (let x: unknown = e, i = 0; x && i < 6; x = (x as { cause?: unknown }).cause, i++) {
    const n = programErrorCode(x);
    if (n !== undefined) return make('program_error', top, { errorCode: n });
    if (x instanceof SimulationError) return make('simulation_failed', top);
  }
  // the bank's own refusals (made before anything is proven or sent)
  const m = top;
  if (/^DepositsPaused\b|deposits are paused/.test(m)) return make('deposits_paused', m);
  if (/^DepositTooLarge\b/.test(m)) return make('cap_per_deposit', m);
  if (/^DepositCapExceeded\b/.test(m)) return make('cap_total', m);
  if (/operator ceiling H081_MAX_/.test(m)) return make('over_operator_ceiling', m);
  const sol = /holds ([\d.]+) SOL; .*?needs about ([\d.]+) SOL/.exec(m);
  if (sol) return make('needs_sol', m, { haveSol: sol[1], needSol: sol[2] });
  if (/the shielded balance is .* less than/.test(m)) return make('insufficient_shielded', m);
  if (/the agent wallet \S+ holds .* less than/.test(m)) return make('insufficient_wallet_usdg', m);
  if (/[Ss]take more/.test(m) && /staked|free tier/.test(m)) return make('needs_stake', m);
  if (/proving artifacts are not in/.test(m)) return make('circuits_missing', m);
  if (/does not match the pinned|hash mismatch/.test(m)) return make('circuit_hash_mismatch', m);
  if (/^no allowance can pay|holds no \w+ allowance|no open allowance with id/.test(m)) return make('allowance_blocked', m);
  if (/^no agent key/.test(m)) return make('no_key', m);
  if (/^the relayer \S+ (is unreachable|does not|names|asks|serves)/.test(m)) return make('relayer_unavailable', m);
  if (INPUT.test(m)) return make('bad_request', m);
  return make('internal', m);
}
