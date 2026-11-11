// The pool's public event-log snapshot that a fresh MCP / agent install starts from (integrations/core
// EVENTS_SEED_URL), kept fresh by a cron and served as a redirect to public storage.
//
//   GET /events/<cluster>-<pool>.events.json  307 to the stored snapshot (public; any other name is 404)
//   GET /events/status                        when the cron last succeeded and what it stored (public JSON);
//                                             scripts/seed-watch.mjs fails when it is older than 3 hours
//   GET /api/events-seed                      the cron: extends the stored snapshot with the pool's newer
//                                             transactions and stores it again (Authorization: Bearer <CRON_SECRET>)
//
// The snapshot holds public chain data only (commitments, nullifiers, encrypted memos) and is built from this
// relayer's own RPC. Clients do not trust it: they check the commitment tree against the pool's on-chain root
// history and their own notes against the nullifier accounts, and scan from the start when it does not match.
// Without it a fresh install must fetch every pool transaction since launch (thousands), which the public RPC
// answers with 429. Storage is injected (Vercel Blob in events-seed-vercel.ts) so this is testable.
//
// A run that cannot finish in its time budget (a slow or rate-limited RPC, the first build) stores what it has:
// a snapshot that ends earlier is still a valid seed, and the next run continues from it. A run never fails
// for being slow, so the snapshot cannot stay stuck behind one long scan.
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connection, PublicKey } from '@solana/web3.js';
import { PoolEventLog, type PoolEventLogSnapshot } from '../src/solana/events.js';
import { header, json } from './http.js';

export interface SeedStore {
  /** the public URL of a stored object, or undefined when there is none */
  url(path: string): Promise<string | undefined>;
  /** the stored object's text, or undefined when there is none */
  read(path: string): Promise<string | undefined>;
  /** stores `body` (public, overwriting) and returns its public URL */
  write(path: string, body: string): Promise<string>;
}

export interface SeedOptions {
  store: SeedStore;
  connection: Connection;
  programId: PublicKey;
  cluster: string;
  /** the cron's bearer secret; unset = the cron route answers 503 (it never runs unauthenticated) */
  cronSecret?: string;
  /** how long one run may scan before it stores what it has, in ms. Default 200 s (the function has 300 s). */
  budgetMs?: number;
  /** the clock, for tests */
  now?: () => number;
  log?: (line: string) => void;
}

/** The file name the clients ask for (integrations/core/constants.ts eventsSeedUrl). */
export const seedFileName = (cluster: string, programId: PublicKey) => `${cluster}-${programId.toBase58()}.events.json`;
const seedPath = (o: SeedOptions) => `events/${seedFileName(o.cluster, o.programId)}`;
const statusPath = (o: SeedOptions) => `events/${seedFileName(o.cluster, o.programId)}.status.json`;

export interface SeedRefresh { stored: boolean; added: number; events: number; bytes: number; newest?: string; url?: string; partial: boolean }

/** What the last runs did (events/<file>.status.json; served by GET /events/status with its age). */
export interface SeedStatus {
  v: 1;
  file: string;
  /** when a run last completed (ISO); `partial` = it ran out of time and the next run continues */
  okAt?: string;
  newest?: string;
  events?: number;
  bytes?: number;
  partial?: boolean;
  /** the last failed run, when it is more recent than okAt */
  errorAt?: string;
  error?: string;
}

class OutOfTime extends Error {}

/**
 * Extends the stored snapshot (or builds one when there is none, or the stored one is not this pool's) with the
 * pool's newer transactions, and stores it when anything changed. Stops scanning at the time budget and stores
 * what it has (`partial`).
 */
