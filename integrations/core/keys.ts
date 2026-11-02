// The agent's keys. One Solana keypair is the whole identity: it pays fees, holds the USDG that goes in and
// comes out, and its deterministic ed25519 signature over a fixed label seeds the shielded account secret
// (the same construction as the site's Sign-In With Solana key, with the agent key in place of the wallet).
// Whoever holds the Solana secret key holds the shielded balance: use a dedicated, low-balance agent key.
import { existsSync, readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { FIELD, mod } from '../../src/crypto.js';
import { DERIVE_LABEL } from './constants.js';

/** A Keypair from a JSON byte array (the Solana CLI file format) or a base58 secret key. */
export function parseSecret(text: string, what = 'the key'): Keypair {
  const t = text.trim();
  let bytes: Uint8Array;
  if (t.startsWith('[')) {
    let arr: unknown;
    try { arr = JSON.parse(t); } catch { throw new Error(`${what} is not a JSON byte array`); }
    if (!Array.isArray(arr) || !arr.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) throw new Error(`${what} is not a JSON byte array`);
    bytes = Uint8Array.from(arr as number[]);
  } else {
    try { bytes = bs58.decode(t); } catch { throw new Error(`${what} is neither base58 nor a JSON byte array`); }
  }
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  if (bytes.length !== 64) throw new Error(`${what} must be 64 bytes (secret + public) or a 32-byte seed; got ${bytes.length}`);
  return Keypair.fromSecretKey(bytes);
}

export const KEY_HELP =
  'set H081_SOLANA_KEYPAIR to a Solana keypair JSON file (e.g. ~/.config/solana/agent.json) or H081_SOLANA_KEY to a base58 secret key';

/** The agent key from the environment: H081_SOLANA_KEYPAIR (a path) first, then H081_SOLANA_KEY (the secret itself). */
export function loadKeypair(env: NodeJS.ProcessEnv = process.env): Keypair {
  const path = env.H081_SOLANA_KEYPAIR?.trim();
  if (path) {
    if (!existsSync(path)) throw new Error(`H081_SOLANA_KEYPAIR: no file at ${path}`);
    return parseSecret(readFileSync(path, 'utf8'), `H081_SOLANA_KEYPAIR (${path})`);
  }
  const raw = env.H081_SOLANA_KEY?.trim();
  if (raw) return parseSecret(raw, 'H081_SOLANA_KEY');
  throw new Error(`no agent key: ${KEY_HELP}`);
}

/** Whether the environment names an agent key at all. */
export function hasKeyInEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.H081_SOLANA_KEYPAIR?.trim() || env.H081_SOLANA_KEY?.trim());
}

/**
 * The shielded account secret of a Solana keypair: a field element from sha256 of the keypair's ed25519
 * signature over `label`. ed25519 signatures are deterministic, so the same key always opens the same
 * account, and nothing about it leaves the process (the signature is never sent anywhere).
 */
export function deriveAccountSk(keypair: Keypair, label: string = DERIVE_LABEL): bigint {
  const seed = keypair.secretKey.subarray(0, 32);
  const sig = ed25519.sign(new TextEncoder().encode(label), seed);
  const h = sha256(sig);
  sig.fill(0);
  const k = mod(BigInt('0x' + Buffer.from(h).toString('hex')));
  return k === 0n ? 1n : k;
}

/** Agent sub-account `index` (what a pledge is granted to), derived from the same key under its own label. */
export function deriveAgentSk(keypair: Keypair, index: number): bigint {
  if (!Number.isInteger(index) || index < 0 || index > 15) throw new Error('agent index must be 0..15');
  return deriveAccountSk(keypair, `${DERIVE_LABEL}/agent/${index}`);
}

/** A field element from decimal or 0x-hex text. */
export function parseFieldElement(text: string, what = 'H081_ACCOUNT_SK'): bigint {
  const t = text.trim();
  let x: bigint;
  if (/^0x[0-9a-fA-F]+$/.test(t)) x = BigInt(t);
  else if (/^\d+$/.test(t)) x = BigInt(t);
  else throw new Error(`${what} must be a decimal or 0x hex integer`);
  if (x <= 0n || x >= FIELD) throw new Error(`${what} must be in 1..${FIELD - 1n}`);
  return x;
}

/** The shielded account secret for `keypair`: H081_ACCOUNT_SK when set, else derived. */
export function accountSkFromEnv(keypair: Keypair, env: NodeJS.ProcessEnv = process.env): { sk: bigint; derived: boolean } {
  const raw = env.H081_ACCOUNT_SK?.trim();
  if (raw) return { sk: parseFieldElement(raw), derived: false };
  return { sk: deriveAccountSk(keypair), derived: true };
}
