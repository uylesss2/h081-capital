import { defineConfig } from 'vitest/config';

// stipend_pool suite on the private WSL validator at 127.0.0.1:8999, plus the validator-free Solana unit
// tests (event log, cross-program consistency). stream_loan and staking have their own configs and
// validators; `npm run test:solana` runs all three (scripts/solana-test-all.mjs).
export default defineConfig({
  test: {
    include: ['test/solana/e2e.test.ts', 'test/solana/pool.test.ts', 'test/solana/events.test.ts', 'test/solana/consistency.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    pool: 'forks',
    fileParallelism: false,
    env: { SOLANA_REQUIRED: '1' },
  },
});
