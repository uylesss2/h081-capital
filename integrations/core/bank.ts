// H081Bank: one agent's view of the bank, over the real SDK (src/solana/*) against the deployed programs.
// Everything the MCP server and the Agent Kit plugin do goes through here, so both behave the same:
//   - one Solana keypair signs (buffer staging takes several transactions per operation), holds the public
//     USDG/SOL/H081, and derives the shielded account (keys.ts);
//   - deposits are checked against the program's caps and the wallet's balances before a proof is made;
//   - withdrawals go through the relayer (fee to the treasury's USDG account, checked here before anything is
//     proven); when the relayer is configured but unavailable the withdrawal is refused, never silently sent
//     by the agent key (that would link the wallet to the recipient on chain); `direct: true` or an empty
//     H081_RELAYER_URL is the only way the signer sends. Above the relayer's anonymous free tier the agent
//     wallet is named as capacity operator (H081 staked in capacity_stake);
//   - payments from an allowance (h081_pay) follow the same relayer rule for a public payout and refuse, before
//     any proof, a payment the allowance's caps or the operator ceiling (H081_MAX_PAY) would not allow; a private
//     payment to an "h081-address:" code is sent by the agent key (there is no public leg to pay a relayer from);
//   - allowances (h081_allowance_grant / _delegate / _reclaim): budgets from the shielded balance to a sub-account or
//     another agent's "h081-address:" code, children carved from a held allowance that can never be looser than
//     their parent, and the owner taking back what is left. Each is checked (operator ceiling H081_MAX_GRANT, the
//     balance, the parent's limits, the SDK's own input builder) before any proof, and without `confirm: true` only
//     the plan of exactly what would be sent is returned. They are note-to-note operations with no public leg, so
//     the agent key sends them (there is nothing a relayer could take its fee from);
//   - loans are the site's two-party flow, there is no matching here: a lender agent opens a slot and hands out its
//     "h081-loan-terms:" code (h081_lend open), a borrower agent pledges to it and hands back an "h081-loan-proof:"
//     code (h081_loan_borrow), the lender funds against it (h081_lend fund: plan unless confirm: true, H081_MAX_LEND
//     ceiling) and later claims, collects and settles. The slot owner must sign every lender action, so no relayer
//     is involved: the agent wallet is publicly the lender;
//   - every program error is explained (errors.ts).
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Account, type StipendAddress } from '../../src/account.js';
import { type Allowance, type LenderRef, allowanceCommitment, initCrypto, lenderShare } from '../../src/crypto.js';
import { DELEGATE_OUTPUTS, delegateInput, minRemainingFor } from '../../src/inputs.js';
import { type CircuitName, type ProofResult, type Prover, type SolidityProof } from '../../src/prover.js';
import { viewingKeyFromSk } from '../../src/encryption.js';
import { RelayerClient, type RelayerInfo } from '../../src/relayer-client.js';
import { type CapacityOperator, SolanaPool, SolanaWallet, type SolOwnedAllowance, type SolRelay } from '../../src/solana/wallet.js';
import { assetCapPda, configPda, vaultPda } from '../../src/solana/pda.js';
import { type StreamArgs, decodeAssetCaps, decodeConfig } from '../../src/solana/program.js';
import { fieldOf } from '../../src/solana/field.js';
import { sendLegacy } from '../../src/solana/send.js';
import {
  SolanaLoanLenderWallet, type SlotAccount, decodeRegistry, decodeSlot, maxPrincipal, originationFee, payoutAudience, registryPda, shortfallOf, slotInbox, slotPda,
} from '../../src/solana/lender.js';
import { createAtaIdempotentIx, readCapacity, requestUnstakeIx, stakeIx, unstakeIx } from '../../src/solana/token.js';
import type { PoolEventLogSnapshot } from '../../src/solana/events.js';
import { FlatDirProver } from './circuits.js';
import { type CodeContext, PLEDGE_BPS_MAX, PLEDGE_BPS_MIN, decodeLoanProof, decodeLoanTerms, encodeAddressCode, encodeLoanProof, encodeLoanTerms } from './codes.js';
import { DEPOSIT_SOL_MIN, type H081Config, MAINNET, NOTICE, PUBLIC_RPC_HOSTS, checkCluster, isMainnetConfig, rpcHost } from './constants.js';
import { type ProgramKind, explained } from './errors.js';
import { ACCOUNT_SOURCE_NOTES, type AccountDerivation, type AccountSource, deriveAgentSk, deriveLenderSk } from './keys.js';
import { fromUnits } from './units.js';

export interface Caps { perDeposit: bigint; total: bigint; inVault: bigint; paused: boolean }

export interface RelayTerms {
  url: string; relayer: PublicKey; feeRecipient: PublicKey; minFee: bigint; feeBps: number; treasury?: string; freeTier?: bigint;
  /** what the relayer adds to the fee when it has to create the recipient's token account; undefined = it will not create one */
  createAccountFee?: bigint;
}

export interface AllowanceView {
  id: bigint; agentIndex?: number; remaining: bigint; remainingUsdg: string; lifetimeCap: bigint; windowCap: bigint; windowLen: bigint;
  maxPerTx: bigint; expiry: bigint; streamRate: bigint; streamStart: bigint; pledgeBps: bigint; loanRef?: bigint; lender?: string;
  /** this account granted it (it is the owner): h081_allowance_reclaim takes back what is left */
  reclaimable: boolean;
}

export interface BalanceView {
  shielded: bigint; shieldedUsdg: string; walletUsdg: bigint; walletUsdgHuman: string; walletSol: number;
  signer: string; shieldedAddress: { pk: string; viewPub: string };
  /** the shielded address as an "h081-address:" code: hand it to whoever should pay this account privately (h081_pay) */
  shieldedAddressCode: string;
  /** allowances this account granted to its sub-accounts (loan pledges live here); h081_pay spends them with agentIndex */
  subAccounts: AllowanceView[];
  /** allowances this account itself can spend as an agent (granted by someone else); h081_pay spends them */
  agentAllowances: AllowanceView[];
  /** allowances this account granted to other agents' shielded addresses: theirs to spend, this account's to reclaim */
  grantedToOthers: AllowanceView[];
  /** allowances sub-accounts hold that another account owns (delegated to them from an allowance granted by someone else); h081_pay spends them with agentIndex */
  heldBySubAccounts: AllowanceView[];
  caps: Caps | null;
}

export interface DepositResult { signature: string; amount: bigint; amountUsdg: string; shielded: bigint; shieldedUsdg: string; computeUnits: number }
export interface WithdrawResult {
  signature: string; amount: bigint; fee: bigint; received: bigint; receivedUsdg: string; to: string; via: 'relayer' | 'direct'; shielded: bigint; shieldedUsdg: string;
  /** the agent wallet, when it was named to the relayer as capacity operator (public amount above the free tier) */
  operator?: string;
}

export interface PayRequest {
  /** gross amount taken out of the allowance (base units); a pledged allowance routes its lender share out of it */
  amount: bigint;
  /** a Solana wallet (public payout to its USDG account) or a shielded H081 address (private, from an "h081-address:" code) */
  to: PublicKey | StipendAddress;
  /** the allowance to spend (its id from h081_bank_balance); default: picked automatically */
  allowanceId?: bigint;
  /** spend an allowance held by this sub-account; default: allowances granted to this account */
  agentIndex?: number;
  /** public payout only: the agent key sends it instead of the relayer */
  direct?: boolean;
  /** accept paying from a pledged (loan) allowance, whose loan slot and lender share are public next to the payment */
  allowPledged?: boolean;
}
export interface PayResult {
  signature: string; amount: bigint; amountUsdg: string; fee: bigint; lenderShare: bigint; received: bigint; receivedUsdg: string;
  /** the recipient wallet, or "shielded" for a private payment */
  to: string; private: boolean; via: 'relayer' | 'direct';
  /** the allowance spent, and its successor's id (what h081_bank_balance shows next); undefined when it is used up */
  allowanceId: bigint; nextAllowanceId?: bigint; agentIndex?: number;
  remaining: bigint; remainingUsdg: string;
  operator?: string;
  /** the loan slot a pledged allowance paid from is tied to (public), and what that reveals */
  linkedToLoan?: bigint; privacy?: string;
}

/** The rules of an allowance as it would be (plan) or was (result) created; 0 means "no such limit". */
export interface AllowanceRules {
  amount: bigint; amountUsdg: string;
  windowCap: bigint; windowCapUsdg: string; windowLen: bigint;
  maxPerTx: bigint; maxPerTxUsdg: string;
  /** unix seconds; 0 = never expires */
  expiry: bigint; expiresAt: string | null;
  /** base units per second the budget unlocks at; 0 = all of it at once */
  streamRate: bigint; unlocksPerDayUsdg: string | null; streamStart: bigint;
  /** a pledged parent's share routed to its lender (children inherit it) */
  pledgeBps: bigint;
}

export interface GrantRequest {
  /** the lifetime budget, taken out of the shielded balance */
  amount: bigint;
  /** a sub-account of this agent; default (and no `to`): the first free one */
  agentIndex?: number;
  /** another agent's shielded address (from its "h081-address:" code) */
  to?: StipendAddress;
  /** per-window cap (base units; default none) and the window in seconds (default 86400, a day) */
  windowCap?: bigint; windowLen?: bigint;
  /** per-payment cap (base units; default none) */
  maxPerTx?: bigint;
  /** lifetime in days (default: no expiry) */
  days?: number;
  /** the budget unlocks linearly over this many days (default: all of it at once) */
  unlockDays?: number;
  /** false (default): return the plan, send nothing */
  confirm?: boolean;
}

export interface DelegateRequest {
  /** the parent: an allowance this account (or sub-account `agentIndex`) holds, by its id from h081_bank_balance */
  allowanceId: bigint;
  /** the parent's holder: sub-account `agentIndex`; default this account */
  agentIndex?: number;
  /** the child goes to sub-account `toAgentIndex`, or to another agent's shielded address `to` */
  toAgentIndex?: number; to?: StipendAddress;
  amount: bigint;
  /** the child's limits; each must be no looser than the parent's (see allowanceDelegate) */
  windowCap?: bigint; maxPerTx?: bigint; days?: number; unlockDays?: number;
  confirm?: boolean;
}

export interface ReclaimRequest { allowanceId: bigint; confirm?: boolean }

export interface AllowancePlanResult {
  sent: false; dryRun: true;
  /** exactly what h081_allowance_* would send with confirm: true */
  plan: Record<string, unknown>;
  next: string;
}

export interface GrantResult {
  sent: true; signature: string; to: string; agentIndex?: number; allowanceId: bigint; rules: AllowanceRules;
  shielded: bigint; shieldedUsdg: string; next: string;
}
export interface DelegateResult {
  sent: true; signature: string; signatures: string[]; parentId: bigint; parentAgentIndex?: number; to: string; toAgentIndex?: number;
  allowanceId: bigint; rules: AllowanceRules;
  /** the parent's successor (what the holder keeps); undefined when nothing is left */
  residualId?: bigint; residualRemaining: bigint; residualRemainingUsdg: string; next: string;
}
export interface ReclaimResult {
  sent: true; signature: string; allowanceId: bigint; reclaimed: bigint; reclaimedUsdg: string; lenderShare: bigint; shielded: bigint; shieldedUsdg: string;
}

/** SOL the agent key needs to stage a grant proof (buffer rent, mostly refunded, and fees); as for a loan pledge. */
const GRANT_SOL_MIN = 0.1;
/** SOL a lender action without a proof needs (slot rent on open, fees). */
const LEND_SOL_MIN = 0.01;

export interface LendPlanResult {
  sent: false; dryRun: true;
  /** exactly what h081_lend would send with confirm: true */
  plan: Record<string, unknown>;
  next: string;
}
export interface LendOpenResult { sent: true; loanRef: bigint; pledgeBps: bigint; slot: string; termsCode: string; next: string }
export interface LendFundResult {
  sent: true; signature: string; loanRef: bigint; principal: bigint; principalUsdg: string; originationFee: bigint; borrowerReceives: bigint; borrowerReceivesUsdg: string;
  payoutTo: string; pledgeBps: number; budgetBacking: bigint; budgetBackingUsdg: string; streamsPerDayUsdg: string; expiry: bigint; expiresAt: string | null; next: string;
}
export interface LendSlotView {
  loanRef: bigint; slot: string; lender: string;
  /** owned by this agent key */
  mine: boolean;
  /** open (not lent yet), funded (being repaid), repaid (principal repaid, not settled), settled */
  state: 'open' | 'funded' | 'repaid' | 'settled';
  funded: boolean; settled: boolean; principal: bigint; principalUsdg: string; repaid: bigint; repaidUsdg: string; outstanding: bigint; outstandingUsdg: string;
  /** the vested lender share of the borrower's stream h081_lend claim pulls now */
  claimable: bigint; claimableUsdg: string;
  /** shares already routed to the slot that h081_lend collect takes */
  collectable: bigint; collectableUsdg: string;
  pledgeBps: bigint | null; expiry: bigint; expiresAt: string | null;
  /** unpaid principal once expiry + 7 days has passed */
  shortfall: bigint;
  payoutTo: string | null;
  /** the borrower moved its pledged note without handing this lender the successor: only the shortfall path remains */
  borrowerWithheldMemo: boolean;
  /** an open slot of this agent, when pledgeBps was given: its "h081-loan-terms:" code again */
  termsCode?: string;
}
export interface LendSentResult {
  sent: true; action: 'collect' | 'claim' | 'settle' | 'close'; loanRef: bigint; signatures: string[];
  collected?: bigint; collectedUsdg?: string; refundedLamports?: bigint; slot?: LendSlotView;
}

/** The relayer is configured but cannot be used: unreachable, wrong pool or asset, or a fee account that is not the treasury's. */
/**
 * The most the agent ever accepts from a relayer's advertised USDG terms (the same ceilings the site pins in its
 * RELAY_FEE_CAPS): the published terms are 0.20% with a 0.05 USDG minimum. A relayer asking more is refused like one
 * naming a wrong fee account: nothing is proven, nothing is sent, and it never turns into a direct send.
 */
