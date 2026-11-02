// Builds the relayer backends from a loaded config. Shared by the long-running server (main.ts) and the
// serverless entry (vercel.ts).
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { JsonRpcProvider, Wallet as EthersWallet } from 'ethers';
import { initCrypto } from '../src/crypto.js';
import { fetchLookupTable } from '../src/solana/alt.js';
import { poolPda } from '../src/solana/pda.js';
import { ConfigError, type RelayerConfig, type X402Config } from './config.js';
import { EvmRelayer } from './evm.js';
import { RateLimiter } from './ratelimit.js';
import type { RelayerServerOptions } from './server.js';
import { SolanaRelayer, solanaRelayerOptions } from './solana.js';
import type { X402Asset } from './x402/catalog.js';
import { CdpFacilitator } from './x402/facilitator.js';
import { LoanMarketReader } from './x402/loans.js';
import { DiscloseProver, poolRootsReader } from './x402/prove.js';
import { X402Seller } from './x402/seller.js';
import { loansMarket, preflight, proveDisclose, relayPriority } from './x402/services.js';
import { caip2OfGenesis } from './x402/types.js';

export async function buildRelayer(cfg: RelayerConfig, log: (line: string) => void = console.log): Promise<RelayerServerOptions> {
  let evm: EvmRelayer | undefined;
  let solana: SolanaRelayer | undefined;
  let x402: X402Seller | undefined;
  if (cfg.evm) {
    const signer = new EthersWallet(cfg.evm.key, new JsonRpcProvider(cfg.evm.rpc));
    evm = await new EvmRelayer({ signer, pool: cfg.evm.pool, minFees: cfg.evm.minFees, allowUnpaid: cfg.allowUnpaid, maxGas: cfg.evm.maxGas }).init();
    log(`evm: relayer ${await signer.getAddress()} for pool ${cfg.evm.pool}`);
  }
  if (cfg.solana) {
    const s = cfg.solana;
    const connection = new Connection(s.rpc, 'confirmed');
    const secret = s.keypairJson ?? readFileSync(s.keypairPath!, 'utf8');
    const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret) as number[]));
    const lookupTables = await Promise.all(s.lookupTables.map((t) => fetchLookupTable(connection, new PublicKey(t))));
    const base = solanaRelayerOptions(s, { connection, payer, lookupTables, allowUnpaid: cfg.allowUnpaid });
    solana = await new SolanaRelayer({ ...base, priority: cfg.x402?.priority }).init();
    const created = await solana.ensureFeeAccounts();
    const note = created.length ? `, created fee accounts ${created.join(', ')}` : '';
    const cap = solana.capacity ? `capacity on (free tier ${solana.capacity.opts.freeTier})` : 'capacity off';
    log(`solana: relayer ${payer.publicKey.toBase58()} for program ${solana.programId.toBase58()}, `
      + `fee ${solana.feeBps} bps to treasury ${solana.feeOwner.toBase58()}, ${cap}${note}`);
    if (cfg.x402) {
      // an x402-only problem never takes the free relay API down: a deliberate refusal (ConfigError) still
      // stops the relayer, anything else (RPC failure, missing payment account) leaves the seller off
      try {
        x402 = await buildX402(cfg.x402, { connection, solana, log });
      } catch (e) {
        if (e instanceof ConfigError) throw e;
        log(`x402: seller off: ${e instanceof Error ? e.message : String(e)} (paid routes answer 503 x402_disabled until the next start)`);
      }
    }
  }
  return {
    evm, solana, limiter: new RateLimiter({ perMinute: cfg.perMinute, burst: cfg.burst }), trustProxy: cfg.trustProxy,
    corsOrigins: cfg.corsOrigins, log: (line) => log(`${new Date().toISOString()} ${line}`), x402, publicBase: cfg.x402?.resourceBase,
  };
}

/** A reason the seller cannot start right now that is not a configuration refusal (the relayer keeps running without it). */
export class X402SetupError extends Error {}

/**
 * The x402 seller: checks the network against the RPC's genesis hash, the payment assets (6 decimals) and
 * the treasury's token accounts (derived ATAs, pinned when configured), then wires the four services.
 * Throws a ConfigError for a deliberate refusal (wrong network, non-treasury payTo, pinned ATA mismatch, bad
 * asset); an X402SetupError (or an RPC error) when the seller merely cannot start yet, e.g. a payment
 * account the owner has not created from the vault. Nothing is sent on chain here, and the facilitator is
 * not called (lazy), so neither blocks the free relay API.
 */
