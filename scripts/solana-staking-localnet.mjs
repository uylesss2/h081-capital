// Drives the Phase 2 staking localnet from Windows: keygen | build | fixtures | start | stop | restart.
// Private validator on rpc 9199 (ledger ~/stipend-staking-ledger); never touches other validators
// (8899/8900 belong to another project, 8999 to the pool suite).
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const toWsl = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
const scripts = toWsl(resolve(root, 'solana', 'scripts'));
const isWin = process.platform === 'win32';

function wsl(script, capture = false) {
  const [cmd, args] = isWin ? ['wsl.exe', ['-d', 'Ubuntu', '--', 'bash', `${scripts}/${script}`]] : ['bash', [`${scripts}/${script}`]];
  const r = spawnSync(cmd, args, { stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' }, encoding: 'utf8' });
  if (r.status !== 0) process.exit(r.status ?? 1);
  return r.stdout;
}

function fixtures() {
  const t0 = wsl('staking-now.sh', true).trim(); // the validator's clock source
  const tsx = resolve(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const r = spawnSync(process.execPath, [tsx, resolve(root, 'test', 'solana', 'staking-fixtures.ts'), t0], { stdio: 'inherit', cwd: root });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const cmd = process.argv[2] ?? 'restart';
switch (cmd) {
  case 'keygen': wsl('staking-keygen.sh'); break;
  case 'build': wsl('staking-build.sh'); break;
  case 'fixtures': fixtures(); break;
  case 'start': wsl('staking-start.sh'); break;
  case 'stop': wsl('staking-stop.sh'); break;
  case 'restart': wsl('staking-stop.sh'); fixtures(); wsl('staking-start.sh'); break;
  default: console.error('usage: node scripts/solana-staking-localnet.mjs keygen|build|fixtures|start|stop|restart'); process.exit(2);
}
