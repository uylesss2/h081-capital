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
import { ed25519 } from '@noble/curves/ed25519';
import {
  AddressLookupTableAccount, Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, TransactionInstruction,
} from '@solana/web3.js';
import {
  ACCOUNT_SIZE, ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAccountLen,
  getAccountTypeOfMintType, getAssociatedTokenAddressSync, getExtensionTypes, unpackAccount, unpackMint,
} from '@solana/spl-token';
import { type OpPlan, abandonPlan, planOperation, planTransactions, sendV0, simulateV0, stagePlan } from '../src/solana/alt.js';
import type { PriorityOptions } from '../src/solana/send.js';
import { fieldOf } from '../src/solana/field.js';
import { createVaultIx, delegateIx, grantIx, spendIx, transactIx, type SpendAccounts } from '../src/solana/ops.js';
import { nullifierPda, poolPda, vaultPda } from '../src/solana/pda.js';
import { BUFFER_MAX_LEN, LOCALNET_POOL_PROGRAM_ID, decodePool } from '../src/solana/program.js';
import {
  type DecodedOp, type FeeTerms, SOLANA_OPS, type SolanaOp, type SolanaRelayRequest, capacityMessage, checkFee, decodeRelayPayload, fromB64, nullifiersOf,
} from '../src/solana/relay.js';
import { LOCALNET_CAPACITY_STAKE_PROGRAM_ID, readCapacity } from '../src/solana/token.js';
import { OP_CU_LIMIT } from '../src/solana/wallet.js';
import { DEFAULT_CREATE_ACCOUNT_LAMPORTS, DEFAULT_FEE_BPS, DEFAULT_STAGING_LAMPORTS, LAUNCH_WALLET_DENYLIST, type RelayerConfig, isDenyListed } from './config.js';
import { RelayError, badRequest, toRelayError } from './errors.js';
import { InFlight } from './ratelimit.js';
import { ProofVerifier, type RelayProofVerifier } from './verify.js';

/**
 * The pool accepts `now` up to NOW_LOOKBACK old; staging takes time, so the relayer wants this much slack left.
 * 60 s covers the staging transactions with margin and leaves a browser two minutes between choosing `now` and
 * the relayer accepting the proof (with the old 15-minute look-back this was 120 s of slack).
 */
export const TIMESTAMP_SLACK = 60n;
/** stipend_pool state.rs NOW_LOOKBACK (3 minutes) and NOW_LOOKAHEAD: the window a proof's `now` must land in. */
export const NOW_LOOKBACK = 180n;
export const NOW_LOOKAHEAD = 60n;

/** Base fee of a one-signer transaction. */
export const LAMPORTS_PER_SIGNATURE = 5_000;
/** Rent-exempt balance of an account of `bytes`: (128 + bytes) * 3,480 lamports per byte-year * 2 years (mainnet's rent parameters). */
export const rentExempt = (bytes: number) => (128 + bytes) * 6_960;
/** Token-2022 account size assumed when the mint's extensions cannot be read (covers ImmutableOwner, TransferFeeAmount and TransferHookAccount). */
export const TOKEN_2022_ACCOUNT_BYTES_FALLBACK = 200;

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
  /** the paid priority lane (x402 relay-priority): its own in-flight count and higher priority-fee caps; absent = no lane */
  priority?: PriorityLaneOptions;
  /** the chain transport (stage, simulate, send, abandon); injectable so tests need no validator */
  io?: RelayIo;
  /**
   * Surcharge per account the relayer creates for an operation (a withdrawal's or payout's ATA, a vault), per
   * fee mint (base58) in base units of that mint. The rent of a created account belongs to the account's owner,
   * who can close it and keep it, so the relayer never pays it uncovered: a mint without a surcharge here means
   * the relayer creates nothing for it (400 account_creation_disabled), and with one the fee must be at least
   * the relay fee plus the surcharge per created account (400 fee_too_low).
   */
  createAccountFees?: Map<string, bigint>;
  /** lamports one surcharge is deemed to cover (default DEFAULT_CREATE_ACCOUNT_LAMPORTS) */
  createAccountLamports?: number;
  /** lamports the relay fee is deemed to cover for staging, per relay (default DEFAULT_STAGING_LAMPORTS) */
  stagingLamports?: number;
  /**
   * Verifies every proof off-chain before anything is staged (ProofVerifier over the program's verifying keys).
   * Without one the relayer relays nothing (503 proof_verifier_unavailable): a proof that fails on chain would
   * still have cost the staging transactions.
   */
  verifier?: RelayProofVerifier;
  /** operational log line (a buffer whose rent could not be recovered, ...); default console.error */
  log?: (line: string) => void;
}

