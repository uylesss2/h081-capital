// x402 ("HTTP 402 Payment Required") on top of Wallet.pay: an agent pays a
// vendor's resource from its allowance, and the vendor checks the payout on
// chain. The shapes follow the public x402 specification (v2: base64 JSON in
// the PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE headers; v1: the
// requirements in the 402 body, X-PAYMENT / X-PAYMENT-RESPONSE headers) with a
// scheme of our own, `stipend-shielded`. See docs/X402.md.
//
// How the shielded payment maps onto x402. In the spec's `exact` scheme the
// client signs a transfer authorization and the server (or its facilitator)
// broadcasts it. A stipend payment is a zero-knowledge spend: the agent proves
// it against its allowance and a relayer broadcasts it, so the payment is
// settled before the retry, and the vendor's "settle" only verifies it on chain
// and consumes it. The vendor learns the payout (asset, amount, its own
// address, the time, the relayer that submitted it), never the payer: which
// allowance paid, its owner, its policy and its balance stay private.
import { AbiCoder, Contract, hexlify, keccak256, randomBytes, type Provider } from 'ethers';
import { type OwnedAllowance, type Relay, type TxResult, type Wallet, latestTimestamp } from './client.js';
import { lenderShare, type Allowance } from './crypto.js';

export const X402_SCHEME = 'stipend-shielded';
/** Domain of the tag written into the spend's `encryptedPayment` slot. */
export const X402_TAG_DOMAIN = 'stipend-x402/v1';

export const X402_HEADERS = {
  v2: { required: 'PAYMENT-REQUIRED', payment: 'PAYMENT-SIGNATURE', response: 'PAYMENT-RESPONSE' },
  v1: { required: undefined, payment: 'X-PAYMENT', response: 'X-PAYMENT-RESPONSE' },
} as const;

export type X402Version = 1 | 2;

// ------------------------------------------------------------------ shapes

export interface X402ResourceInfo { url: string; description?: string; mimeType?: string; serviceName?: string; tags?: string[]; iconUrl?: string }

/** What this scheme puts in `PaymentRequirements.extra`. */
export interface StipendExtra {
  /** the pool whose `spend` must carry the payout */
  pool: string;
  /** a fresh 32-byte value per request, chosen by the vendor */
  nonce: string;
  assetTransferMethod: 'stipend-spend';
  /** the payment is settled by the payer's relayer before the resource runs */
  paymentFlow: 'upfront';
  [k: string]: unknown;
}

/** x402 v2 `PaymentRequirements`. */
export interface PaymentRequirements {
  scheme: string; network: string; amount: string; asset: string; payTo: string; maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

/** x402 v1 `PaymentRequirements`. */
export interface PaymentRequirementsV1 {
  scheme: string; network: string; maxAmountRequired: string; asset: string; payTo: string; resource: string; description: string;
  mimeType?: string; outputSchema?: unknown; maxTimeoutSeconds: number; extra?: Record<string, unknown>;
}

export interface PaymentRequired {
  x402Version: X402Version; error?: string; resource?: X402ResourceInfo;
  accepts: Array<PaymentRequirements | PaymentRequirementsV1>;
  extensions?: Record<string, unknown>;
}

/** The scheme-specific `payload`: which transaction paid, for which request, and the secret behind the tag. */
export interface StipendPayload { transaction: string; nonce: string; secret: string }

export interface PaymentPayload {
  x402Version: X402Version;
  /** v2 */ resource?: X402ResourceInfo; accepted?: PaymentRequirements;
  /** v1 */ scheme?: string; network?: string;
  payload: StipendPayload;
  extensions?: Record<string, unknown>;
}

export interface VerifyResponse { isValid: boolean; invalidReason?: string; payer?: string; extra?: Record<string, unknown> }

export interface SettlementResponse {
  success: boolean; errorReason?: string; payer?: string; transaction: string; network: string; amount?: string;
  extensions?: Record<string, unknown>;
}

/** One accepted way to pay, normalized across versions. */
export interface StipendRequirement {
  version: X402Version; network: string; amount: bigint; asset: string; payTo: string; maxTimeoutSeconds: number;
  pool: string; nonce: string; raw: PaymentRequirements | PaymentRequirementsV1;
}

// ------------------------------------------------------------------ encoding

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

export function decodeHeader<T>(value: string): T {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as T;
}

/** CAIP-2 identifier of an EVM chain, used for `network` in both versions. */
export function evmNetwork(chainId: bigint | number): string {
  return `eip155:${BigInt(chainId)}`;
}

/** The tag a payment carries: keccak256(abi.encode(domain, nonce, secret)). Only the payer knows `secret`. */
export function x402Tag(nonce: string, secret: string): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(['string', 'bytes32', 'bytes32'], [X402_TAG_DOMAIN, nonce, secret]));
}

