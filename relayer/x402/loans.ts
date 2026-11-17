// Loan-market data for the x402 `loans-market` service: the stream_loan registry and every slot, read
// straight from the chain (no indexer) and cached for a short while. Numbers are decimal strings.
import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import {
  GRACE, ORIGINATION_FEE_BPS, type SlotAccount, type SubrogationAccount, decodeRegistry, decodeSlot, decodeSubrogation, registryPda, shortfallOf, slotPda, subrogationPda,
} from '../../src/solana/lender.js';
import { SUBROGATION_LABEL, type SubrogationKind, backedLenderPosition, decodeDraw, drawPda, isBackedSlot, isDrawAccount, subrogationKindOf } from '../../src/solana/backer.js';

/** Slot addresses per getMultipleAccountsInfo call (the RPC limit is 100). */
const SLOT_BATCH = 100;
import { RelayError } from '../errors.js';

/** Treasury of the loan origination fee (stream_loan's compile-time TREASURY on mainnet; docs/MAINNET-RUNBOOK.md). */
export const LOAN_TREASURY_MAINNET = 'EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq';

/**
 * Size of a Slot account: Anchor discriminator (8) + the Slot layout decodeSlot reads
 * (u64, Pubkey, u8, bool, bool, Pubkey, Pubkey, u64, u64, u128, u128, u16, u64, [u8; 32], i64, Pubkey, u64).
 */
export const SLOT_ACCOUNT_BYTES = 8 + 8 + 32 + 1 + 1 + 1 + 32 + 32 + 8 + 8 + 16 + 16 + 2 + 8 + 32 + 8 + 32 + 8;

export interface LoanView {
  loanRef: string; lender: string; asset: string; tokenProgram: string; principal: string; repaid: string; fundedAt: string; expiry: string;
  pledgeBps: number; minRemaining: string; minRate: string; streamStart: string; settled: boolean;
  /** stream_loan's rule: principal - repaid once expiry + grace has passed (for a backed loan this includes the backer's fee) */
  shortfall: string;
  /** `backed`: funded by a backed line (fund_backed; pledgeBps 0, no stream behind it); `stream`: a pledged stream loan */
  kind: 'stream' | 'backed';
  /**
   * The loan's Subrogation, if any: receipts repay `to` first until `paid` reaches `owed`. kind `backer` ("backer fee /
   * recovery") on a backed loan, never a slash; kind `slash` ("safety-pool slash recovery") after a safety-pool slash.
   */
  subrogation: { kind: SubrogationKind; label: string; to: string; owed: string; paid: string } | null;
  /** a backed loan: the lender's due (principal - backer fee), the cover the stake paid, and what the lender is still short */
  backed?: { backing: string; backerFee: string; lenderDue: string; toBacker: string; toLender: string; coverPaid: string; lenderShortfall: string };
}

export interface LoanMarketSnapshot {
  programId: string;
  registry: { nextLoanRef: string };
  originationFeeBps: number;
  graceSeconds: number;
  treasury: string;
  counts: { open: number; funded: number; settled: number; backed: number };
  loans: LoanView[];
  openSlots: Array<{ loanRef: string; lender: string }>;
  /** chain time the shortfalls were computed at (unix seconds) */
  now: string;
  updatedAt: string;
}

export interface LoanMarketReaderOptions {
  programId: PublicKey;
  ttlMs?: number;
  treasury?: string;
  /** wall clock (ms) for the cache; default Date.now */
  clock?: () => number;
}

export class LoanMarketReader {
  private cache?: { at: number; value: LoanMarketSnapshot };
  private pending?: Promise<LoanMarketSnapshot>;
  readonly programId: PublicKey;
  readonly ttlMs: number;

  constructor(readonly connection: Connection, readonly opts: LoanMarketReaderOptions) {
    this.programId = opts.programId;
    this.ttlMs = opts.ttlMs ?? 30_000;
  }

  private now(): number {
    return this.opts.clock ? this.opts.clock() : Date.now();
  }

  /** The snapshot, at most `ttlMs` old; concurrent callers share one read. */
  async snapshot(): Promise<LoanMarketSnapshot> {
    if (this.cache && this.now() - this.cache.at < this.ttlMs) return this.cache.value;
    if (!this.pending) {
      this.pending = this.read().then((value) => {
        this.cache = { at: this.now(), value };
        return value;
      }).finally(() => { this.pending = undefined; });
    }
    return this.pending;
  }

  /** getMultipleAccountsInfo in batches of SLOT_BATCH, in order. */
  private async batch(keys: PublicKey[]): Promise<Array<{ owner: PublicKey; data: Uint8Array } | null>> {
    const out: Array<{ owner: PublicKey; data: Uint8Array } | null> = [];
    for (let i = 0; i < keys.length; i += SLOT_BATCH) out.push(...await this.connection.getMultipleAccountsInfo(keys.slice(i, i + SLOT_BATCH), 'confirmed'));
    return out;
  }

