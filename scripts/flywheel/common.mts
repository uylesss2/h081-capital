// Shared pieces of the H081 flywheel scripts (buyback.mts, rehearse.mts): constants, the creator-fee firewall,
// cluster guards and the append-only ledger.
//
// The flywheel spends PLATFORM FEES ONLY (relayer fee, loan origination fee, paid hosted services), all paid
// into a dedicated treasury multisig. The token's trading CREATOR FEES belong to the team: they are never a
// source, never claimed, never swept, never moved. Nothing in scripts/flywheel imports the launch scripts or any
// fee-claim code; rehearse.mts checks that statically.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { Connection, PublicKey, TransactionInstruction, type VersionedTransactionResponse } from '@solana/web3.js';

export const ROOT = resolve(import.meta.dirname, '..', '..');

// ------------------------------------------------------------- official addresses

/** The official H081 mint (classic SPL token, 6 decimals, mint authority revoked). */
export const H081_MINT = new PublicKey('EgqxxR7zowzaLEm24oep5qqBieLVAWYX78LhgeqAJAo');
/** The H081/SOL Meteora DAMM v2 pool the buyback trades on. */
export const H081_POOL = new PublicKey('CryBbh9QQttrUrfLVXLLEuhkM5wZ8W1DUZFYNhUEhYqs');
/**
 * The mainnet safety_pool program the top-up may call. null until safety_pool is deployed (an owner go): until then
 * buyback.mts refuses --safety-program on mainnet (100% burn). Set it to the deployed program id, nothing else.
 */
export const H081_SAFETY_POOL_PROGRAM: PublicKey | null = null;
export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

/** Hard cap on slippage per chunk: 1%. The CLI may tighten it, never loosen it. */
export const MAX_SLIPPAGE_BPS = 100;
/** Before the safety pool is live 100% of bought H081 is burned; after, half is burned and half tops it up. */
export const SPLIT_BURN_ONLY = { burnBps: 10_000, topUpBps: 0 } as const;
export const SPLIT_LIVE = { burnBps: 5_000, topUpBps: 5_000 } as const;

// ------------------------------------------------------------- creator-fee firewall

/**
 * The H081 launch wallets. Creator trading fees accrue to them; they are the team's income. No account in this
 * list may be a treasury, signer, fee payer, source or any other account of a flywheel transaction, and a
 * treasury that has ever transacted with one of them is refused. Hard-coded on purpose: no flag removes an entry.
 */
export const DENY_LIST: readonly string[] = Object.freeze([
  '2wjxKzH7fVGpjcA9KpjDBDHjSAhz7u8ZgMLnVPVGSkDP',
  'FZEMfMN7hhQcKPHRt2kb9ig5XArMvK5LqfSTXpQ1j4DZ',
  '5XJNtM7a9ocRL8f8vsyNVmQoekutCFJkGNXNQbkJP4bw',
]);

export class FirewallError extends Error {
  constructor(message: string) { super(`FIREWALL: ${message}`); this.name = 'FirewallError'; }
}

/**
 * DENY_LIST plus FLYWHEEL_EXTRA_DENY (comma-separated). The extra list can only ADD addresses; the rehearsal uses
 * it to register the local wallets that stand in for the launch wallets.
 */
export function denySet(): Set<string> {
  const extra = (process.env.FLYWHEEL_EXTRA_DENY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const k of extra) new PublicKey(k); // throws on a malformed entry rather than silently ignoring it
  return new Set([...DENY_LIST, ...extra]);
}

export function assertNotDenied(deny: Set<string>, label: string, key: PublicKey | string) {
  const k = typeof key === 'string' ? key : key.toBase58();
  if (deny.has(k)) throw new FirewallError(`${label} ${k} is a launch wallet (creator fees are never touched); refusing`);
}

/**
 * Every instruction the flywheel builds: no deny-listed account anywhere, the treasury is the only signer, and only
 * allowlisted programs are called.
 */
