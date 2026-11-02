// SolanaPool.checkRecipient against a scripted RPC (no validator): public payouts go to the recipient's
// associated token account, so a recipient that can never sign for it must be refused before any proof.
import { describe, expect, it } from 'vitest';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { SolanaPool } from '../../src/solana/wallet.js';

const accounts = new Map<string, { owner: PublicKey; executable: boolean }>();
const rpc = { async getAccountInfo(k: PublicKey) { return accounts.get(k.toBase58()) ?? null; } };
const pool = new SolanaPool(rpc as unknown as Connection, Keypair.generate().publicKey);

describe('SolanaPool.checkRecipient', () => {
  it('accepts an on-curve wallet, funded or not', async () => {
    const fresh = Keypair.generate().publicKey;
    await expect(pool.checkRecipient(fresh)).resolves.toBeUndefined();
    const funded = Keypair.generate().publicKey;
    accounts.set(funded.toBase58(), { owner: SystemProgram.programId, executable: false });
    await expect(pool.checkRecipient(funded)).resolves.toBeUndefined();
  });

  it('refuses token accounts and mints (Token and Token-2022), even on curve', async () => {
    for (const owner of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const ta = Keypair.generate().publicKey;
      accounts.set(ta.toBase58(), { owner, executable: false });
      await expect(pool.checkRecipient(ta)).rejects.toThrow(/token account or mint/);
    }
  });

  it('refuses programs', async () => {
    const prog = Keypair.generate().publicKey;
    accounts.set(prog.toBase58(), { owner: new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'), executable: true });
    await expect(pool.checkRecipient(prog)).rejects.toThrow(/program/);
  });

  it('refuses off-curve addresses unless allowed', async () => {
    const [pda] = PublicKey.findProgramAddressSync([new TextEncoder().encode('x')], Keypair.generate().publicKey);
    await expect(pool.checkRecipient(pda)).rejects.toThrow(/program-derived/);
    await expect(pool.checkRecipient(pda, { allowOffCurve: true })).resolves.toBeUndefined();
  });
});
