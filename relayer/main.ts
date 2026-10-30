// Relayer service entry: `npm run relayer` (tsx relayer/main.ts). Configuration: environment variables,
// see relayer/README.md. Nothing here reads a .env file; the operator sets the environment.
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { JsonRpcProvider, Wallet as EthersWallet } from 'ethers';
import { fetchLookupTable } from '../src/solana/alt.js';
import { ConfigError, loadConfig } from './config.js';
import { EvmRelayer } from './evm.js';
import { RateLimiter } from './ratelimit.js';
import { createRelayerServer } from './server.js';
import { SolanaRelayer } from './solana.js';

async function main() {
  const cfg = loadConfig();
  let evm: EvmRelayer | undefined;
  let solana: SolanaRelayer | undefined;
  if (cfg.evm) {
    const signer = new EthersWallet(cfg.evm.key, new JsonRpcProvider(cfg.evm.rpc));
    evm = await new EvmRelayer({ signer, pool: cfg.evm.pool, minFees: cfg.evm.minFees, allowUnpaid: cfg.allowUnpaid, maxGas: cfg.evm.maxGas }).init();
    console.log(`evm: relayer ${await signer.getAddress()} for pool ${cfg.evm.pool}`);
  }
  if (cfg.solana) {
    const s = cfg.solana;
    const connection = new Connection(s.rpc, 'confirmed');
    const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(s.keypairPath, 'utf8')) as number[]));
    const lookupTables = await Promise.all(s.lookupTables.map((t) => fetchLookupTable(connection, new PublicKey(t))));
    solana = await new SolanaRelayer({
      connection, payer, programId: s.programId ? new PublicKey(s.programId) : undefined, minFees: s.minFees, lookupTables,
      allowUnpaid: cfg.allowUnpaid, minLamports: s.minLamports, maxInFlight: s.maxInFlight,
    }).init();
    const created = await solana.ensureFeeAccounts();
    const note = created.length ? `, created fee accounts ${created.join(', ')}` : '';
    console.log(`solana: relayer ${payer.publicKey.toBase58()} for program ${solana.programId.toBase58()}${note}`);
  }
  const server = createRelayerServer({
    evm, solana, limiter: new RateLimiter({ perMinute: cfg.perMinute, burst: cfg.burst }), trustProxy: cfg.trustProxy,
    log: (line) => console.log(new Date().toISOString(), line),
  });
  server.listen(cfg.port, cfg.host, () => console.log(`relayer listening on http://${cfg.host}:${cfg.port}`));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error(e instanceof ConfigError ? `config: ${e.message}` : e);
  process.exit(1);
});