/**
 * The smallest gross spend whose payout to the vendor, after the lender's share (on a pledged allowance) and the
 * relayer fee, is at least `net`. Throws when no gross amount can (a pledge of 100%).
 */
export function grossFor(a: Allowance, net: bigint, fee = 0n): bigint {
  const want = net + fee;
  const bps = a.policy.pledgeBps;
  if (bps === 0n) return want;
  if (bps >= 10000n) throw new Error('a fully pledged allowance pays nothing to a vendor');
  const pays = (g: bigint) => g - lenderShare(a, g) >= want;
  let g = (want * 10000n + (10000n - bps) - 1n) / (10000n - bps);
  while (g > want && pays(g - 1n)) g--;
  while (!pays(g)) g++;
  return g;
}

// ------------------------------------------------------------------ client

/** Reads the payment requirements of a 402 response: the v2 header first, else a v1 (or v2) JSON body. */
export async function parsePaymentRequired(res: Response): Promise<PaymentRequired | undefined> {
  if (res.status !== 402) return undefined;
  const header = res.headers.get(X402_HEADERS.v2.required);
  if (header) return decodeHeader<PaymentRequired>(header);
  try {
    const body = (await res.clone().json()) as PaymentRequired;
    return Array.isArray(body?.accepts) ? body : undefined;
  } catch {
    return undefined;
  }
}

/** Every requirement of the `stipend-shielded` scheme in a 402, normalized. */
export function stipendRequirements(pr: PaymentRequired): StipendRequirement[] {
  const out: StipendRequirement[] = [];
  for (const r of pr.accepts ?? []) {
    if (r.scheme !== X402_SCHEME) continue;
    const extra = (r.extra ?? {}) as Partial<StipendExtra>;
    if (typeof extra.pool !== 'string' || typeof extra.nonce !== 'string') continue;
    const amount = 'amount' in r ? r.amount : (r as PaymentRequirementsV1).maxAmountRequired;
    out.push({
      version: pr.x402Version === 1 ? 1 : 2, network: r.network, amount: BigInt(amount), asset: r.asset, payTo: r.payTo,
      maxTimeoutSeconds: r.maxTimeoutSeconds, pool: extra.pool, nonce: extra.nonce, raw: r,
    });
  }
  return out;
}

export interface X402PayOptions {
  relay?: Relay;
  /** refuse to pay more than this gross amount for one request (a client-side ceiling, on top of the policy) */
  maxAmount?: bigint;
  /** pick the allowance to pay from (given the asset and the payout wanted); default: the first agent allowance in the asset with enough left */
  allowance?: (asset: bigint, net: bigint) => OwnedAllowance | undefined;
}

export interface X402Payment { requirement: StipendRequirement; header: { name: string; value: string }; payload: PaymentPayload; gross: bigint; tx: TxResult }

