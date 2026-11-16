import { defineConfig } from 'vitest/config';

// Backed lines on stream_loan: needs the WSL validator on 127.0.0.1:18899 (npm run test:solana:backer starts a fresh one
// with the pre-backer program, so the suite begins with the upgrade rehearsal).
export default defineConfig({
  test: {
    include: ['test/solana/backer.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    pool: 'forks',
    fileParallelism: false,
    env: { STIPEND_BACKER_RPC: process.env.STIPEND_BACKER_RPC ?? 'http://127.0.0.1:18899' },
  },
});
