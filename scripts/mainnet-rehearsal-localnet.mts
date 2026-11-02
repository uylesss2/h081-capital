// Mainnet rehearsal on a PRIVATE local validator: the exact mainnet-profile stipend_pool.so (built by
// h081-deploy-staging/build-mainnet.sh at the mainnet program id) loaded as an UPGRADEABLE program with a fresh
// local upgrade authority, plus a local copy of the USDG mint (same address, same Token-2022 extensions) whose
// authorities are swapped for a local "issuer" key. Runs the mainnet-init sequence and the whole user flow
// through the SDK, records compute units, and stops the validator.
//
// Mainnet is only READ (getGenesisHash, getAccountInfo of the USDG mint and, with --clone-feature-set, the feature
// accounts). Nothing is signed for any public cluster; every transaction goes to 127.0.0.1:<RPC_PORT>.
//
// Validator: own ports and ledger, never 8899/8900 (another project) nor the test suites' 8999/9099/9199 or the
// staging 9299: rpc 9499 (+ws 9500), faucet 9944, gossip 8295, dynamic 9600-9700, ledger ~/h081-rehearsal-ledger.
//
// Usage (Windows, from the repo root; WSL Ubuntu has the Solana toolchain):
//   npx tsx scripts/mainnet-rehearsal-localnet.mts
// Env:
//   POOL_SO          default ../h081-deploy-staging/so-mainnet/stipend_pool.so
//   POOL_SO_SHA256   optional: refuse to run unless the .so has this sha256
//   POOL_PROGRAM_ID  default E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM (the mainnet id the .so was patched with)
//   MAINNET_READ_RPC default https://api.mainnet-beta.solana.com (read-only)
//   CLONE_FEATURES   1 (default): the local validator copies mainnet's feature set; 0: all features on
//   KEEP_VALIDATOR   1: leave the validator running at the end
// Output: solana/target-so/mainnet-rehearsal.json (gitignored).
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import {
  ExtensionType, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotent, freezeAccount, getExtensionTypes, getMint, getTransferFeeConfig,
  mintTo, thawAccount, transferChecked,
} from '@solana/spl-token';
import { Account } from '../src/client.js';
import { initCrypto, randomField } from '../src/crypto.js';
import {
  OP_CU_LIMIT, POOL_ERROR, POOL_SIZE, SolanaPool, SolanaWallet, U64_MAX, assetCapPda, closeBuffer, concatBytes, configPda, createVaultIx, customErrorCode,
  decodeAssetCaps, decodeConfig, decodePool, encodeDiscloseArgs, encodeProof, initializeIx, initializePoolIxs, poolPda, programDataAddress, send,
  setAssetCapsIx, setDepositsPausedIx, spendIx, uploadBuffer, vaultPda, verifyDisclosureIx,
} from '../src/solana/index.js';
import { MAINNET_GENESIS, resolvePoolTarget } from '../src/solana/deploy-target.js';
import { executableHash } from '../src/solana/verify.js';

const root = resolve(import.meta.dirname, '..');
const SO_PATH = resolve(root, process.env.POOL_SO ?? '../h081-deploy-staging/so-mainnet/stipend_pool.so');
const PROGRAM_ID = new PublicKey(process.env.POOL_PROGRAM_ID ?? 'E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM');
const MAINNET_READ_RPC = process.env.MAINNET_READ_RPC ?? 'https://api.mainnet-beta.solana.com';
const CLONE_FEATURES = process.env.CLONE_FEATURES !== '0';
const USDG = new PublicKey('2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH');
const T22 = TOKEN_2022_PROGRAM_ID;
const PORTS = { rpc: 9499, faucet: 9944, gossip: 8295, dynamic: '9600-9700' };
const LEDGER = '$HOME/h081-rehearsal-ledger';
const RPC = `http://127.0.0.1:${PORTS.rpc}`;
const USD = 1_000_000n; // 1 USDG in base units (6 decimals, checked against mainnet below)
const CAP_PER_DEPOSIT = 1_000n * USD;
const CAP_TOTAL = 10_000n * USD;
const TX_CU_MAX = 1_400_000;
const DEFAULT_IX_CU = 200_000; // per-instruction default when a transaction sets no compute-unit limit

