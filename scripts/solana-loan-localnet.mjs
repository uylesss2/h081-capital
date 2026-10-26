// Drives the stream_loan WSL toolchain from Windows: build | start | stop | restart | keygen.
// Private validator on rpc 9099 (ledger ~/stipend-loan-ledger); never touches other validators.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const toWsl = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
const scripts = toWsl(resolve(root, 'solana', 'scripts'));

function run(script) {
  const isWin = process.platform === 'win32';
  const [cmd, args] = isWin ? ['wsl.exe', ['-d', 'Ubuntu', '--', 'bash', `${scripts}/${script}`]] : ['bash', [`${scripts}/${script}`]];
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const cmd = process.argv[2] ?? 'restart';
switch (cmd) {
  case 'keygen': run('loan-keygen.sh'); break;
  case 'build': run('loan-build.sh'); break;
  case 'start': run('loan-start-detached.sh'); break;
  case 'stop': run('loan-stop-validator.sh'); break;
  case 'restart': run('loan-stop-validator.sh'); run('loan-start-detached.sh'); break;
  default: console.error('usage: node scripts/solana-loan-localnet.mjs keygen|build|start|stop|restart'); process.exit(2);
}
