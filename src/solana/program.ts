// Instruction builders and account decoders for the stipend_pool program (Anchor wire format:
// 8-byte discriminator sha256("global:<name>")[0..8] followed by borsh arguments).
import { sha256 } from '@noble/hashes/sha2';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { be32, concatBytes, fromBe, u16le, u32le, u64le } from './field.js';
import { bufferPda, poolPda } from './pda.js';

/** Localnet program ids (from solana/keys/, declared in programs/stipend_pool/src/lib.rs). */
export const LOCALNET_POOL_PROGRAM_ID = new PublicKey('AzES8Vd7NmoxdSrEBbwDNAwn2pyoAz5m5w7bmVas5Si3');
/** Localnet-only build with `probe_insert` (feature merkle-probe). Never deployed anywhere else. */
export const LOCALNET_PROBE_PROGRAM_ID = new PublicKey('FWV9zZmHQoXE1M16eNcCTmzwVKft8RbS5zFUZ1od4hDR');

export const CIRCUIT_ID = { transact: 0, grant: 1, spend: 2, disclose: 3, delegate: 4, stream: 5 } as const;
export type CircuitId = keyof typeof CIRCUIT_ID;

/** Anchor custom error codes of stipend_pool (6000 + variant index). */
export const POOL_ERROR = {
  PublicInputCount: 6000, InputNotInField: 6001, Bn254Syscall: 6002, InvalidProofEncoding: 6003, InvalidProof: 6004,
  PoseidonSyscall: 6005, TreeFull: 6006, UnknownRoot: 6007, UnknownCircuit: 6008, BufferLength: 6009, BufferBounds: 6010,
  BufferPayload: 6011, ExtData: 6012, SameNullifier: 6013, PublicAmount: 6014, AssetMustBeHidden: 6015, AssetRequired: 6016,
  MissingAccount: 6017, AlreadySpent: 6018, NullifierAccount: 6019, StaleTimestamp: 6020, Recipient: 6021, Lender: 6022,
  AmountOverflow: 6023, WrongMint: 6024, WrongTokenAccount: 6025, WrongVault: 6026, WrongEscrow: 6027, NothingOwed: 6028,
  DepositShortfall: 6029, FeeExceedsAmount: 6030, WrongTokenProgram: 6031, BufferAuthority: 6032, AccountInUse: 6033, LenderAccount: 6034,
} as const;

export const LEVELS = 20;
/** Recent roots a proof may use (MerkleTreeWithHistory.ROOT_HISTORY_SIZE in the EVM reference). */
export const ROOT_HISTORY = 128;
export const BUFFER_HEADER = 8 + 32 + 8 + 4 + 1;
/** A buffer is created with up to this many payload bytes (CPI account creation is capped at 10 KiB)... */
export const BUFFER_MAX_INIT = 10_240 - BUFFER_HEADER;
/** ...and grows by 10 KiB per buffer_grow up to this. */
export const BUFFER_MAX_LEN = 96 * 1024;
export const BUFFER_GROW_STEP = 10_240;

export const disc = (name: string) => sha256(new TextEncoder().encode(`global:${name}`)).subarray(0, 8);
export const ix = (programId: PublicKey, name: string, keys: TransactionInstruction['keys'], ...args: Uint8Array[]) =>
  new TransactionInstruction({ programId, keys, data: Buffer.from(concatBytes(disc(name), ...args)) });
export const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
export const r = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });

/** Grows a buffer by up to 10 KiB toward its declared length. */
export function bufferGrowIx(programId: PublicKey, authority: PublicKey, seed: bigint): TransactionInstruction {
  return ix(programId, 'buffer_grow', [w(bufferPda(programId, authority, seed)), w(authority, true), r(SystemProgram.programId)], u64le(seed));
}

export function initializeIx(programId: PublicKey, payer: PublicKey): TransactionInstruction {
  return ix(programId, 'initialize', [w(poolPda(programId)), w(payer, true), r(SystemProgram.programId)]);
}

export function bufferOpenIx(programId: PublicKey, authority: PublicKey, seed: bigint, len: number): TransactionInstruction {
  return ix(programId, 'buffer_open', [w(bufferPda(programId, authority, seed)), w(authority, true), r(SystemProgram.programId)], u64le(seed), u32le(len));
}