// ------------------------------------------------------------------ helpers

const results: { step: string; ok: boolean; detail?: string }[] = [];
const cu: Record<string, { units: number; limit: number }> = {};
function record(step: string, ok: boolean, detail?: string) {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? `  (${detail})` : ''}`);
  if (!ok) process.exitCode = 1;
}
const cuOf = (name: string, units: number, limit: number) => {
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

// ------------------------------------------------------------------ 1. the .so

const so = readFileSync(SO_PATH);
const soSha = createHash('sha256').update(so).digest('hex');
console.log(`stipend_pool.so ${SO_PATH}: ${so.length} bytes, sha256 ${soSha}`);
if (process.env.POOL_SO_SHA256 && process.env.POOL_SO_SHA256 !== soSha) throw new Error(`.so sha256 ${soSha} != POOL_SO_SHA256`);
const idInSo = so.includes(PROGRAM_ID.toBuffer());
const localIdInSo = so.includes(new PublicKey('AzES8Vd7NmoxdSrEBbwDNAwn2pyoAz5m5w7bmVas5Si3').toBuffer());
record('.so carries the mainnet program id and not the localnet one', idInSo && !localIdInSo, `${PROGRAM_ID.toBase58()} present=${idInSo}, AzES8 present=${localIdInSo}`);

// ------------------------------------------------------------------ 2. USDG on mainnet (read-only)

const mainnet = new Connection(MAINNET_READ_RPC, 'confirmed');
const genesis = await mainnet.getGenesisHash();
if (genesis !== MAINNET_GENESIS) throw new Error(`MAINNET_READ_RPC serves genesis ${genesis}, not mainnet-beta`);
const usdgInfo = await mainnet.getAccountInfo(USDG, 'confirmed');
if (!usdgInfo || !usdgInfo.owner.equals(T22)) throw new Error('USDG mint not found on mainnet or not Token-2022');
const usdgMain = await getMint(mainnet, USDG, 'confirmed', T22);
const mainExt = getExtensionTypes(usdgMain.tlvData).map((t) => ExtensionType[t] ?? `type ${t}`);
const fee = getTransferFeeConfig(usdgMain);
console.log(`USDG mainnet: decimals ${usdgMain.decimals}, ${usdgInfo.data.length} bytes, extensions ${mainExt.join(', ')}; transfer fee ${fee?.newerTransferFee.transferFeeBasisPoints} bps`);
record('USDG has 6 decimals on mainnet', usdgMain.decimals === 6);

// Local copy: same bytes, every issuer authority (mint, freeze, permanent delegate, fee, close, metadata, ...) swapped
// for a local issuer key, supply 0. The extension layout is untouched.
const issuer = Keypair.generate();
const data = Buffer.from(usdgInfo.data);
const authorities = new Set<string>();
for (const k of [usdgMain.mintAuthority, usdgMain.freezeAuthority]) if (k) authorities.add(k.toBase58());
// every 32-byte value in the TLV area that is an authority-shaped field: collect from the parsed extensions we know,
// and swap them wherever they appear in the account
const tf = getTransferFeeConfig(usdgMain);
if (tf) { authorities.add(tf.transferFeeConfigAuthority.toBase58()); authorities.add(tf.withdrawWithheldAuthority.toBase58()); }
const { getPermanentDelegate, getMintCloseAuthority, getMetadataPointerState, getExtensionData } = await import('@solana/spl-token');
const pd = getPermanentDelegate(usdgMain); if (pd) authorities.add(pd.delegate.toBase58());
const mc = getMintCloseAuthority(usdgMain); if (mc) authorities.add(mc.closeAuthority.toBase58());
const mp = getMetadataPointerState(usdgMain); if (mp?.authority) authorities.add(mp.authority.toBase58());
// ConfidentialTransferMint / ConfidentialTransferFeeConfig / TransferHook start with their authority
for (const t of getExtensionTypes(usdgMain.tlvData)) {
  if (['ConfidentialTransferMint', 'TransferHook'].includes(ExtensionType[t]) || ExtensionType[t] === undefined) {
    const d = getExtensionData(t, usdgMain.tlvData);
    if (d && d.length >= 32 && d.subarray(0, 32).some((b) => b !== 0)) authorities.add(new PublicKey(d.subarray(0, 32)).toBase58());
  }
}
authorities.delete(PublicKey.default.toBase58());
let swaps = 0;
for (const a of authorities) {
  const from = new PublicKey(a).toBuffer();
  for (let i = data.indexOf(from); i !== -1; i = data.indexOf(from, i + 32)) { issuer.publicKey.toBuffer().copy(data, i); swaps++; }
}
data.writeBigUInt64LE(0n, 36); // supply
const hookData = getExtensionTypes(usdgMain.tlvData).find((t) => ExtensionType[t] === 'TransferHook');
const hookProgram = hookData !== undefined ? new PublicKey(getExtensionData(hookData, usdgMain.tlvData)!.subarray(32, 64)) : undefined;
console.log(`local USDG copy: ${authorities.size} issuer authorities, ${swaps} fields swapped to the local issuer ${issuer.publicKey.toBase58()}; transfer hook program ${hookProgram?.toBase58() ?? 'n/a'}`);

// ------------------------------------------------------------------ 3. private validator

const upgradeAuthority = Keypair.generate(); // local test upgrade authority, this run only
const work = mkdtempSync(join(tmpdir(), 'h081-rehearsal-'));
writeFileSync(join(work, 'usdg.json'), JSON.stringify({
  pubkey: USDG.toBase58(),
  account: { lamports: usdgInfo.lamports, data: [data.toString('base64'), 'base64'], owner: T22.toBase58(), executable: false, rentEpoch: 0, space: data.length },
}));
console.log(stopValidator());
const featureArgs = CLONE_FEATURES ? `--url ${MAINNET_READ_RPC} --clone-feature-set` : '';

const connection = new Connection(RPC, 'confirmed');
let exitCode = 0;
try {
  console.log(wsl([
    SOLANA_PATH, 'set -e', 'D=$HOME/h081-rehearsal', 'mkdir -p "$D"',
    `cp "${toWsl(SO_PATH)}" "$D/stipend_pool.so"`, `cp "${toWsl(join(work, 'usdg.json'))}" "$D/usdg.json"`,
    `setsid nohup solana-test-validator --ledger ${LEDGER} --reset --quiet --rpc-port ${PORTS.rpc} --faucet-port ${PORTS.faucet} ` +
    `--gossip-port ${PORTS.gossip} --dynamic-port-range ${PORTS.dynamic} ${featureArgs} ` +
    `--upgradeable-program ${PROGRAM_ID.toBase58()} "$D/stipend_pool.so" ${upgradeAuthority.publicKey.toBase58()} ` +
    `--account ${USDG.toBase58()} "$D/usdg.json" > "$D/validator.log" 2>&1 < /dev/null & true`,
    // wait here: WSL ends the processes of a finished --exec call, so the validator must be up (and setsid'd) first
    `for i in $(seq 1 180); do curl -s -m 2 -X POST -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' http://127.0.0.1:${PORTS.rpc} | grep -q '"ok"' && { echo "validator healthy on ${PORTS.rpc}"; exit 0; }; sleep 1; done; tail -30 "$D/validator.log"; exit 1`,
  ].join(' ; ')));
  for (let i = 0; ; i++) {
    try { await connection.getVersion(); await connection.getLatestBlockhash(); break; } catch { /* starting */ }
    if (i > 120) throw new Error(`validator did not start: ${wsl('tail -30 $HOME/h081-rehearsal/validator.log', false)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  // wait until the preloaded program is visible at 'finalized' (resolvePoolTarget reads finalized)
  for (let i = 0; !(await connection.getAccountInfo(PROGRAM_ID, 'finalized')); i++) {
    if (i > 120) throw new Error('program not visible at finalized');
    await new Promise((r) => setTimeout(r, 1000));
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
writeFileSync(join(out, 'mainnet-rehearsal.json'), JSON.stringify({
  ran: new Date().toISOString(), so: { path: SO_PATH, bytes: so.length, sha256: soSha, executableHash: executableHash(so) }, programId: PROGRAM_ID.toBase58(),
  rpc: RPC, featureSet: CLONE_FEATURES ? 'mainnet (cloned)' : 'all', usdgMainnet: { decimals: usdgMain.decimals, extensions: mainExt, hookProgram: hookProgram?.toBase58() },
  computeUnits: cu, results,
}, null, 2) + '\n');
console.log(`\n${results.length - failed.length}/${results.length} checks passed; results in solana/target-so/mainnet-rehearsal.json`);
console.table(Object.fromEntries(Object.entries(cu).map(([k, v]) => [k, { units: v.units, limit: v.limit, headroom: `${(100 - (100 * v.units) / v.limit).toFixed(1)}%` }])));
process.exit(exitCode || (failed.length ? 1 : 0));

// ------------------------------------------------------------------ 4. the flow

async function run(conn: Connection, localGenesis: string) {
  await initCrypto();
  const airdrop = async (k: PublicKey, sol: number) => {
    const sig = await conn.requestAirdrop(k, sol * LAMPORTS_PER_SOL);
    await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash('confirmed')) }, 'confirmed');
  };
  const stranger = Keypair.generate();
  const configAuthority = Keypair.generate();
  const pool = new SolanaPool(conn, PROGRAM_ID);
  for (const k of [upgradeAuthority, stranger, configAuthority, issuer]) await airdrop(k.publicKey, 5);

  // the chain's program = this .so, upgradeable, upgrade authority = the local test key (the checks mainnet-init runs)
  const target = await resolvePoolTarget(conn, { programId: PROGRAM_ID.toBase58(), genesis: localGenesis, payer: upgradeAuthority.publicKey, expectSo: so });
  record('program on chain: upgradeable, upgrade authority = local key, executable = the .so', target.loader === 'upgradeable' && !!target.upgradeAuthority?.equals(upgradeAuthority.publicKey),
    `executable ${target.executableHash}, ProgramData ${programDataAddress(PROGRAM_ID).toBase58()}`);
  const localMint = await getMint(conn, USDG, 'confirmed', T22);
  const localExt = getExtensionTypes(localMint.tlvData).map((t) => ExtensionType[t] ?? `type ${t}`);
  record('local USDG copy has the mainnet extensions and decimals', localMint.decimals === usdgMain.decimals && localExt.join() === mainExt.join(), localExt.join(', '));

  // --- initialize: a stranger is refused, the upgrade authority succeeds (initialize + grow_pool, one tx)
  const guard = { authority: configAuthority.publicKey, maxTotal: CAP_TOTAL, maxPerDeposit: CAP_PER_DEPOSIT };
  await expectCode('initialize (+grow_pool) by a stranger is refused', send(conn, stranger, initializePoolIxs(PROGRAM_ID, stranger.publicKey, guard), { cuLimit: TX_CU_MAX }), POOL_ERROR.UpgradeAuthority);
  await expectCode('initialize alone by a stranger is refused', send(conn, stranger, [initializeIx(PROGRAM_ID, stranger.publicKey, guard)]), POOL_ERROR.UpgradeAuthority);
  record('no pool account after the refused attempts', !(await conn.getAccountInfo(poolPda(PROGRAM_ID))));
  // same call shape as SolanaPool.initialize (mainnet-init), sent directly to read its compute units
  const ixs = initializePoolIxs(PROGRAM_ID, upgradeAuthority.publicKey, guard);
  const init = await send(conn, upgradeAuthority, ixs, { cuLimit: 400_000 });
  cuOf('initialize_and_grow_tx', init.computeUnits, 400_000);
  await pool.initialize(upgradeAuthority, guard); // no-op on a complete pool
  const poolAcc = await conn.getAccountInfo(poolPda(PROGRAM_ID), 'confirmed');
  record('pool complete after one transaction', poolAcc?.data.length === POOL_SIZE && decodePool(poolAcc.data).nextIndex === 0, `${ixs.length} instructions, ${poolAcc?.data.length} bytes`);
  const config = decodeConfig((await conn.getAccountInfo(configPda(PROGRAM_ID), 'confirmed'))!.data);
  record('config.authority and default caps verified on chain', config.authority.equals(configAuthority.publicKey) && config.defaultMaxTotal === CAP_TOTAL && config.defaultMaxPerDeposit === CAP_PER_DEPOSIT && !config.depositsPaused);
  await expectReject('second initialize (by the upgrade authority) fails', send(conn, upgradeAuthority, ixs, { cuLimit: TX_CU_MAX }));

  // --- create_vault for USDG (as mainnet-init does; permissionless)
  const cv = await send(conn, upgradeAuthority, [createVaultIx(PROGRAM_ID, upgradeAuthority.publicKey, USDG, T22)]);
  cuOf('create_vault', cv.computeUnits, DEFAULT_IX_CU);
  const vault = vaultPda(PROGRAM_ID, USDG);
  const vaultInfo = await conn.getAccountInfo(vault, 'confirmed');
  const caps = decodeAssetCaps((await conn.getAccountInfo(assetCapPda(PROGRAM_ID, USDG), 'confirmed'))!.data);
  record('USDG vault created; caps 1,000 per deposit / 10,000 total', !!vaultInfo && caps.maxPerDeposit === CAP_PER_DEPOSIT && caps.maxTotal === CAP_TOTAL, `vault ${vault.toBase58()}, ${vaultInfo?.data.length} bytes`);
  await expectCode('a stranger cannot change the caps', send(conn, stranger, [setAssetCapsIx(PROGRAM_ID, stranger.publicKey, USDG, U64_MAX, U64_MAX)]), POOL_ERROR.ConfigAuthority);
  await expectCode('a stranger cannot pause deposits', send(conn, stranger, [setDepositsPausedIx(PROGRAM_ID, stranger.publicKey, true)]), POOL_ERROR.ConfigAuthority);

  // --- wallets
  const mk = async () => { const s = Keypair.generate(); await airdrop(s.publicKey, 5); return new SolanaWallet(Account.random(), pool, s); };
  const owner = await mk(), agent = await mk();
  const merchant = Keypair.generate().publicKey;
  const ownerAta = await createAssociatedTokenAccountIdempotent(conn, owner.signer, USDG, owner.signer.publicKey, { commitment: 'confirmed' }, T22);
  await mintTo(conn, issuer, USDG, ownerAta, issuer, 20_000n * USD, [], { commitment: 'confirmed' }, T22);
  const bal = (a: PublicKey) => pool.tokenBalance(a);
  const vaultBal = () => bal(vault);

  // --- deposit (exactly the per-deposit cap), and one base unit over it is refused
  const dep = await owner.deposit(USDG, CAP_PER_DEPOSIT);
  cuOf('transact_deposit', dep.tx.computeUnits, OP_CU_LIMIT);
  record('deposit 1,000 USDG', owner.balance(USDG) === CAP_PER_DEPOSIT && (await vaultBal()) === CAP_PER_DEPOSIT && (await bal(ownerAta)) === 19_000n * USD);
  await expectCode('deposit of 1,000.000001 USDG refused (per-deposit cap)', owner.deposit(USDG, CAP_PER_DEPOSIT + 1n), POOL_ERROR.DepositTooLarge);

  // --- grant
  const g = await owner.grant(USDG, [{ to: agent.address, amount: 300n * USD, maxPerTx: 100n * USD }]);
  cuOf('grant', g.tx.computeUnits, OP_CU_LIMIT);
  await agent.sync();
  const line = () => agent.agentAllowances(USDG).filter((x) => x.allowance.remaining > 0n)[0];
  record('grant 300 USDG to an agent (max 100 per payment)', line()?.allowance.remaining === 300n * USD && owner.balance(USDG) === 700n * USD);

  // --- agent pays a public merchant
  const pay = await agent.pay(line(), 50n * USD, merchant);
  cuOf('spend_public', pay.tx.computeUnits, OP_CU_LIMIT);
  const merchantAta = pool.ata(USDG, merchant, T22);
  record('agent pays 50 USDG to a merchant', (await bal(merchantAta)) === 50n * USD && line().allowance.remaining === 250n * USD && (await vaultBal()) === 950n * USD);

  // --- over-limit payment: no proof exists (circuit), and a tampered amount is refused on chain
  await expectReject('payment of 100.000001 USDG (over max per payment) has no proof', agent.pay(line(), 100n * USD + 1n, merchant));
  const p = await agent.prepareSpend(line(), 50n * USD, merchant);
  const forged = Uint8Array.from(p.payload);
  const AMOUNT_AT = 256 + 32 * 4; // proof | root | nullifier | newAllowanceCommitment | payCommitment | publicAmount u128le
  forged.set(Buffer.from((200n * USD).toString(16).padStart(32, '0'), 'hex').reverse(), AMOUNT_AT);
  await expectCode('a valid 50 USDG proof sent with amount 200 USDG is refused on chain', pool.run(agent.signer, forged, (buffer) => spendIx(PROGRAM_ID, { ...p.accounts, buffer })), POOL_ERROR.InvalidProof);
  record('merchant and vault unchanged after the refusals', (await bal(merchantAta)) === 50n * USD && (await vaultBal()) === 950n * USD);

  // --- selective disclosure: prove + verify on chain (send, with compute units), a changed bound fails
  const d = await agent.prove(line(), 'remainingAtLeast', 200n * USD, 0xa0d17n);
  const checker = Keypair.generate();
  await airdrop(checker.publicKey, 1);
  const buf = await uploadBuffer(conn, PROGRAM_ID, checker, concatBytes(encodeProof(d.proof.proof), encodeDiscloseArgs(d.args)));
  const stagingCu: number[] = [];
  for (const sig of buf.signatures) stagingCu.push((await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }))?.meta?.computeUnitsConsumed ?? -1);
  cuOf('buffer_open_and_write_tx_max', Math.max(...stagingCu), DEFAULT_IX_CU * 2);
  const vd = await send(conn, checker, [verifyDisclosureIx(PROGRAM_ID, buf.address)], { cuLimit: OP_CU_LIMIT });
  cuOf('verify_disclosure', vd.computeUnits, OP_CU_LIMIT);
  const close = await closeBuffer(conn, PROGRAM_ID, checker, buf.seed);
  cuOf('buffer_close', close.computeUnits, DEFAULT_IX_CU);
  record('disclosure "remaining >= 200 USDG" verified on chain', true);
  record('simulated verification also accepts it', await pool.verifyDisclosure(checker, d.proof, d.args, 'simulate'));
  record('a changed bound (240 USDG) is refused', !(await pool.verifyDisclosure(checker, d.proof, { ...d.args, bound: 240n * USD })));
  record('an unknown root is refused', !(await pool.verifyDisclosure(checker, d.proof, { ...d.args, root: randomField() })));

  // --- withdraw
  const wd = await owner.withdraw(USDG, 200n * USD, owner.signer.publicKey);
  cuOf('transact_withdraw', wd.tx.computeUnits, OP_CU_LIMIT);
  record('owner withdraws 200 USDG', owner.balance(USDG) === 500n * USD && (await bal(ownerAta)) === 19_200n * USD && (await vaultBal()) === 750n * USD);

  // --- pause: deposits refused, withdrawals still work; unpause
  const asAuth = (ix: Parameters<typeof send>[2][number]) => send(conn, configAuthority, [ix]);
  const pz = await asAuth(setDepositsPausedIx(PROGRAM_ID, configAuthority.publicKey, true));
  cuOf('set_deposits_paused', pz.computeUnits, DEFAULT_IX_CU);
  try {
    await expectCode('deposit while paused is refused', owner.deposit(USDG, 10n * USD), POOL_ERROR.DepositsPaused);
    await owner.withdraw(USDG, 100n * USD, owner.signer.publicKey);
    record('withdraw while paused works', owner.balance(USDG) === 400n * USD && (await bal(ownerAta)) === 19_300n * USD);
    const ap = line();
    await agent.pay(ap, 10n * USD, merchant);
    record('agent payment while paused works', (await bal(merchantAta)) === 60n * USD);
  } finally {
    await asAuth(setDepositsPausedIx(PROGRAM_ID, configAuthority.publicKey, false));
  }
  await owner.deposit(USDG, 10n * USD);
  record('unpaused: deposits work again', owner.balance(USDG) === 410n * USD && !decodeConfig((await conn.getAccountInfo(configPda(PROGRAM_ID), 'confirmed'))!.data).depositsPaused);

  // --- total cap: fill the vault to exactly 10,000 USDG, one base unit more is refused
  for (let v = await vaultBal(); v < CAP_TOTAL; v = await vaultBal()) {
    const amt = CAP_TOTAL - v < CAP_PER_DEPOSIT ? CAP_TOTAL - v : CAP_PER_DEPOSIT;
    await owner.deposit(USDG, amt);
  }
  record('vault filled to exactly the 10,000 USDG total cap', (await vaultBal()) === CAP_TOTAL);
  await expectCode('deposit over the total cap is refused', owner.deposit(USDG, 1n), POOL_ERROR.DepositCapExceeded);
  const w2 = await owner.withdraw(USDG, 1_000n * USD, owner.signer.publicKey);
  record('withdraw at the cap works', w2.tx.computeUnits > 0 && (await vaultBal()) === CAP_TOTAL - 1_000n * USD);

  // --- issuer powers (USDG risk notice): permanent delegate and freeze authority act on the pool's vault
  const issuerAta = await createAssociatedTokenAccountIdempotent(conn, issuer, USDG, issuer.publicKey, { commitment: 'confirmed' }, T22);
  const before = await vaultBal();
  await transferChecked(conn, issuer, vault, USDG, issuerAta, issuer, 1n * USD, 6, [], { commitment: 'confirmed' }, T22);
  record('[issuer risk] the permanent delegate can move USDG out of the pool vault', (await vaultBal()) === before - 1n * USD, 'expected: Token-2022 permanentDelegate');
  await freezeAccount(conn, issuer, vault, USDG, issuer, [], { commitment: 'confirmed' }, T22);
  await expectReject('[issuer risk] a frozen vault blocks withdrawals', owner.withdraw(USDG, 1n * USD, owner.signer.publicKey));
  await thawAccount(conn, issuer, vault, USDG, issuer, [], { commitment: 'confirmed' }, T22);
  await owner.sync();
  await owner.withdraw(USDG, 1n * USD, owner.signer.publicKey);
  record('after thaw withdrawals work again', true);

  // --- compute-unit margins
  for (const [k, v] of Object.entries(cu)) {
    record(`compute units ${k} under its limit with >= 25% headroom`, v.units > 0 && v.units <= 0.75 * v.limit && v.units < TX_CU_MAX, `${v.units} of ${v.limit}`);
  }
}
