// The only way to deploy the relayer bundle: stage, check, then take the domain.
//   node scripts/relayer-deploy.mjs [folder, default deploy/relayer-vercel] [--expect-200 /v1/stats,/v1/x402/catalog]
// 1. `vercel deploy --prod --skip-domain` run INSIDE the folder (never `--cwd` from another directory: the CLI
//    would ship the routing of whatever project the shell is in; that took the relayer down on 2026-11-12).
// 2. Probes the staged deployment (production env, not yet on the domain) and stops if anything is wrong.
// 3. `vercel promote`, probes the domain's deployment again, and prints the rollback command if that fails.
// The folder must already hold the bundle to ship (scripts/relayer-vercel.mjs) and .vercel/project.json.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const expect200 = (flag('--expect-200') ?? '').split(',').filter(Boolean);
const dir = resolve(args[0] ?? join(import.meta.dirname, '..', 'deploy', 'relayer-vercel'));
for (const f of ['api/index.mjs', 'api/events-seed.mjs', 'vercel.json', '.vercel/project.json']) {
  if (!existsSync(join(dir, f))) { console.error(`${join(dir, f)} is missing`); process.exit(2); }
}
const vercel = (...a) => {
  const r = spawnSync('vercel', a, { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32' });
  return `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
};
const get = (url, path) => vercel('curl', `${url}${path}`, '--', '-s', '-o', '-', '-w', '[HTTP %{http_code}]');

function check(url) {
  const bad = [];
  const want = (path, re, what) => { const out = get(url, path); if (!re.test(out)) bad.push(`${path}: expected ${what}, got ${out.trim().slice(-160)}`); };
  want('/__routing_probe__', /is not a route[\s\S]*\[HTTP 404\]/, "the relayer's own JSON 404 (the catch-all rewrite)");
  want('/events/nope.json', /no route \/events\/nope\.json/, "the seed function's JSON 404 (the /events rewrite, original path kept)");
  want('/api/events-seed', /\[HTTP (401|503)\]/, 'the cron refusing without its secret');
  want('/events/status', /\[HTTP (200|404)\]/, 'the seed status (200) or "has not run yet" (404)');
  const house = get(url, '/house.json');
  if (/\[HTTP 200\]/.test(house)) bad.push('/house.json answers 200: the deployment carries ANOTHER project\'s vercel.json');
  for (const p of expect200) want(p, /\[HTTP 200\]/, 'HTTP 200');
  return bad;
}

const out = vercel('deploy', '--prod', '--skip-domain', '--yes');
const url = /https:\/\/[a-z0-9-]+\.vercel\.app/.exec(out)?.[0];
if (!url || /"status":\s*"error"/.test(out)) { console.error(`staging failed:\n${out.slice(-1500)}`); process.exit(1); }
console.log(`staged ${url} (not on the domain yet)`);
let bad = check(url);
if (bad.length) { console.error(`NOT promoted. The staged deployment is wrong:\n- ${bad.join('\n- ')}`); process.exit(1); }
console.log('staged deployment routes correctly; promoting');
const promoted = vercel('promote', url, '--yes');
if (!/Success/.test(promoted)) { console.error(`promote failed:\n${promoted.slice(-800)}`); process.exit(1); }
bad = check(url);
if (bad.length) { console.error(`PROMOTED BUT WRONG. Roll back now (run inside ${dir}): vercel rollback <previous deployment url> --yes\n- ${bad.join('\n- ')}`); process.exit(1); }
console.log(`live: ${url}`);
