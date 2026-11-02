// On-chain client: deploys the pool, scans it, and performs every operation
// (deposit, shielded transfer, withdraw, batch grant, policy-bound spend,
// owner reclaim, delegation, pledge, stream proof, bearer transfer,
// selective disclosure) end to end with real proofs.
import { AbiCoder, Contract, ContractFactory, ContractTransactionReceipt, Signer, keccak256, Provider, type InterfaceAbi } from 'ethers';
import { poseidonContract } from 'circomlibjs';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  Allowance, FIELD, Note, SpendingKey, addressKey, allowanceCommitment, allowanceNullifier, keysFromSk, lenderKey, nextRho, noteCommitment,
  noteNullifier, randomField, randomKeys, addressToField, spendAllowance,
} from './crypto.js';
import { MerklePath, MerkleTree, recipientListRoot } from './merkle.js';
import {
  AllowancePayload, LenderInfo, LenderPayload, MemoViews, NotePayload, ViewingKey, allowanceMemo, decodePayload, decryptMemo, fromHex, noteMemo,
  parseAllowancePayload, sealForLender, toHex, unpackMemos, viewingKeyFromSk,
} from './encryption.js';
import {
  DELEGATE_OUTPUTS, GRANT_OUTPUTS, LEVELS, RECIPIENT_LEVELS, delegateInput, dummyNoteInput, discloseInput, grantInput, spendInput, streamInput,
  transactInput, DisclosureKind, NoteInput, SubGrant,
} from './inputs.js';
import { Prover, ProofResult, SolidityProof } from './prover.js';
import type { RelayerClient } from './relayer-client.js';
import { MAX_INPUTS, nextMerge, selectNotes } from './consolidate.js';
import { planDelegation } from './delegation.js';

const artifactsDir = resolve(import.meta.dirname, '..', 'build', 'artifacts', 'contracts');
const abi = AbiCoder.defaultAbiCoder();

function artifact(path: string) {
  return JSON.parse(readFileSync(join(artifactsDir, path), 'utf8')) as { abi: InterfaceAbi; bytecode: string };
}

export const POOL_ARTIFACT = 'StipendPool.sol/StipendPool.json';
export const STREAM_LOAN_ARTIFACT = 'lending/StreamLoan.sol/StreamLoan.json';
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/** ABI type of SpendExtData, hashed into every spend proof. */
export const SPEND_EXT_TYPE = 'tuple(address relayer,bytes encryptedAllowance,bytes encryptedPayment,bytes encryptedLender)';

// ------------------------------------------------------------------ deploy

export interface Deployment {
  pool: Contract;
  addresses: { pool: string; hasher: string; transact: string; grant: string; spend: string; disclose: string; delegate: string; stream: string };
}

export async function deployPool(signer: Signer, levels = LEVELS): Promise<Deployment> {
  const hasher = await new ContractFactory(poseidonContract.generateABI(2), poseidonContract.createCode(2), signer).deploy();
  await hasher.waitForDeployment();
  const deployVerifier = async (name: string) => {
    const a = artifact(`verifiers/${name}Verifier.sol/${name}Verifier.json`);
    const c = await new ContractFactory(a.abi, a.bytecode, signer).deploy();
    await c.waitForDeployment();
    return c.getAddress();
  };
  const [transact, grant, spend, disclose, delegate, stream] = await Promise.all([
    deployVerifier('Transact'), deployVerifier('Grant'), deployVerifier('Spend'), deployVerifier('Disclose'), deployVerifier('Delegate'), deployVerifier('Stream'),
  ]);
  const poolArtifact = artifact(POOL_ARTIFACT);
  const pool = await new ContractFactory(poolArtifact.abi, poolArtifact.bytecode, signer).deploy(
    levels, await hasher.getAddress(), transact, grant, spend, disclose, delegate, stream,
  );
  await pool.waitForDeployment();
  return {
    pool: pool as unknown as Contract,
    addresses: { pool: await pool.getAddress(), hasher: await hasher.getAddress(), transact, grant, spend, disclose, delegate, stream },
  };
}

export function connectPool(address: string, runner: Signer | Provider): Contract {
  return new Contract(address, artifact(POOL_ARTIFACT).abi, runner);
}

/** Deploys the StreamLoan registry (no owner) bound to `pool`; returns its address. */
export async function deployLending(signer: Signer, pool: Contract | string): Promise<string> {
  const poolAddress = typeof pool === 'string' ? pool : await pool.getAddress();
  const a = artifact(STREAM_LOAN_ARTIFACT);
  const c = await new ContractFactory(a.abi, a.bytecode, signer).deploy(poolAddress);
  await c.waitForDeployment();
  return c.getAddress();
}

export function connectLending(address: string, runner: Signer | Provider): Contract {
  return new Contract(address, artifact(STREAM_LOAN_ARTIFACT).abi, runner);
}

// ------------------------------------------------------------------ accounts

/** What you hand to someone who wants to pay you or fund you. */
export interface StipendAddress { pk: bigint; viewPub: Uint8Array }

export class Account {
  readonly keys: SpendingKey;
  readonly view: ViewingKey;
  constructor(sk: bigint) {
    this.keys = keysFromSk(sk);
    this.view = viewingKeyFromSk(sk);
  }
  static random(): Account {
    return new Account(randomKeys().sk);
  }
  get address(): StipendAddress {
    return { pk: this.keys.pk, viewPub: this.view.pub };
  }
}

// ------------------------------------------------------------------ wallet

export interface OwnedNote { note: Note; commitment: bigint; index: number; spent: boolean }
export interface OwnedAllowance {
  allowance: Allowance; commitment: bigint; index: number; spent: boolean; views: MemoViews;
  /** set when the allowance is pledged: who it is pledged to and the lender's viewing key */
  lender?: LenderInfo;
}

