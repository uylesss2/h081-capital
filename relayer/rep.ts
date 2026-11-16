// Private reputation on the relayer (docs/REPUTATION-SPEC.md section 6). Free routes:
//   GET  /v1/rep/leaves   the public leaf list of rep_registry tree 0 (RepAttested events), kept across requests, topped
//                         up with only the new transactions, and checked against the on-chain root before it is served;
//                         clients re-check it themselves
//   GET  /v1/rep/roots    the tree's on-chain state: version, leaf count, current root, the root ring
//   POST /v1/rep/attest   { loanRef }: QUEUES one repaid loan (202). Nothing is sent then: the sweep attests it together
//                         with every other repaid, unattested loan, in loanRef order, signed and paid by the relayer hot
//                         wallet. So the borrower's wallet never appears next to its loan, and the timing of the attests
//                         on chain says nothing about which loans one client asked for together.
//   GET  /v1/rep/sweep    the cron (Authorization: Bearer <CRON_SECRET>); main.ts also runs it on a timer
//
// Drain guard: the hot wallet pays a transaction fee (and, once per 8,192 loan refs, a 1 KiB bitmap page) for each
// attest it sends, and gets nothing back. It attests only loans of at least `minPrincipal` (default 10 USDG: the 0.25%
// origination fee of such a loan, 0.025 USDG, is far above the ~5,000 lamports the attest costs), and every
// request takes a rate-limit token. There is NO proving endpoint: a reputation witness holds the account secret.
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { RelayError } from './errors.js';
import { decodeSlot, slotPda } from '../src/solana/lender.js';
import { sendLegacy } from '../src/solana/send.js';
import {
  attestIx, fetchRepEventsSince, fetchRepTree, isAttested, rebuildRepTree, snapshotOf, type RepAttestedEvent, type RepSnapshot,
} from '../src/solana/reputation.js';

export const DEFAULT_REP_MIN_PRINCIPAL = 10_000_000n;

export interface RepRelayerOptions {
  connection: Connection;
  payer: Keypair;
  repProgramId: PublicKey;
  loanProgramId: PublicKey;
  /** smallest principal the relayer pays to attest (base units) */
  minPrincipal?: bigint;
  /** most attests one sweep sends */
  sweepMax?: number;
  /** how long a served leaf list is reused (ms) */
  cacheMs?: number;
  /** minutes between sweeps (only stated in info and replies; main.ts / the cron run it) */
  sweepEveryMin?: number;
  log?: (line: string) => void;
}

export interface RepQueued { queued: true; loanRef: string; note: string }

export class RepRelayer {
  readonly minPrincipal: bigint;
  /** loan refs a borrower asked for; the sweep attests them with every other repaid loan (a hint: the sweep finds them anyway) */
  private readonly queue = new Set<bigint>();
  /** every leaf seen so far (kept across attests), and the newest RepTree signature read */
  private events: RepAttestedEvent[] = [];
  private newestSig?: string;
  /** the last served snapshot, the root it was checked against, and the attest generation it saw */
  private served?: { at: number; snap: RepSnapshot; root: bigint; count: number; gen: number };
  /** bumped by every attest this relayer sends: a snapshot from an older generation is stale */
  private gen = 0;
  private inflight?: Promise<RepSnapshot>;
  /** RPC work done for the leaf list (tests and logs) */
  readonly fetches = { incremental: 0, full: 0 };

  constructor(readonly opts: RepRelayerOptions) {
    this.minPrincipal = opts.minPrincipal ?? DEFAULT_REP_MIN_PRINCIPAL;
  }

  info() {
    return {
      program: this.opts.repProgramId.toBase58(), attester: this.opts.payer.publicKey.toBase58(), minPrincipal: this.minPrincipal.toString(), proving: false,
      attest: 'queued' as const, ...(this.opts.sweepEveryMin ? { sweepEveryMin: this.opts.sweepEveryMin } : {}),
    };
  }

