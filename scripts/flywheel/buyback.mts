// H081 flywheel buyback: the treasury's PLATFORM FEES (relayer fee, loan origination fee, paid hosted services)
// buy H081 on the DAMM v2 pool in randomised small chunks (max 1% slippage each), and the H081 is burned, or
// once the safety pool is live, half burned and half paid into it with safety_pool::top_up. docs/FLYWHEEL.md.
//
// The token's trading CREATOR FEES are the team's: never a source, never claimed, never moved. Firewall:
// a hard-coded DENY_LIST of the launch wallets (common.mts); the run is refused if the treasury, the fee payer,
// a signer or any account of any instruction is one of them, or if the treasury's history ever touched one.
//
// This script NEVER signs and NEVER sends a transaction, on any cluster.
//   dry run (default)   prints the plan; builds nothing for signing, writes nothing.
//   --propose           writes a proposal file (unsigned transactions + raw instructions, fee payer = treasury)
//                       for the treasury's Squads multisig to review, approve and execute, and appends a
//                       "proposed" ledger entry.
//   check               right before the multisig executes a buy chunk: re-quotes the pool live and says GO only
//                       if the chunk's frozen minimum output is still within the slippage cap of the live quote
//                       and the chunk has not passed its notAfter time; otherwise NO-GO (exit 2): skip or re-plan.
//                       Each chunk's minimum output is fixed when the proposal is built, so a chunk executed hours
//                       later must not rely on it alone.
//   record              after the multisig executed it: reads the confirmed transactions back, checks that each
//                       one carries out a transaction of this proposal (same programs, accounts and data, directly
//                       or inside the Squads vault execute), and appends an "executed" ledger entry with what they
//                       actually did.
// Mainnet RPCs are used read-only and only with the official mint, pool and (once deployed) safety_pool program;
// devnet/testnet are refused.
//
// Usage (Windows, repo root):
//   npm run flywheel:buyback -- --treasury <squads vault>                       # dry run
//   npm run flywheel:buyback -- --treasury <squads vault> --propose [--out p.json] [--safety-program <id>]
//   npm run flywheel:buyback -- check --proposal p.json --chunk <n>              # before executing chunk n
//   npm run flywheel:buyback -- record --proposal p.json --sig <sig> [--sig <sig> ...]
// Options: --rpc (or FLYWHEEL_RPC; default mainnet-beta, read-only), --ledger (default ./flywheel-ledger.json),
//   --fee-payer <member who will execute>, --max-spend-sol, --reserve-sol (0.05), --max-chunk-sol (0.25),
//   --chunk-reserve-bps (30: a chunk is at most this share of the pool's SOL), --max-chunks (24),
//   --slippage-bps (100, cannot exceed 100), --provenance-depth (5000); localhost only: --mint, --pool.
import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import BN from 'bn.js';
import {
  ComputeBudgetProgram, Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  type ParsedTransactionWithMeta, type TokenBalance, type VersionedTransactionResponse,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction, createCloseAccountInstruction, getAssociatedTokenAddressSync, getMint,
} from '@solana/spl-token';
import { CP_AMM_PROGRAM_ID, CpAmm, getCurrentPoint, getTokenProgram, swapQuoteExactInput, type PoolState } from '@meteora-ag/cp-amm-sdk';
import { decodeSafetyConfig, safetyConfigPda, safetyTopUpIx, safetyVaultPda } from '../../src/solana/token.js';
import {
  DEFAULT_LEDGER, DENY_LIST, FirewallError, H081_MINT, H081_POOL, H081_SAFETY_POOL_PROGRAM, MAX_SLIPPAGE_BPS, SPLIT_BURN_ONLY, SPLIT_LIVE,
  appendLedger, assertInstructionsClean, assertNotDenied, base58, base58Decode, denySet, detectCluster, fmt, lastProvenanceCursor,
  parseUnits, readLedger, scanProvenance, sha256Hex, txAccountKeys, type Cluster, type LedgerEntry,
} from './common.mjs';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rpc: { type: 'string' }, treasury: { type: 'string' }, propose: { type: 'boolean', default: false }, out: { type: 'string' },
    ledger: { type: 'string' }, 'fee-payer': { type: 'string' }, 'max-spend-sol': { type: 'string' }, 'reserve-sol': { type: 'string', default: '0.05' },
    'max-chunk-sol': { type: 'string', default: '0.25' }, 'chunk-reserve-bps': { type: 'string', default: '30' }, 'max-chunks': { type: 'string', default: '24' },
    'slippage-bps': { type: 'string', default: String(MAX_SLIPPAGE_BPS) }, 'safety-program': { type: 'string' }, 'provenance-depth': { type: 'string', default: '5000' },
    mint: { type: 'string' }, pool: { type: 'string' }, proposal: { type: 'string' }, sig: { type: 'string', multiple: true }, chunk: { type: 'string' },
  },
});
const cmd = positionals[0] ?? 'plan';
const rpc = args.rpc ?? process.env.FLYWHEEL_RPC ?? 'https://api.mainnet-beta.solana.com';
const conn = new Connection(rpc, 'confirmed');
const ledgerPath = resolve(args.ledger ?? DEFAULT_LEDGER);
const deny = denySet();
const SOL = 9;

