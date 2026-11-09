import { defineConfig } from 'tsup';

// ESM only. Everything is bundled (noExternal) except snarkjs and ffjavascript, which stay real dependencies (they load
// wasm and worker code at run time). Bundled CommonJS dependencies call require(), so each file gets a require from
// createRequire, and __filename / __dirname. The shebang (as in integrations/mcp) lets `npx @h081lll/agent` and the `h081` bin run dist/cli.js.
const requireShim = [
  "import { createRequire as __h081CreateRequire } from 'node:module';",
  "import { fileURLToPath as __h081FileURLToPath } from 'node:url';",
  "import { dirname as __h081Dirname } from 'node:path';",
  "const require = __h081CreateRequire(import.meta.url);",
  "const __filename = __h081FileURLToPath(import.meta.url);",
  "const __dirname = __h081Dirname(__filename);",
].join(' ');

export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
  format: ['esm'],
  outDir: 'dist',
  target: 'node20',
  platform: 'node',
  sourcemap: false,
  clean: true,
  splitting: false,
  treeshake: true,
  noExternal: [/.*/],
  external: ['snarkjs', 'ffjavascript'],
  dts: { entry: { index: 'src/index.ts' }, resolve: false },
  banner: { js: '#!/usr/bin/env node\n' + requireShim },
});
