import { defineConfig } from 'vitest/config';

// Phase 2 staking suite (capacity_stake, safety_pool): needs the private WSL validator on 127.0.0.1:9199
// with the stream_loan fixtures (npm run test:staking restarts it with fresh fixtures first).
export default defineConfig({
  test: {
    include: ['test/solana/staking.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    pool: 'forks',
    fileParallelism: false,
    env: { STAKING_REQUIRED: '1' },
  },
});
