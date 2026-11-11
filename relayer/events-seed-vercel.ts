// Serverless entry for the seed snapshot (relayer/events-seed.ts): its own function, so it runs without the
// relayer's hot key and setup. Bundled by scripts/relayer-vercel.mjs into deploy/relayer-vercel/api/events-seed.mjs;
// the hourly cron is declared in that project's vercel.json.
//
// Environment (the relayer project's): RELAYER_SOLANA_RPC (read only here), RELAYER_SOLANA_PROGRAM_ID (default the
// mainnet pool), EVENTS_SEED_CLUSTER (default mainnet-beta), CRON_SECRET (Vercel sends it to the cron), and
// BLOB_READ_WRITE_TOKEN (set by connecting a public Vercel Blob store to the project).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BlobNotFoundError, head, put } from '@vercel/blob';
import { Connection, PublicKey } from '@solana/web3.js';
import { MAINNET } from '../integrations/core/constants.js';
import { createSeedHandler, type SeedStore } from './events-seed.js';

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
      access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 300, multipart: true,
    });
    return r.url;
  },
};

let handler: ReturnType<typeof createSeedHandler> | undefined;

export default async function events(req: IncomingMessage, res: ServerResponse) {
  if (!handler) {
    const rpc = process.env.RELAYER_SOLANA_RPC;
    if (!rpc) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: { code: 'service_disabled', message: 'RELAYER_SOLANA_RPC is not set' } }));
    }
    handler = createSeedHandler({
      store,
      connection: new Connection(rpc, 'confirmed'),
      programId: new PublicKey(process.env.RELAYER_SOLANA_PROGRAM_ID || MAINNET.programs.pool),
      cluster: process.env.EVENTS_SEED_CLUSTER || 'mainnet-beta',
      cronSecret: process.env.CRON_SECRET || undefined,
      log: (l) => console.log(l),
    });
  }
  return handler(req, res);
}
