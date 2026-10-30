// EVM relaying (the reference StipendPool). A wallet sends pool calldata; the relayer checks that the
// call pays it at least its minimum fee in the asset, simulates it from its own address, and sends it with
// its own key. The proof binds `relayer` and `fee` through extDataHash, so the relayer cannot change either;
// it only decides whether to submit.
import { Interface, type Signer, type TransactionRequest } from 'ethers';
import { connectPool } from '../src/client.js';
import { RelayError, badRequest } from './errors.js';
import { InFlight, Mutex } from './ratelimit.js';

const ZERO = '0x0000000000000000000000000000000000000000';

export interface EvmFeeTerms {
  pool: string;
  relayer: string;
  /** minimum fee by asset address (lowercase) in base units; assets missing here are not accepted */
  minFees: Map<string, bigint>;
  allowUnpaid?: boolean;
}

export interface EvmCheck { fn: 'transact' | 'spend' | 'grant' | 'delegate'; paid: boolean; asset?: string; fee: bigint; nullifiers: bigint[] }

/**
 * Decodes pool calldata and checks what it pays the relayer. Refuses: another contract, functions that are
 * not pool operations, deposits (the pool pulls the deposit from msg.sender, which would be the relayer),
 * lender claims (msg.sender must be the lender), a fee to another relayer, a fee in an asset not accepted
 * or below its minimum, and unpaid operations unless `allowUnpaid`.
 */
export function checkEvmCall(iface: Interface, tx: { to: unknown; data: unknown }, terms: EvmFeeTerms): EvmCheck {
  if (typeof tx.to !== 'string' || typeof tx.data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(tx.data)) {
    throw badRequest('bad_request', 'body must be { to: address, data: 0x-hex calldata }');
  }
  if (tx.to.toLowerCase() !== terms.pool.toLowerCase()) throw badRequest('wrong_contract', `this relayer only calls the pool ${terms.pool}`);
  let parsed;
  try { parsed = iface.parseTransaction({ data: tx.data }); } catch { parsed = null; }
  if (!parsed) throw badRequest('bad_calldata', 'calldata does not decode as a pool call');
  const name = parsed.name;
  if (name !== 'transact' && name !== 'spend' && name !== 'grant' && name !== 'delegate') throw badRequest('function_not_relayable', `${name} is not relayed`);
  const args = parsed.args[1];
  const ext = parsed.args[2];
  const nullifiers: bigint[] = name === 'transact' || name === 'grant' ? [...args.inputNullifiers].map(BigInt) : [BigInt(args.nullifier)];
  const unpaid = (fn: EvmCheck['fn']): EvmCheck => {
    if (!terms.allowUnpaid) throw badRequest('fee_required', `${fn} pays no relayer fee and this relayer does not relay unpaid operations`);
    return { fn, paid: false, fee: 0n, nullifiers };
  };
  if (name === 'grant' || name === 'delegate') return unpaid(name);
  let fee: bigint;
  let asset: string;
  if (name === 'transact') {
    const extAmount = BigInt(ext.extAmount);
    if (extAmount > 0n) throw badRequest('deposit_not_relayable', 'a deposit pulls tokens from msg.sender; send it yourself');
    fee = BigInt(ext.fee);
    if (fee === 0n) return unpaid('transact');
    asset = String(args.publicAsset);
  } else {
    if (args.isLenderClaim) throw badRequest('claim_not_relayable', 'a lender claim must be sent by the lender');
    fee = BigInt(args.fee);
    if (fee === 0n || BigInt(args.publicAmount) === 0n) return unpaid('spend');
    asset = String(args.publicAsset);
  }
  if (asset === ZERO) throw badRequest('asset_missing', 'a paid operation names its asset');
  if (String(ext.relayer).toLowerCase() !== terms.relayer.toLowerCase()) {
    throw badRequest('wrong_relayer', `ext.relayer is ${ext.relayer}, this relayer is ${terms.relayer}`);
  }
  const min = terms.minFees.get(asset.toLowerCase());
  if (min === undefined) throw badRequest('asset_not_accepted', `fees in ${asset} are not accepted`);
  if (fee < min) throw badRequest('fee_too_low', `fee ${fee} is below the minimum ${min} for ${asset}`);
  return { fn: name, paid: true, asset, fee, nullifiers };
}

export interface EvmRelayerOptions {
  signer: Signer;
  pool: string;
  minFees: Map<string, bigint>;
  allowUnpaid?: boolean;
  /** refuse calls whose gas estimate exceeds this (default 8,000,000) */
  maxGas?: bigint;
}

function revertReason(e: unknown): string {
  const x = e as { reason?: string; shortMessage?: string; message?: string };
  return x.reason ?? x.shortMessage ?? x.message ?? String(e);
}

export class EvmRelayer {
  readonly iface: Interface;
  private readonly mutex = new Mutex();
  /** nullifiers of calls this relayer sent recently: a second call spending one would only revert */
  readonly inFlight = new InFlight();
  private address?: string;
  private chainId?: bigint;

  constructor(readonly opts: EvmRelayerOptions) {
    this.iface = connectPool(opts.pool, opts.signer).interface;
    for (const k of opts.minFees.keys()) if (k !== k.toLowerCase()) throw new Error('EVM fee assets must be lowercase');
  }

  async init(): Promise<this> {
    this.address = await this.opts.signer.getAddress();
    const provider = this.opts.signer.provider;
    if (!provider) throw new Error('the relayer signer has no provider');
    this.chainId = (await provider.getNetwork()).chainId;
    return this;
  }

  private terms(): EvmFeeTerms {
    if (!this.address) throw new Error('EvmRelayer.init() first');
    return { pool: this.opts.pool, relayer: this.address, minFees: this.opts.minFees, allowUnpaid: this.opts.allowUnpaid };
  }

  info() {
    const t = this.terms();
    return {
      chainId: String(this.chainId), pool: t.pool, relayer: t.relayer, allowUnpaid: !!t.allowUnpaid,
      minFees: Object.fromEntries([...t.minFees].map(([k, v]) => [k, v.toString()])),
    };
  }

  /** Checks, simulates (eth_call from the relayer) and sends. Resolves with the hash once sent. */
  async relay(body: unknown): Promise<{ hash: string; fn: string; fee: string }> {
    const b = (body ?? {}) as { to?: unknown; data?: unknown };
    const check = checkEvmCall(this.iface, { to: b.to, data: b.data }, this.terms());
    const release = this.inFlight.claim(check.nullifiers);
    try {
      return await this.submit(b.data as string, check);
    } catch (e) {
      release();
      throw e;
    }
  }

  private async submit(data: string, check: EvmCheck): Promise<{ hash: string; fn: string; fee: string }> {
    const provider = this.opts.signer.provider!;
    const req: TransactionRequest = { from: this.address, to: this.opts.pool, data };
    try {
      await provider.call(req);
    } catch (e) {
      throw new RelayError(422, 'simulation_failed', revertReason(e));
    }
    let gas: bigint;
    try {
      gas = await provider.estimateGas(req);
    } catch (e) {
      throw new RelayError(422, 'simulation_failed', revertReason(e));
    }
    const maxGas = this.opts.maxGas ?? 8_000_000n;
    if (gas > maxGas) throw new RelayError(422, 'gas_too_high', `estimated gas ${gas} exceeds ${maxGas}`);
    const sent = await this.mutex.run(() => this.opts.signer.sendTransaction({ to: this.opts.pool, data, gasLimit: (gas * 12n) / 10n }));
    return { hash: sent.hash, fn: check.fn, fee: check.fee.toString() };
  }
}
