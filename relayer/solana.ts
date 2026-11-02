// Solana relaying (stipend_pool). A wallet sends the payload it would stage itself (`borsh(Proof, Args,
// ext)`, base64) and the operation name. The relayer decodes it, checks the fee it pays (ext.relayer and
// ext.feeRecipient bound by extDataHash must be this relayer and its fee account), runs cheap checks that
// need no transaction (known root, nullifiers unspent, timestamp fresh), stages the payload in a buffer it
// owns, simulates the final transaction and only then sends it. If simulation fails the buffer is closed
// (its rent comes back; the staging transaction fees are the relayer's loss, which the rate limit bounds).
//
// Platform fee (docs/FLYWHEEL.md): the fee must be at least max(minFee[mint], feeBps * public amount / 10_000)
// and must go to the treasury's token account for the mint. The treasury is never an H081 launch wallet:
// the token's trading creator fees are the team's and are not part of this; only relay fees are.
// Capacity (capacity_stake): an operation above the free tier must name a staking operator, signed, whose
// 30-day relayed volume stays within free tier + shieldCap(staked).
import { sha256 } from '@noble/hashes/sha2';
import { ed25519 } from '@noble/curves/ed25519';
import {
  AddressLookupTableAccount, Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, TransactionInstruction,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, unpackAccount,
} from '@solana/spl-token';
import { type OpPlan, abandonPlan, planOperation, sendV0, simulateV0, stagePlan } from '../src/solana/alt.js';
import { fieldOf } from '../src/solana/field.js';
import { createVaultIx, delegateIx, grantIx, spendIx, transactIx, type SpendAccounts } from '../src/solana/ops.js';
import { nullifierPda, poolPda, vaultPda } from '../src/solana/pda.js';
import { BUFFER_MAX_LEN, LOCALNET_POOL_PROGRAM_ID, decodePool } from '../src/solana/program.js';
import {
  type DecodedOp, type FeeTerms, SOLANA_OPS, type SolanaOp, type SolanaRelayRequest, checkFee, decodeRelayPayload, fromB64, nullifiersOf,
} from '../src/solana/relay.js';
import { LOCALNET_CAPACITY_STAKE_PROGRAM_ID, readCapacity } from '../src/solana/token.js';
import { OP_CU_LIMIT } from '../src/solana/wallet.js';
import { DEFAULT_FEE_BPS, LAUNCH_WALLET_DENYLIST, type RelayerConfig, isDenyListed } from './config.js';
import { RelayError, badRequest } from './errors.js';
import { InFlight } from './ratelimit.js';

/** The pool accepts `now` up to 15 minutes old; staging takes time, so the relayer wants this much slack left. */
export const TIMESTAMP_SLACK = 120n;
const NOW_LOOKBACK = 900n;
const NOW_LOOKAHEAD = 60n;

export interface SolanaRelayerOptions {
  connection: Connection;
  payer: Keypair;
  programId?: PublicKey;
  /** minimum fee per mint (base58), base units */
  minFees: Map<string, bigint>;
  lookupTables?: AddressLookupTableAccount[];
  allowUnpaid?: boolean;
  /** refuse to relay when the relayer holds fewer lamports than this (default 0.05 SOL) */
  minLamports?: number;
  /** relays processed at once; more are refused with 503 (default 4) */
  maxInFlight?: number;
  /**
   * Owner of the fee token accounts: the platform treasury (RELAYER_SOLANA_TREASURY, wired by
   * solanaRelayerOptions). The proof's fee recipient must be the treasury's ATA for the fee mint. Required:
   * there is no fallback to the relayer's own hot wallet. Never an H081 launch wallet (refused).
   */
  treasury: PublicKey;
  /** platform fee, basis points of the public amount (default 20 = 0.20%); the per-mint minimum still applies */
  feeBps?: number;
  /** capacity_stake enforcement; absent = off */
  capacity?: CapacityOptions;
}

/** Required fee: max(min, bps * amount / 10_000), rounded down. */
export function requiredFee(min: bigint, bps: number, amount: bigint): bigint {
  const pct = (BigInt(bps) * amount) / 10_000n;
  return pct > min ? pct : min;
}