/** Terms of a pledge: the lender contract or address, its slot, the share in basis points and the key its memos go to. */
export interface PledgeTerms { lenderAddr: string | bigint; loanRef: bigint; pledgeBps: bigint; lenderViewPub: Uint8Array }

export interface GrantRequest {
  to: StipendAddress;
  amount: bigint;
  /** window cap, window length (seconds), per-tx cap, expiry (unix), allowed recipients */
  windowCap?: bigint;
  windowLen?: bigint;
  maxPerTx?: bigint;
  expiry?: bigint;
  recipients?: Array<string | StipendAddress>;
  /** an allow-list root prepared earlier (see rememberRecipients); `recipients` takes precedence */
  recipientRoot?: bigint;
  /** release `streamRate` units per second from `streamStart` (defaults to now) */
  streamRate?: bigint;
  streamStart?: bigint;
  /** grant the allowance already pledged to a lender; only the owner can create a pledge */
  pledge?: PledgeTerms;
}

/**
 * Who submits and is paid. `relayer` is bound into the proof (it receives `fee` in the asset). With `via`,
 * the wallet hands the calldata to that relayer service instead of sending it from its own signer
 * (RelayerClient.evmTerms gives the relayer's address and minimum fee). Without `via`, the wallet sends.
 */
export interface Relay { relayer?: string; fee?: bigint; via?: RelayerClient }

export interface PayOptions {
  /**
   * Bytes (0x-hex) written to the spend's `encryptedPayment` slot, which a public payout otherwise leaves empty.
   * The slot is hashed into `extDataHash`, a public input of the spend proof, so the tag cannot be changed once
   * the payment is proven. The x402 adapter uses it to bind a payout to one payment request (`src/x402.ts`).
   */
  paymentTag?: string;
}

export interface TxResult { receipt: ContractTransactionReceipt; proof: ProofResult }

/** Public inputs of a stream proof as `StipendPool.verifyStream` takes them. */
export interface StreamArgs {
  root: bigint; minRemaining: bigint; minRate: bigint; lenderAddr: string; loanRef: bigint; pledgeBps: bigint; expiry: bigint;
  lifetimeCap: bigint; pledgePaid: bigint; agentPk: bigint; audience: bigint; streamStart: bigint; asset: string;
}

/** The memos a spend writes; a subclass may override `spendMemos` (tests model a borrower that withholds one). */
export interface SpendMemos { encryptedAllowance: string; encryptedPayment: string; encryptedLender: string }

/** One line of allowances (a note and its successors) with the lines delegated from it. */
export interface TreasuryNode {
  /** the line's latest note */
  allowance: Allowance; commitment: bigint; index: number; spent: boolean;
  /** the line's first note, as granted or delegated */
  granted: Allowance;
  children: TreasuryNode[];
}

type SubRequest = { to: StipendAddress } & Omit<SubGrant, 'agentPk'>;
type Origin = { kind: 'grant' } | { kind: 'sub' | 'residual'; parentNullifier: bigint };
type NullifierEvent = { nullifier: bigint; transactionHash: string; index: number };

export class Wallet {
  readonly tree = new MerkleTree(LEVELS);
  readonly notes = new Map<bigint, OwnedNote>();
  readonly allowances = new Map<bigint, OwnedAllowance>();
  private nullifierSet = new Set<bigint>();
  /** the rho of every allowance this wallet knows, to tell a spent note with a known successor from an orphan */
  private rhos = new Set<bigint>();
  /** each known allowance keyed by its successor's rho, to inherit along a line */
  private bySuccessorRho = new Map<bigint, OwnedAllowance>();
  private origins = new Map<number, Origin>();
  private lastBlock = 0;

  constructor(
    readonly account: Account,
    readonly pool: Contract,
    readonly prover: Prover = new Prover(),
  ) {}

  get provider(): Provider {
    const p = this.pool.runner?.provider;
    if (!p) throw new Error('pool has no provider');
    return p;
  }

  // ---- scanning ----

  async sync(): Promise<void> {
    const latest = await this.provider.getBlockNumber();
    if (latest < this.lastBlock) return;
    const commits = await this.pool.queryFilter(this.pool.filters.NewCommitment(), this.lastBlock, latest);
    commits.sort((a, b) => (a.blockNumber - b.blockNumber) || (a.index - b.index));
    for (const ev of commits) {
      const [commitment, index, memo] = (ev as unknown as { args: [bigint, bigint, string] }).args;
      if (Number(index) !== this.tree.size) throw new Error(`tree desync: expected ${this.tree.size}, got ${index}`);
      this.tree.insert(commitment);
      this.tryDecrypt(commitment, Number(index), fromHex(memo));
    }
    // where each allowance came from, for the treasury tree
    for (const ev of await this.pool.queryFilter(this.pool.filters.NewGrant(), this.lastBlock, latest)) {
      const first = Number((ev as unknown as { args: [bigint, bigint] }).args[1]);
      for (let i = 0; i < GRANT_OUTPUTS; i++) this.origins.set(first + i, { kind: 'grant' });
    }
    for (const ev of await this.pool.queryFilter(this.pool.filters.NewDelegation(), this.lastBlock, latest)) {
      const [parentNullifier, firstIndex] = (ev as unknown as { args: [bigint, bigint] }).args;
      const first = Number(firstIndex);
      for (let i = 0; i < DELEGATE_OUTPUTS; i++) this.origins.set(first + i, { kind: 'sub', parentNullifier });
      this.origins.set(first + DELEGATE_OUTPUTS, { kind: 'residual', parentNullifier });
    }
    const nfs = await this.pool.queryFilter(this.pool.filters.NewNullifier(), this.lastBlock, latest);
    const seen = new Map<bigint, NullifierEvent>();
    for (const ev of nfs) {
      const e = ev as unknown as { args: [bigint]; transactionHash: string; index: number };
      this.nullifierSet.add(e.args[0]);
      seen.set(e.args[0], { nullifier: e.args[0], transactionHash: e.transactionHash, index: e.index });
    }
    for (const n of this.notes.values()) if (this.nullifierSet.has(noteNullifier(this.account.keys.nk, n.commitment))) n.spent = true;
    const orphans: Array<[OwnedAllowance, NullifierEvent]> = [];
    for (const a of this.allowances.values()) {
      if (a.spent) continue;
      const nf = allowanceNullifier(a.allowance.rho, a.commitment);
      if (!this.nullifierSet.has(nf)) continue;
      a.spent = true;
      const ev = seen.get(nf);
      if (ev && !this.rhos.has(nextRho(a.allowance.rho))) orphans.push([a, ev]);
    }
    for (const [a, ev] of orphans) await this.recoverSuccessor(a, ev, seen);
    this.lastBlock = latest + 1;
  }