export const RELAY_FEE_CAPS = { maxBps: 25, maxMinFee: 75_000n, maxCreateAccountFee: 5_000_000n } as const;

export class RelayerUnavailableError extends Error {
  constructor(readonly reason: 'unreachable' | 'no_solana' | 'asset_not_accepted' | 'wrong_pool' | 'wrong_fee_account' | 'fee_too_high', message: string) {
    super(message);
    this.name = 'RelayerUnavailableError';
  }
}
export interface StakeView {
  signer: string; walletH081: bigint; staked: bigint; pending: bigint; readyAt: bigint; now: bigint; desks: bigint; shieldCap: bigint;
  totalStaked: bigint; caps: { maxPerStake: bigint; maxTotal: bigint; paused: boolean }; cooldownDays: number;
}
export interface LoanQuote {
  pledgeBps: number; minRemaining: bigint; maxPrincipal: bigint; principal: bigint; originationFee: bigint; originationFeeBps: number; payout: bigint;
  loanRef?: bigint; slot?: SlotView | null; note: string;
}
export interface SlotView {
  loanRef: bigint; lender: string; funded: boolean; settled: boolean; principal: bigint; repaid: bigint; expiry: bigint; pledgeBps: bigint; payoutTo: string;
}
export interface BorrowRules { /** the pledged allowance; with `principal` it defaults to, and may not exceed, minRemainingFor(principal, pledgeBps) */ budget?: bigint; dailyCap?: bigint; maxPerTx?: bigint; /** the loan amount asked for; the lender must fund exactly this (default: the most the pledge can back) */ principal?: bigint; days: number; unlockDays: number; agentIndex?: number }
export interface BorrowResult {
  agentIndex: number; allowanceId: bigint; loanRef: bigint; pledgeBps: bigint; grantSignature: string; proofCode: string;
  principal: bigint; maxPrincipal: bigint; originationFeeAtMax: bigint; payoutAccount: string; streamRate: bigint; expiry: bigint; next: string;
}

export interface BankOptions {
  config: H081Config;
  signer: Keypair;
  /** the shielded account secret (keys.ts accountSkFromEnv) */
  accountSk: bigint;
  /** how sub-accounts are derived from the signer (keys.ts; default `seed`) */
  derivation?: AccountDerivation;
  /** where `accountSk` came from, for protocolInfo (default: `derivation`) */
  accountSource?: AccountSource;
  connection?: Connection;
  /** default: FlatDirProver over config.circuitsDir */
  prover?: Prover;
  fetch?: typeof fetch;
  /** event-log cache directory; default <circuitsDir>/../cache; null disables */
  cacheDir?: string | null;
  log?: (line: string) => void;
  /** skip the genesis/id check (tests against a mocked connection) */
  skipClusterCheck?: boolean;
}

const MAX_AGENTS = 16;

export class H081Bank {
  readonly connection: Connection;
  readonly pool: SolanaPool;
  readonly owner: SolanaWallet;
  readonly account: Account;
  readonly signer: Keypair;
  readonly config: H081Config;
  readonly usdg: PublicKey;
  readonly stakeMint: PublicKey;
  readonly decimals: number;
  readonly prover: Prover;
  private readonly relayer?: RelayerClient;
  private readonly agents = new Map<number, { account: Account; wallet: SolanaWallet }>();
  /** sub-accounts this process delegated to: they may hold allowances this account does not own (and so cannot see from its own view) */
  private readonly touched = new Set<number>();
  private lenderWallet?: SolanaLoanLenderWallet;
  private readonly log: (line: string) => void;
  private readonly cacheFile?: string;
  /** where `touched` is kept across restarts (sub-account indices only: no key, no amount) */
  private readonly subAccountsFile?: string;
  private readonly derivation: AccountDerivation;
  private readonly accountSource: AccountSource;

  private constructor(opts: BankOptions, connection: Connection, prover: Prover) {
    this.config = opts.config;
    this.connection = connection;
    this.prover = prover;
    this.signer = opts.signer;
    this.derivation = opts.derivation ?? 'seed';
    this.accountSource = opts.accountSource ?? this.derivation;
    this.usdg = opts.config.usdgMint;
    this.stakeMint = opts.config.stakeMint;
    this.decimals = opts.config.decimals;
    this.log = opts.log ?? (() => {});
    this.pool = new SolanaPool(connection, opts.config.poolProgramId, prover);
    this.account = new Account(opts.accountSk);
    this.owner = new SolanaWallet(this.account, this.pool, opts.signer);
    this.owner.registerMint(this.usdg);
    if (opts.config.relayerUrl) this.relayer = new RelayerClient(opts.config.relayerUrl, opts.fetch);
    const cacheDir = opts.cacheDir === undefined ? join(opts.config.circuitsDir, '..', 'cache') : opts.cacheDir;
    if (cacheDir) {
      this.cacheFile = join(cacheDir, `${opts.config.cluster}-${opts.config.poolProgramId.toBase58()}.events.json`);
      this.subAccountsFile = join(cacheDir, `${opts.config.cluster}-${opts.config.poolProgramId.toBase58()}.subaccounts-${opts.signer.publicKey.toBase58()}.json`);
      try {
        const saved = JSON.parse(readFileSync(this.subAccountsFile, 'utf8')) as { indices?: unknown };
        if (Array.isArray(saved.indices)) for (const i of saved.indices) if (Number.isInteger(i) && i >= 0 && i < MAX_AGENTS) this.touched.add(i);
      } catch { /* none yet */ }
    }
  }

  /** Remembers that sub-account `i` holds something this account may not own (a delegated child), across restarts. */
  private touch(i: number): void {
    if (this.touched.has(i)) return;
    this.touched.add(i);
    if (!this.subAccountsFile) return;
    try {
      mkdirSync(join(this.subAccountsFile, '..'), { recursive: true });
      writeFileSync(this.subAccountsFile, JSON.stringify({ indices: [...this.touched].sort((a, b) => a - b) }));
    } catch (e) { this.log(`could not save the sub-account list: ${(e as Error).message}`); }
  }

  /** Opens the bank: crypto init, cluster check, event-log cache. No transaction is sent. */
  static async open(opts: BankOptions): Promise<H081Bank> {
    await initCrypto();
    const connection = opts.connection ?? new Connection(opts.config.rpcUrl, 'confirmed');
    if (!opts.skipClusterCheck) checkCluster(opts.config, await connection.getGenesisHash());
    const prover = opts.prover ?? new FlatDirProver(opts.config.circuitsDir);
    let bank = new H081Bank(opts, connection, prover);
    if (!(await bank.loadCache())) bank = new H081Bank(opts, connection, prover); // the cache did not match the chain
    return bank;
  }

  get programIds(): Partial<Record<ProgramKind, string>> {
    return { pool: this.config.poolProgramId.toBase58(), loan: this.config.loanProgramId.toBase58(), capacity: this.config.capacityProgramId.toBase58(), safety: this.config.safetyProgramId.toBase58() };
  }

  // ---- event-log cache (public chain data only: commitments, nullifiers, encrypted memos; never a key)

  private async loadCache(): Promise<boolean> {
    if (!this.cacheFile || !existsSync(this.cacheFile)) return true;
    let snap: PoolEventLogSnapshot;
    try { snap = JSON.parse(readFileSync(this.cacheFile, 'utf8')); } catch { return true; }
    if (!this.pool.log.restore(snap)) return true;
    try { await this.owner.sync(); } finally { this.saveCache(); }
    if (await this.owner.matchesChain()) return true;
    this.log('event cache does not match the chain; rescanning');
    try { unlinkSync(this.cacheFile); } catch { /* ignore */ }
    return false;
  }

  private saveCache(): void {
    if (!this.cacheFile) return;
    try {
      mkdirSync(join(this.cacheFile, '..'), { recursive: true });
      writeFileSync(this.cacheFile, JSON.stringify(this.pool.log.snapshot()));
    } catch (e) { this.log(`could not save the event cache: ${(e as Error).message}`); }
  }

  /** Fetches new pool events and re-reads this account's notes; saves the cache. */
  async sync(): Promise<void> {
    try { await this.owner.sync(); } finally { this.saveCache(); }
  }

  // ---- reads

  async tokenProgram(): Promise<PublicKey> { return this.pool.tokenProgramOf(this.usdg); }

  /** The signer's USDG associated token account. */
  async walletUsdgAccount(): Promise<PublicKey> {
    return getAssociatedTokenAddressSync(this.usdg, this.signer.publicKey, false, await this.tokenProgram());
  }

  /** Deposit caps and pause flag as the program enforces them (null when the guard accounts are missing). */
  async caps(): Promise<Caps | null> {
    const pid = this.config.poolProgramId;
    const [cfg, cap] = await Promise.all([
      this.connection.getAccountInfo(configPda(pid), 'confirmed'),
      this.connection.getAccountInfo(assetCapPda(pid, this.usdg), 'confirmed'),
    ]);
    if (!cfg || !cap) return null;
    const c = decodeConfig(cfg.data), a = decodeAssetCaps(cap.data);
    const inVault = await this.pool.tokenBalance(vaultPda(pid, this.usdg));
    return { perDeposit: a.maxPerDeposit, total: a.maxTotal, inVault, paused: c.depositsPaused };
  }

  private agentPks(): Map<bigint, number> {
    const m = new Map<bigint, number>();
    for (let i = 0; i < MAX_AGENTS; i++) m.set(this.agent(i).account.keys.pk, i);
    return m;
  }

  private view(a: SolOwnedAllowance, agentIndex?: number): AllowanceView {
    const P = a.allowance.policy;
    return {
      id: a.commitment, agentIndex, remaining: a.allowance.remaining, remainingUsdg: fromUnits(a.allowance.remaining, this.decimals),
      lifetimeCap: P.lifetimeCap, windowCap: P.windowCap, windowLen: P.windowLen, maxPerTx: P.maxPerTx, expiry: P.expiry,
      streamRate: P.streamRate, streamStart: P.streamStart, pledgeBps: P.pledgeBps, loanRef: a.lender?.loanRef, lender: a.lenderKey?.toBase58(),
      reclaimable: P.ownerPk === this.account.keys.pk,
    };
  }

  /** Sub-accounts that may hold something: the ones this account granted to, and the ones it delegated to (kept in the cache dir). */
  private subAccountsInUse(): number[] {
    const used = new Set(this.owner.grantedAllowances().map((g) => g.allowance.agentPk));
    const out: number[] = [];
    for (let i = 0; i < MAX_AGENTS; i++) if (this.touched.has(i) || used.has(this.agent(i).account.keys.pk)) out.push(i);
    return out;
  }

  async balance(): Promise<BalanceView> {
    await this.sync();
    const [walletUsdg, lamports, caps] = await Promise.all([
      this.walletUsdgAccount().then((ata) => this.pool.tokenBalance(ata)),
      this.connection.getBalance(this.signer.publicKey, 'confirmed'),
      this.caps().catch(() => null),
    ]);
    const byPk = this.agentPks();
    const shielded = this.owner.balance(this.usdg);
    const usdgOnly = (a: SolOwnedAllowance) => a.allowance.asset === this.owner.registerMint(this.usdg);
    const granted = this.owner.grantedAllowances().filter(usdgOnly).filter((a) => a.allowance.agentPk !== this.account.keys.pk);
    // what sub-accounts hold that this account does not own (its own grants are already in subAccounts)
    const heldBySubAccounts: AllowanceView[] = [];
    for (const i of this.subAccountsInUse()) {
      const w = this.agent(i).wallet;
      await w.sync();
      for (const a of w.agentAllowances(this.usdg)) if (a.allowance.policy.ownerPk !== this.account.keys.pk) heldBySubAccounts.push(this.view(a, i));
    }
    return {
      shielded, shieldedUsdg: fromUnits(shielded, this.decimals), walletUsdg, walletUsdgHuman: fromUnits(walletUsdg, this.decimals),
      walletSol: lamports / LAMPORTS_PER_SOL, signer: this.signer.publicKey.toBase58(), shieldedAddress: this.shieldedAddress(),
      shieldedAddressCode: this.shieldedAddressCode(),
      subAccounts: granted.filter((a) => byPk.has(a.allowance.agentPk)).map((a) => this.view(a, byPk.get(a.allowance.agentPk))),
      agentAllowances: this.owner.agentAllowances(this.usdg).map((a) => this.view(a)),
      grantedToOthers: granted.filter((a) => !byPk.has(a.allowance.agentPk)).map((a) => this.view(a)),
      heldBySubAccounts,
      caps,
    };
  }

  shieldedAddress(): { pk: string; viewPub: string } {
    return { pk: this.account.address.pk.toString(), viewPub: '0x' + Buffer.from(this.account.address.viewPub).toString('hex') };
  }

  // ---- deposit

  /** Shields `amount` USDG from the signer's token account. Refuses, before any proof, what the program would refuse. */
  async deposit(amount: bigint): Promise<DepositResult> {
    if (amount <= 0n) throw new Error('the amount must be positive');
    const d = this.decimals, sym = MAINNET.usdg.symbol;
    const caps = await this.caps();
    if (caps?.paused) throw new Error('DepositsPaused: new deposits are paused for now; withdrawals still work.');
    if (caps && amount > caps.perDeposit) throw new Error(`DepositTooLarge: at most ${fromUnits(caps.perDeposit, d)} ${sym} per deposit (asked ${fromUnits(amount, d)}).`);
    if (caps && caps.inVault + amount > caps.total) {
      const room = caps.total > caps.inVault ? caps.total - caps.inVault : 0n;
      throw new Error(`DepositCapExceeded: the bank holds at most ${fromUnits(caps.total, d)} ${sym} in total; ${fromUnits(room, d)} ${sym} of room left.`);
    }
    if (this.config.maxDeposit !== undefined && amount > this.config.maxDeposit) {
      throw new Error(`over the operator ceiling H081_MAX_DEPOSIT (${fromUnits(this.config.maxDeposit, d)} ${sym} per deposit).`);
    }
    const [have, lamports] = await Promise.all([
      this.walletUsdgAccount().then((ata) => this.pool.tokenBalance(ata)),
      this.connection.getBalance(this.signer.publicKey, 'confirmed'),
    ]);
    if (have < amount) throw new Error(`the agent wallet ${this.signer.publicKey.toBase58()} holds ${fromUnits(have, d)} ${sym}, less than ${fromUnits(amount, d)}.`);
    if (lamports < DEPOSIT_SOL_MIN * LAMPORTS_PER_SOL) {
      throw new Error(`the agent wallet holds ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL; a deposit needs about ${DEPOSIT_SOL_MIN} SOL for buffer rent (refunded) and fees.`);
    }
    try {
      const r = await this.owner.deposit(this.usdg, amount);
      this.saveCache();
      const shielded = this.owner.balance(this.usdg);
      return { signature: r.tx.signature, amount, amountUsdg: fromUnits(amount, d), shielded, shieldedUsdg: fromUnits(shielded, d), computeUnits: r.tx.computeUnits };
    } catch (e) {
      this.saveCache();
      throw explained(e, { program: 'pool', ids: this.programIds });
    }
  }

