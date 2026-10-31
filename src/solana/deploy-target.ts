// Which deployed stipend_pool a one-time setup script (scripts/mainnet-init.mts) talks to, and the checks that
// it is the right program before anything is signed. Read-only: getAccountInfo calls only.
//
// The SDK's LOCALNET_* ids are the test validators' programs. A public-cluster release is built with its own
// program id patched into the Rust sources (h081-deploy-staging/build-mainnet.sh), so the setup script must be
// told that id explicitly and must never fall back to the localnet one.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { LOCALNET_POOL_PROGRAM_ID } from './program.js';
import { type AccountReader, type DeployedProgram, executableHash, fetchDeployedProgram } from './verify.js';

export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

export interface PoolTargetOptions {
  /** POOL_PROGRAM_ID: the deployed stipend_pool program id. */
  programId?: string;
  /** KEYS_DIR: a keys directory holding stipend_pool-keypair.json (only its public key is used). */
  keysDir?: string;
  /** Genesis hash of the cluster the RPC serves. */
  genesis: string;
  /** The signer that will send initialize: must be the program's upgrade authority. */
  payer: PublicKey;
  /** POOL_SO: the .so that was deployed; its executable hash must match the program on chain. Required on mainnet. */
  expectSo?: Uint8Array;
}

/** Public key of `<keysDir>/stipend_pool-keypair.json` (the secret key is read only to derive it, never printed). */
export function programIdFromKeysDir(keysDir: string): PublicKey {
  const path = join(keysDir, 'stipend_pool-keypair.json');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')))).publicKey;
}

/** The program id from POOL_PROGRAM_ID and/or KEYS_DIR; both given must agree. Never a default. */
export function resolvePoolProgramId(opts: Pick<PoolTargetOptions, 'programId' | 'keysDir' | 'genesis'>): PublicKey {
  const fromEnv = opts.programId ? new PublicKey(opts.programId) : null;
  const fromKeys = opts.keysDir ? programIdFromKeysDir(opts.keysDir) : null;
  if (fromEnv && fromKeys && !fromEnv.equals(fromKeys)) {
    throw new Error(`POOL_PROGRAM_ID ${fromEnv.toBase58()} differs from ${opts.keysDir}/stipend_pool-keypair.json (${fromKeys.toBase58()})`);
  }
  const id = fromEnv ?? fromKeys;
  if (!id) throw new Error('set POOL_PROGRAM_ID (the deployed stipend_pool id) or KEYS_DIR (holding stipend_pool-keypair.json)');
  if (opts.genesis === MAINNET_GENESIS && id.equals(LOCALNET_POOL_PROGRAM_ID)) {
    throw new Error(`${id.toBase58()} is the localnet stipend_pool id; mainnet needs the id the mainnet build was patched with`);
  }
  return id;
}

/**
 * Resolves the stipend_pool to initialize and checks it before any transaction: deployed with the upgradeable
 * loader (initialize reads the ProgramData), upgrade authority = payer, and (required on mainnet) the deployed
 * executable equals the reviewed .so.
 */
export async function resolvePoolTarget(conn: AccountReader, opts: PoolTargetOptions): Promise<DeployedProgram> {
  const id = resolvePoolProgramId(opts);
  let deployed: DeployedProgram;
  try {
    deployed = await fetchDeployedProgram(conn, id);
  } catch (e) {
    throw new Error(`stipend_pool ${id.toBase58()} is not deployed on this cluster (${(e as Error).message})`);
  }
  if (deployed.loader !== 'upgradeable') throw new Error(`stipend_pool ${id.toBase58()} uses loader ${deployed.loader}; initialize needs the upgradeable loader`);
  if (!deployed.upgradeAuthority) throw new Error(`stipend_pool ${id.toBase58()} is final (no upgrade authority): initialize can never succeed`);
  if (!deployed.upgradeAuthority.equals(opts.payer)) {
    throw new Error(`the signer ${opts.payer.toBase58()} is not the upgrade authority of stipend_pool (${deployed.upgradeAuthority.toBase58()})`);
  }
  if (opts.expectSo) {
    const local = executableHash(opts.expectSo);
    if (local !== deployed.executableHash) throw new Error(`deployed stipend_pool ${deployed.executableHash} differs from the expected .so ${local}`);
  } else if (opts.genesis === MAINNET_GENESIS) {
    throw new Error('mainnet: set POOL_SO to the deployed stipend_pool.so so its hash is checked against the chain');
  }
  return deployed;
}

