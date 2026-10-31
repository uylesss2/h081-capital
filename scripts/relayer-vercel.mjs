// Bundles relayer/vercel.ts into a self-contained Vercel project in deploy/relayer-vercel/ (gitignored):
//   node scripts/relayer-vercel.mjs            # bundle only
//   cd deploy/relayer-vercel && vercel deploy --prod
// Every path is served by the one function (api/index.mjs). Secrets live only in the Vercel project's
// environment (RELAYER_SOLANA_KEYPAIR_JSON etc., see relayer/README.md), never in the bundle.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'deploy', 'relayer-vercel');
rmSync(join(out, 'api'), { recursive: true, force: true });
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
writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'h081-relayer', private: true, type: 'module', engines: { node: '24.x' } }, null, 2) + '\n');
writeFileSync(join(out, 'vercel.json'), JSON.stringify({
  functions: { 'api/index.mjs': { maxDuration: 120 } },
  rewrites: [{ source: '/(.*)', destination: '/api/index' }],
}, null, 2) + '\n');
console.log(`bundled relayer -> ${out}`);