export function bufferWriteIx(programId: PublicKey, authority: PublicKey, seed: bigint, offset: number, bytes: Uint8Array): TransactionInstruction {
  return ix(programId, 'buffer_write', [w(bufferPda(programId, authority, seed)), r(authority, true)], u64le(seed), u32le(offset), u32le(bytes.length), bytes);
}

export function bufferCloseIx(programId: PublicKey, authority: PublicKey, seed: bigint): TransactionInstruction {
  return ix(programId, 'buffer_close', [w(bufferPda(programId, authority, seed)), w(authority, true)], u64le(seed));
}

/** Stateless proof check; the buffer holds borsh (Proof, Vec<[u8; 32]>). */
export function verifyProofIx(programId: PublicKey, buffer: PublicKey, circuit: CircuitId): TransactionInstruction {
  return ix(programId, 'verify_proof', [r(buffer)], Uint8Array.of(CIRCUIT_ID[circuit]));
}

/** Known root + disclose proof; the buffer holds borsh (Proof, DiscloseArgs). */
export function verifyDisclosureIx(programId: PublicKey, buffer: PublicKey): TransactionInstruction {
  return ix(programId, 'verify_disclosure', [r(poolPda(programId)), r(buffer)]);
}

/** Known root + stream proof; the buffer holds borsh (Proof, StreamArgs). */
export function verifyStreamIx(programId: PublicKey, buffer: PublicKey): TransactionInstruction {
  return ix(programId, 'verify_stream', [r(poolPda(programId)), r(buffer)]);
}

/** Probe build only: append raw leaves. */
export function probeInsertIx(programId: PublicKey, leaves: bigint[]): TransactionInstruction {
  return ix(programId, 'probe_insert', [w(poolPda(programId))], u32le(leaves.length), ...leaves.map(be32));
}

// ------------------------------------------------------------- payload encoders

export interface DiscloseArgs { root: bigint; kind: bigint; bound: bigint; windowId: bigint; agentPk: bigint; audience: bigint }

/** borsh DiscloseArgs: six 32-byte big-endian field elements, in circuit order. */
export function encodeDiscloseArgs(a: DiscloseArgs): Uint8Array {
  return concatBytes(...[a.root, a.kind, a.bound, a.windowId, a.agentPk, a.audience].map(be32));
}

export interface StreamArgs {
  root: bigint; minRemaining: bigint; minRate: bigint; lender: PublicKey; loanRef: bigint; pledgeBps: number; expiry: bigint;
  lifetimeCap: bigint; pledgePaid: bigint; agentPk: bigint; audience: bigint; streamStart: bigint; asset: PublicKey;
}

/** borsh StreamArgs (lender and asset as pubkeys; the program maps them with fieldOf). */
export function encodeStreamArgs(a: StreamArgs): Uint8Array {
  return concatBytes(
    be32(a.root), be32(a.minRemaining), be32(a.minRate), a.lender.toBytes(), u64le(a.loanRef), u16le(a.pledgeBps), u64le(a.expiry),
    be32(a.lifetimeCap), be32(a.pledgePaid), be32(a.agentPk), be32(a.audience), u64le(a.streamStart), a.asset.toBytes(),
  );
}

// ------------------------------------------------------------- account decoders

export interface PoolState { nextIndex: number; currentRootIndex: number; filledSubtrees: bigint[]; roots: bigint[]; lastRoot: bigint }

/** Decodes the zero-copy Pool account (discriminator | u32 | u32 | [20][32] | [128][32]). */
export function decodePool(data: Uint8Array): PoolState {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const nextIndex = dv.getUint32(8, true);
  const currentRootIndex = dv.getUint32(12, true);
  const at = (o: number) => fromBe(data.subarray(o, o + 32));
  const filledSubtrees = Array.from({ length: LEVELS }, (_, i) => at(16 + 32 * i));
  const roots = Array.from({ length: ROOT_HISTORY }, (_, i) => at(16 + 32 * LEVELS + 32 * i));
  return { nextIndex, currentRootIndex, filledSubtrees, roots, lastRoot: roots[currentRootIndex] };
}
