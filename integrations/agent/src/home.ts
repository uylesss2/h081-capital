// The files in ~/.h081 (H081_HOME): the agent key, config.json, the gateway's token, ops.jsonl, cache/ and circuits/.
// Private files are created with mode 0600 (the directory 0700 on POSIX); on Windows inheritance is removed and only
// the current user gets access (icacls). A failure to tighten permissions is a warning, never a stop.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import bs58 from 'bs58';
import { CLUSTERS, expandHome, h081Home } from '../../core/constants.js';

export interface HomePaths {
  home: string;
  /** agent.json: the Solana keypair (64-byte JSON array) */
  key: string;
  config: string;
  token: string;
  ops: string;
  cache: string;
  circuits: string;
}

export function homePaths(env: NodeJS.ProcessEnv = process.env): HomePaths {
  const home = h081Home(env);
  const tokenFile = env.H081_API_TOKEN_FILE?.trim();
  return {
    home,
    key: join(home, 'agent.json'),
    config: join(home, 'config.json'),
    token: tokenFile ? expandHome(tokenFile) : join(home, 'api-token'),
    ops: join(home, 'ops.jsonl'),
    cache: join(home, 'cache'),
    circuits: join(home, 'circuits'),
  };
}

export type Warn = (line: string) => void;

const isWindows = process.platform === 'win32';

/** Only the current user may read or write `path`: chmod 0600 (0700 for a directory) on POSIX, icacls on Windows. */
export function restrict(path: string, warn: Warn, dir = false): boolean {
  try {
    if (!isWindows) { chmodSync(path, dir ? 0o700 : 0o600); return true; }
    const user = process.env.USERNAME || userInfo().username;
    const r = spawnSync('icacls', [path, '/inheritance:r', '/grant:r', `${user}:${dir ? '(OI)(CI)F' : 'F'}`], { stdio: 'ignore', windowsHide: true });
    if (r.status === 0) return true;
    warn(`warning: could not limit access to ${path} to the current user (icacls exit ${r.status ?? r.error?.message}); check its permissions`);
    return false;
  } catch (e) {
    warn(`warning: could not limit access to ${path}: ${(e as Error).message}`);
    return false;
  }
}

/** Creates the home directory (0700 on POSIX). */
export function ensureHome(home: string, warn: Warn): void {
  const fresh = !existsSync(home);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (fresh || !isWindows) restrict(home, warn, true);
}

/**
 * Writes a private file (mode 0600). `exclusive`: fail with EEXIST rather than replace an existing file (the key).
 * A replacement goes through a temporary file and a rename, so a crash never leaves half a file.
 */
export function writePrivate(path: string, data: string, warn: Warn, opts: { exclusive?: boolean } = {}): void {
  mkdirSync(dirname(path), { recursive: true });
  if (opts.exclusive) {
    writeFileSync(path, data, { mode: 0o600, flag: 'wx' });
  } else {
    const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
    restrict(tmp, warn);
    renameSync(tmp, path);
  }
  restrict(path, warn);
}

/** Appends a line to a private file, creating it 0600 first. */
export function appendPrivate(path: string, line: string, warn: Warn): void {
  if (!existsSync(path)) writePrivate(path, '', warn);
  appendFileSync(path, line.endsWith('\n') ? line : line + '\n');
}

// ---- config.json

export interface FileConfig { cluster?: string; rpcUrl?: string; port?: number }

export function readFileConfig(path: string): FileConfig {
  if (!existsSync(path)) return {};
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`${path} is not valid JSON; fix or delete it (h081 init writes a new one)`); }
  const o = (raw ?? {}) as Record<string, unknown>;
  const out: FileConfig = {};
  if (typeof o.cluster === 'string' && o.cluster) out.cluster = o.cluster;
  if (typeof o.rpcUrl === 'string' && o.rpcUrl) out.rpcUrl = o.rpcUrl;
  if (typeof o.port === 'number' && Number.isInteger(o.port)) out.port = o.port;
  return out;
}

export function writeFileConfig(path: string, cfg: FileConfig, warn: Warn): void {
  if (cfg.cluster && !(CLUSTERS as readonly string[]).includes(cfg.cluster)) throw new Error('cluster must be mainnet-beta or localnet');
  writePrivate(path, JSON.stringify({ cluster: cfg.cluster ?? 'mainnet-beta', rpcUrl: cfg.rpcUrl, port: cfg.port ?? 8081 }, null, 2) + '\n', warn);
}

/**
 * The environment the bank and the gateway run with: the process environment first, then config.json, then the
 * mainnet defaults (configFromEnv). `home` and `cluster` (command-line flags) override both.
 */
export function effectiveEnv(env: NodeJS.ProcessEnv = process.env, flags: { home?: string; cluster?: string } = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (flags.home) out.H081_HOME = flags.home;
  out.H081_HOME = h081Home(out);
  const file = readFileConfig(join(out.H081_HOME, 'config.json'));
  if (flags.cluster) out.H081_CLUSTER = flags.cluster;
  if (!out.H081_CLUSTER?.trim() && file.cluster) out.H081_CLUSTER = file.cluster;
  if (!out.H081_RPC_URL?.trim() && file.rpcUrl) out.H081_RPC_URL = file.rpcUrl;
  if (!out.H081_API_PORT?.trim() && file.port) out.H081_API_PORT = String(file.port);
  return out;
}

// ---- api-token

/** 32 random bytes in base58. */
export function newToken(): string {
  return bs58.encode(randomBytes(32));
}

export function readToken(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const t = readFileSync(path, 'utf8').trim();
  return t || undefined;
}

/** The token at `path`, created (0600) when missing. */
export function ensureToken(path: string, warn: Warn): { token: string; created: boolean } {
  const have = readToken(path);
  if (have) return { token: have, created: false };
  const token = newToken();
  writePrivate(path, token + '\n', warn);
  return { token, created: true };
}

export function rotateToken(path: string, warn: Warn): string {
  const token = newToken();
  writePrivate(path, token + '\n', warn);
  return token;
}
