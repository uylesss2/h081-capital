// The loan-key list across processes (integrations/core/loankeys.ts): two borrowers on one signer never take the same
// loan key, a lock left by a crashed process is taken over, and a held one is waited for and then refused.
import { spawn } from 'node:child_process';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
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

  it('two real processes reserving 25 keys each at the same time never share one', async () => {
    const file = fileIn();
    const mod = resolve(import.meta.dirname, '..', '..', 'integrations', 'core', 'loankeys.ts').replace(/\\/g, '/');
    const script = `import { reserveLoanKey } from 'file:///${mod.replace(/^\//, '')}';
const out = []; const known = new Set();
for (let i = 0; i < 25; i++) out.push(reserveLoanKey(process.argv[1], known));
process.stdout.write(JSON.stringify(out));`;
    const run = () => new Promise<number[]>((ok, fail) => {
      const p = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, file], { stdio: ['ignore', 'pipe', 'inherit'] });
      let s = '';
      p.stdout.on('data', (c: Buffer) => { s += c.toString('utf8'); });
      p.on('error', fail);
      p.on('close', (code) => (code === 0 ? ok(JSON.parse(s) as number[]) : fail(new Error(`child exited ${code}`))));
    });
    const [x, y] = await Promise.all([run(), run()]);
    const all = [...x, ...y];
    expect(new Set(all).size).toBe(50);
    expect(readLoanKeys(file)).toEqual([...all].sort((p, q) => p - q));
  }, 60_000);
});
