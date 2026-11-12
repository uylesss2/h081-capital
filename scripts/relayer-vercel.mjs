// Bundles relayer/vercel.ts into a self-contained Vercel project in deploy/relayer-vercel/ (gitignored):
//   node scripts/relayer-vercel.mjs            # bundle only
//   node scripts/relayer-deploy.mjs            # stage, check the routes, then take the domain (never `vercel deploy --prod` by hand)
// Deploy from INSIDE that folder, never with `vercel --cwd <folder>` from another directory: the CLI reads the
// vercel.json of the shell's working directory first, and from another Vercel project's folder it ships THAT
// project's routing instead of this one (none of the rewrites below: every path but /api/* is a platform 404).
// Check a preview before promoting: /v1/stats must reach the relayer, /house.json must not answer 200.
// /events/<file> and /api/events-seed are served by api/events-seed.mjs, every other path by the relayer
// (api/index.mjs). Secrets live only in the Vercel project's
// environment (RELAYER_SOLANA_KEYPAIR_JSON etc., see relayer/README.md), never in the bundle.
//
// Circuit artifacts (RELAYER_X402_CIRCUITS_DIR at bundle time names a build/circuits-style directory; default
// build/circuits) are copied into deploy/relayer-vercel/circuits/ and shipped with the function (vercel.json
// includeFiles); the function finds them next to itself at runtime (relayer/vercel.ts):
// - the verifying keys of the relay circuits (transact, grant, spend, delegate) are required: the relayer
//   verifies every proof before it stages it, and refuses to start without them;
// - the disclose prover's artifacts (zkey, wasm, witness calculator, vkey) enable x402 prove-disclose when present.
// Every vkey's sha256 is printed so the owner can pin RELAYER_VKEY_SHA256_<NAME> (and
// RELAYER_X402_DISCLOSE_VKEY_SHA256) in the Vercel environment.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'deploy', 'relayer-vercel');
rmSync(join(out, 'api'), { recursive: true, force: true });
rmSync(join(out, 'circuits'), { recursive: true, force: true });
mkdirSync(join(out, 'api'), { recursive: true });
// api/index.mjs: the relayer; api/events-seed.mjs: the fresh-install event-log snapshot (relayer/events-seed.ts)
for (const [entry, outName] of [['vercel.ts', 'index.mjs'], ['events-seed-vercel.ts', 'events-seed.mjs']]) await build({
  entryPoints: [join(root, 'relayer', entry)],
  outfile: join(out, 'api', outName),
  bundle: true, platform: 'node', format: 'esm', target: 'node22', minify: false, legalComments: 'none',
  // CommonJS dependencies inside an ESM bundle still use require, __filename and __dirname (e.g. `bindings`)
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; import { dirname as __dn } from 'node:path';"
      + ' const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);',
  },
});

const fn = { maxDuration: 120, includeFiles: 'circuits/**' };
const circuitsDir = resolve(root, process.env.RELAYER_X402_CIRCUITS_DIR || join('build', 'circuits'));
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const copy = (name, files) => {
  for (const f of files) {
    const dst = join(out, 'circuits', name, f);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(circuitsDir, name, f), dst);
  }
};

// relay circuits: verifying keys, required
for (const name of ['transact', 'grant', 'spend', 'delegate']) {
  const vkey = join(circuitsDir, name, `${name}.vkey.json`);
  if (!existsSync(vkey)) {
    throw new Error(`${vkey} is missing: the relayer verifies every proof before staging it and does not start without the verifying keys `
      + '(set RELAYER_X402_CIRCUITS_DIR to a build/circuits directory that holds them)');
  }
  copy(name, [`${name}.vkey.json`]);
  console.log(`bundled ${name}.vkey.json sha256 ${sha(vkey)}  (pin as RELAYER_VKEY_SHA256_${name.toUpperCase()})`);
}

// disclose prover: optional
const discloseFiles = ['disclose.zkey', 'disclose.vkey.json', join('disclose_js', 'disclose.wasm'), join('disclose_js', 'witness_calculator.js')];
if (discloseFiles.every((f) => existsSync(join(circuitsDir, 'disclose', f)))) {
  copy('disclose', discloseFiles);
  console.log(`bundled disclose circuit artifacts from ${join(circuitsDir, 'disclose')}\n  disclose.vkey.json sha256 ${sha(join(circuitsDir, 'disclose', 'disclose.vkey.json'))}  (pin as RELAYER_X402_DISCLOSE_VKEY_SHA256)`);
} else {
  console.log(`no complete disclose prover artifacts in ${join(circuitsDir, 'disclose')}: x402 prove-disclose will answer 503 service_disabled`);
}
writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'h081-relayer', private: true, type: 'module', engines: { node: '24.x' } }, null, 2) + '\n');
// A full event-log snapshot to start the seed cron from (RELAYER_SEED_DIR names the folder scripts/events-seed.mts
// wrote): the relayer's RPC keeps only the last days, so without it (or EVENTS_SEED_RPC, or a stored snapshot) the
// cron cannot build the pool's whole history. Optional; ship a recent one.
rmSync(join(out, 'seed'), { recursive: true, force: true });
const seedDir = process.env.RELAYER_SEED_DIR ? resolve(root, process.env.RELAYER_SEED_DIR) : undefined;
const seeds = seedDir && existsSync(seedDir) ? readdirSync(seedDir).filter((f) => f.endsWith('.events.json')) : [];
for (const f of seeds) {
  mkdirSync(join(out, 'seed'), { recursive: true });
  copyFileSync(join(seedDir, f), join(out, 'seed', f));
  console.log(`bundled seed snapshot ${f} (${(readFileSync(join(seedDir, f)).length / 1e6).toFixed(2)} MB)`);
}
if (seeds.length === 0) console.log('no seed snapshot bundled (RELAYER_SEED_DIR): the seed cron needs a stored snapshot or EVENTS_SEED_RPC');
writeFileSync(join(out, 'vercel.json'), JSON.stringify({
  functions: { 'api/index.mjs': fn, 'api/events-seed.mjs': { maxDuration: 300, ...(seeds.length ? { includeFiles: 'seed/**' } : {}) } },
  // the seed snapshot's cron, hourly (a Hobby plan allows only daily crons: there, use '7 6 * * *')
  crons: [{ path: '/api/events-seed', schedule: '7 * * * *' }],
  rewrites: [
    { source: '/api/events-seed', destination: '/api/events-seed' },
    { source: '/events/:file', destination: '/api/events-seed' },
    { source: '/(.*)', destination: '/api/index' },
  ],
}, null, 2) + '\n');
console.log(`bundled relayer -> ${out}`);
