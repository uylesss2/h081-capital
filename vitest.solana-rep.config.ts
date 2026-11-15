import { defineConfig } from 'vitest/config';

// rep_registry localnet tests: need the validator on 127.0.0.1:8899 with the fixture accounts
// (npm run test:solana:rep builds the fixtures and starts a fresh one).
export default defineConfig({
  test: {
    include: ['test/solana/reputation.test.ts'],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    pool: 'forks',
    fileParallelism: false,
    env: { STIPEND_REP_RPC: process.env.STIPEND_REP_RPC ?? 'http://127.0.0.1:8899' },
  },
});
