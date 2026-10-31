// Builds the relayer backends from a loaded config. Shared by the long-running server (main.ts) and the
// serverless entry (vercel.ts).
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { JsonRpcProvider, Wallet as EthersWallet } from 'ethers';
import { fetchLookupTable } from '../src/solana/alt.js';
import type { RelayerConfig } from './config.js';
import { EvmRelayer } from './evm.js';
import { RateLimiter } from './ratelimit.js';
import type { RelayerServerOptions } from './server.js';
import { SolanaRelayer, solanaRelayerOptions } from './solana.js';

export async function buildRelayer(cfg: RelayerConfig, log: (line: string) => void = console.log): Promise<RelayerServerOptions> {
  let evm: EvmRelayer | undefined;
  let solana: SolanaRelayer | undefined;
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
    solana = await new SolanaRelayer(solanaRelayerOptions(s, { connection, payer, lookupTables, allowUnpaid: cfg.allowUnpaid })).init();
    const created = await solana.ensureFeeAccounts();
    const note = created.length ? `, created fee accounts ${created.join(', ')}` : '';
    const cap = solana.capacity ? `capacity on (free tier ${solana.capacity.opts.freeTier})` : 'capacity off';
    log(`solana: relayer ${payer.publicKey.toBase58()} for program ${solana.programId.toBase58()}, `
      + `fee ${solana.feeBps} bps to treasury ${solana.feeOwner.toBase58()}, ${cap}${note}`);
  }
  return {
    evm, solana, limiter: new RateLimiter({ perMinute: cfg.perMinute, burst: cfg.burst }), trustProxy: cfg.trustProxy,
    corsOrigins: cfg.corsOrigins, log: (line) => log(`${new Date().toISOString()} ${line}`),
  };
}
