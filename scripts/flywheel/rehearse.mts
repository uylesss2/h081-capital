// Full flywheel cycle on a PRIVATE LOCAL validator only (rpc 127.0.0.1:9299, ledger ~/stipend-flywheel-ledger;
// 8899/8900 belong to another project, 8999/9099/9199 to the test suites). Any other RPC is refused.
//
// Sets up its own mint and a Meteora DAMM v2 (cp-amm) pool, with Meteora's real cp-amm program dumped once from
// mainnet (read-only) and loaded locally. Local wallets stand in for the three launch wallets; the one standing in
// for the creator-fee wallet owns the pool's LP position, like on mainnet. Fake PLATFORM fees (SOL and WSOL)
// are paid into a local treasury keypair that stands in for the Squads vault. Then it runs buyback.mts exactly
// as an operator would: firewall refusals, dry run, --propose, executes the proposal (the treasury keypair plays
// the multisig), record, and asserts:
//   the H081 supply dropped by exactly the burned amount; the ledger has the proposed and executed entries;
//   the balances of the creator-fee stand-ins and of the real launch-wallet addresses are UNCHANGED;
//   and nothing in scripts/flywheel imports launch or fee-claim code.
// With --with-safety-pool it also loads solana/target-so/safety_pool.so (must include top_up) and checks the
// 50/50 split's top-up. Keys are generated in memory and never written.
//   npm run flywheel:rehearse [-- --with-safety-pool] [-- --keep]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import BN from 'bn.js';
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  AuthorityType, NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMint, createSyncNativeInstruction,
  getAssociatedTokenAddressSync, getMint, getOrCreateAssociatedTokenAccount, mintTo, setAuthority,
} from '@solana/spl-token';
import { BaseFeeMode, CpAmm, MAX_SQRT_PRICE, MIN_SQRT_PRICE, getBaseFeeParams } from '@meteora-ag/cp-amm-sdk';
import { LOCALNET_SAFETY_POOL_PROGRAM_ID, decodeSafetyConfig, safetyConfigPda, safetyDepositIx, safetyInitPoolIx, safetyVaultPda } from '../../src/solana/token.js';
import { DENY_LIST, ROOT, isLocalRpc, readLedger, MAINNET_GENESIS, fmt } from './common.mjs';
import type { Proposal } from './buyback.mjs';
import { sha256 } from '@noble/hashes/sha2';

// Localnet-only upgrade authority (public seed; test/solana/config-authority.ts): the validator loads safety_pool
// upgradeable with it, and init_pool accepts only the upgrade authority. Never use it off a local validator.
const LOCALNET_UPGRADE_AUTHORITY = Keypair.fromSeed(sha256(new TextEncoder().encode('h081 localnet stipend_pool upgrade authority')));

