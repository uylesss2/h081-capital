import { defineConfig } from 'vitest/config';

// stream_loan localnet tests: need the WSL validator on 127.0.0.1:9099 (npm run test:solana:loan starts a fresh one).
export default defineConfig({
  test: {
    include: ['test/solana/lending.test.ts'],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    pool: 'forks',
    fileParallelism: false,
    env: { STIPEND_LOAN_RPC: process.env.STIPEND_LOAN_RPC ?? 'http://127.0.0.1:9099' },
  },
});