/** Lamports kept back for ATA rent (two token accounts) on top of --reserve-sol. */
const RENT_BUFFER = 5_000_000n;
/** Below this a chunk is not worth its transaction; the remainder waits for the next cycle. */
const MIN_CHUNK = 10_000_000n;
/** A chunk may be executed until its suggested time plus this; after that its frozen quote is too old (NO-GO, re-plan). */
const CHUNK_GRACE_MINUTES = 60;
/** Least accounted H081 (whole tokens) the safety pool must hold before the flywheel tops it up instead of burning. */
const MIN_SAFETY_ASSETS_WHOLE = 10_000n;

interface ProposalTx {
  order: number; label: string; executeAfterMinutes: number;
  /** the buy chunk this transaction carries out (absent for unwrap / settle) */
  chunk?: number;
  instructions: { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }[];
  unsignedTxBase58: string; unsignedTxBase64: string; bytes: number;
}
export interface Proposal {
  kind: 'h081-flywheel-proposal'; version: 2; id: string; createdAt: string; cluster: Cluster; genesis: string;
  source: 'platform-fees'; denyList: readonly string[];
  treasury: string; feePayer: string; mint: string; mintDecimals: number; mintTokenProgram: string; pool: string;
  poolVaults: { sol: string; h081: string };
  safety: { program: string; config: string; vault: string } | null;
  split: { burnBps: number; topUpBps: number }; slippageBps: number;
  balances: NonNullable<LedgerEntry['balances']>;
  /** notAfter: latest time (ISO) the chunk may execute; run `check` right before executing it either way. */
  chunks: { index: number; lamportsIn: string; quotedOut: string; minOut: string; executeAfterMinutes: number; notAfter: string }[];
  settle: { h081Held: string; burn: string; topUp: string };
  transactions: ProposalTx[];
  howToExecute: string[];
}

try {
  if (cmd === 'plan') await plan();
  else if (cmd === 'check') await check();
  else if (cmd === 'record') await record();
  else throw new Error(`unknown command ${cmd}; use no command (plan / --propose), "check" or "record"`);
} catch (e) {
  console.error(e instanceof FirewallError ? `\n${e.message}\nNothing was built or written.` : `\nERROR: ${(e as Error).message ?? e}`);
  process.exitCode = 1;
}
// web3.js keeps a socket open; leave promptly.
await new Promise((r) => setTimeout(r, 100));
process.exit(process.exitCode ?? 0);

// ------------------------------------------------------------- plan / propose

