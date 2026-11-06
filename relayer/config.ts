// Relayer configuration from environment variables (no file is read except the Solana keypair path the
// operator names). See relayer/README.md for the list. Keys never live in this repository.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { getAddress } from 'ethers';
import { RELAY_CIRCUITS, type RelayCircuit, vkeyPinEnv } from './verify.js';
import { DEFAULT_X402_PRICES, X402_SERVICE_IDS, type X402ServiceId } from './x402/catalog.js';
import { DEFAULT_FACILITATOR_TIMEOUT_MS, DEFAULT_FACILITATOR_URL } from './x402/facilitator.js';
import { SOLANA_MAINNET_NETWORK } from './x402/types.js';

/** Where the verifying keys live when nothing names a directory: the repository's build/circuits. */
export const DEFAULT_CIRCUITS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'circuits');
/** Lamports one create-account surcharge is deemed to cover: a Token-2022 ATA with the usual extensions (about 2.1M of rent) and its share of fees. */
export const DEFAULT_CREATE_ACCOUNT_LAMPORTS = 2_500_000;
/** Lamports the relay fee is deemed to cover per relay for staging (base fees of up to 200 transactions). */
export const DEFAULT_STAGING_LAMPORTS = 1_000_000;

/** capacity_stake's localnet program id (src/solana/token.ts LOCALNET_CAPACITY_STAKE_PROGRAM_ID). */
const LOCALNET_CAPACITY_ID = '6yzLZPu3JcLQHZQqLKWpGnHUpNTGAkoRcW8Ji8oSgCd3';

/** stream_loan on Solana mainnet (docs/MAINNET-RUNBOOK.md). */
export const MAINNET_LOAN_PROGRAM_ID = '8JBd7epQXxdcKRMaWM1S5PC7nsQKoZq3uCetpiJ684g4';
export const DEFAULT_X402_RESOURCE_BASE = 'https://api.h081.xyz';
export const DEFAULT_X402_SERVICE_NAME = 'H081 Capital';
export const DEFAULT_X402_TAGS = ['solana', 'privacy', 'bank', 'agents', 'loans'];

/** The x402 seller (paid endpoints settled through the CDP facilitator); present only with CDP credentials. */
export interface X402Config {
  facilitatorUrl: string;
  apiKeyId: string;
  apiKeySecret: string;
  facilitatorTimeoutMs: number;
  /** CAIP-2 network id (checked against the RPC's genesis hash at startup) */
  network: string;
  /** base58 owner of the payment token accounts: the platform treasury (must equal RELAYER_SOLANA_TREASURY) */
  payTo: string;
  /** mints (base58) accepted for payment; each must have 6 decimals */
  assets: string[];
  /** mint -> expected ATA(payTo, mint), asserted at startup when given */
  payToTokenAccounts: Map<string, string>;
  /** price per service in 6-decimal base units; 0 disables the service */
  prices: Map<X402ServiceId, bigint>;
  /** https origin the resource URLs are built on */
  resourceBase: string;
  maxTimeoutSeconds: number;
  serviceName: string;
  tags: string[];
  iconUrl?: string;
  priority: { maxInFlight: number; maxLamports: number; priceCeil: number };
  /** build/circuits-style directory holding disclose/ artifacts; absent = prove-disclose answers 503 service_disabled */
  circuitsDir?: string;
  discloseVkeySha256?: string;
  loanProgramId: string;
}

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
    /** per-mint surcharge (base units of the fee mint) for every account the relayer creates for an operation; a mint missing here: no creation */
    createAccountFees: Map<string, bigint>;
    /** lamports one surcharge covers (rent of the created account plus its fees) */
    createAccountLamports: number;
    /** lamports the relay fee covers for staging transactions, per relay */
    stagingLamports: number;
    /** build/circuits-style directory with <name>/<name>.vkey.json for the relay circuits (proofs are verified before staging) */
    circuitsDir: string;
    /** pinned sha256 per relay circuit's verifying key (RELAYER_VKEY_SHA256_<NAME>) */
    vkeySha256: Partial<Record<RelayCircuit, string>>;
  };
  x402?: X402Config;
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
    // Accounts the relayer creates (a withdrawal's or payout's ATA, a vault) cost it rent the owner of the account
    // can take back by closing it; a mint without a surcharge here means the relayer creates nothing for it.
    const createAccountFees = parseFees('RELAYER_SOLANA_CREATE_ACCOUNT_FEE', env.RELAYER_SOLANA_CREATE_ACCOUNT_FEE, (k) => new PublicKey(k).toBase58());
    for (const m of createAccountFees.keys()) {
      if (!minFees.has(m)) throw new ConfigError(`RELAYER_SOLANA_CREATE_ACCOUNT_FEE: ${m} is not a fee mint (RELAYER_SOLANA_MIN_FEES)`);
    }
    const vkeySha256: Partial<Record<RelayCircuit, string>> = {};
    for (const name of RELAY_CIRCUITS) {
      const pin = env[vkeyPinEnv(name)]?.toLowerCase() || undefined;
      if (pin && !/^[0-9a-f]{64}$/.test(pin)) throw new ConfigError(`${vkeyPinEnv(name)} must be a hex sha256`);
      if (pin) vkeySha256[name] = pin;
    }
    cfg.solana = {
      rpc: env.RELAYER_SOLANA_RPC, programId: env.RELAYER_SOLANA_PROGRAM_ID || undefined, keypairPath, keypairJson, minFees, lookupTables,
      minLamports: int(env, 'RELAYER_SOLANA_MIN_LAMPORTS', 50_000_000), maxInFlight: int(env, 'RELAYER_SOLANA_MAX_IN_FLIGHT', 4, 1),
      feeBps, treasury, capacity, createAccountFees,
      createAccountLamports: int(env, 'RELAYER_SOLANA_CREATE_ACCOUNT_LAMPORTS', DEFAULT_CREATE_ACCOUNT_LAMPORTS, 1),
      stagingLamports: int(env, 'RELAYER_SOLANA_STAGING_LAMPORTS', DEFAULT_STAGING_LAMPORTS, 0),
      circuitsDir: env.RELAYER_SOLANA_CIRCUITS_DIR || env.RELAYER_X402_CIRCUITS_DIR || DEFAULT_CIRCUITS_DIR,
      vkeySha256,
    };
  }
  if (!cfg.evm && !cfg.solana) throw new ConfigError('configure at least one chain: RELAYER_EVM_RPC and/or RELAYER_SOLANA_RPC');
  cfg.x402 = loadX402Config(env, cfg);
  return cfg;
}

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * The x402 seller: enabled only when both CDP credentials are set (one alone is a configuration error).
 * payTo is the platform treasury (RELAYER_SOLANA_TREASURY) and nothing else: paid services are protocol
 * revenue; the H081 token's trading creator fees are the team's and never pass through here.
 */
