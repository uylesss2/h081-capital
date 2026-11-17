// rep_registry (docs/REPUTATION-SPEC.md): program ids, PDAs, instruction builders, decoders, the RepAttested event log
// and the leaf set a prover needs. Reads only; nothing here signs.
import { sha256 } from '@noble/hashes/sha2';
import { Connection, PublicKey, SystemProgram, TransactionInstruction, type ConfirmedSignatureInfo } from '@solana/web3.js';
import { loanPk, repLeaf } from '../crypto.js';
import { MerkleTree } from '../merkle.js';
import { REP_LEVELS, REPUTATION_PUBLIC, audienceOf, type RepLoan, type RepPublic } from '../reputation.js';
import { be32, concatBytes, fieldOf, fromBe, u16le, u32le, u64le } from './field.js';
import { programDataAddress } from './program.js';
import { LOCALNET_LOAN_PROGRAM_ID, slotPda, subrogationPda } from './lender.js';

/** Localnet program id (solana/keys/rep_registry-keypair.json; declare_id in programs/rep_registry/src/lib.rs). */
export const LOCALNET_REP_PROGRAM_ID = new PublicKey('8w59GKraS4JrmDqYnqXcvjHTubnj7udMsuLXnscd3KEL');
/** Not deployed on mainnet yet (owner step: ceremony, deploy, initialize). */
export const MAINNET_REP_PROGRAM_ID: PublicKey | undefined = undefined;

export const REP_TREE_SIZE = 8856; // discriminator 8 + 8,848
export const REP_ROOT_HISTORY = 256;
export const REP_BITS_PER_PAGE = 8192n;

/** Anchor custom error codes of rep_registry (6000 + variant index). */
export const REP_ERROR = {
  PublicInputCount: 6000, InputNotInField: 6001, Bn254Syscall: 6002, InvalidProofEncoding: 6003, PoseidonSyscall: 6004, TreeFull: 6005,
  NotStreamLoanSlot: 6006, BadSubrogationAccount: 6007, NotFunded: 6008, NotRepaid: 6009, Slashed: 6010, TooSmall: 6011, BadAgentKey: 6012,
  NoFundingTime: 6013, AlreadyAttested: 6014, UnknownRoot: 6015, Expired: 6016, ExpiryTooFar: 6017, ThresholdOutOfRange: 6018,
  InvalidProof: 6019, UpgradeAuthority: 6020, WrongPage: 6021,
} as const;
export type RepErrorName = keyof typeof REP_ERROR;
export const REP_ERROR_NAME: Record<number, RepErrorName> = Object.fromEntries(Object.entries(REP_ERROR).map(([k, v]) => [v, k])) as Record<number, RepErrorName>;

const enc = (s: string) => new TextEncoder().encode(s);
const disc = (ns: string, name: string) => sha256(enc(`${ns}:${name}`)).subarray(0, 8);
const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });

export function repTreePda(programId = LOCALNET_REP_PROGRAM_ID, version = 0): PublicKey {
  return PublicKey.findProgramAddressSync([enc('reptree'), u16le(version)], programId)[0];
}

export function repBitsPda(loanRef: bigint, programId = LOCALNET_REP_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc('repbits'), u32le(Number(loanRef / REP_BITS_PER_PAGE))], programId)[0];
}

export interface RepPrograms { rep: PublicKey; loan: PublicKey }
export const LOCALNET_REP_PROGRAMS: RepPrograms = { rep: LOCALNET_REP_PROGRAM_ID, loan: LOCALNET_LOAN_PROGRAM_ID };

/** initialize(version): the upgrade authority opens tree `version` (the previous one must be full). */
export function repInitializeIx(payer: PublicKey, version = 0, programId = LOCALNET_REP_PROGRAM_ID): TransactionInstruction {
  const prev = version > 0 ? repTreePda(programId, version - 1) : programId; // Anchor: the program id stands for None
  return new TransactionInstruction({
    programId,
    keys: [w(repTreePda(programId, version)), r(prev), w(payer, true), r(SystemProgram.programId), r(programDataAddress(programId))],
    data: Buffer.from(concatBytes(disc('global', 'initialize'), u16le(version))),
  });
}

