// Phase-2 mainnet rehearsal on a PRIVATE local validator: the EXACT four mainnet .so files (stipend_pool as
// deployed at E16DK..., plus the stream_loan, safety_pool and capacity_stake builds of
// solana/scripts/build-phase2-mainnet.sh at their mainnet ids) loaded as UPGRADEABLE programs with a fresh local
// upgrade authority, a byte copy of the mainnet USDG mint (Token-2022, same extensions; issuer authorities
// swapped for a local key) and a copy of the H081 mint (same address and decimals; a local mint authority so
// the rehearsal can hold H081). It runs the real init scripts (mainnet-init.mts STEPS=loan,
// mainnet-init-h081.mts) and the user flows, and records compute units.
//
// Time: the mainnet builds have a 14-day (safety_pool) / 30-day (capacity_stake) cooldown and a 7-day loan
// grace; the local clock cannot be moved. So:
//   - the loan default path uses a real loan whose allowance expired more than 7 days ago (as lending.test.ts);
//   - withdraw / unstake AFTER the cooldown run on a second, fixture-loaded pool (mint "M2"): its config, vault
//     and the staker's position/stake (cooldown already over) are written at genesis in the programs' own
//     account layouts; the instructions that run against them are the real mainnet programs;
//   - the slash runs against the real defaulted loan (ref 2) with a fixture Cover for ref 2 (insure itself
//     needs expiry + grace >= now + 14 days, so it is exercised on a separate long loan, ref 3).
//
// Mainnet is only READ (getGenesisHash, getAccountInfo of the USDG and H081 mints, --clone-feature-set).
// Nothing is signed for any public cluster; every transaction goes to 127.0.0.1:<RPC_PORT>.
// Validator: rpc 9519 (+ws 9520), faucet 9954, gossip 8297, dynamic 9710-9810, ledger ~/h081-rehearsal2-ledger
// (never 8899/8900, nor the suites' 8999/9099/9199, the staging 9299 or the core rehearsal's 9499).
//
// Usage (Windows, repo root): npx tsx scripts/mainnet-rehearsal-phase2-localnet.mts
// Env: SO_DIR (default ../h081-deploy-staging/so-mainnet), POOL_PROGRAM_ID / LOAN_PROGRAM_ID / SAFETY_PROGRAM_ID /
//      CAPACITY_PROGRAM_ID (default the mainnet ids), LOAN_TREASURY (default the treasury Squads vault the
//      stream_loan build carries), <NAME>_SHA256 (optional pins: POOL_SHA256, LOAN_SHA256, SAFETY_SHA256,
//      CAPACITY_SHA256), MAINNET_READ_RPC, CLONE_FEATURES (1 default), KEEP_VALIDATOR=1.
// Output: solana/target-so/mainnet-rehearsal-phase2.json (gitignored).
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import {
  ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotent, getExtensionData, getExtensionTypes, getMint,
  getMintCloseAuthority, getMetadataPointerState, getPermanentDelegate, getTransferFeeConfig, mintTo,
} from '@solana/spl-token';
import { Account } from '../src/client.js';
import { initCrypto } from '../src/crypto.js';
import { randomViewingKey } from '../src/encryption.js';
import {
  LOCALNET_POOL_PROGRAM_ID, POOL_ERROR, SolanaPool, SolanaWallet, createVaultIx, customErrorCode, send, type SolOwnedAllowance,
} from '../src/solana/index.js';
import { MAINNET_GENESIS, resolveProgramTarget } from '../src/solana/deploy-target.js';
import { executableHash } from '../src/solana/verify.js';
import {
  GRACE, LOAN_ERROR, LOCALNET_LOAN_PROGRAM_ID, SolanaLoanLenderWallet, decodeRegistry, loanInitializeIx, loanTreasuryAccount, originationFee,
  payoutAudience, registryPda, slotInbox,
} from '../src/solana/lender.js';
import {
  CAPACITY_ERROR, LOCALNET_CAPACITY_STAKE_PROGRAM_ID, LOCALNET_SAFETY_POOL_PROGRAM_ID, SAFETY_ERROR, accountDiscriminator, capacityConfigPda,
  capacityInitConfigIx, capacityVaultPda, coverPda, decodeCapacityConfig, decodeCover, decodePosition, decodeSafetyConfig, decodeStake, insureIx,
  loanAccounts, minPremium, positionPda, redeemable, releaseCoverIx, requestUnbondIx, requestUnstakeIx, safetyConfigPda, safetyDepositIx,
  safetyInitPoolIx, safetySetDepositCapsIx, safetySetDepositsPausedIx, safetySetUnderwritingIx, safetyTopUpIx, safetyVaultPda, safetyWithdrawIx,
  setStakeCapsIx, setStakingPausedIx, sharesFor, slashIx, stakeIx, stakePda, unstakeIx, viewCapacity, viewShortfall,
} from '../src/solana/token.js';

const root = resolve(import.meta.dirname, '..');
const SO_DIR = resolve(root, process.env.SO_DIR ?? '../h081-deploy-staging/so-mainnet');
const ID = {
  pool: new PublicKey(process.env.POOL_PROGRAM_ID ?? 'E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM'),
  loan: new PublicKey(process.env.LOAN_PROGRAM_ID ?? '8JBd7epQXxdcKRMaWM1S5PC7nsQKoZq3uCetpiJ684g4'),
  safety: new PublicKey(process.env.SAFETY_PROGRAM_ID ?? 'HmzKNPn8LaRyjmggt2uT95B7KvphtoVXQkeVc2HHARTt'),
  capacity: new PublicKey(process.env.CAPACITY_PROGRAM_ID ?? 'CH1rrfFyJMVn158UHL2fLpKTtoLJojrz5f68toMQdQKU'),
};
const TREASURY = new PublicKey(process.env.LOAN_TREASURY ?? 'EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq');
const FILES = { pool: 'stipend_pool.so', loan: 'stream_loan.so', safety: 'safety_pool.so', capacity: 'capacity_stake.so' } as const;
const PINS = { pool: process.env.POOL_SHA256, loan: process.env.LOAN_SHA256, safety: process.env.SAFETY_SHA256, capacity: process.env.CAPACITY_SHA256 };
const LOCALNET = {
  pool: LOCALNET_POOL_PROGRAM_ID, loan: LOCALNET_LOAN_PROGRAM_ID, safety: LOCALNET_SAFETY_POOL_PROGRAM_ID, capacity: LOCALNET_CAPACITY_STAKE_PROGRAM_ID,
};
const MAINNET_READ_RPC = process.env.MAINNET_READ_RPC ?? 'https://api.mainnet-beta.solana.com';
const CLONE_FEATURES = process.env.CLONE_FEATURES !== '0';
const USDG = new PublicKey('2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH');
const H081 = new PublicKey('EgqxxR7zowzaLEm24oep5qqBieLVAWYX78LhgeqAJAo');
const T22 = TOKEN_2022_PROGRAM_ID;
const SPL = TOKEN_PROGRAM_ID;
const LAUNCH_WALLET = new PublicKey('2wjxKzH7fVGpjcA9KpjDBDHjSAhz7u8ZgMLnVPVGSkDP');
const PORTS = { rpc: 9519, faucet: 9954, gossip: 8297, dynamic: '9710-9810' };
const LEDGER = '$HOME/h081-rehearsal2-ledger';
const WDIR = '$HOME/h081-rehearsal2';
const RPC = `http://127.0.0.1:${PORTS.rpc}`;
const U = 1_000_000n; // 1 token, 6 decimals (USDG and H081)
const POOL_CAP_PER = 1_000n * U, POOL_CAP_TOTAL = 10_000n * U; // the bank's caps
const H081_MAX_TOTAL = 1_000_000n * U, H081_MAX_PER = 100_000n * U; // mainnet-init-h081.mts defaults
const BPS = 4000n;
const TX_CU_MAX = 1_400_000;
const DEFAULT_IX_CU = 200_000;
const OP_CU = 1_400_000;