async function plan() {
  const { cluster, genesis } = await detectCluster(conn, rpc);
  const treasuryArg = args.treasury ?? process.env.FLYWHEEL_TREASURY;
  if (!treasuryArg) throw new Error('set --treasury (or FLYWHEEL_TREASURY) to the platform-fee treasury (the Squads vault address)');
  assertNotDenied(deny, 'treasury', treasuryArg);
  const treasury = new PublicKey(treasuryArg);
  const feePayer = new PublicKey(args['fee-payer'] ?? treasury);
  assertNotDenied(deny, 'fee payer', feePayer);

  const mint = new PublicKey(args.mint ?? H081_MINT);
  const pool = new PublicKey(args.pool ?? H081_POOL);
  if (cluster === 'mainnet-beta' && (!mint.equals(H081_MINT) || !pool.equals(H081_POOL))) throw new Error('on mainnet only the official H081 mint and pool are allowed');
  assertNotDenied(deny, 'mint', mint);
  assertNotDenied(deny, 'pool', pool);
  if (treasury.equals(mint) || treasury.equals(pool)) throw new Error('treasury cannot be the mint or the pool');

  const slippageBps = Number(args['slippage-bps']);
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > MAX_SLIPPAGE_BPS) throw new Error(`--slippage-bps must be 1..${MAX_SLIPPAGE_BPS}`);
  const maxChunks = Number(args['max-chunks']);
  const chunkReserveBps = BigInt(args['chunk-reserve-bps']!);
  if (!Number.isInteger(maxChunks) || maxChunks < 1 || maxChunks > 100) throw new Error('--max-chunks must be 1..100');
  if (chunkReserveBps < 1n || chunkReserveBps > 100n) throw new Error('--chunk-reserve-bps must be 1..100');

  // Pool and mint.
  const amm = new CpAmm(conn);
  const ps: PoolState = await amm.fetchPoolState(pool);
  const mintIsA = ps.tokenAMint.equals(mint);
  if (!(mintIsA ? ps.tokenBMint.equals(NATIVE_MINT) : ps.tokenAMint.equals(NATIVE_MINT) && ps.tokenBMint.equals(mint))) {
    throw new Error(`pool ${pool.toBase58()} is not ${mint.toBase58()}/SOL`);
  }
  const mintAcct = await conn.getAccountInfo(mint);
  if (!mintAcct) throw new Error(`mint ${mint.toBase58()} not found`);
  const mintProgram = mintAcct.owner;
  if (!mintProgram.equals(TOKEN_PROGRAM_ID) && !mintProgram.equals(TOKEN_2022_PROGRAM_ID)) throw new Error('mint is not an SPL token');
  const mintInfo = await getMint(conn, mint, 'confirmed', mintProgram);
  const tokenAProgram = getTokenProgram(ps.tokenAFlag);
  const tokenBProgram = getTokenProgram(ps.tokenBFlag);
  const solVault = mintIsA ? ps.tokenBVault : ps.tokenAVault;
  const h081Vault = mintIsA ? ps.tokenAVault : ps.tokenBVault;
  const poolSol = BigInt((await conn.getTokenAccountBalance(solVault)).value.amount);

  // Treasury balances. Every token account it owns is listed; only SOL/WSOL is spent (the pool is H081/SOL).
  const lamports = BigInt(await conn.getBalance(treasury));
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, treasury, true, TOKEN_PROGRAM_ID);
  const h081Ata = getAssociatedTokenAddressSync(mint, treasury, true, mintProgram);
  const tokenAccounts: { pubkey: PublicKey; mint: string; amount: bigint }[] = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const r = await conn.getParsedTokenAccountsByOwner(treasury, { programId });
    for (const a of r.value) {
      const info = a.account.data.parsed.info;
      tokenAccounts.push({ pubkey: a.pubkey, mint: info.mint as string, amount: BigInt(info.tokenAmount.amount as string) });
    }
  }
  const wsol = tokenAccounts.find((a) => a.pubkey.equals(wsolAta))?.amount ?? 0n;
  const h081Held = tokenAccounts.find((a) => a.pubkey.equals(h081Ata))?.amount ?? 0n;
  const otherTokens = tokenAccounts.filter((a) => !a.pubkey.equals(wsolAta) && !a.pubkey.equals(h081Ata)).map((a) => ({ mint: a.mint, amount: a.amount.toString() }));

  // Provenance: refuse a treasury that ever transacted with a launch wallet.
  const ledger = readLedger(ledgerPath);
  const cursor = lastProvenanceCursor(ledger, treasury);
  const prov = await scanProvenance(conn, [treasury, ...tokenAccounts.map((a) => a.pubkey)], deny, { until: cursor, depth: Number(args['provenance-depth']) });
  if (prov.hits.length) {
    throw new FirewallError(`the treasury's history touches launch wallet(s): ${prov.hits.slice(0, 5).map((h) => `${h.account} in ${h.signature}`).join('; ')}${prov.hits.length > 5 ? ` (+${prov.hits.length - 5} more)` : ''}. Creator-fee money may have mixed in; refusing`);
  }
  // A funded treasury got its funds in some transaction. With no earlier cursor, an empty history means the RPC
  // has pruned it (or never indexed it), so provenance cannot be shown: refuse rather than report "clean".
  if (!cursor && prov.scanned === 0 && (lamports > 0n || tokenAccounts.some((a) => a.amount > 0n))) {
    throw new FirewallError(`the RPC returns no transaction history for the funded treasury ${treasury.toBase58()}, so its provenance cannot be checked; use an RPC with full history; refusing`);
  }
  if (prov.truncated) throw new Error(`treasury history is longer than --provenance-depth ${args['provenance-depth']} and the ledger has no earlier cursor; raise the depth`);

  // Split: burn only, until the safety pool is live (exists and has stakers).
  let split: { burnBps: number; topUpBps: number } = SPLIT_BURN_ONLY;
  // The pool's accounted assets when it qualifies for a top-up. safety_pool refuses a top-up above them, and a
  // top-up into a pool with almost no real stake would mostly go to whoever holds its few shares (a dust stake
  // set up just before the flywheel runs): below MIN_SAFETY_ASSETS_WHOLE whole tokens the cycle burns instead.
  let safetyAssets = 0n;
  let safety: Proposal['safety'] = null;
  let safetyNote = 'no --safety-program given: 100% burn';
  if (args['safety-program']) {
    const sp = new PublicKey(args['safety-program']);
    assertNotDenied(deny, 'safety program', sp);
    // The top-up hands this program the treasury as signer and its H081 account as writable: on mainnet only the
    // pinned safety_pool id is accepted (none until it is deployed), like the mint and the pool.
    if (cluster === 'mainnet-beta') {
      if (!H081_SAFETY_POOL_PROGRAM) throw new Error('safety_pool is not deployed on mainnet yet (H081_SAFETY_POOL_PROGRAM in common.mts is unset); run without --safety-program (100% burn)');
      if (!sp.equals(H081_SAFETY_POOL_PROGRAM)) throw new Error(`on mainnet only the official safety_pool program ${H081_SAFETY_POOL_PROGRAM.toBase58()} is allowed`);
    }
    const cfgKey = safetyConfigPda(sp, mint);
    const acct = await conn.getAccountInfo(cfgKey);
    if (!acct || !acct.owner.equals(sp)) safetyNote = `safety pool ${cfgKey.toBase58()} not found: 100% burn`;
    else {
      const c = decodeSafetyConfig(acct.data);
      if (!c.mint.equals(mint)) throw new Error('safety pool is for a different mint');
      const floor = MIN_SAFETY_ASSETS_WHOLE * 10n ** BigInt(mintInfo.decimals);
      if (c.totalShares === 0n) safetyNote = 'safety pool has no stakers yet: 100% burn';
      else if (c.assets < floor) safetyNote = `safety pool assets ${fmt(c.assets, mintInfo.decimals)} H081 are below the ${MIN_SAFETY_ASSETS_WHOLE} H081 floor: 100% burn`;
      else {
        safetyAssets = c.assets;
        split = SPLIT_LIVE;
        safety = { program: sp.toBase58(), config: cfgKey.toBase58(), vault: safetyVaultPda(sp, mint).toBase58() };
        safetyNote = `safety pool live (assets ${fmt(c.assets, mintInfo.decimals)} H081): 50% burn / 50% top-up`;
      }
    }
  }

  // Budget and randomised chunks, each at most --chunk-reserve-bps of the pool's SOL so no single trade moves the price much.
  const reserve = parseUnits(args['reserve-sol']!, SOL);
  let budget = lamports + wsol - reserve - RENT_BUFFER;
  if (args['max-spend-sol']) { const cap = parseUnits(args['max-spend-sol'], SOL); if (budget > cap) budget = cap; }
  if (budget < 0n) budget = 0n;
  const maxChunk = [parseUnits(args['max-chunk-sol']!, SOL), (poolSol * chunkReserveBps) / 10_000n].reduce((a, b) => (a < b ? a : b));
  const sizes: bigint[] = [];
  let left = budget;
  while (left >= MIN_CHUNK && maxChunk >= MIN_CHUNK && sizes.length < maxChunks) {
    const lo = maxChunk / 2n > MIN_CHUNK ? maxChunk / 2n : MIN_CHUNK;
    let size = lo + BigInt(randomInt(0, Number(maxChunk - lo) + 1)); // maxChunk - lo < 2^48 for any realistic pool
    if (size > left) size = left;
    sizes.push(size);
    left -= size;
  }

  // Quotes chained: chunk k gets q(sum of 1..k) - q(sum of 1..k-1), i.e. what it gets after chunks 1..k-1 executed.
  const point = await getCurrentPoint(conn, ps.activationType);
  const quote = (lamportsIn: bigint) => quoteBuy(ps, point, lamportsIn, mint, mintInfo.decimals);
  const createdAt = new Date();
  const chunks: Proposal['chunks'] = [];
  let cum = 0n, prevOut = 0n, delay = 0;
  for (const [i, size] of sizes.entries()) {
    cum += size;
    const out = quote(cum);
    const quotedOut = out - prevOut;
    prevOut = out;
    const minOut = (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
    if (minOut <= 0n) throw new Error(`chunk ${i + 1} would buy nothing; pool too thin`);
    delay += randomInt(15, 121); // suggested spacing: 15-120 minutes between chunks
    const notAfter = new Date(createdAt.getTime() + (delay + CHUNK_GRACE_MINUTES) * 60_000).toISOString();
    chunks.push({ index: i + 1, lamportsIn: size.toString(), quotedOut: quotedOut.toString(), minOut: minOut.toString(), executeAfterMinutes: delay, notAfter });
  }
  const spend = sizes.reduce((a, b) => a + b, 0n);
  const minBought = chunks.reduce((a, c) => a + BigInt(c.minOut), 0n);
  const toSettle = h081Held + minBought;
  let topUp = (toSettle * BigInt(split.topUpBps)) / 10_000n;
  if (topUp > safetyAssets) topUp = safetyAssets; // one top-up at most doubles the pool (safety_pool::top_up); the rest is burned
  const burn = toSettle - topUp;

  // Instructions. The treasury is the only signer and pays for its own ATAs.
  const txs: { label: string; executeAfterMinutes: number; chunk?: number; ixs: TransactionInstruction[] }[] = [];
  if (wsol > 0n && sizes.length) {
    // Platform fees held as WSOL: unwrap first so the chunks can wrap exactly what they spend.
    txs.push({ label: 'unwrap WSOL platform fees to SOL', executeAfterMinutes: 0, ixs: [createCloseAccountInstruction(wsolAta, treasury, treasury, [], TOKEN_PROGRAM_ID)] });
  }
  for (const c of chunks) {
    const t = await amm.swap({
      payer: treasury, pool, inputTokenMint: NATIVE_MINT, outputTokenMint: mint, amountIn: new BN(c.lamportsIn), minimumAmountOut: new BN(c.minOut),
      tokenAMint: ps.tokenAMint, tokenBMint: ps.tokenBMint, tokenAVault: ps.tokenAVault, tokenBVault: ps.tokenBVault, tokenAProgram, tokenBProgram,
      referralTokenAccount: null, poolState: ps,
    });
    txs.push({ label: `buy chunk ${c.index}/${chunks.length}: ${fmt(BigInt(c.lamportsIn), SOL)} SOL -> >= ${fmt(BigInt(c.minOut), mintInfo.decimals)} H081`, executeAfterMinutes: c.executeAfterMinutes, chunk: c.index, ixs: t.instructions });
  }
  if (toSettle > 0n) {
    const ixs = [createAssociatedTokenAccountIdempotentInstruction(treasury, h081Ata, treasury, mint, mintProgram)];
    if (burn > 0n) ixs.push(createBurnCheckedInstruction(h081Ata, mint, treasury, burn, mintInfo.decimals, [], mintProgram));
    if (topUp > 0n && safety) ixs.push(safetyTopUpIx(new PublicKey(safety.program), treasury, mint, h081Ata, topUp, mintProgram));
    txs.push({ label: `settle: burn ${fmt(burn, mintInfo.decimals)} H081${topUp ? `, top up safety pool ${fmt(topUp, mintInfo.decimals)} H081` : ''} (execute LAST)`, executeAfterMinutes: delay + 5, ixs });
  }

  const programs = [SystemProgram.programId, ComputeBudgetProgram.programId, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, CP_AMM_PROGRAM_ID, ...(safety ? [new PublicKey(safety.program)] : [])];
  assertInstructionsClean(deny, txs.flatMap((t) => t.ixs), treasury, programs);
  for (const t of txs) {
    for (const ix of t.ixs) {
      if (!ix.programId.equals(TOKEN_PROGRAM_ID) && !ix.programId.equals(TOKEN_2022_PROGRAM_ID)) continue;
      // Token-program sources must belong to the treasury (WSOL / H081 ATA) or be a pool vault the pool authority moves.
      const src = ix.keys[0]?.pubkey;
      if (src && ix.keys.some((k) => k.isSigner) && !src.equals(wsolAta) && !src.equals(h081Ata)) throw new FirewallError(`token instruction debits ${src.toBase58()}, which is not a treasury account`);
    }
  }

  // Report.
  const D = mintInfo.decimals;
  const p = (s: string) => console.log(s);
  p(`H081 flywheel buyback (${cluster}${cluster === 'mainnet-beta' ? ', read-only' : ''})  ${args.propose ? 'PROPOSE' : 'DRY RUN'}`);
  p(`  source         platform fees only (treasury ${treasury.toBase58()}); creator fees are never touched`);
  p(`  firewall       deny-list ${DENY_LIST.length}${deny.size > DENY_LIST.length ? ` + ${deny.size - DENY_LIST.length} local` : ''} wallets: treasury, fee payer, signers, every account checked`);
  p(`  provenance     ${prov.scanned} treasury transaction(s) scanned${cursor ? ` since ${cursor.slice(0, 12)}...` : ''}: no launch wallet`);
  p(`  pool           ${pool.toBase58()} (${fmt(poolSol, SOL)} SOL side), mint ${mint.toBase58()}`);
  p(`  treasury       ${fmt(lamports, SOL)} SOL + ${fmt(wsol, SOL)} WSOL, ${fmt(h081Held, D)} H081 held`);
  for (const t of otherTokens) p(`                 ${t.amount} base units of ${t.mint}: held, not spent (no route into the H081/SOL pool)`);
  p(`  budget         ${fmt(spend, SOL)} SOL in ${chunks.length} chunk(s) of <= ${fmt(maxChunk, SOL)} SOL, slippage ${slippageBps / 100}% (reserve ${fmt(reserve, SOL)} SOL kept)`);
  for (const c of chunks) p(`    #${String(c.index).padStart(2)}  ${fmt(BigInt(c.lamportsIn), SOL).padStart(14)} SOL -> ~${fmt(BigInt(c.quotedOut), D)} H081 (min ${fmt(BigInt(c.minOut), D)}), +${c.executeAfterMinutes} min, not after ${c.notAfter}`);
  p(`  split          ${safetyNote}`);
  p(`  settle         burn ${fmt(burn, D)} H081, top up ${fmt(topUp, D)} H081 (held ${fmt(h081Held, D)} + guaranteed minimum bought ${fmt(minBought, D)})`);
  p('                 any H081 bought above the minimum stays in the treasury and is settled next cycle');
  p(`  side effect    buys pay the pool's normal trading fee, like any buyer`);

  if (!args.propose) {
    p('\nDRY RUN: nothing was built for signing, nothing sent, ledger untouched. Add --propose to write a multisig proposal.');
    return;
  }
  if (!txs.length) { p('\nnothing to propose (no spendable platform fees and no H081 held)'); return; }

  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const ptxs: ProposalTx[] = txs.map((t, i) => {
    const tx = new Transaction({ feePayer: treasury, recentBlockhash: blockhash }).add(...t.ixs);
    const raw = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    if (raw.length > 1232) throw new Error(`transaction "${t.label}" is ${raw.length} bytes, over the 1232-byte limit`);
    return {
      order: i + 1, label: t.label, executeAfterMinutes: t.executeAfterMinutes, ...(t.chunk ? { chunk: t.chunk } : {}),
      instructions: t.ixs.map((ix) => ({ programId: ix.programId.toBase58(), accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(ix.data).toString('base64') })),
      unsignedTxBase58: base58(raw), unsignedTxBase64: Buffer.from(raw).toString('base64'), bytes: raw.length,
    };
  });
  const balances = { solLamports: lamports.toString(), wsolLamports: wsol.toString(), h081: h081Held.toString(), otherTokens };
  const proposal: Proposal = {
    kind: 'h081-flywheel-proposal', version: 2, id: randomUUID(), createdAt: createdAt.toISOString(), cluster, genesis,
    source: 'platform-fees', denyList: DENY_LIST,
    treasury: treasury.toBase58(), feePayer: feePayer.toBase58(), mint: mint.toBase58(), mintDecimals: D, mintTokenProgram: mintProgram.toBase58(), pool: pool.toBase58(),
    poolVaults: { sol: solVault.toBase58(), h081: h081Vault.toBase58() }, safety, split, slippageBps, balances, chunks,
    settle: { h081Held: h081Held.toString(), burn: burn.toString(), topUp: topUp.toString() }, transactions: ptxs,
    howToExecute: [
      'Each entry is one vault transaction for the treasury Squads multisig; the vault is the only signer. Nobody signs alone.',
      'Import unsignedTxBase58 into Squads (or rebuild from "instructions"), check every account, approve with the threshold, execute in order.',
      'Space the buys roughly as executeAfterMinutes suggests. Each chunk\'s minimum output was fixed when this file was built, so right before executing a chunk run: buyback.mts check --proposal <this file> --chunk <n>. Execute it only on GO; on NO-GO (price moved beyond the slippage cap either way, or past notAfter) skip it.',
      'A chunk that is skipped or fails on slippage is simply not executed; then skip the settle too and re-plan.',
      'Execute the settle transaction last. Afterwards run: buyback.mts record --proposal <this file> --sig <each executed signature>.',
    ],
  };
  const out = resolve(args.out ?? `flywheel-proposal-${proposal.createdAt.replace(/[:.]/g, '-')}.json`);
  const body = `${JSON.stringify(proposal, null, 2)}\n`;
  writeFileSync(out, body);
  appendLedger(ledgerPath, {
    id: proposal.id, at: proposal.createdAt, status: 'proposed', cluster, source: 'platform-fees', treasury: proposal.treasury, mint: proposal.mint, pool: proposal.pool,
    split, proposal: { file: out, sha256: sha256Hex(body) }, balances,
    plan: { spendLamports: spend.toString(), chunks: chunks.length, minH081Out: minBought.toString(), burn: burn.toString(), topUp: topUp.toString(), slippageBps },
    firewall: { denyListChecked: DENY_LIST, provenanceScanned: prov.scanned, provenanceCursor: prov.newestSignature ?? cursor ?? null },
  });
  p(`\nPROPOSAL written to ${out} (${ptxs.length} transaction(s), nothing signed, nothing sent)`);
  p(`ledger: appended "proposed" entry ${proposal.id} to ${ledgerPath}`);
}

