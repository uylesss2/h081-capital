// The loan-key list (private reputation, docs/REPUTATION-SPEC.md section 5): which loan key indices this account has
// borrowed under, kept next to the event cache (indices only: never a key, never an amount).
//
// Two borrows on one signer must never pick the same key (two Slots with one agent_pk are linked on chain). In one
// process the pick is synchronous, so it cannot interleave. Across processes (an MCP server and the CLI on one wallet)
// each one held its own copy of the list: both could read "0, 1" and both take 2. reserveLoanKey closes that: under an
// exclusive lock file it re-reads the list from disk, picks the first free key, and writes it back before the lock
// is released, so the second process sees the first one's key.
//
// Each lock holds a token unique to its holder. Release removes the lock only when it still holds the holder's token
// (a holder that was only slow never drops the lock a waiter took over). A lock left by a crashed process is taken over
// once it is older than LOCK_STALE_MS (a pick holds it for milliseconds), and only under a second, short-lived
// takeover file: there the waiter re-reads the lock and removes it only if it still holds the token the waiter saw
// stale. Two waiters that saw the same stale lock therefore cannot both take it: the second finds the first one's fresh
// token and goes back to waiting.
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;
/** A takeover file is held for one read and one unlink; older than this, its holder crashed in between. */
const TAKEOVER_STALE_MS = 5_000;

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

/** Creates `path` exclusively with `content`; false when it exists. */
function create(path: string, content: string): boolean {
  let fd: number;
  try { fd = openSync(path, 'wx'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try { writeSync(fd, content); } finally { closeSync(fd); }
  return true;
}

/** The token and age of a lock file, or undefined when it is gone. */
function observe(path: string, now: () => number): { token: string; age: number } | undefined {
  try {
    const age = now() - statSync(path).mtimeMs;
    return { token: readFileSync(path, 'utf8'), age };
  } catch { return undefined; }
}

/** Removes `path` only if it still holds `token` (best effort: a missing file is fine). */
function removeIfHolds(path: string, token: string): void {
  try { if (readFileSync(path, 'utf8') === token) unlinkSync(path); } catch { /* already gone */ }
}

/**
 * Takes `<file>.lock` exclusively (waits up to LOCK_WAIT_MS; takes over a stale one). Returns the release function.
 * `hooks.beforeTakeover` runs after a stale lock was observed and before the takeover (tests use it to interleave a
 * second waiter there).
 */
export function lockLoanKeys(file: string, now: () => number = Date.now, hooks: { beforeTakeover?: () => void } = {}): () => void {
  const lock = `${file}.lock`, guard = `${lock}.takeover`;
  const token = `${process.pid}.${randomBytes(12).toString('hex')}`;
  mkdirSync(dirname(lock), { recursive: true });
  const until = now() + LOCK_WAIT_MS;
  for (;;) {
    if (create(lock, token)) return () => removeIfHolds(lock, token);
    const seen = observe(lock, now);
    if (!seen) continue; // released in between: try again
    if (seen.age > LOCK_STALE_MS) {
      hooks.beforeTakeover?.();
      const guardToken = `${token}.takeover`;
      if (create(guard, guardToken)) {
        try {
          // still the very lock seen stale (not a fresh one another waiter took meanwhile): remove it
          const again = observe(lock, now);
          if (again && again.token === seen.token && again.age > LOCK_STALE_MS) unlinkSync(lock);
        } catch { /* gone already */ } finally { removeIfHolds(guard, guardToken); }
        continue;
      }
      const g = observe(guard, now);
      if (g && g.age > TAKEOVER_STALE_MS) removeIfHolds(guard, g.token); // its holder crashed mid-takeover
    }
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
