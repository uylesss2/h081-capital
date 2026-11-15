// Private reputation on the relayer (docs/REPUTATION-SPEC.md section 6). Free routes:
//   GET  /v1/rep/leaves   the public leaf list of rep_registry tree 0 (RepAttested events), rebuilt and checked against
//                         the on-chain root before it is served; clients re-check it themselves
//   GET  /v1/rep/roots    the tree's on-chain state: version, leaf count, current root, the root ring
//   POST /v1/rep/attest   { loanRef }: attest one repaid loan, signed and paid by the relayer hot wallet, so the
//                         borrower's wallet never appears on chain next to its loan
// and a sweep (the cron) that attests every live repaid loan nobody attested yet.
//
// Drain guard: the hot wallet pays a transaction fee (and, once per 8,192 loan refs, a 1 KiB bitmap page) for each
// attest it sends, and gets nothing back. It attests only loans of at least `minPrincipal` (default 10 USDG: the 0.25%
// origination fee of such a loan, 0.025 USDG, is far above the ~5,000 lamports the attest costs), and every
// POST takes a rate-limit token. There is NO proving endpoint: a reputation witness holds the account secret.
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { RelayError } from './errors.js';
import { decodeSlot, slotPda } from '../src/solana/lender.js';
import { sendLegacy } from '../src/solana/send.js';
import {
  attestIx, eventsOfSnapshot, fetchRepEvents, fetchRepTree, isAttested, rebuildRepTree, snapshotOf, type RepAttestedEvent, type RepSnapshot,
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
  log?: (line: string) => void;
}

export class RepRelayer {
  readonly minPrincipal: bigint;
  private cache?: { at: number; snap: RepSnapshot };

  constructor(readonly opts: RepRelayerOptions) {
    this.minPrincipal = opts.minPrincipal ?? DEFAULT_REP_MIN_PRINCIPAL;
  }

  info() {
    return { program: this.opts.repProgramId.toBase58(), attester: this.opts.payer.publicKey.toBase58(), minPrincipal: this.minPrincipal.toString(), proving: false };
  }

  /** The checked leaf list (cached for cacheMs). */
  async leaves(): Promise<RepSnapshot> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < (this.opts.cacheMs ?? 60_000)) return this.cache.snap;
    const onChain = await fetchRepTree(this.opts.connection, this.opts.repProgramId, 0);
    if (!onChain) throw new RelayError(503, 'rep_disabled', 'rep_registry is not initialized on this cluster');
    let events: RepAttestedEvent[] = this.cache ? eventsOfSnapshot(this.cache.snap) : [];
    if (events.length !== onChain.nextIndex) events = await fetchRepEvents(this.opts.connection, this.opts.repProgramId, 0);
    rebuildRepTree(events, onChain); // throws on any inconsistency: never serve a list that does not rebuild the chain's root
    const snap = snapshotOf(events, this.opts.repProgramId, 0);
    this.cache = { at: now, snap };
    return snap;
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

  async attest(body: unknown): Promise<{ signature: string; loanRef: string }> {
    const raw = (body as { loanRef?: unknown } | undefined)?.loanRef;
    if (typeof raw !== 'string' || !/^\d{1,20}$/.test(raw) || BigInt(raw) >= 1n << 64n) throw new RelayError(400, 'bad_request', 'loanRef must be a decimal u64 string');
    const ref = BigInt(raw);
    const why = await this.refusal(ref);
    if (why) throw why;
    const signature = await sendLegacy(this.opts.connection, this.opts.payer, [this.opts.payer], [
      attestIx(this.opts.payer.publicKey, ref, { rep: this.opts.repProgramId, loan: this.opts.loanProgramId }),
    ]);
    this.cache = undefined;
    this.opts.log?.(`rep: attested loan ${ref} (${signature})`);
    return { signature, loanRef: raw };
  }

  /**
   * The cron: attests every live, funded, fully repaid loan of at least minPrincipal that is not attested yet (at most
   * sweepMax per run). A loan whose lender closes it in the same transaction as its last repayment is never seen here;
   * H081 lenders attest before closing (bank.lendClose).
   */
  async sweep(): Promise<{ attested: string[]; failed: Array<{ loanRef: string; error: string }>; candidates: number }> {
    const accts = await this.opts.connection.getProgramAccounts(this.opts.loanProgramId, { commitment: 'confirmed', filters: [{ dataSize: 253 }] });
    const candidates: bigint[] = [];
    for (const a of accts) {
      let s;
      try { s = decodeSlot(a.account.data); } catch { continue; }
      if (!slotPda(s.loanRef, this.opts.loanProgramId).equals(a.pubkey)) continue;
      if (s.funded && s.repaid >= s.principal && s.principal >= this.minPrincipal && s.agentPk !== 0n) candidates.push(s.loanRef);
    }
    const attested: string[] = [], failed: Array<{ loanRef: string; error: string }> = [];
    for (const ref of candidates.sort((x, y) => (x < y ? -1 : 1))) {
      if (attested.length >= (this.opts.sweepMax ?? 50)) break;
      if (await isAttested(this.opts.connection, ref, this.opts.repProgramId)) continue;
      try { await this.attest({ loanRef: ref.toString() }); attested.push(ref.toString()); } catch (e) { failed.push({ loanRef: ref.toString(), error: (e as Error).message }); }
    }
    return { attested, failed, candidates: candidates.length };
  }
}

