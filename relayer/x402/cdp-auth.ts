// Coinbase Developer Platform API authentication without the CDP SDK: a JWT per request, signed with the
// Secret API Key (Ed25519 keys are base64 of 64 bytes, seed | public key, alg EdDSA; the older EC keys are a
// PEM, alg ES256 with an IEEE P1363 signature). Claims follow the cdp-sdk x402 client: sub = key id,
// iss = "cdp", nbf/exp (120 s), uris = ["METHOD host/path"], no audience; header carries kid and a fresh nonce.
import { type KeyObject, createPrivateKey, createPublicKey, randomBytes, sign as cryptoSign } from 'node:crypto';
import { ConfigError } from '../config.js';

export interface CdpKey { alg: 'EdDSA' | 'ES256'; key: KeyObject }

/** PKCS#8 DER prefix of an Ed25519 private key (RFC 8410): the 32-byte seed follows. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/**
 * Parses CDP_API_KEY_SECRET: a base64 Ed25519 key of 64 bytes (seed | public key, as the CDP portal issues
 * them), a base64 32-byte seed, or an EC/PKCS#8 PEM (the `\n` escapes a single-line environment carries are
 * accepted). Throws ConfigError otherwise.
 */
export function parseCdpSecret(secret: string): CdpKey {
  const s = secret.trim().replace(/\\n/g, '\n');
  if (s.includes('-----BEGIN')) {
    let key: KeyObject;
    try { key = createPrivateKey(s); } catch { throw new ConfigError('CDP_API_KEY_SECRET must be a base64 Ed25519 key (64 bytes) or an EC PEM'); }
    if (key.asymmetricKeyType === 'ed25519') return { alg: 'EdDSA', key };
    if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1') return { alg: 'ES256', key };
    throw new ConfigError('CDP_API_KEY_SECRET PEM must be an Ed25519 or a P-256 EC private key');
  }
  if (!/^[A-Za-z0-9+/=_-]+$/.test(s)) throw new ConfigError('CDP_API_KEY_SECRET must be a base64 Ed25519 key (64 bytes) or an EC PEM');
  const raw = Buffer.from(s, 'base64');
  if (raw.length !== 64 && raw.length !== 32) throw new ConfigError('CDP_API_KEY_SECRET must be a base64 Ed25519 key (64 bytes) or an EC PEM');
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, raw.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
  } catch {
    throw new ConfigError('CDP_API_KEY_SECRET is not a valid Ed25519 key');
  }
  if (raw.length === 64) {
    const pub = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
    if (!pub.equals(raw.subarray(32))) throw new ConfigError('CDP_API_KEY_SECRET: the public half does not match the seed');
  }
  return { alg: 'EdDSA', key };
}

export interface CdpJwtInput {
  keyId: string;
  /** the raw secret (parsed each call) or an already parsed key */
  secret: string | CdpKey;
  method: string;
  host: string;
  path: string;
  /** unix seconds; default: now */
  now?: number;
  /** seconds the token is valid; default 120 */
  expiresIn?: number;
}

/** A CDP JWT bound to one request (`METHOD host/path`), valid for 120 s. */
export function cdpJwt(i: CdpJwtInput): string {
  const { alg, key } = typeof i.secret === 'string' ? parseCdpSecret(i.secret) : i.secret;
  const now = i.now ?? Math.floor(Date.now() / 1000);
  const header = { alg, kid: i.keyId, typ: 'JWT', nonce: randomBytes(16).toString('hex') };
  const claims = { sub: i.keyId, iss: 'cdp', nbf: now, exp: now + (i.expiresIn ?? 120), uris: [`${i.method.toUpperCase()} ${i.host}${i.path}`] };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = alg === 'EdDSA'
    ? cryptoSign(null, Buffer.from(signingInput), key)
    : cryptoSign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(sig)}`;
}
