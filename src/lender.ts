// The lender's side of a stream-backed loan: tracks the pledged notes it was
// handed, follows their successors on chain (every spend on a pledged note
// emits a LenderMemo copy for the lender), prices what it may claim, and
// pulls the vested share through the StreamLoan registry.
//
// The pull path depends on the borrower: the pool hashes the lender memo
// into the proof but cannot read it, so a borrower that writes a blank or
// garbage memo leaves the lender without the successor note. The lender
// then sees the note as `lost` (see `opaque`) and falls back to the
// registry's shortfall path; the routed shares on every spend still arrive.
import { Contract, Provider, type ContractTransactionReceipt } from 'ethers';
import { Allowance, allowanceCommitment, allowanceNullifier, addressToField, lenderClaimable, nextRho } from './crypto.js';
import {
  AllowanceRecord, LenderInfo, LenderPayload, MemoViews, ViewingKey, allowanceMemo, fromHex, openLenderMemo, sealForLender, toHex, unpackMemos,
} from './encryption.js';
import { LEVELS, spendInput } from './inputs.js';
import { MerkleTree } from './merkle.js';
import { Prover, ProofResult } from './prover.js';
import { SPEND_EXT_TYPE, SpendMemos, StreamArgs, TxResult, ZERO_ADDRESS, hashExt, latestTimestamp, solProof, spendArgs } from './client.js';

/** A pledged note as the lender knows it. `lost`: spent on chain, and no successor memo the lender could read. */
export interface LenderNote {
  allowance: Allowance; commitment: bigint; index: number; spent: boolean; lost: boolean; views: MemoViews; lender: LenderInfo;
}

export interface LoanRecord {
  asset: string; principal: bigint; repaid: bigint; minRemaining: bigint; minRate: bigint; pledgeBps: bigint; expiry: bigint;
  agentPk: bigint; fundedAt: bigint; settled: boolean; payoutTo: string; streamStart: bigint;
}

/** Records handed over before their commitment appeared on chain are kept up to this many; older ones are dropped. */
export const PENDING_MAX = 256;

export class LenderWallet {
  readonly tree = new MerkleTree(LEVELS);
  /** every pledged note this lender knows, by commitment */
  readonly notes = new Map<bigint, LenderNote>();
  /** notes handed over before their commitment was seen on chain */
  private pending: Array<AllowanceRecord & { lender: LenderInfo }> = [];
  private nullifierSet = new Set<bigint>();
  private lastBlock = 0;
  /** the StreamLoan registry address as a field element: what pledges name as `lenderAddr` */
  readonly lenderAddr: bigint;

  /**
   * `pool` and `lending` must share a provider; `lending` is connected to the signer that owns the slots
   * (StreamLoan.claim, fund and settle check msg.sender).
   */
  constructor(
    readonly view: ViewingKey,
    readonly pool: Contract,
    readonly lending: Contract,
    readonly prover: Prover = new Prover(),
  ) {
    this.lenderAddr = addressToField(lending.target as string);
  }

  get provider(): Provider {
    const p = this.pool.runner?.provider;
    if (!p) throw new Error('pool has no provider');
    return p;
  }

  /** What a borrower needs to pledge to this lender, once it has a loanRef. */
  get address(): { lenderAddr: string; viewPub: Uint8Array } {
    return { lenderAddr: this.lending.target as string, viewPub: this.view.pub };
  }

  // ---- registry ----

  /** Reserve a slot; the borrower pledges to (this registry, loanRef). */
  async openSlot(): Promise<bigint> {
    const tx = await this.lending.openSlot();
    const receipt: ContractTransactionReceipt = await tx.wait();
    for (const log of receipt.logs) {
      let parsed;
      try { parsed = this.lending.interface.parseLog(log); } catch { continue; }
      if (parsed?.name === 'SlotOpened') return parsed.args[0] as bigint;
    }
    throw new Error('SlotOpened not found');
  }

