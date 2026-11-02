// Tiny real deposit + withdraw through the live stipend_pool (core-only mainnet release, runbook step 8).
// The signer's own USDG goes into the pool and comes straight back to the same wallet.
//
// The shielded account's secret is written to SMOKE_ACCOUNT BEFORE the deposit, so a crash between the deposit
// and the withdraw loses nothing: re-run the same command and it finds the note on chain and withdraws it.
//
//   SMOKE_KEY=solana/keys/mainnet/deployer-keypair.json npx tsx scripts/mainnet-smoke.mts --i-understand-mainnet
// Env:
//   SMOKE_KEY        Solana keypair that pays fees and holds the USDG (its Token-2022 ATA); default the deployer
//   SMOKE_AMOUNT     base units, default 1000000 (1 USDG); must be <= the per-deposit cap
//   SMOKE_ACCOUNT    default solana/keys/mainnet/smoke-account.json (gitignored; holds the shielded secret)
//   POOL_PROGRAM_ID  default E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM
//   RPC              default https://api.mainnet-beta.solana.com
//   REHEARSE_LOCAL=1 + USDG_MINT   local validator test only (refused when the RPC is mainnet)
// Output: signatures on stdout and in solana/target-so/mainnet-smoke.json (gitignored).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Account } from '../src/client.js';
import { initCrypto, randomKeys } from '../src/crypto.js';
import { SolanaPool, SolanaWallet, assetCapPda, configPda, decodeAssetCaps, decodeConfig, vaultPda } from '../src/solana/index.js';
import { MAINNET_GENESIS } from '../src/solana/deploy-target.js';

const root = resolve(import.meta.dirname, '..');
const RPC = process.env.RPC ?? 'https://api.mainnet-beta.solana.com';
const LOCAL = process.env.REHEARSE_LOCAL === '1';
const POOL = new PublicKey(process.env.POOL_PROGRAM_ID ?? 'E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM');
const USDG = new PublicKey(LOCAL && process.env.USDG_MINT ? process.env.USDG_MINT : '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH');
const AMOUNT = BigInt(process.env.SMOKE_AMOUNT ?? 1_000_000);
const KEY = resolve(root, process.env.SMOKE_KEY ?? 'solana/keys/mainnet/deployer-keypair.json');
const ACCOUNT_FILE = resolve(root, process.env.SMOKE_ACCOUNT ?? 'solana/keys/mainnet/smoke-account.json');

const conn = new Connection(RPC, 'confirmed');
const genesis = await conn.getGenesisHash();
if (genesis === MAINNET_GENESIS) {
  if (LOCAL) throw new Error('REHEARSE_LOCAL=1 on a mainnet RPC: refused');
  if (!process.argv.includes('--i-understand-mainnet')) throw new Error('mainnet: pass --i-understand-mainnet');
} else if (!LOCAL) throw new Error(`RPC ${RPC} is not mainnet-beta (genesis ${genesis}); set REHEARSE_LOCAL=1 for a local test`);

const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEY, 'utf8'))));
const ata = getAssociatedTokenAddressSync(USDG, signer.publicKey, false, TOKEN_2022_PROGRAM_ID);
const usdgOf = async () => (await getAccount(conn, ata, 'confirmed', TOKEN_2022_PROGRAM_ID).catch(() => null))?.amount ?? 0n;
const vault = vaultPda(POOL, USDG);
const vaultBal = async () => (await getAccount(conn, vault, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount;

await initCrypto();
// the shielded account: reuse the saved one (resume), else create one and save it before anything is sent
let resumed = false;
let sk: bigint;
if (existsSync(ACCOUNT_FILE)) { sk = BigInt(JSON.parse(readFileSync(ACCOUNT_FILE, 'utf8')).sk); resumed = true; }
else {
  sk = randomKeys().sk;
  mkdirSync(dirname(ACCOUNT_FILE), { recursive: true });
  writeFileSync(ACCOUNT_FILE, JSON.stringify({ note: 'stipend smoke-test shielded account secret; delete after a successful run', program: POOL.toBase58(), sk: sk.toString() }) + '\n', { mode: 0o600 });
}
const wallet = new SolanaWallet(new Account(sk), new SolanaPool(conn, POOL), signer);
const record: Record<string, unknown> = { ran: new Date().toISOString(), rpc: RPC, program: POOL.toBase58(), mint: USDG.toBase58(), signer: signer.publicKey.toBase58(), amount: AMOUNT.toString(), resumed };

await wallet.sync();
let shielded = wallet.balance(USDG);
console.log(`signer ${signer.publicKey.toBase58()}: USDG ${await usdgOf()}, shielded ${shielded}${resumed ? ' (resumed account)' : ''}; vault ${await vaultBal()}`);

if (shielded === 0n) {
  const cfg = decodeConfig((await conn.getAccountInfo(configPda(POOL), 'confirmed'))!.data);
  const caps = decodeAssetCaps((await conn.getAccountInfo(assetCapPda(POOL, USDG), 'confirmed'))!.data);
  if (cfg.depositsPaused) throw new Error('deposits are paused');
  if (AMOUNT > caps.maxPerDeposit) throw new Error(`SMOKE_AMOUNT ${AMOUNT} is above the per-deposit cap ${caps.maxPerDeposit}`);
  if ((await usdgOf()) < AMOUNT) throw new Error(`the signer's USDG account ${ata.toBase58()} holds less than ${AMOUNT}`);
  const before = await vaultBal();
  const dep = await wallet.deposit(USDG, AMOUNT);
  record.deposit = { signature: dep.tx.signature, computeUnits: dep.tx.computeUnits };
  console.log(`deposit ${AMOUNT}: ${dep.tx.signature} (${dep.tx.computeUnits} CU)`);
  shielded = wallet.balance(USDG);
  if (shielded !== AMOUNT || (await vaultBal()) !== before + AMOUNT) throw new Error(`after deposit: shielded ${shielded}, vault ${await vaultBal()} (was ${before})`);
}
const usdgBefore = await usdgOf();
const wd = await wallet.withdraw(USDG, shielded, signer.publicKey);
record.withdraw = { signature: wd.tx.signature, computeUnits: wd.tx.computeUnits, amount: shielded.toString() };
console.log(`withdraw ${shielded}: ${wd.tx.signature} (${wd.tx.computeUnits} CU)`);
const usdgAfter = await usdgOf();
const ok = wallet.balance(USDG) === 0n && usdgAfter === usdgBefore + shielded;
record.ok = ok;
console.log(`${ok ? 'SMOKE OK' : 'SMOKE FAILED'}: shielded ${wallet.balance(USDG)}, signer USDG ${usdgBefore} -> ${usdgAfter}, vault ${await vaultBal()}`);
const out = join(root, 'solana', 'target-so');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, LOCAL ? 'mainnet-smoke-local.json' : 'mainnet-smoke.json'), JSON.stringify(record, null, 2) + '\n');
if (ok) console.log(`the shielded account is empty; ${ACCOUNT_FILE} can be deleted`);
process.exit(ok ? 0 : 1);