  /**
   * Reads the registry and the clock, then every slot by its derived address (["slot", loan_ref] for
   * loan_ref 1..nextLoanRef-1, fetched in batches): public RPC endpoints refuse indexed queries such as
   * getProgramAccounts, and the registry counter makes them unnecessary.
   */
  private async read(): Promise<LoanMarketSnapshot> {
    let registryInfo, clock;
    const slots: Array<{ data: Uint8Array } | null> = [];
    try {
      [registryInfo, clock] = await Promise.all([
        this.connection.getAccountInfo(registryPda(this.programId), 'confirmed'),
        this.connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed'),
      ]);
      if (registryInfo) {
        const next = decodeRegistry(registryInfo.data).nextLoanRef;
        const keys: PublicKey[] = [];
        for (let ref = 1n; ref < next; ref++) keys.push(slotPda(ref, this.programId));
        for (let i = 0; i < keys.length; i += SLOT_BATCH) {
          slots.push(...await this.connection.getMultipleAccountsInfo(keys.slice(i, i + SLOT_BATCH), 'confirmed'));
        }
      }
    } catch (e) {
      throw new RelayError(503, 'rpc', `stream_loan not readable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!registryInfo) throw new RelayError(503, 'registry_missing', 'stream_loan is not initialised on this cluster');
    if (!clock) throw new RelayError(503, 'rpc', 'clock sysvar not readable');
    const now = Buffer.from(clock.data).readBigInt64LE(32);
    const decoded: SlotAccount[] = [];
    for (const account of slots) {
      if (!account || account.data.length !== SLOT_ACCOUNT_BYTES) continue; // closed slot, or not a slot
      try { decoded.push(decodeSlot(account.data)); } catch { /* not a slot */ }
    }
    decoded.sort((a, b) => (a.loanRef < b.loanRef ? -1 : a.loanRef > b.loanRef ? 1 : 0));
    const funded = decoded.filter((s) => s.funded);
    let subs: Array<SubrogationAccount | undefined>, kinds: Array<SubrogationKind | undefined>, draws: Array<ReturnType<typeof decodeDraw> | undefined>;
    try {
      const subInfos = await this.batch(funded.map((s) => subrogationPda(s.loanRef, this.programId)));
      subs = subInfos.map((i) => (i && i.owner.equals(this.programId) ? decodeSubrogation(i.data) : undefined));
      const withSub = subs.flatMap((sub, i) => (sub ? [i] : []));
      const cfgs = await this.batch(withSub.map((i) => subs[i]!.safetyConfig));
      kinds = funded.map(() => undefined);
      withSub.forEach((i, j) => { kinds[i] = subrogationKindOf(cfgs[j], this.programId, funded[i]); });
      const backedIdx = funded.flatMap((s, i) => (isBackedSlot(s) && subs[i] ? [i] : []));
      const drawInfos = await this.batch(backedIdx.map((i) => drawPda(subs[i]!.safetyConfig, funded[i].loanRef, this.programId)));
      draws = funded.map(() => undefined);
      backedIdx.forEach((i, j) => { const d = drawInfos[j]; if (d && d.owner.equals(this.programId) && isDrawAccount(d.data)) draws[i] = decodeDraw(d.data); });
    } catch (e) {
      throw new RelayError(503, 'rpc', `stream_loan not readable: ${e instanceof Error ? e.message : String(e)}`);
    }
    const extra = new Map(funded.map((s, i) => [s.loanRef, { sub: subs[i], kind: kinds[i], draw: draws[i] }]));
    const loans: LoanView[] = [];
    const openSlots: LoanMarketSnapshot['openSlots'] = [];
    const counts = { open: 0, funded: 0, settled: 0, backed: 0 };
    for (const s of decoded) {
      if (!s.funded) {
        counts.open++;
        openSlots.push({ loanRef: s.loanRef.toString(), lender: s.lender.toBase58() });
        continue;
      }
      if (s.settled) counts.settled++; else counts.funded++;
      const x = extra.get(s.loanRef);
      const backed = isBackedSlot(s);
      if (backed) counts.backed++;
      const sub = x?.sub, kind = x?.kind ?? 'slash';
      let backedView: LoanView['backed'];
      if (backed) {
        const p = backedLenderPosition(s, sub, x?.draw, now);
        backedView = {
          backing: sub?.safetyConfig.toBase58() ?? '', backerFee: p.backerFee.toString(), lenderDue: p.lenderDue.toString(), toBacker: p.toBacker.toString(),
          toLender: p.toLender.toString(), coverPaid: p.coverPaid.toString(), lenderShortfall: p.lenderShortfall.toString(),
        };
      }
      loans.push({
        loanRef: s.loanRef.toString(), lender: s.lender.toBase58(), asset: s.asset.toBase58(), tokenProgram: s.tokenProgram.toBase58(),
        principal: s.principal.toString(), repaid: s.repaid.toString(), fundedAt: s.fundedAt.toString(), expiry: s.expiry.toString(),
        pledgeBps: Number(s.pledgeBps), minRemaining: s.minRemaining.toString(), minRate: s.minRate.toString(), streamStart: s.streamStart.toString(),
        settled: s.settled, shortfall: shortfallOf(s, now).toString(), kind: backed ? 'backed' : 'stream',
        subrogation: sub ? { kind, label: SUBROGATION_LABEL[kind], to: sub.to.toBase58(), owed: sub.owed.toString(), paid: sub.paid.toString() } : null,
        ...(backedView ? { backed: backedView } : {}),
      });
    }
    return {
      programId: this.programId.toBase58(), registry: { nextLoanRef: decodeRegistry(registryInfo.data).nextLoanRef.toString() },
      originationFeeBps: Number(ORIGINATION_FEE_BPS), graceSeconds: Number(GRACE), treasury: this.opts.treasury ?? LOAN_TREASURY_MAINNET,
      counts, loans, openSlots, now: now.toString(), updatedAt: new Date(this.now()).toISOString(),
    };
  }
}
