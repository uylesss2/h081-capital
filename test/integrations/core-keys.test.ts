import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { FIELD } from '../../src/crypto.js';
import { accountSkFromEnv, deriveAccountSk, deriveAgentSk, hasKeyInEnv, loadKeypair, parseFieldElement, parseSecret } from '../../integrations/core/keys.js';

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
    expect(() => loadKeypair({})).toThrow(/H081_SOLANA_KEYPAIR/);
    expect(() => loadKeypair({ H081_SOLANA_KEYPAIR: join(dir, 'missing.json') })).toThrow(/no file/);
    expect(() => parseSecret('not base58!!')).toThrow(/neither base58/);
    expect(() => parseSecret('[1,2,3]')).toThrow(/64 bytes/);
    expect(parseSecret(bs58.encode(kp.secretKey.subarray(0, 32))).publicKey.equals(kp.publicKey)).toBe(true); // a 32-byte seed
    expect(hasKeyInEnv({})).toBe(false);
    expect(hasKeyInEnv({ H081_SOLANA_KEY: ' ' })).toBe(false);
    expect(hasKeyInEnv({ H081_SOLANA_KEY: 'x' })).toBe(true);
  });

  it('H081_ACCOUNT_SK overrides the derived secret (decimal or hex) and is validated', () => {
    const kp = Keypair.generate();
    expect(accountSkFromEnv(kp, {})).toEqual({ sk: deriveAccountSk(kp), derived: true });
    expect(accountSkFromEnv(kp, { H081_ACCOUNT_SK: '12345' })).toEqual({ sk: 12345n, derived: false });
    expect(accountSkFromEnv(kp, { H081_ACCOUNT_SK: '0xff' })).toEqual({ sk: 255n, derived: false });
    expect(() => parseFieldElement('0')).toThrow(/in 1\.\./);
    expect(() => parseFieldElement(FIELD.toString())).toThrow(/in 1\.\./);
    expect(() => parseFieldElement('abc')).toThrow(/decimal or 0x hex/);
  });
});
