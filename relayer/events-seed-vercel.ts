// Serverless entry for the seed snapshot (relayer/events-seed.ts): its own function, so it runs without the
// relayer's hot key and setup. Bundled by scripts/relayer-vercel.mjs into deploy/relayer-vercel/api/events-seed.mjs;
// the hourly cron is declared in that project's vercel.json.
//
// Environment (the relayer project's): EVENTS_SEED_RPC (optional: an RPC that has the pool's whole history, so the
// cron can build the snapshot from nothing; without it RELAYER_SOLANA_RPC, read only here, which can only extend
// a stored snapshot when it keeps just the last days), RELAYER_SOLANA_PROGRAM_ID (default the
// mainnet pool), EVENTS_SEED_CLUSTER (default mainnet-beta), CRON_SECRET (Vercel sends it to the cron), and
// BLOB_READ_WRITE_TOKEN (set by connecting a public Vercel Blob store to the project).
//
// A full snapshot can ship with the deployment as seed/<cluster>-<pool>.events.json next to api/ (vercel.json
// includeFiles; scripts/relayer-vercel.mjs copies it from RELAYER_SEED_DIR): the cron starts from it when the
// stored snapshot is missing or unusable, which needs no secret and no RPC with the whole history. It only
// helps while the RPC still has the transaction it ends at, so ship a recent one.
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlobNotFoundError, head, put } from '@vercel/blob';
import { Connection, PublicKey } from '@solana/web3.js';
import { MAINNET } from '../integrations/core/constants.js';
import { createSeedHandler, seedFileName, type SeedStore } from './events-seed.js';

const store: SeedStore = {
  async url(path) {
    try { return (await head(path)).url; } catch (e) { if (e instanceof BlobNotFoundError) return undefined; throw e; }
  },
  async read(path) {
    const url = await this.url(path);
    if (!url) return undefined;
    // the stored copy itself, not a CDN copy older than the last write
    const res = await fetch(url, { cache: 'no-store', headers: { 'cache-control': 'no-cache' } });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`reading the stored snapshot: HTTP ${res.status}`);
    return res.text();
  },
  async write(path, body) {
    const r = await put(path, body, {
      access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json',
      // the snapshot is ~20 MB (multipart, 5 min of CDN cache); the status file is tiny and must read fresh
      cacheControlMaxAge: body.length > 1_000_000 ? 300 : 60, multipart: body.length > 5_000_000,
    });
    return r.url;
  },
};

let handler: ReturnType<typeof createSeedHandler> | undefined;

export default async function events(req: IncomingMessage, res: ServerResponse) {
  if (!handler) {
    const rpc = process.env.EVENTS_SEED_RPC || process.env.RELAYER_SOLANA_RPC;
    if (!rpc) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: { code: 'service_disabled', message: 'RELAYER_SOLANA_RPC is not set' } }));
    }
    const programId = new PublicKey(process.env.RELAYER_SOLANA_PROGRAM_ID || MAINNET.programs.pool);
    const cluster = process.env.EVENTS_SEED_CLUSTER || 'mainnet-beta';
    const shipped = join(dirname(fileURLToPath(import.meta.url)), '..', 'seed', seedFileName(cluster, programId));
    handler = createSeedHandler({
      store,
      connection: new Connection(rpc, 'confirmed'),
      programId,
      cluster,
      cronSecret: process.env.CRON_SECRET || undefined,
      log: (l) => console.log(l),
      bootstrap: async () => (existsSync(shipped) ? readFileSync(shipped, 'utf8') : undefined),
    });
  }
  return handler(req, res);
}
