// A fresh install starts its event log from the hosted seed snapshot instead of scanning every pool transaction
// since launch (which the public RPC answers with 429), and trusts it only after checking it against the chain.
// The RPC's own 429 is reported as rate_limited with source "rpc" and names H081_RPC_URL.
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Prover } from '../../src/prover.js';
import { noteNullifier, type Note } from '../../src/crypto.js';
import { nullifierPda } from '../../src/solana/pda.js';
import { H081Bank } from '../../integrations/core/bank.js';
import { MAINNET, configFromEnv } from '../../integrations/core/constants.js';
import { classify } from '../../integrations/core/errors.js';
import { POOL, fakeConnection, testConfig } from './helpers.js';

const noProver = new Prover('C:/nonexistent');
const SEED = 'https://seed.test/mainnet-beta-pool.events.json';

const snapshot = (events: unknown[], newest = 'S2') => ({ v: 1, programId: POOL.toBase58(), newest, events });
const nullifierEv = (n: bigint, signature: string) => ({ name: 'NewNullifier', nullifier: `n:${n}`, signature, slot: 1, seq: 0 });
const seedFetch = (body: unknown, status = 200) => vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

async function open(fetchFn: typeof fetch, opts: { cacheDir?: string; seed?: string | undefined; conn?: ReturnType<typeof fakeConnection>; signer?: Keypair } = {}) {
  const signer = opts.signer ?? Keypair.generate();
  const conn = opts.conn ?? fakeConnection(signer);
  const lines: string[] = [];
  const cacheDir = opts.cacheDir ?? mkdtempSync(join(tmpdir(), 'h081-seed-'));
  const bank = await H081Bank.open({
    config: testConfig({ eventsSeedUrl: 'seed' in opts ? opts.seed : SEED }), signer, accountSk: 7n, connection: conn as unknown as Connection,
    prover: noProver, cacheDir, fetch: fetchFn, log: (l) => lines.push(l),
  });
  return { bank, conn, lines, cacheDir };
}

describe('seed event log', () => {
  it('a fresh install restores the seed, fetches only what is newer, checks it, and caches it', async () => {
    const f = seedFetch(snapshot([nullifierEv(5n, 'S1'), nullifierEv(6n, 'S2')]));
    const { bank, conn, lines, cacheDir } = await open(f);
    expect(f).toHaveBeenCalledWith(SEED, expect.anything());
    expect(bank.pool.log.events).toHaveLength(2);
    expect(bank.owner.isSpent(5n)).toBe(true);
    // the scan for newer transactions starts after the seed's newest signature
    expect(conn.getSignaturesForAddress).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ until: 'S2' }), 'confirmed');
    expect(lines.some((l) => /starting from the seed event log at seed\.test \(2 events/.test(l))).toBe(true);
    expect(readdirSync(cacheDir).some((n) => n.endsWith('.events.json'))).toBe(true);
    // the next start reads the local cache, not the seed
    const again = await open(f, { cacheDir });
    expect(f).toHaveBeenCalledTimes(1);
    expect(again.bank.pool.log.events).toHaveLength(2);
  });

  it('a seed whose commitment tree is not the pool\'s is dropped and the bank scans from the start', async () => {
    // one leaf, but the (fake) pool account does not exist: no root can match
    const f = seedFetch(snapshot([{ name: 'NewCommitment', commitment: 'n:9', index: 0, encryptedOutput: 'b:00', signature: 'S1', slot: 1, seq: 0 }], 'S1'));
    const { bank, lines, cacheDir } = await open(f);
    expect(bank.pool.log.events).toHaveLength(0);
    expect(lines).toContain('the seed event log does not match the chain; scanning from the start');
    expect(readdirSync(cacheDir).some((n) => n.endsWith('.events.json'))).toBe(false);
  });

  it('an unreachable, missing or broken seed is skipped with a log line, never an error', async () => {
    for (const [f, re] of [
      [seedFetch('not found', 404), /no seed event log at seed\.test \(HTTP 404\)/],
      [seedFetch('{oops'), /could not read the seed event log at seed\.test/],
      [vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch, /could not read the seed event log at seed\.test \(fetch failed\)/],
    ] as const) {
      const { bank, lines } = await open(f);
      expect(bank.pool.log.events).toHaveLength(0);
      expect(lines.some((l) => re.test(l))).toBe(true);
    }
  });

  it('no seed URL (off, localnet, tests): nothing is fetched', async () => {
    const f = seedFetch(snapshot([]));
    await open(f, { seed: undefined });
    expect(f).not.toHaveBeenCalled();
  });

  it('notesMatchChain: a note the log calls unspent whose nullifier account exists on chain fails the check', async () => {
    const f = seedFetch(snapshot([]));
    const { bank, conn } = await open(f, { seed: undefined });
    const commitment = 77n;
    bank.owner.notes.set(commitment, { note: { amount: 5n } as Note, commitment, index: 0, spent: false });
    expect(await bank.owner.notesMatchChain()).toBe(true);
    const nf = nullifierPda(POOL, noteNullifier(bank.account.keys.nk, commitment));
    conn.accounts.set(nf.toBase58(), { owner: POOL, data: Buffer.alloc(0), executable: false, lamports: 1 });
    expect(await bank.owner.notesMatchChain()).toBe(false);
    bank.owner.notes.get(commitment)!.spent = true;
    expect(await bank.owner.notesMatchChain()).toBe(true);
  });
});

describe('H081_EVENTS_SEED_URL', () => {
  it('defaults to the hosted mainnet snapshot for the configured pool; off/empty disables; localnet has none', () => {
    expect(configFromEnv({}).eventsSeedUrl).toBe(`https://api.h081.xyz/events/mainnet-beta-${MAINNET.programs.pool}.events.json`);
    const other = Keypair.generate().publicKey.toBase58();
    expect(configFromEnv({ H081_POOL_PROGRAM_ID: other }).eventsSeedUrl).toBe(`https://api.h081.xyz/events/mainnet-beta-${other}.events.json`);
    for (const v of ['off', 'OFF', '0', 'none', '']) expect(configFromEnv({ H081_EVENTS_SEED_URL: v }).eventsSeedUrl).toBeUndefined();
    expect(configFromEnv({ H081_EVENTS_SEED_URL: 'https://mirror.example/x.json' }).eventsSeedUrl).toBe('https://mirror.example/x.json');
    expect(() => configFromEnv({ H081_EVENTS_SEED_URL: 'file:///etc/passwd' })).toThrow(/http\(s\) URL or "off"/);
    expect(configFromEnv({ H081_CLUSTER: 'localnet', H081_RPC_URL: 'http://127.0.0.1:8899', H081_USDG_MINT: PublicKey.default.toBase58() }).eventsSeedUrl).toBeUndefined();
  });
});

describe('the RPC answering 429', () => {
  it('is rate_limited with source rpc and tells the agent to set H081_RPC_URL', () => {
    const c = classify(new Error('failed to get signatures for address: 429 Too Many Requests: {"jsonrpc":"2.0","error":{"code": 429, "message":"Too many requests for a specific RPC call"}}'));
    expect(c.code).toBe('rate_limited');
    expect(c.status).toBe(429);
    expect(c.retryable).toBe(true);
    expect(c.details).toEqual({ source: 'rpc' });
    expect(c.message).toMatch(/H081_RPC_URL/);
    expect(c.message).toMatch(/continues where this one stopped/);
  });

  it('unrelated errors are not mistaken for it', () => {
    expect(classify(new Error('transaction 4290xyz not found')).code).not.toBe('rate_limited');
  });
});