  /**
   * A spent allowance whose successor no memo revealed. A lender claim writes the successor memo and nothing
   * checks it, but the successor is fixed by public calldata: `remaining - lenderAmount`, `pledgePaid +
   * lenderAmount`, the window state kept, `rho' = nextRho(rho)`. Rebuild it from the spend's logs and keep
   * it when its commitment is the one the pool inserted; if it was spent the same way, follow the chain.
   * Any other spend was written by this wallet or the owner, who have the memo.
   */
  private async recoverSuccessor(spent: OwnedAllowance, ev: NullifierEvent, seen: Map<bigint, NullifierEvent>): Promise<void> {
    const receipt = await this.provider.getTransactionReceipt(ev.transactionHash);
    if (!receipt) return;
    const logs = receipt.logs
      .filter((l) => l.address === this.pool.target && l.index > ev.index)
      .map((l) => ({ index: l.index, parsed: this.pool.interface.parseLog({ topics: [...l.topics], data: l.data }) }));
    const successor = logs.find((l) => l.parsed?.name === 'NewCommitment');
    const routed = logs.find((l) => l.parsed?.name === 'PledgeRouted' && (l.parsed.args[4] as bigint) === ev.nullifier);
    if (!successor || !routed) return;
    const [commitment, index] = successor.parsed!.args as unknown as [bigint, bigint];
    const next = spendAllowance(spent.allowance, routed.parsed!.args[3] as bigint, 0n, false, true);
    if (allowanceCommitment(next) !== commitment) return;
    const nf = allowanceNullifier(next.rho, commitment);
    const owned: OwnedAllowance = { allowance: next, commitment, index: Number(index), spent: this.nullifierSet.has(nf), views: spent.views, lender: spent.lender };
    this.remember(owned);
    const nextEv = seen.get(nf);
    if (owned.spent && nextEv && !this.rhos.has(nextRho(next.rho))) await this.recoverSuccessor(owned, nextEv, seen);
  }

  private remember(owned: OwnedAllowance): void {
    this.allowances.set(owned.commitment, owned);
    this.rhos.add(owned.allowance.rho);
    this.bySuccessorRho.set(nextRho(owned.allowance.rho), owned);
  }

  private tryDecrypt(commitment: bigint, index: number, memo: Uint8Array): void {
    const candidates = memo.length > 0 ? [memo, ...unpackMemos(memo)] : [];
    for (const m of candidates) {
      const pt = decryptMemo(this.account.view, m);
      if (!pt) continue;
      let payload: NotePayload | AllowancePayload;
      try { payload = decodePayload(pt); } catch { continue; }
      if (payload.t === 'note') {
        const note: Note = { asset: payload.asset, amount: payload.amount, pk: payload.pk, blinding: payload.blinding };
        if (note.pk !== this.account.keys.pk || noteCommitment(note) !== commitment) continue;
        this.notes.set(commitment, { note, commitment, index, spent: false });
        return;
      }
      if (payload.t === 'allow') {
        const { allowance: a, views, lender: fromMemo } = parseAllowancePayload(payload);
        if (allowanceCommitment(a) !== commitment) continue;
        const mine = a.agentPk === this.account.keys.pk || a.policy.ownerPk === this.account.keys.pk;
        if (!mine) continue;
        // a pledge is immutable along a line, so a successor memo that leaves the lender out inherits it from its predecessor
        const lender = fromMemo ?? (a.policy.pledgeBps !== 0n ? this.bySuccessorRho.get(a.rho)?.lender : undefined);
        this.remember({ allowance: a, commitment, index, spent: false, views, lender });
        return;
      }
    }
  }

  unspentNotes(asset: bigint): OwnedNote[] {
    return [...this.notes.values()].filter((n) => !n.spent && n.note.asset === asset && n.note.amount > 0n).sort((a, b) => (a.note.amount > b.note.amount ? -1 : 1));
  }

  balance(asset: bigint): bigint {
    return this.unspentNotes(asset).reduce((s, n) => s + n.note.amount, 0n);
  }

  /** Allowances this account can spend as the agent. */
  agentAllowances(asset?: bigint): OwnedAllowance[] {
    return [...this.allowances.values()].filter((a) => !a.spent && a.allowance.agentPk === this.account.keys.pk && (asset === undefined || a.allowance.asset === asset));
  }

  /** Allowances this account granted and can reclaim as the owner. */
  grantedAllowances(): OwnedAllowance[] {
    return [...this.allowances.values()].filter((a) => !a.spent && a.allowance.policy.ownerPk === this.account.keys.pk);
  }