// ------------------------------------------------------------- record

async function record() {
  if (!args.proposal) throw new Error('record needs --proposal <file>');
  const sigs = args.sig ?? [];
  if (!sigs.length) throw new Error('record needs at least one --sig <signature>');
  const proposal = JSON.parse(readFileSync(resolve(args.proposal), 'utf8')) as Proposal;
  if (proposal.kind !== 'h081-flywheel-proposal' || proposal.version !== 2) throw new Error(`${args.proposal} is not a version 2 flywheel proposal`);
  const { cluster, genesis } = await detectCluster(conn, rpc);
  if (genesis !== proposal.genesis) throw new Error(`proposal was built on ${proposal.cluster}, this RPC is ${cluster}`);
  assertNotDenied(deny, 'treasury', proposal.treasury);
  const ledger = readLedger(ledgerPath);
  if (!ledger.entries.some((e) => e.id === proposal.id && e.status === 'proposed')) throw new Error(`ledger has no "proposed" entry ${proposal.id}`);
  if (ledger.entries.some((e) => e.refersTo === proposal.id && e.status === 'executed')) throw new Error(`proposal ${proposal.id} is already recorded as executed`);

  const treasury = proposal.treasury;
  let solSpent = 0n, bought = 0n, burned = 0n, toppedUp = 0n;
  // Every signature must carry out one not-yet-matched transaction of THIS proposal: all of its instructions
  // (program, accounts in order, data) appear among the confirmed transaction's instructions, outer or inner
  // (inner covers the Squads vault execute). Anything else (an unrelated treasury transaction, another
  // proposal's chunk) is refused, so the public ledger only records what this proposal did.
  const unmatched = new Map(proposal.transactions.map((t) => [t.order, t]));
  const executed: number[] = [];
  const warnings: string[] = [];
  for (const sig of new Set(sigs)) {
    const tx = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    const ptx = await conn.getParsedTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!tx || !ptx) throw new Error(`transaction ${sig} not found (confirmed)`);
    if (tx.meta?.err) throw new Error(`transaction ${sig} failed on chain: ${JSON.stringify(tx.meta.err)}`);
    const keys = txAccountKeys(tx).map((k) => k.toBase58());
    for (const k of keys) assertNotDenied(deny, `account of ${sig}`, k);
    if (!keys.includes(treasury)) throw new Error(`transaction ${sig} does not involve the treasury`);
    const onChain = executedInstructions(tx, keys);
    const match = [...unmatched.values()].find((pt) => pt.instructions.every((pi) => onChain.some((ti) =>
      ti.programId === pi.programId && ti.data === pi.data && ti.accounts.length === pi.accounts.length && ti.accounts.every((a, i) => a === pi.accounts[i].pubkey))));
    if (!match) throw new Error(`transaction ${sig} does not carry out any (not yet recorded) transaction of proposal ${proposal.id}; refusing to record it`);
    unmatched.delete(match.order);
    executed.push(match.order);
    const chunk = match.chunk ? proposal.chunks.find((c) => c.index === match.chunk) : undefined;
    if (chunk && tx.blockTime && tx.blockTime * 1000 > Date.parse(chunk.notAfter)) warnings.push(`chunk ${chunk.index} executed after its notAfter ${chunk.notAfter}`);
    solSpent += tokenDelta(ptx, proposal.poolVaults.sol); // what the pool's SOL vault received = what the buys paid in
    bought += -tokenDelta(ptx, proposal.poolVaults.h081);
    if (proposal.safety) toppedUp += tokenDelta(ptx, proposal.safety.vault);
    burned += burnedIn(ptx, proposal.mint, treasury);
  }
  const settle = proposal.transactions.find((t) => t.label.startsWith('settle'));
  if (settle && unmatched.has(settle.order)) warnings.push('the settle transaction (burn / top-up) is not among the recorded signatures');
  const skipped = [...unmatched.values()].filter((t) => t !== settle).map((t) => t.order);
  if (skipped.length) warnings.push(`proposal transaction(s) ${skipped.join(', ')} not executed (skipped)`);
  appendLedger(ledgerPath, {
    id: randomUUID(), at: new Date().toISOString(), status: 'executed', cluster, source: 'platform-fees', treasury, mint: proposal.mint, pool: proposal.pool,
    split: proposal.split, refersTo: proposal.id,
    result: {
      solSpentLamports: solSpent.toString(), h081Bought: bought.toString(), burned: burned.toString(), toppedUp: toppedUp.toString(), signatures: [...new Set(sigs)],
      executed: executed.sort((a, b) => a - b), ...(warnings.length ? { warnings } : {}),
    },
    firewall: { denyListChecked: DENY_LIST, provenanceScanned: 0, provenanceCursor: null },
  });
  const D = proposal.mintDecimals;
  for (const w of warnings) console.warn(`WARNING: ${w}`);
  console.log(`recorded proposal ${proposal.id}: spent ${fmt(solSpent, SOL)} SOL, bought ${fmt(bought, D)} H081, burned ${fmt(burned, D)}, topped up ${fmt(toppedUp, D)}`);
  console.log(`ledger: appended "executed" entry to ${ledgerPath}`);
}