  /**
   * Fund a slot against a stream proof; the principal goes from the lender to `payoutTo`. Approve the registry first.
   * The proof must describe a live note this lender was handed (same agent, cap, expiry, pledge, routed total, start
   * and asset, with the bounds holding), so a borrower cannot present one note and get funded on another's figures.
   */
  async fund(loanRef: bigint, stream: { proof: ProofResult; args: StreamArgs }, asset: string, principal: bigint, payoutTo: string): Promise<ContractTransactionReceipt> {
    const s = stream.args;
    if (s.loanRef !== loanRef) throw new Error('stream proof is for another slot');
    if (s.lenderAddr.toLowerCase() !== (this.lending.target as string).toLowerCase()) throw new Error('stream proof names another lender');
    if (s.asset.toLowerCase() !== asset.toLowerCase()) throw new Error('stream proof names another asset');
    await this.sync();
    const backing = this.current(loanRef).find((n) => {
      const a = n.allowance;
      const P = a.policy;
      return a.agentPk === s.agentPk && P.lifetimeCap === s.lifetimeCap && P.expiry === s.expiry && P.pledgeBps === s.pledgeBps
        && a.pledgePaid === s.pledgePaid && P.streamStart === s.streamStart && a.asset === addressToField(asset)
        && a.remaining >= s.minRemaining && P.streamRate >= s.minRate;
    });
    if (!backing) throw new Error('stream proof does not match a live note handed to this lender');
    const tx = await this.lending.fund(loanRef, solProof(stream.proof.proof), s, asset, principal, payoutTo);
    return tx.wait();
  }

  /** The slot's lender takes shares the registry could not forward (token refused, or routed before the slot was opened). */
  async collect(loanRef: bigint, asset: string): Promise<ContractTransactionReceipt> {
    const tx = await this.lending.collect(loanRef, asset);
    return tx.wait();
  }

  async settle(loanRef: bigint): Promise<ContractTransactionReceipt> {
    const tx = await this.lending.settle(loanRef);
    return tx.wait();
  }

  async loan(loanRef: bigint): Promise<LoanRecord> {
    const l = await this.lending.loans(loanRef);
    return {
      asset: l[0], principal: l[1], repaid: l[2], minRemaining: l[3], minRate: l[4], pledgeBps: l[5], expiry: l[6], agentPk: l[7], fundedAt: l[8],
      settled: l[9], payoutTo: l[10], streamStart: l[11],
    };
  }

  async shortfall(loanRef: bigint): Promise<bigint> {
    return this.lending.shortfall(loanRef);
  }

  // ---- notes ----

  /** Take in the sealed copy a borrower hands over after a pledge. */
  ingest(payload: LenderPayload | string): LenderNote | undefined {
    const rec = openLenderMemo(this.view, typeof payload === 'string' ? fromHex(payload) : payload);
    if (!rec) throw new Error('payload is not a pledged allowance for this key');
    return this.record(rec);
  }

  private record(rec: AllowanceRecord & { lender: LenderInfo }): LenderNote | undefined {
    if (rec.lender.lenderAddr !== this.lenderAddr) throw new Error('allowance is pledged to another lender');
    const commitment = allowanceCommitment(rec.allowance);
    const known = this.notes.get(commitment);
    if (known) return known;
    const index = this.tree.indexOf(commitment);
    if (index < 0) {
      this.pending.push(rec);
      if (this.pending.length > PENDING_MAX) this.pending.splice(0, this.pending.length - PENDING_MAX);
      return undefined;
    }
    const note: LenderNote = {
      allowance: rec.allowance, commitment, index, spent: this.nullifierSet.has(allowanceNullifier(rec.allowance.rho, commitment)), lost: false,
      views: rec.views, lender: rec.lender,
    };
    this.notes.set(commitment, note);
    return note;
  }

