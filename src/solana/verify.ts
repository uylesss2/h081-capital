// Read-only comparison of a locally built program with what a cluster runs (verifiable builds).
// The hash is the one solana-verify uses: sha256 of the ELF with trailing zero bytes removed. A deployed
// program's data is the ELF plus zero padding up to the account's max length, so stripping the zeros on
// both sides makes the two comparable. Nothing here signs or sends a transaction.
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { PublicKey, type AccountInfo } from '@solana/web3.js';

export const BPF_LOADER_UPGRADEABLE_ID = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
export const BPF_LOADER_2_ID = new PublicKey('BPFLoader2111111111111111111111111111111111');
export const BPF_LOADER_1_ID = new PublicKey('BPFLoader1111111111111111111111111111111111');
export const LOADER_V4_ID = new PublicKey('LoaderV411111111111111111111111111111111111');

/** UpgradeableLoaderState::size_of_programdata_metadata(): u32 tag, u64 slot, Option<Pubkey> (always 33 bytes). */
export const PROGRAMDATA_METADATA = 45;
/** LoaderV4State: u64 slot, Pubkey authority_address_or_next_version, u64 status. */
export const LOADER_V4_METADATA = 48;

/** The bytes solana-verify hashes: everything up to the last non-zero byte. */
export function stripTrailingZeros(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return bytes.subarray(0, end);
}

/** sha256 hex of an executable with its trailing zeros removed (`solana-verify get-executable-hash`). */
export function executableHash(elf: Uint8Array): string {
  return bytesToHex(sha256(stripTrailingZeros(elf)));
}

