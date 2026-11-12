// PoolEventLog.refresh against a scripted RPC (no validator): a transaction that is not yet available, or
// an RPC error, must not make the log skip events; concurrent refreshes must not duplicate them.
import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { EVENT_IX_TAG_LE, PoolEventLog, isRateLimited } from '../../src/solana/events.js';
import { be32, concatBytes } from '../../src/solana/field.js';

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

/** A fake chain: signatures newest first; transactions emit one NewNullifier each; `missing` ones return null. */
class FakeRpc {
  txs: Array<{ signature: string; nullifier: bigint }> = [];
  missing = new Set<string>();
  failSignatures = false;
  calls = 0;
  add(signature: string, nullifier: bigint) { this.txs.push({ signature, nullifier }); }
  async getSignaturesForAddress(_a: PublicKey, o: { until?: string }) {
    this.calls++;
    if (this.failSignatures) throw new Error('rpc down');
    const newestFirst = [...this.txs].reverse();
    const stop = o.until ? newestFirst.findIndex((t) => t.signature === o.until) : -1;
    return (stop >= 0 ? newestFirst.slice(0, stop) : newestFirst).map((t) => ({ signature: t.signature, err: null, slot: 1, blockTime: null, memo: null }));
  }
  async getTransaction(signature: string) {
    await new Promise((r) => setTimeout(r, 2));
    if (this.missing.has(signature)) return null;
    const t = this.txs.find((x) => x.signature === signature)!;
    return {
      slot: 1,
      transaction: { message: { staticAccountKeys: [programId] } },
      meta: { err: null, innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 0, accounts: [], data: base58(nullifierEvent(t.nullifier)) }] }] },
    };
  }
}

const nullifiers = (log: PoolEventLog) => log.events.map((e) => (e as { nullifier: bigint }).nullifier);

