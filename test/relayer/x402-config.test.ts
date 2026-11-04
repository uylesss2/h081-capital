// RELAYER_X402_* / CDP_API_KEY_* configuration: enabled only with both credentials, payTo pinned to the
// treasury, defaults, prices, network and resource-base validation.
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
  ConfigError, DEFAULT_X402_RESOURCE_BASE, DEFAULT_X402_SERVICE_NAME, DEFAULT_X402_TAGS, LAUNCH_WALLET_DENYLIST, MAINNET_LOAN_PROGRAM_ID, loadConfig,
} from '../../relayer/config.js';
import { DEFAULT_X402_PRICES } from '../../relayer/x402/catalog.js';
import { DEFAULT_FACILITATOR_URL } from '../../relayer/x402/facilitator.js';
import { SOLANA_MAINNET_NETWORK } from '../../relayer/x402/types.js';

const treasury = Keypair.generate().publicKey.toBase58();
const usdg = '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH';
const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const base = (o: Record<string, string> = {}) => ({
  RELAYER_SOLANA_RPC: 'http://127.0.0.1:9099', RELAYER_SOLANA_KEYPAIR: 'relayer.json', RELAYER_SOLANA_MIN_FEES: `${usdg}=50000`, RELAYER_SOLANA_TREASURY: treasury, ...o,
});
const creds = { CDP_API_KEY_ID: 'organizations/o/apiKeys/k', CDP_API_KEY_SECRET: 'c2VjcmV0' };

