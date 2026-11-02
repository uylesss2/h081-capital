// Offline execution tests of the two DefiLlama adapters: the modules are loaded and run against
// stubbed DefiLlama helpers, so a broken require path, a wrong helper option name or a syntax error
// fails here. No RPC, no Allium key. (The upstream repos' own test runners are the final proof, see
// VERIFY.md.)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as web3 from '@solana/web3.js';
import { beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { ADDR, derived } from './derive-addresses.mjs';
import { calls as receivedCalls, STUB_AMOUNT, USDG_STUB } from './stubs/helpers-token.js';
// resolved to ./stubs/* by vitest.config.ts (the real helpers live only in dimension-adapters)
import feesAdapter from '../fees/fees/h081.js';

const here = path.resolve(__dirname);
const read = (p: string) => readFileSync(path.join(here, '..', p), 'utf8');

// The option names projects/helper/solana.js sumTokensExport() destructures at the verified upstream HEAD.
const SUM_TOKENS_OPTIONS = ['tokenAccounts', 'owner', 'owners', 'tokens', 'solOwners', 'blacklistedTokens', 'allowError', 'tokensAndOwners', 'onlyTrustedTokens'];
// The option names helpers/token.ts getSolanaReceived() destructures at the verified upstream HEAD.
const RECEIVED_OPTIONS = ['options', 'balances', 'target', 'targets', 'mints', 'blacklists', 'blacklist_signers', 'blacklist_mints', 'fromAddress', 'fromAddresses'];

// Documented wallets (docs/MAINNET-RUNBOOK.md, README.md, relayer/README.md)
const DEPLOYER = '5WCpirBe1wHUk6PL2nU97pj87PtyaqH9S6UJUbd5z2W1';
const CONFIG_AUTHORITY = '4eySgHKMNGMpWtbtpfxfSyJZK8LGYxEZLzJwHXCsoPX2';
const MULTISIG = ['G3xFLKe6An28bgdtUuyaoZCpjtPpQTh3GgKNKtWG26A6', '4ir9vPVqWZ28ja6eTZs75LqBduhL1R8AQ9irxBu16kAd', '3QxDPawgSmdPsvNa1xfsHuuF7cXWBaoBhPHgQgoBpnfi', '3TGGDFAtipTMSpkmSEfm1CTcREQYdTkzWhzdVCzLLa7N', '7815bY95r1E5FifAZMf5rM5Vjrper67BBY1wS8m216i1'];
const RELAYER_HOT_WALLET = 'DWp7dJ6QZxqtUDhMy7JB6UJru47J94bQSJNEdG4QrjjA';
const TEAM_SIGNERS = [ADDR.TREASURY, derived.treasuryUsdg, DEPLOYER, CONFIG_AUTHORITY, ...MULTISIG];

/** Runs tvl/projects/h081/index.js (CommonJS) with `../helper/solana` replaced by a recorder. */
function loadTvlAdapter() {
  const src = read('tvl/projects/h081/index.js');
  const calls: any[] = [];
  const helper = {
    sumTokensExport: (args: any) => {
      calls.push(args);
      return (api: any) => ({ api, args });
    },
  };
  const requireStub = (id: string) => {
    if (id === '../helper/solana') return helper;
    if (id === '@solana/web3.js') return web3;
    throw new Error(`unexpected require("${id}") in the TVL adapter`);
  };
  const mod = { exports: {} as any };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('require', 'module', 'exports', 'Buffer', src)(requireStub, mod, mod.exports, Buffer);
  return { exports: mod.exports, calls };
}

describe('TVL adapter (DefiLlama-Adapters projects/h081/index.js)', () => {
  const { exports: tvl, calls } = loadTvlAdapter();

  it('exports the DefiLlama module shape with a solana tvl and staking section', () => {
    expect(tvl.timetravel).toBe(true);
    expect(tvl.start).toBe('2026-10-31');
    expect(typeof tvl.methodology).toBe('string');
    expect(Object.keys(tvl.solana).sort()).toEqual(['staking', 'tvl']);
    expect(typeof tvl.solana.tvl).toBe('function');
    expect(typeof tvl.solana.staking).toBe('function');
  });

  it('counts only the accepted deposit mints owned by the vault authority', () => {
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ owners: [derived.vaultAuthority], tokens: [ADDR.USDG] });
    expect(calls[0].owners[0]).toBe('9JnWo2rJ1MpB14NKNSEXCV2iMtMim6oUpHpgJFSVb2B7');
    // tvl section returns what the helper built from exactly these arguments
    const api = { chain: 'solana' };
    expect(tvl.solana.tvl(api)).toEqual({ api, args: calls[0] });
  });

  it('reports the H081 in the capacity_stake and safety_pool vaults as staking', () => {
    expect(calls[1]).toEqual({ tokenAccounts: [derived.capacityVault, derived.safetyVault] });
    expect(calls[1].tokenAccounts).toEqual(['EUMsBu6yj1DAXriTMSaGQCs6Ff4H6Rb7QTueGa7AN6Nh', '4qM5m3UGiJnn9G3rVUC9b2uMxJmnxKcDXDetX7UDXT8g']);
  });

  it('uses only option names the upstream helper understands', () => {
    for (const c of calls) for (const k of Object.keys(c)) expect(SUM_TOKENS_OPTIONS).toContain(k);
  });

  it('reads nothing from an API and names only the H081 project', () => {
    const src = read('tvl/projects/h081/index.js');
    expect(src).not.toMatch(/https?:\/\/(?!h081\.xyz)/);
    expect(tvl.methodology).toContain('never passes through the bank vault');
    expect(tvl.methodology).not.toMatch(/stays? in the vault/);
  });
});

