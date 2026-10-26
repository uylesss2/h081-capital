// PoolEventLog.refresh against a scripted RPC (no validator): a transaction that is not yet available, or
// an RPC error, must not make the log skip events; concurrent refreshes must not duplicate them.
import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { EVENT_IX_TAG_LE, PoolEventLog } from '../../src/solana/events.js';
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
