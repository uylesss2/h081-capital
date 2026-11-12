// H081: the agent's private bank on this machine, as a TypeScript SDK. The CLI and the local HTTP gateway are thin
// layers over this class, and this class is a thin layer over runOp / H081Bank (integrations/core): the same checks,
// the same errors, the same chain code as the MCP server.
//
// Every method that sends anything returns a plan and sends nothing unless it is given `confirm: true`. A confirmed
// write goes through one queue (one proof and one send at a time) and an idempotency record in ops.jsonl, so a
// retried call with the same key never pays twice. Keys, notes and viewing keys never leave this process.
import { randomBytes } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { Account } from '../../../src/account.js';
import { initCrypto } from '../../../src/crypto.js';
import type { CircuitName } from '../../../src/prover.js';
import { H081Bank, type BalanceView, type RelayTerms } from '../../core/bank.js';
import { missingCircuits } from '../../core/circuits.js';
import {
  ADDRESS_PREFIX, type CodeContext, KEY_PREFIX, PROOF_PREFIX, TERMS_PREFIX, decodeAddressCode, decodeKeyCode, decodeLoanProof,
  decodeLoanTerms, encodeAddressCode,
} from '../../core/codes.js';
import { AGENT_CIRCUITS, MAINNET, type H081Config, configFromEnv, rpcHost } from '../../core/constants.js';
import { CodedError, classify, classifySend } from '../../core/errors.js';
import { accountSkFromEnv, describeKeySource, keySource, loadKeypair } from '../../core/keys.js';
import { openFromEnv } from '../../core/open.js';
import { type Args, type BankLike, plain, runOp, validateArgs } from '../../core/operations.js';
import type { OpName } from '../../core/schemas.js';
import { fromUnits, toUnits } from '../../core/units.js';
import { BalanceWatcher, EventHub, type Snapshot } from './events.js';
import { type HomePaths, effectiveEnv, ensureHome, homePaths } from './home.js';
import { IDEMPOTENCY_KEY, OpStore, bodyHash } from './idempotency.js';
import { SendLimiter } from './auth.js';

export const VERSION = '0.1.2';

/** SOL to keep in the agent wallet for each kind of use (fees, buffer rent that is mostly refunded, slot rent). */
export const FUNDING_NEEDED = { deposit: '0.05', withdraw: '0.05', allow: '0.15', lend: '0.15' } as const;

/** Download size of each circuit's files (MB, rounded). The agent set is about 98 MB in all. */
export const CIRCUIT_MB: Partial<Record<CircuitName, number>> = { transact: 15, grant: 51, spend: 19, stream: 12 };

/** The queue holds at most this many waiting writes; more get `busy`. */
export const QUEUE_MAX = 8;

/** A balance read is served from cache when it is younger than this. */
export const BALANCE_TTL_MS = 15_000;

/** What the agent needs from a bank: H081Bank, or a stub in tests. */
export type AgentBank = BankLike & {
  relayTerms?: () => Promise<RelayTerms | undefined>;
  connection?: { getSignatureStatuses: (sigs: string[], cfg?: { searchTransactionHistory?: boolean }) => Promise<{ value: Array<{ err: unknown; confirmationStatus?: string } | null> }> };
};

export interface OpenOptions {
  /** the data directory (default H081_HOME or ~/.h081) */
  home?: string;
  /** default process.env; config.json fills what it does not set */
  env?: NodeJS.ProcessEnv;
  cluster?: 'mainnet-beta' | 'localnet';
  /** log lines (stderr by default); never carries a key, a token or a full RPC URL */
  log?: (line: string) => void;
  /** tests: a bank (or a factory) instead of opening one against the RPC */
  bank?: AgentBank | (() => Promise<AgentBank>);
  /** tests: the agent key instead of loading it */
  signer?: Keypair;
  /** confirmed writes per minute (default H081_API_MAX_SENDS_PER_MIN or 30) */
  maxSendsPerMin?: number;
  /** base delay before the one retry of a busy or rate-limited relayer (ms; default 1000, jittered) */
  retryDelayMs?: number;
  /** event poll interval in seconds (default 20) */
  pollSeconds?: number;
}

export interface WriteOptions {
  /** true: send it. Default: return the plan and send nothing */
  confirm?: boolean;
  /** a retried call with the same key and body returns the first result instead of sending again (default: a new random key) */
  idempotencyKey?: string;
}

/** What a write would do, returned instead of sending when `confirm` is not true. */
export interface Plan {
  op: string;
  usdg?: string;
  to?: string;
  /** fee taken out of the amount (USDG) */
  fee: string;
  /** what the recipient gets (USDG), when there is one */
  payout?: string;
  /** SOL the agent wallet needs for this (fees, buffer rent) */
  solNeeded: string;
  circuit: string | null;
  /** what the first proof downloads, once */
  download: string;
  /** what the chain shows */
  publicOnChain: string[];
  /** who signs and sends the transaction */
  sentBy: 'relayer' | 'agent key';
  warnings: string[];
  /** the bank's own plan, for allowances and lending */
  details?: unknown;
  next: string;
}

export type Outcome = { status: 'plan'; result: Plan } | { status: 'sent'; result: unknown; replayed?: boolean; idempotencyKey: string } | { status: 'done'; result: unknown };

export interface FeeQuote { fee: string; feeBps: number; minFee: string; payout: string; freeTierMax: string; needsStake: boolean; relayer: string | null; createAccountFee?: string; note?: string }

