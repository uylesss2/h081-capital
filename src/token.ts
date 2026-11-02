// Phase 2 contracts (design 6.3): the H081 token, capacity staking and the
// safety pool. Deploy helpers for tests and scripts, connectors, and the pure
// capacity curve so a relayer can price capacity without a chain call.
// Nothing here is deployed to any public chain; the pool never reads these.
import { Contract, ContractFactory, Provider, Signer, type InterfaceAbi } from 'ethers';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const artifactsDir = resolve(import.meta.dirname, '..', 'build', 'artifacts', 'contracts');

function artifact(path: string) {
  return JSON.parse(readFileSync(join(artifactsDir, path), 'utf8')) as { abi: InterfaceAbi; bytecode: string };
}

export const TOKEN_ARTIFACT = 'token/StipendToken.sol/StipendToken.json';
export const CAPACITY_STAKE_ARTIFACT = 'token/CapacityStake.sol/CapacityStake.json';
export const SAFETY_POOL_ARTIFACT = 'token/SafetyPool.sol/SafetyPool.json';

/** Capacity curve constants, mirrored from CapacityStake.sol. */
export const DESK_UNIT = 100n * 10n ** 18n;
export const SHIELD_UNIT = 100n * 10n ** 18n;
export const SHIELD_PER_UNIT = 10_000n * 10n ** 6n;
export const CAPACITY_COOLDOWN = 7n * 86400n;
export const SAFETY_COOLDOWN = 14n * 86400n;

/** Desks a stake of `staked` H081 base units allows. */
export function deskCapacity(staked: bigint): bigint {
  return staked / DESK_UNIT;
}

/** USDG (6 decimals) per 30 days a stake of `staked` H081 base units allows. */
export function shieldCap(staked: bigint): bigint {
  return (staked / SHIELD_UNIT) * SHIELD_PER_UNIT;
}

const addressOf = async (c: Contract | string) => (typeof c === 'string' ? c : c.getAddress());

/** Deploys the H081 token; the whole `supply` goes to `signer`. */
export async function deployToken(signer: Signer, supply: bigint): Promise<Contract> {
  const a = artifact(TOKEN_ARTIFACT);
  const c = await new ContractFactory(a.abi, a.bytecode, signer).deploy(supply);
  await c.waitForDeployment();
  return c as unknown as Contract;
}

/** Deploys CapacityStake (no owner) for `token`. */
export async function deployCapacityStake(signer: Signer, token: Contract | string): Promise<Contract> {
  const a = artifact(CAPACITY_STAKE_ARTIFACT);
  const c = await new ContractFactory(a.abi, a.bytecode, signer).deploy(await addressOf(token));
  await c.waitForDeployment();
  return c as unknown as Contract;
}

/** Deploys SafetyPool (no owner) holding `token`, reading shortfalls from the StreamLoan registry `lending`. */
export async function deploySafetyPool(signer: Signer, token: Contract | string, lending: Contract | string): Promise<Contract> {
  const a = artifact(SAFETY_POOL_ARTIFACT);
  const c = await new ContractFactory(a.abi, a.bytecode, signer).deploy(await addressOf(token), await addressOf(lending));
  await c.waitForDeployment();
  return c as unknown as Contract;
}

export function connectToken(address: string, runner: Signer | Provider): Contract {
  return new Contract(address, artifact(TOKEN_ARTIFACT).abi, runner);
}

export function connectCapacityStake(address: string, runner: Signer | Provider): Contract {
  return new Contract(address, artifact(CAPACITY_STAKE_ARTIFACT).abi, runner);
}

export function connectSafetyPool(address: string, runner: Signer | Provider): Contract {
  return new Contract(address, artifact(SAFETY_POOL_ARTIFACT).abi, runner);
}
