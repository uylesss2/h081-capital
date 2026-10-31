// Config-authority actions on the live stipend_pool (runbook "Emergency"). Deposits only: withdrawals and agent
// payments can never be paused or capped by this key.
//
//   npx tsx scripts/mainnet-admin.mts show
//   npx tsx scripts/mainnet-admin.mts pause    --i-understand-mainnet
//   npx tsx scripts/mainnet-admin.mts unpause  --i-understand-mainnet
//   npx tsx scripts/mainnet-admin.mts caps <maxTotal> <maxPerDeposit> --i-understand-mainnet   (USDG base units, 6 dec)
// Env: CONFIG_AUTHORITY_KEY (default solana/keys/mainnet/config_authority-keypair.json; needs ~0.00001 SOL per tx),
//      POOL_PROGRAM_ID (default E16DK...), RPC (default https://api.mainnet-beta.solana.com),
//      REHEARSE_LOCAL=1 + USDG_MINT for a local validator test (refused on a mainnet RPC).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { assetCapPda, configPda, decodeAssetCaps, decodeConfig, send, setAssetCapsIx, setDepositsPausedIx } from '../src/solana/index.js';
import { MAINNET_GENESIS } from '../src/solana/deploy-target.js';

const root = resolve(import.meta.dirname, '..');
const RPC = process.env.RPC ?? 'https://api.mainnet-beta.solana.com';
const LOCAL = process.env.REHEARSE_LOCAL === '1';
const POOL = new PublicKey(process.env.POOL_PROGRAM_ID ?? 'E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM');
const USDG = new PublicKey(LOCAL && process.env.USDG_MINT ? process.env.USDG_MINT : '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH');
const [cmd, a1, a2] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!['show', 'pause', 'unpause', 'caps'].includes(cmd ?? '')) {
  console.error('usage: npx tsx scripts/mainnet-admin.mts show | pause | unpause | caps <maxTotal> <maxPerDeposit>  [--i-understand-mainnet]');
  process.exit(2);
}
const conn = new Connection(RPC, 'confirmed');
const genesis = await conn.getGenesisHash();
if (genesis === MAINNET_GENESIS && LOCAL) throw new Error('REHEARSE_LOCAL=1 on a mainnet RPC: refused');
if (genesis !== MAINNET_GENESIS && !LOCAL) throw new Error(`RPC ${RPC} is not mainnet-beta; set REHEARSE_LOCAL=1 for a local test`);

const show = async () => {
  const c = decodeConfig((await conn.getAccountInfo(configPda(POOL), 'confirmed'))!.data);
  const capAcc = await conn.getAccountInfo(assetCapPda(POOL, USDG), 'confirmed');
  const caps = capAcc ? decodeAssetCaps(capAcc.data) : null;
  console.log(JSON.stringify({ program: POOL.toBase58(), authority: c.authority.toBase58(), depositsPaused: c.depositsPaused,
    defaultMaxTotal: c.defaultMaxTotal.toString(), defaultMaxPerDeposit: c.defaultMaxPerDeposit.toString(),
    usdg: caps ? { maxTotal: caps.maxTotal.toString(), maxPerDeposit: caps.maxPerDeposit.toString() } : 'no AssetCap' }, null, 2));
  return c;
};
const before = await show();
if (cmd === 'show') process.exit(0);
if (genesis === MAINNET_GENESIS && !process.argv.includes('--i-understand-mainnet')) throw new Error('mainnet: pass --i-understand-mainnet');

const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(resolve(root, process.env.CONFIG_AUTHORITY_KEY ?? 'solana/keys/mainnet/config_authority-keypair.json'), 'utf8'))));
if (!authority.publicKey.equals(before.authority)) throw new Error(`key ${authority.publicKey.toBase58()} is not config.authority ${before.authority.toBase58()}`);
const ix = cmd === 'caps'
  ? setAssetCapsIx(POOL, authority.publicKey, USDG, BigInt(a1 ?? NaN), BigInt(a2 ?? NaN))
  : setDepositsPausedIx(POOL, authority.publicKey, cmd === 'pause');
const tx = await send(conn, authority, [ix]);
console.log(`${cmd}: ${tx.signature}`);
await show();
process.exit(0);