export interface PriorityLaneOptions { maxInFlight: number; maxLamports: number; priceCeil: number }

export interface RelayIo {
  stagePlan: typeof stagePlan;
  simulateV0: typeof simulateV0;
  sendV0: typeof sendV0;
  abandonPlan: typeof abandonPlan;
}

export interface RelayOptions { lane?: 'priority' }

export interface RelayResult {
  signature: string; computeUnits: number; op: SolanaOp; fee: string;
  lane?: 'priority'; priorityFee?: { maxLamports: number; priceCeil: number };
}

/** What `inspect` reports: the relay checks as findings instead of a thrown refusal. */
export interface Inspection {
  ok: boolean;
  op: SolanaOp;
  fee: {
    paid: string; required: string | null; min: string | null; bps: number; publicAmount: string; mint: string | null; feeAccount: string | null;
    /** surcharge per account the relayer would create, for the fee mint (null: none configured, or no fee mint) */
    createAccountFee: string | null;
  };
  /** whether the proof verifies off-chain (null: the terms did not pass, or this relayer cannot verify) */
  proof: { verified: boolean | null };
  capacity: { needed: boolean; operator: string | null; used: string | null; limit: string | null; ok: boolean } | null;
  chain: { rootKnown: boolean; nullifiersUnspent: boolean[]; timestampFresh: boolean | null };
  accounts: { recipientExists: boolean | null; vaultExists: boolean | null; lenderTokenUsable: boolean | null } | null;
  plan: { payloadBytes: number; setupTxs: number; writeTxs: number; createdAccounts: number; lamports: { estimate: number; covered: number } } | null;
  refusals: Array<{ status: number; code: string; message: string }>;
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
  base: Pick<SolanaRelayerOptions, 'connection' | 'payer' | 'lookupTables' | 'allowUnpaid' | 'verifier' | 'log'>,
): SolanaRelayerOptions {
  const capacity = s.capacity && {
    freeTier: s.capacity.freeTier,
    assets: new Set(s.capacity.assets),
    lookup: capacityStakeLookup(base.connection, new PublicKey(s.capacity.mint), s.capacity.programId ? new PublicKey(s.capacity.programId) : undefined),
  };
  return {
    ...base, programId: s.programId ? new PublicKey(s.programId) : undefined, minFees: s.minFees,
    minLamports: s.minLamports, maxInFlight: s.maxInFlight, treasury: new PublicKey(s.treasury), feeBps: s.feeBps, capacity,
    createAccountFees: s.createAccountFees, createAccountLamports: s.createAccountLamports, stagingLamports: s.stagingLamports,
  };
}

/** The proof verifier the configuration names (reads and pins the verifying keys; throws when any is missing or does not match its pin). */
export function proofVerifierFromConfig(s: NonNullable<RelayerConfig['solana']>): ProofVerifier {
  return new ProofVerifier({ circuitsDir: s.circuitsDir, vkeySha256: s.vkeySha256 });
}

/** 30 days, the period shieldCap is measured over. */
export const CAPACITY_WINDOW_SECS = 30 * 86400;

/** What an operator signs to put an operation on its capacity: defined in src/solana/relay.ts so the SDK signs the same bytes. */
export { capacityMessage };

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

/** An account the final transaction creates at the relayer's expense. */
export interface AccountCreation { account: PublicKey; what: string; lamports: number }

/** What the hot wallet is estimated to spend on a relay, and what the fee policy covers. */
export interface LamportBudget {
  /** rent of created accounts + base fee of every transaction (+ the priority lane's cap per transaction) */
  estimate: number;
  /** stagingLamports + createAccountLamports per created account (+ the priority lane's cap per transaction) */
  covered: number;
  createdAccounts: number;
  transactions: number;
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
  lamports: LamportBudget;
}

