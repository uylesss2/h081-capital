// x402 v2 payment client for the relayer's paid routes (scheme `exact`, Solana mainnet, SPL / Token-2022 asset).
// Uses the official @x402 packages to build the PAYMENT-SIGNATURE header exactly as a wallet would:
//   @x402/core (x402Client + HTTP header codec) and @x402/svm (ExactSvmScheme: partially signed v0 transaction with
//   ComputeBudget limit + price, TransferChecked of `amount` from the payer's ATA to ATA(payTo, asset), a Memo nonce;
//   fee payer = accepts[].extra.feePayer, signed only by the payer).
//
//   node node_modules/tsx/dist/cli.mjs scripts/x402-pay.mts --dry-run --payer solana/keys/mainnet/deployer-keypair.json
//   node node_modules/tsx/dist/cli.mjs scripts/x402-pay.mts --payer <keypair.json> [--url URL] [--method GET|POST] [--body '{...}']
//                                                            [--rpc URL] [--asset MINT] [--dry-run]
//
// --dry-run fetches the 402, builds and signs the payload (two read-only RPC calls: mint + blockhash), prints it decoded
// and exits WITHOUT sending the paid request; nothing is broadcast to Solana (the facilitator does that on settle).
//
// Not in package.json: install once before running:
//   npm install --no-save --no-audit --no-fund @x402/fetch@2.29.0 @x402/svm@2.29.0 @x402/core@2.29.0
// (that pulls in @solana/kit, which ExactSvmScheme needs for the signer; @x402/fetch is unused here but pinned alongside)
import { readFileSync } from 'node:fs';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { ExactSvmScheme } from '@x402/svm/exact/client';

const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const USDG = '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const url = arg('--url', 'https://api.h081.xyz/v1/x402/loans/market')!;
const method = (arg('--method', 'GET')!).toUpperCase();
if (method !== 'GET' && method !== 'POST') throw new Error('--method must be GET or POST');
const body = arg('--body');
const rpcUrl = arg('--rpc', 'https://api.mainnet-beta.solana.com')!;
const asset = arg('--asset', USDG)!;
const dryRun = process.argv.includes('--dry-run');
const payerPath = arg('--payer') ?? (() => { throw new Error('--payer <keypair.json> is required'); })();
if (body !== undefined) JSON.parse(body); // fail early on a malformed body

const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(payerPath, 'utf8'))));
const payer = new PublicKey(signer.address);
console.log(`payer ${payer.toBase58()}\n${method} ${url}${body !== undefined ? `\nbody ${body}` : ''}`);

// 1. unpaid request -> 402 with PAYMENT-REQUIRED (base64 JSON, x402 v2; the body carries the same JSON)
const init = (): RequestInit => ({
  method,
  headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
  body,
});
const first = await fetch(url, init());
if (first.status !== 402) {
  console.log(`expected 402, got ${first.status}; body: ${(await first.text()).slice(0, 2000)}`);
  process.exit(first.ok ? 0 : 1);
}
const http = new x402HTTPClient(new x402Client().register('solana:*', new ExactSvmScheme(signer, { rpcUrl })));
const firstBody: unknown = await first.json().catch(() => undefined);
const required: PaymentRequired = http.getPaymentRequiredResponse((n) => first.headers.get(n), firstBody);
const chosen = required.accepts.find((a) => a.scheme === 'exact' && a.network === SOLANA_MAINNET && a.asset === asset);
if (!chosen) {
  console.error(`no accepts entry for scheme=exact network=${SOLANA_MAINNET} asset=${asset}; offered:`);
  console.error(JSON.stringify(required.accepts, null, 2));
  process.exit(1);
}
const feePayer = chosen.extra?.feePayer;
if (typeof feePayer !== 'string') throw new Error('accepts entry has no extra.feePayer');
console.log(`402: x402Version=${required.x402Version} resource=${required.resource?.url}`);
console.log(`     error="${required.error ?? ''}" extensions=[${Object.keys(required.extensions ?? {}).join(', ')}]`);
console.log(`accepted: amount=${chosen.amount} asset=${chosen.asset} payTo=${chosen.payTo} feePayer=${feePayer} maxTimeoutSeconds=${chosen.maxTimeoutSeconds}`);

// 2. payment payload per the official client: core wraps the scheme's partial payload with resource/accepted/extensions
const narrowed: PaymentRequired = { ...required, accepts: [chosen] };
const payload: PaymentPayload = await http.createPaymentPayload(narrowed);
const header = http.encodePaymentSignatureHeader(payload); // { 'PAYMENT-SIGNATURE': base64(JSON) }
describePayload(payload, chosen, payer, header);
{
  // --dump <file>: write the verify/settle request body ({ paymentPayload, paymentRequirements }) for diagnostics
  const d = process.argv.indexOf('--dump');
  if (d >= 0) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.argv[d + 1], JSON.stringify({ paymentPayload: payload, paymentRequirements: chosen }, null, 1));
    console.log(`dumped verify body to ${process.argv[d + 1]}`);
  }
}

if (dryRun) {
  console.log('\ndry run: paid request NOT sent (nothing signed by the fee payer, nothing broadcast)');
  process.exit(0);
}

