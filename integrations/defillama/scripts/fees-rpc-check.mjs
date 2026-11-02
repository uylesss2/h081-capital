#!/usr/bin/env node
// Independent cross-check of the DefiLlama fees adapter (fees/h081.ts), with no dependencies and no
// API key: sums the USDG that reached the treasury's USDG token account per UTC day straight from
// mainnet transactions, excluding transfers sent or signed by the team's wallets, exactly like the
// adapter's Allium query (to_address = treasury USDG ATA, mint = USDG, from_address NOT IN team wallets
// + relayer hot wallet, signer NOT IN team wallets). Keep the two lists below equal to fees/h081.ts.
//
// Read-only JSON-RPC (getSignaturesForAddress + getTransaction); nothing is signed or sent.
//   node integrations/defillama/scripts/fees-rpc-check.mjs [from YYYY-MM-DD] [to YYYY-MM-DD]
// Env: SOLANA_RPC (default https://api.mainnet-beta.solana.com)

const TREASURY_USDG_ATA = 'DxpmCZYAoDKpHmA5vWuopUrf3UVuGnPvditVrN9xDwDo';
const TREASURY = 'EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq';
const USDG = '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH';
const DECIMALS = 6;
// = INTERNAL in fees/h081.ts (blacklist_signers)
const DENY_SIGNERS = new Set([
  TREASURY,
  TREASURY_USDG_ATA,
  '5WCpirBe1wHUk6PL2nU97pj87PtyaqH9S6UJUbd5z2W1', // deployer / upgrade authority
  '4eySgHKMNGMpWtbtpfxfSyJZK8LGYxEZLzJwHXCsoPX2', // config authority
  'G3xFLKe6An28bgdtUuyaoZCpjtPpQTh3GgKNKtWG26A6', // treasury multisig
  '4ir9vPVqWZ28ja6eTZs75LqBduhL1R8AQ9irxBu16kAd', // multisig create key
  '3QxDPawgSmdPsvNa1xfsHuuF7cXWBaoBhPHgQgoBpnfi', // member 1
  '3TGGDFAtipTMSpkmSEfm1CTcREQYdTkzWhzdVCzLLa7N', // member 2
  '7815bY95r1E5FifAZMf5rM5Vjrper67BBY1wS8m216i1', // member 3
]);
// = BLACKLIST_FROM in fees/h081.ts (blacklists): the signers plus the relayer hot wallet, which signs
// the fee-paying relays (so it is not a denied signer) but never holds protocol fees.
const DENY_FROM = new Set([...DENY_SIGNERS, 'DWp7dJ6QZxqtUDhMy7JB6UJru47J94bQSJNEdG4QrjjA']);

const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const [fromArg, toArg] = process.argv.slice(2);
const from = Math.floor(Date.parse(`${fromArg || '2026-10-31'}T00:00:00Z`) / 1000);
const to = toArg ? Math.floor(Date.parse(`${toArg}T00:00:00Z`) / 1000) + 86400 : Math.floor(Date.now() / 1000);
if (!Number.isFinite(from) || !Number.isFinite(to)) { console.error('usage: fees-rpc-check.mjs [from YYYY-MM-DD] [to YYYY-MM-DD]'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(method, params, attempt = 0) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (r.status === 429 && attempt < 6) { await sleep(1500 * (attempt + 1)); return rpc(method, params, attempt + 1); }
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function allSignatures(address) {
  const out = [];
  let before;
  for (;;) {
    const page = await rpc('getSignaturesForAddress', [address, { limit: 1000, before, commitment: 'confirmed' }]);
    out.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
    await sleep(200);
  }
  return out;
}

function day(ts) { return new Date(ts * 1000).toISOString().slice(0, 10); }

async function main() {
  console.log(`RPC ${RPC}; window ${day(from)} .. ${day(to - 1)} (UTC); account ${TREASURY_USDG_ATA} (owner ${TREASURY}, mint ${USDG})`);
  const sigs = await allSignatures(TREASURY_USDG_ATA);
  console.log(`${sigs.length} signature(s) touch the account in total`);
  const perDay = new Map();
  let inWindow = 0, excluded = 0, failed = 0;
  for (const s of sigs) {
    if (s.blockTime == null || s.blockTime < from || s.blockTime >= to) continue;
    inWindow++;
    if (s.err) { failed++; continue; }
    const tx = await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
    await sleep(150);
    if (!tx || tx.meta?.err) { failed++; continue; }
    const keys = tx.transaction.message.accountKeys;
    const signers = keys.filter((k) => k.signer).map((k) => k.pubkey);
    const idx = keys.findIndex((k) => k.pubkey === TREASURY_USDG_ATA);
    const bal = (list) => BigInt((list || []).find((b) => b.accountIndex === idx && b.mint === USDG)?.uiTokenAmount?.amount ?? '0');
    const delta = bal(tx.meta.postTokenBalances) - bal(tx.meta.preTokenBalances);
    const d = day(s.blockTime);
    // sender = address and owner of every USDG account whose balance went down in this transaction
    const pre = new Map((tx.meta.preTokenBalances || []).filter((b) => b.mint === USDG).map((b) => [b.accountIndex, b]));
    const senders = [];
    for (const b of tx.meta.postTokenBalances || []) {
      if (b.mint !== USDG || b.accountIndex === idx) continue;
      const before = BigInt(pre.get(b.accountIndex)?.uiTokenAmount?.amount ?? '0');
      if (BigInt(b.uiTokenAmount.amount) < before) senders.push(keys[b.accountIndex].pubkey, b.owner);
    }
    const deniedSigner = signers.some((x) => DENY_SIGNERS.has(x));
    const deniedFrom = senders.some((x) => DENY_FROM.has(x));
    const why = deniedSigner ? ' (EXCLUDED: team signer)' : deniedFrom ? ' (EXCLUDED: team sender)' : '';
    console.log(`${d} ${s.signature} delta=${fmt(delta)} USDG signers=${signers.join(',')} from=${[...new Set(senders)].join(',') || '-'}${why}`);
    if (deniedSigner || deniedFrom) { excluded++; continue; }
    if (delta > 0n) perDay.set(d, (perDay.get(d) ?? 0n) + delta);
  }
  console.log('');
  for (let t = from; t < to; t += 86400) {
    const d = day(t);
    console.log(`${d}  dailyFees = ${fmt(perDay.get(d) ?? 0n)} USDG`);
  }
  console.log(`\n${inWindow} tx in window, ${excluded} excluded (team signer or sender), ${failed} failed/skipped`);
}

function fmt(v) {
  const neg = v < 0n; if (neg) v = -v;
  const s = v.toString().padStart(DECIMALS + 1, '0');
  return `${neg ? '-' : ''}${s.slice(0, -DECIMALS)}.${s.slice(-DECIMALS)}`;
}

main().catch((e) => { console.error(e); process.exit(1); });
