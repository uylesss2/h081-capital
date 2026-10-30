// EVM relayer calldata checks (in-process, no chain): which pool calls a relayer accepts and what they pay.
import { describe, expect, it } from 'vitest';
import { Wallet as EthersWallet, JsonRpcProvider } from 'ethers';
import { connectPool } from '../../src/client.js';
import { checkEvmCall, type EvmFeeTerms } from '../../relayer/evm.js';
import { RelayError } from '../../relayer/errors.js';

const pool = EthersWallet.createRandom().address;
const relayer = EthersWallet.createRandom().address;
const usd = EthersWallet.createRandom().address;
const other = EthersWallet.createRandom().address;
const ZERO = '0x0000000000000000000000000000000000000000';
const iface = connectPool(pool, new JsonRpcProvider('http://127.0.0.1:1')).interface;
const terms = (o: Partial<EvmFeeTerms> = {}): EvmFeeTerms => ({ pool, relayer, minFees: new Map([[usd.toLowerCase(), 1_000n]]), ...o });
const proof = { a: [1n, 2n], b: [[3n, 4n], [5n, 6n]], c: [7n, 8n] };

const transact = (o: { extAmount?: bigint; fee?: bigint; relayer?: string; asset?: string } = {}) => iface.encodeFunctionData('transact', [
  proof,
  { root: 1n, publicAmount: 0n, publicAsset: o.asset ?? usd, extDataHash: 2n, inputNullifiers: [3n, 4n], outputCommitments: [5n, 6n] },
  { recipient: other, relayer: o.relayer ?? relayer, extAmount: o.extAmount ?? -5_000n, fee: o.fee ?? 1_000n, encryptedOutputs: ['0x01', '0x02'] },
]);

const spend = (o: { fee?: bigint; publicAmount?: bigint; claim?: boolean; relayer?: string; asset?: string } = {}) => iface.encodeFunctionData('spend', [
  proof,
  {
    root: 1n, nullifier: 9n, newAllowanceCommitment: 2n, payCommitment: 0n, publicAmount: o.publicAmount ?? 50_000n, publicRecipient: other,
    publicAsset: o.asset ?? usd, fee: o.fee ?? 2_000n, timestamp: 1n, receipt: 3n, lenderAmount: 0n, lenderAddr: ZERO, loanRef: 0n,
    isLenderClaim: o.claim ?? false, extDataHash: 4n,
  },
  { relayer: o.relayer ?? relayer, encryptedAllowance: '0x', encryptedPayment: '0x', encryptedLender: '0x' },
]);

const code = (f: () => unknown) => {
  try { f(); } catch (e) { if (e instanceof RelayError) return `${e.status} ${e.code}`; throw e; }
  return 'ok';
};

describe('EVM calldata checks', () => {
  it('accepts a withdrawal and a public spend that pay the relayer at least the minimum', () => {
    expect(checkEvmCall(iface, { to: pool, data: transact() }, terms())).toEqual({ fn: 'transact', paid: true, asset: usd, fee: 1_000n, nullifiers: [3n, 4n] });
    expect(checkEvmCall(iface, { to: pool.toLowerCase(), data: spend() }, terms())).toMatchObject({ fn: 'spend', paid: true, fee: 2_000n, nullifiers: [9n] });
  });

  it('refuses another contract, malformed bodies and functions that are not operations', () => {
    expect(code(() => checkEvmCall(iface, { to: other, data: transact() }, terms()))).toBe('400 wrong_contract');
    expect(code(() => checkEvmCall(iface, { to: pool, data: 'zz' }, terms()))).toBe('400 bad_request');
    expect(code(() => checkEvmCall(iface, { to: pool, data: 5 }, terms()))).toBe('400 bad_request');
    expect(code(() => checkEvmCall(iface, { to: pool, data: '0xdeadbeef' }, terms()))).toBe('400 bad_calldata');
    const pull = iface.encodeFunctionData('pullLenderShare', [usd, other, 1n]);
    expect(code(() => checkEvmCall(iface, { to: pool, data: pull }, terms()))).toBe('400 function_not_relayable');
  });

  it('refuses fees that are too low, in other assets, or bound to another relayer (402)', () => {
    expect(code(() => checkEvmCall(iface, { to: pool, data: transact({ fee: 999n }) }, terms()))).toBe('402 fee_too_low');
    expect(code(() => checkEvmCall(iface, { to: pool, data: transact({ asset: other }) }, terms()))).toBe('402 asset_not_accepted');
    expect(code(() => checkEvmCall(iface, { to: pool, data: transact({ relayer: other }) }, terms()))).toBe('402 wrong_relayer');
    expect(code(() => checkEvmCall(iface, { to: pool, data: spend({ fee: 1n }) }, terms()))).toBe('402 fee_too_low');
    expect(code(() => checkEvmCall(iface, { to: pool, data: spend({ relayer: other }) }, terms()))).toBe('402 wrong_relayer');
  });

  it('never relays a deposit (the pool pulls it from msg.sender) or a lender claim', () => {
    expect(code(() => checkEvmCall(iface, { to: pool, data: transact({ extAmount: 10_000n }) }, terms({ allowUnpaid: true })))).toBe('400 deposit_not_relayable');
    expect(code(() => checkEvmCall(iface, { to: pool, data: spend({ claim: true }) }, terms({ allowUnpaid: true })))).toBe('400 claim_not_relayable');
  });

  it('unpaid operations only when allowed', () => {
    const grant = iface.encodeFunctionData('grant', [
      proof,
      { root: 1n, inputNullifiers: [1n, 2n], allowanceCommitments: Array(16).fill(0n), changeCommitment: 0n, totalCommitment: 0n, extDataHash: 0n },
      { encryptedAllowances: Array(16).fill('0x'), encryptedChange: '0x' },
    ]);
    for (const data of [grant, transact({ extAmount: 0n, fee: 0n, asset: ZERO }), spend({ fee: 0n, publicAmount: 0n })]) {
      expect(code(() => checkEvmCall(iface, { to: pool, data }, terms()))).toBe('402 fee_required');
      expect(checkEvmCall(iface, { to: pool, data }, terms({ allowUnpaid: true })).paid).toBe(false);
    }
  });
});