const { values: args } = parseArgs({ options: { 'with-safety-pool': { type: 'boolean', default: false }, keep: { type: 'boolean', default: false }, 'no-start': { type: 'boolean', default: false } } });
const RPC = 'http://127.0.0.1:9299';
if (process.env.FLYWHEEL_RPC && process.env.FLYWHEEL_RPC !== RPC) throw new Error(`rehearse runs only against its own local validator ${RPC}; refusing FLYWHEEL_RPC=${process.env.FLYWHEEL_RPC}`);
if (!isLocalRpc(RPC)) throw new Error('rehearsal RPC must be localhost');
const CP_AMM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
const withSafety = args['with-safety-pool'];
const isWin = process.platform === 'win32';
const toWsl = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => `/mnt/${d.toLowerCase()}`);
const work = mkdtempSync(join(tmpdir(), 'h081-flywheel-rehearsal-'));
const log: string[] = [];
const out = (s: string) => { console.log(s); log.push(s); };
let failed = 0;
const expect = (name: string, ok: boolean, detail?: string) => { out(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`); if (!ok) failed++; };

let nScripts = 0;
/** Runs a bash script in WSL (Linux: bash). Written to a file first: quoting through wsl.exe is not reliable. */
function bash(script: string) {
  const file = join(work, `step-${++nScripts}.sh`);
  writeFileSync(file, `${script}\n`.replace(/\r\n/g, '\n'));
  const [cmd, a] = isWin ? ['wsl.exe', ['-d', 'Ubuntu', '--', 'bash', toWsl(file)]] : ['bash', [file]];
  const r = spawnSync(cmd, a, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  return { ok: r.status === 0, text: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}
const LEDGER_MATCH = 'solana-test-validator.*--ledger $HOME/stipend-flywheel-ledger';
const stopValidator = () => bash(`pids=$(pgrep -f "${LEDGER_MATCH}" || true); [ -n "$pids" ] && kill $pids && sleep 2; echo stopped`);

// ------------------------------------------------------------- validator
if (!args['no-start']) {
  const env = `${toWsl(resolve(ROOT, 'solana', 'scripts', 'env.sh'))}`;
  const so = toWsl(resolve(ROOT, 'solana', 'target-so', 'safety_pool.so'));
  if (withSafety && !existsSync(resolve(ROOT, 'solana', 'target-so', 'safety_pool.so'))) throw new Error('--with-safety-pool needs solana/target-so/safety_pool.so (build it first)');
  const started = bash(`set -euo pipefail; source "${env}"
L="$HOME/stipend-flywheel-ledger"; P="$HOME/stipend-flywheel-programs"; mkdir -p "$P"
# Meteora's cp-amm program, dumped once from mainnet (a read; nothing is sent there).
[ -s "$P/cp_amm.so" ] || solana program dump -u https://api.mainnet-beta.solana.com ${CP_AMM} "$P/cp_amm.so" >/dev/null
progs=(--bpf-program ${CP_AMM} "$P/cp_amm.so")
${withSafety ? `cp "${so}" "$P/safety_pool.so"; progs+=(--upgradeable-program ${LOCALNET_SAFETY_POOL_PROGRAM_ID.toBase58()} "$P/safety_pool.so" ${LOCALNET_UPGRADE_AUTHORITY.publicKey.toBase58()})` : ''}
pids=$(pgrep -f "${LEDGER_MATCH}" || true); [ -n "$pids" ] && kill $pids && sleep 2
setsid nohup solana-test-validator --ledger "$L" --reset --quiet --rpc-port 9299 --faucet-port 9915 --gossip-port 8094 --dynamic-port-range 8700-8800 "\${progs[@]}" > /tmp/stipend-flywheel-validator.log 2>&1 < /dev/null &
for i in $(seq 1 120); do
  curl -s -m 2 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' http://127.0.0.1:9299 | grep -q '"ok"' && { echo "flywheel validator healthy on 9299"; exit 0; }
  sleep 1
done
tail -30 /tmp/stipend-flywheel-validator.log; exit 1`);
  out(started.text);
  if (!started.ok) process.exit(1);
}

const conn = new Connection(RPC, 'confirmed');
// healthy inside WSL does not mean reachable from Windows yet: the localhost forward can lag a few seconds
let genesis: string | undefined;
for (let i = 0; genesis === undefined; i++) {
  try {
    genesis = await conn.getGenesisHash();
  } catch (e) {
    if (i >= 60) {
      if (!args.keep && !args['no-start']) out(stopValidator().text);
      throw e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
if (genesis === MAINNET_GENESIS) throw new Error('localhost reports the mainnet genesis; refusing');

try {
  await rehearse();
} catch (e) {
  out(`FAIL rehearsal aborted: ${(e as Error).stack ?? e}`);
  failed++;
} finally {
  if (!args.keep && !args['no-start']) out(stopValidator().text);
}
out(failed ? `\n${failed} CHECK(S) FAILED` : '\nFLYWHEEL REHEARSAL PASSED');
writeFileSync(join(work, 'rehearsal.txt'), `${new Date().toISOString()}\n\n${log.join('\n')}\n`);
console.log(`evidence: ${join(work, 'rehearsal.txt')}`);
await new Promise((r) => setTimeout(r, 100));
process.exit(failed ? 1 : 0);

// ------------------------------------------------------------- the cycle

async function rehearse() {
  const send = (ixs: TransactionInstruction[], signers: Keypair[]) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: 'confirmed' });
  const airdrop = async (to: PublicKey, sol: number) => {
    const sig = await conn.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
    await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash('confirmed')) }, 'confirmed');
  };

  // Actors. creator / launchB / launchC stand in for the three launch wallets (creator owns the LP position).
  const payer = Keypair.generate(), creator = Keypair.generate(), launchB = Keypair.generate(), launchC = Keypair.generate();
  const relayer = Keypair.generate(), staker = Keypair.generate(), treasury = Keypair.generate(), dirtyTreasury = Keypair.generate();
  const standIns = [creator, launchB, launchC];
  const extraDeny = standIns.map((k) => k.publicKey.toBase58()).join(',');
  for (const [k, sol] of [[payer, 20], [creator, 120], [launchB, 2], [launchC, 2], [relayer, 20], [staker, 2]] as const) await airdrop(k.publicKey, sol);

  // Our own H081 stand-in: classic SPL, 6 decimals, then mint authority revoked like the real one.
  const mint = await createMint(conn, payer, payer.publicKey, null, 6, Keypair.generate(), { commitment: 'confirmed' }, TOKEN_PROGRAM_ID);
  const creatorAta = (await getOrCreateAssociatedTokenAccount(conn, payer, mint, creator.publicKey)).address;
  await mintTo(conn, payer, mint, creatorAta, payer, 900_000_000n * 1_000_000n);
  const stakerAta = (await getOrCreateAssociatedTokenAccount(conn, payer, mint, staker.publicKey)).address;
  await mintTo(conn, payer, mint, stakerAta, payer, 1_000_000n * 1_000_000n);
  await setAuthority(conn, payer, mint, payer, AuthorityType.MintTokens, null);
  out(`mint ${mint.toBase58()} (authority revoked)`);

  // DAMM v2 pool H081/SOL, 2% fee collected in SOL, LP position owned (and permanently locked) by the creator stand-in.
  const amm = new CpAmm(conn);
  const tokenAAmount = new BN((500_000_000n * 1_000_000n).toString());
  const tokenBAmount = new BN(50 * LAMPORTS_PER_SOL);
  const { initSqrtPrice, liquidityDelta } = amm.preparePoolCreationParams({ tokenAAmount, tokenBAmount, minSqrtPrice: MIN_SQRT_PRICE, maxSqrtPrice: MAX_SQRT_PRICE, collectFeeMode: 1 });
  const positionNft = Keypair.generate();
  const created = await amm.createCustomPool({
    payer: creator.publicKey, creator: creator.publicKey, positionNft: positionNft.publicKey, tokenAMint: mint, tokenBMint: NATIVE_MINT,
    tokenAAmount, tokenBAmount, sqrtMinPrice: MIN_SQRT_PRICE, sqrtMaxPrice: MAX_SQRT_PRICE, liquidityDelta, initSqrtPrice,
    poolFees: { baseFee: getBaseFeeParams({ baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear, feeTimeSchedulerParam: { startingFeeBps: 200, endingFeeBps: 200, numberOfPeriod: 0, totalDuration: 0 } }), compoundingFeeBps: 0, padding: 0, dynamicFee: null },
    hasAlphaVault: false, activationType: 1, collectFeeMode: 1, activationPoint: null, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, isLockLiquidity: true,
  });
  created.tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));
  await sendAndConfirmTransaction(conn, created.tx, [creator, positionNft], { commitment: 'confirmed' });
  const pool = created.pool;
  out(`pool ${pool.toBase58()} (500M H081 / 50 SOL, 2% fee, LP locked to the creator stand-in)`);

  // Safety pool (optional): created and staked so the 50/50 split applies.
  if (withSafety) {
    // init_pool accepts only the upgrade authority the validator loaded safety_pool with (localnet-only public seed)
    await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: LOCALNET_UPGRADE_AUTHORITY.publicKey, lamports: LAMPORTS_PER_SOL })], [payer]);
    await send([safetyInitPoolIx(LOCALNET_SAFETY_POOL_PROGRAM_ID, LOCALNET_UPGRADE_AUTHORITY.publicKey, mint, { authority: payer.publicKey, maxTotal: 10n ** 18n, maxPerDeposit: 10n ** 18n }, TOKEN_PROGRAM_ID)], [LOCALNET_UPGRADE_AUTHORITY]);
    await send([safetyDepositIx(LOCALNET_SAFETY_POOL_PROGRAM_ID, staker.publicKey, mint, stakerAta, 1_000_000n * 1_000_000n, TOKEN_PROGRAM_ID)], [staker]);
    out('safety pool created, 1M H081 staked');
  }

  // Fake PLATFORM fees into the treasury: a relayer fee in SOL and a loan origination fee in WSOL.
  const treasuryWsol = getAssociatedTokenAddressSync(NATIVE_MINT, treasury.publicKey, true);
  await send([SystemProgram.transfer({ fromPubkey: relayer.publicKey, toPubkey: treasury.publicKey, lamports: 2 * LAMPORTS_PER_SOL })], [relayer]);
  await send([
    createAssociatedTokenAccountIdempotentInstruction(relayer.publicKey, treasuryWsol, treasury.publicKey, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: relayer.publicKey, toPubkey: treasuryWsol, lamports: LAMPORTS_PER_SOL / 2 }),
    createSyncNativeInstruction(treasuryWsol),
  ], [relayer]);
  out(`treasury ${treasury.publicKey.toBase58()} received 2 SOL + 0.5 WSOL of fake platform fees`);

  // Snapshot of every creator-fee stand-in and of the real launch-wallet addresses.
  const watched = [
    ...standIns.map((k, i) => ({ label: `creator-fee stand-in ${i + 1}`, key: k.publicKey })),
    ...DENY_LIST.map((k) => ({ label: `launch wallet ${k.slice(0, 8)}`, key: new PublicKey(k) })),
  ];
  const snapshot = async () => Promise.all(watched.map(async (w) => {
    const ata = getAssociatedTokenAddressSync(mint, w.key, true);
    const t = await conn.getTokenAccountBalance(ata).then((b) => b.value.amount).catch(() => '0');
    return `${await conn.getBalance(w.key)}/${t}`;
  }));
  const before = await snapshot();
  const supply0 = (await getMint(conn, mint)).supply;

  // buyback.mts as a child process, exactly like an operator runs it.
  const tsx = resolve(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = resolve(ROOT, 'scripts', 'flywheel', 'buyback.mts');
  const ledger = join(work, 'flywheel-ledger.json');
  const run = (a: string[]) => {
    const r = spawnSync(process.execPath, [tsx, script, ...a, '--rpc', RPC, '--mint', mint.toBase58(), '--pool', pool.toBase58(), '--ledger', ledger], {
      encoding: 'utf8', cwd: work, env: { ...process.env, FLYWHEEL_RPC: RPC, FLYWHEEL_EXTRA_DENY: extraDeny },
    });
    const text = `${r.stdout}${r.stderr}`.split('\n').filter((l) => !/^bigint:|Assertion failed: !\(handle/.test(l)).join('\n').trim();
    out(`$ buyback.mts ${a.join(' ')}\n${text}\n`);
    return { ok: r.status === 0, text };
  };
  const T = treasury.publicKey.toBase58();
  const safetyArgs = withSafety ? ['--safety-program', LOCALNET_SAFETY_POOL_PROGRAM_ID.toBase58()] : [];

  // Firewall refusals: nothing written, nothing sent.
  const refused = (name: string, a: string[], re: RegExp) => {
    const p = join(work, `refused-${name.replace(/\W+/g, '-')}.json`);
    const r = run([...a, '--propose', '--out', p]);
    expect(`refuses: ${name}`, !r.ok && re.test(r.text) && !existsSync(p) && !existsSync(ledger));
  };
  refused('treasury is the real creator-fee wallet', ['--treasury', DENY_LIST[0]], /FIREWALL/);
  refused('treasury is a launch wallet', ['--treasury', DENY_LIST[2]], /FIREWALL/);
  refused('treasury is the creator-fee stand-in', ['--treasury', creator.publicKey.toBase58()], /FIREWALL/);
  refused('fee payer is a launch wallet', ['--treasury', T, '--fee-payer', DENY_LIST[1]], /FIREWALL/);
  await send([SystemProgram.transfer({ fromPubkey: launchB.publicKey, toPubkey: dirtyTreasury.publicKey, lamports: LAMPORTS_PER_SOL })], [launchB]);
  refused('treasury that ever received from a launch wallet', ['--treasury', dirtyTreasury.publicKey.toBase58()], /FIREWALL.*history touches launch wallet/);
  refused('slippage above 1%', ['--treasury', T, '--slippage-bps', '150'], /slippage-bps must be 1\.\.100/);
  // launchB paid the dirty treasury above (part of the test); re-snapshot it so the cycle itself is what is compared.
  const beforeCycle = await snapshot();
  expect('only the deliberate dirty-treasury transfer moved a stand-in so far', before.filter((b, i) => b !== beforeCycle[i]).length === 1);

  // Dry run: plan printed, nothing built, nothing written.
  const lam0 = await conn.getBalance(treasury.publicKey);
  const dry = run(['--treasury', T, '--max-spend-sol', '1.5', '--chunk-reserve-bps', '100', ...safetyArgs]);
  expect('dry run is the default and writes nothing', dry.ok && /DRY RUN/.test(dry.text) && !existsSync(ledger) && (await conn.getBalance(treasury.publicKey)) === lam0);

  // Propose: unsigned transactions for the multisig, ledger "proposed".
  const pfile = join(work, 'proposal.json');
  const prop = run(['--treasury', T, '--max-spend-sol', '1.5', '--chunk-reserve-bps', '100', '--propose', '--out', pfile, ...safetyArgs]);
  expect('propose writes a proposal and a ledger entry, sends nothing', prop.ok && existsSync(pfile) && readLedger(ledger).entries.length === 1 && (await conn.getBalance(treasury.publicKey)) === lam0);
  if (!existsSync(pfile)) throw new Error('no proposal to execute');
  const proposal = JSON.parse(readFileSync(pfile, 'utf8')) as Proposal;
  expect('proposal: several randomised chunks, 1% slippage, treasury the only signer', proposal.chunks.length > 1 && proposal.slippageBps === 100
    && proposal.transactions.every((t) => t.instructions.every((ix) => ix.accounts.every((k) => !k.isSigner || k.pubkey === T))),
    `${proposal.chunks.length} chunks: ${proposal.chunks.map((c) => fmt(BigInt(c.lamportsIn), 9)).join(', ')} SOL`);
  expect(`split is ${withSafety ? '50/50' : '100% burn'}`, withSafety ? proposal.split.topUpBps === 5000 : proposal.split.burnBps === 10_000);

  // Execute it: the treasury keypair plays the multisig, in order, from the raw instructions in the file.
  const vault0 = withSafety ? decodeSafetyConfig((await conn.getAccountInfo(safetyConfigPda(LOCALNET_SAFETY_POOL_PROGRAM_ID, mint)))!.data).assets : 0n;
  const sigs: string[] = [];
  // An unrelated treasury transaction (its funding) for the record refusal below.
  const [unrelated] = await conn.getSignaturesForAddress(treasury.publicKey, { limit: 1 }, 'confirmed');
  // check: a chunk whose frozen minimum is far below the live quote is NO-GO (stale protection).
  const stale = join(work, 'proposal-stale.json');
  writeFileSync(stale, JSON.stringify({ ...proposal, chunks: proposal.chunks.map((c) => (c.index === 1 ? { ...c, minOut: '1' } : c)) }));
  const staleCheck = run(['check', '--proposal', stale, '--chunk', '1']);
  expect('check: a stale minimum output is NO-GO', !staleCheck.ok && /NO-GO/.test(staleCheck.text));
  for (const t of proposal.transactions) {
    if (t.chunk) {
      const c = run(['check', '--proposal', pfile, '--chunk', String(t.chunk)]);
      expect(`check: chunk ${t.chunk} is GO right before it executes`, c.ok && /GO: execute/.test(c.text));
    }
    const ixs = t.instructions.map((ix) => new TransactionInstruction({
      programId: new PublicKey(ix.programId), data: Buffer.from(ix.data, 'base64'),
      keys: ix.accounts.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
    }));
    const tx = new Transaction().add(...ixs);
    tx.feePayer = treasury.publicKey;
    sigs.push(await sendAndConfirmTransaction(conn, tx, [treasury], { commitment: 'confirmed' }));
    out(`executed ${t.order}. ${t.label}: ${sigs.at(-1)}`);
  }

  const wrongRec = run(['record', '--proposal', pfile, '--sig', unrelated.signature]);
  expect('record refuses a treasury transaction that is not part of the proposal', !wrongRec.ok && /does not carry out/.test(wrongRec.text) && readLedger(ledger).entries.length === 1);
  const rec = run(['record', '--proposal', pfile, ...sigs.flatMap((s) => ['--sig', s])]);
  const l = readLedger(ledger);
  const executed = l.entries.find((e) => e.status === 'executed');
  expect('record appends an executed entry', rec.ok && l.entries.length === 2 && executed?.refersTo === proposal.id);
  expect('record matched every proposal transaction, no warnings', executed?.result?.executed?.length === proposal.transactions.length && !executed?.result?.warnings);

  const supply1 = (await getMint(conn, mint)).supply;
  const burned = BigInt(executed?.result?.burned ?? '0');
  expect('H081 supply dropped by exactly the burned amount', burned > 0n && supply0 - supply1 === burned, `${fmt(supply0, 6)} -> ${fmt(supply1, 6)}, burned ${fmt(burned, 6)}`);
  expect('burned matches the proposal', burned === BigInt(proposal.settle.burn));
  expect('ledger: bought >= guaranteed minimum', BigInt(executed?.result?.h081Bought ?? '0') >= BigInt(proposal.chunks.reduce((a, c) => a + BigInt(c.minOut), 0n)));
  expect('ledger: SOL spent equals the planned chunks', executed?.result?.solSpentLamports === proposal.chunks.reduce((a, c) => a + BigInt(c.lamportsIn), 0n).toString());
  if (withSafety) {
    const vault1 = decodeSafetyConfig((await conn.getAccountInfo(safetyConfigPda(LOCALNET_SAFETY_POOL_PROGRAM_ID, mint)))!.data).assets;
    expect('safety pool assets grew by the top-up', vault1 - vault0 === BigInt(proposal.settle.topUp) && BigInt(executed?.result?.toppedUp ?? '0') === vault1 - vault0, `vault ${safetyVaultPda(LOCALNET_SAFETY_POOL_PROGRAM_ID, mint).toBase58()}`);
  }
  expect('treasury WSOL unwrapped and spent', !(await conn.getAccountInfo(treasuryWsol)) && (await conn.getBalance(treasury.publicKey)) < lam0);

  const after = await snapshot();
  for (const [i, w] of watched.entries()) expect(`${w.label} unchanged (SOL lamports / H081)`, after[i] === beforeCycle[i], `${beforeCycle[i]} -> ${after[i]}`);

  // Static firewall: no launch / fee-claim code anywhere in scripts/flywheel (patterns assembled so this file does not match itself).
  const banned = [['launch', '.mjs'], ['claim', 'CreatorTradingFee'], ['claim', 'PartnerTradingFee'], ['claim', 'PositionFee'], ['dynamic-bonding-curve', '-sdk'], ['scripts/', 'launch']].map((p) => p.join(''));
  const dir = resolve(ROOT, 'scripts', 'flywheel');
  const offenders = readdirSync(dir).filter((f) => /\.(m?ts|m?js)$/.test(f)).flatMap((f) => banned.filter((b) => readFileSync(join(dir, f), 'utf8').includes(b)).map((b) => `${f}: ${b}`));
  expect('scripts/flywheel never imports launch or fee-claim code', offenders.length === 0, offenders.join('; '));
}
