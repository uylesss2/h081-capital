// Relayer configuration from environment variables (no file is read except the Solana keypair path the
// operator names). See relayer/README.md for the list. Keys never live in this repository.
import { PublicKey } from '@solana/web3.js';
import { getAddress } from 'ethers';

export interface RelayerConfig {
  host: string;
  port: number;
  perMinute: number;
  burst: number;
  trustProxy: boolean;
  allowUnpaid: boolean;
  evm?: { rpc: string; pool: string; key: string; minFees: Map<string, bigint>; maxGas: bigint };
  solana?: {
    rpc: string; programId?: string; keypairPath: string; minFees: Map<string, bigint>; lookupTables: string[]; minLamports: number; maxInFlight: number;
  };
}

export class ConfigError extends Error {}

const flag = (v: string | undefined) => v === '1' || v === 'true';

function int(env: Record<string, string | undefined>, name: string, dflt: number, min = 0): number {
  const v = env[name];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new ConfigError(`${name} must be an integer >= ${min}`);
  return n;
}

/** "asset=amount,asset=amount" -> Map; amounts are base units (integers). */
export function parseFees(name: string, v: string | undefined, normalize: (k: string) => string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  if (!v) return out;
  for (const part of v.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [k, amount] = part.split('=').map((s) => s.trim());
    if (!k || !amount || !/^\d+$/.test(amount)) throw new ConfigError(`${name}: "${part}" is not asset=amount`);
    let key: string;
    try { key = normalize(k); } catch { throw new ConfigError(`${name}: "${k}" is not a valid asset`); }
    out.set(key, BigInt(amount));
  }
  return out;
}

const isKey = (s: string) => { try { new PublicKey(s); return true; } catch { return false; } };

export function loadConfig(env: Record<string, string | undefined> = process.env): RelayerConfig {
  const cfg: RelayerConfig = {
    host: env.RELAYER_HOST || '127.0.0.1',
    port: int(env, 'RELAYER_PORT', 8787),
    perMinute: int(env, 'RELAYER_RATE_PER_MIN', 30, 1),
    burst: int(env, 'RELAYER_BURST', 10, 1),
    trustProxy: flag(env.RELAYER_TRUST_PROXY),
    allowUnpaid: flag(env.RELAYER_ALLOW_UNPAID),
  };
  if (env.RELAYER_EVM_RPC) {
    const { RELAYER_EVM_POOL: pool, RELAYER_EVM_KEY: key } = env;
    if (!pool || !key) throw new ConfigError('EVM relaying needs RELAYER_EVM_POOL and RELAYER_EVM_KEY');
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new ConfigError('RELAYER_EVM_KEY must be a 0x-prefixed 32-byte hex key');
    let poolAddr: string;
    try { poolAddr = getAddress(pool); } catch { throw new ConfigError('RELAYER_EVM_POOL is not an address'); }
    const minFees = parseFees('RELAYER_EVM_MIN_FEES', env.RELAYER_EVM_MIN_FEES, (k) => getAddress(k).toLowerCase());
    if (minFees.size === 0 && !cfg.allowUnpaid) throw new ConfigError('RELAYER_EVM_MIN_FEES is empty: no operation would be accepted');
    cfg.evm = { rpc: env.RELAYER_EVM_RPC, pool: poolAddr, key, minFees, maxGas: BigInt(int(env, 'RELAYER_EVM_MAX_GAS', 8_000_000, 21_000)) };
  }
  if (env.RELAYER_SOLANA_RPC) {
    const keypairPath = env.RELAYER_SOLANA_KEYPAIR;
    if (!keypairPath) throw new ConfigError('Solana relaying needs RELAYER_SOLANA_KEYPAIR (path to a keypair JSON file)');
    const minFees = parseFees('RELAYER_SOLANA_MIN_FEES', env.RELAYER_SOLANA_MIN_FEES, (k) => new PublicKey(k).toBase58());
    if (minFees.size === 0 && !cfg.allowUnpaid) throw new ConfigError('RELAYER_SOLANA_MIN_FEES is empty: no operation would be accepted');
    const lookupTables = (env.RELAYER_SOLANA_LOOKUP_TABLES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const t of lookupTables) if (!isKey(t)) throw new ConfigError(`RELAYER_SOLANA_LOOKUP_TABLES: ${t} is not a public key`);
    if (env.RELAYER_SOLANA_PROGRAM_ID && !isKey(env.RELAYER_SOLANA_PROGRAM_ID)) throw new ConfigError('RELAYER_SOLANA_PROGRAM_ID is not a public key');
    cfg.solana = {
      rpc: env.RELAYER_SOLANA_RPC, programId: env.RELAYER_SOLANA_PROGRAM_ID || undefined, keypairPath, minFees, lookupTables,
      minLamports: int(env, 'RELAYER_SOLANA_MIN_LAMPORTS', 50_000_000), maxInFlight: int(env, 'RELAYER_SOLANA_MAX_IN_FLIGHT', 4, 1),
    };
  }
  if (!cfg.evm && !cfg.solana) throw new ConfigError('configure at least one chain: RELAYER_EVM_RPC and/or RELAYER_SOLANA_RPC');
  return cfg;
}