/** Pays one requirement from an allowance with `Wallet.pay` and builds the header to retry with. */
export async function payRequirement(wallet: Wallet, req: StipendRequirement, opts: X402PayOptions = {}, resource?: X402ResourceInfo): Promise<X402Payment> {
  const asset = BigInt(req.asset);
  await wallet.sync();
  const fee = opts.relay?.fee ?? 0n;
  // the gross depends on each allowance's pledge, so it is sized per candidate
  const candidates = opts.allowance ? [opts.allowance(asset, req.amount)].filter((c): c is OwnedAllowance => c !== undefined) : wallet.agentAllowances(asset);
  let owned: OwnedAllowance | undefined;
  let gross = 0n;
  for (const c of candidates) {
    let g: bigint;
    try { g = grossFor(c.allowance, req.amount, fee); } catch { continue; }
    if (c.allowance.remaining >= g) { owned = c; gross = g; break; }
  }
  if (!owned) throw new Error(`no allowance in ${req.asset} can pay ${req.amount} (plus fee ${fee})`);
  if (opts.maxAmount !== undefined && gross > opts.maxAmount) throw new Error(`payment of ${gross} exceeds the client ceiling ${opts.maxAmount}`);
  const secret = hexlify(randomBytes(32));
  // The policy (per-tx cap, window, stream, expiry, allow-list) is enforced by the spend proof: a payment it
  // forbids has no valid proof, and the prover throws here.
  const tx = await wallet.pay(owned, gross, req.payTo, opts.relay ?? {}, { paymentTag: x402Tag(req.nonce, secret) });
  const stipend: StipendPayload = { transaction: tx.receipt.hash, nonce: req.nonce, secret };
  const payload: PaymentPayload = req.version === 1
    ? { x402Version: 1, scheme: X402_SCHEME, network: req.network, payload: stipend }
    : { x402Version: 2, ...(resource ? { resource } : {}), accepted: req.raw as PaymentRequirements, payload: stipend };
  const name = req.version === 1 ? X402_HEADERS.v1.payment : X402_HEADERS.v2.payment;
  return { requirement: req, header: { name, value: encodeHeader(payload) }, payload, gross, tx };
}

export interface X402FetchOptions extends X402PayOptions {
  /** the chain the wallet's pool lives on; requirements for another network or pool are ignored */
  chainId: bigint | number;
  fetch?: typeof fetch;
}

export interface X402FetchResult {
  response: Response;
  /** set when the first response was a 402 that this client paid */
  payment?: X402Payment;
  /** the vendor's PAYMENT-RESPONSE (or X-PAYMENT-RESPONSE), decoded */
  settlement?: SettlementResponse;
}

/**
 * `fetch` that pays a 402 from the wallet's allowance and retries once with the payment header. The request
 * body must be re-sendable (a string, bytes or form data, not a stream).
 */
export async function x402Fetch(wallet: Wallet, url: string, init: RequestInit = {}, opts: X402FetchOptions): Promise<X402FetchResult> {
  const doFetch = opts.fetch ?? fetch;
  const first = await doFetch(url, init);
  if (first.status !== 402) return { response: first };
  const pr = await parsePaymentRequired(first);
  if (!pr) return { response: first };
  const pool = String(await wallet.pool.getAddress()).toLowerCase();
  const network = evmNetwork(opts.chainId);
  const req = stipendRequirements(pr).find((r) => r.network === network && r.pool.toLowerCase() === pool);
  if (!req) throw new Error(`no ${X402_SCHEME} requirement for ${network} and pool ${pool}`);
  const resource = pr.resource ?? { url };
  const payment = await payRequirement(wallet, req, opts, resource);
  const headers = new Headers(init.headers);
  headers.set(payment.header.name, payment.header.value);
  const response = await doFetch(url, { ...init, headers });
  const rh = response.headers.get(X402_HEADERS.v2.response) ?? response.headers.get(X402_HEADERS.v1.response);
  return { response, payment, settlement: rh ? decodeHeader<SettlementResponse>(rh) : undefined };
}

// ------------------------------------------------------------------ vendor

export interface VendorRequest {
  asset: string; payTo: string; amount: bigint; resource: X402ResourceInfo;
  maxTimeoutSeconds?: number;
}

interface Issued { req: PaymentRequirements; resource: X402ResourceInfo; issuedAt: bigint; consumed: boolean }