/**
 * The public leg of an operation: tokens leaving the pool's vault. A withdrawal's amount; for a spend the
 * recipient's public amount plus the lender's share (the pool pays both out of the vault). Else 0.
 */
export function publicAmountOf(d: DecodedOp): bigint {
  if (d.op === 'transact') return d.extAmount < 0n ? -d.extAmount : 0n;
  if (d.op === 'spend') return d.publicAmount + d.lenderAmount;
  return 0n;
}

/** Capacity is measured in 6-decimal (USDG) base units; only mints with this many decimals may count against it. */
export const CAPACITY_DECIMALS = 6;

/** SolanaRelayer options from the loaded configuration: treasury, fee rate and capacity_stake as configured. */
export function solanaRelayerOptions(
  s: NonNullable<RelayerConfig['solana']>,
  base: Pick<SolanaRelayerOptions, 'connection' | 'payer' | 'lookupTables' | 'allowUnpaid'>,
): SolanaRelayerOptions {
  const capacity = s.capacity && {
    freeTier: s.capacity.freeTier,
    assets: new Set(s.capacity.assets),
    lookup: capacityStakeLookup(base.connection, new PublicKey(s.capacity.mint), s.capacity.programId ? new PublicKey(s.capacity.programId) : undefined),
  };
  return {
    ...base, programId: s.programId ? new PublicKey(s.programId) : undefined, minFees: s.minFees,
    minLamports: s.minLamports, maxInFlight: s.maxInFlight, treasury: new PublicKey(s.treasury), feeBps: s.feeBps, capacity,
  };
}

/** 30 days, the period shieldCap is measured over. */
export const CAPACITY_WINDOW_SECS = 30 * 86400;

/** What an operator signs (ed25519) to put an operation on its capacity: a domain tag and sha256 of the payload. */
export function capacityMessage(payload: Uint8Array): Uint8Array {
  const tag = new TextEncoder().encode('h081-relay-capacity:v1:');
  const out = new Uint8Array(tag.length + 32);
  out.set(tag);
  out.set(sha256(payload), tag.length);
  return out;
}

export interface CapacityOptions {
  /** an operation whose public amount is at most this needs no operator (anonymous free tier); also added to every operator's allowance */
  freeTier: bigint;
  /** mints (base58) whose amounts count against capacity; each must have 6 decimals (shieldCap is in 6-decimal USDG base units; SolanaRelayer.init checks) */
  assets: Set<string>;
  /** the operator's shieldCap (base units per 30 days) from capacity_stake; injectable so tests need no validator */
  lookup: (operator: PublicKey) => Promise<bigint>;
  /** unix seconds (default: wall clock) */
  now?: () => number;
}

/** Reads shieldCap from capacity_stake for `mint` (the H081 mint) with the program's own curve (src/solana/token.ts). */
export function capacityStakeLookup(connection: Connection, mint: PublicKey, programId = LOCALNET_CAPACITY_STAKE_PROGRAM_ID) {
  return async (operator: PublicKey) => (await readCapacity(connection, programId, mint, operator)).shieldCap;
}

/** A capacity claim checked against the operator's limit, not yet counted. */
export interface CapacityTicket { operator: string; amount: bigint; limit: bigint }

/** Rolling 30-day relayed volume per operator, held in memory (a restart forgets it). */
export class CapacityGate {
  private used = new Map<string, Array<{ at: number; amount: bigint }>>();

  constructor(readonly opts: CapacityOptions) {}

  private now() { return this.opts.now ? this.opts.now() : Math.floor(Date.now() / 1000); }

  /** Volume `operator` relayed in the window (old entries dropped). */
  usage(operator: string): bigint {
    const from = this.now() - CAPACITY_WINDOW_SECS;
    const list = (this.used.get(operator) ?? []).filter((e) => e.at > from);
    this.used.set(operator, list);
    return list.reduce((s, e) => s + e.amount, 0n);
  }

