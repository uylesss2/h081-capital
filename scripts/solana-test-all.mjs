// npm run test:solana: every Solana test file, each suite on its own private WSL validator.
//   1. pool      rpc 8999  vitest.solana.config.ts       e2e, pool (Groth16, Merkle probe), events, consistency
//   2. loan      rpc 9099  vitest.solana-loan.config.ts  stream_loan with stipend_pool
//   3. staking   rpc 9199  vitest.staking.config.ts      capacity_stake, safety_pool (+ stream_loan fixtures and .so)
// Each validator is restarted fresh right before its suite (the staking fixtures are time-relative) and
// stopped afterwards; only validators matched by their own ledger paths are touched. Port 8899/8900 belong
// to another project and are never used. A missing validator or program fails the run (no silent skips).
// Options: --keep (leave the validators running), --only pool|loan|staking (repeatable).
// Programs are not built here: npm run solana:build first (it builds every program into solana/target-so).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const only = args.flatMap((a, i) => (a === '--only' ? [args[i + 1]] : []));
const outDir = resolve(root, 'solana', 'target-so');
mkdirSync(outDir, { recursive: true });

const suites = [
  { name: 'pool', script: 'solana-localnet.mjs', config: 'vitest.solana.config.ts' },
  { name: 'loan', script: 'solana-loan-localnet.mjs', config: 'vitest.solana-loan.config.ts' },
  { name: 'staking', script: 'solana-staking-localnet.mjs', config: 'vitest.staking.config.ts' },
].filter((s) => only.length === 0 || only.includes(s.name));

const node = (file, ...a) => spawnSync(process.execPath, [file, ...a], { stdio: 'inherit', cwd: root, env: process.env }).status ?? 1;
const vitest = resolve(root, 'node_modules', 'vitest', 'vitest.mjs');

const results = [];
for (const s of suites) {
  console.log(`\n=== ${s.name}: restarting its validator`);
  const script = resolve(root, 'scripts', s.script);
  let status = node(script, 'restart');
  let counts = { passed: 0, failed: 0, skipped: 0, total: 0, files: 0 };
  if (status === 0) {
    const json = resolve(outDir, `vitest-${s.name}.json`);
    status = node(vitest, 'run', '--config', s.config, '--reporter=default', '--reporter=json', `--outputFile.json=${json}`);
    if (existsSync(json)) {
      const r = JSON.parse(readFileSync(json, 'utf8'));
      counts = { passed: r.numPassedTests, failed: r.numFailedTests, skipped: r.numPendingTests + r.numTodoTests, total: r.numTotalTests, files: r.testResults.length };
      if (counts.skipped > 0) { console.error(`${s.name}: ${counts.skipped} skipped test(s); every Solana test must run`); status = status || 1; }
    }
  } else {
    console.error(`${s.name}: validator did not start`);
  }
  if (!keep) node(script, 'stop');
  results.push({ suite: s.name, status, ...counts });
}

console.log('\n=== Solana test summary');
for (const r of results) console.log(`${r.status === 0 ? 'PASS' : 'FAIL'}  ${r.suite.padEnd(8)} files ${r.files}  tests ${r.passed}/${r.total} passed, ${r.failed} failed, ${r.skipped} skipped`);
const total = results.reduce((a, r) => ({ passed: a.passed + r.passed, total: a.total + r.total, failed: a.failed + r.failed }), { passed: 0, total: 0, failed: 0 });
console.log(`TOTAL  ${total.passed}/${total.total} passed, ${total.failed} failed`);
process.exit(results.every((r) => r.status === 0) ? 0 : 1);
