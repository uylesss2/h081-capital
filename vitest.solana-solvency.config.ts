import { defineConfig } from 'vitest/config';

// Solvency on a private validator (npm run test:solana:solvency starts a fresh one on 127.0.0.1:28899): real H081Bank,
// real proofs from the build tree (grant, spend, transact, disclose).
export default defineConfig({
  test: {
    include: ['test/solana/solvency.test.ts'],
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
    pool: 'forks',
    fileParallelism: false,
    env: { STIPEND_SOLVENCY_RPC: process.env.STIPEND_SOLVENCY_RPC ?? 'http://127.0.0.1:28899' },
  },
});