export interface BalanceResult {
  shielded: string;
  wallet: { usdg: string; sol: string };
  caps: { perDeposit: string; total: string; inVault: string; paused: boolean } | null;
  allowances: Array<{ id: string; remaining: string; holder: string; agentIndex?: number; dailyCap?: string; maxPerTx?: string; expires?: string; reclaimable: boolean; pledged: boolean }>;
  addressCode: string;
  syncedAt: string;
}

export interface HistoryItem { id: string; time: string; kind: string; usdg?: string; signature?: string; state: string; to?: string; error?: string }

export interface CodeCheck { kind: string | null; network: string | null; valid: boolean; reason?: string }

const NEXT = 'Nothing was sent. Send it again with confirm: true (CLI: --yes) to do it.';
const SELF_LINK = 'Sending back to the wallet that deposited links the two.';
const KINDS: Record<string, string> = {
  h081_bank_deposit: 'deposit', h081_bank_withdraw: 'withdraw', h081_pay: 'pay', h081_transfer: 'transfer', h081_allowance_grant: 'allow',
  h081_allowance_reclaim: 'reclaim', h081_lend: 'lend', h081_loan_borrow: 'borrow', h081_stake: 'stake',
};

const bad = (message: string) => new CodedError('bad_request', message);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Decimal USDG text, checked. */
function usdgUnits(v: unknown, what = 'usdg'): bigint {
  if (typeof v !== 'string' && typeof v !== 'number') throw bad(`${what} must be a decimal amount like "2.5"`);
  let x: bigint;
  try { x = toUnits(String(v), MAINNET.usdg.decimals); } catch (e) { throw bad(`${what}: ${(e as Error).message}`); }
  if (x <= 0n) throw bad(`${what} must be positive`);
  return x;
}

/** Where address and key codes belong: the cluster, the pool program, USDG. */
export function poolContext(config: H081Config): CodeContext {
  return { cluster: config.cluster, program: config.poolProgramId.toBase58(), mint: config.usdgMint.toBase58() };
}

/** Where loan codes belong: the cluster, the loan program, USDG. */
export function loanContext(config: H081Config): CodeContext {
  return { cluster: config.cluster, program: config.loanProgramId.toBase58(), mint: config.usdgMint.toBase58() };
}

const PREFIX_KIND_NAME: Record<string, string> = { [ADDRESS_PREFIX]: 'address', [KEY_PREFIX]: 'key', [TERMS_PREFIX]: 'loan-terms', [PROOF_PREFIX]: 'loan-proof' };

/** Checks any "h081-*:" code against `config`: its kind, its network and whether it is valid there. Offline, no key needed. */
export function checkCode(config: H081Config, code: string): CodeCheck {
  const text = String(code ?? '').trim();
  // the prefix after what copying adds in front (quotes, brackets, Markdown); unframeV2 cleans the rest
  const m = /^[^A-Za-z0-9]{0,8}(h081-[a-z-]+:)/i.exec(text);
  const prefix = m ? m[1].toLowerCase() : undefined;
  const pool = poolContext(config), loan = loanContext(config);
  const kinds: Record<string, { kind: string; ctx: CodeContext; decode: (c: CodeContext, s: string) => unknown }> = {
    [ADDRESS_PREFIX]: { kind: 'address', ctx: pool, decode: decodeAddressCode },
    [KEY_PREFIX]: { kind: 'key', ctx: pool, decode: decodeKeyCode },
    [TERMS_PREFIX]: { kind: 'loan-terms', ctx: loan, decode: decodeLoanTerms },
    [PROOF_PREFIX]: { kind: 'loan-proof', ctx: loan, decode: decodeLoanProof },
  };
  const k = prefix ? kinds[prefix] : undefined;
  if (!k) return { kind: null, network: null, valid: false, reason: prefix ? `"${prefix}" is not a code this bank reads` : 'not an H081 code (it should start with "h081-")' };
  try {
    k.decode(k.ctx, text);
    return { kind: k.kind, network: config.cluster, valid: true };
  } catch (e) {
    const reason = (e as Error).message;
    let network: string | null = null;
    if (/another network/.test(reason)) {
      // which network it was made for, when it is one this package knows
      const mainnetCtx = { cluster: MAINNET.cluster, program: k.kind.startsWith('loan') ? MAINNET.programs.loan : MAINNET.programs.pool, mint: MAINNET.usdg.mint };
      try { k.decode(mainnetCtx, text); network = MAINNET.cluster; } catch { network = 'unknown'; }
    }
    return { kind: k.kind, network, valid: false, reason };
  }
}

class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve();
  waiting = 0;
  running = 0;
  get depth(): number { return this.waiting + this.running; }
  run<T>(fn: () => Promise<T>): Promise<T> {
    this.waiting++;
    const p = this.tail.then(async () => {
      this.waiting--;
      this.running++;
      try { return await fn(); } finally { this.running--; }
    });
    this.tail = p.then(() => undefined, () => undefined);
    return p;
  }
}

export class H081 {
  readonly paths: HomePaths;
  readonly network: string;
  readonly events = new EventHub();
  readonly ops: OpStore;
  private bankPromise?: Promise<AgentBank>;
  private readonly limiter: SendLimiter;
  private readonly queue = new WriteQueue();
  private balanceCache?: { value: BalanceResult; at: number };
  private syncing = false;
  private syncedAt?: string;
  private readonly addressCodeValue: string;
  readonly watcher: BalanceWatcher;
  readonly log: (line: string) => void;

