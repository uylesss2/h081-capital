// Drives the solvency localnet from Windows or Linux: start | stop | restart. A private validator on rpc 28899 with its
// ledger in solana/test-ledger/solvency (gitignored), loading solana/target-so/stipend_pool.so at the localnet id.
// It never stops or reuses another suite's validator. Localnet only: nothing here talks to a public cluster.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const toWsl = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
const scripts = toWsl(resolve(root, 'solana', 'scripts'));
const isWin = process.platform === 'win32';

function bash(script) {
  const [cmd, args] = isWin ? ['wsl.exe', ['-d', 'Ubuntu', '--', 'bash', `${scripts}/${script}`]] : ['bash', [`${scripts}/${script}`]];
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const cmd = process.argv[2] ?? 'restart';
if ((cmd === 'start' || cmd === 'restart') && !existsSync(resolve(root, 'solana', 'target-so', 'stipend_pool.so'))) {
  console.error('solana/target-so/stipend_pool.so is missing: npm run solana:build first');
  process.exit(1);
}
switch (cmd) {
  case 'start': bash('solvency-start-detached.sh'); break;
  case 'stop': bash('solvency-stop-validator.sh'); break;
  case 'restart': bash('solvency-stop-validator.sh'); bash('solvency-start-detached.sh'); break;
  default: console.error('usage: node scripts/solana-solvency-localnet.mjs start|stop|restart'); process.exit(2);
}
