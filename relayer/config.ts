// Relayer configuration from environment variables (no file is read except the Solana keypair path the
// operator names). See relayer/README.md for the list. Keys never live in this repository.
import { PublicKey } from '@solana/web3.js';
import { getAddress } from 'ethers';

/** capacity_stake's localnet program id (src/solana/token.ts LOCALNET_CAPACITY_STAKE_PROGRAM_ID). */
const LOCALNET_CAPACITY_ID = '6yzLZPu3JcLQHZQqLKWpGnHUpNTGAkoRcW8Ji8oSgCd3';

export interface RelayerConfig {
  host: string;
  port: number;
  perMinute: number;
  burst: number;
  trustProxy: boolean;
  allowUnpaid: boolean;
  /** browser origins allowed to call the API (RELAYER_CORS_ORIGINS, comma-separated) */
  corsOrigins: string[];
  evm?: { rpc: string; pool: string; key: string; minFees: Map<string, bigint>; maxGas: bigint };
  solana?: {
    rpc: string; programId?: string; keypairPath?: string; keypairJson?: string; minFees: Map<string, bigint>; lookupTables: string[]; minLamports: number; maxInFlight: number;
    /** platform fee rate on the public amount, basis points: required fee = max(minFee, feeBps * amount / 10_000) */
    feeBps: number;
    /** owner (base58) of the fee token accounts: the platform treasury, never a launch wallet */
    treasury: string;
    /** capacity_stake enforcement; absent = off */
    capacity?: { programId?: string; mint: string; freeTier: bigint; assets: string[] };
  };
}

export class ConfigError extends Error {}

/**
 * The H081 launch wallets. The token's trading creator fees are the team's income and never feed the
 * platform-fee flywheel, so no relayer fee is ever paid to one of these (refused at startup and per relay).
 */
export const LAUNCH_WALLET_DENYLIST: ReadonlySet<string> = new Set([
  '2wjxKzH7fVGpjcA9KpjDBDHjSAhz7u8ZgMLnVPVGSkDP',
  'FZEMfMN7hhQcKPHRt2kb9ig5XArMvK5LqfSTXpQ1j4DZ',
  '5XJNtM7a9ocRL8f8vsyNVmQoekutCFJkGNXNQbkJP4bw',
]);

export const isDenyListed = (key: string | PublicKey) => LAUNCH_WALLET_DENYLIST.has(typeof key === 'string' ? key : key.toBase58());