const keyOrBad = (s: unknown, what: string): PublicKey => {
  if (typeof s !== 'string') throw badRequest('bad_request', `${what} must be a base58 public key`);
  try { return new PublicKey(s); } catch { throw badRequest('bad_request', `${what} is not a public key`); }
};

export class SolanaRelayer {
  readonly programId: PublicKey;
  readonly inFlight = new InFlight();
  private tokenPrograms = new Map<string, PublicKey>();
  /** bytes of a token account of each known mint (legacy: 165; Token-2022: the mint's required account extensions) */
  private accountBytes = new Map<string, number>();
  private busy = 0;
  private busyPriority = 0;
  readonly capacity?: CapacityGate;
  private readonly io: RelayIo;
  private readonly log: (line: string) => void;

  constructor(readonly opts: SolanaRelayerOptions) {
    this.programId = opts.programId ?? LOCALNET_POOL_PROGRAM_ID;
    if (!opts.treasury) throw new Error('treasury is required: platform fees go to the treasury, never to the relayer hot wallet');
    const owner = opts.treasury;
    if (isDenyListed(owner)) throw new Error(`fee account owner ${owner.toBase58()} is an H081 launch wallet; platform fees never go to a launch wallet`);
    const bps = opts.feeBps ?? DEFAULT_FEE_BPS;
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error('feeBps must be an integer in 0..10000');
    for (const m of opts.createAccountFees?.keys() ?? []) {
      if (!opts.minFees.has(m)) throw new Error(`createAccountFees: ${m} is not a fee mint`);
    }
    if (opts.capacity) this.capacity = new CapacityGate(opts.capacity);
    this.io = opts.io ?? { stagePlan, simulateV0, sendV0, abandonPlan };
    this.log = opts.log ?? ((line) => console.error(line));
  }

  get createAccountLamports(): number { return this.opts.createAccountLamports ?? DEFAULT_CREATE_ACCOUNT_LAMPORTS; }
  get stagingLamports(): number { return this.opts.stagingLamports ?? DEFAULT_STAGING_LAMPORTS; }

