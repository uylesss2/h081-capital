import { defineConfig } from 'tsup';

// ESM only: the SDK uses import.meta and top-level ESM dependencies (snarkjs). The CLI gets the shebang so
// `npx @h081/mcp` / the `h081-mcp` bin run it directly. Dependencies stay external (package.json lists them).
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    clean: true,
    outDir: 'dist',
    target: 'node20',
    platform: 'node',
    sourcemap: false,
    treeshake: true,
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    dts: false,
    outDir: 'dist',
    target: 'node20',
    platform: 'node',
    banner: { js: '#!/usr/bin/env node' },
    sourcemap: false,
  },
]);