/**
 * The vendor's side: issue requirements for a resource, then verify and consume the payment the client
 * retries with. It reads the chain through the pool contract's provider and holds issued nonces in memory
 * (a production vendor would keep them in its database). It never moves funds and needs no key.
 */
export class StipendX402Vendor {
  private issued = new Map<string, Issued>();
  private spentTx = new Set<string>();
  readonly network: string;

  constructor(readonly pool: Contract, chainId: bigint | number, readonly opts: { confirmations?: number } = {}) {
    this.network = evmNetwork(chainId);
  }

  private get provider(): Provider {
    const p = this.pool.runner?.provider;
    if (!p) throw new Error('pool has no provider');
    return p;
  }

  /** A fresh requirement for one request; its nonce is remembered until paid or expired. */
  async requirement(r: VendorRequest): Promise<PaymentRequirements> {
    const nonce = hexlify(randomBytes(32));
    const extra: StipendExtra = { pool: String(await this.pool.getAddress()), nonce, assetTransferMethod: 'stipend-spend', paymentFlow: 'upfront' };
    const req: PaymentRequirements = {
      scheme: X402_SCHEME, network: this.network, amount: r.amount.toString(), asset: r.asset, payTo: r.payTo,
      maxTimeoutSeconds: r.maxTimeoutSeconds ?? 300, extra,
    };
    this.issued.set(nonce, { req, resource: r.resource, issuedAt: await latestTimestamp(this.provider), consumed: false });
    return req;
  }

