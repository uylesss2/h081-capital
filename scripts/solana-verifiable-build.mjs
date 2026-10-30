// Verifiable build from Windows: tars the committed `solana/` tree at a ref (default HEAD) with git
// archive, then runs solana/scripts/verifiable-build.sh in WSL (or bash elsewhere) on that tar.
// Uncommitted changes are never built: the tar is the commit, so the output matches the commit hash.
//   npm run solana:verifiable-build [-- --ref <gitref>] [-- --out <dir>]
// Outputs (default solana/target-verifiable/, gitignored): the four production .so files, SHA256SUMS,
// EXECUTABLE-HASHES and build-info.txt. No network access other than crates.io; nothing is deployed.
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const isWin = process.platform === 'win32';
const toWsl = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
const shPath = (p) => (isWin ? toWsl(p) : p);

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const ref = opt('ref', 'HEAD');
const out = resolve(opt('out', join(root, 'solana', 'target-verifiable')));

const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();
const commit = git('rev-parse', `${ref}^{commit}`);
if (ref === 'HEAD' && git('status', '--porcelain', '--', 'solana')) {
  console.warn('note: solana/ has uncommitted changes; they are NOT part of this build (the tar is the commit)');
}
const tmp = mkdtempSync(join(tmpdir(), 'h081-vb-'));
const tar = join(tmp, 'solana-src.tar');
git('archive', '--format=tar', '-o', tar, commit, 'solana');
console.log(`source: ${commit} (solana/ tree) -> ${tar}`);

const script = shPath(join(root, 'solana', 'scripts', 'verifiable-build.sh'));
const shArgs = [script, '--src-tar', shPath(tar), '--commit', commit, '--out', shPath(out)];
const [cmd, args] = isWin ? ['wsl.exe', ['-d', 'Ubuntu', '--', 'bash', ...shArgs]] : ['bash', shArgs];
const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
rmSync(tmp, { recursive: true, force: true });
process.exit(r.status ?? 1);
