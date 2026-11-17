// The loan-key list (private reputation, docs/REPUTATION-SPEC.md section 5): which loan key indices this account has
// borrowed under, kept next to the event cache (indices only: never a key, never an amount).
//
// Two borrows on one signer must never pick the same key (two Slots with one agent_pk are linked on chain). In one
// process the pick is synchronous, so it cannot interleave. Across processes (an MCP server and the CLI on one wallet)
// each one held its own copy of the list: both could read "0, 1" and both take 2. reserveLoanKey closes that: under an
// exclusive lock file it re-reads the list from disk, picks the first free key, and writes it back before the lock
// is released, so the second process sees the first one's key. A lock left by a crashed process is taken over once it
// is older than LOCK_STALE_MS (a pick holds it for milliseconds).
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

const isKey = (k: unknown): k is number => Number.isInteger(k) && (k as number) >= 0 && (k as number) < 2 ** 32;

/** The keys in a loan-key file (none when it is missing or unreadable). */
export function readLoanKeys(file: string): number[] {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { keys?: unknown };
    return Array.isArray(saved.keys) ? saved.keys.filter(isKey) : [];
  } catch { return []; }
}

export function writeLoanKeys(file: string, keys: Iterable<number>): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ keys: [...new Set(keys)].sort((a, b) => a - b) }));
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Takes `<file>.lock` exclusively (waits up to LOCK_WAIT_MS; takes over a stale one). Returns the release function. */
export function lockLoanKeys(file: string, now: () => number = Date.now): () => void {
  const lock = `${file}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const until = now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lock, 'wx');
      try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
      return () => { try { unlinkSync(lock); } catch { /* already gone */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let age = 0;
    try { age = now() - statSync(lock).mtimeMs; } catch { continue; } // released in between: try again
    if (age > LOCK_STALE_MS) { try { unlinkSync(lock); } catch { /* another process took it over first */ } continue; }
    if (now() > until) throw new Error(`another borrow on this wallet holds the loan-key lock (${lock}); retry in a moment. Nothing was sent.`);
    sleep(25);
  }
}

/**
 * Picks the first loan key that neither `known` nor the file lists, and records it in the file before returning, all
 * under the lock. `known` gains everything the file listed and the new key. Without a file (no cache dir) the pick is
 * from `known` only: one process, and synchronous, so still never twice.
 */
export function reserveLoanKey(file: string | undefined, known: Set<number>): number {
  if (!file) {
    let k = 0;
    while (known.has(k)) k++;
    known.add(k);
    return k;
  }
  const release = lockLoanKeys(file);
  try {
    for (const k of readLoanKeys(file)) known.add(k);
    let k = 0;
    while (known.has(k)) k++;
    known.add(k);
    writeLoanKeys(file, known);
    return k;
  } finally { release(); }
}