describe('x402 configuration', () => {
  it('is absent without credentials, an error with only one, and defaults with both', () => {
    expect(loadConfig(base()).x402).toBeUndefined();
    expect(() => loadConfig(base({ CDP_API_KEY_ID: 'k' }))).toThrow(/both CDP_API_KEY_ID and CDP_API_KEY_SECRET/);
    expect(() => loadConfig(base({ CDP_API_KEY_SECRET: 's' }))).toThrow(ConfigError);
    const x = loadConfig(base(creds)).x402!;
    expect(x).toMatchObject({
      facilitatorUrl: DEFAULT_FACILITATOR_URL, apiKeyId: creds.CDP_API_KEY_ID, apiKeySecret: creds.CDP_API_KEY_SECRET, facilitatorTimeoutMs: 30_000,
      network: SOLANA_MAINNET_NETWORK, payTo: treasury, assets: [usdg], resourceBase: DEFAULT_X402_RESOURCE_BASE, maxTimeoutSeconds: 120,
      serviceName: DEFAULT_X402_SERVICE_NAME, tags: DEFAULT_X402_TAGS, iconUrl: undefined, circuitsDir: undefined, loanProgramId: MAINNET_LOAN_PROGRAM_ID,
      priority: { maxInFlight: 4, maxLamports: 4_000_000, priceCeil: 5_000_000 },
    });
    expect([...x.prices]).toEqual(Object.entries(DEFAULT_X402_PRICES));
    expect(x.payToTokenAccounts.size).toBe(0);
  });

  it('needs Solana relaying and pins payTo to the treasury (never a launch wallet)', () => {
    expect(() => loadConfig({ RELAYER_EVM_RPC: 'http://x', RELAYER_EVM_POOL: '0x' + '1'.repeat(40), RELAYER_EVM_KEY: '0x' + '2'.repeat(64), RELAYER_EVM_MIN_FEES: `0x${'3'.repeat(40)}=1`, ...creds }))
      .toThrow(/Solana relaying/);
    expect(loadConfig(base({ ...creds, RELAYER_X402_PAY_TO: treasury })).x402?.payTo).toBe(treasury);
    expect(() => loadConfig(base({ ...creds, RELAYER_X402_PAY_TO: Keypair.generate().publicKey.toBase58() }))).toThrow(/must be the platform treasury/);
    expect(() => loadConfig(base({ ...creds, RELAYER_X402_PAY_TO: 'nope' }))).toThrow(ConfigError);
    // a launch wallet is never the treasury, so it fails the treasury rule first; either way it is refused
    for (const w of LAUNCH_WALLET_DENYLIST) expect(() => loadConfig(base({ ...creds, RELAYER_X402_PAY_TO: w }))).toThrow(/treasury|launch wallet/);
  });

  it('parses prices (unknown id, non-integer refused; 0 disables), assets and pinned token accounts', () => {
    const x = loadConfig(base({ ...creds, RELAYER_X402_PRICES: 'relay-priority=300000, preflight=0', RELAYER_X402_ASSETS: `${usdg},${usdc}`, RELAYER_X402_PAY_TO_TOKEN_ACCOUNTS: `${usdg}=DxpmCZYAoDKpHmA5vWuopUrf3UVuGnPvditVrN9xDwDo` })).x402!;
    expect(x.prices.get('relay-priority')).toBe(300_000n);
    expect(x.prices.get('preflight')).toBe(0n);
    expect(x.prices.get('loans-market')).toBe(DEFAULT_X402_PRICES['loans-market']);
    expect(x.assets).toEqual([usdg, usdc]);
    expect(x.payToTokenAccounts.get(usdg)).toBe('DxpmCZYAoDKpHmA5vWuopUrf3UVuGnPvditVrN9xDwDo');
    expect(() => loadConfig(base({ ...creds, RELAYER_X402_PRICES: 'nope=1' }))).toThrow(/unknown service/);
    expect(() => loadConfig(base({ ...creds, RELAYER_X402_PRICES: 'preflight=1.5' }))).toThrow(ConfigError);
    expect(() => loadConfig(base({ ...creds, RELAYER_X402_ASSETS: 'nope' }))).toThrow(ConfigError);
    expect(() => loadConfig(base({ ...creds, RELAYER_X402_PAY_TO_TOKEN_ACCOUNTS: `${usdg}` }))).toThrow(/mint=tokenAccount/);
  });

  it('validates the network id, the resource base, the listing fields and the loan program id', () => {
    expect(() => loadConfig(base({ ...creds, RELAYER_X402_NETWORK: 'solana' }))).toThrow(/CAIP-2/);
    expect(() => loadConfig(base({ ...creds, RELAYER_X402_NETWORK: 'eip155:8453' }))).toThrow(ConfigError);
    expect(loadConfig(base({ ...creds, RELAYER_X402_NETWORK: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' })).x402?.network).toBe('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1');
    expect(() => loadConfig(base({ ...creds, RELAYER_X402_RESOURCE_BASE: 'http://relayer.example' }))).toThrow(/https origin/);
    expect(() => loadConfig(base({ ...creds, RELAYER_X402_RESOURCE_BASE: 'https://relayer.example/v1' }))).toThrow(/https origin/);
    expect(loadConfig(base({ ...creds, RELAYER_X402_RESOURCE_BASE: 'https://relayer.example/' })).x402?.resourceBase).toBe('https://relayer.example');
    expect(() => loadConfig(base({ ...creds, RELAYER_X402_SERVICE_NAME: 'x'.repeat(33) }))).toThrow(/32/);
    expect(() => loadConfig(base({ ...creds, RELAYER_X402_TAGS: 'a,b,c,d,e,f' }))).toThrow(/5 tags/);
    expect(loadConfig(base({ ...creds, RELAYER_X402_TAGS: '' })).x402?.tags).toEqual([]);
    expect(() => loadConfig(base({ ...creds, RELAYER_X402_ICON_URL: 'https://h081.xyz/icon.svg' }))).toThrow(/png/);
    expect(loadConfig(base({ ...creds, RELAYER_X402_ICON_URL: 'https://h081.xyz/icon.png' })).x402?.iconUrl).toBe('https://h081.xyz/icon.png');
    expect(() => loadConfig(base({ ...creds, RELAYER_X402_LOAN_PROGRAM_ID: 'nope' }))).toThrow(ConfigError);
    expect(() => loadConfig(base({ ...creds, RELAYER_X402_DISCLOSE_VKEY_SHA256: 'abc' }))).toThrow(/sha256/);
    expect(loadConfig(base({ ...creds, RELAYER_X402_CIRCUITS_DIR: 'build/circuits', RELAYER_X402_DISCLOSE_VKEY_SHA256: 'A'.repeat(64) })).x402)
      .toMatchObject({ circuitsDir: 'build/circuits', discloseVkeySha256: 'a'.repeat(64) });
  });
});
