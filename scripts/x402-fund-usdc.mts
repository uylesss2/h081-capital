// Swaps a little SOL from a keypair into USDC on Solana mainnet through Jupiter's public Swap API, so the wallet can
// hold USDC for x402 payments. Dry run by default: quote, build, simulate, print. `--send` signs and sends.
//
//   node node_modules/tsx/dist/cli.mjs scripts/x402-fund-usdc.mts --payer solana/keys/mainnet/deployer-keypair.json \
//     [--lamports 10000000] [--rpc URL] [--slippage-bps 100] [--max-priority-lamports 200000] [--api-key KEY] [--send]
//
// Endpoints (Jupiter Swap API V1 "Metis", https://developers.jup.ag/docs/swap/v1/get-quote):
//   GET  https://api.jup.ag/swap/v1/quote   POST https://api.jup.ag/swap/v1/swap
// No API key is needed (keyless traffic is limited to 0.5 requests/s, so the two calls are spaced out and 429s are
// retried). A free key from https://portal.jup.ag raises the limit: pass --api-key or set JUPITER_API_KEY; it is sent
// as the `x-api-key` header. `--api-base` overrides the host (e.g. https://lite-api.jup.ag/swap/v1).
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const LAUNCH_WALLET_DENYLIST = new Set([
  '2wjxKzH7fVGpjcA9KpjDBDHjSAhz7u8ZgMLnVPVGSkDP', 'FZEMfMN7hhQcKPHRt2kb9ig5XArMvK5LqfSTXpQ1j4DZ', '5XJNtM7a9ocRL8f8vsyNVmQoekutCFJkGNXNQbkJP4bw',
]);
const TOKEN_ACCOUNT_SIZE = 165;

interface QuoteResponse {
  inputMint: string; inAmount: string; outputMint: string; outAmount: string; otherAmountThreshold: string;
  swapMode: string; slippageBps: number; priceImpactPct: string; swapUsdValue?: string; contextSlot?: number;
  routePlan: { swapInfo: { ammKey: string; label?: string; inputMint: string; outputMint: string; inAmount: string; outAmount: string }; percent?: number | null; bps?: number | null }[];
}
interface SwapResponse {
  swapTransaction: string; lastValidBlockHeight: number; prioritizationFeeLamports?: number; computeUnitLimit?: number;
  prioritizationType?: { computeBudget?: { microLamports: number; estimatedMicroLamports?: number } }; simulationError?: unknown;
}

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const uint = (k: string, d: string) => {
  const v = arg(k, d)!;
  if (!/^\d+$/.test(v)) throw new Error(`${k} must be a non-negative integer, got ${JSON.stringify(v)}`);
  return Number(v);
};
const payerPath = arg('--payer') ?? (() => { throw new Error('--payer <keypair.json> is required'); })();
const lamports = uint('--lamports', '10000000');
if (lamports === 0) throw new Error('--lamports must be > 0');
const slippageBps = uint('--slippage-bps', '100');
const maxPriorityLamports = uint('--max-priority-lamports', '200000');
const rpcUrl = arg('--rpc', 'https://api.mainnet-beta.solana.com')!;
const apiBase = (arg('--api-base', 'https://api.jup.ag/swap/v1')!).replace(/\/+$/, '');
const apiKey = arg('--api-key') ?? process.env.JUPITER_API_KEY;
const send = process.argv.includes('--send');

const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(payerPath, 'utf8'))));
if (LAUNCH_WALLET_DENYLIST.has(payer.publicKey.toBase58())) throw new Error(`refusing: ${payer.publicKey.toBase58()} is a launch wallet`);
const conn = new Connection(rpcUrl, 'confirmed');
const sol = (l: number) => `${(l / LAMPORTS_PER_SOL).toFixed(9).replace(/0+$/, '').replace(/\.$/, '')} SOL`;
const usdc = (raw: string | number) => `${(Number(raw) / 1e6).toFixed(6)} USDC`;

