// Drives the Phase 2 staking localnet from Windows: keygen | build | fixtures | start | stop | restart.
// Private validator on rpc 9199 (ledger ~/stipend-staking-ledger); never touches other validators
// (8899/8900 belong to another project, 8999 to the pool suite).
// STAKING_RPC_PORT, STAKING_FAUCET_PORT, STAKING_GOSSIP_PORT, STAKING_DYNAMIC_PORTS, STAKING_LEDGER (a WSL path),
// STAKING_STAGE and STAKING_LOG are passed on to the WSL scripts (WSLENV), so a worktree can run the suite on its own
// port and ledger; point the tests at it with STAKING_RPC.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const toWsl = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
const scripts = toWsl(resolve(root, 'solana', 'scripts'));
const isWin = process.platform === 'win32';
const passOn = Object.keys(process.env).filter((k) => /^STAKING_(RPC_PORT|FAUCET_PORT|GOSSIP_PORT|DYNAMIC_PORTS|LEDGER|STAGE|LOG)$/.test(k));
const wslenv = [process.env.WSLENV, ...passOn.map((k) => `${k}/u`)].filter(Boolean).join(':');

function wsl(script, capture = false) {
  const [cmd, args] = isWin ? ['wsl.exe', ['-d', 'Ubuntu', '--', 'bash', `${scripts}/${script}`]] : ['bash', [`${scripts}/${script}`]];
  const r = spawnSync(cmd, args, { stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1', ...(wslenv ? { WSLENV: wslenv } : {}) }, encoding: 'utf8' });
  if (r.status !== 0) process.exit(r.status ?? 1);
  return r.stdout;
}

function fixtures() {
  const t0 = wsl('staking-now.sh', true).trim(); // the validator's clock source
  const tsx = resolve(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const r = spawnSync(process.execPath, [tsx, resolve(root, 'test', 'solana', 'staking-fixtures.ts'), t0], { stdio: 'inherit', cwd: root });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

/** safety_pool `slash` records itself in stream_loan by CPI, so the staking validator must load stream_loan.so too. */
function needStreamLoan() {
  if (existsSync(resolve(root, 'solana', 'target-so', 'stream_loan.so'))) return;
  console.error('solana/target-so/stream_loan.so is missing: the staking suite needs it (slash -> stream_loan record_slash). Build it: node scripts/solana-loan-localnet.mjs build');
  process.exit(1);
}

const cmd = process.argv[2] ?? 'restart';
switch (cmd) {
  case 'keygen': wsl('staking-keygen.sh'); break;
  case 'build': wsl('staking-build.sh'); break;
  case 'fixtures': fixtures(); break;
  case 'start': needStreamLoan(); wsl('staking-start.sh'); break;
  case 'stop': wsl('staking-stop.sh'); break;
  case 'restart': needStreamLoan(); wsl('staking-stop.sh'); fixtures(); wsl('staking-start.sh'); break;
  default: console.error('usage: node scripts/solana-staking-localnet.mjs keygen|build|fixtures|start|stop|restart'); process.exit(2);
}