export async function refreshSeed(o: SeedOptions): Promise<SeedRefresh> {
  const now = o.now ?? Date.now;
  const started = now();
  const budget = o.budgetMs ?? 200_000;
  // progress is reported after each committed chunk: stopping there loses nothing
  const log = new PoolEventLog(o.connection, o.programId, { onProgress: () => { if (now() - started > budget) throw new OutOfTime(); } });
  const prev = await o.store.read(seedPath(o));
  let prevNewest: string | undefined;
  if (prev !== undefined) {
    let snap: PoolEventLogSnapshot | undefined;
    try { snap = JSON.parse(prev); } catch { /* rebuilt below */ }
    if (snap && log.restore(snap)) prevNewest = snap.newest;
    else o.log?.('events-seed: the stored snapshot is unreadable or another pool\'s; rebuilding it');
  }
  const before = log.events.length;
  let partial = false;
  try {
    await log.refresh();
  } catch (e) {
    if (!(e instanceof OutOfTime)) throw e;
    partial = true;
  }
  const added = log.events.length - before;
  const snap = log.snapshot();
  const body = JSON.stringify(snap);
  const result: SeedRefresh = { stored: false, added, events: log.events.length, bytes: body.length, newest: snap.newest, partial };
  // nothing to store: no transaction yet, or the stored copy already ends at the same one
  if (snap.newest !== undefined && !(prev !== undefined && prevNewest !== undefined && snap.newest === prevNewest)) {
    result.url = await o.store.write(seedPath(o), body);
    result.stored = true;
    o.log?.(`events-seed: stored ${log.events.length} events (${added} new, ${(body.length / 1e6).toFixed(2)} MB${partial ? ', out of time: the next run continues' : ''})`);
  }
  return result;
}

async function readStatus(o: SeedOptions): Promise<SeedStatus | undefined> {
  try {
    const text = await o.store.read(statusPath(o));
    const s = text === undefined ? undefined : (JSON.parse(text) as SeedStatus);
    return s?.v === 1 ? s : undefined;
  } catch { return undefined; }
}

/** One cron run: refresh, then record the outcome (also a failure, so the status says why the snapshot is old). */
export async function runSeedCron(o: SeedOptions): Promise<SeedRefresh> {
  const at = new Date((o.now ?? Date.now)()).toISOString();
  const file = seedFileName(o.cluster, o.programId);
  try {
    const r = await refreshSeed(o);
    await o.store.write(statusPath(o), JSON.stringify({ v: 1, file, okAt: at, newest: r.newest, events: r.events, bytes: r.bytes, partial: r.partial } satisfies SeedStatus));
    return r;
  } catch (e) {
    const prev = await readStatus(o);
    const status: SeedStatus = { ...(prev ?? { v: 1, file }), errorAt: at, error: (e as Error).message.slice(0, 300) };
    try { await o.store.write(statusPath(o), JSON.stringify(status)); } catch { /* the store itself is down */ }
    throw e;
  }
}

const bearerMatches = (got: string | undefined, secret: string) => {
  const a = Buffer.from(got ?? '');
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** The routes above as a node:http handler; anything else is 404. */
export function createSeedHandler(o: SeedOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: { code: 'method_not_allowed', message: 'GET only' } }, { allow: 'GET, HEAD' });
      if (path === '/api/events-seed') {
        if (!o.cronSecret) return json(res, 503, { error: { code: 'service_disabled', message: 'the seed cron is not configured (CRON_SECRET)' } });
        if (!bearerMatches(header(req, 'authorization'), o.cronSecret)) return json(res, 401, { error: { code: 'unauthorized', message: 'cron only' } });
        return json(res, 200, await runSeedCron(o));
      }
      if (path === '/events/status') {
        const s = await readStatus(o);
        if (!s) return json(res, 404, { error: { code: 'not_found', message: 'the seed cron has not run yet' } });
        const ageSeconds = s.okAt ? Math.max(0, Math.round(((o.now ?? Date.now)() - Date.parse(s.okAt)) / 1000)) : null;
        const failing = !!s.errorAt && (!s.okAt || s.errorAt > s.okAt);
        return json(res, 200, { ...s, ageSeconds, failing }, { 'cache-control': 'public, max-age=60' });
      }
      const m = /^\/events\/([^/]+)$/.exec(path);
      if (m && m[1] === seedFileName(o.cluster, o.programId)) {
        const url = await o.store.url(seedPath(o));
        if (!url) return json(res, 404, { error: { code: 'not_found', message: 'no snapshot yet; scan from the start' } }, { 'cache-control': 'public, max-age=60' });
        res.writeHead(307, { location: url, 'cache-control': 'public, max-age=60, s-maxage=60' });
        return void res.end();
      }
      return json(res, 404, { error: { code: 'not_found', message: `no route ${path}` } });
    } catch (e) {
      o.log?.(`events-seed: ${(e as Error).message}`);
      return json(res, 502, { error: { code: 'unavailable', message: 'the snapshot store or the RPC failed; try again later' } });
    }
  };
}