  async sync(): Promise<void> {
    const latest = await this.provider.getBlockNumber();
    if (latest < this.lastBlock) return;
    const commits = await this.pool.queryFilter(this.pool.filters.NewCommitment(), this.lastBlock, latest);
    commits.sort((a, b) => (a.blockNumber - b.blockNumber) || (a.index - b.index));
    const found: Array<AllowanceRecord & { lender: LenderInfo }> = [];
    for (const ev of commits) {
      const [commitment, index, memo] = (ev as unknown as { args: [bigint, bigint, string] }).args;
      if (Number(index) !== this.tree.size) throw new Error(`tree desync: expected ${this.tree.size}, got ${index}`);
      this.tree.insert(commitment);
      // a pledged sub or residual carries a lender copy in its commitment memo
      const bytes = fromHex(memo);
      for (const m of bytes.length > 0 ? [bytes, ...unpackMemos(bytes)] : []) {
        const rec = openLenderMemo(this.view, m);
        if (rec && allowanceCommitment(rec.allowance) === commitment) found.push(rec);
      }
    }
    // every spend on a pledged note emits the successor for the lender
    for (const ev of await this.pool.queryFilter(this.pool.filters.LenderMemo(), this.lastBlock, latest)) {
      const [, memo] = (ev as unknown as { args: [bigint, string] }).args;
      const rec = openLenderMemo(this.view, fromHex(memo));
      if (rec) found.push(rec);
    }
    const nfs = await this.pool.queryFilter(this.pool.filters.NewNullifier(), this.lastBlock, latest);
    for (const ev of nfs) this.nullifierSet.add((ev as unknown as { args: [bigint] }).args[0]);
    const pending = this.pending;
    this.pending = [];
    for (const rec of [...pending, ...found]) {
      if (rec.lender.lenderAddr !== this.lenderAddr) continue;
      this.record(rec);
    }
    // a spent note whose successor (rho' = nextRho(rho)) never reached this lender is lost to the pull path
    const rhos = new Set([...this.notes.values()].map((n) => n.allowance.rho));
    for (const n of this.notes.values()) {
      if (this.nullifierSet.has(allowanceNullifier(n.allowance.rho, n.commitment))) n.spent = true;
      n.lost = n.spent && !rhos.has(nextRho(n.allowance.rho));
    }
    this.lastBlock = latest + 1;
  }

  /** Live notes pledged to `loanRef`, largest balance first. */
  current(loanRef: bigint): LenderNote[] {
    return [...this.notes.values()].filter((n) => !n.spent && n.lender.loanRef === loanRef).sort((a, b) => (a.allowance.remaining > b.allowance.remaining ? -1 : 1));
  }

  /** True when the borrower moved a note of this loan without handing the lender its successor; only the shortfall path remains. */
  opaque(loanRef: bigint): boolean {
    return [...this.notes.values()].some((n) => n.lost && n.lender.loanRef === loanRef);
  }

  /** What the lender may pull right now across every live note of the loan. */
  claimable(loanRef: bigint, now: bigint): bigint {
    return this.current(loanRef).reduce((s, n) => s + lenderClaimable(n.allowance, now), 0n);
  }

  /**
   * Pull the vested share from the loan's live note with the most to claim
   * (`amount` defaults to all of it). The proof carries no key: the registry
   * checks the slot owner and the pool checks msg.sender. The borrower learns
   * its successor note from the memo this writes.
   */
  async claim(loanRef: bigint, amount?: bigint): Promise<TxResult & { next: Allowance; amount: bigint }> {
    await this.sync();
    const now = await latestTimestamp(this.provider);
    const notes = this.current(loanRef);
    if (notes.length === 0) {
      if (this.opaque(loanRef)) throw new Error('borrower withheld the successor memo; use shortfall/settle');
      throw new Error('no live note for this loan');
    }
    const note = notes.reduce((best, n) => (lenderClaimable(n.allowance, now) > lenderClaimable(best.allowance, now) ? n : best));
    const want = amount ?? lenderClaimable(note.allowance, now);
    if (want <= 0n) throw new Error('nothing claimable yet');
    const base = {
      root: this.tree.root, allowance: note.allowance, path: this.tree.path(note.index), amount: want, now, claim: true,
      lender: { lenderAddr: note.lender.lenderAddr, loanRef },
    };
    const draft = spendInput({ ...base, extDataHash: 0n });
    const ext = { relayer: ZERO_ADDRESS, ...this.claimMemos(draft.next, note) };
    const extDataHash = hashExt([SPEND_EXT_TYPE], [ext]);
    const built = spendInput({ ...base, extDataHash });
    const proof = await this.prover.prove('spend', built.input);
    const args = spendArgs(built, now, extDataHash);
    const tx = await this.lending.claim(loanRef, solProof(proof.proof), args, ext);
    const receipt = await tx.wait();
    await this.sync();
    return { receipt, proof, next: built.next, amount: want };
  }

  /**
   * The memos a claim writes: the successor for the agent and the owner, and the lender's own copy. A subclass
   * may override it (tests model a lender that withholds the borrower's copy; the borrower recovers anyway).
   */
  protected claimMemos(next: Allowance, note: LenderNote): SpendMemos {
    return {
      encryptedAllowance: toHex(allowanceMemo(next, note.views, note.lender)),
      encryptedPayment: '0x',
      encryptedLender: toHex(sealForLender(next, note.views, note.lender)),
    };
  }
}
