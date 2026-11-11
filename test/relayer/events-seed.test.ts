// The relayer's seed snapshot (relayer/events-seed.ts): the cron extends the stored snapshot incrementally and
// stores it only when it changed, only with the cron secret; GET /events/<file> redirects to the stored copy.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { EVENT_IX_TAG_LE } from '../../src/solana/events.js';
import { be32, concatBytes } from '../../src/solana/field.js';
import { createSeedHandler, refreshSeed, runSeedCron, seedFileName, type SeedOptions, type SeedStore } from '../../relayer/events-seed.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Uint8Array): string {
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  let s = '';
  while (x > 0n) { s = B58[Number(x % 58n)] + s; x /= 58n; }
  for (const b of bytes) { if (b === 0) s = '1' + s; else break; }
  return s;
}
const programId = Keypair.generate().publicKey;
const nullifierEvent = (n: bigint) => concatBytes(EVENT_IX_TAG_LE, sha256(new TextEncoder().encode('event:NewNullifier')).subarray(0, 8), be32(n));

class FakeRpc {
  txs: Array<{ signature: string; nullifier: bigint }> = [];
  fetched = 0;
  add(signature: string, nullifier: bigint) { this.txs.push({ signature, nullifier }); }
  async getSignaturesForAddress(_a: PublicKey, o: { until?: string }) {
    const newestFirst = [...this.txs].reverse();
    const stop = o.until ? newestFirst.findIndex((t) => t.signature === o.until) : -1;
    return (stop >= 0 ? newestFirst.slice(0, stop) : newestFirst).map((t) => ({ signature: t.signature, err: null, slot: 1, blockTime: null, memo: null }));
  }
  async getTransaction(signature: string) {
    this.fetched++;
    const t = this.txs.find((x) => x.signature === signature)!;
    return {
      slot: 1,
      transaction: { message: { staticAccountKeys: [programId] } },
      meta: { err: null, innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 0, accounts: [], data: base58(nullifierEvent(t.nullifier)) }] }] },
    };
  }
}

class MemStore implements SeedStore {
  files = new Map<string, string>();
  writes = 0;
  async url(path: string) { return this.files.has(path) ? `https://blob.test/${path}` : undefined; }
  async read(path: string) { return this.files.get(path); }
  async write(path: string, body: string) { this.writes++; this.files.set(path, body); return `https://blob.test/${path}`; }
}

const opts = (rpc: FakeRpc, store: MemStore, over: Partial<SeedOptions> = {}): SeedOptions => ({
  store, connection: rpc as unknown as Connection, programId, cluster: 'mainnet-beta', cronSecret: 's3cret', ...over,
});
const file = () => `events/${seedFileName('mainnet-beta', programId)}`;

describe('refreshSeed', () => {
  it('builds the snapshot, then extends it with only the newer transactions; nothing new = nothing stored', async () => {
    const rpc = new FakeRpc();
    const store = new MemStore();
    for (let i = 1; i <= 3; i++) rpc.add(`S${i}`, BigInt(i));
    expect(await refreshSeed(opts(rpc, store))).toMatchObject({ stored: true, added: 3, events: 3, newest: 'S3' });
    expect(rpc.fetched).toBe(3);
    rpc.add('S4', 4n);
    expect(await refreshSeed(opts(rpc, store))).toMatchObject({ stored: true, added: 1, events: 4, newest: 'S4' });
    expect(rpc.fetched).toBe(4); // only S4 was fetched
    expect(await refreshSeed(opts(rpc, store))).toMatchObject({ stored: false, added: 0, events: 4 });
    expect(store.writes).toBe(2);
    expect(JSON.parse(store.files.get(file())!).events).toHaveLength(4);
  });

  it('a stored snapshot that is unreadable or another pool\'s is rebuilt', async () => {
    const rpc = new FakeRpc();
    rpc.add('S1', 1n);
    const store = new MemStore();
    store.files.set(file(), '{broken');
    expect(await refreshSeed(opts(rpc, store))).toMatchObject({ stored: true, events: 1 });
    store.files.set(file(), JSON.stringify({ v: 1, programId: Keypair.generate().publicKey.toBase58(), events: [] }));
    expect(await refreshSeed(opts(rpc, store))).toMatchObject({ stored: true, events: 1 });
  });
});

