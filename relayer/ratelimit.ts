// Token-bucket rate limiting per client key (the remote address, or the first X-Forwarded-For hop when the
// relayer runs behind a proxy it trusts). Each key holds up to `burst` tokens and regains `perMinute` per
// minute; a relay request costs one. Idle buckets are dropped so the map stays small.
import { RelayError } from './errors.js';

export interface RateLimitOptions { perMinute: number; burst: number; now?: () => number; maxKeys?: number }

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(readonly opts: RateLimitOptions) {
    if (!(opts.perMinute > 0) || !(opts.burst >= 1)) throw new Error('rate limit: perMinute > 0 and burst >= 1');
    this.now = opts.now ?? Date.now;
    this.maxKeys = opts.maxKeys ?? 100_000;
  }

  /** Takes one token for `key`. Returns 0 when allowed, else the milliseconds until a token is available. */
  take(key: string): number {
    const t = this.now();
    const rate = this.opts.perMinute / 60_000;
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.sweep(t);
      b = { tokens: this.opts.burst, at: t };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.opts.burst, b.tokens + (t - b.at) * rate);
    b.at = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - b.tokens) / rate);
  }

  /** Drops buckets that have refilled completely (they behave exactly like a fresh one). */
  sweep(t = this.now()): void {
    const rate = this.opts.perMinute / 60_000;
    for (const [k, b] of this.buckets) if (b.tokens + (t - b.at) * rate >= this.opts.burst) this.buckets.delete(k);
  }

  get size(): number { return this.buckets.size; }
}

/** Runs tasks one at a time (EVM nonces; one relayer key must not race itself). */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/**
 * Nullifiers of operations this relayer has accepted and not yet seen fail. A second request spending one
 * of them is refused (409) instead of being simulated against a state that does not include the first.
 * Entries expire after `ttlMs` (by then the first has landed and simulation catches the double spend).
 */
export class InFlight {
  private until = new Map<string, number>();
  constructor(readonly ttlMs = 10 * 60_000, private readonly now: () => number = Date.now) {}

  /** Reserves the nullifiers or throws a 409; returns a function that releases them (on failure). */
  claim(nullifiers: bigint[]): () => void {
    const t = this.now();
    for (const [k, u] of this.until) if (u <= t) this.until.delete(k);
    const keys = nullifiers.map((n) => n.toString(16));
    if (keys.some((k) => this.until.has(k))) throw new RelayError(409, 'in_flight', 'an operation spending this nullifier is already being relayed');
    for (const k of keys) this.until.set(k, t + this.ttlMs);
    return () => { for (const k of keys) this.until.delete(k); };
  }
}