// ------------------------------------------------------------- check (right before executing a chunk)

async function check() {
  if (!args.proposal) throw new Error('check needs --proposal <file>');
  const proposal = JSON.parse(readFileSync(resolve(args.proposal), 'utf8')) as Proposal;
  if (proposal.kind !== 'h081-flywheel-proposal' || proposal.version !== 2) throw new Error(`${args.proposal} is not a version 2 flywheel proposal`);
  const { cluster, genesis } = await detectCluster(conn, rpc);
  if (genesis !== proposal.genesis) throw new Error(`proposal was built on ${proposal.cluster}, this RPC is ${cluster}`);
  const n = Number(args.chunk);
  const chunk = proposal.chunks.find((c) => c.index === n);
  if (!chunk) throw new Error(`--chunk must be one of 1..${proposal.chunks.length}`);
  const mint = new PublicKey(proposal.mint);
  const ps: PoolState = await new CpAmm(conn).fetchPoolState(new PublicKey(proposal.pool));
  const point = await getCurrentPoint(conn, ps.activationType);
  const live = quoteBuy(ps, point, BigInt(chunk.lamportsIn), mint, proposal.mintDecimals);
  const minOut = BigInt(chunk.minOut);
  const D = proposal.mintDecimals;
  const why: string[] = [];
  if (Date.now() > Date.parse(chunk.notAfter)) why.push(`past notAfter ${chunk.notAfter}`);
  if (live < minOut) why.push(`the live quote ${fmt(live, D)} H081 is below the minimum ${fmt(minOut, D)}: the swap would fail; skip this chunk`);
  // Stale when what a sandwich could take (live - minOut) is over the slippage cap of the live quote; 1 bps of
  // tolerance absorbs the rounding of the chained plan-time quotes.
  if ((live - minOut) * 10_000n > live * BigInt(proposal.slippageBps + 1)) why.push(`the frozen minimum ${fmt(minOut, D)} H081 is more than ${proposal.slippageBps / 100}% below the live quote ${fmt(live, D)}: it no longer protects the trade; re-plan`);
  console.log(`chunk ${chunk.index}/${proposal.chunks.length}: ${fmt(BigInt(chunk.lamportsIn), SOL)} SOL, live quote ${fmt(live, D)} H081, planned ${fmt(BigInt(chunk.quotedOut), D)}, minimum ${fmt(minOut, D)}`);
  if (why.length) {
    console.log(`NO-GO: ${why.join('; ')}`);
    process.exitCode = 2;
  } else {
    console.log('GO: execute this chunk now');
  }
}

