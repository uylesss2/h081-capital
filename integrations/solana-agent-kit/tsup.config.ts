import { defineConfig } from 'tsup';

// Same layout as the upstream @solana-agent-kit/plugin-* packages: cjs + esm with type declarations.
// Dependencies and peer dependencies stay external; the H081 SDK (../../src, ../core) is bundled in.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  outDir: 'dist',
  target: 'node20',
  platform: 'node',
  shims: true,
  sourcemap: false,
  treeshake: true,
});