/** Default platform fee: 0.20% of the public amount. */
export const DEFAULT_FEE_BPS = 20;
/** Default free tier: an operation moving at most 100 USDG (6 decimals) needs no staked capacity. */
export const DEFAULT_FREE_TIER = 100_000_000n;

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
    corsOrigins: (env.RELAYER_CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
  for (const o of cfg.corsOrigins) {
    let ok = false;
    try { ok = new URL(o).origin === o; } catch { /* not a URL */ }
    if (!ok) throw new ConfigError(`RELAYER_CORS_ORIGINS: ${o} is not an origin (scheme://host[:port])`);
  }
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
    // A path, or (for hosts without a file for secrets) the keypair JSON itself in RELAYER_SOLANA_KEYPAIR_JSON.
    const keypairPath = env.RELAYER_SOLANA_KEYPAIR || undefined;
    const keypairJson = env.RELAYER_SOLANA_KEYPAIR_JSON || undefined;
    if (!keypairPath === !keypairJson) throw new ConfigError('Solana relaying needs exactly one of RELAYER_SOLANA_KEYPAIR (path to a keypair JSON file) or RELAYER_SOLANA_KEYPAIR_JSON');
    const minFees = parseFees('RELAYER_SOLANA_MIN_FEES', env.RELAYER_SOLANA_MIN_FEES, (k) => new PublicKey(k).toBase58());
    if (minFees.size === 0 && !cfg.allowUnpaid) throw new ConfigError('RELAYER_SOLANA_MIN_FEES is empty: no operation would be accepted');
    const lookupTables = (env.RELAYER_SOLANA_LOOKUP_TABLES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const t of lookupTables) if (!isKey(t)) throw new ConfigError(`RELAYER_SOLANA_LOOKUP_TABLES: ${t} is not a public key`);
    if (env.RELAYER_SOLANA_PROGRAM_ID && !isKey(env.RELAYER_SOLANA_PROGRAM_ID)) throw new ConfigError('RELAYER_SOLANA_PROGRAM_ID is not a public key');
    const feeBps = int(env, 'RELAYER_FEE_BPS', DEFAULT_FEE_BPS);
    if (feeBps > 10_000) throw new ConfigError('RELAYER_FEE_BPS must be at most 10000');
    const treasuryRaw = env.RELAYER_SOLANA_TREASURY;
    if (!treasuryRaw) throw new ConfigError('Solana relaying needs RELAYER_SOLANA_TREASURY (the platform treasury that owns the fee accounts)');
    if (!isKey(treasuryRaw)) throw new ConfigError('RELAYER_SOLANA_TREASURY is not a public key');
    const treasury = new PublicKey(treasuryRaw).toBase58();
    if (isDenyListed(treasury)) throw new ConfigError(`RELAYER_SOLANA_TREASURY ${treasury} is an H081 launch wallet; platform fees never go to a launch wallet`);
    let capacity: NonNullable<RelayerConfig['solana']>['capacity'];
    if (env.RELAYER_SOLANA_CAPACITY_MINT) {
      if (!isKey(env.RELAYER_SOLANA_CAPACITY_MINT)) throw new ConfigError('RELAYER_SOLANA_CAPACITY_MINT is not a public key');
      const capProgram = env.RELAYER_SOLANA_CAPACITY_PROGRAM_ID;
      if (capProgram && !isKey(capProgram)) throw new ConfigError('RELAYER_SOLANA_CAPACITY_PROGRAM_ID is not a public key');
      // Off localnet (any explicit pool program id) the capacity program must be named and must not be the localnet
      // id: whoever holds that test key could deploy a program there that reports unlimited stakes.
      if (env.RELAYER_SOLANA_PROGRAM_ID && (!capProgram || new PublicKey(capProgram).toBase58() === LOCALNET_CAPACITY_ID)) {
        throw new ConfigError('RELAYER_SOLANA_CAPACITY_PROGRAM_ID must name the deployed capacity_stake program (not the localnet id) when RELAYER_SOLANA_PROGRAM_ID is set');
      }
      const freeTier = env.RELAYER_SOLANA_CAPACITY_FREE_TIER;
      if (freeTier && !/^\d+$/.test(freeTier)) throw new ConfigError('RELAYER_SOLANA_CAPACITY_FREE_TIER must be an amount in base units');
      const assets = (env.RELAYER_SOLANA_CAPACITY_ASSETS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      // No default: capacity counts raw base units against a 6-decimal (USDG) shieldCap, so the operator names
      // the 6-decimal stablecoin mint(s) that count; SolanaRelayer.init refuses any mint without 6 decimals.
      if (assets.length === 0) throw new ConfigError('RELAYER_SOLANA_CAPACITY_ASSETS is required with RELAYER_SOLANA_CAPACITY_MINT (the 6-decimal USDG mint(s) capacity counts)');
      for (const a of assets) if (!isKey(a)) throw new ConfigError(`RELAYER_SOLANA_CAPACITY_ASSETS: ${a} is not a public key`);
      capacity = {
        programId: capProgram || undefined, mint: new PublicKey(env.RELAYER_SOLANA_CAPACITY_MINT).toBase58(),
        freeTier: freeTier ? BigInt(freeTier) : DEFAULT_FREE_TIER,
        assets: assets.map((a) => new PublicKey(a).toBase58()),
      };
    }
    cfg.solana = {
      rpc: env.RELAYER_SOLANA_RPC, programId: env.RELAYER_SOLANA_PROGRAM_ID || undefined, keypairPath, keypairJson, minFees, lookupTables,
      minLamports: int(env, 'RELAYER_SOLANA_MIN_LAMPORTS', 50_000_000), maxInFlight: int(env, 'RELAYER_SOLANA_MAX_IN_FLIGHT', 4, 1),
      feeBps, treasury, capacity,
    };
  }
  if (!cfg.evm && !cfg.solana) throw new ConfigError('configure at least one chain: RELAYER_EVM_RPC and/or RELAYER_SOLANA_RPC');
  return cfg;
}
