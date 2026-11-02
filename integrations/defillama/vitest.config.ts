// Offline unit tests of the DefiLlama integration (address derivation only; no RPC).
//   npx vitest run --config integrations/defillama/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['integrations/defillama/**/*.test.ts'],
    exclude: ['node_modules/**'],
    pool: 'forks',
  },
});
