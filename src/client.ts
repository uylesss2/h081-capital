// On-chain client: deploys the pool, scans it, and performs every operation
// (deposit, shielded transfer, withdraw, batch grant, policy-bound spend,
// owner reclaim, selective disclosure) end to end with real proofs.
import { AbiCoder, Contract, ContractFactory, Signer, keccak256, Provider, type ContractTransactionReceipt, type InterfaceAbi } from 'ethers';
import { poseidonContract } from 'circomlibjs';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  Allowance, FIELD, Note, Policy, SpendingKey, addressKey, allowanceCommitment, allowanceNullifier, keysFromSk, noteCommitment,
  noteNullifier, randomField, randomKeys, addressToField,
} from './crypto.js';
import { MerklePath, MerkleTree, recipientListRoot } from './merkle.js';
import { ViewingKey, decodePayload, decryptMemo, encodePayload, encryptMemo, fromHex, toHex, viewingKeyFromSk } from './encryption.js';
import { DELEGATE_OUTPUTS, GRANT_OUTPUTS, LEVELS, RECIPIENT_LEVELS, delegateInput, dummyNoteInput, discloseInput, grantInput, spendInput, transactInput, DisclosureKind, NoteInput, SubGrant } from './inputs.js';
import { Prover, ProofResult, SolidityProof } from './prover.js';

const artifactsDir = resolve(import.meta.dirname, '..', 'build', 'artifacts', 'contracts');
const abi = AbiCoder.defaultAbiCoder();

function artifact(path: string) {
  return JSON.parse(readFileSync(join(artifactsDir, path), 'utf8')) as { abi: InterfaceAbi; bytecode: string };
}

export const POOL_ARTIFACT = 'StipendPool.sol/StipendPool.json';

// ------------------------------------------------------------------ deploy

export interface Deployment {
  pool: Contract;
  addresses: { pool: string; hasher: string; transact: string; grant: string; spend: string; disclose: string; delegate: string };
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
  const [transact, grant, spend, disclose, delegate] = await Promise.all([
    deployVerifier('Transact'), deployVerifier('Grant'), deployVerifier('Spend'), deployVerifier('Disclose'), deployVerifier('Delegate'),
  ]);
  const poolArtifact = artifact(POOL_ARTIFACT);
  const pool = await new ContractFactory(poolArtifact.abi, poolArtifact.bytecode, signer).deploy(
    levels, await hasher.getAddress(), transact, grant, spend, disclose, delegate,
  );
  await pool.waitForDeployment();
  return {
    pool: pool as unknown as Contract,
    addresses: { pool: await pool.getAddress(), hasher: await hasher.getAddress(), transact, grant, spend, disclose, delegate },
  };
}