/** attest(loan_ref): permissionless. The SDK sends it from the relayer or the lender, never from the borrower. */
export function attestIx(payer: PublicKey, loanRef: bigint, p: RepPrograms = LOCALNET_REP_PROGRAMS, version = 0): TransactionInstruction {
  return new TransactionInstruction({
    programId: p.rep,
    keys: [
      w(payer, true), r(slotPda(loanRef, p.loan)), r(subrogationPda(loanRef, p.loan)), w(repTreePda(p.rep, version)),
      w(repBitsPda(loanRef, p.rep)), r(SystemProgram.programId),
    ],
    data: Buffer.from(concatBytes(disc('global', 'attest'), u64le(loanRef))),
  });
}

/** verify_reputation(proof 256 B, 13 inputs): reverts unless the proof is valid against a recent root. 8 + 256 + 416 = 680 B. */
export function verifyReputationIx(proof: Uint8Array, pub: RepPublic, programId = LOCALNET_REP_PROGRAM_ID, version = 0): TransactionInstruction {
  if (proof.length !== 256) throw new Error('proof must be 256 bytes');
  return new TransactionInstruction({
    programId,
    keys: [r(repTreePda(programId, version))],
    data: Buffer.from(concatBytes(disc('global', 'verify_reputation'), proof, ...REPUTATION_PUBLIC.map((k) => be32(pub[k])))),
  });
}

export interface RepTreeAccount { nextIndex: number; currentRootIndex: number; version: number; roots: bigint[]; root: bigint }

export function decodeRepTree(data: Uint8Array): RepTreeAccount {
  if (data.length !== REP_TREE_SIZE) throw new Error('not a RepTree account');
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const nextIndex = dv.getUint32(8, true), currentRootIndex = dv.getUint32(12, true), version = dv.getUint16(16, true);
  const base = 8 + 16 + 32 * REP_LEVELS;
  const roots = Array.from({ length: REP_ROOT_HISTORY }, (_, i) => fromBe(data.subarray(base + 32 * i, base + 32 * i + 32)));
  return { nextIndex, currentRootIndex, version, roots, root: roots[currentRootIndex] };
}

export function isKnownRepRootIn(t: RepTreeAccount, root: bigint): boolean {
  return root !== 0n && t.roots.includes(root);
}

export async function fetchRepTree(connection: Connection, programId = LOCALNET_REP_PROGRAM_ID, version = 0): Promise<RepTreeAccount | undefined> {
  const info = await connection.getAccountInfo(repTreePda(programId, version), 'confirmed');
  if (!info) return undefined;
  if (!info.owner.equals(programId)) throw new Error('the RepTree account is not owned by rep_registry');
  return decodeRepTree(info.data);
}

export async function isKnownRepRoot(connection: Connection, root: bigint, programId = LOCALNET_REP_PROGRAM_ID, version = 0): Promise<boolean> {
  const t = await fetchRepTree(connection, programId, version);
  return !!t && isKnownRepRootIn(t, root);
}

/** Whether loan `loanRef` is attested (its bit in the bitmap page). */
export async function isAttested(connection: Connection, loanRef: bigint, programId = LOCALNET_REP_PROGRAM_ID): Promise<boolean> {
  const info = await connection.getAccountInfo(repBitsPda(loanRef, programId), 'confirmed');
  if (!info) return false;
  const bit = Number(loanRef % REP_BITS_PER_PAGE);
  return ((info.data[8 + 4 + 1 + (bit >> 3)] >> (bit & 7)) & 1) === 1;
}

// ---- what can never be attested: backed loans and slashed loans
//
// A backed loan (stream_loan fund_backed, docs/BACKER-SPEC.md on the private-backer branch) is funded with
// pledge_bps = 0 and agent_pk = 0, and gets a Subrogation at funding that routes the backer's fee or recovery to the
// Backing's vault. A safety-pool slash also leaves a Subrogation. rep_registry refuses both the same way (any
// Subrogation: error Slashed, 6010), so a reader must not call a backed loan "slashed". The helpers below are a
// minimal READ-ONLY port of isBackedSlot / isBackedSubrogation from that branch's src/solana/backer.ts (same names and
// rules: Backing discriminator and size, owner = the stream_loan program); nothing else of the backer feature is here.