  private constructor(readonly env: NodeJS.ProcessEnv, readonly config: H081Config, readonly signer: Keypair, private readonly opts: OpenOptions) {
    this.log = opts.log ?? ((line) => process.stderr.write(line + '\n'));
    this.paths = homePaths(env);
    ensureHome(this.paths.home, this.log);
    this.network = config.cluster;
    this.ops = new OpStore(this.paths.ops, this.log);
    const perMin = opts.maxSendsPerMin ?? Number(env.H081_API_MAX_SENDS_PER_MIN?.trim() || 30);
    if (!Number.isInteger(perMin) || perMin < 1) throw new Error('H081_API_MAX_SENDS_PER_MIN must be a positive integer');
    this.limiter = new SendLimiter(perMin);
    const { sk } = accountSkFromEnv(signer, env);
    this.addressCodeValue = encodeAddressCode(this.poolContext, new Account(sk).address);
    this.watcher = new BalanceWatcher(this.events, () => this.snapshot(), (opts.pollSeconds ?? 20) * 1000, this.log);
  }

  /**
   * Opens the agent: ~/.h081/agent.json (or H081_SOLANA_KEYPAIR / H081_SOLANA_KEY), ~/.h081/config.json and the
   * environment. Offline: the RPC is reached only when an operation needs the chain.
   */
  static async open(opts: OpenOptions = {}): Promise<H081> {
    const env = effectiveEnv(opts.env ?? process.env, { home: opts.home, cluster: opts.cluster });
    const config = configFromEnv(env);
    const signer = opts.signer ?? loadKeypair(env);
    await initCrypto();
    return new H081(env, config, signer, opts);
  }

  // ---- codes and addresses (offline)

  /** Where address and key codes belong: this cluster, the pool program, USDG. */
  get poolContext(): CodeContext { return poolContext(this.config); }

  /** Where loan codes belong: this cluster, the loan program, USDG. */
  get loanContext(): CodeContext { return loanContext(this.config); }

  /** The agent wallet and this account's "h081-address:" code. Offline. */
  address(): { wallet: string; addressCode: string } {
    return { wallet: this.signer.publicKey.toBase58(), addressCode: this.addressCodeValue };
  }

  /** Checks any "h081-*:" code: its kind, its network and whether it is valid here. Offline. */
  checkCode(code: string): CodeCheck {
    return checkCode(this.config, code);
  }

  /** Refuses a code that is not valid on this network (invalid_code), before anything else is done with it. */
  private requireCode(code: unknown, prefix: string, what: string): string {
    if (typeof code !== 'string' || !code.trim()) throw bad(`${what} is required`);
    const c = this.checkCode(code);
    if (!c.valid || c.kind !== PREFIX_KIND_NAME[prefix]) {
      throw new CodedError('invalid_code', c.valid ? `${what} must be an "${prefix}" code (this is a ${c.kind} code)` : (c.reason ?? `${what} is not valid`), { kind: c.kind, network: c.network });
    }
    return code.trim();
  }

  // ---- the bank (opened on first use)

  bank(): Promise<AgentBank> {
    if (!this.bankPromise) {
      const given = this.opts.bank;
      const p: Promise<AgentBank> = given
        ? (typeof given === 'function' ? given() : Promise.resolve(given))
        : openFromEnv({ env: this.env, config: this.config, signer: this.signer, log: this.log }).then((o) => o.bank as AgentBank);
      this.bankPromise = p.catch((e) => { this.bankPromise = undefined; throw e; });
    }
    return this.bankPromise;
  }

  /** Replaces a full RPC URL (its path or query may hold an API key) with its host. */
  redact(text: string): string {
    const url = this.config.rpcUrl;
    let out = text;
    if (url) out = out.split(url).join(rpcHost(url));
    return out;
  }

  // ---- reads

  /** Where things stand: offline, no RPC call. */
  status(): Record<string, unknown> {
    const missing = missingCircuits(this.config.circuitsDir, AGENT_CIRCUITS);
    return {
      network: this.network,
      agent: this.signer.publicKey.toBase58(),
      keySource: describeKeySource(keySource(this.env)),
      rpcHost: rpcHost(this.config.rpcUrl),
      relayer: this.config.relayerUrl ? rpcHost(this.config.relayerUrl) : null,
      circuits: { present: AGENT_CIRCUITS.filter((c) => !missing.includes(c)), missing },
      syncedAt: this.syncedAt ?? null,
      syncing: this.syncing,
      queue: { depth: this.queue.depth },
      fundingNeeded: FUNDING_NEEDED,
    };
  }

  /** Protocol facts plus where the key and the RPC are (host only) and the SOL each use needs. */
  async info(): Promise<Record<string, unknown>> {
    const bank = await this.bank();
    return { ...plain<Record<string, unknown>>(await bank.protocolInfo()), keySource: describeKeySource(keySource(this.env)), rpcHost: rpcHost(this.config.rpcUrl), fundingNeeded: FUNDING_NEEDED };
  }