export function assertInstructionsClean(deny: Set<string>, ixs: TransactionInstruction[], treasury: PublicKey, programs: PublicKey[]) {
  const allowed = new Set(programs.map((p) => p.toBase58()));
  for (const [i, ix] of ixs.entries()) {
    assertNotDenied(deny, `instruction ${i} program`, ix.programId);
    if (!allowed.has(ix.programId.toBase58())) throw new FirewallError(`instruction ${i} calls ${ix.programId.toBase58()}, which is not on the flywheel's program allowlist`);
    for (const k of ix.keys) {
      assertNotDenied(deny, `instruction ${i} account`, k.pubkey);
      if (k.isSigner && !k.pubkey.equals(treasury)) throw new FirewallError(`instruction ${i} wants signer ${k.pubkey.toBase58()}; only the treasury may sign`);
    }
  }
}

/** Every account a confirmed transaction loaded (static keys and address-lookup-table keys). */
export function txAccountKeys(tx: VersionedTransactionResponse): PublicKey[] {
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined });
  const out: PublicKey[] = [];
  for (let i = 0; i < keys.length; i++) out.push(keys.get(i)!);
  return out;
}

export interface ProvenanceReport { scanned: number; newestSignature: string | null; hits: { signature: string; account: string }[]; truncated: boolean }

/**
 * Provenance of the treasury's money: walks the history of every given address (the treasury and its token
 * accounts) back to `until` (the previous run's cursor) or `depth` signatures, and reports every transaction
 * that touched a deny-listed account. Any hit means creator-fee money may have mixed in, and the run is refused.
 */
