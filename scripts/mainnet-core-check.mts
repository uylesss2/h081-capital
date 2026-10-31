// Read-only checks for the core-only mainnet release (stipend_pool only). Never signs or sends anything: it
// reads the genesis hash, rent, balances and accounts, and loads keypair files only to derive their PUBLIC keys
// (secret keys are never printed).
//
//   npx tsx scripts/mainnet-core-check.mts preflight   before funding / deploy (exit 1 if a check fails)
//   npx tsx scripts/mainnet-core-check.mts usdg        the USDG mint gate, run again right before create_vault
//   npx tsx scripts/mainnet-core-check.mts verify      after mainnet-init: program, config, caps, vault on chain
//
// Env (defaults are the core-only release values):
//   RPC            https://api.mainnet-beta.solana.com (must serve mainnet-beta's genesis)
//   KEYS_DIR       solana/keys/mainnet (deployer-, config_authority-, stipend_pool-keypair.json)
//   POOL_SO        ../h081-deploy-staging/so-mainnet/stipend_pool.so
//   POOL_SO_SHA256 4e1fbbc3...2c1a51 (the mainnet build of 540faa7)
//   CU_PRICE       100000 (micro-lamports per CU, deploy-cluster.mjs's mainnet price); CAP_SOL 3.6
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import {
  ExtensionType, TOKEN_2022_PROGRAM_ID, getAccount, getAccountLen, getAccountTypeOfMintType,getExtensionTypes, getMint, getTransferFeeConfig, getTransferHook,
  getPermanentDelegate, getMintCloseAuthority,
} from '@solana/spl-token';
import { POOL_SIZE, assetCapPda, configPda, decodeAssetCaps, decodeConfig, poolPda, vaultPda } from '../src/solana/index.js';
import { MAINNET_GENESIS } from '../src/solana/deploy-target.js';
import { executableHash, fetchDeployedProgram } from '../src/solana/verify.js';

const root = resolve(import.meta.dirname, '..');
const mode = process.argv[2];
if (!['preflight', 'usdg', 'verify'].includes(mode ?? '')) {
  console.error('usage: npx tsx scripts/mainnet-core-check.mts <preflight|usdg|verify>');
  process.exit(2);
}
const RPC = process.env.RPC ?? 'https://api.mainnet-beta.solana.com';
const KEYS_DIR = resolve(root, process.env.KEYS_DIR ?? 'solana/keys/mainnet');
const SO_PATH = resolve(root, process.env.POOL_SO ?? '../h081-deploy-staging/so-mainnet/stipend_pool.so');
const SO_SHA256 = process.env.POOL_SO_SHA256 ?? '4e1fbbc3d1c7d094824ce323f34bbc671f68334b15a2467da4533e11052c1a51';
const CU_PRICE = BigInt(process.env.CU_PRICE ?? 100_000);
const CAP_SOL = Number(process.env.CAP_SOL ?? 3.6);

// Expected public keys of the core-only release (HANDOFF.md, "Done").
const EXPECT = {
  deployer: '5WCpirBe1wHUk6PL2nU97pj87PtyaqH9S6UJUbd5z2W1',
  config_authority: '4eySgHKMNGMpWtbtpfxfSyJZK8LGYxEZLzJwHXCsoPX2',
  stipend_pool: 'E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM',
};
const FEE_WALLET = new PublicKey('2wjxKzH7fVGpjcA9KpjDBDHjSAhz7u8ZgMLnVPVGSkDP');
const USDG = new PublicKey('2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH');
const LOCALNET_POOL = 'AzES8Vd7NmoxdSrEBbwDNAwn2pyoAz5m5w7bmVas5Si3';
const CAP_TOTAL = 10_000_000_000n; // 10,000 USDG
const CAP_PER_DEPOSIT = 1_000_000_000n; // 1,000 USDG
const PROGRAM_ID = new PublicKey(EXPECT.stipend_pool);

let failed = 0;
const check = (ok: boolean, what: string, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
};
const sol = (l: number | bigint) => (Number(l) / LAMPORTS_PER_SOL).toFixed(4);
const pubOf = (file: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, 'utf8')))).publicKey.toBase58();

const conn = new Connection(RPC, 'confirmed');
const genesis = await conn.getGenesisHash();
check(genesis === MAINNET_GENESIS, 'RPC serves mainnet-beta', `${RPC}, genesis ${genesis}`);
if (genesis !== MAINNET_GENESIS) process.exit(1);