  private mapBalance(b: BalanceView): BalanceResult {
    const d = MAINNET.usdg.decimals;
    const u = (x: bigint) => fromUnits(x, d);
    const rows: BalanceResult['allowances'] = [];
    const add = (list: BalanceView['agentAllowances'], holder: (a: BalanceView['agentAllowances'][number]) => string) => {
      for (const a of list ?? []) {
        rows.push({
          id: String(a.id), remaining: u(a.remaining), holder: holder(a), ...(a.agentIndex === undefined ? {} : { agentIndex: a.agentIndex }),
          ...(a.windowCap !== 0n && a.windowLen === 86400n ? { dailyCap: u(a.windowCap) } : {}),
          ...(a.maxPerTx !== 0n ? { maxPerTx: u(a.maxPerTx) } : {}),
          ...(a.expiry !== 0n ? { expires: new Date(Number(a.expiry) * 1000).toISOString() } : {}),
          reclaimable: a.reclaimable, pledged: a.pledgeBps !== 0n,
        });
      }
    };
    add(b.agentAllowances, () => 'this account');
    add(b.subAccounts, (a) => `sub-account ${a.agentIndex}`);
    add(b.heldBySubAccounts, (a) => `sub-account ${a.agentIndex}`);
    add(b.grantedToOthers, () => 'another agent');
    return {
      shielded: b.shieldedUsdg ?? u(b.shielded),
      wallet: { usdg: b.walletUsdgHuman ?? u(b.walletUsdg), sol: String(b.walletSol) },
      caps: b.caps ? { perDeposit: u(b.caps.perDeposit), total: u(b.caps.total), inVault: u(b.caps.inVault), paused: b.caps.paused } : null,
      allowances: rows,
      addressCode: this.addressCodeValue,
      syncedAt: new Date().toISOString(),
    };
  }

  /** Shielded and wallet balances, caps and allowances. Served from cache when under 15 s old unless `fresh`. */
  async balance(opts: { fresh?: boolean } = {}): Promise<BalanceResult> {
    const c = this.balanceCache;
    if (!opts.fresh && c && Date.now() - c.at < BALANCE_TTL_MS) return c.value;
    const bank = await this.bank();
    this.syncing = true;
    try {
      const value = this.mapBalance(await bank.balance() as BalanceView);
      this.balanceCache = { value, at: Date.now() };
      this.syncedAt = value.syncedAt;
      return value;
    } finally {
      this.syncing = false;
    }
  }

  private async snapshot(): Promise<Snapshot> {
    const b = await this.balance({ fresh: true });
    return { shielded: b.shielded, wallet: b.wallet, allowances: b.allowances.map((a) => ({ id: a.id, remaining: a.remaining })) };
  }

  /** What this gateway or CLI did (ops.jsonl), newest first. Nothing from before its first run. */
  history(opts: { after?: string; limit?: number } = {}): { items: HistoryItem[]; next: string | null } {
    const limit = opts.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw bad('limit must be 1..200');
    const all = this.ops.list();
    let start = 0;
    if (opts.after) {
      const i = all.findIndex((r) => r.key === opts.after);
      if (i < 0) throw bad('after: unknown cursor (use the `next` value of the previous page)');
      start = i + 1;
    }
    const page = all.slice(start, start + limit);
    const items = page.map((r) => ({
      id: r.key, time: new Date(r.at).toISOString(), kind: r.kind ?? r.route, ...(r.usdg ? { usdg: r.usdg } : {}),
      ...(r.signature ? { signature: r.signature } : {}), state: r.state, ...(r.to ? { to: r.to } : {}), ...(r.error ? { error: r.error.code } : {}),
    }));
    return { items, next: start + limit < all.length ? page[page.length - 1].key : null };
  }

  /** The relayer's fee for withdrawing `usdg`, what arrives, and whether it needs H081 staked. No proof is made. */
  async withdrawFee(usdg: string): Promise<FeeQuote> {
    const amount = usdgUnits(usdg);
    const bank = await this.bank();
    const terms = bank.relayTerms ? await bank.relayTerms() : undefined;
    const d = MAINNET.usdg.decimals;
    if (!terms) return { fee: '0', feeBps: 0, minFee: '0', payout: fromUnits(amount, d), freeTierMax: '100', needsStake: false, relayer: null, note: 'no relayer configured: the agent key sends withdrawals itself' };
    const fee = H081Bank.relayFee(amount, terms);
    if (fee >= amount) throw bad(`the relay fee ${fromUnits(fee, d)} USDG is not below ${fromUnits(amount, d)} USDG; withdraw more`);
    const tier = terms.freeTier ?? 100_000_000n;
    return {
      fee: fromUnits(fee, d), feeBps: terms.feeBps, minFee: fromUnits(terms.minFee, d), payout: fromUnits(amount - fee, d), freeTierMax: fromUnits(tier, d),
      needsStake: amount - fee > tier, relayer: terms.url,
      ...(terms.createAccountFee !== undefined ? { createAccountFee: fromUnits(terms.createAccountFee, d) } : {}),
    };
  }

  // ---- plans

  private download(...names: CircuitName[]): string {
    const missing = missingCircuits(this.config.circuitsDir, names);
    const mb = missing.reduce((s, n) => s + (CIRCUIT_MB[n] ?? 0), 0);
    return mb ? `${mb} MB` : '0 MB (already downloaded)';
  }

  private planOf(p: Omit<Plan, 'next' | 'download'> & { circuits?: CircuitName[] }): Plan {
    const { circuits, ...rest } = p;
    return { ...rest, download: circuits?.length ? this.download(...circuits) : '0 MB', next: NEXT };
  }

