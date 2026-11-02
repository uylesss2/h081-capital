// Offline unit tests of the DefiLlama integration (address derivation + adapter execution against
// stubbed DefiLlama helpers; no RPC, no Allium key).
//   npx vitest run --config integrations/defillama/vitest.config.ts
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// fees/fees/h081.ts imports the dimension-adapters helpers by relative path (they exist only in the
// upstream repo); in this suite those specifiers resolve to recording stubs.
const stubs = path.resolve(__dirname, 'scripts', 'stubs');

export default defineConfig({
  resolve: {
    alias: [
      { find: /^\.\.\/adapters\/types$/, replacement: path.join(stubs, 'adapters-types.ts') },
      { find: /^\.\.\/helpers\/chains$/, replacement: path.join(stubs, 'helpers-chains.ts') },
      { find: /^\.\.\/helpers\/token$/, replacement: path.join(stubs, 'helpers-token.ts') },
      { find: /^\.\.\/helpers\/metrics$/, replacement: path.join(stubs, 'helpers-metrics.ts') },
    ],
  },
  test: {
    include: ['integrations/defillama/**/*.test.ts'],
    exclude: ['node_modules/**'],
    pool: 'forks',
  },
});
