// Idempotency records and local history in ops.jsonl (append-only, one JSON record per line, the last line for a key
// wins; compacted on load; records older than 7 days are dropped). A record holds what a confirmed write was asked
// (route and body hash), its state, and its result or error: never a key, a note or a token.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { appendPrivate, writePrivate, type Warn } from './home.js';

/** What an Idempotency-Key may look like: 1-128 of A-Z a-z 0-9 _ . : - */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;
export const RETENTION_MS = 7 * 24 * 3600 * 1000;

export type OpState = 'pending' | 'done' | 'failed';

export interface StoredError { code: string; message: string; retryable: boolean; status: number; details?: Record<string, unknown> }

export interface OpRecord {
  key: string;
  route: string;
  bodyHash: string;
  state: OpState;
  result?: unknown;
  error?: StoredError;
  signature?: string;
  /** when the record was written (ms since the epoch) */
  at: number;
  /** for the local history */
  kind?: string;
  usdg?: string;
  to?: string;
}

/** JSON with sorted object keys (so the same body always hashes the same). */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
  }
  return typeof v === 'bigint' ? JSON.stringify(v.toString()) : JSON.stringify(v ?? null);
}

export function bodyHash(route: string, body: unknown): string {
  return createHash('sha256').update(`${route}\n${stableStringify(body)}`).digest('hex');
}

export class OpStore {
  private readonly records = new Map<string, OpRecord>();
  /** keys running in this process (a pending record not in here was left by a process that stopped) */
  private readonly live = new Set<string>();

  constructor(readonly file: string, private readonly warn: Warn = () => {}, private readonly now: () => number = Date.now) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    const cutoff = this.now() - RETENTION_MS;
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r: (OpRecord & { dropped?: boolean }) | undefined;
      try { r = JSON.parse(line); } catch { this.warn(`ops.jsonl: skipped an unreadable line`); continue; }
      if (!r || typeof r.key !== 'string') continue;
      if (r.dropped) { this.records.delete(r.key); continue; }
      this.records.set(r.key, r);
    }
    for (const [k, r] of this.records) if (r.at < cutoff) this.records.delete(k);
    this.compact();
  }

  private compact(): void {
    const lines = [...this.records.values()].map((r) => JSON.stringify(r)).join('\n');
    try { writePrivate(this.file, lines ? lines + '\n' : '', this.warn); } catch (e) { this.warn(`could not rewrite ${this.file}: ${(e as Error).message}`); }
  }

  private append(r: OpRecord | { key: string; dropped: true; at: number }): void {
    appendPrivate(this.file, JSON.stringify(r), this.warn);
  }

  get(key: string): OpRecord | undefined { return this.records.get(key); }

  /** True while a request with this key runs in this process. */
  isLive(key: string): boolean { return this.live.has(key); }

  begin(r: Omit<OpRecord, 'state' | 'at'>): OpRecord {
    const rec: OpRecord = { ...r, state: 'pending', at: this.now() };
    this.records.set(rec.key, rec);
    this.live.add(rec.key);
    this.append(rec);
    return rec;
  }

  /** Records the outcome (done or failed) of `key`. */
  finish(key: string, patch: Partial<Pick<OpRecord, 'state' | 'result' | 'error' | 'signature'>>): OpRecord | undefined {
    const prev = this.records.get(key);
    this.live.delete(key);
    if (!prev) return undefined;
    const rec: OpRecord = { ...prev, ...patch, at: this.now() };
    this.records.set(key, rec);
    this.append(rec);
    return rec;
  }

  /** Forgets `key` (a retryable failure: nothing was sent, so the same key may run again). */
  drop(key: string): void {
    this.live.delete(key);
    if (!this.records.delete(key)) return;
    this.append({ key, dropped: true, at: this.now() });
  }

  /** Every finished or pending record, newest first. */
  list(): OpRecord[] {
    return [...this.records.values()].sort((a, b) => b.at - a.at || (a.key < b.key ? -1 : 1));
  }

  /** Pending records left by a process that stopped (not running here). */
  orphans(): OpRecord[] {
    return [...this.records.values()].filter((r) => r.state === 'pending' && !this.live.has(r.key));
  }
}
