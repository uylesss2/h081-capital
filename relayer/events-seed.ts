// The pool's public event-log snapshot that a fresh MCP / agent install starts from (integrations/core
// EVENTS_SEED_URL), kept fresh by a cron and served as a redirect to public storage.
//
//   GET /events/<cluster>-<pool>.events.json  307 to the stored snapshot (public; any other name is 404)
//   GET /api/events-seed                      the cron: extends the stored snapshot with the pool's newer
//                                             transactions and stores it again (Authorization: Bearer <CRON_SECRET>)
//
// The snapshot holds public chain data only (commitments, nullifiers, encrypted memos) and is built from this
// relayer's own RPC. Clients do not trust it: they check the commitment tree against the pool's on-chain root
// history and their own notes against the nullifier accounts, and scan from the start when it does not match.
// Without it a fresh install must fetch every pool transaction since launch (thousands), which the public RPC
// answers with 429. Storage is injected (Vercel Blob in events-seed-vercel.ts) so this is testable.
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
  log?: (line: string) => void;
}

/** The file name the clients ask for (integrations/core/constants.ts eventsSeedUrl). */
export const seedFileName = (cluster: string, programId: PublicKey) => `${cluster}-${programId.toBase58()}.events.json`;
const seedPath = (o: SeedOptions) => `events/${seedFileName(o.cluster, o.programId)}`;

export interface SeedRefresh { stored: boolean; added: number; events: number; bytes: number; newest?: string; url?: string }

/**
 * Extends the stored snapshot (or builds one when there is none, or the stored one is not this pool's) with the
 * pool's newer transactions, and stores it when anything changed.
 */
export async function refreshSeed(o: SeedOptions): Promise<SeedRefresh> {
  const log = new PoolEventLog(o.connection, o.programId);
  const prev = await o.store.read(seedPath(o));
  let prevNewest: string | undefined;
  if (prev !== undefined) {
    let snap: PoolEventLogSnapshot | undefined;
    try { snap = JSON.parse(prev); } catch { /* rebuilt below */ }
    if (snap && log.restore(snap)) prevNewest = snap.newest;
    else o.log?.('events-seed: the stored snapshot is unreadable or another pool\'s; rebuilding it');
  }
  const added = await log.refresh();
  const snap = log.snapshot();
  const body = JSON.stringify(snap);
  if (prev !== undefined && prevNewest !== undefined && snap.newest === prevNewest) {
    return { stored: false, added, events: log.events.length, bytes: body.length, newest: snap.newest };
  }
  const url = await o.store.write(seedPath(o), body);
  o.log?.(`events-seed: stored ${log.events.length} events (${added} new, ${(body.length / 1e6).toFixed(2)} MB)`);
  return { stored: true, added, events: log.events.length, bytes: body.length, newest: snap.newest, url };
}

const bearerMatches = (got: string | undefined, secret: string) => {
  const a = Buffer.from(got ?? '');
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** The two routes above as a node:http handler; anything else is 404. */
export function createSeedHandler(o: SeedOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: { code: 'method_not_allowed', message: 'GET only' } }, { allow: 'GET, HEAD' });
      if (path === '/api/events-seed') {
        if (!o.cronSecret) return json(res, 503, { error: { code: 'service_disabled', message: 'the seed cron is not configured (CRON_SECRET)' } });
        if (!bearerMatches(header(req, 'authorization'), o.cronSecret)) return json(res, 401, { error: { code: 'unauthorized', message: 'cron only' } });
        return json(res, 200, await refreshSeed(o));
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