export async function buildX402(
  x: X402Config, deps: { connection: Connection; solana: SolanaRelayer; log: (line: string) => void },
): Promise<X402Seller> {
  const { connection, solana, log } = deps;
  const genesis = await connection.getGenesisHash();
  if (caip2OfGenesis(genesis) !== x.network) throw new ConfigError(`RELAYER_X402_NETWORK ${x.network} does not match the RPC cluster (${caip2OfGenesis(genesis)})`);
  const payTo = new PublicKey(x.payTo);
  if (!payTo.equals(solana.feeOwner)) throw new ConfigError('x402 payTo must be the platform treasury');
  const assets: X402Asset[] = [];
  for (const m of x.assets) {
    const mint = new PublicKey(m);
    const info = await connection.getAccountInfo(mint, 'confirmed');
    if (!info) throw new ConfigError(`x402 asset ${m} not found`);
    if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) throw new ConfigError(`x402 asset ${m} is not an SPL Token / Token-2022 mint`);
    const decimals = info.data.length > 44 ? info.data[44] : undefined; // Mint layout: decimals at byte 44
    if (decimals !== 6) throw new ConfigError(`x402 asset ${m} has ${decimals} decimals; prices are in 6-decimal base units`);
    const ata = getAssociatedTokenAddressSync(mint, payTo, true, info.owner);
    const pinned = x.payToTokenAccounts.get(m);
    if (pinned && pinned !== ata.toBase58()) throw new ConfigError(`x402: ATA(payTo, ${m}) is ${ata.toBase58()}, not the pinned ${pinned}`);
    if (!(await connection.getAccountInfo(ata, 'confirmed'))) {
      throw new X402SetupError(`the treasury's token account ${ata.toBase58()} for ${m} does not exist; create it from the vault (ATA of ${x.payTo}), pin it in RELAYER_X402_PAY_TO_TOKEN_ACCOUNTS and restart`);
    }
    assets.push({ mint: m, decimals: 6, tokenProgram: info.owner.toBase58(), payToTokenAccount: ata.toBase58(), symbol: SYMBOLS[m] });
  }
  const facilitator = new CdpFacilitator({ url: x.facilitatorUrl, apiKeyId: x.apiKeyId, apiKeySecret: x.apiKeySecret, timeoutMs: x.facilitatorTimeoutMs });
  const loans = new LoanMarketReader(connection, { programId: new PublicKey(x.loanProgramId), treasury: x.payTo });
  let prover: DiscloseProver | undefined;
  if (x.circuitsDir) {
    // a bad artifact set disables prove-disclose (503 service_disabled), not the other three services
    try {
      await initCrypto(); // Poseidon (path and commitment checks before proving)
      prover = new DiscloseProver({ circuitsDir: x.circuitsDir, vkeySha256: x.discloseVkeySha256, knownRoots: poolRootsReader(connection, poolPda(solana.programId)) });
      log(`x402: disclose prover on (vkey sha256 ${prover.vkeySha256})`);
    } catch (e) {
      log(`x402: disclose prover off: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const seller = new X402Seller({
    facilitator, network: x.network, payTo, treasury: solana.feeOwner, assets, prices: x.prices,
    services: [relayPriority(solana), preflight(solana), loansMarket(loans), proveDisclose(prover)],
    resourceBase: x.resourceBase, maxTimeoutSeconds: x.maxTimeoutSeconds, serviceName: x.serviceName, tags: x.tags, iconUrl: x.iconUrl, log,
  });
  log(`x402: seller on, payTo ${x.payTo} (${assets.map((a) => `${a.symbol ?? a.mint} -> ${a.payToTokenAccount}`).join(', ')}), `
    + `services ${seller.services.map((s) => `${s.id}=${x.prices.get(s.id)}`).join(' ')}, facilitator ${x.facilitatorUrl}`);
  return seller;
}

/** Symbols of the well-known 6-decimal mints (display only). */
const SYMBOLS: Record<string, string> = {
  '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH': 'USDG',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
};