  /** The 402 response for a request: v2 puts the requirements in a header, v1 in the body. */
  async paymentRequired(r: VendorRequest, version: X402Version = 2): Promise<{ status: 402; headers: Record<string, string>; body: string }> {
    const req = await this.requirement(r);
    if (version === 1) {
      const v1: PaymentRequirementsV1 = {
        scheme: req.scheme, network: req.network, maxAmountRequired: req.amount, asset: req.asset, payTo: req.payTo, resource: r.resource.url,
        description: r.resource.description ?? '', mimeType: r.resource.mimeType, maxTimeoutSeconds: req.maxTimeoutSeconds, extra: req.extra,
      };
      const body: PaymentRequired = { x402Version: 1, error: `${X402_HEADERS.v1.payment} header is required`, accepts: [v1] };
      return { status: 402, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    }
    const pr: PaymentRequired = { x402Version: 2, error: `${X402_HEADERS.v2.payment} header is required`, resource: r.resource, accepts: [req] };
    return { status: 402, headers: { [X402_HEADERS.v2.required]: encodeHeader(pr), 'content-type': 'application/json' }, body: '{}' };
  }

  /** Reads the payment header of a request, either version. */
  static paymentFrom(headers: Headers | Record<string, string | string[] | undefined>): PaymentPayload | undefined {
    const get = (n: string) => (headers instanceof Headers ? headers.get(n) : first(headers[n.toLowerCase()] ?? headers[n]));
    const v = get(X402_HEADERS.v2.payment) ?? get(X402_HEADERS.v1.payment);
    if (!v) return undefined;
    try { return decodeHeader<PaymentPayload>(v); } catch { return undefined; }
  }

  /** Read-only: is this payment valid for a requirement this vendor issued and has not yet consumed? */
  async verify(payment: PaymentPayload): Promise<VerifyResponse & { amount?: bigint }> {
    const bad = (invalidReason: string): VerifyResponse => ({ isValid: false, invalidReason });
    if (payment.x402Version !== 1 && payment.x402Version !== 2) return bad('invalid_x402_version');
    const scheme = payment.x402Version === 2 ? payment.accepted?.scheme : payment.scheme;
    const network = payment.x402Version === 2 ? payment.accepted?.network : payment.network;
    if (scheme !== X402_SCHEME) return bad('unsupported_scheme');
    if (network !== this.network) return bad('invalid_network');
    const p = payment.payload;
    if (!p || typeof p.transaction !== 'string' || typeof p.nonce !== 'string' || typeof p.secret !== 'string') return bad('invalid_payload');
    const issued = this.issued.get(p.nonce);
    if (!issued) return bad('invalid_payment_requirements');
    if (issued.consumed || this.spentTx.has(p.transaction.toLowerCase())) return bad('invalid_transaction_state');
    if (payment.x402Version === 2 && payment.accepted && !sameRequirement(payment.accepted, issued.req)) return bad('invalid_payment_requirements');

    const receipt = await this.provider.getTransactionReceipt(p.transaction);
    if (!receipt || receipt.status !== 1) return bad('invalid_transaction_state');
    if ((await receipt.confirmations()) < (this.opts.confirmations ?? 1)) return { ...bad('settlement_pending') };
    const pool = String(await this.pool.getAddress()).toLowerCase();
    if (receipt.to?.toLowerCase() !== pool) return bad('invalid_payload');
    const tx = await this.provider.getTransaction(p.transaction);
    if (!tx) return bad('invalid_transaction_state');
    let parsed;
    try { parsed = this.pool.interface.parseTransaction({ data: tx.data }); } catch { parsed = null; }
    if (!parsed || parsed.name !== 'spend') return bad('invalid_payload');
    // the tag sits in the proof's ext data: only the payer, who knows the secret, can claim this payout
    let tag: string;
    try { tag = x402Tag(p.nonce, p.secret); } catch { return bad('invalid_payload'); }
    const ext = parsed.args[2] as unknown as { encryptedPayment: string };
    if (String(ext.encryptedPayment).toLowerCase() !== tag.toLowerCase()) return bad('invalid_payload');

    const want = BigInt(issued.req.amount);
    let paid = 0n;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== pool) continue;
      const ev = this.pool.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (ev?.name !== 'PublicPayout') continue;
      const [evAsset, recipient, amount] = ev.args as unknown as [string, string, bigint];
      if (evAsset.toLowerCase() === issued.req.asset.toLowerCase() && recipient.toLowerCase() === issued.req.payTo.toLowerCase()) paid += amount;
    }
    if (paid === 0n) return bad('invalid_exact_evm_payload_recipient_mismatch');
    if (paid < want) return bad('insufficient_funds');
    const block = await this.provider.getBlock(receipt.blockNumber);
    const at = BigInt(block!.timestamp);
    if (at > issued.issuedAt + BigInt(issued.req.maxTimeoutSeconds)) return bad('invalid_transaction_state');
    return { isValid: true, amount: paid, extra: { amount: paid.toString(), blockNumber: receipt.blockNumber } };
  }

  /**
   * Verify and consume: a payment settles one request once. Nothing is broadcast (the payer's relayer already
   * did); `transaction` is the payer's spend. `payer` is omitted because the vendor does not learn it.
   */
  async settle(payment: PaymentPayload): Promise<SettlementResponse> {
    const tx = payment.payload?.transaction ?? '';
    const v = await this.verify(payment);
    if (!v.isValid) return { success: false, errorReason: v.invalidReason, transaction: v.invalidReason === 'settlement_pending' ? tx : '', network: this.network };
    const issued = this.issued.get(payment.payload.nonce)!;
    // no await between this check and the write, so two concurrent settles cannot both pass
    if (issued.consumed || this.spentTx.has(tx.toLowerCase())) return { success: false, errorReason: 'invalid_transaction_state', transaction: '', network: this.network };
    issued.consumed = true;
    this.spentTx.add(tx.toLowerCase());
    return { success: true, transaction: tx, network: this.network, amount: v.amount!.toString() };
  }
}

function first(v: string | string[] | undefined): string | null {
  if (v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function sameRequirement(a: PaymentRequirements, b: PaymentRequirements): boolean {
  return a.scheme === b.scheme && a.network === b.network && a.amount === b.amount && a.asset.toLowerCase() === b.asset.toLowerCase()
    && a.payTo.toLowerCase() === b.payTo.toLowerCase() && (a.extra as StipendExtra | undefined)?.nonce === (b.extra as StipendExtra).nonce;
}