/** Minimal stand-in for @defillama/sdk Balances: what fees/h081.ts calls on the object. */
class FakeBalances {
  readonly entries: Record<string, bigint> = {};
  readonly labelled: Record<string, Record<string, bigint>> = {};
  add(token: string, amount: string | number | bigint, label?: string) {
    const key = token.includes(':') ? token : `solana:${token}`;
    this.entries[key] = (this.entries[key] ?? 0n) + BigInt(amount);
    if (label) {
      this.labelled[label] ??= {};
      this.labelled[label][key] = (this.labelled[label][key] ?? 0n) + BigInt(amount);
    }
  }
  addBalances(other: FakeBalances, label?: string) {
    for (const [k, v] of Object.entries(other.entries)) this.add(k, v, label);
  }
}

describe('fees adapter (dimension-adapters fees/h081.ts)', () => {
  beforeEach(() => { receivedCalls.length = 0; });

  const options = () => ({
    chain: 'solana',
    startTimestamp: Date.UTC(2026, 10, 1) / 1000,
    endTimestamp: Date.UTC(2026, 10, 2) / 1000,
    createBalances: () => new FakeBalances(),
  });

  it('declares a v2 Solana adapter that depends on Allium and starts at launch', () => {
    expect(feesAdapter.version).toBe(2);
    expect(feesAdapter.chains).toEqual(['solana']);
    expect(feesAdapter.start).toBe('2026-10-31');
    expect(feesAdapter.dependencies).toEqual(['allium']);
    expect(typeof feesAdapter.fetch).toBe('function');
    for (const k of ['Fees', 'Revenue', 'ProtocolRevenue']) {
      expect(typeof feesAdapter.methodology[k]).toBe('string');
      expect(feesAdapter.breakdownMethodology[k]).toHaveProperty('Protocol Fees');
    }
  });

  it('queries only the treasury, in USDG, with every team wallet excluded', async () => {
    const opts = options();
    await feesAdapter.fetch(opts);
    expect(receivedCalls).toHaveLength(1);
    const call = receivedCalls[0];
    for (const k of Object.keys(call)) expect(RECEIVED_OPTIONS).toContain(k);
    expect(call.options).toBe(opts);
    expect(call.balances).toBeInstanceOf(FakeBalances);
    expect(call.targets).toEqual([ADDR.TREASURY, derived.treasuryUsdg]);
    expect(call.targets).toEqual(['EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq', 'DxpmCZYAoDKpHmA5vWuopUrf3UVuGnPvditVrN9xDwDo']);
    expect(call.mints).toEqual([ADDR.USDG]);
    expect(call.blacklist_mints).toEqual([ADDR.H081]);
    // senders: every team wallet AND the relayer hot wallet
    expect([...call.blacklists].sort()).toEqual([...TEAM_SIGNERS, RELAYER_HOT_WALLET].sort());
    // signers: every team wallet but NOT the relayer hot wallet (it signs the fee-paying relays)
    expect([...call.blacklist_signers].sort()).toEqual([...TEAM_SIGNERS].sort());
    expect(call.blacklist_signers).not.toContain(RELAYER_HOT_WALLET);
    // only the treasury is ever a fee destination
    expect([...call.targets].sort()).toEqual([ADDR.TREASURY, derived.treasuryUsdg].sort());
  });

  it('books what the treasury received as fees = revenue = protocol revenue, labelled', async () => {
    const res = await feesAdapter.fetch(options());
    const key = `solana:${USDG_STUB}`;
    expect(res.dailyFees.entries).toEqual({ [key]: BigInt(STUB_AMOUNT) });
    expect(res.dailyFees.labelled).toEqual({ 'Protocol Fees': { [key]: BigInt(STUB_AMOUNT) } });
    expect(res.dailyRevenue).toBe(res.dailyFees);
    expect(res.dailyProtocolRevenue).toBe(res.dailyFees);
  });

  it('states the fee-only treasury account and the trading-fee exclusion in the methodology', () => {
    const text = JSON.stringify(feesAdapter.methodology).toLowerCase();
    expect(text).toContain('fee-only');
    expect(text).toContain('trading');
    expect(text).toContain('excluded');
    expect(text).toContain('relayer hot wallet');
  });
});
