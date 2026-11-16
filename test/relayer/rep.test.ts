// The relayer's private-reputation routes with a stub backend (no RPC): enabled/disabled, methods, rate limit, the
// config floor that keeps wash loans from draining the hot wallet, and that there is no proving route. Then RepRelayer
// itself over a mocked chain: attest requests are queued for the sweep (not sent on request), and the leaf list is kept
// across attests and topped up incrementally, one refresh at a time.
import type { Server } from 'node:http';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Keypair, type Connection, type PublicKey } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2';
import { initCrypto, randomField, repLeaf } from '../../src/crypto.js';
import { MerkleTree } from '../../src/merkle.js';
import { REP_LEVELS } from '../../src/reputation.js';
import { be32 } from '../../src/solana/field.js';
import { LOCALNET_REP_PROGRAM_ID, REP_TREE_SIZE, repTreePda } from '../../src/solana/reputation.js';
import { loadConfig, ConfigError } from '../../relayer/config.js';
import { RelayError } from '../../relayer/errors.js';
import { RateLimiter } from '../../relayer/ratelimit.js';
import { RepRelayer } from '../../relayer/rep.js';
import { createRelayerServer } from '../../relayer/server.js';

const h = vi.hoisted(() => ({ onSend: undefined as undefined | ((loanRef: bigint) => string) }));
vi.mock('../../src/solana/send.js', async (orig) => ({
  ...(await orig<typeof import('../../src/solana/send.js')>()),
  // the attest instruction's data is its 8-byte discriminator and the loan ref (u64 LE); nothing is sent anywhere
  sendLegacy: async (_c: unknown, _p: unknown, _s: unknown, ixs: Array<{ data: Buffer }>) => h.onSend!(ixs[0].data.readBigUInt64LE(8)),
}));

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function start(rep?: Parameters<typeof createRelayerServer>[0]['rep'], burst = 5, repCronSecret?: string): Promise<string> {
  server = createRelayerServer({ solana: { info: () => ({}), relay: async () => ({}) }, limiter: new RateLimiter({ perMinute: 60, burst }), rep, repCronSecret });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const a = server.address() as { port: number };
  return `http://127.0.0.1:${a.port}`;
}