/** Size of stream_loan's Backing account (private-backer branch, BACKING_ACCOUNT_SIZE). */
export const BACKING_ACCOUNT_SIZE = 278;
const BACKING_DISC = disc('account', 'Backing');
/** True when `data` is a stream_loan Backing account (discriminator and size). */
export const isBackingAccount = (data: Uint8Array) => data.length >= BACKING_ACCOUNT_SIZE && BACKING_DISC.every((b, i) => data[i] === b);

/** A slot funded by fund_backed: no pledge (stream slots always have pledge_bps > 0). */
export const isBackedSlot = (s: { funded: boolean; pledgeBps: bigint }) => s.funded && s.pledgeBps === 0n;

/** True when a loan's Subrogation belongs to a backed line (its safety_config is a Backing of `loanProgram`), not to a slash. */
export async function isBackedSubrogation(connection: Pick<Connection, 'getAccountInfo'>, sub: { safetyConfig: PublicKey }, loanProgram = LOCALNET_LOAN_PROGRAM_ID): Promise<boolean> {
  const info = await connection.getAccountInfo(sub.safetyConfig, 'confirmed');
  return !!info && info.owner.equals(loanProgram) && isBackingAccount(info.data);
}

export type RepBlock = 'backed' | 'slashed' | 'no_agent_key';
export const REP_BLOCK_NOTE: Record<RepBlock, string> = {
  backed: 'a backed loan (funded against a backer\'s stake: no pledge, no agent key); its Subrogation is the backer\'s fee or recovery, not a slash. Backed loans never count toward reputation',
  slashed: 'the loan was slashed (a safety pool covered it and holds a Subrogation); it never counts toward reputation, even once recovered',
  no_agent_key: 'the loan has no agent key, so no account can ever prove it',
};

/**
 * Why a funded loan can never be attested, or undefined when nothing here blocks it (repaid and the minimum principal
 * are the caller's rules). The slot says backed (pledge_bps 0) first, so a closed or missing Backing never turns a backed
 * loan into a "slash"; then any Subrogation, labelled by isBackedSubrogation; then a zero agent key.
 */
export async function repBlockOf(
  connection: Pick<Connection, 'getAccountInfo'>, slot: { loanRef: bigint; funded: boolean; pledgeBps: bigint; agentPk: bigint }, loanProgram = LOCALNET_LOAN_PROGRAM_ID,
): Promise<RepBlock | undefined> {
  if (isBackedSlot(slot)) return 'backed';
  const info = await connection.getAccountInfo(subrogationPda(slot.loanRef, loanProgram), 'confirmed');
  if (info && info.data.length > 0) {
    // Subrogation: disc 8, loan_ref 8, safety_config 32 (offset 16), to 32, owed 8, paid 8, bump 1
    const backed = info.owner.equals(loanProgram) && info.data.length >= 48
      && await isBackedSubrogation(connection, { safetyConfig: new PublicKey(info.data.subarray(16, 48)) }, loanProgram).catch(() => false);
    return backed ? 'backed' : 'slashed';
  }
  if (slot.agentPk === 0n) return 'no_agent_key';
  return undefined;
}

// ---- events

export interface RepAttestedEvent {
  version: number; index: number; loanRef: bigint; leaf: bigint; root: bigint;
  agentPk: bigint; principal: bigint; assetF: bigint; lenderF: bigint; fundedDay: number;
}

const ATTESTED_DISC = disc('event', 'RepAttested');
const VERIFIED_DISC = disc('event', 'ReputationVerified');

