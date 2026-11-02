// CDP API authentication for the x402 facilitator: the JWT shape and signature for Ed25519 (EdDSA) and
// P-256 (ES256) Secret API Keys, built with node:crypto only.
import { describe, expect, it } from 'vitest';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { ConfigError } from '../../relayer/config.js';
import { cdpJwt, parseCdpSecret } from '../../relayer/x402/cdp-auth.js';

const b64urlJson = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

/** A CDP-style Ed25519 secret: base64 of seed (32) | public key (32). */
function ed25519Secret() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { secret: Buffer.concat([seed, pub]).toString('base64'), publicKey, seed, pub };
}

const request = { keyId: 'organizations/abc/apiKeys/k1', method: 'POST', host: 'api.cdp.coinbase.com', path: '/platform/v2/x402/verify' } as const;

describe('cdp jwt', () => {
  it('signs an EdDSA token with the kid, a fresh nonce and request-bound claims', () => {
    const { secret, publicKey } = ed25519Secret();
    const now = 1_800_000_000;
    const jwt = cdpJwt({ ...request, secret, now });
    const [h, c, s] = jwt.split('.');
    const header = b64urlJson(h);
    expect(header).toMatchObject({ alg: 'EdDSA', kid: request.keyId, typ: 'JWT' });
    expect(header.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(b64urlJson(c)).toEqual({ sub: request.keyId, iss: 'cdp', nbf: now, exp: now + 120, uris: ['POST api.cdp.coinbase.com/platform/v2/x402/verify'] });
    expect(verify(null, Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url'))).toBe(true);
    // a second token differs (nonce), and a 32-byte seed alone is accepted too
    expect(cdpJwt({ ...request, secret, now })).not.toBe(jwt);
    expect(parseCdpSecret(ed25519Secret().seed.toString('base64')).alg).toBe('EdDSA');
  });

  it('signs an ES256 token (IEEE P1363 signature) for an EC PEM key', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = privateKey.export({ format: 'pem', type: 'sec1' }).toString();
    expect(pem).toContain('BEGIN EC PRIVATE KEY');
    const jwt = cdpJwt({ ...request, secret: pem.replace(/\n/g, '\\n'), method: 'GET', path: '/platform/v2/x402/supported' });
    const [h, c, s] = jwt.split('.');
    expect(b64urlJson(h).alg).toBe('ES256');
    expect(b64urlJson(c).uris).toEqual(['GET api.cdp.coinbase.com/platform/v2/x402/supported']);
    const sig = Buffer.from(s, 'base64url');
    expect(sig).toHaveLength(64);
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' }, sig)).toBe(true);
  });

  it('refuses secrets that are not an Ed25519 key or an EC PEM', () => {
    expect(() => parseCdpSecret('garbage!!')).toThrow(ConfigError);
    expect(() => parseCdpSecret(Buffer.alloc(40).toString('base64'))).toThrow(ConfigError);
    // a 64-byte value whose public half does not match the seed
    const { seed } = ed25519Secret();
    expect(() => parseCdpSecret(Buffer.concat([seed, Buffer.alloc(32, 7)]).toString('base64'))).toThrow(/public half/);
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    expect(() => parseCdpSecret(privateKey.export({ format: 'pem', type: 'sec1' }).toString())).toThrow(/P-256/);
  });
});