// Jupiter fetch with 429 back-off (keyless limit is 0.5 rps; one retry window covers the quote -> swap gap too).
const jup = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const headers: Record<string, string> = { accept: 'application/json', ...(init?.headers as Record<string, string> | undefined) };
  if (apiKey) headers['x-api-key'] = apiKey;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${apiBase}${path}`, { ...init, headers });
    if (res.status === 429 && attempt < 4) {
      const wait = Math.max(Number(res.headers.get('retry-after') ?? 0) * 1000, 2500);
      console.log(`  jupiter rate-limited (429); retrying in ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`jupiter ${init?.method ?? 'GET'} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text) as T;
  }
};

console.log(`${send ? 'SEND' : 'DRY RUN'}: swap ${sol(lamports)} -> USDC via Jupiter (${apiBase}${apiKey ? ', with api key' : ', no api key'})`);
console.log(`payer ${payer.publicKey.toBase58()}\nrpc ${rpcUrl}`);

const ata = getAssociatedTokenAddressSync(USDC_MINT, payer.publicKey);
const [balance, ataInfo, ataRent, wsolRent] = await Promise.all([
  conn.getBalance(payer.publicKey, 'confirmed'),
  conn.getAccountInfo(ata, 'confirmed'),
  conn.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE, 'confirmed'),
  conn.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE, 'confirmed'),
]);
const usdcBefore = ataInfo ? (await conn.getTokenAccountBalance(ata, 'confirmed')).value.amount : '0';
console.log(`USDC ATA ${ata.toBase58()} (${ataInfo ? `exists, ${usdc(usdcBefore)}` : `will be created, rent ${sol(ataRent)}`})`);
console.log(`payer balance ${sol(balance)}`);

// 1. quote
const q = new URLSearchParams({
  inputMint: SOL_MINT, outputMint: USDC_MINT.toBase58(), amount: String(lamports), slippageBps: String(slippageBps),
  swapMode: 'ExactIn', restrictIntermediateTokens: 'true',
});
const quote = await jup<QuoteResponse>(`/quote?${q}`);
const routes = quote.routePlan.map((r) => {
  const share = r.percent ?? (r.bps != null ? r.bps / 100 : undefined);
  return `${r.swapInfo.label ?? r.swapInfo.ammKey}${share !== undefined ? ` ${share}%` : ''}`;
}).join(' -> ');
console.log(`\nquote (${quote.swapMode}, slot ${quote.contextSlot ?? '?'})`);
console.log(`  in        ${quote.inAmount} lamports = ${sol(Number(quote.inAmount))}`);
console.log(`  out       ${quote.outAmount} = ${usdc(quote.outAmount)}${quote.swapUsdValue ? ` (~$${Number(quote.swapUsdValue).toFixed(4)})` : ''}`);
console.log(`  min out   ${quote.otherAmountThreshold} = ${usdc(quote.otherAmountThreshold)} (slippage ${quote.slippageBps} bps)`);
console.log(`  impact    ${quote.priceImpactPct}%`);
console.log(`  route     ${routes}`);
console.log(`  price     1 SOL = ${(Number(quote.outAmount) / 1e6 / (Number(quote.inAmount) / LAMPORTS_PER_SOL)).toFixed(4)} USDC`);

// 2. build the swap transaction
if (!apiKey) await sleep(2100); // keyless limit: 0.5 rps
const swap = await jup<SwapResponse>('/swap', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    quoteResponse: quote,
    userPublicKey: payer.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: { priorityLevelWithMaxLamports: { priorityLevel: 'medium', maxLamports: maxPriorityLamports } },
  }),
});
if (swap.simulationError) throw new Error(`jupiter reported a simulation error: ${JSON.stringify(swap.simulationError)}`);
const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
const priorityFee = swap.prioritizationFeeLamports ?? 0;
const sigFee = 5000 * tx.message.header.numRequiredSignatures;
// getFeeForMessage already includes the compute-budget priority fee; fall back to signature + priority if the RPC has no answer.
const totalFee = (await conn.getFeeForMessage(tx.message, 'confirmed')).value ?? sigFee + priorityFee;
const needed = lamports + totalFee + (ataInfo ? 0 : ataRent) + wsolRent; // wSOL rent comes back on unwrap
console.log(`\nswap transaction (v${tx.version}, ${tx.message.compiledInstructions.length} ixs, ${tx.message.addressTableLookups.length} ALT lookups, valid to block height ${swap.lastValidBlockHeight})`);
console.log(`  signature fee   ${sol(sigFee)}`);
console.log(`  priority fee    ${sol(priorityFee)}${swap.prioritizationType?.computeBudget ? ` (${swap.prioritizationType.computeBudget.microLamports} µlamports/CU, est. ${swap.prioritizationType.computeBudget.estimatedMicroLamports ?? '?'})` : ''}${swap.computeUnitLimit ? `, CU limit ${swap.computeUnitLimit}` : ''}`);
console.log(`  total tx fee    ${sol(totalFee)} (RPC getFeeForMessage)`);
console.log(`  ATA rent        ${ataInfo ? '0 SOL (exists)' : sol(ataRent)}`);
console.log(`  wSOL temp rent  ${sol(wsolRent)} (refunded on unwrap)`);
console.log(`  total debit     ~${sol(needed - wsolRent)} (peak ${sol(needed)} during the tx); balance after ~${sol(balance - (needed - wsolRent))}`);
if (balance < needed) throw new Error(`insufficient balance: have ${sol(balance)}, need ~${sol(needed)}`);

// 3. simulate on our RPC (unsigned: skip signature verification)
const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
if (sim.value.err) {
  console.error('simulation failed', JSON.stringify(sim.value.err));
  for (const l of sim.value.logs ?? []) console.error('  ' + l);
  process.exit(1);
}
console.log(`\nsimulation ok (${sim.value.unitsConsumed ?? '?'} CU)`);
if (!send) { console.log('dry run; pass --send to sign and send'); process.exit(0); }

// 4. sign, send, confirm
tx.sign([payer]);
const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
console.log(`sent ${signature}\nhttps://solscan.io/tx/${signature}`);
const blockhash = tx.message.recentBlockhash;
const conf = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight: swap.lastValidBlockHeight }, 'confirmed');
if (conf.value.err) { console.error('transaction failed on-chain', JSON.stringify(conf.value.err)); process.exit(1); }
const after = await conn.getTokenAccountBalance(ata, 'confirmed');
console.log(`confirmed; USDC balance ${usdc(after.value.amount)} (${ata.toBase58()}); SOL balance ${sol(await conn.getBalance(payer.publicKey, 'confirmed'))}`);