async function usdgGate(): Promise<number> {
  const info = await conn.getAccountInfo(USDG, 'confirmed');
  check(!!info && info.owner.equals(TOKEN_2022_PROGRAM_ID), 'USDG mint exists and is Token-2022', USDG.toBase58());
  if (!info) return 0;
  const mint = await getMint(conn, USDG, 'confirmed', TOKEN_2022_PROGRAM_ID);
  const types = getExtensionTypes(mint.tlvData);
  const names = types.map((t) => ExtensionType[t] ?? `type ${t}`);
  console.log(`      USDG extensions: ${names.join(', ')}`);
  check(mint.decimals === 6, 'USDG has 6 decimals', String(mint.decimals));
  // Blocking: any of these would let the issuer stop the pool's vault for everyone, or change transfer semantics.
  check(!types.includes(ExtensionType.PausableConfig), 'no Pausable extension');
  check(!types.includes(ExtensionType.DefaultAccountState), 'no DefaultAccountState extension (new vault not frozen by default)');
  const hook = getTransferHook(mint);
  check(!hook || hook.programId.equals(PublicKey.default), 'transfer hook has no program set', hook ? hook.programId.toBase58() : 'no TransferHook extension');
  const fee = getTransferFeeConfig(mint);
  const bps = fee ? Math.max(fee.olderTransferFee.transferFeeBasisPoints, fee.newerTransferFee.transferFeeBasisPoints) : 0;
  check(bps === 0, 'transfer fee is 0 bps (older and newer)', fee ? `older ${fee.olderTransferFee.transferFeeBasisPoints}, newer ${fee.newerTransferFee.transferFeeBasisPoints} from epoch ${fee.newerTransferFee.epoch}` : 'no TransferFeeConfig');
  // Disclosed, not blocking (RiskNotice): who holds the issuer powers.
  console.log(`      issuer powers (disclosed in RiskNotice): freeze ${mint.freezeAuthority?.toBase58() ?? 'none'}, mint ${mint.mintAuthority?.toBase58() ?? 'none'}, ` +
    `permanent delegate ${getPermanentDelegate(mint)?.delegate.toBase58() ?? 'none'}, close ${getMintCloseAuthority(mint)?.closeAuthority.toBase58() ?? 'none'}`);
  // Vault size: Token-2022's required account extensions for this mint. spl-token 0.4.13 does not know mint
  // extension 16 (ConfidentialTransferFeeConfig), which needs no account extension at init; any other unknown
  // type must be reviewed before create_vault.
  const unknown = types.filter((t) => ExtensionType[t] === undefined && (t as number) !== 16);
  check(unknown.length === 0, 'no unreviewed mint extension types', unknown.length ? unknown.join(', ') : 'only 16 (ConfidentialTransferFeeConfig) is unnamed');
  // Only these mint extensions force an account extension at InitializeAccount (Token-2022
  // get_required_init_account_extensions); ConfidentialTransferMint's account part is opt-in (ConfigureAccount).
  const REQUIRED = [ExtensionType.TransferFeeConfig, ExtensionType.NonTransferable, ExtensionType.TransferHook, ExtensionType.PausableConfig];
  const accountTypes = types.filter((t) => REQUIRED.includes(t)).map(getAccountTypeOfMintType);
  return getAccountLen(accountTypes);
}

