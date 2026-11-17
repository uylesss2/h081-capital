// Drives the rep_registry localnet from Windows or Linux: keygen | build | loan-build | fixtures | start | stop | restart.
// Validator on rpc 8899 / ws 8900 with its ledger in solana/test-ledger/rep (gitignored). Localnet only: nothing here
// talks to a public cluster.
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
function fixtures() {
  const r = spawnSync(process.execPath, ['--import', 'tsx', resolve(root, 'scripts', 'rep-fixtures.mts')], { stdio: 'inherit', cwd: root });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const cmd = process.argv[2] ?? 'restart';
switch (cmd) {
  case 'keygen': bash('rep-keygen.sh'); break;
  case 'build': bash('rep-build.sh'); break;
  // stream_loan from this worktree (the fixture Slots' program; the lender-close test runs its close_slot)
  case 'loan-build': bash('rep-loan-build.sh'); break;
  case 'fixtures': fixtures(); break;
  case 'start': bash('rep-start-detached.sh'); break;
  case 'stop': bash('rep-stop-validator.sh'); break;
  case 'restart':
    bash('rep-stop-validator.sh');
    if (!existsSync(resolve(root, 'solana', 'target-so', 'stream_loan.so'))) bash('rep-loan-build.sh');
    fixtures(); bash('rep-start-detached.sh'); break;
  default: console.error('usage: node scripts/solana-rep-localnet.mjs keygen|build|loan-build|fixtures|start|stop|restart'); process.exit(2);
}
