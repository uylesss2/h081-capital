// Events for /v1/events (server-sent events): op.completed and op.failed from this gateway's own writes, and
// balance.changed / allowance.changed from a background sync that runs only while a client is connected. Event ids
// increase monotonically; the last 1,000 events are kept in memory so a client can resume with Last-Event-ID.

export type EventType = 'balance.changed' | 'allowance.changed' | 'op.completed' | 'op.failed';

export interface AgentEvent { id: number; type: EventType; time: string; data: Record<string, unknown> }

export const EVENT_BUFFER = 1000;

export class EventHub {
  private readonly buf: AgentEvent[] = [];
  private next = 1;
  private readonly subs = new Set<(e: AgentEvent) => void>();
  private readonly watchers = new Set<() => void>();

  emit(type: EventType, data: Record<string, unknown>): AgentEvent {
    const e: AgentEvent = { id: this.next++, type, time: new Date().toISOString(), data };
    this.buf.push(e);
    if (this.buf.length > EVENT_BUFFER) this.buf.splice(0, this.buf.length - EVENT_BUFFER);
    for (const fn of this.subs) { try { fn(e); } catch { /* a broken subscriber never stops the others */ } }
    return e;
  }

  /** Events after `lastId` still in the buffer. */
  since(lastId: number): AgentEvent[] {
    return this.buf.filter((e) => e.id > lastId);
  }

  get lastId(): number { return this.next - 1; }

  subscribe(fn: (e: AgentEvent) => void): () => void {
    this.subs.add(fn);
    for (const w of this.watchers) w();
    return () => { this.subs.delete(fn); for (const w of this.watchers) w(); };
  }

  get subscribers(): number { return this.subs.size; }

  /** Called whenever the subscriber count changes. */
  onSubscribers(fn: () => void): void { this.watchers.add(fn); }
}

/** What the watcher compares between two syncs: decimal strings. */
export interface Snapshot {
  shielded: string;
  wallet: { usdg: string; sol: string };
  allowances: Array<{ id: string; remaining: string }>;
}

const sub = (a: string, b: string): string => {
  // decimal strings with up to 6 fraction digits (USDG)
  const units = (s: string) => { const [i, f = ''] = s.split('.'); return BigInt(i) * 1_000_000n + BigInt((f + '000000').slice(0, 6)); };
  const d = units(a) - units(b);
  const neg = d < 0n, x = neg ? -d : d;
  const frac = (x % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${x / 1_000_000n}${frac ? '.' + frac : ''}`;
};

/** The events between two snapshots (none for the first one: it is the baseline). */
export function diffSnapshots(prev: Snapshot | undefined, cur: Snapshot): Array<{ type: EventType; data: Record<string, unknown> }> {
  if (!prev) return [];
  const out: Array<{ type: EventType; data: Record<string, unknown> }> = [];
  if (prev.shielded !== cur.shielded || prev.wallet.usdg !== cur.wallet.usdg || prev.wallet.sol !== cur.wallet.sol) {
    out.push({ type: 'balance.changed', data: { shielded: cur.shielded, wallet: cur.wallet, deltaShielded: sub(cur.shielded, prev.shielded) } });
  }
  const before = new Map(prev.allowances.map((a) => [a.id, a.remaining]));
  const now = new Map(cur.allowances.map((a) => [a.id, a.remaining]));
  for (const [id, remaining] of now) if (before.get(id) !== remaining) out.push({ type: 'allowance.changed', data: { id, remaining } });
  for (const id of before.keys()) if (!now.has(id)) out.push({ type: 'allowance.changed', data: { id, remaining: '0' } });
  return out;
}

/**
 * Syncs every `pollMs` while the hub has at least one subscriber, and emits what changed. One sync at a time; a
 * failed sync is logged (host only, by the caller's snapshot function) and retried on the next tick.
 */
export class BalanceWatcher {
  private timer?: NodeJS.Timeout;
  private running = false;
  private last?: Snapshot;

  constructor(private readonly hub: EventHub, private readonly snapshot: () => Promise<Snapshot>, private readonly pollMs: number, private readonly log: (line: string) => void = () => {}) {
    hub.onSubscribers(() => this.update());
  }

  private update(): void {
    if (this.hub.subscribers > 0 && !this.timer) {
      this.timer = setInterval(() => { void this.tick(); }, this.pollMs);
      this.timer.unref?.();
      void this.tick();
    } else if (this.hub.subscribers === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const cur = await this.snapshot();
      for (const e of diffSnapshots(this.last, cur)) this.hub.emit(e.type, e.data);
      this.last = cur;
    } catch (e) {
      this.log(`events: sync failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