describe('time budget and status', () => {
  it('a run that is out of time stores what it has; the next run continues and finishes', async () => {
    const rpc = new FakeRpc();
    const store = new MemStore();
    for (let i = 1; i <= 60; i++) rpc.add(`S${i}`, BigInt(i));
    let t = 0;
    const o = opts(rpc, store, { budgetMs: 10, now: () => (t += 20) }); // out of time after the first chunk of 25
    expect(await refreshSeed(o)).toMatchObject({ stored: true, partial: true, events: 25, newest: 'S25' });
    expect(await refreshSeed(opts(rpc, store))).toMatchObject({ stored: true, partial: false, events: 60, newest: 'S60' });
    expect(rpc.fetched).toBe(60); // nothing fetched twice
  });

  it('the cron records each outcome; /events/status reports its age and a failure after the last success', async () => {
    const rpc = new FakeRpc();
    rpc.add('S1', 1n);
    const store = new MemStore();
    let now = Date.parse('2026-11-12T00:00:00Z');
    const o = opts(rpc, store, { now: () => now });
    await runSeedCron(o);
    const server = createServer(createSeedHandler(o));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      now += 90 * 60_000;
      expect(await (await fetch(`${base}/events/status`)).json()).toMatchObject({ okAt: '2026-11-12T00:00:00.000Z', newest: 'S1', events: 1, partial: false, ageSeconds: 5400, failing: false });
      rpc.getSignaturesForAddress = async () => { throw new Error('rpc down'); };
      await expect(runSeedCron(o)).rejects.toThrow(/rpc down/);
      expect(await (await fetch(`${base}/events/status`)).json()).toMatchObject({ okAt: '2026-11-12T00:00:00.000Z', error: 'rpc down', failing: true });
    } finally { server.close(); }
  });

  it('/events/status before any run is 404', async () => {
    const server = createServer(createSeedHandler(opts(new FakeRpc(), new MemStore())));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try { expect((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/events/status`)).status).toBe(404); } finally { server.close(); }
  });
});

describe('seed routes', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());
  async function serve(o: SeedOptions) {
    server = createServer(createSeedHandler(o));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('the cron needs the secret; with it, it refreshes', async () => {
    const rpc = new FakeRpc();
    rpc.add('S1', 1n);
    const store = new MemStore();
    const base = await serve(opts(rpc, store));
    expect((await fetch(`${base}/api/events-seed`)).status).toBe(401);
    expect((await fetch(`${base}/api/events-seed`, { headers: { authorization: 'Bearer wrong!' } })).status).toBe(401);
    const ok = await fetch(`${base}/api/events-seed`, { headers: { authorization: 'Bearer s3cret' } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ stored: true, events: 1 });
  });

  it('without CRON_SECRET the cron never runs', async () => {
    const base = await serve(opts(new FakeRpc(), new MemStore(), { cronSecret: undefined }));
    const r = await fetch(`${base}/api/events-seed`, { headers: { authorization: 'Bearer ' } });
    expect(r.status).toBe(503);
  });

  it('GET /events/<this pool\'s file> redirects to the stored copy; other names and a missing copy are 404', async () => {
    const store = new MemStore();
    const base = await serve(opts(new FakeRpc(), store));
    const name = seedFileName('mainnet-beta', programId);
    expect((await fetch(`${base}/events/${name}`, { redirect: 'manual' })).status).toBe(404);
    store.files.set(`events/${name}`, '{}');
    const r = await fetch(`${base}/events/${name}`, { redirect: 'manual' });
    expect(r.status).toBe(307);
    expect(r.headers.get('location')).toBe(`https://blob.test/events/${name}`);
    expect((await fetch(`${base}/events/other.events.json`, { redirect: 'manual' })).status).toBe(404);
    expect((await fetch(`${base}/events/${name}`, { method: 'POST' })).status).toBe(405);
  });
});