// 3. paid request
const paid = await fetch(url, { ...init(), headers: { ...(init().headers as Record<string, string> | undefined), ...header } });
const paidText = await paid.text();
console.log(`\npaid request: HTTP ${paid.status}`);
const responseHeader = paid.headers.get('PAYMENT-RESPONSE');
if (responseHeader) {
  const settle = http.getPaymentSettleResponse((n) => paid.headers.get(n));
  console.log(`PAYMENT-RESPONSE: success=${settle.success} transaction=${settle.transaction} network=${settle.network}`
    + `${settle.errorReason ? ` errorReason=${settle.errorReason}` : ''}${settle.errorMessage ? ` errorMessage=${settle.errorMessage}` : ''}`
    + `${settle.payer ? ` payer=${settle.payer}` : ''}`);
} else {
  console.log('no PAYMENT-RESPONSE header');
}
try { console.log(JSON.stringify(JSON.parse(paidText), null, 2)); } catch { console.log(paidText.slice(0, 4000)); }
process.exit(paid.ok ? 0 : 1);

function describePayload(p: PaymentPayload, req: PaymentRequirements, payerKey: PublicKey, hdr: Record<string, string>) {
  const headerValue = hdr['PAYMENT-SIGNATURE'];
  if (!headerValue) throw new Error('encodePaymentSignatureHeader did not return PAYMENT-SIGNATURE');
  const txB64 = p.payload.transaction;
  if (typeof txB64 !== 'string') throw new Error('payload.transaction missing');
  const raw = Buffer.from(txB64, 'base64');
  const tx = VersionedTransaction.deserialize(raw);
  const msg = tx.message;
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  const signed = tx.signatures.map((s, i) => ({ key: keys[i], signed: s.some((b) => b !== 0) }));

  console.log('\nPaymentPayload (decoded PAYMENT-SIGNATURE header):');
  console.log(`  x402Version ${p.x402Version}`);
  console.log(`  resource    ${JSON.stringify(p.resource)}`);
  console.log(`  accepted    ${JSON.stringify(p.accepted)}`);
  console.log(`  extensions  ${p.extensions ? Object.keys(p.extensions).join(', ') + (deepEqual(p.extensions, required.extensions) ? ' (echo of the 402 extensions)' : ' (DIFFERS from the 402 extensions)') : 'none'}`);
  console.log(`  header size ${headerValue.length} chars; transaction ${raw.length} bytes base64=${txB64.length} chars, version ${msg.version}`);
  console.log(`  fee payer   ${keys[0]}${keys[0] === req.extra?.feePayer ? ' (= extra.feePayer)' : ' (MISMATCH vs extra.feePayer)'}`);
  console.log(`  blockhash   ${msg.recentBlockhash}`);
  console.log(`  signers     ${signed.map((s) => `${s.key}:${s.signed ? 'signed' : 'unsigned'}`).join('  ')}`);
  if (msg.addressTableLookups.length) console.log(`  ALTs        ${msg.addressTableLookups.length} (unexpected)`);

  let transferSeen = false;
  msg.compiledInstructions.forEach((ix, i) => {
    const program = keys[ix.programIdIndex];
    const data = Buffer.from(ix.data);
    const accounts = ix.accountKeyIndexes.map((a) => keys[a]);
    if (program === COMPUTE_BUDGET) {
      if (data[0] === 2) console.log(`  ix${i} ComputeBudget.setComputeUnitLimit units=${data.readUInt32LE(1)}`);
      else if (data[0] === 3) console.log(`  ix${i} ComputeBudget.setComputeUnitPrice microLamports=${data.readBigUInt64LE(1)}`);
      else console.log(`  ix${i} ComputeBudget tag=${data[0]}`);
    } else if ((program === TOKEN_2022_PROGRAM_ID.toBase58() || program === TOKEN_PROGRAM_ID.toBase58()) && data[0] === 12) {
      transferSeen = true;
      const amount = data.readBigUInt64LE(1);
      const decimals = data[9];
      const [source, mint, destination, authority] = accounts;
      const tokenProgram = new PublicKey(program);
      const expectedSource = getAssociatedTokenAddressSync(new PublicKey(req.asset), payerKey, false, tokenProgram).toBase58();
      const expectedDest = getAssociatedTokenAddressSync(new PublicKey(req.asset), new PublicKey(req.payTo), true, tokenProgram).toBase58();
      const check = (ok: boolean) => (ok ? 'ok' : 'MISMATCH');
      console.log(`  ix${i} TransferChecked via ${program === TOKEN_2022_PROGRAM_ID.toBase58() ? 'Token-2022' : 'Token'}`);
      console.log(`       amount      ${amount} (${check(amount === BigInt(req.amount))} vs accepted.amount ${req.amount}) decimals=${decimals}`);
      console.log(`       source      ${source} (${check(source === expectedSource)}: ATA(payer, asset))`);
      console.log(`       mint        ${mint} (${check(mint === req.asset)})`);
      console.log(`       destination ${destination} (${check(destination === expectedDest)}: ATA(payTo, asset) = ${expectedDest})`);
      console.log(`       authority   ${authority} (${check(authority === payerKey.toBase58())}: payer)`);
    } else if (program === MEMO) {
      console.log(`  ix${i} Memo "${data.toString('utf8')}"`);
    } else {
      console.log(`  ix${i} program=${program} data=${data.toString('hex')} accounts=${accounts.join(',')}`);
    }
  });
  if (!transferSeen) throw new Error('no TransferChecked instruction found in the payment transaction');
  const payerSig = signed.find((s) => s.key === payerKey.toBase58());
  if (!payerSig?.signed) throw new Error('payer signature missing');
  if (signed[0]?.signed) throw new Error('fee payer slot unexpectedly signed');
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