/** H081 out for `lamportsIn` SOL into the H081/SOL pool at its current state (0 for 0). */
function quoteBuy(ps: PoolState, point: BN, lamportsIn: bigint, mint: PublicKey, mintDecimals: number): bigint {
  if (lamportsIn === 0n) return 0n;
  const mintIsA = ps.tokenAMint.equals(mint);
  if (!(mintIsA ? ps.tokenBMint.equals(NATIVE_MINT) : ps.tokenAMint.equals(NATIVE_MINT) && ps.tokenBMint.equals(mint))) throw new Error(`pool is not ${mint.toBase58()}/SOL`);
  const [decA, decB] = mintIsA ? [mintDecimals, SOL] : [SOL, mintDecimals];
  return BigInt(swapQuoteExactInput(ps, point, new BN(lamportsIn.toString()), 0, !mintIsA, false, decA, decB).outputAmount.toString());
}

/** Every instruction a confirmed transaction executed, outer and inner, with account keys resolved. */
function executedInstructions(tx: VersionedTransactionResponse, keys: string[]): { programId: string; accounts: string[]; data: string }[] {
  const out = tx.transaction.message.compiledInstructions.map((ix) => ({
    programId: keys[ix.programIdIndex], accounts: ix.accountKeyIndexes.map((i) => keys[i]), data: Buffer.from(ix.data).toString('base64'),
  }));
  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions) {
      out.push({ programId: keys[ix.programIdIndex], accounts: ix.accounts.map((i) => keys[i]), data: Buffer.from(base58Decode(ix.data)).toString('base64') });
    }
  }
  return out;
}

/** Change of a token account's balance in one transaction (0 if it is not in the transaction). */
function tokenDelta(tx: ParsedTransactionWithMeta, account: string): bigint {
  const idx = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey.toBase58() === account);
  if (idx < 0) return 0n;
  const amt = (list: TokenBalance[] | null | undefined) => BigInt(list?.find((b) => b.accountIndex === idx)?.uiTokenAmount.amount ?? '0');
  return amt(tx.meta?.postTokenBalances) - amt(tx.meta?.preTokenBalances);
}

/** H081 burned by the treasury in one transaction (outer and inner instructions). */
function burnedIn(tx: ParsedTransactionWithMeta, mint: string, authority: string): bigint {
  const all = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions)];
  let sum = 0n;
  for (const ix of all) {
    if (!('parsed' in ix) || typeof ix.parsed !== 'object' || !ix.parsed) continue;
    const { type, info } = ix.parsed as { type: string; info: Record<string, unknown> };
    if ((type !== 'burn' && type !== 'burnChecked') || info.mint !== mint || info.authority !== authority) continue;
    sum += BigInt((info.tokenAmount as { amount: string } | undefined)?.amount ?? (info.amount as string));
  }
  return sum;
}