  /**
   * Checks an operation moving `amount` of `mint`. Undefined when it needs no capacity (mint not counted,
   * nothing public, or within the anonymous free tier). Refuses an anonymous operation above the free tier
   * and an operator over its limit.
   */
  async check(mint: PublicKey | undefined, amount: bigint, operator: PublicKey | undefined): Promise<CapacityTicket | undefined> {
    if (!mint || amount === 0n || !this.opts.assets.has(mint.toBase58())) return undefined;
    if (!operator) {
      if (amount <= this.opts.freeTier) return undefined;
      throw new RelayError(403, 'capacity_required',
        `${amount} is above the free tier of ${this.opts.freeTier}; name an operator with H081 staked in capacity_stake (operator, operatorSig)`);
    }
    let cap: bigint;
    try {
      cap = await this.opts.lookup(operator);
    } catch (e) {
      throw new RelayError(503, 'capacity_unavailable', `capacity_stake not readable: ${e instanceof Error ? e.message : String(e)}`);
    }
    const t = { operator: operator.toBase58(), amount, limit: this.opts.freeTier + cap };
    this.assertRoom(t);
    return t;
  }

  private assertRoom(t: CapacityTicket) {
    const used = this.usage(t.operator);
    if (used + t.amount > t.limit) {
      throw new RelayError(403, 'over_capacity',
        `operator ${t.operator} has relayed ${used} of ${t.limit} in the last 30 days; ${t.amount} more is over capacity (stake more H081 in capacity_stake)`);
    }
  }

  /** Counts the ticket (re-checked, so concurrent relays cannot overshoot); returns a function that uncounts it. */
  reserve(t: CapacityTicket): () => void {
    this.assertRoom(t);
    const entry = { at: this.now(), amount: t.amount };
    const list = this.used.get(t.operator) ?? [];
    list.push(entry);
    this.used.set(t.operator, list);
    return () => {
      const l = this.used.get(t.operator);
      const i = l ? l.indexOf(entry) : -1;
      if (l && i >= 0) l.splice(i, 1);
    };
  }
}

/** The relay request body: the SDK request plus the optional capacity operator and its signature over capacityMessage(payload). */
export type SolanaRelayBody = Partial<SolanaRelayRequest> & { operator?: string; operatorSig?: string };

/** Result of the checks that need no pool state: decoded op, fee, mint, capacity claim. */
export interface CheckedTerms {
  op: SolanaOp;
  payload: Uint8Array;
  decoded: DecodedOp;
  fee: bigint;
  /** the fee mint, or the request mint */
  mint?: PublicKey;
  capacity?: CapacityTicket;
}

/** An operation checked and planned, not sent. */
export interface PreparedRelay {
  op: SolanaOp;
  decoded: DecodedOp;
  fee: bigint;
  mint?: PublicKey;
  plan: OpPlan;
  /** other final transactions to try, in order, when `plan.final` does not simulate (a pledged spend without the lender account) */
  fallbacks: TransactionInstruction[][];
  /** capacity to count when the relay is sent */
  capacity?: CapacityTicket;
}

const keyOrBad = (s: unknown, what: string): PublicKey => {
  if (typeof s !== 'string') throw badRequest('bad_request', `${what} must be a base58 public key`);
  try { return new PublicKey(s); } catch { throw badRequest('bad_request', `${what} is not a public key`); }
};

export class SolanaRelayer {
  readonly programId: PublicKey;
  readonly inFlight = new InFlight();
  private tokenPrograms = new Map<string, PublicKey>();
  private busy = 0;
  readonly capacity?: CapacityGate;

  constructor(readonly opts: SolanaRelayerOptions) {
    this.programId = opts.programId ?? LOCALNET_POOL_PROGRAM_ID;
    if (!opts.treasury) throw new Error('treasury is required: platform fees go to the treasury, never to the relayer hot wallet');
    const owner = opts.treasury;
    if (isDenyListed(owner)) throw new Error(`fee account owner ${owner.toBase58()} is an H081 launch wallet; platform fees never go to a launch wallet`);
    const bps = opts.feeBps ?? DEFAULT_FEE_BPS;
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error('feeBps must be an integer in 0..10000');
    if (opts.capacity) this.capacity = new CapacityGate(opts.capacity);
  }

