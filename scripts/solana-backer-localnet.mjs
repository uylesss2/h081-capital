// Drives the backed-line test validator (WSL, rpc 18899, ledger solana/test-ledger/backer) from Windows:
//   start [base] | stop | restart [base] | build. Localnet only; never touches the other suites' validators.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const toWsl = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
const scripts = toWsl(resolve(root, 'solana', 'scripts'));

function run(script, ...args) {
  const isWin = process.platform === 'win32';
  const [cmd, a] = isWin ? ['wsl.exe', ['-d', 'Ubuntu', '--', 'bash', `${scripts}/${script}`, ...args]] : ['bash', [`${scripts}/${script}`, ...args]];
  const r = spawnSync(cmd, a, { stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const [cmd = 'restart', mode] = process.argv.slice(2);
switch (cmd) {
  case 'build': run('loan-build.sh'); break;
  case 'start': run('backer-validator.sh', 'start', ...(mode ? [mode] : [])); break;
  case 'stop': run('backer-validator.sh', 'stop'); break;
  case 'restart': run('backer-validator.sh', 'stop'); run('backer-validator.sh', 'start', ...(mode ? [mode] : [])); break;
  default: console.error('usage: node scripts/solana-backer-localnet.mjs start [base] | stop | restart [base] | build'); process.exit(2);
}