  /**
   * The owner's treasury as a tree: every line granted by this account with
   * the lines delegated from it, nested. Each node shows the line's latest
   * note; a residual continues its parent's line, a sub starts a child line.
   */
  treasuryTree(): TreasuryNode[] {
    const mine = [...this.allowances.values()].filter((a) => a.allowance.policy.ownerPk === this.account.keys.pk).sort((a, b) => a.index - b.index);
    const byRho = new Map(mine.map((a) => [a.allowance.rho, a]));
    const successorRhos = new Set(mine.map((a) => nextRho(a.allowance.rho)));
    const heads = mine.filter((a) => !successorRhos.has(a.allowance.rho));
    const lineOfNullifier = new Map<bigint, TreasuryNode>();
    const nodes: Array<{ head: OwnedAllowance; node: TreasuryNode }> = [];
    for (const head of heads) {
      const line: OwnedAllowance[] = [head];
      for (let next = byRho.get(nextRho(head.allowance.rho)); next; next = byRho.get(nextRho(next.allowance.rho))) line.push(next);
      const last = line[line.length - 1];
      const node: TreasuryNode = { allowance: last.allowance, commitment: last.commitment, index: last.index, spent: last.spent, granted: head.allowance, children: [] };
      for (const n of line) lineOfNullifier.set(allowanceNullifier(n.allowance.rho, n.commitment), node);
      nodes.push({ head, node });
    }
    const roots: TreasuryNode[] = [];
    for (const { head, node } of nodes) {
      const origin = this.origins.get(head.index);
      const parent = origin?.kind === 'sub' ? lineOfNullifier.get(origin.parentNullifier) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  // ---- treasury ----

  private pickInputs(asset: bigint, needed: bigint): [NoteInput, NoteInput] {
    const chosen = selectNotes(this.unspentNotes(asset), (n) => n.note.amount, needed);
    if (chosen.length > MAX_INPUTS) throw new Error('consolidate notes first (more than two inputs needed)');
    const toInput = (n: OwnedNote): NoteInput => ({ note: n.note, keys: this.account.keys, path: this.tree.path(n.index) });
    return [chosen[0] ? toInput(chosen[0]) : dummyNoteInput(asset, this.account.keys, this.tree), chosen[1] ? toInput(chosen[1]) : dummyNoteInput(asset, this.account.keys, this.tree)];
  }

  /**
   * Merge notes until at most `maxInputs` (1 or 2) of them cover `needed` (default: the whole balance).
   * Each merge is a fully shielded 2-in-2-out transfer to this account: the two smallest notes of the
   * selection go in, their sum and a zero note come out. Returns one result per merge, none when nothing
   * needed merging. transfer, withdraw and grant call it themselves; call it directly to tidy a wallet ahead
   * of time, so the payment that follows is a single transaction.
   */
  async consolidate(asset: bigint, needed?: bigint, maxInputs = MAX_INPUTS): Promise<TxResult[]> {
    await this.sync();
    const target = needed ?? this.balance(asset);
    const done: TxResult[] = [];
    for (let pair = nextMerge(this.unspentNotes(asset), (n) => n.note.amount, target, maxInputs); pair; pair = nextMerge(this.unspentNotes(asset), (n) => n.note.amount, target, maxInputs)) {
      const toInput = (n: OwnedNote): NoteInput => ({ note: n.note, keys: this.account.keys, path: this.tree.path(n.index) });
      const outputs: [Note, Note] = [
        { asset, amount: pair[0].note.amount + pair[1].note.amount, pk: this.account.keys.pk, blinding: randomField() },
        { asset, amount: 0n, pk: this.account.keys.pk, blinding: randomField() },
      ];
      done.push(await this.transact(asset, [toInput(pair[0]), toInput(pair[1])], outputs, [this.account.view.pub, this.account.view.pub], 0n, {}));
    }
    return done;
  }

  private async transact(asset: bigint, inputs: [NoteInput, NoteInput], outputs: [Note, Note], outputViews: [Uint8Array, Uint8Array], extAmount: bigint, relay: Relay, recipient = ZERO_ADDRESS): Promise<TxResult> {
    const fee = relay.fee ?? 0n;
    const relayer = relay.relayer ?? ZERO_ADDRESS;
    const memos = [noteMemo(outputs[0], outputViews[0]), noteMemo(outputs[1], outputViews[1])].map(toHex);
    const ext = { recipient, relayer, extAmount, fee, encryptedOutputs: memos };
    const extDataHash = hashExt(['tuple(address recipient,address relayer,int256 extAmount,uint256 fee,bytes[2] encryptedOutputs)'], [ext]);
    const built = transactInput({ root: this.tree.root, asset, inputs, outputs, publicAmount: extAmount - fee, extDataHash });
    const proof = await this.prover.prove('transact', built.input);
    const args = {
      root: this.tree.root, publicAmount: built.publicAmount, publicAsset: fieldToAddress(built.publicAsset), extDataHash,
      inputNullifiers: built.inputNullifier, outputCommitments: built.outputCommitment,
    };
    const receipt = await this.submit('transact', [solProof(proof.proof), args, ext], relay);
    await this.sync();
    return { receipt, proof };
  }

  /** Shield `amount` of `asset` (caller must have approved the pool). The relayer fee comes out of the deposit. */
  async deposit(asset: bigint, amount: bigint, relay: Relay = {}): Promise<TxResult> {
    await this.sync();
    const fee = relay.fee ?? 0n;
    const outputs: [Note, Note] = [{ asset, amount: amount - fee, pk: this.account.keys.pk, blinding: randomField() }, { asset, amount: 0n, pk: this.account.keys.pk, blinding: randomField() }];
    const dummy = dummyNoteInput(asset, this.account.keys, this.tree);
    return this.transact(asset, [dummy, dummyNoteInput(asset, this.account.keys, this.tree)], outputs, [this.account.view.pub, this.account.view.pub], amount, relay);
  }

  /**
   * Fully shielded transfer to another Stipend address. Nothing public changes except two commitments.
   * If more than two notes are needed, merges run first (see `consolidate`).
   */
  async transfer(asset: bigint, amount: bigint, to: StipendAddress): Promise<TxResult> {
    await this.consolidate(asset, amount);
    const inputs = this.pickInputs(asset, amount);
    const sum = inputs[0].note.amount + inputs[1].note.amount;
    const outputs: [Note, Note] = [{ asset, amount, pk: to.pk, blinding: randomField() }, { asset, amount: sum - amount, pk: this.account.keys.pk, blinding: randomField() }];
    return this.transact(asset, inputs, outputs, [to.viewPub, this.account.view.pub], 0n, {});
  }

  /** Unshield: `amount` leaves the pool, the recipient gets amount - fee. Merges notes first if more than two are needed. */
  async withdraw(asset: bigint, amount: bigint, recipient: string, relay: Relay = {}): Promise<TxResult> {
    await this.sync();
    const fee = relay.fee ?? 0n;
    await this.consolidate(asset, amount);
    const inputs = this.pickInputs(asset, amount);
    const sum = inputs[0].note.amount + inputs[1].note.amount;
    const outputs: [Note, Note] = [{ asset, amount: sum - amount, pk: this.account.keys.pk, blinding: randomField() }, { asset, amount: 0n, pk: this.account.keys.pk, blinding: randomField() }];
    return this.transact(asset, inputs, outputs, [this.account.view.pub, this.account.view.pub], -(amount - fee), relay, recipient);
  }

  // ---- distribution ----

  /**
   * Fund up to sixteen agents in one transaction, each under its own policy. Returns the allowances as the
   * owner sees them and, for pre-pledged ones, the sealed copy to hand the lender.
   */
  async grant(asset: bigint, requests: GrantRequest[]): Promise<TxResult & { allowances: Allowance[]; total: bigint; totalSalt: bigint; lenderPayloads: Array<LenderPayload | undefined> }> {
    if (requests.length === 0 || requests.length > GRANT_OUTPUTS) throw new Error(`1..${GRANT_OUTPUTS} grants per transaction`);
    await this.sync();
    const total = requests.reduce((s, r) => s + r.amount, 0n);
    await this.consolidate(asset, total);
    const inputs = this.pickInputs(asset, total);
    const sum = inputs[0].note.amount + inputs[1].note.amount;
    const now = requests.some((r) => r.streamRate) ? await latestTimestamp(this.provider) : 0n;
    const lenders = requests.map((r) => (r.pledge ? lenderInfo(r.pledge) : undefined));
    const allowances: Allowance[] = requests.map((r, i) => ({
      asset, remaining: r.amount, agentPk: r.to.pk, windowId: 0n, windowSpent: 0n, rho: randomField(), pledgePaid: 0n,
      policy: {
        lifetimeCap: r.amount, windowCap: r.windowCap ?? 0n, windowLen: r.windowLen ?? 86400n, maxPerTx: r.maxPerTx ?? 0n,
        expiry: r.expiry ?? 0n, recipientRoot: r.recipients?.length ? recipientListRoot(r.recipients.map(recipientKey), RECIPIENT_LEVELS).root : (r.recipientRoot ?? 0n),
        ownerPk: this.account.keys.pk,
        streamRate: r.streamRate ?? 0n, streamStart: r.streamRate ? (r.streamStart ?? now) : 0n,
        lender: lenders[i] ? lenderKey(lenders[i]!.lenderAddr, lenders[i]!.loanRef) : 0n, pledgeBps: r.pledge?.pledgeBps ?? 0n,
      },
    }));
    const change: Note = { asset, amount: sum - total, pk: this.account.keys.pk, blinding: randomField() };
    const totalSalt = randomField();
    const base = { root: this.tree.root, asset, owner: this.account.keys, inputs, allowances, lenders, change, totalSalt };
    const built = grantInput({ ...base, extDataHash: 0n });
    const views = (i: number): MemoViews => ({ owner: this.account.view.pub, agent: requests[i].to.viewPub });
    const memos = built.allowances.map((a, i) => (requests[i] ? allowanceMemo(a, views(i), lenders[i]) : new Uint8Array()));
    const ext = { encryptedAllowances: memos.map(toHex), encryptedChange: toHex(noteMemo(change, this.account.view.pub)) };
    const extDataHash = hashExt([`tuple(bytes[${GRANT_OUTPUTS}] encryptedAllowances,bytes encryptedChange)`], [ext]);
    const rebuilt = grantInput({ ...base, allowances: built.allowances, extDataHash });
    const proof = await this.prover.prove('grant', rebuilt.input);
    const args = {
      root: this.tree.root, inputNullifiers: rebuilt.inputNullifier, allowanceCommitments: rebuilt.allowanceCommitments,
      changeCommitment: rebuilt.changeCommitment, totalCommitment: rebuilt.totalCommitment, extDataHash,
    };
    const tx = await this.pool.grant(solProof(proof.proof), args, ext);
    const receipt = await tx.wait();
    await this.sync();
    const lenderPayloads = allowances.map((a, i) => (lenders[i] ? sealForLender(a, views(i), lenders[i]!) : undefined));
    return { receipt, proof, allowances, total, totalSalt, lenderPayloads };
  }

  // ---- spending ----

  /**
   * Pay from an allowance. `to` is either a public address (amount and
   * address visible, payer hidden) or a Stipend address (everything hidden).
   * On a pledged allowance the lender's share is routed and the chain also
   * sees the asset, the lender, the loan ref and the share.
   */
  async pay(owned: OwnedAllowance, amount: bigint, to: string | StipendAddress, relay: Relay = {}, opts: PayOptions = {}): Promise<TxResult & { next: Allowance }> {
    if (opts.paymentTag !== undefined && typeof to !== 'string') throw new Error('a payment tag binds a public payout only');
    return this.spend(owned, amount, to, relay, opts.paymentTag);
  }

  /**
   * Split an allowance this account holds as the agent into sub-allowances
   * for other agents, each under policy no looser than this one, keeping the
   * rest. The owner is not involved and can still reclaim every note in the
   * tree. A pledged allowance passes its pledge to every sub; an agent cannot
   * create a pledge (only the owner can, at grant).
   *
   * Up to four subs take one transaction. More subs are delegated in a chain:
   * four per step, each step delegating from the previous step's residual
   * (see src/delegation.ts). The whole chain is checked before the first
   * transaction, but it is not atomic: if a step fails, the earlier steps
   * stand and the residual holds the rest. `steps` has one result per step.
   */
  async delegate(owned: OwnedAllowance, subs: SubRequest[], opts: { residualWindowCap?: bigint; residualStreamRate?: bigint } = {}): Promise<TxResult & { subs: Allowance[]; residual: Allowance; steps: TxResult[] }> {
    if (owned.allowance.agentPk !== this.account.keys.pk) throw new Error('only the agent can delegate');
    if (subs.length === 0) throw new Error('at least one sub');
    if (subs.length <= DELEGATE_OUTPUTS) {
      const one = await this.delegateOnce(owned, subs, opts);
      return { ...one, steps: [{ receipt: one.receipt, proof: one.proof }] };
    }
    if (owned.allowance.policy.pledgeBps !== 0n && !owned.lender) throw new Error('pledged allowance without its lender info');
    await this.sync();
    const now = await latestTimestamp(this.provider);
    const plan = planDelegation(owned.allowance, subs.map((s) => ({ ...s, agentPk: s.to.pk })), {
      ...opts, now, lender: owned.lender, agent: this.account.keys, path: this.tree.path(owned.index),
    });
    const steps: TxResult[] = [];
    const made: Allowance[] = [];
    let current = owned;
    let at = 0;
    let residual = owned.allowance;
    for (const step of plan.steps) {
      const chunk = subs.slice(at, at + step.subs.length).map((s, i) => ({ ...s, ...step.subs[i], to: s.to }));
      at += step.subs.length;
      const res = await this.delegateOnce(current, chunk, { residualWindowCap: step.residualWindowCap, residualStreamRate: step.residualStreamRate });
      steps.push({ receipt: res.receipt, proof: res.proof });
      made.push(...res.subs);
      residual = res.residual;
      const next = this.allowances.get(allowanceCommitment(res.residual));
      if (!next) throw new Error('residual not found after sync');
      current = next;
    }
    const lastStep = steps[steps.length - 1];
    return { receipt: lastStep.receipt, proof: lastStep.proof, subs: made, residual, steps };
  }

  private async delegateOnce(owned: OwnedAllowance, subs: SubRequest[], opts: { residualWindowCap?: bigint; residualStreamRate?: bigint } = {}): Promise<TxResult & { subs: Allowance[]; residual: Allowance }> {
    if (subs.length === 0 || subs.length > DELEGATE_OUTPUTS) throw new Error(`1..${DELEGATE_OUTPUTS} subs per delegation`);
    const parentPledged = owned.allowance.policy.pledgeBps !== 0n;
    if (parentPledged && !owned.lender) throw new Error('pledged allowance without its lender info');
    const subLenders: Array<LenderInfo | undefined> = subs.map(() => (parentPledged ? owned.lender : undefined));
    await this.sync();
    const now = await latestTimestamp(this.provider);
    const base = {
      root: this.tree.root, allowance: owned.allowance, path: this.tree.path(owned.index), agent: this.account.keys, now,
      subs: subs.map((s) => ({ ...s, agentPk: s.to.pk })), lender: owned.lender, ...opts,
    };
    const draft = delegateInput({ ...base, extDataHash: 0n });
    const ext = {
      encryptedSubs: draft.subs.map((a, i) => (subs[i] ? toHex(allowanceMemo(a, { owner: owned.views.owner, agent: subs[i].to.viewPub }, subLenders[i])) : '0x')),
      encryptedResidual: toHex(allowanceMemo(draft.residual, owned.views, owned.lender)),
    };
    const extDataHash = hashExt(['tuple(bytes[4] encryptedSubs,bytes encryptedResidual)'], [ext]);
    // delegateInput draws fresh rho per call; pin the draft's notes so memos and commitments agree
    const built = delegateInput({ ...base, extDataHash });
    built.subs.forEach((s, i) => { s.rho = draft.subs[i].rho; s.agentPk = draft.subs[i].agentPk; });
    const input = { ...built.input, subRho: draft.subs.map((s) => s.rho), subAgentPk: draft.subs.map((s) => s.agentPk), subCommitment: draft.subCommitments };
    const proof = await this.prover.prove('delegate', input);
    const args = {
      root: this.tree.root, nullifier: built.nullifier, subCommitments: draft.subCommitments, residualCommitment: built.residualCommitment,
      timestamp: now, extDataHash,
    };
    const tx = await this.pool.delegate(solProof(proof.proof), args, ext);
    const receipt = await tx.wait();
    await this.sync();
    return { receipt, proof, subs: draft.subs.slice(0, subs.length), residual: built.residual };
  }

  /**
   * Pledge an allowance this account granted. Only the owner can create a
   * pledge: an agent lending its allowance to itself would strip every rule
   * the owner set. The owner reclaims what is left and grants it again to the
   * same agent under the same rules plus the pledge (two transactions). A
   * streamed allowance restarts its stream at `streamStart` (default: now).
   * Returns the pledged note and the sealed copy to hand the lender off-chain.
   * A pledge is immutable: a pledged allowance cannot be pledged again.
   */
  async pledge(owned: OwnedAllowance, terms: PledgeTerms, opts: { streamStart?: bigint } = {}): Promise<TxResult & { allowance: Allowance; owned: OwnedAllowance; payload: LenderPayload; lender: LenderInfo }> {
    if (owned.allowance.policy.ownerPk !== this.account.keys.pk) throw new Error('only the owner can pledge an allowance');
    if (owned.allowance.policy.pledgeBps !== 0n) throw new Error('a pledge is immutable: the allowance is already pledged');
    if (terms.pledgeBps <= 0n || terms.pledgeBps > 10000n) throw new Error('pledgeBps must be 1..10000');
    const a = owned.allowance;
    if (a.remaining === 0n) throw new Error('nothing left to pledge');
    const P = a.policy;
    await this.reclaim(owned);
    const res = await this.grant(a.asset, [{
      to: { pk: a.agentPk, viewPub: owned.views.agent }, amount: a.remaining,
      windowCap: P.windowCap, windowLen: P.windowLen, maxPerTx: P.maxPerTx, expiry: P.expiry, recipientRoot: P.recipientRoot,
      streamRate: P.streamRate, streamStart: P.streamRate === 0n ? undefined : opts.streamStart, pledge: terms,
    }]);
    const allowance = res.allowances[0];
    const pledged = this.allowances.get(allowanceCommitment(allowance));
    if (!pledged || !res.lenderPayloads[0]) throw new Error('pledged note not found after sync');
    return { receipt: res.receipt, proof: res.proof, allowance, owned: pledged, payload: res.lenderPayloads[0], lender: lenderInfo(terms) };
  }

  /**
   * Hand an allowance to another agent as a bearer note: the whole balance
   * moves into one note for `to` under the same policy (window and per-tx
   * caps, expiry, allow-list, stream, pledge), leaving an empty residual.
   * Placeholder slots take one unit of cap and rate each.
   */
  async transferAllowance(owned: OwnedAllowance, to: StipendAddress): Promise<TxResult & { allowance: Allowance }> {
    if (owned.allowance.agentPk !== this.account.keys.pk) throw new Error('only the agent can move an allowance');
    if (owned.allowance.remaining === 0n) throw new Error('nothing left to move');
    const P = owned.allowance.policy;
    const slots = BigInt(DELEGATE_OUTPUTS - 1);
    const windowCap = P.windowCap === 0n ? undefined : P.windowCap - slots;
    const streamRate = P.streamRate === 0n ? undefined : P.streamRate - slots;
    if (windowCap !== undefined && windowCap <= 0n) throw new Error('window cap too small to move');
    if (streamRate !== undefined && streamRate <= 0n) throw new Error('stream rate too small to move');
    const res = await this.delegate(owned, [{ to, amount: owned.allowance.remaining, windowCap, streamRate }]);
    return { receipt: res.receipt, proof: res.proof, allowance: res.subs[0] };
  }

  /** Owner takes back what is left of an allowance into their own treasury. On a pledged allowance the lender's share is still routed. */
  async reclaim(owned: OwnedAllowance): Promise<TxResult & { next: Allowance }> {
    if (owned.allowance.policy.ownerPk !== this.account.keys.pk) throw new Error('not the owner');
    return this.spend(owned, owned.allowance.remaining, this.account.address, {});
  }

  private async spend(owned: OwnedAllowance, amount: bigint, to: string | StipendAddress, relay: Relay, paymentTag?: string): Promise<TxResult & { next: Allowance }> {
    await this.sync();
    const a = owned.allowance;
    if (a.policy.pledgeBps !== 0n && !owned.lender) throw new Error('pledged allowance without its lender info');
    const isPublic = typeof to === 'string';
    const now = await latestTimestamp(this.provider);
    // the allow-list binds the agent's key; the owner's own key is free of it
    const isAgent = a.agentPk === this.account.keys.pk;
    const recipientPath = a.policy.recipientRoot !== 0n && isAgent ? this.recipientPath(owned, to) : undefined;
    const payBlinding = randomField();
    const base = {
      root: this.tree.root, allowance: a, path: this.tree.path(owned.index), spender: this.account.keys, amount, now, fee: relay.fee,
      ...(isPublic ? { publicTo: addressToField(to) } : { shieldedTo: { pk: to.pk, blinding: payBlinding } }), recipientPath,
      lender: owned.lender,
    };
    const draft = spendInput({ ...base, extDataHash: 0n });
    const ext = { relayer: relay.relayer ?? ZERO_ADDRESS, ...this.spendMemos(draft.next, draft.payNote, owned, to) };
    // A public payout carries no payment memo; a tag in its place is hashed into the proof and read by the payee (x402).
    if (paymentTag !== undefined) ext.encryptedPayment = paymentTag;
    const extDataHash = hashExt([SPEND_EXT_TYPE], [ext]);
    const built = spendInput({ ...base, extDataHash });
    const proof = await this.prover.prove('spend', built.input);
    const args = spendArgs(built, now, extDataHash, isPublic ? to : undefined);
    const receipt = await this.submit('spend', [solProof(proof.proof), args, ext], relay);
    await this.sync();
    return { receipt, proof, next: built.next };
  }

  /** Sends a pool call from this wallet's signer, or hands its calldata to `relay.via` and waits for the receipt. */
  private async submit(fn: 'transact' | 'spend', args: unknown[], relay: Relay): Promise<ContractTransactionReceipt> {
    if (!relay.via) {
      const tx = await this.pool.getFunction(fn)(...args);
      return (await tx.wait())!;
    }
    const to = await this.pool.getAddress();
    const { hash } = await relay.via.relayEvm({ to, data: this.pool.interface.encodeFunctionData(fn, args) });
    const receipt = await this.provider.waitForTransaction(hash);
    if (!receipt) throw new Error(`relayed transaction ${hash} has no receipt`);
    if (receipt.status !== 1) throw new Error(`relayed transaction ${hash} reverted`);
    return new ContractTransactionReceipt(this.pool.interface, this.provider, receipt);
  }

  /** The memos of a spend: the successor for agent and owner, the payout note, and the lender's copy when pledged. */
  protected spendMemos(next: Allowance, payNote: Note, owned: OwnedAllowance, to: string | StipendAddress): SpendMemos {
    return {
      encryptedAllowance: toHex(allowanceMemo(next, owned.views, owned.lender)),
      encryptedPayment: typeof to === 'string' ? '0x' : toHex(noteMemo(payNote, to.viewPub)),
      encryptedLender: owned.lender ? toHex(sealForLender(next, owned.views, owned.lender)) : '0x',
    };
  }

  private recipientPath(owned: OwnedAllowance, to: string | StipendAddress): MerklePath {
    const list = owned.allowance.policy;
    const key = recipientKey(to);
    // The allow-list leaves are not on chain; the agent is given them with the grant out of band.
    const known = this.recipientLists.get(list.recipientRoot);
    if (!known) throw new Error('allow-list for this allowance is unknown; call rememberRecipients()');
    const idx = known.tree.indexOf(key);
    if (idx < 0) throw new Error('recipient is not on the allow-list');
    return known.tree.path(idx);
  }

  private recipientLists = new Map<bigint, { tree: MerkleTree }>();
  /** Register an allow-list so spends can prove membership against it. */
  rememberRecipients(recipients: Array<string | StipendAddress>): bigint {
    const { root, tree } = recipientListRoot(recipients.map(recipientKey), RECIPIENT_LEVELS);
    this.recipientLists.set(root, { tree });
    return root;
  }

  // ---- disclosure ----

  async prove(owned: OwnedAllowance, kind: DisclosureKind, bound: bigint, audience: bigint): Promise<{ proof: ProofResult; args: Record<string, bigint> }> {
    await this.sync();
    const built = discloseInput({ root: this.tree.root, allowance: owned.allowance, path: this.tree.path(owned.index), kind, bound, audience });
    const proof = await this.prover.prove('disclose', built.input);
    const [root, k, b, windowId, agentPk, aud] = built.publicSignals;
    return { proof, args: { root, kind: k, bound: b, windowId, agentPk, audience: aud } };
  }

  /**
   * The lender-facing proof over a pledged allowance: at least `minRemaining`
   * left, streaming at least `minRate`, pledged to the lender; cap, expiry,
   * what was already routed, the stream start and the asset are disclosed.
   * `audience` binds it to one verifier.
   */
  async proveStream(owned: OwnedAllowance, bounds: { minRemaining: bigint; minRate: bigint; audience: bigint }): Promise<{ proof: ProofResult; args: StreamArgs }> {
    if (!owned.lender) throw new Error('allowance is not pledged');
    await this.sync();
    const built = streamInput({ root: this.tree.root, allowance: owned.allowance, path: this.tree.path(owned.index), lender: owned.lender, ...bounds });
    const proof = await this.prover.prove('stream', built.input);
    const [root, minRemaining, minRate, lenderAddr, loanRef, pledgeBps, expiry, lifetimeCap, pledgePaid, agentPk, audience, streamStart, asset] = built.publicSignals;
    return {
      proof,
      args: {
        root, minRemaining, minRate, lenderAddr: fieldToAddress(lenderAddr), loanRef, pledgeBps, expiry, lifetimeCap, pledgePaid, agentPk, audience,
        streamStart, asset: fieldToAddress(asset),
      },
    };
  }
}

/** Anyone with the pool address can check a disclosure, on-chain or off. */
export async function verifyDisclosure(pool: Contract, proof: ProofResult, args: Record<string, bigint>): Promise<boolean> {
  return pool.verifyDisclosure(solProof(proof.proof), args);
}

/** Anyone with the pool address can check a stream proof. */
export async function verifyStream(pool: Contract, proof: ProofResult, args: StreamArgs): Promise<boolean> {
  return pool.verifyStream(solProof(proof.proof), args);
}

// ------------------------------------------------------------------ helpers

export function recipientKey(to: string | StipendAddress): bigint {
  return typeof to === 'string' ? addressKey(addressToField(to)) : to.pk;
}

export function hashExt(types: string[], values: unknown[]): bigint {
  return BigInt(keccak256(abi.encode(types, values))) % FIELD;
}

export function fieldToAddress(x: bigint): string {
  return '0x' + x.toString(16).padStart(40, '0');
}

export function solProof(p: SolidityProof) {
  return { a: p.a, b: p.b, c: p.c };
}

export function lenderInfo(t: PledgeTerms): LenderInfo {
  return { lenderAddr: typeof t.lenderAddr === 'string' ? addressToField(t.lenderAddr) : t.lenderAddr, loanRef: t.loanRef, viewPub: t.lenderViewPub };
}

/** Block time straight from the node; ethers caches "latest" briefly, which is too stale for a spend window. */
export async function latestTimestamp(provider: Provider): Promise<bigint> {
  const p = provider as Provider & { send?: (m: string, a: unknown[]) => Promise<{ timestamp: string }> };
  if (typeof p.send === 'function') {
    const block = await p.send('eth_getBlockByNumber', ['latest', false]);
    return BigInt(block.timestamp);
  }
  return BigInt((await p.getBlock('latest'))!.timestamp);
}

/** The SpendArgs struct for `StipendPool.spend` from a built spend input. */
export function spendArgs(built: ReturnType<typeof spendInput>, now: bigint, extDataHash: bigint, publicRecipient?: string) {
  const lenderAddr = built.input.lenderAddr as bigint;
  return {
    root: built.input.root as bigint, nullifier: built.nullifier, newAllowanceCommitment: built.newAllowanceCommitment, payCommitment: built.payCommitment,
    publicAmount: built.isPublic ? built.net : 0n, publicRecipient: publicRecipient ?? ZERO_ADDRESS,
    publicAsset: built.publicAsset === 0n ? ZERO_ADDRESS : fieldToAddress(built.publicAsset), fee: built.fee, timestamp: now,
    receipt: built.receipt, lenderAmount: built.lenderAmount, lenderAddr: lenderAddr === 0n ? ZERO_ADDRESS : fieldToAddress(lenderAddr), loanRef: built.input.loanRef as bigint,
    isLenderClaim: built.claim, extDataHash,
  };
}