  get connection(): Connection { return this.opts.connection; }
  get relayer(): PublicKey { return this.opts.payer.publicKey; }
  /** Owner of the fee accounts: the treasury. */
  get feeOwner(): PublicKey { return this.opts.treasury; }
  get feeBps(): number { return this.opts.feeBps ?? DEFAULT_FEE_BPS; }

  /**
   * Reads the token program of every fee mint (needed to name the treasury's fee accounts) and, with capacity
   * on, checks that every capacity mint has 6 decimals (amounts are not normalised across assets).
   */
  async init(): Promise<this> {
    for (const m of this.opts.minFees.keys()) await this.tokenProgramOf(new PublicKey(m));
    for (const m of this.capacity?.opts.assets ?? []) {
      const info = await this.connection.getAccountInfo(new PublicKey(m), 'confirmed');
      if (!info) throw new Error(`capacity asset ${m} not found`);
      if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) throw new Error(`capacity asset ${m} is not an SPL Token / Token-2022 mint`);
      const decimals = info.data.length > 44 ? info.data[44] : undefined; // Mint layout: decimals at byte 44
      if (decimals !== CAPACITY_DECIMALS) throw new Error(`capacity asset ${m} has ${decimals} decimals; capacity counts 6-decimal (USDG) base units only`);
    }
    return this;
  }

  /** Creates the treasury's fee ATAs that do not exist yet (sends transactions, paid by the relayer). */
  async ensureFeeAccounts(): Promise<string[]> {
    const created: string[] = [];
    for (const m of this.opts.minFees.keys()) {
      const mint = new PublicKey(m);
      const ata = this.feeAccount(mint);
      if (await this.connection.getAccountInfo(ata, 'confirmed')) continue;
      const tp = await this.tokenProgramOf(mint);
      await sendV0(this.connection, this.opts.payer, [createAssociatedTokenAccountIdempotentInstruction(this.relayer, ata, this.feeOwner, mint, tp)]);
      created.push(ata.toBase58());
    }
    return created;
  }

  async tokenProgramOf(mint: PublicKey): Promise<PublicKey> {
    const k = mint.toBase58();
    let tp = this.tokenPrograms.get(k);
    if (!tp) {
      const info = await this.connection.getAccountInfo(mint, 'confirmed');
      if (!info) throw badRequest('unknown_mint', `mint ${k} not found`);
      if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) throw badRequest('unknown_mint', `${k} is not an SPL Token / Token-2022 mint`);
      tp = info.owner;
      this.tokenPrograms.set(k, tp);
    }
    return tp;
  }

  /** The fee account for a configured mint: the treasury's associated token account. */
  feeAccount(mint: PublicKey): PublicKey {
    const tp = this.tokenPrograms.get(mint.toBase58());
    if (!tp) throw new Error(`fee mint ${mint.toBase58()} not initialised (SolanaRelayer.init)`);
    return getAssociatedTokenAddressSync(mint, this.feeOwner, true, tp);
  }

  terms(): FeeTerms {
    return { relayer: this.relayer, minFees: this.opts.minFees, feeAccount: (m) => this.feeAccount(m), allowUnpaid: this.opts.allowUnpaid };
  }

  info() {
    const mints = [...this.opts.minFees.keys()];
    const cap = this.capacity?.opts;
    return {
      programId: this.programId.toBase58(), relayer: this.relayer.toBase58(), allowUnpaid: !!this.opts.allowUnpaid,
      minFees: Object.fromEntries([...this.opts.minFees].map(([k, v]) => [k, v.toString()])),
      feeBps: this.feeBps, treasury: this.feeOwner.toBase58(),
      feeAccounts: Object.fromEntries(mints.map((m) => [m, this.feeAccount(new PublicKey(m)).toBase58()])),
      lookupTables: (this.opts.lookupTables ?? []).map((t) => t.key.toBase58()),
      ...(cap ? { capacity: { freeTier: cap.freeTier.toString(), assets: [...cap.assets] } } : {}),
    };
  }

  /**
   * Decodes the request and runs the checks that need no pool state: fee rules (relayer, treasury fee
   * account, per-mint minimum, fee bps of the public amount) and capacity. Reads only capacity_stake.
   */
  async checkTerms(body: unknown): Promise<CheckedTerms> {
    const req = (body ?? {}) as SolanaRelayBody;
    if (!SOLANA_OPS.includes(req.op as SolanaOp)) throw badRequest('bad_op', `op must be one of ${SOLANA_OPS.join(', ')}`);
    const op = req.op as SolanaOp;
    const payload = fromB64(req.payload as string);
    if (payload.length === 0 || payload.length > BUFFER_MAX_LEN) throw badRequest('bad_payload', `payload must be 1..${BUFFER_MAX_LEN} bytes`);
    const d = decodeRelayPayload(op, payload);
    const reqMint = req.mint === undefined ? undefined : keyOrBad(req.mint, 'mint');
    const fc = checkFee(d, this.terms(), reqMint);
    // checkFee already pins the recipient to the treasury ATA (whose owner the constructor deny-checks). This
    // also refuses, per relay, a launch wallet itself or any launch wallet's token account for the fee mint.
    if (fc.paid && (d.op === 'transact' || d.op === 'spend')) {
      const tp = fc.mint ? this.tokenPrograms.get(fc.mint.toBase58()) : undefined;
      const launch = isDenyListed(d.feeRecipient) || (!!fc.mint && !!tp && [...LAUNCH_WALLET_DENYLIST].some((w) =>
        getAssociatedTokenAddressSync(fc.mint!, new PublicKey(w), true, tp).equals(d.feeRecipient)));
      if (launch) throw badRequest('wrong_fee_account', 'the fee recipient is an H081 launch wallet account');
    }
    const amount = publicAmountOf(d);
    if (fc.paid && fc.mint) {
      const min = this.opts.minFees.get(fc.mint.toBase58()) ?? 0n;
      const need = requiredFee(min, this.feeBps, amount);
      if (fc.fee < need) {
        throw new RelayError(402, 'fee_too_low', `fee ${fc.fee} is below ${need} (max of the minimum ${min} and ${this.feeBps} bps of ${amount})`);
      }
    }
    let capacity: CapacityTicket | undefined;
    if (this.capacity) {
      let operator: PublicKey | undefined;
      if (req.operator !== undefined) {
        operator = keyOrBad(req.operator, 'operator');
        let sig: Uint8Array;
        try { sig = fromB64(req.operatorSig as string); } catch { throw badRequest('bad_operator_sig', 'operatorSig must be base64'); }
        let ok = false;
        try { ok = sig.length === 64 && ed25519.verify(sig, capacityMessage(payload), operator.toBytes()); } catch { ok = false; }
        if (!ok) throw badRequest('bad_operator_sig', 'operatorSig is not the operator\'s signature over capacityMessage(payload)');
      }
      const capMint = fc.mint ?? (d.op === 'spend' ? d.publicAsset : reqMint);
      capacity = await this.capacity.check(capMint, amount, operator);
    }
    return { op, payload, decoded: d, fee: fc.fee, mint: fc.mint ?? reqMint, capacity };
  }

  private async now(): Promise<bigint> {
    const info = await this.connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed');
    if (!info) throw new RelayError(503, 'rpc', 'clock sysvar not readable');
    return Buffer.from(info.data).readBigInt64LE(32);
  }

  /** Decodes, checks the fee and the chain state, and plans the transactions. Reads only. */
  async prepare(body: unknown): Promise<PreparedRelay> {
    const req = (body ?? {}) as SolanaRelayBody;
    const checked = await this.checkTerms(body);
    const { op, payload, decoded: d } = checked;
    const reqMint = req.mint === undefined ? undefined : keyOrBad(req.mint, 'mint');

    // chain-state checks that cost no transaction
    const poolInfo = await this.connection.getAccountInfo(poolPda(this.programId), 'confirmed');
    if (!poolInfo) throw new RelayError(503, 'pool_missing', 'the pool is not initialised on this cluster');
    if (!decodePool(poolInfo.data).roots.includes(d.root)) throw new RelayError(409, 'unknown_root', 'the proof is against a root the pool no longer knows; sync and prove again');
    const nfs = nullifiersOf(d);
    const nfAccounts = await this.connection.getMultipleAccountsInfo(nfs.map((n) => nullifierPda(this.programId, n)), 'confirmed');
    if (nfAccounts.some((a) => a !== null)) throw new RelayError(409, 'already_spent', 'a nullifier of this operation is already spent');
    if (d.op === 'spend' || d.op === 'delegate') {
      const now = await this.now();
      if (d.timestamp + NOW_LOOKBACK < now + TIMESTAMP_SLACK) throw new RelayError(409, 'stale_timestamp', 'the proof timestamp is too old to land; prove again');
      if (d.timestamp > now + NOW_LOOKAHEAD) throw new RelayError(409, 'stale_timestamp', 'the proof timestamp is in the future');
    }
    const lamports = await this.connection.getBalance(this.relayer, 'confirmed');
    if (lamports < (this.opts.minLamports ?? 50_000_000)) throw new RelayError(503, 'relayer_underfunded', 'the relayer is out of SOL');

    const payer = this.relayer;
    const pre: TransactionInstruction[] = [];
    const ensureVault = async (mint: PublicKey, tp: PublicKey) => {
      if (!(await this.connection.getAccountInfo(vaultPda(this.programId, mint), 'confirmed'))) pre.push(createVaultIx(this.programId, payer, mint, tp));
    };
    let ops: Array<(buffer: PublicKey) => TransactionInstruction>;
    let mint: PublicKey | undefined;

    if (d.op === 'transact') {
      const moves = d.extAmount !== 0n || d.fee !== 0n;
      let token: { mint: PublicKey; tokenProgram: PublicKey } | undefined;
      if (moves) {
        if (!reqMint) throw badRequest('mint_required', 'a transact that moves tokens needs the mint');
        mint = reqMint;
        token = { mint, tokenProgram: await this.tokenProgramOf(mint) };
        await ensureVault(mint, token.tokenProgram);
      }
      let recipientToken: PublicKey | undefined;
      if (d.extAmount < 0n) {
        recipientToken = d.recipient;
        if (!(await this.connection.getAccountInfo(recipientToken, 'confirmed'))) {
          if (req.recipientOwner === undefined) throw badRequest('recipient_account_missing', 'the withdrawal account does not exist; pass recipientOwner to have it created');
          const owner = keyOrBad(req.recipientOwner, 'recipientOwner');
          const ata = getAssociatedTokenAddressSync(token!.mint, owner, true, token!.tokenProgram);
          if (!ata.equals(recipientToken)) throw badRequest('recipient_mismatch', 'recipientOwner does not own the withdrawal account');
          pre.push(createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, token!.mint, token!.tokenProgram));
        }
      }
      const feeToken = d.fee > 0n ? d.feeRecipient : undefined;
      ops = [(buffer) => transactIx(this.programId, { payer, buffer, nullifiers: d.nullifiers, token, recipientToken, feeToken })];
    } else if (d.op === 'spend') {
      const accounts: Omit<SpendAccounts, 'buffer'> = { payer, nullifier: d.nullifier };
      if (d.publicAmount > 0n || d.lenderAmount > 0n) {
        mint = d.publicAsset;
        const tokenProgram = await this.tokenProgramOf(mint);
        accounts.token = { mint, tokenProgram };
        await ensureVault(mint, tokenProgram);
        if (d.publicAmount > 0n) {
          const ata = getAssociatedTokenAddressSync(mint, d.publicRecipient, true, tokenProgram);
          accounts.recipientToken = ata;
          if (!(await this.connection.getAccountInfo(ata, 'confirmed'))) {
            pre.push(createAssociatedTokenAccountIdempotentInstruction(payer, ata, d.publicRecipient, mint, tokenProgram));
          }
          if (d.fee > 0n) accounts.feeToken = d.feeRecipient;
        }
        if (d.lenderAmount > 0n) {
          accounts.escrow = { lenderAddr: d.lenderAddr, loanRef: d.loanRef };
          if (req.lenderToken !== undefined) accounts.lenderToken = await this.lenderAccount(keyOrBad(req.lenderToken, 'lenderToken'), mint, d.lenderAddr);
        }
      }
      ops = [(buffer) => spendIx(this.programId, { ...accounts, buffer })];
      // as SolanaWallet.submitSpend: a lender account that cannot take the share never blocks the spend
      if (accounts.lenderToken) ops.push((buffer) => spendIx(this.programId, { ...accounts, lenderToken: undefined, buffer }));
    } else if (d.op === 'grant') {
      ops = [(buffer) => grantIx(this.programId, payer, buffer, d.nullifiers)];
    } else {
      ops = [(buffer) => delegateIx(this.programId, payer, buffer, d.nullifier)];
    }

    let plan: OpPlan;
    try {
      plan = planOperation({ programId: this.programId, authority: payer, payload, op: ops[0], pre, lookupTables: this.opts.lookupTables, cuLimit: OP_CU_LIMIT });
    } catch (e) {
      throw badRequest('too_large', e instanceof Error ? e.message : String(e));
    }
    const fallbacks = ops.slice(1).map((mk) => [...plan.final.slice(0, -1), mk(plan.buffer)]);
    return { op, decoded: d, fee: checked.fee, mint, plan, fallbacks, capacity: checked.capacity };
  }

  /** A lender token account the spend may name: it must exist, hold `mint` and be owned by a key whose fieldOf is lenderAddr. Undefined otherwise (escrow). */
  private async lenderAccount(account: PublicKey, mint: PublicKey, lenderAddr: bigint): Promise<PublicKey | undefined> {
    const info = await this.connection.getAccountInfo(account, 'confirmed');
    if (!info) return undefined;
    try {
      const acc = unpackAccount(account, info, info.owner);
      if (acc.isFrozen || !acc.mint.equals(mint) || fieldOf(acc.owner) !== lenderAddr) return undefined;
      return account;
    } catch {
      return undefined;
    }
  }

  /** prepare, then stage, simulate and send. */
  async relay(body: unknown): Promise<{ signature: string; computeUnits: number; op: SolanaOp; fee: string }> {
    const max = this.opts.maxInFlight ?? 4;
    if (this.busy >= max) throw new RelayError(503, 'busy', 'the relayer is at capacity; retry shortly');
    this.busy++;
    try {
      const p = await this.prepare(body);
      const release = this.inFlight.claim(nullifiersOf(p.decoded));
      let uncount: (() => void) | undefined;
      try {
        if (p.capacity && this.capacity) uncount = this.capacity.reserve(p.capacity);
        return { ...(await this.execute(p)), op: p.op, fee: p.fee.toString() };
      } catch (e) {
        uncount?.();
        release();
        throw e;
      }
    } finally {
      this.busy--;
    }
  }

  private async execute(p: PreparedRelay): Promise<{ signature: string; computeUnits: number }> {
    const payer = this.opts.payer;
    const tables = this.opts.lookupTables ?? [];
    try {
      await stagePlan(this.connection, payer, p.plan);
    } catch (e) {
      await abandonPlan(this.connection, this.programId, payer, p.plan);
      throw new RelayError(502, 'staging_failed', e instanceof Error ? e.message : String(e));
    }
    let chosen: TransactionInstruction[] | undefined;
    let logs: string[] = [];
    for (const candidate of [p.plan.final, ...p.fallbacks]) {
      const sim = await simulateV0(this.connection, payer, candidate, tables);
      if (sim.err === null) { chosen = candidate; break; }
      if (logs.length === 0) logs = sim.logs;
    }
    if (!chosen) {
      await abandonPlan(this.connection, this.programId, payer, p.plan);
      throw new RelayError(422, 'simulation_failed', logs.slice(-6).join(' | ') || 'the operation does not simulate');
    }
    try {
      const sent = await sendV0(this.connection, payer, chosen, tables);
      return { signature: sent.signature, computeUnits: sent.computeUnits };
    } catch (e) {
      await abandonPlan(this.connection, this.programId, payer, p.plan);
      throw new RelayError(502, 'send_failed', e instanceof Error ? e.message : String(e));
    }
  }
}

