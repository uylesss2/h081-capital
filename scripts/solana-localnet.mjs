// Drives the WSL Solana toolchain from Windows: build | start | stop | restart | keygen.
// The validator is private and local (rpc 8999); it never touches other validators (8899 is another project's).
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
  case 'keygen': run('keygen.sh'); break;
  case 'build': run('build-all.sh'); break; // every program, all localnet variants
  case 'start': run('start-detached.sh'); break;
  case 'stop': run('stop-validator.sh'); break;
  case 'restart': run('stop-validator.sh'); run('start-detached.sh'); break;
  default: console.error('usage: node scripts/solana-localnet.mjs keygen|build|start|stop|restart'); process.exit(2);
}