if (mode === 'usdg') {
  await usdgGate();
} else if (mode === 'preflight') {
  // .so: the reviewed mainnet build, carrying the mainnet id and not the localnet one
  check(existsSync(SO_PATH), '.so present', SO_PATH);
  const so = readFileSync(SO_PATH);
  const sha = createHash('sha256').update(so).digest('hex');
  check(sha === SO_SHA256, '.so sha256 matches the mainnet build', `${so.length} bytes, ${sha}`);
  check(so.includes(PROGRAM_ID.toBuffer()) && !so.includes(new PublicKey(LOCALNET_POOL).toBuffer()), '.so carries the mainnet program id, not the localnet one');
  // keys: present, and the public keys are the expected ones
  for (const [name, want] of Object.entries(EXPECT)) {
    const f = join(KEYS_DIR, `${name}-keypair.json`);
    const got = existsSync(f) ? pubOf(f) : 'missing';
    check(got === want, `${name} keypair present`, `${got}${got === want ? '' : `, want ${want}`}`);
  }
  // chain state: program id not used yet (a re-run after the deploy reports what is there)
  const prog = await conn.getAccountInfo(PROGRAM_ID, 'confirmed');
  console.log(`      program ${PROGRAM_ID.toBase58()}: ${prog ? `EXISTS (executable ${prog.executable}) — deploy step will skip, go to init` : 'not on chain yet'}`);
  const pool = await conn.getAccountInfo(poolPda(PROGRAM_ID), 'confirmed');
  check(!pool || !!prog, 'no pool account without a program', pool ? 'pool exists' : 'none');
  const depBal = await conn.getBalance(new PublicKey(EXPECT.deployer), 'confirmed');
  const feeBal = await conn.getBalance(FEE_WALLET, 'confirmed');
  console.log(`      deployer ${EXPECT.deployer} balance ${sol(depBal)} SOL; fee wallet ${FEE_WALLET.toBase58()} balance ${sol(feeBal)} SOL`);
  const vaultLen = await usdgGate();

  // Funding figure. Deploy with --max-len = .so size (deploy-cluster.mjs --maxlen-factor 1).
  const rent = (n: number) => conn.getMinimumBalanceForRentExemption(n);
  const programData = await rent(so.length + 45), programAcct = await rent(36), buffer = await rent(so.length + 37);
  const writes = Math.ceil(so.length / 1000) + 21; // ~1,000-byte write txs + setup/final txs (step 2: 351 writes, 372 budgeted)
  const feePerTx = 5_000n + (CU_PRICE * 200_000n) / 1_000_000n; // worst case: priority fee on a 200k-CU default limit
  const deployFees = BigInt(writes) * feePerTx;
  const peak = BigInt(programData + programAcct + buffer) + deployFees;
  const retry = deployFees; // one failed upload attempt loses its fees (the buffer is closed and refunded)
  const init = BigInt((await rent(POOL_SIZE)) + (await rent(58)) + (await rent(57)) + (await rent(vaultLen)));
  const fund = ((peak + retry + 999_999n) / 1_000_000n) * 1_000_000n; // rounded up to 0.001 SOL
  console.log('      rent: programdata %s, program %s, buffer %s (refunded), pool+config+cap+vault(%d B) %s', sol(programData), sol(programAcct), sol(buffer), vaultLen, sol(init));
  console.log(`      deploy fees worst case ${sol(deployFees)} (${writes} tx x ${feePerTx} lamports); peak ${sol(peak)}; +1 retry ${sol(peak + retry)}`);
  console.log(`      after deploy (buffer refunded): ${sol(fund - BigInt(programData + programAcct) - deployFees)} SOL left for init ${sol(init)} + smoke test`);
  check(Number(fund) / LAMPORTS_PER_SOL <= CAP_SOL, `FUND EXACTLY ${(Number(fund) / LAMPORTS_PER_SOL).toFixed(3)} SOL to the deployer (cap ${CAP_SOL})`, `need ${sol(fund - BigInt(depBal) > 0n ? fund - BigInt(depBal) : 0n)} more than its balance`);
} else {
  // verify: after deploy + mainnet-init
  const so = readFileSync(SO_PATH);
  const d = await fetchDeployedProgram(conn, PROGRAM_ID).catch((e: Error) => {
    check(false, 'program deployed', e.message);
    process.exit(1);
  });
  check(d.loader === 'upgradeable', 'program deployed with the upgradeable loader', d.loader);
  check(d.upgradeAuthority?.toBase58() === EXPECT.deployer, 'upgrade authority is the deployer', d.upgradeAuthority?.toBase58() ?? 'none (final)');
  check(d.executableHash === executableHash(so), 'deployed executable equals the .so', d.executableHash);
  const poolAcc = await conn.getAccountInfo(poolPda(PROGRAM_ID), 'confirmed');
  check(poolAcc?.data.length === POOL_SIZE && poolAcc.owner.equals(PROGRAM_ID), 'pool account complete', `${poolAcc?.data.length ?? 0} of ${POOL_SIZE} bytes`);
  const cfgAcc = await conn.getAccountInfo(configPda(PROGRAM_ID), 'confirmed');
  if (!cfgAcc) check(false, 'config account exists');
  else {
    const c = decodeConfig(cfgAcc.data);
    check(c.authority.toBase58() === EXPECT.config_authority, 'config.authority', c.authority.toBase58());
    check(c.defaultMaxTotal === CAP_TOTAL && c.defaultMaxPerDeposit === CAP_PER_DEPOSIT, 'default caps 10,000 / 1,000 USDG', `${c.defaultMaxTotal} / ${c.defaultMaxPerDeposit}`);
    console.log(`      deposits paused: ${c.depositsPaused}`);
  }
  const capAcc = await conn.getAccountInfo(assetCapPda(PROGRAM_ID, USDG), 'confirmed');
  if (!capAcc) check(false, 'USDG AssetCap exists');
  else {
    const caps = decodeAssetCaps(capAcc.data);
    check(caps.mint.equals(USDG) && caps.maxTotal === CAP_TOTAL && caps.maxPerDeposit === CAP_PER_DEPOSIT, 'USDG caps 10,000 total / 1,000 per deposit', `${caps.maxTotal} / ${caps.maxPerDeposit}`);
  }
  const vault = vaultPda(PROGRAM_ID, USDG);
  try {
    const v = await getAccount(conn, vault, 'confirmed', TOKEN_2022_PROGRAM_ID);
    check(v.mint.equals(USDG) && !v.isFrozen, 'USDG vault exists, not frozen', `${vault.toBase58()}, balance ${v.amount}`);
  } catch (e) { check(false, 'USDG vault exists', (e as Error).message); }
  const depBal = await conn.getBalance(new PublicKey(EXPECT.deployer), 'confirmed');
  console.log(`      deployer balance ${sol(depBal)} SOL`);
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