/** sha256 hex of the exact bytes (what `sha256sum` prints for a .so). */
export function fileHash(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

const u32le = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const u64le = (b: Uint8Array, o: number) => {
  let x = 0n;
  for (let i = 7; i >= 0; i--) x = (x << 8n) | BigInt(b[o + i]!);
  return x;
};

/** Loader-v3 `Program` account: tag 2, then the ProgramData address. */
export function programDataAddress(programAccountData: Uint8Array): PublicKey {
  if (programAccountData.length < 36 || u32le(programAccountData, 0) !== 2) throw new Error('not an upgradeable-loader Program account');
  return new PublicKey(programAccountData.subarray(4, 36));
}

export interface ProgramDataHeader {
  /** Slot of the last deployment. */
  slot: bigint;
  /** Upgrade authority, or null when the program is final (immutable). */
  upgradeAuthority: PublicKey | null;
}

/** Loader-v3 `ProgramData` account: tag 3, slot, Option<authority>, then the ELF padded with zeros. */
export function parseProgramData(data: Uint8Array): ProgramDataHeader & { elf: Uint8Array } {
  if (data.length < PROGRAMDATA_METADATA || u32le(data, 0) !== 3) throw new Error('not an upgradeable-loader ProgramData account');
  const slot = u64le(data, 4);
  const tag = data[12];
  if (tag !== 0 && tag !== 1) throw new Error(`bad Option tag ${tag} in ProgramData`);
  const upgradeAuthority = tag === 1 ? new PublicKey(data.subarray(13, 45)) : null;
  return { slot, upgradeAuthority, elf: data.subarray(PROGRAMDATA_METADATA) };
}

/** Loader-v4 program account: slot, authority (or next version), status (0 retracted, 1 deployed, 2 finalized). */
export function parseLoaderV4(data: Uint8Array): ProgramDataHeader & { elf: Uint8Array; status: bigint } {
  if (data.length < LOADER_V4_METADATA) throw new Error('loader-v4 account too short');
  const slot = u64le(data, 0);
  const status = u64le(data, 40);
  const upgradeAuthority = status === 2n ? null : new PublicKey(data.subarray(8, 40));
  return { slot, upgradeAuthority, status, elf: data.subarray(LOADER_V4_METADATA) };
}

export interface DeployedProgram {
  programId: PublicKey;
  loader: 'upgradeable' | 'v4' | 'v2' | 'v1';
  /** Where the ELF lives: the ProgramData account for the upgradeable loader, else the program account. */
  dataAccount: PublicKey;
  /** null when no authority can change the code (final / immutable). */
  upgradeAuthority: PublicKey | null;
  /** Slot of the last deployment, when the loader records one. */
  slot: bigint | null;
  elf: Uint8Array;
  executableHash: string;
}

/** The read-only subset of Connection this module needs. */
export interface AccountReader {
  getAccountInfo(key: PublicKey, commitment?: 'confirmed' | 'finalized'): Promise<AccountInfo<Buffer | Uint8Array> | null>;
}

/** Fetches a program's executable from a cluster (two getAccountInfo calls at most) and hashes it. */
export async function fetchDeployedProgram(conn: AccountReader, programId: PublicKey): Promise<DeployedProgram> {
  const acc = await conn.getAccountInfo(programId, 'finalized');
  if (!acc) throw new Error(`${programId.toBase58()}: no account on this cluster`);
  if (!acc.executable) throw new Error(`${programId.toBase58()}: account is not executable`);
  const data = Uint8Array.from(acc.data);
  if (acc.owner.equals(BPF_LOADER_UPGRADEABLE_ID)) {
    const dataAccount = programDataAddress(data);
    const pd = await conn.getAccountInfo(dataAccount, 'finalized');
    if (!pd) throw new Error(`${programId.toBase58()}: ProgramData ${dataAccount.toBase58()} missing`);
    if (!pd.owner.equals(BPF_LOADER_UPGRADEABLE_ID)) throw new Error(`${programId.toBase58()}: ProgramData has the wrong owner`);
    const { slot, upgradeAuthority, elf } = parseProgramData(Uint8Array.from(pd.data));
    return { programId, loader: 'upgradeable', dataAccount, upgradeAuthority, slot, elf, executableHash: executableHash(elf) };
  }
  if (acc.owner.equals(LOADER_V4_ID)) {
    const { slot, upgradeAuthority, elf } = parseLoaderV4(data);
    return { programId, loader: 'v4', dataAccount: programId, upgradeAuthority, slot, elf, executableHash: executableHash(elf) };
  }
  if (acc.owner.equals(BPF_LOADER_2_ID) || acc.owner.equals(BPF_LOADER_1_ID)) {
    return {
      programId, loader: acc.owner.equals(BPF_LOADER_2_ID) ? 'v2' : 'v1', dataAccount: programId, upgradeAuthority: null, slot: null,
      elf: data, executableHash: executableHash(data),
    };
  }
  throw new Error(`${programId.toBase58()}: owned by ${acc.owner.toBase58()}, not a known loader`);
}

export interface HashComparison {
  programId: string;
  local: string;
  deployed: string;
  match: boolean;
  loader: DeployedProgram['loader'];
  upgradeAuthority: string | null;
}

/** Compares a local .so (bytes) with the program a cluster runs at `programId`. */
export async function compareWithDeployed(conn: AccountReader, programId: PublicKey, localSo: Uint8Array): Promise<HashComparison> {
  const d = await fetchDeployedProgram(conn, programId);
  const local = executableHash(localSo);
  return {
    programId: programId.toBase58(), local, deployed: d.executableHash, match: local === d.executableHash, loader: d.loader,
    upgradeAuthority: d.upgradeAuthority?.toBase58() ?? null,
  };
}

/** Public RPC endpoints by cluster name; anything else is taken as a URL. */
export const CLUSTER_URLS: Record<string, string> = {
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
};

/** Genesis hashes of the public clusters, to name the cluster an RPC URL actually serves. */
export const GENESIS_HASHES: Record<string, string> = {
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'mainnet-beta',
  'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG': 'devnet',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY': 'testnet',
};

export function clusterUrl(nameOrUrl: string): string {
  const url = CLUSTER_URLS[nameOrUrl] ?? nameOrUrl;
  if (!/^https?:\/\//.test(url)) throw new Error(`unknown cluster ${nameOrUrl}: use mainnet-beta, devnet, testnet or an http(s) URL`);
  return url;
}
