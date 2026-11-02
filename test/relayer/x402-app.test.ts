// buildX402 (relayer/app.ts) over a stub connection: which problems are deliberate refusals (ConfigError, the
// relayer must not start) and which only leave the seller off (the free relay API keeps working). Nothing is
// ever sent on chain at startup: a missing payment account is reported for the owner to create from the vault.
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { X402SetupError, buildX402 } from '../../relayer/app.js';
import { ConfigError, type X402Config } from '../../relayer/config.js';
import type { SolanaRelayer } from '../../relayer/solana.js';
import { DEFAULT_X402_PRICES, X402_SERVICE_IDS, type X402ServiceId } from '../../relayer/x402/catalog.js';
import { SOLANA_MAINNET_NETWORK } from '../../relayer/x402/types.js';

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const treasury = new PublicKey('EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq');
const USDG = new PublicKey('2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH');
const usdgAta = getAssociatedTokenAddressSync(USDG, treasury, true, TOKEN_2022_PROGRAM_ID);
const solana = { feeOwner: treasury, programId: Keypair.generate().publicKey } as unknown as SolanaRelayer;

/** A CDP-style Ed25519 secret (base64 of seed | public key), as the facilitator client parses it. */
function cdpSecret(): string {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return Buffer.concat([seed, pub]).toString('base64');
}
const apiKeySecret = cdpSecret();

const config = (over: Partial<X402Config> = {}): X402Config => ({
  facilitatorUrl: 'https://facilitator.example', apiKeyId: 'organizations/o/apiKeys/k', apiKeySecret, facilitatorTimeoutMs: 1_000,
  network: SOLANA_MAINNET_NETWORK, payTo: treasury.toBase58(), assets: [USDG.toBase58()], payToTokenAccounts: new Map(),
  prices: new Map<X402ServiceId, bigint>(X402_SERVICE_IDS.map((id) => [id, DEFAULT_X402_PRICES[id]])),
  resourceBase: 'https://relayer.example', maxTimeoutSeconds: 120, serviceName: 'H081 Capital', tags: ['solana'],
  priority: { maxInFlight: 4, maxLamports: 4_000_000, priceCeil: 5_000_000 }, loanProgramId: Keypair.generate().publicKey.toBase58(), ...over,
});

/** A cluster that knows the USDG mint (Token-2022, 6 decimals) and, optionally, the treasury's ATA. Nothing else (no send). */
function cluster(o: { ata?: boolean; genesis?: string | Error; decimals?: number } = {}) {
  const mintData = Buffer.alloc(82);
  mintData[44] = o.decimals ?? 6;
  const calls: string[] = [];
  return {
    calls,
    connection: {
      getGenesisHash: async () => { calls.push('genesis'); if (o.genesis instanceof Error) throw o.genesis; return o.genesis ?? MAINNET_GENESIS; },
      getAccountInfo: async (k: PublicKey) => {
        calls.push(`account ${k.toBase58()}`);
        if (k.equals(USDG)) return { owner: TOKEN_2022_PROGRAM_ID, data: mintData, lamports: 1, executable: false };
        if (k.equals(usdgAta) && o.ata !== false) return { owner: TOKEN_2022_PROGRAM_ID, data: Buffer.alloc(165), lamports: 1, executable: false };
        return null;
      },
    } as never,
  };
}

const build = (cfg: X402Config, c = cluster(), logs: string[] = []) => buildX402(cfg, { connection: c.connection, solana, log: (l) => logs.push(l) });

describe('buildX402', () => {
  it('builds the seller over the existing payment account without sending anything', async () => {
    const c = cluster();
    const logs: string[] = [];
    const seller = await build(config(), c, logs);
    expect(seller.opts.payTo.equals(treasury)).toBe(true);
    expect(seller.opts.assets).toEqual([{ mint: USDG.toBase58(), decimals: 6, tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(), payToTokenAccount: usdgAta.toBase58(), symbol: 'USDG' }]);
    expect(usdgAta.toBase58()).toBe('DxpmCZYAoDKpHmA5vWuopUrf3UVuGnPvditVrN9xDwDo');
    expect(seller.services.map((s) => s.id).sort()).toEqual(['loans-market', 'preflight', 'prove-disclose', 'relay-priority']);
    expect(c.calls).toEqual(['genesis', `account ${USDG.toBase58()}`, `account ${usdgAta.toBase58()}`]);
    expect(logs.some((l) => l.startsWith('x402: seller on, payTo EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq'))).toBe(true);
  });

  it('deliberate refusals are ConfigErrors: wrong network, non-treasury payTo, pinned ATA mismatch, bad asset', async () => {
    await expect(build(config({ network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' }))).rejects.toThrow(ConfigError);
    await expect(build(config({ network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' }))).rejects.toThrow(/does not match the RPC cluster/);
    await expect(build(config({ payTo: Keypair.generate().publicKey.toBase58() }))).rejects.toThrow(ConfigError);
    const pinnedWrong = new Map([[USDG.toBase58(), Keypair.generate().publicKey.toBase58()]]);
    await expect(build(config({ payToTokenAccounts: pinnedWrong }))).rejects.toThrow(ConfigError);
    await expect(build(config({ payToTokenAccounts: pinnedWrong }))).rejects.toThrow(/not the pinned/);
    await expect(build(config({ assets: [Keypair.generate().publicKey.toBase58()] }))).rejects.toThrow(/not found/);
    await expect(build(config(), cluster({ decimals: 9 }))).rejects.toThrow(/9 decimals/);
  });

  it('a missing payment account is an X402SetupError (seller off, relayer up): no transaction is sent to create it', async () => {
    const c = cluster({ ata: false });
    const err = await build(config(), c).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(X402SetupError);
    expect(err).not.toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/DxpmCZYAoDKpHmA5vWuopUrf3UVuGnPvditVrN9xDwDo .* does not exist; create it from the vault/);
    expect(c.calls.filter((x) => !x.startsWith('genesis') && !x.startsWith('account'))).toEqual([]);
    // the pinned account missing is the same: the owner creates it, the seller never does
    const pinned = new Map([[USDG.toBase58(), usdgAta.toBase58()]]);
    await expect(build(config({ payToTokenAccounts: pinned }), cluster({ ata: false }))).rejects.toThrow(X402SetupError);
  });

  it('an RPC failure during setup is not a ConfigError either', async () => {
    const err = await build(config(), cluster({ genesis: new Error('rpc down') })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ConfigError);
  });

  it('unusable disclose artifacts switch the prover off, not the seller', async () => {
    const logs: string[] = [];
    const seller = await build(config({ circuitsDir: 'C:/nonexistent/circuits' }), cluster(), logs);
    expect(seller.services.map((s) => s.id)).toContain('prove-disclose');
    expect(logs.some((l) => l.startsWith('x402: disclose prover off: disclose circuit artifact missing'))).toBe(true);
    const disclose = seller.services.find((s) => s.id === 'prove-disclose')!;
    await expect(disclose.prepare!({ body: {}, url: new URL('http://x/'), clientKey: 'k', log: () => undefined })).rejects.toMatchObject({ status: 503, code: 'service_disabled' });
  });
});