describe('PoolEventLog.refresh', () => {
  it('a transaction that is not available yet fails the refresh without losing anything; the next refresh gets it all', async () => {
    const rpc = new FakeRpc();
    const log = new PoolEventLog(rpc as unknown as Connection, programId, { fetchAttempts: 2, retryDelayMs: 1 });
    rpc.add('A', 1n);
    rpc.add('B', 2n);
    rpc.missing.add('B');
    await expect(log.refresh()).rejects.toThrow(/not found/);
    expect(log.events).toHaveLength(0); // nothing half-committed
    rpc.missing.clear();
    expect(await log.refresh()).toBe(2);
    expect(nullifiers(log)).toEqual([1n, 2n]);
    expect(await log.refresh()).toBe(0);
  });

  it('retries a null getTransaction before giving up', async () => {
    const rpc = new FakeRpc();
    const log = new PoolEventLog(rpc as unknown as Connection, programId, { fetchAttempts: 5, retryDelayMs: 5 });
    rpc.add('A', 1n);
    rpc.missing.add('A');
    setTimeout(() => rpc.missing.clear(), 8);
    expect(await log.refresh()).toBe(1);
    expect(nullifiers(log)).toEqual([1n]);
  });

  it('an RPC error leaves the cursor where it was', async () => {
    const rpc = new FakeRpc();
    const log = new PoolEventLog(rpc as unknown as Connection, programId, { fetchAttempts: 1 });
    rpc.add('A', 1n);
    expect(await log.refresh()).toBe(1);
    rpc.add('B', 2n);
    rpc.failSignatures = true;
    await expect(log.refresh()).rejects.toThrow(/rpc down/);
    rpc.failSignatures = false;
    expect(await log.refresh()).toBe(1);
    expect(nullifiers(log)).toEqual([1n, 2n]);
  });

  it('keeps whole chunks fetched before a failure, and resumes after them', async () => {
    const rpc = new FakeRpc();
    const log = new PoolEventLog(rpc as unknown as Connection, programId, { fetchAttempts: 1 });
    for (let i = 1; i <= 60; i++) rpc.add(`S${i}`, BigInt(i));
    rpc.missing.add('S30'); // in the second chunk of 25
    await expect(log.refresh()).rejects.toThrow(/not found/);
    expect(nullifiers(log)).toEqual(Array.from({ length: 25 }, (_, i) => BigInt(i + 1)));
    rpc.missing.clear();
    let fetched = 0;
    const orig = rpc.getTransaction.bind(rpc);
    rpc.getTransaction = async (s: string) => { fetched++; return orig(s); };
    expect(await log.refresh()).toBe(35);
    expect(fetched).toBe(35); // the first 25 are not fetched again
    expect(nullifiers(log)).toEqual(Array.from({ length: 60 }, (_, i) => BigInt(i + 1)));
  });

  it('snapshot/restore: a restored log fetches only what is newer and matches a full scan', async () => {
    const rpc = new FakeRpc();
    for (let i = 1; i <= 7; i++) rpc.add(`S${i}`, BigInt(i));
    const a = new PoolEventLog(rpc as unknown as Connection, programId);
    await a.refresh();
    const snap = JSON.parse(JSON.stringify(a.snapshot()));
    rpc.add('S8', 8n);
    const b = new PoolEventLog(rpc as unknown as Connection, programId);
    expect(b.restore(snap)).toBe(true);
    expect(b.restore(snap)).toBe(false); // only into an empty log
    let fetched = 0;
    const orig = rpc.getTransaction.bind(rpc);
    rpc.getTransaction = async (s: string) => { fetched++; return orig(s); };
    expect(await b.refresh()).toBe(1);
    expect(fetched).toBe(1);
    expect(nullifiers(b)).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]);
    expect(b.byTx.size).toBe(8);
    expect(new PoolEventLog(rpc as unknown as Connection, Keypair.generate().publicKey).restore(snap)).toBe(false); // other program
    const bad = new PoolEventLog(rpc as unknown as Connection, programId);
    expect(bad.restore({ ...snap, events: [{ name: 'Nope', signature: 'x', slot: 1, seq: 0 }] })).toBe(false);
    expect(bad.events).toHaveLength(0);
  });

  it('waits out HTTP 429s, keeps at most `concurrency` calls in flight, and drops to one at a time once limited', async () => {
    const rpc = new FakeRpc();
    for (let i = 1; i <= 60; i++) rpc.add(`S${i}`, BigInt(i));
    let inflight = 0;
    const peaks: number[] = [];
    let limited = 3;
    const orig = rpc.getTransaction.bind(rpc);
    rpc.getTransaction = async (s: string) => {
      inflight++;
      peaks.push(inflight);
      try {
        if (s === 'S10' && limited-- > 0) throw new Error('failed to get transaction: 429 Too Many Requests: {"code": 429, "message":"Too many requests for a specific RPC call"}');
        return await orig(s);
      } finally { inflight--; }
    };
    const progress: Array<[number, number]> = [];
    const log = new PoolEventLog(rpc as unknown as Connection, programId, { concurrency: 4, rateLimitDelayMs: 1, onProgress: (d, t) => progress.push([d, t]) });
    expect(await log.refresh()).toBe(60);
    expect(nullifiers(log)).toEqual(Array.from({ length: 60 }, (_, i) => BigInt(i + 1)));
    expect(Math.max(...peaks)).toBeLessThanOrEqual(4);
    // S10 is in the first chunk of 25; the chunks after it run one call at a time
    expect(Math.max(...peaks.slice(-35))).toBe(1);
    expect(progress).toEqual([[25, 60], [50, 60], [60, 60]]);
  });

  it('a 429 that does not clear fails the refresh after `rateLimitAttempts`, keeping whole chunks fetched before it', async () => {
    const rpc = new FakeRpc();
    for (let i = 1; i <= 30; i++) rpc.add(`S${i}`, BigInt(i));
    const orig = rpc.getTransaction.bind(rpc);
    let calls = 0;
    rpc.getTransaction = async (s: string) => { if (s === 'S27') { calls++; throw new Error('429 Too Many Requests'); } return orig(s); };
    const log = new PoolEventLog(rpc as unknown as Connection, programId, { rateLimitAttempts: 3, rateLimitDelayMs: 1 });
    await expect(log.refresh()).rejects.toThrow(/429/);
    expect(calls).toBe(3);
    expect(log.events).toHaveLength(25);
    rpc.getTransaction = orig;
    expect(await log.refresh()).toBe(5);
  });

  it('a 429 on the signature scan is waited out too', async () => {
    const rpc = new FakeRpc();
    rpc.add('A', 1n);
    const orig = rpc.getSignaturesForAddress.bind(rpc);
    let n = 0;
    rpc.getSignaturesForAddress = async (a: PublicKey, o: { until?: string }) => { if (n++ < 2) throw new Error('Server responded with 429 Too Many Requests'); return orig(a, o); };
    const log = new PoolEventLog(rpc as unknown as Connection, programId, { rateLimitDelayMs: 1 });
    expect(await log.refresh()).toBe(1);
  });

  it('isRateLimited reads web3.js and fetch wordings, and nothing else', () => {
    expect(isRateLimited(new Error('failed to get signatures for address: 429 Too Many Requests'))).toBe(true);
    expect(isRateLimited(new Error('outer', { cause: new Error('Too many requests for a specific RPC call') }))).toBe(true);
    expect(isRateLimited(new Error('transaction 4290abc not found'))).toBe(false);
    expect(isRateLimited(new Error('rpc down'))).toBe(false);
  });

  it('concurrent refreshes do not duplicate events', async () => {
    const rpc = new FakeRpc();
    const log = new PoolEventLog(rpc as unknown as Connection, programId);
    for (let i = 1; i <= 30; i++) rpc.add(`S${i}`, BigInt(i));
    const [x, y, z] = await Promise.all([log.refresh(), log.refresh(), log.refresh()]);
    expect(x + y + z).toBe(30);
    expect(nullifiers(log)).toEqual(Array.from({ length: 30 }, (_, i) => BigInt(i + 1)));
    expect(log.byTx.size).toBe(30);
  });
});
