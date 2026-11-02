// Offline: the addresses the DefiLlama adapters derive must equal the SDK's own PDA helpers and the
// documented mainnet accounts (docs/MAINNET-RUNBOOK.md). No RPC.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { vaultAuthorityPda, vaultPda } from '../../../src/solana/pda.js';
// @ts-expect-error plain ESM script without types
import { ADDR, derived } from './derive-addresses.mjs';

const here = path.resolve(__dirname);
const read = (p: string) => readFileSync(path.join(here, '..', p), 'utf8');

describe('DefiLlama address derivation', () => {
  it('matches the stipend_pool SDK PDAs', () => {
    const program = new PublicKey(ADDR.STIPEND_POOL);
    expect(derived.vaultAuthority).toBe(vaultAuthorityPda(program).toBase58());
    expect(derived.usdgVault).toBe(vaultPda(program, new PublicKey(ADDR.USDG)).toBase58());
  });

  it('matches the documented mainnet accounts', () => {
    expect(derived.vaultAuthority).toBe('9JnWo2rJ1MpB14NKNSEXCV2iMtMim6oUpHpgJFSVb2B7');
    expect(derived.usdgVault).toBe('FaRG7DV8e7XF3RyoZrBb3h1oLiFFWFFCuYDSXsDoyyzG');
    expect(derived.capacityConfig).toBe('7QuqMc95ry9sjeem5gsS4SNQzoQfoHqVwSvAcSFq8uKS');
    expect(derived.safetyConfig).toBe('91QLL95oPgJF8yjWeKb41yMs5Z48UPd9mTXMH7xppoQA');
    expect(derived.loanRegistry).toBe('5MMWdQWZB3JWTCZXZsEGSLWegi9bk9iSitT9avdLo4Kt');
    expect(derived.treasuryUsdg).toBe('DxpmCZYAoDKpHmA5vWuopUrf3UVuGnPvditVrN9xDwDo');
    expect(derived.capacityVault).toBe('EUMsBu6yj1DAXriTMSaGQCs6Ff4H6Rb7QTueGa7AN6Nh');
    expect(derived.safetyVault).toBe('4qM5m3UGiJnn9G3rVUC9b2uMxJmnxKcDXDetX7UDXT8g');
  });

  it('TVL adapter derives the same vaults from the same ids', () => {
    const src = read('tvl/projects/h081/index.js');
    for (const id of [ADDR.STIPEND_POOL, ADDR.CAPACITY_STAKE, ADDR.SAFETY_POOL, ADDR.H081]) expect(src).toContain(id);
    expect(src).toContain('"vault_auth"');
    expect(src).toContain('"vault"');
    expect(src).not.toMatch(/https?:\/\/(?!h081\.xyz)/); // no API: every number comes from the chain
    // same derivation as the adapter's code path
    const pda = (seeds: Buffer[], programId: string) => PublicKey.findProgramAddressSync(seeds, new PublicKey(programId))[0].toBase58();
    expect(pda([Buffer.from('vault_auth')], ADDR.STIPEND_POOL)).toBe(derived.vaultAuthority);
    expect(pda([Buffer.from('vault'), new PublicKey(ADDR.H081).toBuffer()], ADDR.CAPACITY_STAKE)).toBe(derived.capacityVault);
    expect(pda([Buffer.from('vault'), new PublicKey(ADDR.H081).toBuffer()], ADDR.SAFETY_POOL)).toBe(derived.safetyVault);
  });

  it('fees adapter targets only the treasury and excludes the team wallets', () => {
    const src = read('fees/fees/h081.ts');
    expect(src).toContain(`targets: [TREASURY, TREASURY_USDG_ATA]`);
    expect(src).toContain(`const TREASURY = "${ADDR.TREASURY}"`);
    expect(src).toContain(`const TREASURY_USDG_ATA = "${derived.treasuryUsdg}"`);
    expect(src).toContain(`mints: [USDG]`);
    for (const w of ['5WCpirBe1wHUk6PL2nU97pj87PtyaqH9S6UJUbd5z2W1', '2wjxKzH7fVGpjcA9KpjDBDHjSAhz7u8ZgMLnVPVGSkDP', 'FZEMfMN7hhQcKPHRt2kb9ig5XArMvK5LqfSTXpQ1j4DZ', '5XJNtM7a9ocRL8f8vsyNVmQoekutCFJkGNXNQbkJP4bw']) {
      expect(src).toContain(w);
    }
    expect(src).toContain('blacklist_signers: INTERNAL');
    expect(src.toLowerCase()).toContain('trading');
    expect(src.toLowerCase()).toContain('excluded');
  });
});
