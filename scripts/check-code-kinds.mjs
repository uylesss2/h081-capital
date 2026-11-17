#!/usr/bin/env node
// The code-kind registry across branches. Every branch keeps its own integrations/core/codes.ts, so a kind number one
// branch allocates can be taken by another and the clash only shows when they merge. This reads CODE_KIND from the
// working tree and from every local branch, and fails when one number names two different codes, or when this tree
// allocates a number another branch uses without holding it in RESERVED_CODE_KINDS.
//   node scripts/check-code-kinds.mjs            (npm run check:code-kinds)
// Read only: `git show <branch>:integrations/core/codes.ts`, nothing is checked out or written.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const CODES = 'integrations/core/codes.ts';

/** `{ name: number }` from a codes.ts source's `export const CODE_KIND = { ... }`, or undefined when it has none. */
export function parseCodeKinds(src) {
  const m = /export const CODE_KIND\s*=\s*\{([^}]*)\}/.exec(src);
  if (!m) return undefined;
  const out = {};
  for (const [, name, n] of m[1].matchAll(/(\w+)\s*:\s*(\d+)/g)) out[name] = Number(n);
  return out;
}

/** The numbers a codes.ts source holds in RESERVED_CODE_KINDS (none when it has no such table). */
export function parseReserved(src) {
  const m = /export const RESERVED_CODE_KINDS[^=]*=\s*\{([^}]*)\}/.exec(src);
  return m ? [...m[1].matchAll(/(?:^|[,{\s])(\d+)\s*:/g)].map((x) => Number(x[1])) : [];
}

/**
 * tables: [{ source, kinds: {name: number} }]. A clash is one number with two names across the tables (the same
 * name at the same number on several branches is the shared, shipped registry).
 */
export function findClashes(tables) {
  const byKind = new Map();
  for (const t of tables) {
    for (const [name, n] of Object.entries(t.kinds)) {
      if (!byKind.has(n)) byKind.set(n, new Map());
      const names = byKind.get(n);
      if (!names.has(name)) names.set(name, []);
      names.get(name).push(t.source);
    }
  }
  const clashes = [];
  for (const [n, names] of [...byKind].sort((a, b) => a[0] - b[0])) {
    if (names.size > 1) clashes.push({ kind: n, uses: [...names].map(([name, sources]) => ({ name, sources })) });
  }
  return clashes;
}

/** Kinds other tables allocate that `mine` neither allocates under the same name nor reserves. */
export function unreserved(mine, reserved, others) {
  const held = new Set(reserved);
  const missing = [];
  for (const t of others) {
    for (const [name, n] of Object.entries(t.kinds)) {
      if (mine[name] === n || held.has(n)) continue;
      if (Object.values(mine).includes(n)) continue; // a clash, reported by findClashes
      missing.push({ kind: n, name, source: t.source });
    }
  }
  return missing;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const here = readFileSync(resolve(root, CODES), 'utf8');
  const mine = parseCodeKinds(here);
  const tables = [{ source: '(working tree)', kinds: mine }];
  const current = git('rev-parse', '--abbrev-ref', 'HEAD').trim(); // its committed table is the one being changed here
  for (const b of git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean)) {
    if (b === current) continue;
    let src;
    try { src = git('show', `${b}:${CODES}`); } catch { continue; }
    const kinds = parseCodeKinds(src);
    if (kinds) tables.push({ source: b, kinds });
  }
  const clashes = findClashes(tables);
  const missing = unreserved(mine, parseReserved(here), tables.slice(1));
  console.log(`code kinds: ${tables.length - 1} branch(es) with ${CODES} read`);
  for (const c of clashes) console.log(`CLASH kind ${c.kind}: ${c.uses.map((u) => `${u.name} (${u.sources.join(', ')})`).join(' vs ')}`);
  for (const m of missing) console.log(`UNRESERVED kind ${m.kind} (${m.name} on ${m.source}): add it to RESERVED_CODE_KINDS`);
  if (clashes.length || missing.length) process.exit(1);
  console.log('no kind is used for two codes, and every kind another branch uses is reserved here');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
