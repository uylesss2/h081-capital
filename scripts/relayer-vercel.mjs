// Bundles relayer/vercel.ts into a self-contained Vercel project in deploy/relayer-vercel/ (gitignored):
//   node scripts/relayer-vercel.mjs            # bundle only
//   cd deploy/relayer-vercel && vercel deploy --prod
// Every path is served by the one function (api/index.mjs). Secrets live only in the Vercel project's
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
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
writeFileSync(join(out, 'vercel.json'), JSON.stringify({
  functions: { 'api/index.mjs': fn, 'api/events-seed.mjs': { maxDuration: 300 } },
  // the seed snapshot's cron, hourly (a Hobby plan allows only daily crons: there, use '7 6 * * *')
  crons: [{ path: '/api/events-seed', schedule: '7 * * * *' }],
  rewrites: [
    { source: '/api/events-seed', destination: '/api/events-seed' },
    { source: '/events/:file', destination: '/api/events-seed' },
    { source: '/(.*)', destination: '/api/index' },
  ],
}, null, 2) + '\n');
console.log(`bundled relayer -> ${out}`);
