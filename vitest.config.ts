import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // the Solana suite needs a local validator: npm run test:solana
    exclude: ['test/solana/**', 'node_modules/**'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