  // ---- withdraw

  /**
   * The relayer's terms for USDG. Undefined only when no relayer is configured (H081_RELAYER_URL empty).
   * Throws RelayerUnavailableError when the relayer is unreachable, does not serve this pool or USDG, or
   * names a fee account that is not the treasury's: on mainnet exactly the treasury's USDG account
   * (MAINNET.treasuryUsdgAccount, owned by MAINNET.loanTreasury); elsewhere the ATA of the treasury it names.
   * Nothing else is ever bound into a proof as fee recipient.
   */
  async relayTerms(): Promise<RelayTerms | undefined> {
    if (!this.relayer) return undefined;
    const url = this.relayer.url, sym = MAINNET.usdg.symbol;
    let info: RelayerInfo & { solana?: { feeBps?: number; treasury?: string; capacity?: { freeTier?: string } } };
    try { info = await this.relayer.info(); } catch (e) {
      throw new RelayerUnavailableError('unreachable', `the relayer ${url} is unreachable (${(e as Error).message})`);
    }
    const sol = info.solana;
    if (!sol) throw new RelayerUnavailableError('no_solana', `the relayer ${url} does not relay Solana operations`);
    const mint = this.usdg.toBase58();
    const minFee = sol.minFees?.[mint], feeRecipient = sol.feeAccounts?.[mint];
    if (minFee === undefined || !feeRecipient) throw new RelayerUnavailableError('asset_not_accepted', `the relayer ${url} does not accept ${sym} (${mint})`);
    if (sol.programId && sol.programId !== this.config.poolProgramId.toBase58()) {
      throw new RelayerUnavailableError('wrong_pool', `the relayer ${url} serves pool ${sol.programId}, not ${this.config.poolProgramId.toBase58()}`);
    }
    let feeAccount: PublicKey, relayerKey: PublicKey;
    try { feeAccount = new PublicKey(feeRecipient); relayerKey = new PublicKey(sol.relayer); } catch {
      throw new RelayerUnavailableError('wrong_fee_account', `the relayer ${url} names an invalid fee account or relayer key`);
    }
    const wrong = (why: string) => new RelayerUnavailableError('wrong_fee_account',
      `the relayer ${url} names ${feeRecipient} as its ${sym} fee account (treasury ${sol.treasury ?? 'unset'}), ${why}; H081 relay fees go only to the protocol treasury, so this relayer is refused and nothing was signed`);
    if (isMainnetConfig(this.config)) {
      if (feeRecipient !== MAINNET.treasuryUsdgAccount || sol.treasury !== MAINNET.loanTreasury) {
        throw wrong(`not the treasury's ${sym} account ${MAINNET.treasuryUsdgAccount} owned by ${MAINNET.loanTreasury}`);
      }
    } else {
      let treasury: PublicKey;
      try { treasury = sol.treasury ? new PublicKey(sol.treasury) : this.config.loanTreasury; } catch { throw wrong('which is not a valid treasury'); }
      const want = getAssociatedTokenAddressSync(this.usdg, treasury, true, await this.tokenProgram());
      if (!feeAccount.equals(want)) throw wrong(`not the treasury's associated ${sym} account ${want.toBase58()}`);
    }
    // the surcharge the relayer wants when it must create the recipient's token account (it pays the rent)
    const surcharge = (sol as { createAccountFees?: Record<string, string> }).createAccountFees?.[mint];
    // bounded terms: the treasury pin stops theft, these ceilings stop an overcharge the circuit would allow (fee < net)
    const d = this.decimals;
    const tooHigh = (what: string) => new RelayerUnavailableError('fee_too_high',
      `the relayer ${url} asks ${what}; H081 relays on the published terms (0.20%, at least 0.05 ${sym}), so this relayer is refused and nothing was signed`);
    const feeBps = sol.feeBps ?? 0;
    let minFeeUnits: bigint, surchargeUnits: bigint | undefined;
    try {
      minFeeUnits = BigInt(minFee);
      surchargeUnits = surcharge === undefined ? undefined : BigInt(surcharge);
    } catch { throw tooHigh('a fee that is not a whole number of base units'); }
    if (!Number.isInteger(feeBps) || feeBps < 0) throw tooHigh(`an invalid fee rate (${String(feeBps)} bps)`);
    if (feeBps > RELAY_FEE_CAPS.maxBps) throw tooHigh(`${feeBps / 100}% of each operation (at most ${RELAY_FEE_CAPS.maxBps / 100}% is accepted)`);
    if (minFeeUnits < 0n || minFeeUnits > RELAY_FEE_CAPS.maxMinFee) throw tooHigh(`a minimum fee of ${fromUnits(minFeeUnits, d)} ${sym} (at most ${fromUnits(RELAY_FEE_CAPS.maxMinFee, d)} ${sym} is accepted)`);
    if (surchargeUnits !== undefined && (surchargeUnits < 0n || surchargeUnits > RELAY_FEE_CAPS.maxCreateAccountFee)) {
      throw tooHigh(`${fromUnits(surchargeUnits, d)} ${sym} to create a recipient's token account (at most ${fromUnits(RELAY_FEE_CAPS.maxCreateAccountFee, d)} ${sym} is accepted)`);
    }
    return {
      url, relayer: relayerKey, feeRecipient: feeAccount, minFee: minFeeUnits,
      feeBps, treasury: sol.treasury, freeTier: sol.capacity?.freeTier === undefined ? undefined : BigInt(sol.capacity.freeTier),
      createAccountFee: surchargeUnits,
    };
  }

  /** The agent wallet's shieldCap from capacity_stake (undefined when it cannot be read). */
  private async shieldCap(): Promise<{ staked: bigint; shieldCap: bigint } | undefined> {
    try {
      const c = await readCapacity(this.connection, this.config.capacityProgramId, this.stakeMint, this.signer.publicKey);
      return { staked: c.stake.staked, shieldCap: c.shieldCap };
    } catch (e) { this.log(`capacity_stake not readable: ${(e as Error).message}`); return undefined; }
  }

  /**
   * The smallest fee the relayer accepts for a withdrawal of `amount`: it checks fee >= max(minFee, bps *
   * public amount / 10000) where the public amount is what the recipient receives, amount - fee.
   */
  static relayFee(amount: bigint, t: Pick<RelayTerms, 'minFee' | 'feeBps'>): bigint {
    const bps = BigInt(t.feeBps);
    let fee = (bps * amount) / (10_000n + bps);
    if (fee < t.minFee) fee = t.minFee;
    const need = (f: bigint) => { const pct = (bps * (amount - f)) / 10_000n; return pct > t.minFee ? pct : t.minFee; };
    while (fee < need(fee)) fee++;
    return fee;
  }

  /**
   * The smallest fee the relayer accepts for a payment from an allowance of gross `amount`: the relayer checks
   * fee >= max(minFee, bps * public leg / 10000), and a spend's public leg is the payout plus the lender's share,
   * which is the gross amount (the fee comes out of the payout, so unlike a withdrawal it does not shrink the leg).
   */
  static spendRelayFee(amount: bigint, t: Pick<RelayTerms, 'minFee' | 'feeBps'>): bigint {
    const pct = (BigInt(t.feeBps) * amount) / 10_000n;
    return pct > t.minFee ? pct : t.minFee;
  }

  /**
   * Above the relayer's anonymous free tier the relayer wants a capacity operator: the agent wallet, with its H081
   * stake. Undefined at or below the tier; refuses (before any proof) a public leg above the tier plus the stake.
   */
  private async capacityOperator(pub: bigint, terms: RelayTerms, verb: string, directHint: string): Promise<CapacityOperator | undefined> {
    if (terms.freeTier === undefined || pub <= terms.freeTier) return undefined;
    const d = this.decimals, sym = MAINNET.usdg.symbol;
    const cap = await this.shieldCap();
    const tier = fromUnits(terms.freeTier, d);
    if (cap && pub > terms.freeTier + cap.shieldCap) {
      throw new Error(
        `${fromUnits(pub, d)} ${sym} is above the relayer's anonymous free tier (${tier} ${sym} per 30 days) plus the agent wallet's staked capacity ` +
        `(${fromUnits(cap.shieldCap, d)} ${sym} from ${fromUnits(cap.staked, MAINNET.h081.decimals)} ${MAINNET.h081.symbol} in capacity_stake). Nothing was sent. ` +
        `Stake more ${MAINNET.h081.symbol} (h081_stake), ${verb} at most ${fromUnits(terms.freeTier + cap.shieldCap, d)} ${sym} per 30 days through the relayer, or ${directHint}.`,
      );
    }
    const seed = this.signer.secretKey.subarray(0, 32);
    this.log(`${fromUnits(pub, d)} ${sym} is above the free tier of ${tier}: the agent wallet is named to the relayer as capacity operator`);
    return { operator: this.signer.publicKey, sign: (m) => ed25519.sign(m, seed) };
  }

  async withdraw(amount: bigint, to?: PublicKey, direct = false): Promise<WithdrawResult> {
    if (amount <= 0n) throw new Error('the amount must be positive');
    const d = this.decimals, sym = MAINNET.usdg.symbol;
    const dest = to ?? this.signer.publicKey;
    await this.pool.checkRecipient(dest);
    await this.sync();
    const shielded = this.owner.balance(this.usdg);
    if (amount > shielded) throw new Error(`the shielded balance is ${fromUnits(shielded, d)} ${sym}, less than ${fromUnits(amount, d)}.`);
    const me = this.signer.publicKey.toBase58();
    const directHint = `pass direct: true to have the agent wallet ${me} send it itself (no relay fee; the chain then links the agent wallet to ${dest.toBase58()})`;
    let terms: RelayTerms | undefined;
    if (!direct) {
      if (!this.relayer) {
        this.log('no relayer configured (H081_RELAYER_URL is empty): the agent key sends the withdrawal itself');
      } else {
        // fail closed: a configured relayer that cannot be used never turns into a direct send
        try { terms = await this.relayTerms(); } catch (e) {
          throw new Error(`${(e as Error).message}. The withdrawal was not sent: retry later, or ${directHint}.`);
        }
      }
    }
    let relay: SolRelay = {};
    let fee = 0n;
    let operator: string | undefined;
    if (terms) {
      fee = H081Bank.relayFee(amount, terms);
      // the relayer pays the rent of a missing recipient token account only against its surcharge (it refuses otherwise)
      const ata = getAssociatedTokenAddressSync(this.usdg, dest, true, await this.tokenProgram());
      if (!(await this.connection.getAccountInfo(ata, 'confirmed'))) {
        if (terms.createAccountFee === undefined) {
          throw new Error(`${dest.toBase58()} has no ${sym} token account yet and the relayer ${terms.url} does not create accounts. Create ${ata.toBase58()} first, or ${directHint}.`);
        }
        fee += terms.createAccountFee;
        this.log(`${dest.toBase58()} has no ${sym} account: the relayer creates it for a surcharge of ${fromUnits(terms.createAccountFee, d)} ${sym} on top of the fee`);
      }
      if (fee >= amount) throw new Error(`the relay fee ${fromUnits(fee, d)} ${sym} is not below the amount; withdraw more or use direct: true.`);
      relay = { via: this.relayer, relayer: terms.relayer, feeRecipient: terms.feeRecipient, fee };
      const op = await this.capacityOperator(amount - fee, terms, 'withdraw', directHint);
      if (op) { relay.operator = op; operator = me; }
    }
    try {
      const r = await this.owner.withdraw(this.usdg, amount, dest, relay);
      this.saveCache();
      const left = this.owner.balance(this.usdg);
      return {
        signature: r.tx.signature, amount, fee, received: amount - fee, receivedUsdg: fromUnits(amount - fee, d), to: dest.toBase58(),
        via: terms ? 'relayer' : 'direct', shielded: left, shieldedUsdg: fromUnits(left, d), ...(operator ? { operator } : {}),
      };
    } catch (e) {
      this.saveCache();
      throw explained(e, { program: 'pool', ids: this.programIds });
    }
  }

  // ---- pay from an allowance

  /** Where codes this bank makes and reads belong: this cluster, the pool program, USDG. */
  get codeContext(): CodeContext {
    return { cluster: this.config.cluster, program: this.config.poolProgramId.toBase58(), mint: this.usdg.toBase58() };
  }

  /** This account's shielded address as an "h081-address:" code (kind 5) another agent pays privately with h081_pay. */
  shieldedAddressCode(): string {
    return encodeAddressCode(this.codeContext, this.account.address);
  }