  /** The checked leaf list: reused for cacheMs unless an attest landed since; one refresh at a time however many ask. */
  async leaves(): Promise<RepSnapshot> {
    if (this.inflight) return this.inflight;
    const s = this.served;
    if (s && s.gen === this.gen && Date.now() - s.at < (this.opts.cacheMs ?? 60_000)) return s.snap;
    this.inflight = this.refresh().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async refresh(): Promise<RepSnapshot> {
    const { connection, repProgramId } = this.opts;
    const gen = this.gen; // an attest during this refresh leaves the result stale
    const onChain = await fetchRepTree(connection, repProgramId, 0);
    if (!onChain) throw new RelayError(503, 'rep_disabled', 'rep_registry is not initialized on this cluster');
    // nothing new on chain: the list already checked against this root is still the list
    if (this.served && this.served.count === onChain.nextIndex && this.served.root === onChain.root) {
      this.served = { ...this.served, at: Date.now(), gen };
      return this.served.snap;
    }
    if (this.events.length < onChain.nextIndex) {
      // top up: only the transactions newer than the newest one already read
      const { events, newest } = await fetchRepEventsSince(connection, repProgramId, 0, this.newestSig);
      if (this.newestSig) this.fetches.incremental++; else this.fetches.full++;
      this.merge(events);
      if (newest) this.newestSig = newest;
    }
    let use = this.events.filter((e) => e.index < onChain.nextIndex);
    try {
      rebuildRepTree(use, onChain);
    } catch (e) {
      // the incremental list does not rebuild the chain's root (an RPC that lagged, history read out of step): start
      // over from the whole history, and never serve a list that does not rebuild the root
      this.opts.log?.(`rep: leaf list out of step (${(e as Error).message}); rebuilding it from the whole history`);
      const full = await fetchRepEventsSince(connection, repProgramId, 0);
      this.fetches.full++;
      this.events = [];
      this.merge(full.events);
      this.newestSig = full.newest;
      use = this.events.filter((x) => x.index < onChain.nextIndex);
      rebuildRepTree(use, onChain);
    }
    const snap = snapshotOf(use, repProgramId, 0);
    this.served = { at: Date.now(), snap, root: onChain.root, count: onChain.nextIndex, gen };
    return snap;
  }

  /** Adds events by index (a re-read transaction adds nothing it already had). */
  private merge(events: RepAttestedEvent[]): void {
    const known = new Set(this.events.map((e) => e.index));
    for (const e of events) if (!known.has(e.index)) { this.events.push(e); known.add(e.index); }
    this.events.sort((a, b) => a.index - b.index);
  }

  async roots() {
    const t = await fetchRepTree(this.opts.connection, this.opts.repProgramId, 0);
    if (!t) throw new RelayError(503, 'rep_disabled', 'rep_registry is not initialized on this cluster');
    return { version: t.version, nextIndex: t.nextIndex, root: t.root.toString(), roots: t.roots.filter((r) => r !== 0n).map(String) };
  }

  /** Why the relayer will not attest `loanRef`, or undefined when it will. */
  async refusal(loanRef: bigint): Promise<RelayError | undefined> {
    const info = await this.opts.connection.getAccountInfo(slotPda(loanRef, this.opts.loanProgramId), 'confirmed');
    if (!info || !info.owner.equals(this.opts.loanProgramId)) return new RelayError(404, 'no_slot', `loan ${loanRef} has no open slot (never opened, or closed before it was attested)`);
    let s;
    try { s = decodeSlot(info.data); } catch { return new RelayError(400, 'bad_slot', `loan ${loanRef}'s slot could not be read`); }
    if (!s.funded) return new RelayError(409, 'not_funded', `loan ${loanRef} was never funded`);
    if (s.repaid < s.principal) return new RelayError(409, 'not_repaid', `loan ${loanRef} is not fully repaid`);
    if (s.principal < this.minPrincipal) return new RelayError(402, 'below_floor', `the relayer attests loans of at least ${this.minPrincipal} base units; attest this one yourself (selfSign) or have its lender do it`);
    if (await isAttested(this.opts.connection, loanRef, this.opts.repProgramId)) return new RelayError(409, 'already_attested', `loan ${loanRef} is already attested`);
    return undefined;
  }

  /**
   * POST /v1/rep/attest: checks the loan and queues it (202). Nothing is sent here: the next sweep attests it with every
   * other repaid loan, so the attests on chain are not timed by this request.
   */
  async enqueue(body: unknown): Promise<RepQueued> {
    const ref = loanRefOf(body);
    const why = await this.refusal(ref);
    if (why) throw why;
    this.queue.add(ref);
    const every = this.opts.sweepEveryMin;
    return {
      queued: true, loanRef: ref.toString(),
      note: `queued: the next sweep${every ? ` (every ${every} min)` : ''} attests it together with every other repaid loan, in loanRef order, from the relayer's wallet`,
    };
  }

  /** Attests one loan now (the sweep's step; no route sends this directly). */
  async attest(body: unknown): Promise<{ signature: string; loanRef: string }> {
    const ref = loanRefOf(body);
    const why = await this.refusal(ref);
    if (why) throw why;
    const signature = await sendLegacy(this.opts.connection, this.opts.payer, [this.opts.payer], [
      attestIx(this.opts.payer.publicKey, ref, { rep: this.opts.repProgramId, loan: this.opts.loanProgramId }),
    ]);
    this.gen++; // keep the leaf list; the next read tops it up with the new transactions only
    this.opts.log?.(`rep: attested loan ${ref} (${signature})`);
    return { signature, loanRef: ref.toString() };
  }

  /**
   * The cron: attests every live, funded, fully repaid loan of at least minPrincipal that is not attested yet, queued
   * or not, in loanRef order (at most sweepMax per run). A loan whose lender closes it in the same transaction as its
   * last repayment is never seen here; H081 lenders attest before closing (bank.lendClose).
   */
  async sweep(): Promise<{ attested: string[]; signatures: string[]; failed: Array<{ loanRef: string; error: string }>; candidates: number }> {
    const accts = await this.opts.connection.getProgramAccounts(this.opts.loanProgramId, { commitment: 'confirmed', filters: [{ dataSize: 253 }] });
    const candidates = new Set<bigint>(this.queue);
    for (const a of accts) {
      let s;
      try { s = decodeSlot(a.account.data); } catch { continue; }
      if (!slotPda(s.loanRef, this.opts.loanProgramId).equals(a.pubkey)) continue;
      if (s.funded && s.repaid >= s.principal && s.principal >= this.minPrincipal && s.agentPk !== 0n) candidates.add(s.loanRef);
    }
    const attested: string[] = [], signatures: string[] = [], failed: Array<{ loanRef: string; error: string }> = [];
    for (const ref of [...candidates].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))) {
      if (attested.length >= (this.opts.sweepMax ?? 50)) break;
      if (await isAttested(this.opts.connection, ref, this.opts.repProgramId)) { this.queue.delete(ref); continue; }
      try {
        signatures.push((await this.attest({ loanRef: ref.toString() })).signature);
        attested.push(ref.toString());
        this.queue.delete(ref);
      } catch (e) {
        failed.push({ loanRef: ref.toString(), error: (e as Error).message });
        // a refusal will not change by waiting (closed, below the floor); a send failure is retried next sweep
        if (e instanceof RelayError) this.queue.delete(ref);
      }
    }
    return { attested, signatures, failed, candidates: candidates.size };
  }
}

function loanRefOf(body: unknown): bigint {
  const raw = (body as { loanRef?: unknown } | undefined)?.loanRef;
  if (typeof raw !== 'string' || !/^\d{1,20}$/.test(raw) || BigInt(raw) >= 1n << 64n) throw new RelayError(400, 'bad_request', 'loanRef must be a decimal u64 string');
  return BigInt(raw);
}