export function decodeRepAttested(data: Uint8Array): RepAttestedEvent | undefined {
  if (data.length !== 8 + 2 + 4 + 8 + 32 + 32 + 32 + 8 + 32 + 32 + 4) return undefined;
  for (let i = 0; i < 8; i++) if (data[i] !== ATTESTED_DISC[i]) return undefined;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8;
  const u16 = () => { const v = dv.getUint16(o, true); o += 2; return v; };
  const u32 = () => { const v = dv.getUint32(o, true); o += 4; return v; };
  const u64 = () => { const v = dv.getBigUint64(o, true); o += 8; return v; };
  const b32 = () => { const v = fromBe(data.subarray(o, o + 32)); o += 32; return v; };
  return { version: u16(), index: u32(), loanRef: u64(), leaf: b32(), root: b32(), agentPk: b32(), principal: u64(), assetF: b32(), lenderF: b32(), fundedDay: u32() };
}

export function isReputationVerifiedEvent(data: Uint8Array): boolean {
  return data.length >= 8 && VERIFIED_DISC.every((b, i) => data[i] === b);
}

/**
 * "Program data:" lines EMITTED BY `programId` (a stack of invoke/success lines attributes each one, so another program
 * in the same transaction cannot pass its own log line off as a rep_registry event).
 */
export function programDataOf(logs: readonly string[], programId: PublicKey): Uint8Array[] {
  const id = programId.toBase58();
  const stack: string[] = [];
  const out: Uint8Array[] = [];
  for (const line of logs) {
    let m = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (m) { stack.push(m[1]); continue; }
    m = /^Program (\w+) (success|failed.*)$/.exec(line);
    if (m) { stack.pop(); continue; }
    if (line.startsWith('Program data: ') && stack[stack.length - 1] === id) out.push(Uint8Array.from(Buffer.from(line.slice(14), 'base64')));
  }
  return out;
}

export function repEventsOfLogs(logs: readonly string[], programId = LOCALNET_REP_PROGRAM_ID): RepAttestedEvent[] {
  return programDataOf(logs, programId).map(decodeRepAttested).filter((e): e is RepAttestedEvent => !!e);
}

/** A public snapshot of the leaf list (the relayer serves one; anyone can rebuild it from the chain). */
export interface RepSnapshot { version: number; program: string; events: Array<Record<keyof RepAttestedEvent, string | number>> }

export function snapshotOf(events: RepAttestedEvent[], programId: PublicKey, version = 0): RepSnapshot {
  return {
    version, program: programId.toBase58(),
    events: events.map((e) => Object.fromEntries(Object.entries(e).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])) as RepSnapshot['events'][number]),
  };
}

export function eventsOfSnapshot(s: RepSnapshot): RepAttestedEvent[] {
  return s.events.map((e) => ({
    version: Number(e.version), index: Number(e.index), loanRef: BigInt(e.loanRef), leaf: BigInt(e.leaf), root: BigInt(e.root),
    agentPk: BigInt(e.agentPk), principal: BigInt(e.principal), assetF: BigInt(e.assetF), lenderF: BigInt(e.lenderF), fundedDay: Number(e.fundedDay),
  }));
}

/**
 * Rebuilds the tree from `events` and checks it: indices 0..n-1 with no gap, each leaf equal to the hash of its fields,
 * and the resulting root known to the on-chain ring (`tree`). Throws on any mismatch.
 */
export function rebuildRepTree(events: RepAttestedEvent[], onChain?: RepTreeAccount): MerkleTree {
  const sorted = [...events].sort((a, b) => a.index - b.index);
  const t = new MerkleTree(REP_LEVELS);
  sorted.forEach((e, i) => {
    if (e.index !== i) throw new Error(`the reputation leaf list has a gap at index ${i}`);
    const leaf = repLeaf({ agentPk: e.agentPk, loanRef: e.loanRef, principal: e.principal, assetF: e.assetF, lenderF: e.lenderF, fundedDay: BigInt(e.fundedDay) });
    if (leaf !== e.leaf) throw new Error(`leaf ${i} does not match its fields`);
    t.insert(leaf);
    if (t.root !== e.root) throw new Error(`root after leaf ${i} does not match the event`);
  });
  if (onChain) {
    if (sorted.length !== onChain.nextIndex) throw new Error(`the leaf list has ${sorted.length} leaves; the chain has ${onChain.nextIndex}`);
    if (t.root !== onChain.root) throw new Error('the rebuilt reputation root is not the on-chain root');
  }
  return t;
}