  /**
   * Why `owned` cannot pay a gross `amount` at `now`, in words that name the cap (undefined: it can). These are the
   * rules spend.circom enforces for the agent key (expiry, per-payment cap, lifetime remaining, streaming release,
   * per-window cap, forward-only window), checked here so a blocked payment costs no proof.
   */
  payBlock(owned: SolOwnedAllowance, amount: bigint, now: bigint): string | undefined {
    const d = this.decimals, sym = MAINNET.usdg.symbol, a = owned.allowance, P = a.policy;
    const u = (x: bigint) => `${fromUnits(x, d)} ${sym}`;
    const at = (t: bigint) => new Date(Number(t) * 1000).toISOString();
    if (P.expiry !== 0n && now >= P.expiry) return `expired at ${at(P.expiry)} (expiry)`;
    if (P.maxPerTx !== 0n && amount > P.maxPerTx) return `over its per-payment cap (maxPerTx ${u(P.maxPerTx)})`;
    if (amount > a.remaining) return `only ${u(a.remaining)} left of its lifetime cap ${u(P.lifetimeCap)} (remaining)`;
    if (P.streamRate !== 0n) {
      const allotted = now > P.streamStart ? P.streamRate * (now - P.streamStart) : 0n;
      const spent = P.lifetimeCap - a.remaining;
      const free = allotted > spent ? allotted - spent : 0n;
      if (amount > free) {
        const wait = (amount - free + P.streamRate - 1n) / P.streamRate;
        return `it streams: ${u(free)} unlocked and unspent so far (streamRate ${u(P.streamRate * 86400n)} a day); ${u(amount)} unlocks in about ${wait} s, at ${at(now + wait)}`;
      }
    }
    const windowId = now / P.windowLen;
    if (windowId < a.windowId) return `the chain clock is behind the allowance's last window; retry in a minute`;
    if (P.windowCap !== 0n) {
      const used = windowId === a.windowId ? a.windowSpent : 0n;
      const left = P.windowCap > used ? P.windowCap - used : 0n;
      if (amount > left) return `over its per-window cap (windowCap ${u(P.windowCap)} per ${P.windowLen} s; ${u(left)} left in this window, which resets at ${at((windowId + 1n) * P.windowLen)})`;
    }
    if (P.recipientRoot !== 0n) return 'it pays only an allow-list of recipients that h081_pay cannot prove membership in';
    if (P.pledgeBps !== 0n && !owned.lender) return 'it is pledged but its lender details were not found in its memo';
    return undefined;
  }

  /** The wallets that hold allowances this agent can spend: the account itself, sub-account `agentIndex`, or (with an id) every sub-account in use. */
  private async allowanceHolders(agentIndex: number | undefined, anySub: boolean, everySub = false): Promise<Array<{ wallet: SolanaWallet; agentIndex?: number }>> {
    await this.sync();
    if (agentIndex !== undefined) {
      const a = this.agent(agentIndex);
      await a.wallet.sync();
      return [{ wallet: a.wallet, agentIndex }];
    }
    const out: Array<{ wallet: SolanaWallet; agentIndex?: number }> = [{ wallet: this.owner }];
    if (anySub) {
      // everySub: all MAX_AGENTS sub-accounts, for an id the known ones do not hold (e.g. delegated before the list was kept)
      const subs = everySub ? Array.from({ length: MAX_AGENTS }, (_, i) => i) : this.subAccountsInUse();
      for (const i of subs) {
        const a = this.agent(i);
        await a.wallet.sync();
        out.push({ wallet: a.wallet, agentIndex: i });
      }
    }
    return out;
  }

