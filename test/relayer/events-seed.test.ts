// The relayer's seed snapshot (relayer/events-seed.ts): the cron extends the stored snapshot incrementally and
// stores it only when it changed, only with the cron secret; GET /events/<file> redirects to the stored copy.
// Nothing is stored that is not the pool's history from its first commitment, matching the pool's root history.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { initCrypto } from '../../src/crypto.js';
import { MerkleTree } from '../../src/merkle.js';
import { EVENT_IX_TAG_LE, PoolEventLog } from '../../src/solana/events.js';
import { be32, concatBytes } from '../../src/solana/field.js';
import { LEVELS, POOL_DISCRIMINATOR, POOL_SIZE } from '../../src/solana/program.js';
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

beforeAll(() => initCrypto());

const u32le = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const commitmentEvent = (c: bigint, index: number) => concatBytes(EVENT_IX_TAG_LE, sha256(new TextEncoder().encode('event:NewCommitment')).subarray(0, 8), be32(c), u32le(index), u32le(0));
/** A Pool account holding `leaves`, its current root at slot 3 of the root history. */
function poolAccount(leaves: bigint[]) {
  const tree = new MerkleTree(LEVELS);
  for (const l of leaves) tree.insert(l);
  const data = new Uint8Array(POOL_SIZE);
  data.set(POOL_DISCRIMINATOR, 0);
  data.set(u32le(leaves.length), 8);
  data.set(u32le(3), 12);
  data.set(be32(tree.root), 16 + 32 * LEVELS + 32 * 3);
  return { data };
}

class FakeRpc {
  txs: Array<{ signature: string; nullifier: bigint; commitment?: number }> = [];
  fetched = 0;
  /** the oldest transactions the RPC no longer has (a node that keeps only recent history) */
  forgotten = 0;
  /** the Pool account; unset = derived from the commitments added so far */
  pool?: { data: Uint8Array } | null;
  accountReads = 0;
  add(signature: string, nullifier: bigint) { this.txs.push({ signature, nullifier }); }
  /** a transaction that inserts commitment number `index` (its value is 1000 + index) */
  addCommitment(signature: string, index: number) { this.txs.push({ signature, nullifier: 0n, commitment: index }); }
  leaves(upTo = Infinity) { return this.txs.filter((t) => t.commitment !== undefined && t.commitment < upTo).map((t) => 1000n + BigInt(t.commitment!)); }
  async getAccountInfo() {
    this.accountReads++;
    if (this.pool !== undefined) return this.pool;
    return this.leaves().length ? poolAccount(this.leaves()) : null;
  }
  async getSignaturesForAddress(_a: PublicKey, o: { until?: string }) {
    const newestFirst = this.txs.slice(this.forgotten).reverse();
    const stop = o.until ? newestFirst.findIndex((t) => t.signature === o.until) : -1;
    return (stop >= 0 ? newestFirst.slice(0, stop) : newestFirst).map((t) => ({ signature: t.signature, err: null, slot: 1, blockTime: null, memo: null }));
  }
  async getTransaction(signature: string) {
    this.fetched++;
    const t = this.txs.find((x) => x.signature === signature)!;
    return {
      slot: 1,
      transaction: { message: { staticAccountKeys: [programId] } },
      meta: { err: null, innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 0, accounts: [], data: base58(t.commitment === undefined ? nullifierEvent(t.nullifier) : commitmentEvent(1000n + BigInt(t.commitment), t.commitment)) }] }] },
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
  store, connection: rpc as unknown as Connection, programId, cluster: 'mainnet-beta', cronSecret: 's3cret', recheckDelayMs: 0, ...over,
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

