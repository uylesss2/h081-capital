// Bundles relayer/vercel.ts into a self-contained Vercel project in deploy/relayer-vercel/ (gitignored):
//   node scripts/relayer-vercel.mjs            # bundle only
//   cd deploy/relayer-vercel && vercel deploy --prod
// Every path is served by the one function (api/index.mjs). Secrets live only in the Vercel project's
// environment (RELAYER_SOLANA_KEYPAIR_JSON etc., see relayer/README.md), never in the bundle.
//
// x402 prove-disclose: with RELAYER_X402_CIRCUITS_DIR set at bundle time (a build/circuits-style directory),
// the disclose artifacts are copied into deploy/relayer-vercel/circuits/disclose/ and shipped with the
// function (vercel.json includeFiles); the function finds them next to itself at runtime. The vkey's sha256
// is printed so the owner can pin RELAYER_X402_DISCLOSE_VKEY_SHA256 in the Vercel environment.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'deploy', 'relayer-vercel');
rmSync(join(out, 'api'), { recursive: true, force: true });
rmSync(join(out, 'circuits'), { recursive: true, force: true });
mkdirSync(join(out, 'api'), { recursive: true });
await build({
  entryPoints: [join(root, 'relayer', 'vercel.ts')],
  outfile: join(out, 'api', 'index.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22', minify: false, legalComments: 'none',
  // CommonJS dependencies inside an ESM bundle still use require, __filename and __dirname (e.g. `bindings`)
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; import { dirname as __dn } from 'node:path';"
      + ' const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);',
  },
});

const fn = { maxDuration: 120 };
const circuitsDir = process.env.RELAYER_X402_CIRCUITS_DIR;
if (circuitsDir) {
  const src = resolve(root, circuitsDir, 'disclose');
  const files = ['disclose.zkey', 'disclose.vkey.json', join('disclose_js', 'disclose.wasm'), join('disclose_js', 'witness_calculator.js')];
  for (const f of files) if (!existsSync(join(src, f))) throw new Error(`RELAYER_X402_CIRCUITS_DIR: missing ${join(src, f)}`);
  const dst = join(out, 'circuits', 'disclose');
  mkdirSync(join(dst, 'disclose_js'), { recursive: true });
  for (const f of files) copyFileSync(join(src, f), join(dst, f));
  fn.includeFiles = 'circuits/**';
  const sha = createHash('sha256').update(readFileSync(join(src, 'disclose.vkey.json'))).digest('hex');
  console.log(`bundled disclose circuit artifacts from ${src}\n  disclose.vkey.json sha256 ${sha}  (pin as RELAYER_X402_DISCLOSE_VKEY_SHA256)`);
}
writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'h081-relayer', private: true, type: 'module', engines: { node: '24.x' } }, null, 2) + '\n');
writeFileSync(join(out, 'vercel.json'), JSON.stringify({
  functions: { 'api/index.mjs': fn },
  rewrites: [{ source: '/(.*)', destination: '/api/index' }],
}, null, 2) + '\n');
console.log(`bundled relayer -> ${out}`);