  /**
   * Pays `amount` USDG (gross, out of the allowance) from an allowance this agent holds: one granted to this account,
   * or one held by sub-account `agentIndex`. To a Solana wallet it is a public payout through the relayer (fee to the
   * treasury, checked before anything is proven; refused, never sent by the agent key, when the relayer is configured
   * but unusable; `direct: true` has the agent key send it). To a shielded address it is a private note-to-note payment
   * the agent key sends (no public leg the relayer could take its fee from). A pledged allowance routes its lender share.
   */
  async pay(req: PayRequest): Promise<PayResult> {
    const { amount, to } = req;
    const d = this.decimals, sym = MAINNET.usdg.symbol;
    const u = (x: bigint) => `${fromUnits(x, d)} ${sym}`;
    if (amount <= 0n) throw new Error('the amount must be positive');
    if (this.config.maxPay !== undefined && amount > this.config.maxPay) {
      throw new Error(`over the operator ceiling H081_MAX_PAY (${u(this.config.maxPay)} per payment; asked ${u(amount)}). Nothing was sent.`);
    }
    const isPublic = to instanceof PublicKey;
    if (isPublic) await this.pool.checkRecipient(to);
    const holders = await this.allowanceHolders(req.agentIndex, req.allowanceId !== undefined);
    const where = req.agentIndex === undefined ? 'this account' : `sub-account ${req.agentIndex}`;
    const held = (hs: typeof holders) => hs.flatMap((h) => h.wallet.agentAllowances(this.usdg).map((owned) => ({ ...h, owned })));
    let found = held(holders);
    if (req.allowanceId !== undefined) {
      found = found.filter((c) => c.owned.commitment === req.allowanceId);
      if (!found.length && req.agentIndex === undefined) {
        // not in the known sub-accounts: look in every one before refusing, and remember where it was
        found = held(await this.allowanceHolders(undefined, true, true)).filter((c) => c.owned.commitment === req.allowanceId);
        for (const c of found) if (c.agentIndex !== undefined) this.touch(c.agentIndex);
      }
      if (!found.length) throw new Error(`no open allowance with id ${req.allowanceId} is held by ${req.agentIndex === undefined ? 'this account or its sub-accounts' : where} (h081_bank_balance lists them; an id changes after every payment). Nothing was sent.`);
    } else if (!found.length) {
      throw new Error(`${where} holds no ${sym} allowance to pay from (h081_bank_balance lists agentAllowances and subAccounts; pass agentIndex for a sub-account's). Nothing was sent.`);
    }
    const now = await this.pool.now();
    // a pledged (loan) allowance publishes its loan slot and lender share next to the payment, which links the payee to
    // the borrower wallet (the slot's public payout) and reveals the gross amount: never used without allowPledged
    const pledgedBlock = 'it is pledged to a loan: paying from it puts its loan slot and lender share on chain next to the payment, linking the recipient to the borrower wallet and revealing the gross amount; pass allowPledged: true to accept that';
    const checked = found.map((c) => ({ ...c, block: this.payBlock(c.owned, amount, now) ?? (c.owned.allowance.policy.pledgeBps !== 0n && !req.allowPledged ? pledgedBlock : undefined) }));
    const ok = checked.filter((c) => !c.block)
      // unpledged first (a pledged one routes a share to its lender), then the smallest that suffices, then the newest
      .sort((x, y) => Number(x.owned.allowance.policy.pledgeBps !== 0n) - Number(y.owned.allowance.policy.pledgeBps !== 0n)
        || (x.owned.allowance.remaining < y.owned.allowance.remaining ? -1 : x.owned.allowance.remaining > y.owned.allowance.remaining ? 1 : y.owned.index - x.owned.index));
    if (!ok.length) {
      const why = checked.map((c) => `allowance ${c.owned.commitment}${c.agentIndex === undefined ? '' : ` (sub-account ${c.agentIndex})`}: ${c.block}`).join('; ');
      throw new Error(`no allowance can pay ${u(amount)} now. Nothing was sent. ${why}.`);
    }
    const pick = ok[0];
    const share = lenderShare(pick.owned.allowance, amount);
    const net = amount - share;
    const me = this.signer.publicKey.toBase58();
    const dest = isPublic ? to.toBase58() : 'a shielded H081 address';
    const directHint = `pass direct: true to have the agent wallet ${me} send it itself (no relay fee; the chain then links the agent wallet to ${dest})`;
    let terms: RelayTerms | undefined;
    if (isPublic && !req.direct) {
      if (!this.relayer) this.log('no relayer configured (H081_RELAYER_URL is empty): the agent key sends the payment itself');
      else {
        // fail closed: a configured relayer that cannot be used never turns into a direct send
        try { terms = await this.relayTerms(); } catch (e) {
          throw new Error(`${(e as Error).message}. The payment was not sent: retry later, or ${directHint}.`);
        }
      }
    }
    let relay: SolRelay = {};
    let fee = 0n;
    let operator: string | undefined;
    if (terms && isPublic) {
      fee = H081Bank.spendRelayFee(amount, terms);
      const ata = getAssociatedTokenAddressSync(this.usdg, to, true, await this.tokenProgram());
      if (!(await this.connection.getAccountInfo(ata, 'confirmed'))) {
        if (terms.createAccountFee === undefined) {
          throw new Error(`${dest} has no ${sym} token account yet and the relayer ${terms.url} does not create accounts. Create ${ata.toBase58()} first, or ${directHint}. Nothing was sent.`);
        }
        fee += terms.createAccountFee;
      }
      if (fee >= net) throw new Error(`the relay fee ${u(fee)} is not below what the recipient would get (${u(net)}${share ? ` after the lender's share ${u(share)}` : ''}); pay more or use direct: true. Nothing was sent.`);
      relay = { via: this.relayer, relayer: terms.relayer, feeRecipient: terms.feeRecipient, fee };
      const op = await this.capacityOperator(amount, terms, 'pay', directHint);
      if (op) { relay.operator = op; operator = me; }
    } else {
      // the agent key stages and sends it: buffer rent (refunded) and fees
      const lamports = await this.connection.getBalance(this.signer.publicKey, 'confirmed');
      if (lamports < DEPOSIT_SOL_MIN * LAMPORTS_PER_SOL) {
        throw new Error(`the agent wallet holds ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL; a payment it sends itself needs about ${DEPOSIT_SOL_MIN} SOL for buffer rent (refunded) and fees. Nothing was sent.`);
      }
    }
    try {
      const r = await pick.wallet.pay(pick.owned, amount, to, relay);
      this.saveCache();
      return {
        signature: r.tx.signature, amount, amountUsdg: fromUnits(amount, d), fee, lenderShare: share, received: net - fee, receivedUsdg: fromUnits(net - fee, d),
        to: isPublic ? to.toBase58() : 'shielded', private: !isPublic, via: terms ? 'relayer' : 'direct',
        allowanceId: pick.owned.commitment, nextAllowanceId: r.next.remaining > 0n ? allowanceCommitment(r.next) : undefined,
        ...(pick.agentIndex === undefined ? {} : { agentIndex: pick.agentIndex }),
        remaining: r.next.remaining, remainingUsdg: fromUnits(r.next.remaining, d), ...(operator ? { operator } : {}),
        ...(pick.owned.allowance.policy.pledgeBps !== 0n ? {
          linkedToLoan: pick.owned.lender?.loanRef,
          privacy: `paid from an allowance pledged to loan slot ${pick.owned.lender?.loanRef}: the slot and the lender share ${u(share)} are public in this transaction, which links it to the borrower wallet (the slot's payout account) and reveals the gross amount ${u(amount)}`,
        } : {}),
      };
    } catch (e) {
      this.saveCache();
      throw explained(e, { program: 'pool', ids: this.programIds });
    }
  }

  // ---- allowances: grant, delegate, reclaim

  private rulesOf(a: Pick<Allowance, 'remaining' | 'policy'>): AllowanceRules {
    const P = a.policy, d = this.decimals;
    return {
      amount: a.remaining, amountUsdg: fromUnits(a.remaining, d),
      windowCap: P.windowCap, windowCapUsdg: fromUnits(P.windowCap, d), windowLen: P.windowLen,
      maxPerTx: P.maxPerTx, maxPerTxUsdg: fromUnits(P.maxPerTx, d),
      expiry: P.expiry, expiresAt: P.expiry === 0n ? null : new Date(Number(P.expiry) * 1000).toISOString(),
      streamRate: P.streamRate, unlocksPerDayUsdg: P.streamRate === 0n ? null : fromUnits(P.streamRate * 86400n, d), streamStart: P.streamStart,
      pledgeBps: P.pledgeBps,
    };
  }

  private grantCeiling(amount: bigint): void {
    const max = this.config.maxGrant;
    if (max !== undefined && amount > max) {
      const u = (x: bigint) => `${fromUnits(x, this.decimals)} ${MAINNET.usdg.symbol}`;
      throw new Error(`over the operator ceiling H081_MAX_GRANT (${u(max)} per allowance; asked ${u(amount)}). Nothing was sent.`);
    }
  }

  private async needSol(min: number, what: string): Promise<void> {
    const lamports = await this.connection.getBalance(this.signer.publicKey, 'confirmed');
    if (lamports < min * LAMPORTS_PER_SOL) {
      throw new Error(`the agent wallet holds ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL; ${what} needs about ${min} SOL for buffer rent (refunded) and fees. Nothing was sent.`);
    }
  }

  /**
   * Refuses, before anything is sent (a grant may first consolidate notes), when the proving artifacts of `name` are not
   * there. A prover that fetches on first use (open.ts AutoFetchProver) gets the chance to fetch them first.
   */
  private async requireArtifacts(name: CircuitName): Promise<void> {
    const ensure = (this.prover as Prover & { ensure?: (n: CircuitName) => Promise<void> }).ensure;
    let fetchError = '';
    if (typeof ensure === 'function') {
      try { await ensure.call(this.prover, name); } catch (e) { fetchError = ` (download failed: ${(e as Error).message})`; }
    }
    const p = this.prover.paths(name);
    if (!existsSync(p.wasm) || !existsSync(p.zkey)) {
      const hint = name === 'delegate'
        ? 'the site does not ship the delegate artifacts yet; put delegate.wasm and delegate.zkey (the ceremony\'s, docs/CEREMONY.md) there'
        : 'run fetch-circuits (h081-mcp fetch-circuits) to download them';
      throw new Error(`the ${name} proving artifacts are not in ${join(p.wasm, '..')}${fetchError}: ${hint}. Nothing was sent.`);
    }
  }

  private static seconds(days: number): bigint { return BigInt(Math.max(1, Math.round(days * 86400))); }

  private static checkDays(days?: number, unlockDays?: number): void {
    if (days !== undefined && !(days > 0)) throw new Error('days must be a positive number');
    if (unlockDays !== undefined && !(unlockDays > 0)) throw new Error('unlockDays must be a positive number');
    if (days !== undefined && unlockDays !== undefined && unlockDays > days) throw new Error('unlockDays must not exceed days');
  }

  /**
   * Gives a budget from this account's shielded balance to sub-account `agentIndex` (default: the first free one) or to
   * another agent's shielded address: a lifetime amount, an optional per-window cap (windowLen seconds, default a day),
   * per-payment cap, expiry and streaming unlock. Wraps SolanaWallet.grant; this account stays the owner and can take
   * back what is left (allowanceReclaim). Without `confirm` it returns the plan and sends nothing.
   */
  async allowanceGrant(req: GrantRequest): Promise<GrantResult | AllowancePlanResult> {
    const d = this.decimals, sym = MAINNET.usdg.symbol;
    const u = (x: bigint) => `${fromUnits(x, d)} ${sym}`;
    if (req.amount <= 0n) throw new Error('the amount must be positive');
    this.grantCeiling(req.amount);
    if (req.agentIndex !== undefined && req.to) throw new Error('give a sub-account (agentIndex) or another agent\'s address code, not both');
    H081Bank.checkDays(req.days, req.unlockDays);
    const windowLen = req.windowLen ?? 86400n;
    if (windowLen <= 0n) throw new Error('windowLen must be a positive number of seconds');
    if (req.to && req.to.pk === this.account.keys.pk) throw new Error('that is this account\'s own shielded address; grant to a sub-account (agentIndex) instead. Nothing was sent.');
    await this.sync();
    const shielded = this.owner.balance(this.usdg);
    if (req.amount > shielded) throw new Error(`the shielded balance is ${u(shielded)}, less than the budget ${u(req.amount)}; deposit first (h081_bank_deposit). Nothing was sent.`);
    const agentIndex = req.to ? undefined : (req.agentIndex ?? (await this.freeAgentIndex()));
    const to = req.to ?? this.agent(agentIndex!).account.address;
    const now = await this.pool.now();
    const streamRate = req.unlockDays === undefined ? 0n : (req.amount + H081Bank.seconds(req.unlockDays) - 1n) / H081Bank.seconds(req.unlockDays);
    const expiry = req.days === undefined ? 0n : now + H081Bank.seconds(req.days);
    const windowCap = req.windowCap ?? 0n, maxPerTx = req.maxPerTx ?? 0n;
    const rules = this.rulesOf({
      remaining: req.amount,
      policy: { lifetimeCap: req.amount, windowCap, windowLen, maxPerTx, expiry, recipientRoot: 0n, ownerPk: this.account.keys.pk, streamRate, streamStart: streamRate ? now : 0n, lender: 0n, pledgeBps: 0n },
    });
    const toText = agentIndex === undefined ? 'another agent\'s shielded address' : `sub-account ${agentIndex}`;
    if (!req.confirm) {
      return {
        sent: false, dryRun: true,
        plan: {
          action: 'grant', from: 'this account\'s shielded balance', to: toText, ...(agentIndex === undefined ? {} : { agentIndex }), rules,
          shielded, shieldedUsdg: fromUnits(shielded, d), shieldedAfter: shielded - req.amount, shieldedAfterUsdg: fromUnits(shielded - req.amount, d),
          sender: this.signer.publicKey.toBase58(),
          privacy: 'the agent wallet is visible on chain as the sender of a grant; the amount, the rules and the recipient are not',
        },
        next: 'nothing was sent. Call h081_allowance_grant again with the same arguments and confirm: true to send exactly this.',
      };
    }
    await this.requireArtifacts('grant');
    await this.needSol(GRANT_SOL_MIN, 'a grant stages a large proof and');
    let r: Awaited<ReturnType<SolanaWallet['grant']>>;
    try {
      r = await this.owner.grant(this.usdg, [{ to, amount: req.amount, windowCap, windowLen, maxPerTx, expiry, streamRate, ...(streamRate ? { streamStart: now } : {}) }]);
    } catch (e) {
      throw explained(e, { program: 'pool', ids: this.programIds });
    } finally { this.saveCache(); }
    const made = r.allowances[0];
    const allowanceId = allowanceCommitment(made);
    const left = this.owner.balance(this.usdg);
    return {
      sent: true, signature: r.tx.signature, to: toText, ...(agentIndex === undefined ? {} : { agentIndex }), allowanceId, rules: this.rulesOf(made),
      shielded: left, shieldedUsdg: fromUnits(left, d),
      next: agentIndex === undefined
        ? 'the other agent sees it in its h081_bank_balance (agentAllowances) and spends it with h081_pay; this account can take back what is left with h081_allowance_reclaim (h081_bank_balance grantedToOthers shows its current id; an id changes after every payment)'
        : `sub-account ${agentIndex} spends it with h081_pay (agentIndex: ${agentIndex}) or carves children from it with h081_allowance_delegate; h081_allowance_reclaim takes back what is left`,
    };
  }

  /**
   * Carves a child allowance for a sub-agent out of an allowance this account (or sub-account `agentIndex`) holds. The
   * child can never be looser than its parent (the delegate circuit enforces it; this checks it first, in words):
   * amount <= what the parent has left; per-window cap and streaming rate shared with what the parent keeps (the three
   * unused slots of a delegation take one unit of each); per-payment cap and expiry no looser; allow-list, owner,
   * window length and pledge inherited. Wraps SolanaWallet.delegate (src/delegation.ts chains larger splits; one child
   * here is one transaction). Without `confirm` it returns the plan and sends nothing.
   */
  async allowanceDelegate(req: DelegateRequest): Promise<DelegateResult | AllowancePlanResult> {
    const d = this.decimals, sym = MAINNET.usdg.symbol;
    const u = (x: bigint) => `${fromUnits(x, d)} ${sym}`;
    const at = (t: bigint) => new Date(Number(t) * 1000).toISOString();
    if (req.amount <= 0n) throw new Error('the amount must be positive');
    this.grantCeiling(req.amount);
    if ((req.toAgentIndex === undefined) === (req.to === undefined)) throw new Error('give exactly one recipient for the child: toAgentIndex (a sub-account) or toAddressCode (another agent\'s "h081-address:" code)');
    H081Bank.checkDays(req.days, req.unlockDays);
    const holders = await this.allowanceHolders(req.agentIndex, true);
    const where = req.agentIndex === undefined ? 'this account or its sub-accounts' : `sub-account ${req.agentIndex}`;
    const found = holders.flatMap((h) => h.wallet.agentAllowances(this.usdg).map((owned) => ({ ...h, owned }))).find((c) => c.owned.commitment === req.allowanceId);
    if (!found) throw new Error(`no open allowance with id ${req.allowanceId} is held by ${where} (h081_bank_balance lists them; an id changes after every payment or delegation). Nothing was sent.`);
    const { wallet, owned } = found;
    const parentAgentIndex = found.agentIndex;
    const a = owned.allowance, P = a.policy;
    const to = req.to ?? this.agent(req.toAgentIndex!).account.address;
    if (to.pk === wallet.account.keys.pk) throw new Error('the child must go to another account than the one holding the parent. Nothing was sent.');
    if (P.pledgeBps !== 0n && !owned.lender) throw new Error('the parent is pledged but its lender details were not found in its memo. Nothing was sent.');
    const now = await this.pool.now();
    if (P.expiry !== 0n && now >= P.expiry) throw new Error(`the parent expired at ${at(P.expiry)}; there is nothing to delegate. Nothing was sent.`);
    if (req.amount > a.remaining) throw new Error(`the parent has ${u(a.remaining)} left; a child can never get more than its parent has. Nothing was sent.`);
    const slots = BigInt(DELEGATE_OUTPUTS - 1);
    const keeps = a.remaining > req.amount ? 1n : 0n; // a parent that keeps something keeps at least one unit of cap and rate
    const share = (x: bigint) => (x * req.amount) / a.remaining;
    const clamp = (x: bigint, most: bigint) => (x < 1n ? 1n : x > most ? most : x);

    let windowCap: bigint;
    if (P.windowCap !== 0n) {
      const most = P.windowCap - slots - keeps;
      if (most < 1n) throw new Error(`the parent's per-window cap (${u(P.windowCap)}) is too small to split: a delegation takes ${slots} base units of it for unused slots. Nothing was sent.`);
      if (req.windowCap !== undefined && req.windowCap > most) {
        throw new Error(`a child's per-window cap can never exceed its parent's: at most ${u(most)} here (the parent's windowCap ${u(P.windowCap)} per ${P.windowLen} s is shared with what it keeps). Nothing was sent.`);
      }
      windowCap = req.windowCap ?? clamp(share(P.windowCap), most);
    } else windowCap = req.windowCap ?? 0n;

    const maxPerTx = req.maxPerTx ?? P.maxPerTx;
    if (P.maxPerTx !== 0n && maxPerTx > P.maxPerTx) throw new Error(`a child's per-payment cap can never exceed its parent's (maxPerTx ${u(P.maxPerTx)}). Nothing was sent.`);

    const expiry = req.days === undefined ? P.expiry : now + H081Bank.seconds(req.days);
    if (P.expiry !== 0n && expiry > P.expiry) throw new Error(`a child can never outlive its parent: the parent expires at ${at(P.expiry)}, ${req.days} days from now is later. Nothing was sent.`);

    let streamRate: bigint, streamStart: bigint | undefined;
    const asked = req.unlockDays === undefined ? undefined : (req.amount + H081Bank.seconds(req.unlockDays) - 1n) / H081Bank.seconds(req.unlockDays);
    if (P.streamRate !== 0n) {
      const most = P.streamRate - slots - keeps;
      if (most < 1n) throw new Error(`the parent's streaming rate is too small to split. Nothing was sent.`);
      if (asked !== undefined && asked > most) {
        throw new Error(`a child can never unlock faster than its parent: at most ${u(most * 86400n)} a day here (the parent unlocks ${u(P.streamRate * 86400n)} a day, shared with what it keeps); give a longer unlockDays. Nothing was sent.`);
      }
      streamRate = asked ?? clamp(share(P.streamRate), most);
      streamStart = undefined; // the SDK starts it where the parent's stream has got to (subStreamStartFloor)
    } else {
      streamRate = asked ?? 0n;
      streamStart = asked === undefined ? undefined : now;
    }

    // the SDK's own input builder, run before anything is proven: every check delegate makes (lender share, window carry, ...)
    const sub = { agentPk: to.pk, amount: req.amount, windowCap, maxPerTx, expiry, streamRate, ...(streamStart === undefined ? {} : { streamStart }) };
    let child: Allowance, residual: Allowance;
    try {
      const built = delegateInput({
        root: 0n, allowance: a, path: { pathElements: [], pathIndices: [], root: 0n, index: owned.index }, agent: wallet.account.keys, now,
        subs: [sub], lender: owned.lender as LenderRef | undefined, extDataHash: 0n,
      });
      child = built.subs[0];
      residual = built.residual;
    } catch (e) {
      throw new Error(`that child cannot be carved from allowance ${req.allowanceId}: ${(e as Error).message}. Nothing was sent.`);
    }
    const toText = req.to ? 'another agent\'s shielded address' : `sub-account ${req.toAgentIndex}`;
    const parent = { parentId: req.allowanceId, ...(parentAgentIndex === undefined ? {} : { parentAgentIndex }) };
    if (!req.confirm) {
      return {
        sent: false, dryRun: true,
        plan: {
          action: 'delegate', ...parent, parentRemaining: a.remaining, parentRemainingUsdg: fromUnits(a.remaining, d), to: toText,
          ...(req.toAgentIndex === undefined ? {} : { toAgentIndex: req.toAgentIndex }),
          child: this.rulesOf(child), parentKeeps: this.rulesOf(residual),
          inherited: 'owner, window length, recipient allow-list and pledge come from the parent; the owner can reclaim the child',
          sender: this.signer.publicKey.toBase58(),
          privacy: 'the agent wallet is visible on chain as the sender of a delegation; amounts, rules and recipient are not',
        },
        next: 'nothing was sent. Call h081_allowance_delegate again with the same arguments and confirm: true to send exactly this.',
      };
    }
    await this.requireArtifacts('delegate');
    await this.needSol(DEPOSIT_SOL_MIN, 'a delegation the agent key sends');
    let r: Awaited<ReturnType<SolanaWallet['delegate']>>;
    try {
      r = await wallet.delegate(owned, [{ to, amount: req.amount, windowCap, maxPerTx, expiry, streamRate, ...(streamStart === undefined ? {} : { streamStart }) }]);
    } catch (e) {
      throw explained(e, { program: 'pool', ids: this.programIds });
    } finally { this.saveCache(); }
    if (req.toAgentIndex !== undefined) this.touch(req.toAgentIndex);
    const made = r.subs[0];
    const allowanceId = allowanceCommitment(made);
    return {
      sent: true, signature: r.tx.signature, signatures: r.steps.map((s) => s.tx.signature), ...parent, to: toText,
      ...(req.toAgentIndex === undefined ? {} : { toAgentIndex: req.toAgentIndex }), allowanceId, rules: this.rulesOf(made),
      residualId: r.residual.remaining > 0n ? allowanceCommitment(r.residual) : undefined,
      residualRemaining: r.residual.remaining, residualRemainingUsdg: fromUnits(r.residual.remaining, d),
      next: req.toAgentIndex !== undefined
        ? `sub-account ${req.toAgentIndex} spends it with h081_pay (agentIndex: ${req.toAgentIndex}, allowanceId: ${allowanceId})`
        : 'the other agent sees it in its h081_bank_balance (agentAllowances) and spends it with h081_pay',
    };
  }

  /**
   * The owner takes back what is left of an allowance it granted (to a sub-account or another agent) into its shielded
   * balance. Wraps SolanaWallet.reclaim; a pledged allowance still routes its lender share. Without `confirm` it returns
   * the plan and sends nothing.
   */
  async allowanceReclaim(req: ReclaimRequest): Promise<ReclaimResult | AllowancePlanResult> {
    const d = this.decimals;
    await this.sync();
    const owned = this.owner.grantedAllowances().find((a) => a.commitment === req.allowanceId);
    if (!owned) throw new Error(`no open allowance with id ${req.allowanceId} was granted by this account (h081_bank_balance lists subAccounts and grantedToOthers with reclaimable: true; an id changes after every payment). Nothing was sent.`);
    const a = owned.allowance;
    if (a.remaining === 0n) throw new Error('that allowance has nothing left to reclaim. Nothing was sent.');
    if (a.policy.pledgeBps !== 0n && !owned.lender) throw new Error('it is pledged but its lender details were not found in its memo. Nothing was sent.');
    const share = lenderShare(a, a.remaining);
    const byPk = this.agentPks();
    const holder = byPk.has(a.agentPk) ? `sub-account ${byPk.get(a.agentPk)}` : 'another agent';
    if (!req.confirm) {
      return {
        sent: false, dryRun: true,
        plan: {
          action: 'reclaim', allowanceId: req.allowanceId, heldBy: holder, reclaimed: a.remaining, reclaimedUsdg: fromUnits(a.remaining, d),
          lenderShare: share, backToShielded: a.remaining - share, backToShieldedUsdg: fromUnits(a.remaining - share, d),
          ...(share ? { note: `the allowance is pledged: ${a.policy.pledgeBps} bps of what is reclaimed goes to its lender` } : {}),
          sender: this.signer.publicKey.toBase58(),
        },
        next: 'nothing was sent. Call h081_allowance_reclaim again with the same allowanceId and confirm: true to send exactly this.',
      };
    }
    await this.requireArtifacts('spend');
    await this.needSol(DEPOSIT_SOL_MIN, 'a reclaim the agent key sends');
    let r: Awaited<ReturnType<SolanaWallet['reclaim']>>;
    try { r = await this.owner.reclaim(owned); } catch (e) {
      throw explained(e, { program: 'pool', ids: this.programIds });
    } finally { this.saveCache(); }
    const left = this.owner.balance(this.usdg);
    return {
      sent: true, signature: r.tx.signature, allowanceId: req.allowanceId, reclaimed: a.remaining, reclaimedUsdg: fromUnits(a.remaining, d), lenderShare: share,
      shielded: left, shieldedUsdg: fromUnits(left, d),
    };
  }

  // ---- capacity_stake (H081)

  private async stakeTokenProgram(): Promise<PublicKey> {
    const info = await this.connection.getAccountInfo(this.stakeMint, 'confirmed');
    if (!info) throw new Error(`${MAINNET.h081.symbol} mint ${this.stakeMint.toBase58()} not found`);
    return info.owner;
  }

  async stakeView(): Promise<StakeView> {
    const pid = this.config.capacityProgramId;
    const tp = await this.stakeTokenProgram();
    const ata = getAssociatedTokenAddressSync(this.stakeMint, this.signer.publicKey, false, tp);
    const [c, walletH081, now] = await Promise.all([readCapacity(this.connection, pid, this.stakeMint, this.signer.publicKey), this.pool.tokenBalance(ata), this.pool.now()]);
    return {
      signer: this.signer.publicKey.toBase58(), walletH081, staked: c.stake.staked, pending: c.stake.pending, readyAt: c.stake.readyAt, now,
      desks: c.desks, shieldCap: c.shieldCap, totalStaked: c.config.totalStaked,
      caps: { maxPerStake: c.config.maxPerStake, maxTotal: c.config.maxTotal, paused: c.config.stakingPaused }, cooldownDays: 30,
    };
  }

  private async sendStake(ixs: TransactionInstruction[]): Promise<string> {
    try { return await sendLegacy(this.connection, this.signer, [this.signer], ixs); } catch (e) { throw explained(e, { program: 'capacity', ids: this.programIds }); }
  }

  async stake(amount: bigint): Promise<StakeView & { signature: string }> {
    const v = await this.stakeView(), d = MAINNET.h081.decimals, sym = MAINNET.h081.symbol;
    if (amount <= 0n) throw new Error('the amount must be positive');
    if (v.caps.paused) throw new Error('StakingPaused: new staking is paused for now; unstaking still works.');
    if (amount > v.caps.maxPerStake) throw new Error(`StakeCap: at most ${fromUnits(v.caps.maxPerStake, d)} ${sym} per stake.`);
    if (v.totalStaked + amount > v.caps.maxTotal) throw new Error(`StakeCap: at most ${fromUnits(v.caps.maxTotal, d)} ${sym} staked in total.`);
    if (amount > v.walletH081) throw new Error(`the agent wallet holds ${fromUnits(v.walletH081, d)} ${sym}, less than ${fromUnits(amount, d)}.`);
    const tp = await this.stakeTokenProgram();
    const from = getAssociatedTokenAddressSync(this.stakeMint, this.signer.publicKey, false, tp);
    const signature = await this.sendStake([stakeIx(this.config.capacityProgramId, this.signer.publicKey, this.stakeMint, from, amount, tp)]);
    return { signature, ...(await this.stakeView()) };
  }

  async requestUnstake(amount: bigint): Promise<StakeView & { signature: string }> {
    const v = await this.stakeView(), d = MAINNET.h081.decimals, sym = MAINNET.h081.symbol;
    if (amount <= 0n) throw new Error('the amount must be positive');
    if (amount > v.staked) throw new Error(`MoreThanStaked: only ${fromUnits(v.staked, d)} ${sym} is staked.`);
    const signature = await this.sendStake([requestUnstakeIx(this.config.capacityProgramId, this.signer.publicKey, this.stakeMint, amount)]);
    return { signature, ...(await this.stakeView()) };
  }

  async unstake(): Promise<StakeView & { signature: string }> {
    const v = await this.stakeView();
    if (v.pending === 0n) throw new Error('NothingPending: nothing is waiting to unstake; request_unstake first.');
    if (v.now < v.readyAt) throw new Error(`Cooldown: unstakable from ${new Date(Number(v.readyAt) * 1000).toISOString()}.`);
    const tp = await this.stakeTokenProgram();
    const to = getAssociatedTokenAddressSync(this.stakeMint, this.signer.publicKey, false, tp);
    const signature = await this.sendStake([
      createAtaIdempotentIx(this.signer.publicKey, this.signer.publicKey, this.stakeMint, tp),
      unstakeIx(this.config.capacityProgramId, this.signer.publicKey, this.stakeMint, to, tp),
    ]);
    return { signature, ...(await this.stakeView()) };
  }

  // ---- loans (stream_loan): the borrower side

  async loanSlot(loanRef: bigint): Promise<SlotView | null> {
    const info = await this.connection.getAccountInfo(slotPda(loanRef, this.config.loanProgramId), 'confirmed');
    if (!info) return null;
    let s: SlotAccount;
    try { s = decodeSlot(info.data); } catch { return null; }
    return {
      loanRef: s.loanRef, lender: s.lender.toBase58(), funded: s.funded, settled: s.settled, principal: s.principal, repaid: s.repaid,
      expiry: s.expiry, pledgeBps: s.pledgeBps, payoutTo: s.payoutTo.toBase58(),
    };
  }

  /** Pure pricing (stream_loan::max_principal and the 0.25% origination fee) plus, with a loanRef, the slot on chain. */
  async loanQuote(q: { termsCode?: string; minRemaining?: bigint; pledgeBps?: number; principal?: bigint; loanRef?: bigint }): Promise<LoanQuote> {
    let pledgeBps = q.pledgeBps, loanRef = q.loanRef;
    if (q.termsCode) {
      const t = decodeLoanTerms(this.loanCodeContext, q.termsCode);
      pledgeBps ??= Number(t.pledgeBps);
      loanRef ??= t.loanRef;
    }
    if (pledgeBps === undefined && loanRef === undefined) throw new Error('give a termsCode, a pledgeBps or a loanRef');
    const slot = loanRef === undefined ? undefined : await this.loanSlot(loanRef);
    if (pledgeBps === undefined && slot?.funded) pledgeBps = Number(slot.pledgeBps);
    const bps = pledgeBps ?? 0;
    const minRemaining = q.minRemaining ?? 0n;
    const max = maxPrincipal(minRemaining, bps);
    const principal = q.principal ?? max;
    if (principal > max) throw new Error(`PrincipalTooLarge: at most ${fromUnits(max, this.decimals)} USDG against ${fromUnits(minRemaining, this.decimals)} USDG pledged at ${bps} bps.`);
    const fee = originationFee(principal);
    return {
      pledgeBps: bps, minRemaining, maxPrincipal: max, principal, originationFee: fee, originationFeeBps: 25, payout: principal - fee, loanRef, slot,
      note: 'terms come from a lender off-chain (no on-chain offer book); h081_loan_borrow pledges to them and returns the proof code the lender funds against',
    };
  }

  /** Sub-account `i` of this agent (its own shielded account, granted to by the owner account). */
  agent(i: number): { account: Account; wallet: SolanaWallet } {
    let a = this.agents.get(i);
    if (!a) {
      const account = new Account(deriveAgentSk(this.signer, i, this.derivation));
      const wallet = new SolanaWallet(account, this.pool, this.signer);
      wallet.registerMint(this.usdg);
      a = { account, wallet };
      this.agents.set(i, a);
    }
    return a;
  }

  private async freeAgentIndex(): Promise<number> {
    const used = new Set(this.subAccountsInUse());
    for (let i = 0; i < MAX_AGENTS; i++) if (!used.has(i)) return i;
    throw new Error(`all ${MAX_AGENTS} sub-accounts are in use; pass agentIndex to add to one`);
  }

  /**
   * Borrower flow, as the site does it: grant a pledged, streaming allowance from the shielded balance to a
   * sub-account, then make the stream proof for the lender with the agent wallet's USDG account as payout.
   */
  async borrow(termsCode: string, rules: BorrowRules): Promise<BorrowResult> {
    const d = this.decimals, sym = MAINNET.usdg.symbol;
    const t = decodeLoanTerms(this.loanCodeContext, termsCode);
    const lenderSlot = slotPda(t.loanRef, this.config.loanProgramId);
    // The lender's pledged share runs over the WHOLE budget and stream_loan does not stop crediting at the principal,
    // so a budget larger than the principal needs lets the lender take more than it lent. Size the budget to the
    // principal (minRemainingFor) and refuse a bigger one.
    if (rules.principal !== undefined && rules.principal <= 0n) throw new Error('the principal must be positive');
    const needed = rules.principal === undefined ? undefined : minRemainingFor(rules.principal, BigInt(t.pledgeBps));
    const budget = rules.budget ?? needed;
    if (budget === undefined) throw new Error('give a budget or a principal (the budget is then sized to it)');
    if (budget <= 0n) throw new Error('the budget must be positive');
    if (needed !== undefined && budget > needed) {
      const share = maxPrincipal(budget, Number(t.pledgeBps));
      throw new Error(
        `Overpay: a budget of ${fromUnits(budget, d)} ${sym} pledged at ${Number(t.pledgeBps) / 100}% lets the lender take up to ${fromUnits(share, d)} ${sym}, ` +
        `more than the ${fromUnits(rules.principal!, d)} ${sym} you borrow. Use a budget of ${fromUnits(needed, d)} ${sym} (or leave budget out and it is sized for you). Nothing was sent.`,
      );
    }
    if (!(rules.unlockDays > 0) || rules.unlockDays > rules.days) throw new Error('the budget must unlock within the allowance lifetime (0 < unlockDays <= days)');
    const slot = await this.loanSlot(t.loanRef);
    if (!slot) throw new Error(`loan slot #${t.loanRef} does not exist on chain.`);
    if (slot.funded) throw new Error(`AlreadyFunded: loan slot #${t.loanRef} is already funded.`);
    await this.sync();
    const shielded = this.owner.balance(this.usdg);
    if (budget > shielded) throw new Error(`the shielded balance is ${fromUnits(shielded, d)} ${sym}, less than the budget ${fromUnits(budget, d)}; deposit first.`);
    const lamports = await this.connection.getBalance(this.signer.publicKey, 'confirmed');
    if (lamports < 0.1 * LAMPORTS_PER_SOL) throw new Error(`the agent wallet holds ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL; a pledge stages a large proof and needs about 0.1 SOL (most of it refunded).`);
    const i = rules.agentIndex ?? (await this.freeAgentIndex());
    const a = this.agent(i);
    const now = await this.pool.now();
    const secs = BigInt(Math.max(1, Math.round(rules.unlockDays * 86400)));
    const streamRate = (budget + secs - 1n) / secs;
    const expiry = now + BigInt(Math.round(rules.days * 86400));
    let grantSignature: string;
    try {
      const r = await this.owner.grant(this.usdg, [{
        to: a.account.address, amount: budget, windowCap: rules.dailyCap ?? 0n, windowLen: 86400n, maxPerTx: rules.maxPerTx ?? 0n,
        expiry, streamRate, streamStart: now,
        pledge: { lender: lenderSlot, loanRef: t.loanRef, pledgeBps: t.pledgeBps, lenderViewPub: t.lenderViewPub },
      }]);
      grantSignature = r.tx.signature;
    } catch (e) {
      throw explained(e, { program: 'pool', ids: this.programIds });
    } finally { this.saveCache(); }
    await a.wallet.sync();
    const owned = a.wallet.agentAllowances(this.usdg).filter((x) => x.lender?.loanRef === t.loanRef).sort((x, y) => y.index - x.index)[0];
    if (!owned || !owned.lender || !owned.lenderKey) throw new Error(`the pledged allowance was granted (${grantSignature}) but not found after sync; retry h081_loan_borrow later with the same agentIndex ${i}`);
    const payout = await this.pool.ensureAta(this.signer, this.usdg, this.signer.publicKey);
    const P = owned.allowance.policy;
    // The proof's bound fixes the loan amount: stream_loan funds exactly max_principal(minRemaining, pledgeBps), so the
    // borrower names the principal here and the bound reveals the ask, not the balance. Default: the whole pledge.
    const ceiling = maxPrincipal(owned.allowance.remaining, P.pledgeBps);
    const principal = rules.principal ?? ceiling;
    if (principal <= 0n) throw new Error('the principal must be positive');
    if (principal > ceiling) throw new Error(`PrincipalTooLarge: at most ${fromUnits(ceiling, d)} ${sym} against a budget of ${fromUnits(owned.allowance.remaining, d)} ${sym} pledged at ${t.pledgeBps} bps.`);
    const minRemaining = minRemainingFor(principal, BigInt(t.pledgeBps));
    const s = await a.wallet.proveStream(owned, { minRemaining, minRate: P.streamRate, audience: payoutAudience(payout) });
    const ok = await this.prover.verify('stream', s.proof).catch(() => true); // a missing vkey must not block; the lender verifies on chain
    if (!ok) throw new Error('the stream proof did not verify locally; the proving artifacts may be corrupt (run fetch-circuits)');
    const proofCode = encodeLoanProof(this.loanCodeContext, { ref: t.loanRef, payout, proof: s.proof.proof, args: s.args });
    const max = maxPrincipal(minRemaining, P.pledgeBps); // == principal
    return {
      agentIndex: i, allowanceId: owned.commitment, loanRef: t.loanRef, pledgeBps: t.pledgeBps, grantSignature, proofCode, principal: max, maxPrincipal: max,
      originationFeeAtMax: originationFee(max), payoutAccount: payout.toBase58(), streamRate, expiry,
      next: `hand proofCode to the lender; they fund exactly ${fromUnits(max, d)} ${sym} against it (the program accepts no other amount), and the principal minus the 0.25% origination fee arrives in ${payout.toBase58()} when they do`,
    };
  }

  // ---- loans (stream_loan): the lender side (h081_lend)
  //
  // The agent key owns the loan slots (stream_loan checks the slot owner's signature on open, fund, claim, collect and
  // settle), so a relayer cannot send these: the agent wallet is publicly the lender, and the principal and the
  // borrower's payout account are public. What stays private is the borrower's budget and every payment it makes.
  // Funding moves the agent wallet's own USDG: it is refused over H081_MAX_LEND and, like open, settle and close, only
  // returns the plan unless confirm: true.

  /** The lender wallet: slots owned by the agent key, pledged notes read with the lender viewing key (keys.ts deriveLenderSk). */
  lender(): SolanaLoanLenderWallet {
    if (!this.lenderWallet) {
      const view = viewingKeyFromSk(deriveLenderSk(this.signer, this.derivation));
      this.lenderWallet = new SolanaLoanLenderWallet(this.pool, this.signer, view, this.config.loanProgramId, this.config.loanTreasury);
    }
    return this.lenderWallet;
  }

  /** Where loan codes belong: this cluster, the stream_loan program, USDG (the site's loan code context). */
  get loanCodeContext(): CodeContext {
    return { cluster: this.config.cluster, program: this.config.loanProgramId.toBase58(), mint: this.usdg.toBase58() };
  }

  /** The "h081-loan-terms:" code for a slot of this agent: what a borrower gives h081_loan_borrow. */
  loanTermsCode(loanRef: bigint, pledgeBps: bigint): string {
    return encodeLoanTerms(this.loanCodeContext, { loanRef, pledgeBps, lenderViewPub: this.lender().view.pub });
  }

  private static lendPlan(plan: Record<string, unknown>, next: string): LendPlanResult {
    return { sent: false, dryRun: true, plan, next: `nothing was sent. ${next}` };
  }

  private loanErr(e: unknown): Error {
    return explained(e, { program: 'loan', ids: this.programIds });
  }

  /** The slot `loanRef` read for a lender action: it must exist and belong to this agent key. */
  private async mySlot(loanRef: bigint, what: string): Promise<SlotAccount> {
    const info = await this.connection.getAccountInfo(slotPda(loanRef, this.config.loanProgramId), 'confirmed');
    if (!info) throw new Error(`loan slot #${loanRef} does not exist on chain (or its lender closed it). Nothing was sent.`);
    let s: SlotAccount;
    try { s = decodeSlot(info.data); } catch { throw new Error(`loan slot #${loanRef} could not be read. Nothing was sent.`); }
    if (!s.lender.equals(this.signer.publicKey)) {
      throw new Error(`loan slot #${loanRef} belongs to another lender (${s.lender.toBase58()}); only its owner can ${what}. Nothing was sent.`);
    }
    return s;
  }

  /** Opens a loan slot owned by the agent key and returns its terms code. Without `confirm` it returns the plan. */
  async lendOpen(req: { pledgeBps: bigint; confirm?: boolean }): Promise<LendOpenResult | LendPlanResult> {
    const bps = req.pledgeBps;
    if (bps < PLEDGE_BPS_MIN || bps > PLEDGE_BPS_MAX) throw new Error('pledgeBps must be 100..9000: the share of every borrower payment routed to this slot (1% to 90%). Nothing was sent.');
    const reg = await this.connection.getAccountInfo(registryPda(this.config.loanProgramId), 'confirmed');
    if (!reg) throw new Error(`the stream_loan registry is not initialized on ${this.config.cluster}; no slot can be opened. Nothing was sent.`);
    const nextRef = decodeRegistry(reg.data).nextLoanRef;
    if (!req.confirm) {
      return H081Bank.lendPlan({
        action: 'open', loanRef: nextRef, note: 'the slot number is the next free one now; if another lender takes it first, the next one is used',
        pledgeBps: bps, sharePercent: Number(bps) / 100, lender: this.signer.publicKey.toBase58(), slot: slotPda(nextRef, this.config.loanProgramId).toBase58(),
        cost: 'the slot account rent and the fee, in SOL from the agent wallet; no USDG moves until fund',
        privacy: 'the agent wallet is public on chain as the owner of the slot',
      }, 'Call h081_lend again with action "open", the same pledgeBps and confirm: true to open it; the result carries the "h081-loan-terms:" code for the borrower.');
    }
    await this.needSol(LEND_SOL_MIN, 'opening a loan slot');
    let loanRef: bigint;
    try { loanRef = await this.lender().openSlot(); } catch (e) { throw this.loanErr(e); }
    return {
      sent: true, loanRef, pledgeBps: bps, slot: slotPda(loanRef, this.config.loanProgramId).toBase58(), termsCode: this.loanTermsCode(loanRef, bps),
      next: 'hand termsCode to the borrower (h081_loan_borrow); it returns an "h081-loan-proof:" code: fund the loan with h081_lend action "fund" and that proofCode. h081_lend action "status" with this loanRef and pledgeBps gives the terms code again.',
    };
  }

  /** The proof result the SDK and snarkjs take, rebuilt from a proof code (the public signals in stream.circom's order). */
  static streamProofResult(proof: SolidityProof, a: StreamArgs): ProofResult {
    const publicSignals = [
      a.root, a.minRemaining, a.minRate, fieldOf(a.lender), a.loanRef, BigInt(a.pledgeBps), a.expiry, a.lifetimeCap, a.pledgePaid, a.agentPk, a.audience,
      a.streamStart, fieldOf(a.asset),
    ];
    const s = (x: bigint) => x.toString();
    return {
      proof, publicSignals,
      raw: {
        proof: {
          pi_a: [s(proof.a[0]), s(proof.a[1]), '1'], pi_b: [[s(proof.b[0][1]), s(proof.b[0][0])], [s(proof.b[1][1]), s(proof.b[1][0])], ['1', '0']],
          pi_c: [s(proof.c[0]), s(proof.c[1]), '1'], protocol: 'groth16', curve: 'bn128',
        },
        publicSignals: publicSignals.map(s),
      },
    };
  }

  /**
   * Funds slot `loanRef` against a borrower's "h081-loan-proof:" code: the principal leaves the agent wallet's USDG
   * account; the borrower's payout account receives it minus the 0.25% origination fee (to the protocol treasury).
   * Checked before anything is sent: the code (checksum, kind, network), the slot (exists, is this agent's, not funded),
   * the proof (this slot, USDG, made for that payout account, not expired, verified locally when the stream vkey is
   * there, and backed by a live pledged note this lender can read), the amount (exactly what the proof backs, at most
   * H081_MAX_LEND, held by the wallet). Without `confirm` it returns the plan.
   */
  async lendFund(req: { proofCode: string; loanRef?: bigint; principal?: bigint; pledgeBps?: bigint; confirm?: boolean }): Promise<LendFundResult | LendPlanResult> {
    const d = this.decimals, sym = MAINNET.usdg.symbol;
    const u = (x: bigint) => `${fromUnits(x, d)} ${sym}`;
    const c = decodeLoanProof(this.loanCodeContext, req.proofCode);
    const ref = req.loanRef ?? c.ref;
    if (c.ref !== ref) throw new Error(`that proof code is for loan slot #${c.ref}, not #${ref}. Nothing was sent.`);
    const a = c.args;
    if (a.loanRef !== ref) throw new Error(`the proof inside the code is for loan slot #${a.loanRef}, not #${ref}: the code was put together wrongly. Nothing was sent.`);
    const slot = await this.mySlot(ref, 'fund it');
    if (slot.funded) throw new Error(`AlreadyFunded: loan slot #${ref} is already funded. Nothing was sent.`);
    if (!a.lender.equals(slotPda(ref, this.config.loanProgramId))) throw new Error('the proof names another lender than this slot. Nothing was sent.');
    if (!a.asset.equals(this.usdg)) throw new Error(`the proof is over another asset (${a.asset.toBase58()}), not ${sym}. Nothing was sent.`);
    if (a.audience !== payoutAudience(c.payout)) throw new Error('the proof was not made for the payout account in the code (its audience differs). Nothing was sent.');
    if (req.pledgeBps !== undefined && BigInt(a.pledgeBps) < req.pledgeBps) {
      throw new Error(`the proof pledges ${a.pledgeBps / 100}% of each payment, less than the ${Number(req.pledgeBps) / 100}% this slot asked for; the borrower must pledge with this slot's terms code. Nothing was sent.`);
    }
    const principal = maxPrincipal(a.minRemaining, a.pledgeBps);
    if (principal <= 0n) throw new Error('the proof backs no principal (its bound is 0). Nothing was sent.');
    if (req.principal !== undefined && req.principal !== principal) {
      throw new Error(`the proof asks for exactly ${u(principal)}; the loan program funds that amount and no other. Lend ${u(principal)}, or ask the borrower for a proof for ${u(req.principal)}. Nothing was sent.`);
    }
    if (this.config.maxLend !== undefined && principal > this.config.maxLend) {
      throw new Error(`over the operator ceiling H081_MAX_LEND (${u(this.config.maxLend)} per loan; this proof asks for ${u(principal)}). Nothing was sent.`);
    }
    const now = await this.pool.now();
    if (a.expiry !== 0n && a.expiry <= now) throw new Error(`the borrower's pledged allowance expired at ${new Date(Number(a.expiry) * 1000).toISOString()}; nothing would repay this loan. Nothing was sent.`);
    const [walletUsdg, payoutInfo] = await Promise.all([this.walletUsdgAccount().then((ata) => this.pool.tokenBalance(ata)), this.connection.getAccountInfo(c.payout, 'confirmed')]);
    if (!payoutInfo) throw new Error(`the borrower's payout account ${c.payout.toBase58()} does not exist; the borrower must create its ${sym} account first. Nothing was sent.`);
    if (walletUsdg < principal) {
      throw new Error(`the agent wallet ${this.signer.publicKey.toBase58()} holds ${u(walletUsdg)}, less than the ${u(principal)} this loan needs (lending uses the wallet's public ${sym}, not the shielded balance: withdraw first). Nothing was sent.`);
    }
    const stream = H081Bank.streamProofResult(c.proof, a);
    let verifiedLocally = false;
    if (existsSync(this.prover.paths('stream').vkey)) {
      let ok = false;
      try { ok = await this.prover.verify('stream', stream); } catch { ok = false; }
      if (!ok) throw new Error('the borrower\'s stream proof does not verify (stream.vkey.json): the code does not hold a valid proof. Nothing was sent.');
      verifiedLocally = true;
    }
    // what the SDK's fund checks first: a live pledged note this lender can read that the proof describes
    const lender = this.lender();
    try { await lender.sync(); } catch (e) { throw new Error(`could not read the pool's events to find the pledged note (${(e as Error).message}). Nothing was sent.`); }
    const asset = fieldOf(this.usdg);
    const backing = lender.current(ref).find((n) => {
      const x = n.allowance, P = x.policy;
      return x.agentPk === a.agentPk && P.lifetimeCap === a.lifetimeCap && P.expiry === a.expiry && P.pledgeBps === BigInt(a.pledgeBps)
        && x.pledgePaid === a.pledgePaid && P.streamStart === a.streamStart && x.asset === asset && x.remaining >= a.minRemaining && P.streamRate >= a.minRate;
    });
    if (!backing) {
      throw new Error(`the proof does not match a live allowance pledged to loan slot #${ref} that this lender can read: the borrower must pledge with this agent's terms code for slot #${ref} (h081_lend action "status" with pledgeBps gives it again). Nothing was sent.`);
    }
    const fee = originationFee(principal);
    const terms = {
      loanRef: ref, principal, principalUsdg: fromUnits(principal, d), originationFee: fee, borrowerReceives: principal - fee, borrowerReceivesUsdg: fromUnits(principal - fee, d),
      payoutTo: c.payout.toBase58(), pledgeBps: a.pledgeBps, budgetBacking: a.minRemaining, budgetBackingUsdg: fromUnits(a.minRemaining, d),
      streamsPerDayUsdg: fromUnits(a.minRate * 86400n, d), expiry: a.expiry, expiresAt: a.expiry === 0n ? null : new Date(Number(a.expiry) * 1000).toISOString(),
    };
    if (!req.confirm) {
      return H081Bank.lendPlan({
        action: 'fund', ...terms, from: `the agent wallet's ${sym} account (public)`, walletUsdg, walletUsdgAfter: walletUsdg - principal,
        proofChecked: verifiedLocally
          ? 'verified locally and matched to a live pledged note; the program verifies it again on chain'
          : 'matched to a live pledged note; the program verifies the proof on chain (no stream.vkey.json here to check it locally)',
        risk: `repayment is only the borrower's ${a.pledgeBps / 100}% share of each payment its allowance makes, until the principal is repaid; what is unpaid 7 days after expiry is a shortfall`,
        privacy: 'the agent wallet is public as the lender, and the principal and payout account are public; the borrower\'s budget and payments are not',
      }, 'Call h081_lend again with action "fund", the same proofCode and confirm: true to lend exactly this.');
    }
    await this.needSol(DEPOSIT_SOL_MIN, 'funding a loan (it stages the proof in a buffer)');
    let tx: Awaited<ReturnType<SolanaLoanLenderWallet['fund']>>;
    try { tx = await lender.fund(ref, { proof: stream, args: a }, this.usdg, principal, c.payout); } catch (e) { throw this.loanErr(e); }
    return {
      sent: true, signature: tx.signature, ...terms,
      next: `the borrower received ${fromUnits(principal - fee, d)} ${sym}. Repayments: h081_lend action "status" shows what is claimable; "claim" pulls the vested share, "collect" takes shares routed to the slot; "settle" once it is repaid.`,
    };
  }

  /** One slot as its lender sees it (status). */
  private async lendView(ref: bigint, s: SlotAccount, now: bigint, pledgeBps?: bigint): Promise<LendSlotView> {
    const d = this.decimals;
    const lender = this.lender();
    const [inbox, ledger] = await Promise.all([
      s.funded ? this.pool.tokenBalance(slotInbox(ref, s.asset, s.tokenProgram, this.config.loanProgramId)).catch(() => 0n) : Promise.resolve(0n),
      s.funded ? lender.ledger(ref, s.asset).catch(() => undefined) : Promise.resolve(undefined),
    ]);
    const mine = s.lender.equals(this.signer.publicKey);
    const claimable = mine && s.funded && !s.settled ? lender.claimable(ref, now) : 0n;
    const outstanding = s.funded && s.principal > s.repaid ? s.principal - s.repaid : 0n;
    const collectable = inbox + (ledger?.held ?? 0n);
    const view: LendSlotView = {
      loanRef: ref, slot: slotPda(ref, this.config.loanProgramId).toBase58(), lender: s.lender.toBase58(), mine,
      state: !s.funded ? 'open' : s.settled ? 'settled' : outstanding === 0n ? 'repaid' : 'funded',
      funded: s.funded, settled: s.settled, principal: s.principal, principalUsdg: fromUnits(s.principal, d), repaid: s.repaid, repaidUsdg: fromUnits(s.repaid, d),
      outstanding, outstandingUsdg: fromUnits(outstanding, d), claimable, claimableUsdg: fromUnits(claimable, d), collectable, collectableUsdg: fromUnits(collectable, d),
      pledgeBps: s.funded ? s.pledgeBps : pledgeBps ?? null, expiry: s.expiry,
      expiresAt: s.funded && s.expiry !== 0n ? new Date(Number(s.expiry) * 1000).toISOString() : null,
      shortfall: shortfallOf(s, now, inbox), payoutTo: s.funded ? s.payoutTo.toBase58() : null,
      borrowerWithheldMemo: mine && s.funded && lender.opaque(ref),
    };
    if (!s.funded && mine && pledgeBps !== undefined) view.termsCode = this.loanTermsCode(ref, pledgeBps);
    return view;
  }

  /**
   * The slots of this agent (or slot `loanRef`, anyone's): funded, repaid, outstanding, what the lender can claim
   * (vested share of the pledged stream) and collect (shares already routed to the slot), shortfall. With `pledgeBps`
   * an open slot of this agent shows its terms code again. Read-only.
   */
  async lendStatus(req: { loanRef?: bigint; pledgeBps?: bigint } = {}): Promise<{ slots: LendSlotView[]; note?: string }> {
    if (req.pledgeBps !== undefined && (req.pledgeBps < PLEDGE_BPS_MIN || req.pledgeBps > PLEDGE_BPS_MAX)) throw new Error('pledgeBps must be 100..9000 (1% to 90%)');
    const pid = this.config.loanProgramId;
    let refs: bigint[] = [];
    let note: string | undefined;
    if (req.loanRef !== undefined) refs = [req.loanRef];
    else {
      try {
        // Slot: 8-byte discriminator, loan_ref u64, lender pubkey at offset 16
        const found = await this.connection.getProgramAccounts(pid, { commitment: 'confirmed', filters: [{ memcmp: { offset: 16, bytes: this.signer.publicKey.toBase58() } }] });
        for (const f of found) { try { refs.push(decodeSlot(f.account.data).loanRef); } catch { /* not a slot */ } }
      } catch (e) {
        note = `this RPC cannot list the agent's slots (${(e as Error).message}); pass loanRef`;
      }
    }
    const now = await this.pool.now();
    const slots: LendSlotView[] = [];
    let synced = false;
    for (const ref of [...new Set(refs)].sort((x, y) => (x < y ? 1 : -1))) {
      const info = await this.connection.getAccountInfo(slotPda(ref, pid), 'confirmed');
      if (!info) {
        if (req.loanRef !== undefined) throw new Error(`loan slot #${ref} does not exist on chain (or its lender closed it)`);
        continue;
      }
      let s: SlotAccount;
      try { s = decodeSlot(info.data); } catch { continue; }
      if (s.funded && !s.settled && s.lender.equals(this.signer.publicKey) && !synced) { await this.lender().sync(); synced = true; }
      slots.push(await this.lendView(ref, s, now, req.pledgeBps));
    }
    return note ? { slots, note } : { slots };
  }

  /** Forwards the shares routed to slot `loanRef` (sync) and takes those the registry could not forward (collect). */
  async lendCollect(req: { loanRef: bigint }): Promise<LendSentResult> {
    const ref = req.loanRef, d = this.decimals;
    const s = await this.mySlot(ref, 'collect its repayments');
    if (!s.funded) throw new Error(`loan slot #${ref} has not lent anything yet; there is nothing to collect. Nothing was sent.`);
    const lender = this.lender();
    const inbox = await this.pool.tokenBalance(slotInbox(ref, s.asset, s.tokenProgram, this.config.loanProgramId)).catch(() => 0n);
    const held = (await lender.ledger(ref, s.asset).catch(() => undefined))?.held ?? 0n;
    if (inbox === 0n && held === 0n) {
      throw new Error(`nothing has been routed to loan slot #${ref} since the last collect (h081_lend action "claim" pulls the vested share of the borrower's stream). Nothing was sent.`);
    }
    await this.needSol(LEND_SOL_MIN, 'collecting');
    const signatures: string[] = [];
    try {
      if (inbox > 0n) signatures.push((await lender.syncLoan(ref)).signature);
      const left = (await lender.ledger(ref, s.asset).catch(() => undefined))?.held ?? 0n;
      if (left > 0n) signatures.push((await lender.collect(ref, s.asset)).signature);
    } catch (e) { throw this.loanErr(e); }
    const v = await this.lendView(ref, await this.mySlot(ref, 'read it'), await this.pool.now());
    return { sent: true, action: 'collect', loanRef: ref, signatures, collected: inbox + held, collectedUsdg: fromUnits(inbox + held, d), slot: v };
  }

  /** Pulls the vested share of the borrower's pledged stream to the lender (a lender-claim spend proof the agent key sends). */
  async lendClaim(req: { loanRef: bigint; amount?: bigint }): Promise<LendSentResult> {
    const ref = req.loanRef, d = this.decimals;
    const s = await this.mySlot(ref, 'claim on it');
    if (!s.funded) throw new Error(`loan slot #${ref} has not lent anything yet. Nothing was sent.`);
    if (s.settled) throw new Error(`loan #${ref} is settled. Nothing was sent.`);
    const lender = this.lender();
    await lender.sync();
    const claimable = lender.claimable(ref, await this.pool.now());
    if (claimable === 0n) {
      throw new Error(lender.opaque(ref)
        ? 'the borrower moved its pledged note without handing this lender its successor: nothing can be claimed; 7 days after expiry the unpaid principal is a shortfall. Nothing was sent.'
        : `nothing is claimable on loan #${ref} yet (the borrower's stream has not vested more of the pledged share). Nothing was sent.`);
    }
    if (req.amount !== undefined && (req.amount <= 0n || req.amount > claimable)) {
      throw new Error(`at most ${fromUnits(claimable, d)} ${MAINNET.usdg.symbol} is claimable now. Nothing was sent.`);
    }
    await this.requireArtifacts('spend');
    await this.needSol(DEPOSIT_SOL_MIN, 'a claim (it stages a spend proof)');
    let r: Awaited<ReturnType<SolanaLoanLenderWallet['claim']>>;
    try { r = await lender.claim(ref, req.amount); } catch (e) { throw this.loanErr(e); }
    const v = await this.lendView(ref, await this.mySlot(ref, 'read it'), await this.pool.now());
    return { sent: true, action: 'claim', loanRef: ref, signatures: [r.tx.signature], collected: r.amount, collectedUsdg: fromUnits(r.amount, d), slot: v };
  }

  /** Settles loan `loanRef`: the lender closes the books (no shortfall can be reported after). Without `confirm`, the plan. */
  async lendSettle(req: { loanRef: bigint; confirm?: boolean }): Promise<LendSentResult | LendPlanResult> {
    const ref = req.loanRef, d = this.decimals;
    const s = await this.mySlot(ref, 'settle it');
    if (!s.funded) throw new Error(`loan slot #${ref} has not lent anything; there is nothing to settle. Nothing was sent.`);
    if (s.settled) throw new Error(`loan #${ref} is already settled. Nothing was sent.`);
    const outstanding = s.principal > s.repaid ? s.principal - s.repaid : 0n;
    if (!req.confirm) {
      return H081Bank.lendPlan({
        action: 'settle', loanRef: ref, principal: s.principal, repaid: s.repaid, outstanding, outstandingUsdg: fromUnits(outstanding, d),
        warning: outstanding > 0n
          ? `${fromUnits(outstanding, d)} ${MAINNET.usdg.symbol} is still unpaid: settling now gives up any shortfall claim on it`
          : 'the loan is repaid; settling closes it',
      }, 'Call h081_lend again with action "settle", the same loanRef and confirm: true to settle it.');
    }
    await this.needSol(LEND_SOL_MIN, 'settling');
    let tx: Awaited<ReturnType<SolanaLoanLenderWallet['settle']>>;
    try { tx = await this.lender().settle(ref); } catch (e) { throw this.loanErr(e); }
    const v = await this.lendView(ref, await this.mySlot(ref, 'read it'), await this.pool.now());
    return { sent: true, action: 'settle', loanRef: ref, signatures: [tx.signature], slot: v };
  }

  /**
   * Closes a settled (or never funded) slot and takes its rent back, where the SDK has stream_loan close_slot (this
   * build's does not yet: the action is refused, nothing sent). Without `confirm`, the plan.
   */
  async lendClose(req: { loanRef: bigint; confirm?: boolean }): Promise<LendSentResult | LendPlanResult> {
    const ref = req.loanRef;
    const s = await this.mySlot(ref, 'close it');
    if (s.funded && !s.settled) throw new Error(`loan #${ref} is not settled: settle it first (h081_lend action "settle"). Nothing was sent.`);
    const lender = this.lender() as SolanaLoanLenderWallet & { close?: (loanRef: bigint) => Promise<{ signature: string; refunded?: bigint }> };
    if (typeof lender.close !== 'function') {
      throw new Error('closing a loan slot (stream_loan close_slot) is not in this build\'s SDK yet; the slot stays open and keeps its rent. Nothing was sent.');
    }
    if (!req.confirm) {
      return H081Bank.lendPlan({
        action: 'close', loanRef: ref, funded: s.funded,
        note: 'the slot\'s accounts are closed and their rent goes back to the agent wallet; repayments still in the slot are collected first',
      }, 'Call h081_lend again with action "close", the same loanRef and confirm: true to close it.');
    }
    await this.needSol(LEND_SOL_MIN, 'closing a slot');
    let tx: { signature: string; refunded?: bigint };
    try { tx = await lender.close(ref); } catch (e) { throw this.loanErr(e); }
    return { sent: true, action: 'close', loanRef: ref, signatures: [tx.signature], ...(tx.refunded === undefined ? {} : { refundedLamports: tx.refunded }) };
  }

  // ---- info

  /** Facts about the deployment and this agent. Never the RPC URL (its path/query may carry an API key): only its host. */
  async protocolInfo(): Promise<Record<string, unknown>> {
    let terms: RelayTerms | undefined, relayerStatus: string;
    const [caps, genesis] = await Promise.all([this.caps().catch(() => null), this.connection.getGenesisHash().catch(() => undefined)]);
    if (!this.relayer) relayerStatus = 'no relayer configured (H081_RELAYER_URL is empty): withdrawals are sent by the agent key';
    else {
      try { terms = await this.relayTerms(); relayerStatus = 'ok'; } catch (e) { relayerStatus = `unavailable: ${(e as Error).message}; relayed withdrawals are refused until it is (direct: true still works)`; }
    }
    const host = rpcHost(this.config.rpcUrl);
    return {
      cluster: this.config.cluster, genesis, rpc: host, rpcIsPublic: PUBLIC_RPC_HOSTS.has(host),
      programs: { pool: this.config.poolProgramId.toBase58(), loan: this.config.loanProgramId.toBase58(), safety: this.config.safetyProgramId.toBase58(), capacity: this.config.capacityProgramId.toBase58() },
      usdg: { mint: this.usdg.toBase58(), decimals: this.decimals, symbol: MAINNET.usdg.symbol },
      h081: { mint: this.stakeMint.toBase58(), decimals: MAINNET.h081.decimals, symbol: MAINNET.h081.symbol },
      loanTreasury: this.config.loanTreasury.toBase58(),
      caps: caps && { perDeposit: caps.perDeposit, perDepositUsdg: fromUnits(caps.perDeposit, this.decimals), total: caps.total, totalUsdg: fromUnits(caps.total, this.decimals), inVault: caps.inVault, inVaultUsdg: fromUnits(caps.inVault, this.decimals), paused: caps.paused },
      stakeCaps: { perStake: MAINNET.stakeCaps.perStake, total: MAINNET.stakeCaps.total, cooldownDays: 30 },
      fees: { relayBps: terms?.feeBps ?? null, relayMin: terms?.minFee ?? null, loanOriginationBps: 25 },
      relayer: terms ? { url: terms.url, relayer: terms.relayer.toBase58(), minFee: terms.minFee, feeBps: terms.feeBps, feeAccount: terms.feeRecipient.toBase58(), treasury: terms.treasury, freeTier: terms.freeTier } : null,
      relayerStatus,
      signer: this.signer.publicKey.toBase58(), shieldedAddress: this.shieldedAddress(), shieldedAddressCode: this.shieldedAddressCode(),
      operatorCeilings: { maxDeposit: this.config.maxDeposit ?? null, maxPay: this.config.maxPay ?? null, maxGrant: this.config.maxGrant ?? null, maxLend: this.config.maxLend ?? null }, circuitsDir: this.config.circuitsDir,
      account: { source: this.accountSource, note: ACCOUNT_SOURCE_NOTES[this.accountSource] },
      notice: NOTICE,
    };
  }
}