  private async relayedPlan(op: string, usdg: string, amount: bigint, to: string, isSpend: boolean, warnings: string[]): Promise<Plan> {
    const d = MAINNET.usdg.decimals;
    const circuits: CircuitName[] = [isSpend ? 'spend' : 'transact'];
    let terms: RelayTerms | undefined;
    try {
      const bank = await this.bank();
      terms = bank.relayTerms ? await bank.relayTerms() : undefined;
    } catch (e) {
      const c = classify(e);
      warnings.push(`The relayer cannot be used right now (${this.redact(c.message)}); a confirmed ${op} will be refused unless direct is set.`);
      return this.planOf({ op, usdg, to, fee: 'unknown', solNeeded: '0', circuit: circuits[0], circuits, publicOnChain: ['recipient', 'amount received'], sentBy: 'relayer', warnings });
    }
    if (!terms) {
      warnings.push('No relayer is configured: the agent key sends it, so the chain links the agent wallet to the recipient.');
      return this.planOf({ op, usdg, to, fee: '0', payout: usdg, solNeeded: '0.02', circuit: circuits[0], circuits, publicOnChain: ['recipient', 'amount', 'agent wallet as sender'], sentBy: 'agent key', warnings });
    }
    const fee = isSpend ? H081Bank.spendRelayFee(amount, terms) : H081Bank.relayFee(amount, terms);
    const tier = terms.freeTier ?? 100_000_000n;
    const pub = isSpend ? amount : amount - fee;
    if (fee >= amount) warnings.push(`The relay fee ${fromUnits(fee, d)} USDG is not below the amount; this would be refused.`);
    if (pub > tier) warnings.push(`Above ${fromUnits(tier, d)} USDG the relayer needs H081 staked by the agent wallet (capacity_stake), which then names the agent wallet to the relayer. Otherwise split it or use direct.`);
    if (terms.createAccountFee !== undefined) warnings.push(`If ${to} has no USDG account yet, the relayer adds ${fromUnits(terms.createAccountFee, d)} USDG to create it.`);
    return this.planOf({
      op, usdg, to, fee: fromUnits(fee, d), payout: fromUnits(amount - fee, d), solNeeded: '0', circuit: circuits[0], circuits,
      publicOnChain: ['recipient', 'amount received'], sentBy: 'relayer', warnings,
    });
  }

  // ---- confirmed writes: idempotency, queue, rate limit, events

  private async recover(key: string): Promise<void> {
    const rec = this.ops.get(key);
    if (!rec || rec.state !== 'pending' || !rec.signature) return;
    const bank = await this.bank();
    if (!bank.connection) return;
    const st = (await bank.connection.getSignatureStatuses([rec.signature], { searchTransactionHistory: true })).value[0];
    if (!st) return;
    if (st.err) {
      const c = classify(new Error(`the transaction ${rec.signature} failed on chain: ${JSON.stringify(st.err)}`));
      this.ops.finish(key, { state: 'failed', error: { code: 'program_error', message: c.message, retryable: false, status: 422, details: { signature: rec.signature } } });
    } else {
      this.ops.finish(key, { state: 'done', result: { signature: rec.signature, recovered: true } });
    }
  }