// ------------------------------------------------------------------ helpers

const results: { step: string; ok: boolean; detail?: string }[] = [];
const cu: Record<string, { units: number; limit: number }> = {};
const sizes: Record<string, number> = {};
function record(step: string, ok: boolean, detail?: string) {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? `  (${detail})` : ''}`);
  if (!ok) process.exitCode = 1;
}
const cuOf = (name: string, units: number, limit = DEFAULT_IX_CU) => {
  cu[name] = { units, limit };
  console.log(`      cu ${name}: ${units.toLocaleString()} of ${limit.toLocaleString()}`);
};
async function expectCode(step: string, p: Promise<unknown>, code: number) {
  let caught: unknown;
  try { await p; } catch (e) { caught = e; }
  const got = caught === undefined ? undefined : customErrorCode(caught);
  record(step, got === code, caught === undefined ? 'unexpectedly succeeded' : `error ${got ?? String(caught).slice(0, 200)}, want ${code}`);
}
async function expectReject(step: string, p: Promise<unknown>, match?: RegExp) {
  let caught: unknown;
  try { await p; } catch (e) { caught = e; }
  const msg = caught === undefined ? '' : String((caught as Error).message ?? caught);
  record(step, caught !== undefined && (!match || match.test(msg)), caught === undefined ? 'unexpectedly succeeded' : msg.slice(0, 160));
}
const toWsl = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => `/mnt/${d.toLowerCase()}`);
function wsl(script: string, check = true) {
  const isWin = process.platform === 'win32';
  const [cmd, args] = isWin ? ['wsl.exe', ['-d', 'Ubuntu', '--exec', 'bash', '-c', script]] : ['bash', ['-c', script]];
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  if (check && r.status !== 0) throw new Error(`wsl failed (${r.status}): ${r.stdout}\n${r.stderr}`);
  return (r.stdout ?? '').trim();
}
const SOLANA_PATH = 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"';
const stopValidator = () => wsl(`pids=$(pgrep -f "[s]olana-test-validator --ledger ${LEDGER}" || true); if [ -n "$pids" ]; then kill $pids; echo "stopped $pids"; else echo "not running"; fi`, false);
/** Runs one of the repo's scripts against the local validator; returns exit status and output. */
function runScript(script: string, env: Record<string, string>) {
  const r = spawnSync(process.execPath, [resolve(root, 'node_modules/tsx/dist/cli.mjs'), resolve(root, 'scripts', script)], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...env, REHEARSE_LOCAL: '1', MAINNET_RPC: RPC }, timeout: 600_000,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { status: r.status, out };
}

// account encoders (Anchor: 8-byte discriminator + borsh), for the genesis fixtures
class W {
  parts: Uint8Array[] = [];
  key(k: PublicKey) { this.parts.push(k.toBytes()); return this; }
  u8(v: number) { this.parts.push(Uint8Array.of(v)); return this; }
  bool(v: boolean) { return this.u8(v ? 1 : 0); }
  u16(v: number) { const b = Buffer.alloc(2); b.writeUInt16LE(v); this.parts.push(b); return this; }
  u64(v: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); this.parts.push(b); return this; }
  i64(v: bigint) { const b = Buffer.alloc(8); b.writeBigInt64LE(v); this.parts.push(b); return this; }
  u128(v: bigint) { const b = Buffer.alloc(16); b.writeBigUInt64LE(v & 0xffffffffffffffffn); b.writeBigUInt64LE(v >> 64n, 8); this.parts.push(b); return this; }
  done(name: string) { return Buffer.concat([accountDiscriminator(name), ...this.parts]); }
}
function splMint(authority: PublicKey, supply: bigint, decimals: number): Buffer {
  const d = Buffer.alloc(82);
  d.writeUInt32LE(1, 0); authority.toBuffer().copy(d, 4); d.writeBigUInt64LE(supply, 36); d[44] = decimals; d[45] = 1;
  return d;
}
function splAccount(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const d = Buffer.alloc(165);
  mint.toBuffer().copy(d, 0); owner.toBuffer().copy(d, 32); d.writeBigUInt64LE(amount, 64); d[108] = 1;
  return d;
}
const pdaBump = (seeds: Uint8Array[], pid: PublicKey) => PublicKey.findProgramAddressSync(seeds, pid);
const enc = (s: string) => Buffer.from(s);
const u64le = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };

// ------------------------------------------------------------------ 1. the four .so files

const so = {} as Record<keyof typeof ID, Buffer>;
const soInfo = {} as Record<string, { path: string; bytes: number; sha256: string; executableHash: string }>;
for (const k of Object.keys(ID) as (keyof typeof ID)[]) {
  const path = join(SO_DIR, FILES[k]);
  so[k] = readFileSync(path);
  const sha = createHash('sha256').update(so[k]).digest('hex');
  soInfo[k] = { path, bytes: so[k].length, sha256: sha, executableHash: executableHash(so[k]) };
  console.log(`${FILES[k]}: ${so[k].length} bytes, sha256 ${sha}`);
  if (PINS[k] && PINS[k] !== sha) throw new Error(`${FILES[k]} sha256 ${sha} != pinned ${PINS[k]}`);
}
const has = (k: keyof typeof ID, key: PublicKey) => so[k].includes(key.toBuffer());
const allLocal = Object.values(LOCALNET);
for (const k of Object.keys(ID) as (keyof typeof ID)[]) {
  record(`${FILES[k]} carries its mainnet id ${ID[k].toBase58()} and no localnet id`, has(k, ID[k]) && !allLocal.some((l) => has(k, l)));
}
record('stream_loan.so and safety_pool.so carry the mainnet stipend_pool id', has('loan', ID.pool) && has('safety', ID.pool));
record('safety_pool.so carries the mainnet stream_loan id', has('safety', ID.loan));
record(`stream_loan.so carries the fee treasury ${TREASURY.toBase58()}`, has('loan', TREASURY));

// ------------------------------------------------------------------ 2. mainnet mints (read-only) -> local copies

const mainnet = new Connection(MAINNET_READ_RPC, 'confirmed');
const genesis = await mainnet.getGenesisHash();
if (genesis !== MAINNET_GENESIS) throw new Error(`MAINNET_READ_RPC serves genesis ${genesis}, not mainnet-beta`);
const usdgInfo = await mainnet.getAccountInfo(USDG, 'confirmed');
if (!usdgInfo || !usdgInfo.owner.equals(T22)) throw new Error('USDG mint not found on mainnet or not Token-2022');
const usdgMain = await getMint(mainnet, USDG, 'confirmed', T22);
const mainExt = getExtensionTypes(usdgMain.tlvData).map((t) => ExtensionType[t] ?? `type ${t}`);
const h081Info = await mainnet.getAccountInfo(H081, 'confirmed');
if (!h081Info || !h081Info.owner.equals(SPL)) throw new Error('H081 mint not found on mainnet or not SPL Token');
const h081Main = await getMint(mainnet, H081, 'confirmed', SPL);
console.log(`USDG mainnet: decimals ${usdgMain.decimals}, extensions ${mainExt.join(', ')}; H081 mainnet: SPL Token, decimals ${h081Main.decimals}, mint authority ${h081Main.mintAuthority?.toBase58() ?? 'none'}`);
record('USDG 6 decimals and H081 6 decimals on mainnet', usdgMain.decimals === 6 && h081Main.decimals === 6);

const issuer = Keypair.generate();
// USDG copy: every issuer authority swapped for the local issuer, supply 0, extension layout untouched
const usdgData = Buffer.from(usdgInfo.data);
const authorities = new Set<string>();
for (const k of [usdgMain.mintAuthority, usdgMain.freezeAuthority]) if (k) authorities.add(k.toBase58());
const tf = getTransferFeeConfig(usdgMain);
if (tf) { authorities.add(tf.transferFeeConfigAuthority.toBase58()); authorities.add(tf.withdrawWithheldAuthority.toBase58()); }
const pdel = getPermanentDelegate(usdgMain); if (pdel) authorities.add(pdel.delegate.toBase58());
const mca = getMintCloseAuthority(usdgMain); if (mca) authorities.add(mca.closeAuthority.toBase58());
const mpp = getMetadataPointerState(usdgMain); if (mpp?.authority) authorities.add(mpp.authority.toBase58());
for (const t of getExtensionTypes(usdgMain.tlvData)) {
  if (['ConfidentialTransferMint', 'TransferHook'].includes(ExtensionType[t]) || ExtensionType[t] === undefined) {
    const d = getExtensionData(t, usdgMain.tlvData);
    if (d && d.length >= 32 && d.subarray(0, 32).some((b) => b !== 0)) authorities.add(new PublicKey(d.subarray(0, 32)).toBase58());
  }
}
authorities.delete(PublicKey.default.toBase58());
for (const a of authorities) {
  const from = new PublicKey(a).toBuffer();
  for (let i = usdgData.indexOf(from); i !== -1; i = usdgData.indexOf(from, i + 32)) issuer.publicKey.toBuffer().copy(usdgData, i);
}
usdgData.writeBigUInt64LE(0n, 36);
// H081 copy: same address and decimals; the real mint has no mint authority, the copy gets the local issuer
const h081Data = Buffer.from(h081Info.data);
h081Data.writeUInt32LE(1, 0); issuer.publicKey.toBuffer().copy(h081Data, 4); h081Data.writeBigUInt64LE(0n, 36);

// ------------------------------------------------------------------ 3. keys and genesis fixtures

const upgradeAuthority = Keypair.generate(); // local test upgrade authority, this run only
const configAuthority = Keypair.generate();
const stranger = Keypair.generate();
const lenderKp = Keypair.generate();
const maturedStaker = Keypair.generate();
const m2 = Keypair.generate().publicKey; // fixture mint of the "cooldown already over" pools
const T0 = BigInt(Math.floor(Date.now() / 1000));
const fixtures: { pubkey: PublicKey; owner: PublicKey; data: Buffer }[] = [];
const put = (pubkey: PublicKey, owner: PublicKey, data: Buffer) => fixtures.push({ pubkey, owner, data });

// matured capacity_stake pool on M2: 500 tokens pending, cooldown over
const M2_STAKE = 500n * U;
const [capCfg, capBump] = pdaBump([enc('config'), m2.toBuffer()], ID.capacity);
const [capVault, capVaultBump] = pdaBump([enc('vault'), m2.toBuffer()], ID.capacity);
const [m2Stake, m2StakeBump] = pdaBump([enc('stake'), m2.toBuffer(), maturedStaker.publicKey.toBuffer()], ID.capacity);
put(capCfg, ID.capacity, new W().key(m2).key(SPL).key(capVault).u8(6).u64(100n * U).u64(100n * U).u64(0n).u64(M2_STAKE).u8(capBump).u8(capVaultBump)
  .key(configAuthority.publicKey).bool(false).u64(H081_MAX_TOTAL).u64(H081_MAX_PER).done('Config'));
put(capVault, SPL, splAccount(m2, capCfg, M2_STAKE));
put(m2Stake, ID.capacity, new W().key(maturedStaker.publicKey).key(m2).u64(0n).u64(M2_STAKE).i64(T0 - 3600n).u8(m2StakeBump).done('Stake'));
// matured safety_pool on M2: 1,000 tokens of assets, all shares unbonding, cooldown over
const M2_ASSETS = 1_000n * U;
const M2_SHARES = sharesFor(M2_ASSETS, 0n, 0n);
const [safCfg, safBump] = pdaBump([enc('safety'), m2.toBuffer()], ID.safety);
const [safVault, safVaultBump] = pdaBump([enc('vault'), m2.toBuffer()], ID.safety);
const [m2Pos, m2PosBump] = pdaBump([enc('position'), m2.toBuffer(), maturedStaker.publicKey.toBuffer()], ID.safety);
put(safCfg, ID.safety, new W().key(m2).key(SPL).key(safVault).u8(6).u128(M2_SHARES).u64(0n).u8(safBump).u8(safVaultBump).u64(M2_ASSETS)
  .key(configAuthority.publicKey).bool(false).u64(H081_MAX_TOTAL).u64(H081_MAX_PER).key(PublicKey.default).u64(0n).u64(0n).u16(0).u64(0n).done('SafetyConfig'));
put(safVault, SPL, splAccount(m2, safCfg, M2_ASSETS));
put(m2Pos, ID.safety, new W().key(maturedStaker.publicKey).key(m2).u128(0n).u128(M2_SHARES).i64(T0 - 3600n).u64(0n).u8(m2PosBump).done('Position'));
put(m2, SPL, splMint(issuer.publicKey, M2_STAKE + M2_ASSETS, 6));
// cover of the defaulted loan (ref 2) on the real H081 pool: the lender is lenderKp, limit 150 H081
const DEFAULT_REF = 2n, COVER_LIMIT = 150n * U;
const [cov2, cov2Bump] = pdaBump([enc('cover'), u64le(DEFAULT_REF)], ID.safety);
put(cov2, ID.safety, new W().u64(DEFAULT_REF).key(H081).key(lenderKp.publicKey).u64(0n).i64(T0 - 86400n).bool(false).u64(0n).u8(cov2Bump).u64(COVER_LIMIT).bool(false).done('Cover'));

// ------------------------------------------------------------------ 4. private validator

const work = mkdtempSync(join(tmpdir(), 'h081-rehearsal2-'));
mkdirSync(join(work, 'accounts'));
const acctJson = (pubkey: PublicKey, owner: PublicKey, data: Buffer, lamports = LAMPORTS_PER_SOL) => JSON.stringify({
  pubkey: pubkey.toBase58(), account: { lamports, data: [data.toString('base64'), 'base64'], owner: owner.toBase58(), executable: false, rentEpoch: 0, space: data.length },
});
writeFileSync(join(work, 'accounts', 'usdg.json'), acctJson(USDG, T22, usdgData, usdgInfo.lamports));
writeFileSync(join(work, 'accounts', 'h081.json'), acctJson(H081, SPL, h081Data, h081Info.lamports));
fixtures.forEach((f, i) => writeFileSync(join(work, 'accounts', `f${i}.json`), acctJson(f.pubkey, f.owner, f.data)));
const deployerFile = join(work, 'upgrade-authority.json'); // local throwaway key for the init scripts
writeFileSync(deployerFile, JSON.stringify([...upgradeAuthority.secretKey]));
const strangerFile = join(work, 'stranger.json');
writeFileSync(strangerFile, JSON.stringify([...stranger.secretKey]));

console.log(stopValidator());
const featureArgs = CLONE_FEATURES ? `--url ${MAINNET_READ_RPC} --clone-feature-set` : '';
const progArgs = (Object.keys(ID) as (keyof typeof ID)[]).map((k) => `--upgradeable-program ${ID[k].toBase58()} "$D/${FILES[k]}" ${upgradeAuthority.publicKey.toBase58()}`).join(' ');
const connection = new Connection(RPC, 'confirmed');
let exitCode = 0;
try {
  console.log(wsl([
    SOLANA_PATH, 'set -e', `D=${WDIR}`, 'rm -rf "$D"', 'mkdir -p "$D/accounts"',
    ...(Object.keys(ID) as (keyof typeof ID)[]).map((k) => `cp "${toWsl(join(SO_DIR, FILES[k]))}" "$D/${FILES[k]}"`),
    `cp "${toWsl(join(work, 'accounts'))}"/*.json "$D/accounts/"`,
    `setsid nohup solana-test-validator --ledger ${LEDGER} --reset --quiet --rpc-port ${PORTS.rpc} --faucet-port ${PORTS.faucet} ` +
    `--gossip-port ${PORTS.gossip} --dynamic-port-range ${PORTS.dynamic} ${featureArgs} ${progArgs} --account-dir "$D/accounts" ` +
    `> "$D/validator.log" 2>&1 < /dev/null & true`,
    `for i in $(seq 1 180); do curl -s -m 2 -X POST -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' http://127.0.0.1:${PORTS.rpc} | grep -q '"ok"' && { echo "validator healthy on ${PORTS.rpc}"; exit 0; }; sleep 1; done; tail -30 "$D/validator.log"; exit 1`,
  ].join(' ; ')));
  for (let i = 0; ; i++) {
    try { await connection.getVersion(); await connection.getLatestBlockhash(); break; } catch { /* starting */ }
    if (i > 120) throw new Error(`validator did not start: ${wsl(`tail -30 ${WDIR}/validator.log`, false)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  for (const k of Object.keys(ID) as (keyof typeof ID)[]) {
    for (let i = 0; !(await connection.getAccountInfo(ID[k], 'finalized')); i++) {
      if (i > 120) throw new Error(`${FILES[k]} not visible at finalized`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const localGenesis = await connection.getGenesisHash();
  record('local validator is not mainnet', localGenesis !== MAINNET_GENESIS, `genesis ${localGenesis}, rpc ${RPC}, features ${CLONE_FEATURES ? 'cloned from mainnet' : 'all'}`);
  await run(connection, localGenesis);
} catch (e) {
  console.error(e);
  record('rehearsal ran to the end', false, String((e as Error).message ?? e).slice(0, 400));
  exitCode = 1;
} finally {
  if (process.env.KEEP_VALIDATOR !== '1') console.log('validator:', stopValidator());
}
const out = resolve(root, 'solana', 'target-so');
mkdirSync(out, { recursive: true });
const failed = results.filter((r) => !r.ok);
writeFileSync(join(out, 'mainnet-rehearsal-phase2.json'), JSON.stringify({
  ran: new Date().toISOString(), so: soInfo, programIds: Object.fromEntries(Object.entries(ID).map(([k, v]) => [k, v.toBase58()])), treasury: TREASURY.toBase58(),
  rpc: RPC, featureSet: CLONE_FEATURES ? 'mainnet (cloned)' : 'all', usdgMainnet: { decimals: usdgMain.decimals, extensions: mainExt },
  accountSizes: sizes, computeUnits: cu, results,
}, null, 2) + '\n');
console.log(`\n${results.length - failed.length}/${results.length} checks passed; results in solana/target-so/mainnet-rehearsal-phase2.json`);
console.table(Object.fromEntries(Object.entries(cu).map(([k, v]) => [k, { units: v.units, limit: v.limit, headroom: `${(100 - (100 * v.units) / v.limit).toFixed(1)}%` }])));
console.log('account sizes', sizes);
process.exit(exitCode || (failed.length ? 1 : 0));

// ------------------------------------------------------------------ 5. the flow

async function run(conn: Connection, localGenesis: string) {
  await initCrypto();
  const airdrop = async (k: PublicKey, sol: number) => {
    const sig = await conn.requestAirdrop(k, sol * LAMPORTS_PER_SOL);
    await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash('confirmed')) }, 'confirmed');
  };
  const ownerKp = Keypair.generate(), agentKp = Keypair.generate(), borrowerKp = Keypair.generate(), vendorKp = Keypair.generate(), stakerKp = Keypair.generate();
  for (const k of [upgradeAuthority, configAuthority, stranger, lenderKp, maturedStaker, issuer, ownerKp, agentKp, borrowerKp, vendorKp, stakerKp]) await airdrop(k.publicKey, 20);
  const pool = new SolanaPool(conn, ID.pool);
  const bal = (a: PublicKey) => pool.tokenBalance(a);
  const sizeOf = async (name: string, k: PublicKey) => { const a = await conn.getAccountInfo(k, 'confirmed'); sizes[name] = a?.data.length ?? -1; return sizes[name]; };

  // --- every program on chain = its .so, upgradeable, upgrade authority = the local key (the init scripts' checks)
  for (const k of Object.keys(ID) as (keyof typeof ID)[]) {
    const t = await resolveProgramTarget(conn, {
      name: FILES[k], programId: ID[k], genesis: localGenesis, payer: upgradeAuthority.publicKey, expectSo: so[k],
      soMustContain: k === 'loan' ? [ID.pool, TREASURY] : k === 'safety' ? [ID.pool, ID.loan] : [], soMustNotContain: allLocal,
    });
    record(`${FILES[k]} on chain: upgradeable, upgrade authority = local key, executable = the .so`, t.executableHash === soInfo[k].executableHash, t.executableHash);
  }
  const localUsdg = await getMint(conn, USDG, 'confirmed', T22);
  record('local USDG copy has the mainnet extensions', getExtensionTypes(localUsdg.tlvData).map((t) => ExtensionType[t] ?? `type ${t}`).join() === mainExt.join());

  // --- stipend_pool as on mainnet: initialize + grow_pool, USDG vault, caps 1,000 / 10,000
  const guard = { authority: configAuthority.publicKey, maxTotal: POOL_CAP_TOTAL, maxPerDeposit: POOL_CAP_PER };
  await pool.initialize(upgradeAuthority, guard);
  await send(conn, upgradeAuthority, [createVaultIx(ID.pool, upgradeAuthority.publicKey, USDG, T22)]);
  record('stipend_pool initialized as on mainnet (caps 1,000 / 10,000 USDG, USDG vault)', true);

  // --- unauthorized inits are refused (each program reads its ProgramData upgrade authority)
  const h081Caps = { authority: stranger.publicKey, maxTotal: 1n << 60n, maxPerDeposit: 1n << 60n };
  await expectCode('stream_loan initialize by a stranger is refused', send(conn, stranger, [loanInitializeIx(stranger.publicKey, ID.loan)]), LOAN_ERROR.UpgradeAuthority);
  await expectCode('capacity_stake init_config by a stranger is refused',
    send(conn, stranger, [capacityInitConfigIx(ID.capacity, stranger.publicKey, H081, { authority: stranger.publicKey, maxTotal: 1n << 60n, maxPerStake: 1n << 60n }, SPL)]), CAPACITY_ERROR.UpgradeAuthority);
  await expectCode('safety_pool init_pool by a stranger is refused', send(conn, stranger, [safetyInitPoolIx(ID.safety, stranger.publicKey, H081, h081Caps, SPL)]), SAFETY_ERROR.UpgradeAuthority);
  record('no registry / configs after the refused attempts', !(await conn.getAccountInfo(registryPda(ID.loan))) && !(await conn.getAccountInfo(capacityConfigPda(ID.capacity, H081)))
    && !(await conn.getAccountInfo(safetyConfigPda(ID.safety, H081))));

  // --- the init scripts refuse a wrong signer or a wrong .so before signing anything
  const loanEnv = {
    DEPLOYER_KEY: deployerFile, POOL_PROGRAM_ID: ID.pool.toBase58(), POOL_SO: join(SO_DIR, FILES.pool), USDG_MINT: USDG.toBase58(),
    STEPS: 'loan', LOAN_PROGRAM_ID: ID.loan.toBase58(), LOAN_SO: join(SO_DIR, FILES.loan), LOAN_TREASURY: TREASURY.toBase58(),
  };
  const h081Env = {
    DEPLOYER_KEY: deployerFile, H081_MINT: H081.toBase58(), CAPACITY_PROGRAM_ID: ID.capacity.toBase58(), SAFETY_PROGRAM_ID: ID.safety.toBase58(),
    LOAN_PROGRAM_ID: ID.loan.toBase58(), POOL_PROGRAM_ID: ID.pool.toBase58(), CAPACITY_SO: join(SO_DIR, FILES.capacity), SAFETY_SO: join(SO_DIR, FILES.safety),
    CONFIG_AUTHORITY: configAuthority.publicKey.toBase58(),
  };
  let r = runScript('mainnet-init.mts', { ...loanEnv, DEPLOYER_KEY: strangerFile });
  record('mainnet-init.mts refuses a signer that is not the upgrade authority', r.status !== 0 && /not the upgrade authority/.test(r.out), r.out.split('\n').find((l) => /upgrade authority/.test(l))?.slice(0, 160));
  r = runScript('mainnet-init.mts', { ...loanEnv, LOAN_SO: join(SO_DIR, FILES.safety) });
  record('mainnet-init.mts refuses a stream_loan whose deployed hash is not LOAN_SO', r.status !== 0 && /differs from the expected/.test(r.out));
  r = runScript('mainnet-init.mts', { ...loanEnv, LOAN_TREASURY: Keypair.generate().publicKey.toBase58() });
  record('mainnet-init.mts refuses a LOAN_TREASURY the .so does not carry', r.status !== 0 && /does not carry/.test(r.out));
  r = runScript('mainnet-init-h081.mts', { ...h081Env, SAFETY_SO: join(SO_DIR, FILES.capacity) });
  record('mainnet-init-h081.mts refuses a safety_pool whose deployed hash is not SAFETY_SO', r.status !== 0 && /differs from the expected/.test(r.out));
  r = runScript('mainnet-init-h081.mts', { ...h081Env, DEPLOYER_KEY: strangerFile });
  record('mainnet-init-h081.mts refuses a signer that is not the upgrade authority', r.status !== 0 && /not the upgrade authority/.test(r.out));
  record('still no registry / configs after the refused script runs', !(await conn.getAccountInfo(registryPda(ID.loan))) && !(await conn.getAccountInfo(capacityConfigPda(ID.capacity, H081))));

  // --- the real inits, through the mainnet scripts (then re-run: idempotent)
  r = runScript('mainnet-init.mts', loanEnv);
  console.log(r.out.split('\n').filter((l) => /stream_loan|registry|treasury|done|balance/.test(l)).map((l) => `      | ${l}`).join('\n'));
  const reg = await conn.getAccountInfo(registryPda(ID.loan), 'confirmed');
  const treasuryAta = loanTreasuryAccount(USDG, T22, TREASURY);
  record('mainnet-init.mts STEPS=loan: registry initialized (next ref 1) and the treasury USDG account exists', r.status === 0 && !!reg && decodeRegistry(reg.data).nextLoanRef === 1n
    && !!(await conn.getAccountInfo(treasuryAta)), `treasury ATA ${treasuryAta.toBase58()}`);
  await sizeOf('stream_loan registry', registryPda(ID.loan));
  await sizeOf('treasury USDG ATA (Token-2022)', treasuryAta);
  r = runScript('mainnet-init-h081.mts', h081Env);
  console.log(r.out.split('\n').filter((l) => /config|pool|OK|FAIL|CU/.test(l)).map((l) => `      | ${l}`).join('\n'));
  record('mainnet-init-h081.mts: capacity_stake config + safety_pool pool for H081, authority and caps read back', r.status === 0 && /OK +capacity_stake config/.test(r.out) && /OK +safety_pool config/.test(r.out) && !/FAIL/.test(r.out));
  for (const m of r.out.matchAll(/(capacity_stake config|safety_pool pool): done \(.*?, (\d+) CU\)/g)) cuOf(m[1] === 'capacity_stake config' ? 'capacity_stake init_config' : 'safety_pool init_pool', Number(m[2]));
  await sizeOf('capacity_stake config', capacityConfigPda(ID.capacity, H081));
  await sizeOf('capacity_stake vault (H081, SPL)', capacityVaultPda(ID.capacity, H081));
  await sizeOf('safety_pool config', safetyConfigPda(ID.safety, H081));
  await sizeOf('safety_pool vault (H081, SPL)', safetyVaultPda(ID.safety, H081));
  const r1 = runScript('mainnet-init.mts', loanEnv), r2 = runScript('mainnet-init-h081.mts', h081Env);
  record('both init scripts re-run cleanly ("already done", checks pass)', r1.status === 0 && r2.status === 0 && /already done/.test(r1.out) && /already done/.test(r2.out));
  await expectReject('a second stream_loan initialize by the upgrade authority fails', send(conn, upgradeAuthority, [loanInitializeIx(upgradeAuthority.publicKey, ID.loan)]));

  // ================================================================ loans (USDG)
  const usdgAta = async (owner: PublicKey) => createAssociatedTokenAccountIdempotent(conn, issuer, USDG, owner, { commitment: 'confirmed' }, T22);
  const h081Ata = async (owner: PublicKey) => createAssociatedTokenAccountIdempotent(conn, issuer, H081, owner, { commitment: 'confirmed' }, SPL);
  const ownerUsdg = await usdgAta(ownerKp.publicKey), lenderUsdg = await usdgAta(lenderKp.publicKey), payout = await usdgAta(borrowerKp.publicKey);
  await mintTo(conn, issuer, USDG, ownerUsdg, issuer, 5_000n * U, [], { commitment: 'confirmed' }, T22);
  await mintTo(conn, issuer, USDG, lenderUsdg, issuer, 1_000n * U, [], { commitment: 'confirmed' }, T22);
  const owner = new SolanaWallet(Account.random(), pool, ownerKp);
  const lender = new SolanaLoanLenderWallet(pool, lenderKp, randomViewingKey(), ID.loan, TREASURY);
  const current = (w: SolanaWallet): SolOwnedAllowance => {
    const list = w.agentAllowances(USDG).filter((a) => a.allowance.remaining > 0n);
    if (list.length !== 1) throw new Error(`expected one live allowance, got ${list.length}`);
    return list[0];
  };
  const dep = await owner.deposit(USDG, POOL_CAP_PER);
  cuOf('stipend_pool transact_deposit', dep.tx.computeUnits, OP_CU);
  await expectCode('bank: deposit over the 1,000 USDG per-deposit cap is refused', owner.deposit(USDG, POOL_CAP_PER + 1n), POOL_ERROR.DepositTooLarge);

  // loan 1: borrow, repay through routed shares and a lender claim
  const ref1 = await lender.openSlot();
  record('loan 1: slot ref 1 opened', ref1 === 1n);
  const b = new SolanaWallet(Account.random(), pool, agentKp);
  let now = await pool.now();
  const g1 = await owner.grant(USDG, [{ to: b.address, amount: 500n * U, streamRate: 10n * U, expiry: now + 86400n, pledge: lender.terms(ref1, BPS) }]);
  cuOf('stipend_pool grant (pledged stream)', g1.tx.computeUnits, OP_CU);
  lender.ingest(g1.lenderPayloads[0]!);
  await b.sync();
  const s1 = await b.proveStream(current(b), { minRemaining: 500n * U, minRate: 10n * U, audience: payoutAudience(payout) });
  await lender.sync();
  const principal1 = 100n * U, fee1 = originationFee(principal1);
  const payoutBefore = await bal(payout), treasuryBefore = await bal(treasuryAta);
  const f1 = await lender.fund(ref1, s1, USDG, principal1, payout);
  cuOf('stream_loan fund (verify_stream CPI)', f1.computeUnits, OP_CU);
  record('loan 1 funded: borrower gets principal - 0.25%, the treasury USDG account the fee', (await bal(payout)) === payoutBefore + principal1 - fee1 && (await bal(treasuryAta)) === treasuryBefore + fee1,
    `principal ${principal1}, fee ${fee1}`);
  await expectCode('loan 1 cannot be funded twice', lender.fundUnchecked(ref1, s1, USDG, principal1, payout), LOAN_ERROR.AlreadyFunded);
  const streamStart = current(b).allowance.policy.streamStart;
  while ((await pool.now()) < streamStart + 16n) await new Promise((res) => setTimeout(res, 1000));
  const lenderBefore = await bal(lenderUsdg);
  const p1 = await b.pay(current(b), 100n * U, vendorKp.publicKey);
  cuOf('stipend_pool spend with lender share', p1.tx.computeUnits, OP_CU);
  record('agent payment routes the 40% pledge share to the slot inbox', (await bal(slotInbox(ref1, USDG, T22, ID.loan))) === 40n * U);
  const sy = await lender.syncLoan(ref1, undefined, stranger);
  cuOf('stream_loan sync', sy.computeUnits);
  record('sync (permissionless) credits 40 USDG as repayment and forwards it to the lender', (await lender.loan(ref1)).repaid === 40n * U && (await bal(lenderUsdg)) === lenderBefore + 40n * U);
  await lender.sync();
  const pc = await lender.prepareClaim(ref1);
  const cl = await lender.submitClaim(pc);
  cuOf('stream_loan claim (spend CPI)', cl.computeUnits, OP_CU);
  record('lender claims the vested share through the registry; repaid grows by the claim', (await lender.loan(ref1)).repaid === 40n * U + pc.amount, `claim ${pc.amount}`);
  const sh1 = await lender.shortfall(ref1);
  record('loan 1 (not expired) reports no shortfall', sh1 === 0n);

  // loan 2: default (allowance expired more than GRACE ago, nothing repaid)
  const ref2 = await lender.openSlot();
  record('loan 2: slot ref 2 opened (the fixture cover is for ref 2)', ref2 === DEFAULT_REF);
  const c = new SolanaWallet(Account.random(), pool, agentKp);
  now = await pool.now();
  const expiry2 = now - GRACE - 60n;
  const g2 = await owner.grant(USDG, [{ to: c.address, amount: 300n * U, streamRate: 1n * U, streamStart: expiry2 - 100_000n, expiry: expiry2, pledge: lender.terms(ref2, BPS) }]);
  lender.ingest(g2.lenderPayloads[0]!);
  await c.sync();
  const s2 = await c.proveStream(current(c), { minRemaining: 300n * U, minRate: 1n * U, audience: payoutAudience(payout) });
  await lender.sync();
  const principal2 = 100n * U;
  await lender.fund(ref2, s2, USDG, principal2, payout);
  const sh2 = await lender.shortfall(ref2);
  record('loan 2 (expired + grace, unpaid) reports the full principal as shortfall', sh2 === principal2, `shortfall ${sh2}`);

  // loan 3: long loan (expiry in 8 days) that the safety pool can insure for real
  const ref3 = await lender.openSlot();
  const d3 = new SolanaWallet(Account.random(), pool, agentKp);
  now = await pool.now();
  const g3 = await owner.grant(USDG, [{ to: d3.address, amount: 150n * U, streamRate: 1n * U, streamStart: now - 10n, expiry: now + 8n * 86400n, pledge: lender.terms(ref3, BPS) }]);
  lender.ingest(g3.lenderPayloads[0]!);
  await d3.sync();
  const s3 = await d3.proveStream(current(d3), { minRemaining: 150n * U, minRate: 1n * U, audience: payoutAudience(payout) });
  await lender.sync();
  const principal3 = 50n * U;
  await lender.fund(ref3, s3, USDG, principal3, payout);
  record('loan 3 funded (expiry in 8 days)', (await lender.loan(ref3)).funded);

  // ================================================================ safety_pool (H081)
  const S = ID.safety;
  const stakerH = await h081Ata(stakerKp.publicKey), lenderH = await h081Ata(lenderKp.publicKey), strangerH = await h081Ata(stranger.publicKey);
  await mintTo(conn, issuer, H081, stakerH, issuer, 3_000_000n * U, [], { commitment: 'confirmed' }, SPL);
  await mintTo(conn, issuer, H081, lenderH, issuer, 100n * U, [], { commitment: 'confirmed' }, SPL);
  await mintTo(conn, issuer, H081, strangerH, issuer, 1_000n * U, [], { commitment: 'confirmed' }, SPL);
  const scfg = async () => decodeSafetyConfig((await conn.getAccountInfo(safetyConfigPda(S, H081), 'confirmed'))!.data);
  const asAuth = (ix: TransactionInstruction) => send(conn, configAuthority, [ix]);

  const sd = await send(conn, stakerKp, [safetyDepositIx(S, stakerKp.publicKey, H081, stakerH, 1_000n * U, SPL)]);
  cuOf('safety_pool deposit (first, creates position)', sd.computeUnits);
  let pos = decodePosition((await conn.getAccountInfo(positionPda(S, H081, stakerKp.publicKey), 'confirmed'))!.data);
  record('safety deposit 1,000 H081: shares minted at the virtual-offset price', pos.shares === sharesFor(1_000n * U, 0n, 0n) && (await scfg()).assets === 1_000n * U);
  await sizeOf('safety_pool position', positionPda(S, H081, stakerKp.publicKey));
  await expectCode('safety deposit over the 100,000 H081 per-deposit cap is refused', send(conn, stakerKp, [safetyDepositIx(S, stakerKp.publicKey, H081, stakerH, H081_MAX_PER + 1n, SPL)]), SAFETY_ERROR.DepositCap);
  await expectCode('a stranger cannot change the safety caps', send(conn, stranger, [safetySetDepositCapsIx(S, stranger.publicKey, H081, 1n << 60n, 1n << 60n)]), SAFETY_ERROR.ConfigAuthority);
  await expectCode('a stranger cannot pause safety deposits', send(conn, stranger, [safetySetDepositsPausedIx(S, stranger.publicKey, H081, true)]), SAFETY_ERROR.ConfigAuthority);

  // top_up (platform fees) raises the share price without minting shares; never from a launch (creator-fee) wallet
  const tu = await send(conn, stranger, [safetyTopUpIx(S, stranger.publicKey, H081, strangerH, 100n * U, SPL)]);
  cuOf('safety_pool top_up', tu.computeUnits);
  let cfg = await scfg();
  record('top_up 100 H081: assets 1,100, no new shares', cfg.assets === 1_100n * U && cfg.totalShares === pos.shares);
  await expectCode('top_up above the pool assets is refused', send(conn, stranger, [safetyTopUpIx(S, stranger.publicKey, H081, strangerH, cfg.assets + 1n, SPL)]), SAFETY_ERROR.TopUpTooLarge);
  const launchH = await h081Ata(LAUNCH_WALLET);
  await mintTo(conn, issuer, H081, launchH, issuer, 10n * U, [], { commitment: 'confirmed' }, SPL);
  await expectCode('top_up from a launch (creator-fee) wallet account is refused', send(conn, stranger, [safetyTopUpIx(S, stranger.publicKey, H081, launchH, 1n * U, SPL)]), SAFETY_ERROR.LaunchWallet);

  // pause blocks deposits (and new covers), never unbonding or withdrawals
  const pz = await asAuth(safetySetDepositsPausedIx(S, configAuthority.publicKey, H081, true));
  cuOf('safety_pool set_deposits_paused', pz.computeUnits);
  await expectCode('safety deposit while paused is refused', send(conn, stakerKp, [safetyDepositIx(S, stakerKp.publicKey, H081, stakerH, 1n * U, SPL)]), SAFETY_ERROR.DepositsPaused);
  const ub = await send(conn, stakerKp, [requestUnbondIx(S, stakerKp.publicKey, H081, pos.shares / 10n)]);
  cuOf('safety_pool request_unbond', ub.computeUnits);
  record('request_unbond works while paused', decodePosition((await conn.getAccountInfo(positionPda(S, H081, stakerKp.publicKey), 'confirmed'))!.data).unbonding === pos.shares / 10n);
  await expectCode('withdraw before the 14-day cooldown is refused (Cooldown, not the pause)', send(conn, stakerKp, [safetyWithdrawIx(S, stakerKp.publicKey, H081, stakerH, SPL)]), SAFETY_ERROR.Cooldown);
  // matured M2 pool (fixture): paused, the cooldown is over -> withdraw works
  const matM2 = await createAssociatedTokenAccountIdempotent(conn, issuer, m2, maturedStaker.publicKey, { commitment: 'confirmed' }, SPL);
  await asAuth(safetySetDepositsPausedIx(S, configAuthority.publicKey, m2, true));
  const m2cfg = decodeSafetyConfig((await conn.getAccountInfo(safetyConfigPda(S, m2), 'confirmed'))!.data);
  const want = redeemable(M2_SHARES, m2cfg.assets, m2cfg.totalShares);
  const sw = await send(conn, maturedStaker, [safetyWithdrawIx(S, maturedStaker.publicKey, m2, matM2, SPL)]);
  cuOf('safety_pool withdraw', sw.computeUnits);
  record('[fixture pool, cooldown over] withdraw works while deposits are paused', (await bal(matM2)) === want && want > 0n, `received ${want} of ${M2_ASSETS} assets`);
  await asAuth(safetySetDepositsPausedIx(S, configAuthority.publicKey, H081, false));
  await send(conn, stakerKp, [safetyDepositIx(S, stakerKp.publicKey, H081, stakerH, 10n * U, SPL)]);
  record('unpaused: safety deposits work again', (await scfg()).assets === 1_110n * U);

  // underwriting + a real cover on loan 3, released after the lender settles
  await expectCode('insure before underwriting is set is refused (nothing insurable)',
    send(conn, lenderKp, [insureIx(S, lenderKp.publicKey, H081, lenderH, ref3, 1n * U, 50n * U, configAuthority.publicKey, SPL, ID.loan)], { signers: [configAuthority] }), SAFETY_ERROR.NotInsurable);
  const uw = await asAuth(safetySetUnderwritingIx(S, configAuthority.publicKey, H081, { loanAsset: USDG, maxCover: 100n * U, maxExposure: 500n * U, minPremiumBps: 100 }));
  cuOf('safety_pool set_underwriting', uw.computeUnits);
  await expectCode('insure without the underwriter signature is refused', send(conn, lenderKp, [insureIx(S, lenderKp.publicKey, H081, lenderH, ref3, 1n * U, 50n * U, stranger.publicKey, SPL, ID.loan)], { signers: [stranger] }), SAFETY_ERROR.ConfigAuthority);
  await expectCode('insure of loan 1 (due in 1 day: slashable before stakers could leave) is refused', send(conn, lenderKp, [insureIx(S, lenderKp.publicKey, H081, lenderH, ref1, 1n * U, 50n * U, configAuthority.publicKey, SPL, ID.loan)], { signers: [configAuthority] }), SAFETY_ERROR.TooShort);
  const premium = minPremium(50n * U, 100);
  const ins = await send(conn, lenderKp, [insureIx(S, lenderKp.publicKey, H081, lenderH, ref3, premium, 50n * U, configAuthority.publicKey, SPL, ID.loan)], { signers: [configAuthority] });
  cuOf('safety_pool insure', ins.computeUnits);
  cfg = await scfg();
  record('loan 3 insured: cover 50, premium 0.5 H081 into the pool, exposure 50', cfg.exposure === 50n * U && cfg.assets === 1_110n * U + premium && decodeCover((await conn.getAccountInfo(coverPda(S, ref3), 'confirmed'))!.data).limit === 50n * U);
  await sizeOf('safety_pool cover', coverPda(S, ref3));
  const la3 = loanAccounts(ref3, USDG, T22, ID.loan, ID.pool);
  await expectCode('release_cover before loan 3 is settled or repaid is refused', send(conn, stranger, [releaseCoverIx(S, H081, ref3, la3)]), SAFETY_ERROR.NotReleasable);
  const st = await lender.settle(ref3);
  cuOf('stream_loan settle', st.computeUnits);
  const rc = await send(conn, stranger, [releaseCoverIx(S, H081, ref3, la3)]);
  cuOf('safety_pool release_cover', rc.computeUnits);
  record('lender settles loan 3; release_cover (anyone) frees the exposure', (await scfg()).exposure === 0n);

  // default path: slash the cover of loan 2 (real defaulted loan, fixture cover)
  const la2 = loanAccounts(ref2, USDG, T22, ID.loan, ID.pool);
  const vs = await viewShortfall(conn, stranger, S, ref2, la2);
  record('safety_pool sees loan 2 shortfall = principal (through stream_loan state)', vs === principal2, `shortfall ${vs}`);
  await expectCode('slash of the healthy loan 1 is refused (no cover)', send(conn, stranger, [slashIx(S, H081, ref1, loanAccounts(ref1, USDG, T22, ID.loan, ID.pool), lenderH, SPL)]), 3012);
  const lenderHBefore = await bal(lenderH), assetsBefore = (await scfg()).assets;
  const sl = await send(conn, stranger, [slashIx(S, H081, ref2, la2, lenderH, SPL)]);
  cuOf('safety_pool slash', sl.computeUnits);
  const pay = [principal2, assetsBefore, COVER_LIMIT].reduce((a, x) => (x < a ? x : a));
  record('slash pays the lender min(shortfall, assets, cover) in H081 and marks the cover paid',
    (await bal(lenderH)) === lenderHBefore + pay && (await scfg()).assets === assetsBefore - pay && decodeCover((await conn.getAccountInfo(cov2, 'confirmed'))!.data).paid, `paid ${pay}`);
  await expectCode('a second slash of the same cover is refused', send(conn, stranger, [slashIx(S, H081, ref2, la2, lenderH, SPL)]), SAFETY_ERROR.AlreadyPaid);

  // total cap: fill to exactly 1,000,000 H081 of assets, one base unit more is refused
  for (let a = (await scfg()).assets; a < H081_MAX_TOTAL; a = (await scfg()).assets) {
    const amt = H081_MAX_TOTAL - a < H081_MAX_PER ? H081_MAX_TOTAL - a : H081_MAX_PER;
    await send(conn, stakerKp, [safetyDepositIx(S, stakerKp.publicKey, H081, stakerH, amt, SPL)]);
  }
  record('safety pool filled to exactly the 1,000,000 H081 total cap', (await scfg()).assets === H081_MAX_TOTAL);
  await expectCode('safety deposit over the total cap is refused', send(conn, stakerKp, [safetyDepositIx(S, stakerKp.publicKey, H081, stakerH, 1n, SPL)]), SAFETY_ERROR.DepositCap);

  // ================================================================ capacity_stake (H081)
  const C = ID.capacity;
  const ccfg = async (m = H081) => decodeCapacityConfig((await conn.getAccountInfo(capacityConfigPda(C, m), 'confirmed'))!.data);
  const sk = await send(conn, stakerKp, [stakeIx(C, stakerKp.publicKey, H081, stakerH, 1_000n * U, SPL)]);
  cuOf('capacity_stake stake (first, creates stake account)', sk.computeUnits);
  await sizeOf('capacity_stake stake account', stakePda(C, H081, stakerKp.publicKey));
  const cap = await viewCapacity(conn, stakerKp, C, H081, stakerKp.publicKey);
  record('stake 1,000 H081: capacity 10 desks, shield cap 100,000 USDG / 30 days', cap.desks === 10n && cap.shieldCap === 100_000n * U && (await ccfg()).totalStaked === 1_000n * U);
  await expectCode('stake over the 100,000 H081 per-stake cap is refused', send(conn, stakerKp, [stakeIx(C, stakerKp.publicKey, H081, stakerH, H081_MAX_PER + 1n, SPL)]), CAPACITY_ERROR.StakeCap);
  await expectCode('a stranger cannot change the staking caps', send(conn, stranger, [setStakeCapsIx(C, stranger.publicKey, H081, 1n << 60n, 1n << 60n)]), CAPACITY_ERROR.ConfigAuthority);
  const sc = await asAuth(setStakeCapsIx(C, configAuthority.publicKey, H081, 1_005n * U, H081_MAX_PER));
  cuOf('capacity_stake set_stake_caps', sc.computeUnits);
  await expectCode('stake over a lowered total cap (1,005 H081) is refused', send(conn, stakerKp, [stakeIx(C, stakerKp.publicKey, H081, stakerH, 6n * U, SPL)]), CAPACITY_ERROR.StakeCap);
  await send(conn, stakerKp, [stakeIx(C, stakerKp.publicKey, H081, stakerH, 5n * U, SPL)]);
  record('stake up to exactly the total cap works', (await ccfg()).totalStaked === 1_005n * U);
  await asAuth(setStakeCapsIx(C, configAuthority.publicKey, H081, H081_MAX_TOTAL, H081_MAX_PER));
  const sp = await asAuth(setStakingPausedIx(C, configAuthority.publicKey, H081, true));
  cuOf('capacity_stake set_staking_paused', sp.computeUnits);
  await expectCode('stake while paused is refused', send(conn, stakerKp, [stakeIx(C, stakerKp.publicKey, H081, stakerH, 1n * U, SPL)]), CAPACITY_ERROR.StakingPaused);
  const ru = await send(conn, stakerKp, [requestUnstakeIx(C, stakerKp.publicKey, H081, 100n * U)]);
  cuOf('capacity_stake request_unstake', ru.computeUnits);
  record('request_unstake works while paused', decodeStake((await conn.getAccountInfo(stakePda(C, H081, stakerKp.publicKey), 'confirmed'))!.data).pending === 100n * U);
  await expectCode('unstake before the 30-day cooldown is refused (Cooldown, not the pause)', send(conn, stakerKp, [unstakeIx(C, stakerKp.publicKey, H081, stakerH, SPL)]), CAPACITY_ERROR.Cooldown);
  // matured M2 config (fixture): paused, cooldown over -> unstake works
  await asAuth(setStakingPausedIx(C, configAuthority.publicKey, m2, true));
  const m2Before = await bal(matM2);
  const us = await send(conn, maturedStaker, [unstakeIx(C, maturedStaker.publicKey, m2, matM2, SPL)]);
  cuOf('capacity_stake unstake', us.computeUnits);
  record('[fixture config, cooldown over] unstake works while staking is paused', (await bal(matM2)) === m2Before + M2_STAKE && (await ccfg(m2)).totalPending === 0n);
  await asAuth(setStakingPausedIx(C, configAuthority.publicKey, H081, false));
  await send(conn, stakerKp, [stakeIx(C, stakerKp.publicKey, H081, stakerH, 1n * U, SPL)]);
  record('unpaused: staking works again', (await ccfg()).totalStaked === 906n * U);

  // ================================================================ bank still fine; compute-unit margins
  const wd = await owner.withdraw(USDG, 10n * U, ownerKp.publicKey);
  cuOf('stipend_pool transact_withdraw', wd.tx.computeUnits, OP_CU);
  record('bank withdraw still works after all phase-2 activity', wd.tx.computeUnits > 0);
  for (const [k, v] of Object.entries(cu)) {
    record(`compute units ${k} under its limit with >= 25% headroom`, v.units > 0 && v.units <= 0.75 * v.limit && v.units < TX_CU_MAX, `${v.units} of ${v.limit}`);
  }
}