  /** The priority lane's fee caps, when the lane exists. */
  get priorityLane(): PriorityLaneOptions | undefined { return this.opts.priority; }

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
      this.accountBytes.set(k, tokenAccountBytes(mint, info, tp));
    }
    return tp;
  }

  /** Rent the relayer would pay for a token account of `mint` (an ATA, or the pool's vault). */
  private rentOfTokenAccount(mint: PublicKey): number {
    return rentExempt(this.accountBytes.get(mint.toBase58()) ?? TOKEN_2022_ACCOUNT_BYTES_FALLBACK);
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
      // what creating an account for an operation costs on top of the fee (a mint missing here: the relayer creates none for it)
      createAccountFees: Object.fromEntries([...(this.opts.createAccountFees ?? [])].map(([k, v]) => [k, v.toString()])),
      createAccountLamports: this.createAccountLamports, stagingLamports: this.stagingLamports,
      proofVerification: this.opts.verifier instanceof ProofVerifier ? { vkeySha256: this.opts.verifier.vkeySha256 } : { vkeySha256: null },
    };
  }

  /**
   * Verifies the payload's Groth16 proof off-chain against the program's public inputs, before any read of
   * the chain or any staging. 400 invalid_proof when it does not verify; 503 when this relayer cannot verify.
   */
  private async requireValidProof(checked: CheckedTerms): Promise<void> {
    const v = this.opts.verifier;
    if (!v) throw new RelayError(503, 'proof_verifier_unavailable', 'this relayer has no verifying keys loaded and relays nothing without them');
    const d = checked.decoded;
    if (d.op === 'transact' && (d.extAmount !== 0n || d.fee !== 0n) && !checked.mint) throw badRequest('mint_required', 'a transact that moves tokens needs the mint');
    if (!(await v.verify(checked.payload, d, checked.mint))) {
      throw badRequest('invalid_proof', `the ${d.op} proof does not verify against the program's public inputs; nothing was staged`);
    }
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

  /** Chain-state facts about an operation that cost no transaction (reads only). */
  private async chainFacts(d: DecodedOp): Promise<{ poolExists: boolean; rootKnown: boolean; nullifiersUnspent: boolean[]; timestampFresh: boolean | null; lamports: number }> {
    const poolInfo = await this.connection.getAccountInfo(poolPda(this.programId), 'confirmed');
    const rootKnown = !!poolInfo && decodePool(poolInfo.data).roots.includes(d.root);
    const nfs = nullifiersOf(d);
    const nfAccounts = await this.connection.getMultipleAccountsInfo(nfs.map((n) => nullifierPda(this.programId, n)), 'confirmed');
    const nullifiersUnspent = nfAccounts.map((a) => a === null);
    let timestampFresh: boolean | null = null;
    if (d.op === 'spend' || d.op === 'delegate') {
      const now = await this.now();
      timestampFresh = !(d.timestamp + NOW_LOOKBACK < now + TIMESTAMP_SLACK) && !(d.timestamp > now + NOW_LOOKAHEAD);
    }
    const lamports = await this.connection.getBalance(this.relayer, 'confirmed');
    return { poolExists: !!poolInfo, rootKnown, nullifiersUnspent, timestampFresh, lamports };
  }

  /** The refusals the chain facts imply, in the order `prepare` raises them. */
  private chainRefusals(f: Awaited<ReturnType<SolanaRelayer['chainFacts']>>): RelayError[] {
    const out: RelayError[] = [];
    if (!f.poolExists) out.push(new RelayError(503, 'pool_missing', 'the pool is not initialised on this cluster'));
    else if (!f.rootKnown) out.push(new RelayError(409, 'unknown_root', 'the proof is against a root the pool no longer knows; sync and prove again'));
    if (f.nullifiersUnspent.some((u) => !u)) out.push(new RelayError(409, 'already_spent', 'a nullifier of this operation is already spent'));
    if (f.timestampFresh === false) out.push(new RelayError(409, 'stale_timestamp', 'the proof timestamp is too old to land (or in the future); prove again'));
    if (f.lamports < (this.opts.minLamports ?? 50_000_000)) out.push(new RelayError(503, 'relayer_underfunded', 'the relayer is out of SOL'));
    return out;
  }

  /** Account facts `planFor` gathers while it decides which accounts the final transaction creates. */
  private emptyAccounts() {
    return { recipientExists: null as boolean | null, vaultExists: null as boolean | null, lenderTokenUsable: null as boolean | null };
  }

  /**
   * The fee an operation must pay when the relayer creates `creations` for it: the relay fee plus the
   * surcharge per created account, in the fee mint. Refuses (400) an operation that pays no fee, a fee mint
   * without a surcharge, and a fee below the total. Nothing when no account is created.
   */
  private creationFeeRefusal(checked: CheckedTerms, creations: AccountCreation[]): RelayError | undefined {
    if (creations.length === 0) return undefined;
    const names = creations.map((c) => `${c.what} ${c.account.toBase58()}`).join(', ');
    const n = creations.length;
    const mint = checked.mint;
    if (!mint || checked.fee === 0n) {
      return new RelayError(400, 'account_creation_disabled', `${names} ${n === 1 ? 'does' : 'do'} not exist and this operation pays no fee; the relayer creates no account for free`);
    }
    const surcharge = this.opts.createAccountFees?.get(mint.toBase58());
    if (surcharge === undefined) {
      return new RelayError(400, 'account_creation_disabled',
        `${names} ${n === 1 ? 'does' : 'do'} not exist and this relayer does not create accounts paid in ${mint.toBase58()} (no create-account surcharge for it); create ${n === 1 ? 'it' : 'them'} first`);
    }
    const min = this.opts.minFees.get(mint.toBase58()) ?? 0n;
    const base = requiredFee(min, this.feeBps, publicAmountOf(checked.decoded));
    const need = base + surcharge * BigInt(n);
    if (checked.fee < need) {
      return new RelayError(400, 'fee_too_low',
        `fee ${checked.fee} is below ${need}: creating ${names} adds a surcharge of ${surcharge} per account (${n}) on top of the ${base} relay fee`);
    }
    return undefined;
  }

  /**
   * What the hot wallet is estimated to spend on a plan against what the fee policy covers, and the refusal
   * (400 lamport_budget_exceeded) when it would cost more: the surcharges and the relay fee are priced for
   * what they cover, and anything beyond that is the relayer's uncovered loss.
   */
  private lamportBudget(plan: OpPlan, creations: AccountCreation[], lane?: 'priority'): { budget: LamportBudget; refusal?: RelayError } {
    const transactions = planTransactions(plan);
    const priorityPerTx = lane === 'priority' ? this.opts.priority?.maxLamports ?? 0 : 0;
    const rent = creations.reduce((s, c) => s + c.lamports, 0);
    const estimate = rent + transactions * (LAMPORTS_PER_SIGNATURE + priorityPerTx);
    const covered = this.stagingLamports + creations.length * this.createAccountLamports + transactions * priorityPerTx;
    const budget = { estimate, covered, createdAccounts: creations.length, transactions };
    const refusal = estimate > covered
      ? new RelayError(400, 'lamport_budget_exceeded',
        `this relay would cost the relayer about ${estimate} lamports (${rent} of rent for ${creations.length} account(s), ${transactions} transactions), above the ${covered} its fee policy covers`)
      : undefined;
    return { budget, refusal };
  }

  /**
   * The transactions of an operation (reads the accounts it names). Throws the relay API's 400s when it
   * cannot plan; a plan that is refused on price (created accounts without their surcharge, lamports over
   * budget) is returned with its `refusal`, so a preflight can report the accounts and the plan with it.
   */
  private async planFor(req: SolanaRelayBody, checked: CheckedTerms, lane?: 'priority'):
  Promise<Pick<PreparedRelay, 'mint' | 'plan' | 'fallbacks' | 'lamports'> & { accounts: ReturnType<SolanaRelayer['emptyAccounts']>; creations: AccountCreation[]; refusal?: RelayError }> {
    const { payload, decoded: d } = checked;
    const reqMint = req.mint === undefined ? undefined : keyOrBad(req.mint, 'mint');
    const accounts = this.emptyAccounts();
    const payer = this.relayer;
    const pre: TransactionInstruction[] = [];
    // every instruction in `pre` creates an account the relayer pays rent for; the fee must cover it (requireCreationFee)
    const creations: AccountCreation[] = [];
    const ensureVault = async (mint: PublicKey, tp: PublicKey) => {
      const vault = vaultPda(this.programId, mint);
      accounts.vaultExists = !!(await this.connection.getAccountInfo(vault, 'confirmed'));
      if (!accounts.vaultExists) {
        pre.push(createVaultIx(this.programId, payer, mint, tp));
        creations.push({ account: vault, what: 'vault', lamports: this.rentOfTokenAccount(mint) });
      }
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
        accounts.recipientExists = !!(await this.connection.getAccountInfo(recipientToken, 'confirmed'));
        if (!accounts.recipientExists) {
          if (req.recipientOwner === undefined) throw badRequest('recipient_account_missing', 'the withdrawal account does not exist; pass recipientOwner to have it created');
          const owner = keyOrBad(req.recipientOwner, 'recipientOwner');
          const ata = getAssociatedTokenAddressSync(token!.mint, owner, true, token!.tokenProgram);
          if (!ata.equals(recipientToken)) throw badRequest('recipient_mismatch', 'recipientOwner does not own the withdrawal account');
          pre.push(createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, token!.mint, token!.tokenProgram));
          creations.push({ account: ata, what: 'withdrawal account', lamports: this.rentOfTokenAccount(token!.mint) });
        }
      }
      const feeToken = d.fee > 0n ? d.feeRecipient : undefined;
      ops = [(buffer) => transactIx(this.programId, { payer, buffer, nullifiers: d.nullifiers, token, recipientToken, feeToken })];
    } else if (d.op === 'spend') {
      const spendAccounts: Omit<SpendAccounts, 'buffer'> = { payer, nullifier: d.nullifier };
      if (d.publicAmount > 0n || d.lenderAmount > 0n) {
        mint = d.publicAsset;
        const tokenProgram = await this.tokenProgramOf(mint);
        spendAccounts.token = { mint, tokenProgram };
        await ensureVault(mint, tokenProgram);
        if (d.publicAmount > 0n) {
          const ata = getAssociatedTokenAddressSync(mint, d.publicRecipient, true, tokenProgram);
          spendAccounts.recipientToken = ata;
          accounts.recipientExists = !!(await this.connection.getAccountInfo(ata, 'confirmed'));
          if (!accounts.recipientExists) {
            pre.push(createAssociatedTokenAccountIdempotentInstruction(payer, ata, d.publicRecipient, mint, tokenProgram));
            creations.push({ account: ata, what: 'payout account', lamports: this.rentOfTokenAccount(mint) });
          }
          if (d.fee > 0n) spendAccounts.feeToken = d.feeRecipient;
        }
        if (d.lenderAmount > 0n) {
          spendAccounts.escrow = { lenderAddr: d.lenderAddr, loanRef: d.loanRef };
          if (req.lenderToken !== undefined) {
            spendAccounts.lenderToken = await this.lenderAccount(keyOrBad(req.lenderToken, 'lenderToken'), mint, d.lenderAddr);
            accounts.lenderTokenUsable = !!spendAccounts.lenderToken;
          }
        }
      }
      ops = [(buffer) => spendIx(this.programId, { ...spendAccounts, buffer })];
      // as SolanaWallet.submitSpend: a lender account that cannot take the share never blocks the spend
      if (spendAccounts.lenderToken) ops.push((buffer) => spendIx(this.programId, { ...spendAccounts, lenderToken: undefined, buffer }));
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
    const { budget, refusal: overBudget } = this.lamportBudget(plan, creations, lane);
    const fallbacks = ops.slice(1).map((mk) => [...plan.final.slice(0, -1), mk(plan.buffer)]);
    return { mint, plan, fallbacks, accounts, creations, lamports: budget, refusal: this.creationFeeRefusal(checked, creations) ?? overBudget };
  }

  /**
   * Decodes, checks the fee, verifies the proof, checks the chain state, and plans the transactions (with the
   * accounts they create priced into the fee and the lamports they cost within budget). Reads only.
   */
  async prepare(body: unknown, opts: RelayOptions = {}): Promise<PreparedRelay> {
    const req = (body ?? {}) as SolanaRelayBody;
    const checked = await this.checkTerms(body);
    await this.requireValidProof(checked);
    const refusal = this.chainRefusals(await this.chainFacts(checked.decoded))[0];
    if (refusal) throw refusal;
    const planned = await this.planFor(req, checked, opts.lane);
    if (planned.refusal) throw planned.refusal;
    return {
      op: checked.op, decoded: checked.decoded, fee: checked.fee, mint: planned.mint, plan: planned.plan, fallbacks: planned.fallbacks,
      capacity: checked.capacity, lamports: planned.lamports,
    };
  }

  /**
   * The relay checks as a report instead of a refusal: would `prepare` accept this request, and why not.
   * A payload that does not decode (bad op, bad base64, bad extDataHash) still throws the relay API's 400.
   * Reads only; nothing is staged or reserved.
   */
  async inspect(body: unknown): Promise<Inspection> {
    const req = (body ?? {}) as SolanaRelayBody;
    if (!SOLANA_OPS.includes(req.op as SolanaOp)) throw badRequest('bad_op', `op must be one of ${SOLANA_OPS.join(', ')}`);
    const op = req.op as SolanaOp;
    const payload = fromB64(req.payload as string);
    if (payload.length === 0 || payload.length > BUFFER_MAX_LEN) throw badRequest('bad_payload', `payload must be 1..${BUFFER_MAX_LEN} bytes`);
    const d = decodeRelayPayload(op, payload);
    const refusals: RelayError[] = [];
    let checked: CheckedTerms | undefined;
    try {
      checked = await this.checkTerms(body);
    } catch (e) {
      refusals.push(toRelayError(e));
    }
    // fee facts, whether or not the terms passed
    const reqMint = typeof req.mint === 'string' ? (() => { try { return new PublicKey(req.mint as string); } catch { return undefined; } })() : undefined;
    const feeMint = d.op === 'spend' ? (d.publicAsset.equals(PublicKey.default) ? undefined : d.publicAsset) : d.op === 'transact' ? reqMint : undefined;
    const amount = publicAmountOf(d);
    const min = feeMint ? this.opts.minFees.get(feeMint.toBase58()) : undefined;
    const paid = d.op === 'transact' || d.op === 'spend' ? d.fee : 0n;
    const feeAccount = feeMint && this.tokenPrograms.has(feeMint.toBase58()) ? this.feeAccount(feeMint).toBase58() : null;
    const surcharge = feeMint ? this.opts.createAccountFees?.get(feeMint.toBase58()) : undefined;
    const fee: Inspection['fee'] = {
      paid: paid.toString(), required: min === undefined ? null : requiredFee(min, this.feeBps, amount).toString(), min: min === undefined ? null : min.toString(),
      bps: this.feeBps, publicAmount: amount.toString(), mint: feeMint?.toBase58() ?? null, feeAccount, createAccountFee: surcharge?.toString() ?? null,
    };
    // the proof, as prepare checks it right after the terms (nothing is staged either way)
    const proof: Inspection['proof'] = { verified: null };
    if (checked) {
      try {
        await this.requireValidProof(checked);
        proof.verified = true;
      } catch (e) {
        const r = toRelayError(e);
        if (r.code === 'invalid_proof') proof.verified = false;
        refusals.push(r);
      }
    }
    let capacity: Inspection['capacity'] = null;
    if (this.capacity) {
      const t = checked?.capacity;
      const capRefusal = refusals.find((r) => r.code === 'capacity_required' || r.code === 'over_capacity');
      if (t) capacity = { needed: true, operator: t.operator, used: this.capacity.usage(t.operator).toString(), limit: t.limit.toString(), ok: true };
      else if (capRefusal) capacity = { needed: true, operator: typeof req.operator === 'string' ? req.operator : null, used: null, limit: null, ok: false };
      else if (checked) capacity = { needed: false, operator: null, used: null, limit: null, ok: true };
    }
    const facts = await this.chainFacts(d);
    refusals.push(...this.chainRefusals(facts));
    let accounts: Inspection['accounts'] = null;
    let plan: Inspection['plan'] = null;
    if (checked) {
      try {
        const planned = await this.planFor(req, checked);
        accounts = planned.accounts;
        plan = {
          payloadBytes: payload.length, setupTxs: planned.plan.setup.length, writeTxs: planned.plan.writes.length,
          createdAccounts: planned.lamports.createdAccounts, lamports: { estimate: planned.lamports.estimate, covered: planned.lamports.covered },
        };
        if (planned.refusal) refusals.push(planned.refusal);
      } catch (e) {
        refusals.push(toRelayError(e));
      }
    }
    return {
      ok: refusals.length === 0, op, fee, proof, capacity,
      chain: { rootKnown: facts.rootKnown, nullifiersUnspent: facts.nullifiersUnspent, timestampFresh: facts.timestampFresh },
      accounts, plan, refusals: refusals.map((r) => ({ status: r.status, code: r.code, message: r.message })),
    };
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

  /**
   * Takes a slot in a lane (the free lane, or the paid priority lane with its own count) or throws 503 busy.
   * Returns the function that gives the slot back.
   */
  acquire(lane?: 'priority'): () => void {
    if (lane === 'priority') {
      const p = this.opts.priority;
      if (!p) throw new RelayError(503, 'lane_disabled', 'this relayer has no priority lane');
      if (this.busyPriority >= p.maxInFlight) throw new RelayError(503, 'busy', 'the priority lane is at capacity; retry shortly');
      this.busyPriority++;
      return () => { this.busyPriority--; };
    }
    const max = this.opts.maxInFlight ?? 4;
    if (this.busy >= max) throw new RelayError(503, 'busy', 'the relayer is at capacity; retry shortly');
    this.busy++;
    return () => { this.busy--; };
  }

  /** prepare, then stage, simulate and send. */
  async relay(body: unknown, opts: RelayOptions = {}): Promise<RelayResult> {
    const release = this.acquire(opts.lane);
    try {
      return await this.submit(await this.prepare(body, opts), opts);
    } finally {
      release();
    }
  }

  /**
   * The second half of `relay`: reserves the nullifiers and capacity of a prepared operation and sends it.
   * The caller holds a lane slot (`acquire`). The x402 priority lane settles the payment between `prepare`
   * and `submit`.
   */
  async submit(p: PreparedRelay, opts: RelayOptions = {}): Promise<RelayResult> {
    const release = this.inFlight.claim(nullifiersOf(p.decoded));
    let uncount: (() => void) | undefined;
    try {
      if (p.capacity && this.capacity) uncount = this.capacity.reserve(p.capacity);
      const lane = opts.lane === 'priority' ? this.opts.priority : undefined;
      const priority: PriorityOptions | undefined = lane && { maxLamports: lane.maxLamports, priceCeil: lane.priceCeil };
      const sent = await this.execute(p, priority);
      return {
        ...sent, op: p.op, fee: p.fee.toString(),
        ...(lane ? { lane: 'priority' as const, priorityFee: { maxLamports: lane.maxLamports, priceCeil: lane.priceCeil } } : {}),
      };
    } catch (e) {
      uncount?.();
      release();
      throw e;
    }
  }

  private async execute(p: PreparedRelay, priority?: PriorityOptions): Promise<{ signature: string; computeUnits: number }> {
    const payer = this.opts.payer;
    const tables = this.opts.lookupTables ?? [];
    const io = this.io;
    try {
      await io.stagePlan(this.connection, payer, p.plan, priority);
    } catch (e) {
      await this.abandon(p, 'staging_failed');
      throw new RelayError(502, 'staging_failed', e instanceof Error ? e.message : String(e));
    }
    let chosen: TransactionInstruction[] | undefined;
    let logs: string[] = [];
    for (const candidate of [p.plan.final, ...p.fallbacks]) {
      const sim = await io.simulateV0(this.connection, payer, candidate, tables);
      if (sim.err === null) { chosen = candidate; break; }
      if (logs.length === 0) logs = sim.logs;
    }
    if (!chosen) {
      await this.abandon(p, 'simulation_failed');
      throw new RelayError(422, 'simulation_failed', logs.slice(-6).join(' | ') || 'the operation does not simulate');
    }
    try {
      const sent = await io.sendV0(this.connection, payer, chosen, tables, [], priority);
      return { signature: sent.signature, computeUnits: sent.computeUnits };
    } catch (e) {
      await this.abandon(p, 'send_failed');
      throw new RelayError(502, 'send_failed', e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Closes the staged buffer of a relay that failed (its rent comes back to the hot wallet). The transport
   * retries the close; a buffer that still holds its rent is logged with what is needed to close it by hand
   * (buffer_close by the hot wallet with the seed), never silently forgotten.
   */
  private async abandon(p: PreparedRelay, why: string): Promise<void> {
    const where = `buffer ${p.plan.buffer.toBase58()} (seed ${p.plan.seed}, ${p.plan.lookupTables.length} tables) after ${why}`;
    try {
      const r = await this.io.abandonPlan(this.connection, this.programId, this.opts.payer, p.plan);
      if (!r.closed) this.log(`solana: ${where}: not closed after ${r.attempts} attempts (${r.error ?? 'unknown error'}); its rent stays locked until buffer_close succeeds`);
    } catch (e) {
      this.log(`solana: ${where}: close failed: ${e instanceof Error ? e.message : String(e)}; its rent stays locked until buffer_close succeeds`);
    }
  }
}

/**
 * Bytes of a token account of `mint`: 165 for SPL Token; for Token-2022 the base account plus ImmutableOwner
 * (every ATA has it) and the account extensions the mint's own extensions require (transfer fee, transfer
 * hook, ...). Falls back to a conservative size when the mint data does not parse.
 */
export function tokenAccountBytes(mint: PublicKey, info: { data: Uint8Array; owner: PublicKey }, tokenProgram: PublicKey): number {
  if (!tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) return ACCOUNT_SIZE;
  try {
    const m = unpackMint(mint, { ...info, data: Buffer.from(info.data), executable: false, lamports: 0 }, tokenProgram);
    const fromMint = getExtensionTypes(m.tlvData).map(getAccountTypeOfMintType).filter((t) => t !== ExtensionType.Uninitialized);
    return getAccountLen([...new Set([ExtensionType.ImmutableOwner, ...fromMint])]);
  } catch {
    return TOKEN_2022_ACCOUNT_BYTES_FALLBACK;
  }
}