/** The 32 raw bytes of `key` occur in `elf` (a program id or address constant compiled into a .so). */
export function soContainsKey(elf: Uint8Array, key: PublicKey): boolean {
  return Buffer.from(elf).includes(key.toBuffer());
}

export interface ProgramTargetOptions {
  /** Label used in messages (e.g. "stream_loan"). */
  name: string;
  /** The deployed program id (given explicitly; never a localnet default on mainnet). */
  programId: PublicKey;
  /** Localnet ids this program must not be on mainnet (the SDK's LOCALNET_* id for it). */
  localnetIds?: PublicKey[];
  genesis: string;
  /** The signer of the one-time init: must be the program's upgrade authority. */
  payer: PublicKey;
  /** The .so that was deployed; its executable hash must match the chain. Required on mainnet. */
  expectSo?: Uint8Array;
  /** Addresses the .so must carry (its own id is always checked): e.g. the stipend_pool id, the treasury. */
  soMustContain?: PublicKey[];
  /** Addresses the .so must not carry (localnet ids of the programs it talks to). */
  soMustNotContain?: PublicKey[];
}

/**
 * Checks a deployed upgradeable program before its one-time init is signed: not a localnet id on mainnet,
 * upgradeable loader, upgrade authority = payer, and (required on mainnet) deployed executable = the reviewed
 * .so, which carries its own id and the given addresses. Read-only.
 */
export async function resolveProgramTarget(conn: AccountReader, opts: ProgramTargetOptions): Promise<DeployedProgram> {
  const { name, programId: id } = opts;
  if (opts.genesis === MAINNET_GENESIS && (opts.localnetIds ?? []).some((l) => l.equals(id))) {
    throw new Error(`${name} ${id.toBase58()} is a localnet id; mainnet needs the id the mainnet build was patched with`);
  }
  let deployed: DeployedProgram;
  try {
    deployed = await fetchDeployedProgram(conn, id);
  } catch (e) {
    throw new Error(`${name} ${id.toBase58()} is not deployed on this cluster (${(e as Error).message})`);
  }
  if (deployed.loader !== 'upgradeable') throw new Error(`${name} ${id.toBase58()} uses loader ${deployed.loader}; its init needs the upgradeable loader`);
  if (!deployed.upgradeAuthority) throw new Error(`${name} ${id.toBase58()} is final (no upgrade authority): its init can never succeed`);
  if (!deployed.upgradeAuthority.equals(opts.payer)) {
    throw new Error(`the signer ${opts.payer.toBase58()} is not the upgrade authority of ${name} (${deployed.upgradeAuthority.toBase58()})`);
  }
  if (opts.expectSo) {
    const local = executableHash(opts.expectSo);
    if (local !== deployed.executableHash) throw new Error(`deployed ${name} ${deployed.executableHash} differs from the expected .so ${local}`);
    for (const k of [id, ...(opts.soMustContain ?? [])]) {
      if (!soContainsKey(opts.expectSo, k)) throw new Error(`${name} .so does not carry ${k.toBase58()}`);
    }
    for (const k of opts.soMustNotContain ?? []) {
      if (soContainsKey(opts.expectSo, k)) throw new Error(`${name} .so carries the localnet id ${k.toBase58()}`);
    }
  } else if (opts.genesis === MAINNET_GENESIS) {
    throw new Error(`mainnet: give the deployed ${name}.so so its hash is checked against the chain`);
  }
  return deployed;
}