export function connectPool(address: string, runner: Signer | Provider): Contract {
  return new Contract(address, artifact(POOL_ARTIFACT).abi, runner);
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

// ------------------------------------------------------------------ memos

type NotePayload = { t: 'note'; asset: bigint; amount: bigint; pk: bigint; blinding: bigint };
type AllowancePayload = {
  t: 'allow'; asset: bigint; remaining: bigint; agentPk: bigint; windowId: bigint; windowSpent: bigint; rho: bigint;
  policy: Policy; ownerView: string; agentView: string;
};

function packMemos(memos: Uint8Array[]): Uint8Array {
  const parts: number[] = [];
  for (const m of memos) { parts.push(m.length >> 8, m.length & 0xff, ...m); }
  return Uint8Array.from(parts);
}
function unpackMemos(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let i = 0;
  while (i + 2 <= bytes.length) {
    const len = (bytes[i] << 8) | bytes[i + 1];
    out.push(bytes.slice(i + 2, i + 2 + len));
    i += 2 + len;
  }
  return out;
}
function noteMemo(note: Note, to: Uint8Array): Uint8Array {
  return encryptMemo(to, encodePayload({ t: 'note', ...note } satisfies NotePayload));
}
function allowanceMemo(a: Allowance, views: { owner: Uint8Array; agent: Uint8Array }): Uint8Array {
  const payload = encodePayload({ t: 'allow', ...a, ownerView: toHex(views.owner), agentView: toHex(views.agent) } satisfies AllowancePayload);
  return packMemos([encryptMemo(views.agent, payload), encryptMemo(views.owner, payload)]);
}

// ------------------------------------------------------------------ wallet

export interface OwnedNote { note: Note; commitment: bigint; index: number; spent: boolean }
export interface OwnedAllowance {
  allowance: Allowance; commitment: bigint; index: number; spent: boolean; views: { owner: Uint8Array; agent: Uint8Array };
}

export interface GrantRequest {
  to: StipendAddress;
  amount: bigint;
  /** window cap, window length (seconds), per-tx cap, expiry (unix), allowed recipients */
  windowCap?: bigint;
  windowLen?: bigint;
  maxPerTx?: bigint;
  expiry?: bigint;
  recipients?: Array<string | StipendAddress>;
  /** release `streamRate` units per second from `streamStart` (defaults to now) */
  streamRate?: bigint;
  streamStart?: bigint;
}

export interface Relay { relayer?: string; fee?: bigint }

export interface TxResult { receipt: ContractTransactionReceipt; proof: ProofResult }

export class Wallet {
  readonly tree = new MerkleTree(LEVELS);
  readonly notes = new Map<bigint, OwnedNote>();
  readonly allowances = new Map<bigint, OwnedAllowance>();
  private nullifierSet = new Set<bigint>();
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
    const nfs = await this.pool.queryFilter(this.pool.filters.NewNullifier(), this.lastBlock, latest);
    for (const ev of nfs) this.nullifierSet.add((ev as unknown as { args: [bigint] }).args[0]);
    for (const n of this.notes.values()) if (this.nullifierSet.has(noteNullifier(this.account.keys.nk, n.commitment))) n.spent = true;
    for (const a of this.allowances.values()) if (this.nullifierSet.has(allowanceNullifier(a.allowance.rho, a.commitment))) a.spent = true;
    this.lastBlock = latest + 1;
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
        const a: Allowance = {
          asset: payload.asset, remaining: payload.remaining, agentPk: payload.agentPk, policy: payload.policy,
          windowId: payload.windowId, windowSpent: payload.windowSpent, rho: payload.rho,
        };
        if (allowanceCommitment(a) !== commitment) continue;
        const mine = a.agentPk === this.account.keys.pk || a.policy.ownerPk === this.account.keys.pk;
        if (!mine) continue;
        this.allowances.set(commitment, { allowance: a, commitment, index, spent: false, views: { owner: fromHex(payload.ownerView), agent: fromHex(payload.agentView) } });
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

  // ---- treasury ----

  private pickInputs(asset: bigint, needed: bigint): [NoteInput, NoteInput] {
    const avail = this.unspentNotes(asset);
    const chosen: OwnedNote[] = [];
    let sum = 0n;
    for (const n of avail) { if (sum >= needed) break; chosen.push(n); sum += n.note.amount; }
    if (sum < needed) throw new Error(`insufficient shielded balance: have ${sum}, need ${needed}`);
    if (chosen.length > 2) throw new Error('consolidate notes first (more than two inputs needed)');
    const toInput = (n: OwnedNote): NoteInput => ({ note: n.note, keys: this.account.keys, path: this.tree.path(n.index) });
    return [chosen[0] ? toInput(chosen[0]) : dummyNoteInput(asset, this.account.keys, this.tree), chosen[1] ? toInput(chosen[1]) : dummyNoteInput(asset, this.account.keys, this.tree)];
  }

  private async transact(asset: bigint, inputs: [NoteInput, NoteInput], outputs: [Note, Note], outputViews: [Uint8Array, Uint8Array], extAmount: bigint, relay: Relay, recipient = '0x0000000000000000000000000000000000000000'): Promise<TxResult> {
    const fee = relay.fee ?? 0n;
    const relayer = relay.relayer ?? '0x0000000000000000000000000000000000000000';
    const memos = [noteMemo(outputs[0], outputViews[0]), noteMemo(outputs[1], outputViews[1])].map(toHex);
    const ext = { recipient, relayer, extAmount, fee, encryptedOutputs: memos };
    const extDataHash = hashExt(['tuple(address recipient,address relayer,int256 extAmount,uint256 fee,bytes[2] encryptedOutputs)'], [ext]);
    const built = transactInput({ root: this.tree.root, asset, inputs, outputs, publicAmount: extAmount - fee, extDataHash });
    const proof = await this.prover.prove('transact', built.input);
    const args = {
      root: this.tree.root, publicAmount: built.publicAmount, publicAsset: fieldToAddress(built.publicAsset), extDataHash,
      inputNullifiers: built.inputNullifier, outputCommitments: built.outputCommitment,
    };
    const tx = await this.pool.transact(solProof(proof.proof), args, ext);
    const receipt = await tx.wait();
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

  /** Fully shielded transfer to another Stipend address. Nothing public changes except two commitments. */
  async transfer(asset: bigint, amount: bigint, to: StipendAddress): Promise<TxResult> {
    await this.sync();
    const inputs = this.pickInputs(asset, amount);
    const sum = inputs[0].note.amount + inputs[1].note.amount;
    const outputs: [Note, Note] = [{ asset, amount, pk: to.pk, blinding: randomField() }, { asset, amount: sum - amount, pk: this.account.keys.pk, blinding: randomField() }];
    return this.transact(asset, inputs, outputs, [to.viewPub, this.account.view.pub], 0n, {});
  }

  /** Unshield: `amount` leaves the pool, the recipient gets amount - fee. */
  async withdraw(asset: bigint, amount: bigint, recipient: string, relay: Relay = {}): Promise<TxResult> {
    await this.sync();
    const fee = relay.fee ?? 0n;
    const inputs = this.pickInputs(asset, amount);
    const sum = inputs[0].note.amount + inputs[1].note.amount;
    const outputs: [Note, Note] = [{ asset, amount: sum - amount, pk: this.account.keys.pk, blinding: randomField() }, { asset, amount: 0n, pk: this.account.keys.pk, blinding: randomField() }];
    return this.transact(asset, inputs, outputs, [this.account.view.pub, this.account.view.pub], -(amount - fee), relay, recipient);
  }

  // ---- distribution ----

  /** Fund up to eight agents in one transaction, each under its own policy. Returns the allowances as the owner sees them. */
  async grant(asset: bigint, requests: GrantRequest[]): Promise<TxResult & { allowances: Allowance[]; total: bigint; totalSalt: bigint }> {
    if (requests.length === 0 || requests.length > GRANT_OUTPUTS) throw new Error(`1..${GRANT_OUTPUTS} grants per transaction`);
    await this.sync();
    const total = requests.reduce((s, r) => s + r.amount, 0n);
    const inputs = this.pickInputs(asset, total);
    const sum = inputs[0].note.amount + inputs[1].note.amount;
    const now = requests.some((r) => r.streamRate) ? await this.latestTimestamp() : 0n;
    const allowances: Allowance[] = requests.map((r) => ({
      asset, remaining: r.amount, agentPk: r.to.pk, windowId: 0n, windowSpent: 0n, rho: randomField(),
      policy: {
        lifetimeCap: r.amount, windowCap: r.windowCap ?? 0n, windowLen: r.windowLen ?? 86400n, maxPerTx: r.maxPerTx ?? 0n,
        expiry: r.expiry ?? 0n, recipientRoot: r.recipients?.length ? recipientListRoot(r.recipients.map(recipientKey), RECIPIENT_LEVELS).root : 0n,
        ownerPk: this.account.keys.pk,
        streamRate: r.streamRate ?? 0n, streamStart: r.streamRate ? (r.streamStart ?? now) : 0n,
      },
    }));
    const change: Note = { asset, amount: sum - total, pk: this.account.keys.pk, blinding: randomField() };
    const totalSalt = randomField();
    const built = grantInput({ root: this.tree.root, asset, owner: this.account.keys, inputs, allowances, change, totalSalt, extDataHash: 0n });
    const memos = built.allowances.map((a, i) => {
      const req = requests[i];
      return req ? allowanceMemo(a, { owner: this.account.view.pub, agent: req.to.viewPub }) : new Uint8Array();
    });
    const ext = { encryptedAllowances: memos.map(toHex), encryptedChange: toHex(noteMemo(change, this.account.view.pub)) };
    const extDataHash = hashExt([`tuple(bytes[${GRANT_OUTPUTS}] encryptedAllowances,bytes encryptedChange)`], [ext]);
    const rebuilt = grantInput({ root: this.tree.root, asset, owner: this.account.keys, inputs, allowances: built.allowances, change, totalSalt, extDataHash });
    const proof = await this.prover.prove('grant', rebuilt.input);
    const args = {
      root: this.tree.root, inputNullifiers: rebuilt.inputNullifier, allowanceCommitments: rebuilt.allowanceCommitments,
      changeCommitment: rebuilt.changeCommitment, totalCommitment: rebuilt.totalCommitment, extDataHash,
    };
    const tx = await this.pool.grant(solProof(proof.proof), args, ext);
    const receipt = await tx.wait();
    await this.sync();
    return { receipt, proof, allowances, total, totalSalt };
  }

  // ---- spending ----

  /**
   * Pay from an allowance. `to` is either a public address (amount and
   * address visible, payer hidden) or a Stipend address (everything hidden).
   */
  async pay(owned: OwnedAllowance, amount: bigint, to: string | StipendAddress, relay: Relay = {}): Promise<TxResult & { next: Allowance }> {
    return this.spend(owned, amount, to, relay);
  }

  /**
   * Split an allowance this account holds as the agent into up to four
   * sub-allowances for other agents, each under policy no looser than this
   * one, keeping the rest. The owner is not involved and can still reclaim
   * every note in the tree.
   */
  async delegate(owned: OwnedAllowance, subs: Array<{ to: StipendAddress } & Omit<SubGrant, 'agentPk'>>, opts: { residualWindowCap?: bigint; residualStreamRate?: bigint } = {}): Promise<TxResult & { subs: Allowance[]; residual: Allowance }> {
    if (owned.allowance.agentPk !== this.account.keys.pk) throw new Error('only the agent can delegate');
    if (subs.length === 0 || subs.length > DELEGATE_OUTPUTS) throw new Error(`1..${DELEGATE_OUTPUTS} subs per delegation`);
    await this.sync();
    const now = await this.latestTimestamp();
    const base = {
      root: this.tree.root, allowance: owned.allowance, path: this.tree.path(owned.index), agent: this.account.keys, now,
      subs: subs.map((s) => ({ ...s, agentPk: s.to.pk })), ...opts,
    };
    const draft = delegateInput({ ...base, extDataHash: 0n });
    const ext = {
      encryptedSubs: draft.subs.map((a, i) => (subs[i] ? toHex(allowanceMemo(a, { owner: owned.views.owner, agent: subs[i].to.viewPub })) : '0x')),
      encryptedResidual: toHex(allowanceMemo(draft.residual, owned.views)),
    };
    const extDataHash = hashExt(['tuple(bytes[4] encryptedSubs,bytes encryptedResidual)'], [ext]);
    // rebuild with the same sub notes (rho and placeholders fixed) and the bound ext hash
    const built = delegateInput({ ...base, extDataHash, subs: draft.subs.slice(0, subs.length).map((a) => ({
      agentPk: a.agentPk, amount: a.remaining, windowCap: a.policy.windowCap, maxPerTx: a.policy.maxPerTx, expiry: a.policy.expiry, streamRate: a.policy.streamRate, streamStart: a.policy.streamStart,
    })) });
    // delegateInput draws fresh rho per call; pin the draft's notes so memos and commitments agree
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

  /** Owner takes back what is left of an allowance into their own treasury. */
  async reclaim(owned: OwnedAllowance): Promise<TxResult & { next: Allowance }> {
    if (owned.allowance.policy.ownerPk !== this.account.keys.pk) throw new Error('not the owner');
    return this.spend(owned, owned.allowance.remaining, this.account.address, {});
  }

  private async spend(owned: OwnedAllowance, amount: bigint, to: string | StipendAddress, relay: Relay): Promise<TxResult & { next: Allowance }> {
    await this.sync();
    const a = owned.allowance;
    const isPublic = typeof to === 'string';
    const now = await this.latestTimestamp();
    const recipientPath = a.policy.recipientRoot !== 0n ? this.recipientPath(owned, to) : undefined;
    const payBlinding = randomField();
    const base = {
      root: this.tree.root, allowance: a, path: this.tree.path(owned.index), spender: this.account.keys, amount, now, fee: relay.fee,
      ...(isPublic ? { publicTo: addressToField(to) } : { shieldedTo: { pk: to.pk, blinding: payBlinding } }), recipientPath,
    };
    const draft = spendInput({ ...base, extDataHash: 0n });
    const ext = {
      relayer: relay.relayer ?? '0x0000000000000000000000000000000000000000',
      encryptedAllowance: toHex(allowanceMemo(draft.next, owned.views)),
      encryptedPayment: isPublic ? '0x' : toHex(noteMemo(draft.payNote, to.viewPub)),
    };
    const extDataHash = hashExt(['tuple(address relayer,bytes encryptedAllowance,bytes encryptedPayment)'], [ext]);
    const built = spendInput({ ...base, extDataHash });
    const proof = await this.prover.prove('spend', built.input);
    const args = {
      root: this.tree.root, nullifier: built.nullifier, newAllowanceCommitment: built.newAllowanceCommitment, payCommitment: built.payCommitment,
      publicAmount: isPublic ? amount : 0n, publicRecipient: isPublic ? to : '0x0000000000000000000000000000000000000000',
      publicAsset: isPublic ? fieldToAddress(a.asset) : '0x0000000000000000000000000000000000000000', fee: built.fee, timestamp: now,
      receipt: built.receipt, extDataHash,
    };
    const tx = await this.pool.spend(solProof(proof.proof), args, ext);
    const receipt = await tx.wait();
    await this.sync();
    return { receipt, proof, next: built.next };
  }

  /** Block time straight from the node; ethers caches "latest" briefly, which is too stale for a spend window. */
  private async latestTimestamp(): Promise<bigint> {
    const p = this.provider as Provider & { send?: (m: string, a: unknown[]) => Promise<{ timestamp: string }> };
    if (typeof p.send === 'function') {
      const block = await p.send('eth_getBlockByNumber', ['latest', false]);
      return BigInt(block.timestamp);
    }
    return BigInt((await p.getBlock('latest'))!.timestamp);
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
}

/** Anyone with the pool address can check a disclosure, on-chain or off. */
export async function verifyDisclosure(pool: Contract, proof: ProofResult, args: Record<string, bigint>): Promise<boolean> {
  return pool.verifyDisclosure(solProof(proof.proof), args);
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
