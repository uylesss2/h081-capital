// A stub Solana cluster for SolanaRelayer tests (no validator): one or more SPL Token mints with 6 decimals, a
// complete pool account that knows the given roots, no spent nullifiers, a clock, and a set of accounts that
// exist (token accounts and vaults); everything else is absent.
import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { LEVELS } from '../../../src/inputs.js';
import { POOL_DISCRIMINATOR, POOL_SIZE } from '../../../src/solana/program.js';
import { poolPda } from '../../../src/solana/pda.js';
import { clockAccount } from './x402.js';

export interface StubClusterOptions {
  programId: PublicKey;
  mints: PublicKey[];
  roots?: bigint[];
  now?: bigint;
  lamports?: number;
  /** accounts that exist (165-byte SPL Token accounts) */
  existing?: PublicKey[];
}

/** A complete ["pool"] account whose root history starts with `roots`. */
export function poolAccount(programId: PublicKey, roots: bigint[]) {
  const data = Buffer.alloc(POOL_SIZE);
  Buffer.from(POOL_DISCRIMINATOR).copy(data, 0);
  roots.forEach((r, i) => Buffer.from(r.toString(16).padStart(64, '0'), 'hex').copy(data, 16 + 32 * LEVELS + 32 * i));
  return { data, owner: programId, lamports: 1, executable: false };
}

/** An SPL Token mint account with `decimals` (byte 44 of the Mint layout). */
export const mintAccount = (decimals = 6) => { const b = Buffer.alloc(82); b[44] = decimals; return { owner: TOKEN_PROGRAM_ID, data: b, lamports: 1, executable: false }; };

export function stubCluster(o: StubClusterOptions): Connection {
  const pool = poolAccount(o.programId, o.roots ?? [11n]);
  const existing = o.existing ?? [];
  return {
    getAccountInfo: async (k: PublicKey) => {
      if (o.mints.some((m) => m.equals(k))) return mintAccount();
      if (k.equals(poolPda(o.programId))) return pool;
      if (k.equals(SYSVAR_CLOCK_PUBKEY)) return clockAccount(o.now ?? 1_800_000_000n);
      if (existing.some((e) => e.equals(k))) return { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(165), lamports: 2_039_280, executable: false };
      return null;
    },
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(() => null),
    getBalance: async () => o.lamports ?? 1_000_000_000,
  } as unknown as Connection;
}