  private async runWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (e) {
      const c = classify(e);
      if (c.code !== 'relayer_busy' && c.code !== 'rate_limited') throw e;
      const base = this.opts.retryDelayMs ?? 1000;
      const wait = base / 2 + Math.random() * base;
      this.log(`relayer ${c.code === 'relayer_busy' ? 'busy' : 'rate-limited'}; retrying once in ${Math.round(wait)} ms`);
      await sleep(wait);
      return fn();
    }
  }

  private async write(w: {
    route: string; op: OpName; args: Args; usdg?: string; to?: string;
    plan: () => Promise<Plan>; run: (bank: AgentBank) => Promise<unknown>;
  }, o: WriteOptions): Promise<Outcome> {
    validateArgs(w.op, w.args);
    if (!o.confirm) return { status: 'plan', result: await w.plan() };
    const key = o.idempotencyKey ?? `sdk-${randomBytes(12).toString('hex')}`;
    if (!IDEMPOTENCY_KEY.test(key)) throw new CodedError('idempotency_key_required', 'Idempotency-Key must be 1-128 characters of A-Z a-z 0-9 _ . : -');
    const hash = bodyHash(w.route, w.args);
    const prior = this.ops.get(key);
    if (prior) {
      if (prior.route !== w.route || prior.bodyHash !== hash) throw new CodedError('idempotency_key_reused', `the Idempotency-Key ${key} was used for a different request; use a new key`);
      if (prior.state === 'pending' && this.ops.isLive(key)) throw new CodedError('in_progress', `the request with Idempotency-Key ${key} is still running`, { retryAfter: 5 });
      if (prior.state === 'pending') {
        await this.recover(key).catch((e) => this.log(`could not check ${key}: ${this.redact((e as Error).message)}`));
        const now = this.ops.get(key);
        if (!now || now.state === 'pending') {
          throw new CodedError('outcome_unknown', `the gateway stopped while the request with Idempotency-Key ${key} was running, so its outcome is unknown: check /v1/balance before retrying with a new key`, { idempotencyKey: key });
        }
      }
      const rec = this.ops.get(key)!;
      if (rec.state === 'done') return { status: 'sent', result: rec.result, replayed: true, idempotencyKey: key };
      const err = rec.error!;
      throw new CodedError(err.code as never, err.message, { ...(err.details ?? {}), replayed: true, idempotencyKey: key });
    }
    const slot = this.limiter.take();
    if (!slot.ok) throw new CodedError('rate_limited', `more than ${this.limiter.max} sends in a minute on this machine (H081_API_MAX_SENDS_PER_MIN); try again in ${slot.retryAfter} s`, { retryAfter: slot.retryAfter, local: true });
    if (this.queue.waiting >= QUEUE_MAX) throw new CodedError('busy', `${this.queue.waiting} sends are already waiting; try again shortly`, { retryAfter: 5 });
    const kind = KINDS[w.op] ?? w.op;
    this.ops.begin({ key, route: w.route, bodyHash: hash, kind, ...(w.usdg ? { usdg: w.usdg } : {}), ...(w.to ? { to: w.to } : {}) });
    // a failure before the bank is open sent nothing; after that, classifySend decides whether anything may have gone out
    let opened = false;
    try {
      const raw = await this.queue.run(async () => {
        const bank = await this.bank();
        opened = true;
        return this.runWithRetry(() => w.run(bank));
      });
      const result = plain<Record<string, unknown>>(raw);
      const signature = typeof result?.signature === 'string' ? result.signature
        : Array.isArray(result?.signatures) && typeof result.signatures[0] === 'string' ? result.signatures[0] as string
          : typeof result?.grantSignature === 'string' ? result.grantSignature : undefined;
      this.ops.finish(key, { state: 'done', result, ...(signature ? { signature } : {}) });
      this.balanceCache = undefined;
      this.events.emit('op.completed', { idempotencyKey: key, kind, ...(signature ? { signature } : {}) });
      return { status: 'sent', result, idempotencyKey: key };
    } catch (e) {
      const plainC = classify(e);
      const c = opened ? classifySend(e) : plainC;
      // a retryable failure here provably sent nothing: forget the key so the same request may run again with it.
      // Anything else (a final error, or an outcome that is unknown) is stored and replayed, never sent again.
      if (c.retryable) this.ops.drop(key);
      else this.ops.finish(key, { state: 'failed', error: { code: c.code, message: this.redact(c.message), retryable: c.retryable, status: c.status, ...(c.details ? { details: c.details } : {}) } });
      this.events.emit('op.failed', { idempotencyKey: key, kind, code: c.code });
      if (c.code === plainC.code) throw e;
      this.log(`${kind} ${key}: outcome unknown after ${plainC.code}; it is not retried`);
      throw new CodedError(c.code, c.message, { ...(c.details ?? {}), idempotencyKey: key }, { cause: e });
    }
  }

  // ---- writes

  async deposit(usdg: string, o: WriteOptions = {}): Promise<Outcome> {
    usdgUnits(usdg);
    const args = { usdg: String(usdg) };
    return this.write({
      route: 'deposit', op: 'h081_bank_deposit', args, usdg: args.usdg,
      plan: async () => this.planOf({
        op: 'deposit', usdg: args.usdg, fee: '0', solNeeded: '0.02', circuit: 'transact', circuits: ['transact'], publicOnChain: ['agent wallet', 'amount'], sentBy: 'agent key',
        warnings: ['A deposit is public: the chain shows the agent wallet and the amount. What happens inside the bank afterwards is private.'],
      }),
      run: (bank) => runOp(bank, 'h081_bank_deposit', args),
    }, o);
  }

  async withdraw(usdg: string, o: WriteOptions & { to: string; direct?: boolean }): Promise<Outcome> {
    const amount = usdgUnits(usdg);
    if (o.to === undefined || o.to === null || String(o.to).trim() === '') throw bad('to is required: a fresh wallet address, or "self" to send it back to the agent wallet');
    const self = String(o.to).trim() === 'self';
    let to: string;
    if (self) to = this.signer.publicKey.toBase58();
    else { try { to = new PublicKey(String(o.to).trim()).toBase58(); } catch { throw bad('to must be a base58 Solana wallet address or "self"'); } }
    const direct = o.direct === true;
    const args = { usdg: String(usdg), to, ...(direct ? { direct: true } : {}) };
    const warnings: string[] = [];
    if (to === this.signer.publicKey.toBase58()) warnings.push(SELF_LINK);
    return this.write({
      route: 'withdraw', op: 'h081_bank_withdraw', args, usdg: args.usdg, to,
      plan: async () => {
        if (direct) {
          return this.planOf({
            op: 'withdraw', usdg: args.usdg, to, fee: '0', payout: args.usdg, solNeeded: '0.02', circuit: 'transact', circuits: ['transact'],
            publicOnChain: ['recipient', 'amount', 'agent wallet as sender'], sentBy: 'agent key',
            warnings: [...warnings, 'direct: the agent key sends it, so the chain links the agent wallet to the recipient.'],
          });
        }
        return this.relayedPlan('withdraw', args.usdg, amount, to, false, warnings);
      },
      run: (bank) => runOp(bank, 'h081_bank_withdraw', args),
    }, o);
  }

  async pay(usdg: string, o: WriteOptions & { to?: string; toAddressCode?: string; allowanceId?: string; agentIndex?: number; direct?: boolean; allowPledged?: boolean }): Promise<Outcome> {
    const amount = usdgUnits(usdg);
    const hasTo = o.to !== undefined && String(o.to).trim() !== '', hasCode = o.toAddressCode !== undefined && String(o.toAddressCode).trim() !== '';
    if (hasTo === hasCode) throw bad('give exactly one recipient: to (a wallet, public payout) or toAddressCode (an "h081-address:" code, private payment)');
    const code = hasCode ? this.requireCode(o.toAddressCode, ADDRESS_PREFIX, 'toAddressCode') : undefined;
    let to: string | undefined;
    if (hasTo) { try { to = new PublicKey(String(o.to).trim()).toBase58(); } catch { throw bad('to must be a base58 Solana wallet address'); } }
    const args: Args = {
      usdg: String(usdg), ...(to ? { to } : { toAddressCode: code }), ...(o.allowanceId !== undefined ? { allowanceId: String(o.allowanceId) } : {}),
      ...(o.agentIndex !== undefined ? { agentIndex: o.agentIndex } : {}), ...(o.direct ? { direct: true } : {}), ...(o.allowPledged ? { allowPledged: true } : {}),
    };
    return this.write({
      route: 'pay', op: 'h081_pay', args, usdg: String(usdg), to: to ?? 'shielded',
      plan: async () => {
        const warnings = ['Pays from an allowance this agent holds, inside its caps; when none can pay, the error names the cap.'];
        if (!to) {
          return this.planOf({
            op: 'pay', usdg: String(usdg), to: 'shielded', fee: '0', payout: String(usdg), solNeeded: '0.02', circuit: 'spend', circuits: ['spend'],
            publicOnChain: ['that the agent wallet sent a bank transaction'], sentBy: 'agent key',
            warnings: [...warnings, 'A payment to an address code is sent by the agent key: the chain shows the agent wallet made a payment, not to whom or how much.'],
          });
        }
        if (o.direct) {
          return this.planOf({
            op: 'pay', usdg: String(usdg), to, fee: '0', payout: String(usdg), solNeeded: '0.02', circuit: 'spend', circuits: ['spend'],
            publicOnChain: ['recipient', 'amount', 'agent wallet as sender'], sentBy: 'agent key', warnings: [...warnings, 'direct: the agent key sends it, so the chain links the agent wallet to the recipient.'],
          });
        }
        if (to === this.signer.publicKey.toBase58()) warnings.push(SELF_LINK);
        return this.relayedPlan('pay', String(usdg), amount, to, true, warnings);
      },
      run: (bank) => runOp(bank, 'h081_pay', args),
    }, o);
  }

  async transfer(usdg: string, o: WriteOptions & { toAddressCode: string }): Promise<Outcome> {
    usdgUnits(usdg);
    const code = this.requireCode(o.toAddressCode, ADDRESS_PREFIX, 'toAddressCode');
    if (code === this.addressCodeValue) throw bad('that is this account\'s own address code; a transfer to itself does nothing');
    const args = { usdg: String(usdg), toAddressCode: code };
    return this.write({
      route: 'transfer', op: 'h081_transfer', args, usdg: args.usdg, to: 'shielded',
      plan: async () => this.planOf({
        op: 'transfer', usdg: args.usdg, to: 'shielded', fee: '0', payout: args.usdg, solNeeded: '0.02', circuit: 'transact', circuits: ['transact'],
        publicOnChain: ['that the agent wallet sent a bank transaction'], sentBy: 'agent key',
        warnings: ['Sent by the agent key: the agent wallet is visible on chain as a bank user. The amount and the recipient stay hidden.'],
      }),
      run: (bank) => runOp(bank, 'h081_transfer', args),
    }, o);
  }

  async allow(budget: string, o: WriteOptions & { dailyCap?: string; maxPerTx?: string; days?: number; unlockDays?: number; agentIndex?: number; toAddressCode?: string } = {}): Promise<Outcome> {
    usdgUnits(budget, 'budget');
    const code = o.toAddressCode !== undefined ? this.requireCode(o.toAddressCode, ADDRESS_PREFIX, 'toAddressCode') : undefined;
    const args: Args = {
      usdg: String(budget), ...(o.dailyCap !== undefined ? { windowCapUsdg: String(o.dailyCap) } : {}), ...(o.maxPerTx !== undefined ? { maxPerTxUsdg: String(o.maxPerTx) } : {}),
      ...(o.days !== undefined ? { days: o.days } : {}), ...(o.unlockDays !== undefined ? { unlockDays: o.unlockDays } : {}),
      ...(o.agentIndex !== undefined ? { agentIndex: o.agentIndex } : {}), ...(code ? { toAddressCode: code } : {}),
    };
    return this.write({
      route: 'allowances', op: 'h081_allowance_grant', args, usdg: String(budget), to: code ? 'another agent' : o.agentIndex !== undefined ? `sub-account ${o.agentIndex}` : 'a sub-account',
      plan: async () => {
        const bankPlan = await runOp(await this.bank(), 'h081_allowance_grant', { ...args, confirm: false });
        return this.planOf({
          op: 'allow', usdg: String(budget), fee: '0', solNeeded: '0.1', circuit: 'grant', circuits: ['grant'], publicOnChain: ['that the agent wallet made a grant'], sentBy: 'agent key',
          warnings: ['Sent by the agent key: the chain shows the agent wallet made a grant, not the amount, the rules or the recipient.'], details: plain(bankPlan),
        });
      },
      run: async (bank) => runOp(bank, 'h081_allowance_grant', { ...args, confirm: true }),
    }, o);
  }

  async reclaim(allowanceId: string, o: WriteOptions = {}): Promise<Outcome> {
    if (!/^\d+$/.test(String(allowanceId ?? ''))) throw bad('the allowance id must be the decimal id /v1/balance shows');
    const args = { allowanceId: String(allowanceId) };
    return this.write({
      route: 'reclaim', op: 'h081_allowance_reclaim', args,
      plan: async () => {
        const bankPlan = await runOp(await this.bank(), 'h081_allowance_reclaim', { ...args, confirm: false });
        return this.planOf({
          op: 'reclaim', fee: '0', solNeeded: '0.02', circuit: 'spend', circuits: ['spend'], publicOnChain: ['that the agent wallet sent a bank transaction'], sentBy: 'agent key',
          warnings: [], details: plain(bankPlan),
        });
      },
      run: (bank) => runOp(bank, 'h081_allowance_reclaim', { ...args, confirm: true }),
    }, o);
  }

  async loanQuote(termsCode: string, o: { principal?: string } = {}): Promise<unknown> {
    const code = this.requireCode(termsCode, TERMS_PREFIX, 'termsCode');
    return plain(await runOp(await this.bank(), 'h081_loan_quote', { termsCode: code, ...(o.principal !== undefined ? { principalUsdg: String(o.principal) } : {}) }));
  }

  async borrow(termsCode: string, o: WriteOptions & { days: number; unlockDays: number; principal?: string; budget?: string; dailyCap?: string; maxPerTx?: string; agentIndex?: number }): Promise<Outcome> {
    const code = this.requireCode(termsCode, TERMS_PREFIX, 'termsCode');
    const args: Args = {
      termsCode: code, days: o.days, unlockDays: o.unlockDays, ...(o.principal !== undefined ? { principalUsdg: String(o.principal) } : {}),
      ...(o.budget !== undefined ? { budgetUsdg: String(o.budget) } : {}), ...(o.dailyCap !== undefined ? { dailyCapUsdg: String(o.dailyCap) } : {}),
      ...(o.maxPerTx !== undefined ? { maxPerTxUsdg: String(o.maxPerTx) } : {}), ...(o.agentIndex !== undefined ? { agentIndex: o.agentIndex } : {}),
    };
    return this.write({
      route: 'borrow', op: 'h081_loan_borrow', args, usdg: o.principal,
      plan: async () => {
        const quote = await this.loanQuote(code, { principal: o.principal });
        return this.planOf({
          op: 'borrow', usdg: o.principal, fee: '0', solNeeded: '0.1', circuit: 'grant, stream', circuits: ['grant', 'stream'],
          publicOnChain: ['that the agent wallet made a grant'], sentBy: 'agent key',
          warnings: ['This pledges an allowance from the shielded balance and returns a proof code for the lender. Nothing is borrowed until the lender funds it.'],
          details: quote,
        });
      },
      run: (bank) => runOp(bank, 'h081_loan_borrow', args),
    }, o);
  }

  /** Lender actions: open, fund, collect, claim, settle (a plan unless confirm); status is a read. close is not available. */
  async lend(action: string, fields: Record<string, unknown> = {}, o: WriteOptions = {}): Promise<Outcome> {
    if (action === 'close') throw new CodedError('not_available', 'closing a loan slot is not available in this version');
    if (action === 'status') return { status: 'done', result: await this.lendStatus(fields.loanRef as string | undefined) };
    if (!['open', 'fund', 'collect', 'claim', 'settle'].includes(action)) throw bad('action must be one of open, fund, collect, claim, settle (status: GET /v1/loans/lent)');
    const allowed = ['pledgeBps', 'proofCode', 'loanRef', 'principal', 'principalUsdg', 'amount', 'usdg'];
    const stray = Object.keys(fields).filter((k) => fields[k] !== undefined && !allowed.includes(k));
    if (stray.length) throw bad(`unknown field(s): ${stray.join(', ')}`);
    if (action === 'fund') this.requireCode(fields.proofCode, PROOF_PREFIX, 'proofCode');
    const args: Args = { action, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
    const hasPlanStep = action === 'open' || action === 'fund' || action === 'settle';
    const sol = { open: '0.01', fund: '0.02', collect: '0.01', claim: '0.02', settle: '0.01' }[action as 'open'];
    return this.write({
      route: 'lend', op: 'h081_lend', args, usdg: typeof fields.principalUsdg === 'string' ? fields.principalUsdg : typeof fields.usdg === 'string' ? fields.usdg : undefined,
      plan: async () => {
        const details = hasPlanStep ? plain(await runOp(await this.bank(), 'h081_lend', { ...args, confirm: false })) : { action, ...fields };
        return this.planOf({
          op: `lend ${action}`, fee: '0', solNeeded: sol, circuit: action === 'claim' ? 'spend' : action === 'fund' ? 'stream' : null, circuits: action === 'claim' ? ['spend'] : [],
          publicOnChain: ['agent wallet as lender', ...(action === 'fund' ? ['principal', 'borrower payout account'] : [])], sentBy: 'agent key',
          warnings: ['The loan program needs the slot owner to sign, so the agent key sends every lender action: the agent wallet is public as the lender.'], details,
        });
      },
      run: (bank) => runOp(bank, 'h081_lend', hasPlanStep ? { ...args, confirm: true } : args),
    }, o);
  }

  async lendStatus(loanRef?: string): Promise<unknown> {
    return plain(await runOp(await this.bank(), 'h081_lend', { action: 'status', ...(loanRef !== undefined && loanRef !== '' ? { loanRef: String(loanRef) } : {}) }));
  }

  async stakeView(): Promise<unknown> {
    return plain(await runOp(await this.bank(), 'h081_stake', { action: 'view' }));
  }

  /** capacity_stake: view, stake, request_unstake, unstake. */
  async stake(action: string, o: WriteOptions & { h081?: string } = {}): Promise<Outcome> {
    if (action === 'view') return { status: 'done', result: await this.stakeView() };
    if (!['stake', 'request_unstake', 'unstake'].includes(action)) throw bad('action must be one of view, stake, request_unstake, unstake');
    const args: Args = { action, ...(o.h081 !== undefined ? { h081: String(o.h081) } : {}) };
    return this.write({
      route: 'stake', op: 'h081_stake', args,
      plan: async () => this.planOf({
        op: action, fee: '0', solNeeded: '0.01', circuit: null, publicOnChain: ['agent wallet', ...(o.h081 !== undefined ? ['H081 amount'] : [])], sentBy: 'agent key',
        warnings: action === 'request_unstake' ? ['Unstaking has a 30-day cooldown.'] : [], details: { action, ...(o.h081 !== undefined ? { h081: String(o.h081) } : {}) },
      }),
      run: (bank) => runOp(bank, 'h081_stake', args),
    }, o);
  }

  /** Stops the background sync. */
  close(): void {
    this.watcher.stop();
  }
}

