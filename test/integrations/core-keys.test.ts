import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { FIELD, mod } from '../../src/crypto.js';
import { DERIVE_LABEL } from '../../integrations/core/constants.js';
import {
  accountDerivationFromEnv, accountSkFromEnv, defaultKeyPath, describeKeySource, expandHome, h081Home, keySource, deriveAccountSk, deriveAccountSkFromSignature, deriveAgentSk, hasKeyInEnv, loadKeypair, parseFieldElement, parseSecret,
} from '../../integrations/core/keys.js';

const field = (h: Uint8Array) => { const k = mod(BigInt('0x' + Buffer.from(h).toString('hex'))); return k === 0n ? 1n : k; };

describe('keys', () => {
  it('derives the same shielded secret from the same Solana key, a different one from another key', () => {
    const a = Keypair.generate(), b = Keypair.generate();
    const sa = deriveAccountSk(a);
    expect(sa).toBe(deriveAccountSk(Keypair.fromSecretKey(a.secretKey)));
    expect(sa).not.toBe(deriveAccountSk(b));
    expect(sa > 0n && sa < FIELD).toBe(true);
    expect(deriveAgentSk(a, 0)).not.toBe(sa);
    expect(deriveAgentSk(a, 0)).not.toBe(deriveAgentSk(a, 1));
    expect(deriveAgentSk(a, 3)).toBe(deriveAgentSk(a, 3));
    expect(() => deriveAgentSk(a, 16)).toThrow(/0\.\.15/);
  });

  it('the default secret is bound to the seed: a signature of the label by the key does not reproduce it; H081_DERIVE_ACCOUNT=1 is the signature construction', () => {
    const kp = Keypair.generate();
    const seed = kp.secretKey.subarray(0, 32);
    const label = new TextEncoder().encode(DERIVE_LABEL);
    // what a message-signing tool could be talked into producing
    const sig = ed25519.sign(label, seed);
    const fromSig = field(sha256(sig));
    expect(deriveAccountSk(kp)).toBe(field(hmac(sha256, seed, label)));
    expect(deriveAccountSk(kp)).not.toBe(fromSig);
    expect(deriveAccountSkFromSignature(kp)).toBe(fromSig);
    expect(deriveAgentSk(kp, 0, 'signature')).toBe(field(sha256(ed25519.sign(new TextEncoder().encode(`${DERIVE_LABEL}/agent/0`), seed))));
    expect(deriveAgentSk(kp, 0, 'signature')).not.toBe(deriveAgentSk(kp, 0));
    expect(deriveAgentSk(kp, 0, 'seed')).toBe(deriveAgentSk(kp, 0));
    expect(accountDerivationFromEnv({})).toBe('seed');
    expect(accountDerivationFromEnv({ H081_DERIVE_ACCOUNT: '0' })).toBe('seed');
    expect(accountDerivationFromEnv({ H081_DERIVE_ACCOUNT: '1' })).toBe('signature');
    expect(accountDerivationFromEnv({ H081_DERIVE_ACCOUNT: 'signature' })).toBe('signature');
    expect(() => accountDerivationFromEnv({ H081_DERIVE_ACCOUNT: 'maybe' })).toThrow(/H081_DERIVE_ACCOUNT/);
    expect(accountSkFromEnv(kp, { H081_DERIVE_ACCOUNT: '1' })).toEqual({ sk: fromSig, derived: true, source: 'signature', derivation: 'signature' });
    expect(accountSkFromEnv(kp, { H081_DERIVE_ACCOUNT: '1', H081_ACCOUNT_SK: '7' })).toEqual({ sk: 7n, derived: false, source: 'env', derivation: 'signature' });
  });

  it('loads a keypair from a JSON file (H081_SOLANA_KEYPAIR) or a base58 / JSON secret (H081_SOLANA_KEY)', () => {
    const kp = Keypair.generate();
    const dir = mkdtempSync(join(tmpdir(), 'h081-keys-'));
    const file = join(dir, 'agent.json');
    writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
    expect(loadKeypair({ H081_SOLANA_KEYPAIR: file }).publicKey.equals(kp.publicKey)).toBe(true);
    expect(loadKeypair({ H081_SOLANA_KEY: bs58.encode(kp.secretKey) }).publicKey.equals(kp.publicKey)).toBe(true);
    expect(loadKeypair({ H081_SOLANA_KEY: JSON.stringify(Array.from(kp.secretKey)) }).publicKey.equals(kp.publicKey)).toBe(true);
    // the file wins when both are set
    expect(loadKeypair({ H081_SOLANA_KEYPAIR: file, H081_SOLANA_KEY: bs58.encode(Keypair.generate().secretKey) }).publicKey.equals(kp.publicKey)).toBe(true);
    const empty = { H081_HOME: join(dir, 'empty-home') };
    expect(() => loadKeypair(empty)).toThrow(/H081_SOLANA_KEYPAIR/);
    expect(() => loadKeypair({ H081_SOLANA_KEYPAIR: join(dir, 'missing.json') })).toThrow(/no file/);
    expect(() => parseSecret('not base58!!')).toThrow(/neither base58/);
    expect(() => parseSecret('[1,2,3]')).toThrow(/64 bytes/);
    expect(parseSecret(bs58.encode(kp.secretKey.subarray(0, 32))).publicKey.equals(kp.publicKey)).toBe(true); // a 32-byte seed
    expect(hasKeyInEnv(empty)).toBe(false);
    expect(hasKeyInEnv({ ...empty, H081_SOLANA_KEY: ' ' })).toBe(false);
    expect(hasKeyInEnv({ H081_SOLANA_KEY: 'x' })).toBe(true);
  });

  it('expands a leading ~, defaults to <H081_HOME>/agent.json and reports only where the key came from', () => {
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('~/x/agent.json')).toBe(join(homedir(), 'x', 'agent.json'));
    expect(expandHome('/abs/agent.json')).toBe('/abs/agent.json');
    expect(h081Home({})).toBe(join(homedir(), '.h081'));
    expect(defaultKeyPath({})).toBe(join(homedir(), '.h081', 'agent.json'));
    const home = mkdtempSync(join(tmpdir(), 'h081-home-'));
    const env = { H081_HOME: home };
    expect(keySource(env)).toBeUndefined();
    expect(describeKeySource(keySource(env))).toBe('none');
    const kp = Keypair.generate();
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'agent.json'), JSON.stringify(Array.from(kp.secretKey)));
    expect(keySource(env)).toEqual({ kind: 'default', path: join(home, 'agent.json') });
    expect(loadKeypair(env).publicKey.equals(kp.publicKey)).toBe(true);
    const src = describeKeySource(keySource(env));
    expect(src).toBe(`file ${join(home, 'agent.json')}`);
    expect(src).not.toContain(bs58.encode(kp.secretKey));
    expect(describeKeySource(keySource({ ...env, H081_SOLANA_KEY: bs58.encode(kp.secretKey) }))).toBe('H081_SOLANA_KEY');
    // H081_SOLANA_KEYPAIR with a leading ~ is expanded
    expect(keySource({ H081_SOLANA_KEYPAIR: '~/.h081/agent.json' })).toEqual({ kind: 'H081_SOLANA_KEYPAIR', path: join(homedir(), '.h081', 'agent.json') });
    expect(() => loadKeypair({ H081_SOLANA_KEYPAIR: '~/h081-surely-missing-dir/agent.json' })).toThrow(`no file at ${join(homedir(), 'h081-surely-missing-dir', 'agent.json')}`);
  });

  it('H081_ACCOUNT_SK overrides the derived secret (decimal or hex) and is validated', () => {
    const kp = Keypair.generate();
    expect(accountSkFromEnv(kp, {})).toEqual({ sk: deriveAccountSk(kp), derived: true, source: 'seed', derivation: 'seed' });
    expect(accountSkFromEnv(kp, { H081_ACCOUNT_SK: '12345' })).toEqual({ sk: 12345n, derived: false, source: 'env', derivation: 'seed' });
    expect(accountSkFromEnv(kp, { H081_ACCOUNT_SK: '0xff' })).toEqual({ sk: 255n, derived: false, source: 'env', derivation: 'seed' });
    expect(() => parseFieldElement('0')).toThrow(/in 1\.\./);
    expect(() => parseFieldElement(FIELD.toString())).toThrow(/in 1\.\./);
    expect(() => parseFieldElement('abc')).toThrow(/decimal or 0x hex/);
  });
});
