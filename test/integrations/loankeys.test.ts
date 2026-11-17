// The loan-key list across processes (integrations/core/loankeys.ts): two borrowers on one signer never take the same
// loan key, a lock left by a crashed process is taken over, and a held one is waited for and then refused.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCK_STALE_MS, lockLoanKeys, readLoanKeys, reserveLoanKey, writeLoanKeys } from '../../integrations/core/loankeys.js';

const fileIn = () => join(mkdtempSync(join(tmpdir(), 'h081-loankeys-')), 'localnet-x.loankeys-S.json');

describe('reserveLoanKey', () => {
  it('two banks opened on one signer before either borrowed (each with a stale in-memory list) take different keys', () => {
    const file = fileIn();
    writeLoanKeys(file, [0, 1]);
    const a = new Set(readLoanKeys(file)), b = new Set(readLoanKeys(file));
    expect(reserveLoanKey(file, a)).toBe(2);
    // b still believes 0 and 1 are all that was used: it re-reads the file under the lock and takes 3
    expect(reserveLoanKey(file, b)).toBe(3);
    expect(readLoanKeys(file)).toEqual([0, 1, 2, 3]);
    expect([...b].sort()).toEqual([0, 1, 2, 3]);
  });

  it('without a cache dir it picks from memory only', () => {
    const known = new Set([0, 2]);
    expect(reserveLoanKey(undefined, known)).toBe(1);
    expect(reserveLoanKey(undefined, known)).toBe(3);
  });

  it('a lock older than LOCK_STALE_MS (a crashed process) is taken over; a fresh one is waited for, then refused', () => {
    const file = fileIn();
    writeFileSync(`${file}.lock`, '999999');
    const old = (Date.now() - LOCK_STALE_MS - 5_000) / 1000;
    utimesSync(`${file}.lock`, old, old);
    expect(reserveLoanKey(file, new Set())).toBe(0);
    // a live lock: the clock is moved past the 10 s wait instead of sleeping through it
    const release = lockLoanKeys(file);
    let t = Date.now();
    expect(() => lockLoanKeys(file, () => (t += 4_000))).toThrow(/holds the loan-key lock.*Nothing was sent/);
    release();
    expect(reserveLoanKey(file, new Set())).toBe(1);
  });

  it('two real processes released together at a barrier reserve 50 keys each, interleaved, and never share one', async () => {
    const file = fileIn();
    const mod = resolve(import.meta.dirname, '..', '..', 'integrations', 'core', 'loankeys.ts').replace(/\\/g, '/');
    // each child says it is ready, then waits for the other one: both loops start together (tsx start-up skew used to
    // let one child finish before the other began, which passes with or without the lock)
    const script = `import { existsSync, writeFileSync } from 'node:fs';
import { reserveLoanKey } from 'file:///${mod.replace(/^\//, '')}';
const [file, me, other] = process.argv.slice(1);
writeFileSync(file + '.ready-' + me, '');
const until = Date.now() + 30000;
while (!existsSync(file + '.ready-' + other)) { if (Date.now() > until) throw new Error('the other child never started'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); }
const out = []; const known = new Set();
// a pause between picks (outside the lock) lets the other child in: without it the holder re-takes the lock
// before a waiter wakes from its 25 ms sleep, and one child runs all 50 picks alone
for (let i = 0; i < 50; i++) { out.push(reserveLoanKey(file, known)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.floor(Math.random() * 20)); }
process.stdout.write(JSON.stringify(out));`;
    const run = (me: string, other: string) => new Promise<number[]>((ok, fail) => {
      const p = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, file, me, other], { stdio: ['ignore', 'pipe', 'inherit'] });
      let s = '';
      p.stdout.on('data', (c: Buffer) => { s += c.toString('utf8'); });
      p.on('error', fail);
      p.on('close', (code) => (code === 0 ? ok(JSON.parse(s) as number[]) : fail(new Error(`child exited ${code}`))));
    });
    const [x, y] = await Promise.all([run('a', 'b'), run('b', 'a')]);
    // the loops really overlapped: neither child's keys all come before the other's
    expect(Math.max(...x) > Math.min(...y) && Math.max(...y) > Math.min(...x)).toBe(true);
    const all = [...x, ...y];
    expect(new Set(all).size).toBe(100);
    expect(readLoanKeys(file)).toEqual([...all].sort((p, q) => p - q));
  }, 120_000);

  it('release removes only its own lock: after a stale lock was taken over, the old holder releasing leaves the new holder\'s lock', () => {
    const file = fileIn(), lock = `${file}.lock`;
    const releaseA = lockLoanKeys(file);
    const old = (Date.now() - LOCK_STALE_MS - 5_000) / 1000;
    utimesSync(lock, old, old); // A looks crashed
    const releaseB = lockLoanKeys(file); // B takes it over
    releaseA(); // A was only slow: its release must not drop B's lock
    expect(existsSync(lock)).toBe(true);
    let t = Date.now();
    expect(() => lockLoanKeys(file, () => (t += 4_000))).toThrow(/holds the loan-key lock/);
    releaseB();
    expect(existsSync(lock)).toBe(false);
  });

  it('two waiters that both saw one stale lock: the second does not remove the fresh lock the first one took', () => {
    const file = fileIn(), lock = `${file}.lock`;
    writeFileSync(lock, 'crashed');
    const old = (Date.now() - LOCK_STALE_MS - 5_000) / 1000;
    utimesSync(lock, old, old);
    let releaseA: (() => void) | undefined;
    // B observed the stale lock; before B acts on it, A takes it over and holds a fresh one
    let t = Date.now();
    const b = () => lockLoanKeys(file, () => (t += 1_000), { beforeTakeover: () => { releaseA ??= lockLoanKeys(file); } });
    expect(b).toThrow(/holds the loan-key lock/);
    expect(releaseA).toBeDefined();
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(lock, 'utf8')).not.toBe('crashed');
    releaseA!();
    expect(existsSync(lock)).toBe(false);
    expect(reserveLoanKey(file, new Set())).toBe(0);
  });
});