describe('only the pool\'s whole history is stored', () => {
  const full = (n: number) => { const rpc = new FakeRpc(); for (let i = 0; i < n; i++) rpc.addCommitment(`C${i}`, i); return rpc; };

  it('an RPC that keeps only recent history: nothing is stored and the status says why', async () => {
    const rpc = full(6);
    rpc.forgotten = 2; // its oldest transaction is commitment 2
    const store = new MemStore();
    await expect(refreshSeed(opts(rpc, store))).rejects.toThrow(/only part of the pool's history \(its first commitment is number 2, not 0\).*EVENTS_SEED_RPC/);
    expect(store.files.has(file())).toBe(false);
    await expect(runSeedCron(opts(rpc, store))).rejects.toThrow(/only part/);
    const status = JSON.parse(store.files.get(`${file()}.status.json`)!);
    expect(status.error).toMatch(/first commitment is number 2/);
    expect(status.okAt).toBeUndefined();
    expect(status.verified).toBeUndefined();
  });

  it('a stored snapshot that starts late is rebuilt from the start, not extended', async () => {
    const rpc = full(6);
    const store = new MemStore();
    rpc.forgotten = 2;
    // what the cron of 2026-11-12 stored: a log that begins at the RPC's oldest transaction
    const late = new FakeRpc();
    late.txs = rpc.txs.slice(2, 4);
    const log = new PoolEventLog(late as unknown as Connection, programId);
    await log.refresh();
    store.files.set(file(), JSON.stringify(log.snapshot()));
    // still no full history: reported, the stored copy untouched
    await expect(refreshSeed(opts(rpc, store))).rejects.toThrow(/only part/);
    expect(JSON.parse(store.files.get(file())!).events).toHaveLength(2);
    // an RPC with the whole history: rebuilt from commitment 0
    rpc.forgotten = 0;
    const lines: string[] = [];
    expect(await refreshSeed(opts(rpc, store, { log: (l) => lines.push(l) }))).toMatchObject({ stored: true, events: 6, added: 6, newest: 'C5' });
    expect(lines.join('\n')).toMatch(/not the pool's whole history \(its first commitment is number 2, not 0\); rebuilding/);
    expect(JSON.parse(store.files.get(file())!).events[0].index).toBe(0);
  });

  it('a full snapshot uploaded once is extended by an RPC that keeps only recent history', async () => {
    const rpc = full(4);
    const store = new MemStore();
    await runSeedCron(opts(rpc, store));
    rpc.addCommitment('C4', 4);
    rpc.addCommitment('C5', 5);
    rpc.forgotten = 3; // it still has the stored snapshot's newest transaction and what follows
    expect(await runSeedCron(opts(rpc, store))).toMatchObject({ stored: true, added: 2, events: 6 });
    expect(JSON.parse(store.files.get(`${file()}.status.json`)!)).toMatchObject({ events: 6, verified: true });
    // once it has lost the transaction the snapshot ends at, the hole is seen and nothing is stored
    for (let i = 6; i < 10; i++) rpc.addCommitment(`C${i}`, i);
    rpc.forgotten = 8;
    await expect(runSeedCron(opts(rpc, store))).rejects.toThrow(/only part of the pool's history \(commitment 6 is missing/);
    expect(JSON.parse(store.files.get(file())!).events).toHaveLength(6);
  });

  it('with no usable stored snapshot the run starts from the one shipped with the deployment', async () => {
    const rpc = full(6);
    // the shipped snapshot: the pool's first 4 commitments
    const early = new FakeRpc();
    early.txs = rpc.txs.slice(0, 4);
    const built = new PoolEventLog(early as unknown as Connection, programId);
    await built.refresh();
    const shipped = JSON.stringify(built.snapshot());
    rpc.forgotten = 3; // the RPC alone could not build the history
    const fetchedBefore = rpc.fetched;
    // nothing stored yet
    const store = new MemStore();
    const lines: string[] = [];
    expect(await refreshSeed(opts(rpc, store, { bootstrap: async () => shipped, log: (l) => lines.push(l) }))).toMatchObject({ stored: true, added: 2, events: 6, newest: 'C5' });
    expect(rpc.fetched - fetchedBefore).toBe(2);
    expect(lines.join('\n')).toMatch(/starting from the snapshot shipped with this deployment \(4 events\)/);
    // a stored snapshot that starts late (the 2026-11-12 one) is replaced through it too
    const late = new FakeRpc();
    late.txs = rpc.txs.slice(3, 5);
    const lateLog = new PoolEventLog(late as unknown as Connection, programId);
    await lateLog.refresh();
    const store2 = new MemStore();
    store2.files.set(file(), JSON.stringify(lateLog.snapshot()));
    expect(await refreshSeed(opts(rpc, store2, { bootstrap: async () => shipped }))).toMatchObject({ stored: true, events: 6 });
    expect(JSON.parse(store2.files.get(file())!).events[0].index).toBe(0);
    // a good stored snapshot is used as it is: the shipped one is not read
    let asked = 0;
    expect(await refreshSeed(opts(rpc, store2, { bootstrap: async () => { asked++; return shipped; } }))).toMatchObject({ stored: false, added: 0, events: 6 });
    expect(asked).toBe(0);
    // a shipped snapshot that itself starts late, or is broken, is ignored: the run fails as without it
    for (const bad of [JSON.stringify(lateLog.snapshot()), '{broken']) {
      await expect(refreshSeed(opts(rpc, new MemStore(), { bootstrap: async () => bad }))).rejects.toThrow(/only part of the pool's history/);
    }
    // too old for the RPC (it no longer has the transaction the shipped snapshot ends at): the hole is seen
    rpc.forgotten = 5;
    await expect(refreshSeed(opts(rpc, new MemStore(), { bootstrap: async () => shipped }))).rejects.toThrow(/commitment 4 is missing/);
  });

  it('a log whose tree the pool never committed is not stored; a pool read that is behind is read again', async () => {
    const rpc = full(3);
    const store = new MemStore();
    rpc.pool = poolAccount([1n, 2n, 3n]); // another pool's leaves
    await expect(refreshSeed(opts(rpc, store))).rejects.toThrow(/does not match the pool on chain \(the root of its 3 commitments is not in the pool's root history/);
    rpc.pool = poolAccount(rpc.leaves(2)); // the pool as it was one commitment ago
    await expect(refreshSeed(opts(rpc, store))).rejects.toThrow(/it has 3 commitments, the pool 2/);
    expect(store.writes).toBe(0);
    // the account read lags the transaction list once, then catches up
    const behind = poolAccount(rpc.leaves(2));
    rpc.pool = undefined;
    const read = rpc.getAccountInfo.bind(rpc);
    let reads = 0;
    rpc.getAccountInfo = async () => (reads++ === 0 ? behind : read());
    expect(await refreshSeed(opts(rpc, store))).toMatchObject({ stored: true, events: 3 });
    expect(reads).toBe(2);
  });

  it('a run that is out of time is checked for holes only: its tree may be older than the pool\'s root history', async () => {
    const rpc = full(60);
    const store = new MemStore();
    rpc.pool = poolAccount([9n]); // would fail the root check
    let t = 0;
    expect(await refreshSeed(opts(rpc, store, { budgetMs: 10, now: () => (t += 20) }))).toMatchObject({ stored: true, partial: true, events: 25 });
    expect(rpc.accountReads).toBe(0);
    rpc.pool = undefined;
    expect(await refreshSeed(opts(rpc, store))).toMatchObject({ stored: true, partial: false, events: 60 });
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
      expect(await (await fetch(`${base}/events/status`)).json()).toMatchObject({ okAt: '2026-11-12T00:00:00.000Z', newest: 'S1', events: 1, partial: false, verified: true, ageSeconds: 5400, failing: false });
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