export async function scanProvenance(conn: Connection, addresses: PublicKey[], deny: Set<string>, opts: { until?: string; depth: number }): Promise<ProvenanceReport> {
  const sigs = new Map<string, number>(); // signature -> slot
  let truncated = false;
  for (const addr of addresses) {
    let before: string | undefined;
    let seen = 0;
    for (;;) {
      const page = await conn.getSignaturesForAddress(addr, { limit: 1000, before, until: opts.until }, 'confirmed');
      for (const s of page) sigs.set(s.signature, s.slot);
      seen += page.length;
      if (page.length < 1000) break;
      if (seen >= opts.depth) { truncated = true; break; }
      before = page[page.length - 1].signature;
    }
  }
  const list = [...sigs.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
  const hits: ProvenanceReport['hits'] = [];
  for (let i = 0; i < list.length; i += 25) {
    const batch = list.slice(i, i + 25);
    const txs = await conn.getTransactions(batch, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    for (const [j, tx] of txs.entries()) {
      if (!tx) throw new Error(`provenance: transaction ${batch[j]} not returned by the RPC; refusing to guess`);
      for (const k of txAccountKeys(tx)) if (deny.has(k.toBase58())) hits.push({ signature: batch[j], account: k.toBase58() });
    }
  }
  return { scanned: list.length, newestSignature: list[0] ?? null, hits, truncated };
}

// ------------------------------------------------------------- cluster guards

export function isLocalRpc(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
  } catch { return false; }
}

export type Cluster = 'mainnet-beta' | 'localnet';

/** Local validators, or mainnet-beta for READ-ONLY planning. Any other cluster (devnet, testnet, unknown) is refused. */
export async function detectCluster(conn: Connection, rpc: string): Promise<{ cluster: Cluster; genesis: string }> {
  const genesis = await conn.getGenesisHash();
  if (isLocalRpc(rpc)) {
    if (genesis === MAINNET_GENESIS) throw new Error('a localhost RPC that reports the mainnet genesis hash; refusing');
    return { cluster: 'localnet', genesis };
  }
  if (genesis !== MAINNET_GENESIS) throw new Error(`RPC ${rpc} is neither localhost nor mainnet-beta (genesis ${genesis}); the flywheel never touches public test clusters`);
  return { cluster: 'mainnet-beta', genesis };
}

// ------------------------------------------------------------- ledger (append-only)

export const LEDGER_SCHEMA = 'h081-flywheel-ledger/1';
export const DEFAULT_LEDGER = resolve(ROOT, 'flywheel-ledger.json');

/** Amounts are base-unit integers as decimal strings (lamports for SOL, 10^-6 H081 for H081). */
export interface LedgerEntry {
  id: string;
  at: string;
  status: 'proposed' | 'executed';
  cluster: Cluster;
  source: 'platform-fees';
  treasury: string;
  mint: string;
  pool: string;
  split: { burnBps: number; topUpBps: number };
  proposal?: { file: string; sha256: string };
  /** proposed: what the treasury held when the plan was built, and the plan. */
  balances?: { solLamports: string; wsolLamports: string; h081: string; otherTokens: { mint: string; amount: string }[] };
  plan?: { spendLamports: string; chunks: number; minH081Out: string; burn: string; topUp: string; slippageBps: number };
  /** executed: what the confirmed transactions did. */
  result?: {
    solSpentLamports: string; h081Bought: string; burned: string; toppedUp: string; signatures: string[];
    /** the proposal transactions (order numbers) the signatures were matched to */
    executed?: number[];
    /** e.g. settle missing, chunks skipped, a chunk executed after its notAfter */
    warnings?: string[];
  };
  firewall: { denyListChecked: readonly string[]; provenanceScanned: number; provenanceCursor: string | null };
  refersTo?: string;
}
export interface Ledger { schema: typeof LEDGER_SCHEMA; note: string; entries: LedgerEntry[] }

export function readLedger(path: string): Ledger {
  if (!existsSync(path)) {
    return { schema: LEDGER_SCHEMA, note: 'H081 flywheel: platform fees -> H081 buyback -> burn / safety-pool top-up. Creator trading fees are never a source.', entries: [] };
  }
  const l = JSON.parse(readFileSync(path, 'utf8')) as Ledger;
  if (l.schema !== LEDGER_SCHEMA || !Array.isArray(l.entries)) throw new Error(`${path} is not a ${LEDGER_SCHEMA} ledger`);
  return l;
}

/** Appends one entry; earlier entries are never rewritten. Written via a temp file so a crash cannot truncate it. */
export function appendLedger(path: string, entry: LedgerEntry) {
  const l = readLedger(path);
  if (l.entries.some((e) => e.id === entry.id)) throw new Error(`ledger already has entry ${entry.id}`);
  l.entries.push(entry);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(l, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

/** The newest provenance cursor recorded for `treasury`, so the next scan only reads newer history. */
export function lastProvenanceCursor(l: Ledger, treasury: PublicKey): string | undefined {
  for (let i = l.entries.length - 1; i >= 0; i--) {
    const e = l.entries[i];
    if (e.treasury === treasury.toBase58() && e.firewall.provenanceCursor) return e.firewall.provenanceCursor;
  }
  return undefined;
}

// ------------------------------------------------------------- small helpers

export const sha256Hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = `1${s}`; }
  return s;
}

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error(`not base58: ${s}`);
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

/** 1234567 base units at 6 decimals -> "1.234567". */
export function fmt(amount: bigint, decimals: number): string {
  const neg = amount < 0n;
  const a = neg ? -amount : amount;
  const d = 10n ** BigInt(decimals);
  const frac = (a % d).toString().padStart(decimals, '0');
  return `${neg ? '-' : ''}${a / d}${decimals ? `.${frac}` : ''}`;
}

/** "1.5" SOL -> 1500000000n, exact (no float rounding). */
export function parseUnits(v: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`not a non-negative decimal amount: ${v}`);
  const [w, f = ''] = v.split('.');
  if (f.length > decimals) throw new Error(`${v} has more than ${decimals} decimals`);
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, '0') || '0');
}