describe('relayer /v1/rep routes', () => {
  it('answer 503 rep_disabled when reputation is off; info says so', async () => {
    const url = await start();
    for (const [m, p] of [['GET', '/v1/rep/leaves'], ['GET', '/v1/rep/roots'], ['POST', '/v1/rep/attest'], ['GET', '/v1/rep/sweep']]) {
      const r = await fetch(`${url}${p}`, { method: m, ...(m === 'POST' ? { body: '{}' } : {}) });
      expect(r.status).toBe(503);
      expect(((await r.json()) as any).error.code).toBe('rep_disabled');
    }
    expect(((await (await fetch(`${url}/v1/info`)).json()) as any).rep).toEqual({ enabled: false });
  });

  it('serve leaves and roots, queue an attest (202, nothing sent), map refusals, rate limit every route, and offer no proving route', async () => {
    const calls: unknown[] = [];
    const url = await start({
      info: () => ({ program: 'P', attester: 'A', minPrincipal: '10000000', proving: false }),
      leaves: async () => ({ version: 0, program: 'P', events: [] }),
      roots: async () => ({ version: 0, nextIndex: 0, root: '1', roots: ['1'] }),
      enqueue: async (b: unknown) => {
        calls.push(b);
        if ((b as { loanRef: string }).loanRef === '9') throw new RelayError(402, 'below_floor', 'too small');
        return { queued: true, loanRef: (b as { loanRef: string }).loanRef, note: 'queued' };
      },
    } as never, 4);
    expect(await (await fetch(`${url}/v1/rep/leaves`)).json()).toEqual({ version: 0, program: 'P', events: [] });
    expect(((await (await fetch(`${url}/v1/rep/roots`)).json()) as any).nextIndex).toBe(0);
    expect((await fetch(`${url}/v1/rep/leaves`, { method: 'POST', body: '{}' })).status).toBe(405);
    expect((await fetch(`${url}/v1/rep/attest`)).status).toBe(405);
    const ok = await fetch(`${url}/v1/rep/attest`, { method: 'POST', body: JSON.stringify({ loanRef: '7' }) });
    expect(ok.status).toBe(202);
    expect(await ok.json()).toEqual({ queued: true, loanRef: '7', note: 'queued' });
    const small = await fetch(`${url}/v1/rep/attest`, { method: 'POST', body: JSON.stringify({ loanRef: '9' }) });
    expect(small.status).toBe(402);
    expect(((await small.json()) as any).error.code).toBe('below_floor');
    // burst 4, and the GETs take tokens too: leaves, roots and two attests used them, so the next request of any kind
    // is refused before the backend runs (a flood of leaf reads cannot turn into RPC load)
    expect((await fetch(`${url}/v1/rep/attest`, { method: 'POST', body: JSON.stringify({ loanRef: '8' }) })).status).toBe(429);
    expect((await fetch(`${url}/v1/rep/leaves`)).status).toBe(429);
    expect((await fetch(`${url}/v1/rep/roots`)).status).toBe(429);
    expect(calls).toHaveLength(2);
    expect((await fetch(`${url}/v1/rep/prove`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect(((await (await fetch(`${url}/v1/info`)).json()) as any).rep).toMatchObject({ enabled: true, proving: false });
  });

  it('GET /v1/rep/sweep runs the sweep only with the cron secret; 503 without one configured', async () => {
    let swept = 0;
    const backend = {
      info: () => ({}), leaves: async () => ({}), roots: async () => ({}), enqueue: async () => ({}),
      sweep: async () => { swept++; return { attested: ['3'], failed: [], candidates: 1 }; },
    } as never;
    let url = await start(backend);
    expect((await fetch(`${url}/v1/rep/sweep`, { headers: { authorization: 'Bearer anything' } })).status).toBe(503);
    await new Promise<void>((r) => server!.close(() => r()));
    url = await start(backend, 5, 'a-long-cron-secret-123');
    expect((await fetch(`${url}/v1/rep/sweep`)).status).toBe(401);
    expect((await fetch(`${url}/v1/rep/sweep`, { headers: { authorization: 'Bearer wrong-secret-same-len!' } })).status).toBe(401);
    expect((await fetch(`${url}/v1/rep/sweep`, { method: 'POST' })).status).toBe(405);
    expect(swept).toBe(0);
    const ok = await fetch(`${url}/v1/rep/sweep`, { headers: { authorization: 'Bearer a-long-cron-secret-123' } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ attested: ['3'], failed: [], candidates: 1 });
    expect(swept).toBe(1);
  });
});

// ---- RepRelayer over a mocked chain

const PROG = LOCALNET_REP_PROGRAM_ID;
const ATTESTED = sha256(new TextEncoder().encode('event:RepAttested')).subarray(0, 8);

/** A rep tree on a fake chain: the RepTree account, one transaction per attest (newest first), and call counters. */
function chain() {
  const tree = new MerkleTree(REP_LEVELS);
  const txs: Array<{ sig: string; logs: string[] }> = [];
  const calls = { sigs: [] as Array<string | undefined>, txs: 0 };
  let lag = 0; // newest transactions the signature listing does not show yet (a lagging RPC node)
  const add = (loanRef: bigint): string => {
    const f = { agentPk: randomField(), loanRef, principal: 10_000_000n, assetF: 3n, lenderF: 4n, fundedDay: 20_000n };
    const leaf = repLeaf(f);
    const index = tree.insert(leaf);
    const b = Buffer.alloc(8 + 2 + 4 + 8 + 32 * 3 + 8 + 32 * 2 + 4);
    let o = 0;
    Buffer.from(ATTESTED).copy(b, o); o += 8;
    b.writeUInt16LE(0, o); o += 2;
    b.writeUInt32LE(index, o); o += 4;
    b.writeBigUInt64LE(loanRef, o); o += 8;
    for (const x of [leaf, tree.root, f.agentPk]) { Buffer.from(be32(x)).copy(b, o); o += 32; }
    b.writeBigUInt64LE(f.principal, o); o += 8;
    for (const x of [f.assetF, f.lenderF]) { Buffer.from(be32(x)).copy(b, o); o += 32; }
    b.writeUInt32LE(Number(f.fundedDay), o);
    const sig = `sig${txs.length}`;
    txs.unshift({ sig, logs: [`Program ${PROG.toBase58()} invoke [1]`, `Program data: ${b.toString('base64')}`, `Program ${PROG.toBase58()} success`] });
    return sig;
  };
  const account = () => {
    const data = new Uint8Array(REP_TREE_SIZE);
    new DataView(data.buffer).setUint32(8, txs.length, true);
    data.set(be32(tree.root), 8 + 16 + 32 * REP_LEVELS);
    return data;
  };
  const connection = {
    getAccountInfo: async (k: PublicKey) => (k.equals(repTreePda(PROG, 0)) ? { data: account(), owner: PROG, lamports: 1, executable: false } : null),
    getSignaturesForAddress: async (_a: PublicKey, o: { until?: string }) => {
      calls.sigs.push(o.until);
      const visible = txs.slice(lag);
      const stop = o.until ? visible.findIndex((t) => t.sig === o.until) : -1;
      return (stop >= 0 ? visible.slice(0, stop) : visible).map((t) => ({ signature: t.sig, err: null }));
    },
    getTransaction: async (sig: string) => { calls.txs++; return { meta: { err: null, logMessages: txs.find((t) => t.sig === sig)!.logs } }; },
    getProgramAccounts: async () => [],
  } as unknown as Connection;
  return { add, connection, calls, setLag: (n: number) => { lag = n; } };
}

function relayerOn(c: ReturnType<typeof chain>, extra: { sweepEveryMin?: number } = {}) {
  const rep = new RepRelayer({ connection: c.connection, payer: Keypair.generate(), repProgramId: PROG, loanProgramId: Keypair.generate().publicKey, ...extra });
  vi.spyOn(rep, 'refusal').mockResolvedValue(undefined);
  return rep;
}

describe('RepRelayer: queued attests and an incremental leaf list (mocked chain)', () => {
  beforeAll(async () => { await initCrypto(); });

  it('two attests followed by three GETs cost one incremental fetch of only the new transactions', async () => {
    const c = chain();
    for (const r of [1n, 2n, 3n]) c.add(r);
    h.onSend = (ref) => c.add(ref);
    const rep = relayerOn(c);
    expect((await rep.leaves()).events).toHaveLength(3);
    expect(rep.fetches).toEqual({ incremental: 0, full: 1 });
    expect(c.calls).toEqual({ sigs: [undefined], txs: 3 });

    await rep.attest({ loanRef: '10' });
    await rep.attest({ loanRef: '11' });
    for (let i = 0; i < 3; i++) expect((await rep.leaves()).events.map((e) => e.loanRef)).toEqual(['1', '2', '3', '10', '11']);
    expect(rep.fetches).toEqual({ incremental: 1, full: 1 });
    // one more signature listing, from the newest one already read, and only the two new transactions
    expect(c.calls).toEqual({ sigs: [undefined, 'sig2'], txs: 5 });
  });

  it('concurrent reads during a miss share one refresh; a listing that lags the RepTree falls back to one full rebuild', async () => {
    const c = chain();
    for (const r of [1n, 2n]) c.add(r);
    h.onSend = (ref) => c.add(ref);
    const rep = relayerOn(c);
    await rep.leaves();
    await rep.attest({ loanRef: '5' });
    const [a, b, d] = await Promise.all([rep.leaves(), rep.leaves(), rep.leaves()]);
    expect(a).toBe(b);
    expect(b).toBe(d);
    expect(rep.fetches).toEqual({ incremental: 1, full: 1 });
    // the RepTree says 4 leaves but the listing still lacks the newest transaction: never served short, rebuilt in full
    c.setLag(1);
    await rep.attest({ loanRef: '6' });
    await expect(rep.leaves()).rejects.toThrow(/3 leaves; the chain has 4/);
    expect(rep.fetches).toEqual({ incremental: 2, full: 2 });
    c.setLag(0);
    expect((await rep.leaves()).events).toHaveLength(4);
  });

  it('an attest request is queued, not sent; the sweep sends every queued and repaid loan together in loanRef order', async () => {
    const c = chain();
    c.add(1n);
    const sent: bigint[] = [];
    h.onSend = (ref) => { sent.push(ref); return c.add(ref); };
    const rep = relayerOn(c, { sweepEveryMin: 15 });
    expect(await rep.enqueue({ loanRef: '30' })).toMatchObject({ queued: true, loanRef: '30', note: expect.stringMatching(/every 15 min/) });
    await rep.enqueue({ loanRef: '20' });
    await expect(rep.enqueue({ loanRef: 'x' })).rejects.toThrow(/decimal u64/);
    expect(sent).toEqual([]);
    expect(await rep.sweep()).toMatchObject({ attested: ['20', '30'], signatures: ['sig1', 'sig2'], failed: [], candidates: 2 });
    expect(sent).toEqual([20n, 30n]);
    expect((await rep.sweep()).candidates).toBe(0);
    expect(rep.info()).toMatchObject({ attest: 'queued', sweepEveryMin: 15, proving: false });
  });
});

describe('relayer reputation config', () => {
  const base = {
    RELAYER_SOLANA_RPC: 'http://127.0.0.1:8899', RELAYER_SOLANA_KEYPAIR_JSON: '[1]', RELAYER_SOLANA_MIN_FEES: '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH=50000',
    RELAYER_SOLANA_TREASURY: 'EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq',
  };
  const REP = '8w59GKraS4JrmDqYnqXcvjHTubnj7udMsuLXnscd3KEL';
  it('is off without RELAYER_REP_PROGRAM_ID; on with a 10 USDG default floor; a floor under 1 USDG is refused', () => {
    expect(loadConfig(base).solana?.rep).toBeUndefined();
    const on = loadConfig({ ...base, RELAYER_REP_PROGRAM_ID: REP }).solana?.rep;
    expect(on).toMatchObject({ programId: REP, loanProgramId: '8JBd7epQXxdcKRMaWM1S5PC7nsQKoZq3uCetpiJ684g4', minPrincipal: 10_000_000n });
    expect(() => loadConfig({ ...base, RELAYER_REP_PROGRAM_ID: REP, RELAYER_REP_MIN_PRINCIPAL: '999999' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, RELAYER_REP_PROGRAM_ID: 'nope' })).toThrow(/not a public key/);
  });

  it('sweeps every 15 minutes by default; RELAYER_REP_SWEEP_MIN and CRON_SECRET are read', () => {
    const on = loadConfig({ ...base, RELAYER_REP_PROGRAM_ID: REP }).solana?.rep;
    expect(on).toMatchObject({ sweepEveryMin: 15 });
    expect(on?.cronSecret).toBeUndefined();
    expect(loadConfig({ ...base, RELAYER_REP_PROGRAM_ID: REP, RELAYER_REP_SWEEP_MIN: '0', CRON_SECRET: 's3cret-for-the-cron' }).solana?.rep)
      .toMatchObject({ sweepEveryMin: 0, cronSecret: 's3cret-for-the-cron' });
    expect(() => loadConfig({ ...base, RELAYER_REP_PROGRAM_ID: REP, RELAYER_REP_SWEEP_MIN: 'soon' })).toThrow(/whole number of minutes/);
  });
});