/**
 * Every RepAttested event of tree `version`, from the transaction history of its RepTree PDA (each attest writes it).
 * Fetches everything (not just the caller's loans), so the request reveals nothing beyond the IP and the timing.
 */
export async function fetchRepEvents(connection: Connection, programId = LOCALNET_REP_PROGRAM_ID, version = 0): Promise<RepAttestedEvent[]> {
  return (await fetchRepEventsSince(connection, programId, version)).events;
}

/**
 * The RepAttested events of transactions newer than signature `until` (all of them without it), oldest first, and the
 * newest signature seen (the next call's `until`; undefined when there was nothing new). Lets a long-lived reader
 * top its list up with only the new transactions instead of refetching the whole history.
 */
export async function fetchRepEventsSince(
  connection: Connection, programId = LOCALNET_REP_PROGRAM_ID, version = 0, until?: string,
): Promise<{ events: RepAttestedEvent[]; newest?: string }> {
  const tree = repTreePda(programId, version);
  const sigs: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await connection.getSignaturesForAddress(tree, { before, until, limit: 1000 }, 'confirmed');
    sigs.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  const newest = sigs[0]?.signature;
  const out: RepAttestedEvent[] = [];
  for (const s of sigs.reverse()) {
    if (s.err) continue;
    const tx = await connection.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!tx?.meta || tx.meta.err) continue;
    out.push(...repEventsOfLogs(tx.meta.logMessages ?? [], programId).filter((e) => e.version === version));
  }
  return { events: out, newest };
}

/** The checked leaf set: events (from a snapshot when given, else the chain), the rebuilt tree, the on-chain tree. */
export async function fetchRepLeaves(connection: Connection, opts: { programId?: PublicKey; version?: number; snapshot?: RepSnapshot } = {}) {
  const programId = opts.programId ?? LOCALNET_REP_PROGRAM_ID, version = opts.version ?? 0;
  const onChain = await fetchRepTree(connection, programId, version);
  if (!onChain) throw new Error(`rep_registry tree ${version} is not initialized on this cluster`);
  let events = opts.snapshot ? eventsOfSnapshot(opts.snapshot) : await fetchRepEvents(connection, programId, version);
  // a snapshot may be behind: top it up from the chain when it is
  if (opts.snapshot && events.length < onChain.nextIndex) {
    const all = await fetchRepEvents(connection, programId, version);
    events = all;
  }
  const tree = rebuildRepTree(events, onChain);
  return { events, tree, onChain };
}

/**
 * The prover's own attested loans: events whose agent_pk is loanPk(masterSk, k) for some k. Keys are tried from 0 up
 * to `maxKey` (the bank's highest used index) plus a gap limit of 20 misses.
 */
export function myRepLoans(events: RepAttestedEvent[], masterSk: bigint, opts: { maxKey?: number; gap?: number; assetF?: bigint } = {}): RepLoan[] {
  const byPk = new Map<bigint, RepAttestedEvent[]>();
  for (const e of events) { const l = byPk.get(e.agentPk) ?? []; l.push(e); byPk.set(e.agentPk, l); }
  const gap = opts.gap ?? 20;
  const out: RepLoan[] = [];
  let misses = 0;
  for (let k = 0; k <= (opts.maxKey ?? -1) || misses < gap; k++) {
    const hits = byPk.get(loanPk(masterSk, k));
    if (!hits) { misses++; continue; }
    misses = 0;
    for (const e of hits) {
      if (opts.assetF !== undefined && e.assetF !== opts.assetF) continue;
      out.push({ loanRef: e.loanRef, principal: e.principal, assetF: e.assetF, lenderF: e.lenderF, fundedDay: BigInt(e.fundedDay), keyIndex: k, index: e.index });
    }
  }
  return out;
}

/** The audience field of a Solana key (domain separated from names; see audienceOf). */
export function audienceOfKey(key: PublicKey): bigint {
  return audienceOf(key.toBytes());
}

/** fieldOf(mint): the public `asset` input for a loan asset. */
export const repAssetOf = (mint: PublicKey) => fieldOf(mint);