export function loadX402Config(env: Record<string, string | undefined>, cfg: Pick<RelayerConfig, 'solana'>): X402Config | undefined {
  const apiKeyId = env.CDP_API_KEY_ID || undefined;
  const apiKeySecret = env.CDP_API_KEY_SECRET || undefined;
  if (!apiKeyId && !apiKeySecret) return undefined;
  if (!apiKeyId || !apiKeySecret) throw new ConfigError('x402: set both CDP_API_KEY_ID and CDP_API_KEY_SECRET (or neither to disable the paid endpoints)');
  if (!cfg.solana) throw new ConfigError('x402: the paid endpoints need Solana relaying (RELAYER_SOLANA_RPC)');
  const network = env.RELAYER_X402_NETWORK || SOLANA_MAINNET_NETWORK;
  if (!/^solana:[1-9A-HJ-NP-Za-km-z]{32}$/.test(network)) throw new ConfigError('RELAYER_X402_NETWORK must be a Solana CAIP-2 id (solana:<32 chars of the genesis hash>)');
  const payToRaw = env.RELAYER_X402_PAY_TO || cfg.solana.treasury;
  if (!isKey(payToRaw)) throw new ConfigError('RELAYER_X402_PAY_TO is not a public key');
  const payTo = new PublicKey(payToRaw).toBase58();
  if (payTo !== cfg.solana.treasury) throw new ConfigError(`x402 payTo must be the platform treasury ${cfg.solana.treasury} (RELAYER_SOLANA_TREASURY)`);
  if (isDenyListed(payTo)) throw new ConfigError(`x402 payTo ${payTo} is an H081 launch wallet; paid services never pay a launch wallet`);
  const assets = env.RELAYER_X402_ASSETS ? list(env.RELAYER_X402_ASSETS) : [...cfg.solana.minFees.keys()];
  if (assets.length === 0) throw new ConfigError('RELAYER_X402_ASSETS is empty (and no Solana fee mint to default to)');
  for (const a of assets) if (!isKey(a)) throw new ConfigError(`RELAYER_X402_ASSETS: ${a} is not a public key`);
  const payToTokenAccounts = new Map<string, string>();
  for (const part of list(env.RELAYER_X402_PAY_TO_TOKEN_ACCOUNTS)) {
    const [mint, ata] = part.split('=').map((s) => s.trim());
    if (!mint || !ata || !isKey(mint) || !isKey(ata)) throw new ConfigError(`RELAYER_X402_PAY_TO_TOKEN_ACCOUNTS: "${part}" is not mint=tokenAccount`);
    payToTokenAccounts.set(new PublicKey(mint).toBase58(), new PublicKey(ata).toBase58());
  }
  const prices = new Map<X402ServiceId, bigint>(X402_SERVICE_IDS.map((id) => [id, DEFAULT_X402_PRICES[id]]));
  for (const part of list(env.RELAYER_X402_PRICES)) {
    const [id, amount] = part.split('=').map((s) => s.trim());
    if (!id || amount === undefined || !/^\d+$/.test(amount)) throw new ConfigError(`RELAYER_X402_PRICES: "${part}" is not service=amount`);
    if (!(X402_SERVICE_IDS as readonly string[]).includes(id)) throw new ConfigError(`RELAYER_X402_PRICES: unknown service "${id}" (${X402_SERVICE_IDS.join(', ')})`);
    prices.set(id as X402ServiceId, BigInt(amount));
  }
  const resourceBase = (env.RELAYER_X402_RESOURCE_BASE || DEFAULT_X402_RESOURCE_BASE).replace(/\/+$/, '');
  let okBase = false;
  try { const u = new URL(resourceBase); okBase = u.protocol === 'https:' && u.origin === resourceBase; } catch { /* not a URL */ }
  if (!okBase) throw new ConfigError('RELAYER_X402_RESOURCE_BASE must be an https origin (https://host[:port])');
  const serviceName = env.RELAYER_X402_SERVICE_NAME || DEFAULT_X402_SERVICE_NAME;
  if (serviceName.length > 32 || !/^[\x20-\x7e]+$/.test(serviceName)) throw new ConfigError('RELAYER_X402_SERVICE_NAME must be at most 32 printable ASCII characters');
  const tags = env.RELAYER_X402_TAGS === undefined ? DEFAULT_X402_TAGS : list(env.RELAYER_X402_TAGS);
  if (tags.length > 5 || tags.some((t) => t.length > 32)) throw new ConfigError('RELAYER_X402_TAGS: at most 5 tags of at most 32 characters');
  const iconUrl = env.RELAYER_X402_ICON_URL || undefined;
  if (iconUrl && !/^https:\/\/\S+\.(png|jpe?g|webp|gif)$/i.test(iconUrl)) throw new ConfigError('RELAYER_X402_ICON_URL must be an https png/jpg/webp/gif URL');
  const loanProgramId = env.RELAYER_X402_LOAN_PROGRAM_ID || MAINNET_LOAN_PROGRAM_ID;
  if (!isKey(loanProgramId)) throw new ConfigError('RELAYER_X402_LOAN_PROGRAM_ID is not a public key');
  const discloseVkeySha256 = env.RELAYER_X402_DISCLOSE_VKEY_SHA256?.toLowerCase() || undefined;
  if (discloseVkeySha256 && !/^[0-9a-f]{64}$/.test(discloseVkeySha256)) throw new ConfigError('RELAYER_X402_DISCLOSE_VKEY_SHA256 must be a hex sha256');
  return {
    facilitatorUrl: (env.RELAYER_X402_FACILITATOR_URL || DEFAULT_FACILITATOR_URL).replace(/\/+$/, ''),
    apiKeyId, apiKeySecret, facilitatorTimeoutMs: int(env, 'RELAYER_X402_FACILITATOR_TIMEOUT_MS', DEFAULT_FACILITATOR_TIMEOUT_MS, 1_000),
    network, payTo, assets: assets.map((a) => new PublicKey(a).toBase58()), payToTokenAccounts, prices, resourceBase,
    maxTimeoutSeconds: int(env, 'RELAYER_X402_MAX_TIMEOUT_SECONDS', 120, 10), serviceName, tags, iconUrl,
    priority: {
      maxInFlight: int(env, 'RELAYER_X402_PRIORITY_MAX_IN_FLIGHT', 4, 1),
      maxLamports: int(env, 'RELAYER_X402_PRIORITY_MAX_LAMPORTS', 4_000_000, 1),
      priceCeil: int(env, 'RELAYER_X402_PRIORITY_PRICE_CEIL', 5_000_000, 1),
    },
    circuitsDir: env.RELAYER_X402_CIRCUITS_DIR || undefined, discloseVkeySha256, loanProgramId: new PublicKey(loanProgramId).toBase58(),
  };
}
