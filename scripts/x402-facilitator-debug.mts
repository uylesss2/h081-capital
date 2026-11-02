// Read-only diagnostics against the CDP x402 facilitator with the operator's key: prints the Solana entries of
// GET /supported (which assets / fee payer the facilitator accepts), and with --verify <payload.json> runs a verify
// (no settlement) and prints the full verdict. Credentials from CDP_API_KEY_ID / CDP_API_KEY_SECRET; never printed.
import { readFileSync } from 'node:fs';
import { CdpFacilitator } from '../relayer/x402/facilitator.js';

const id = process.env.CDP_API_KEY_ID, secret = process.env.CDP_API_KEY_SECRET;
if (!id || !secret) throw new Error('CDP_API_KEY_ID and CDP_API_KEY_SECRET are required');
const fac = new CdpFacilitator({ apiKeyId: id, apiKeySecret: secret });

const sup = await fac.supported() as any;
const kinds = (sup.kinds ?? []).filter((k: any) => String(k.network).startsWith('solana'));
console.log('supported (solana):', JSON.stringify(kinds, null, 1));
for (const [k, v] of Object.entries(sup)) if (k !== 'kinds' && k !== 'signers') console.log(`supported.${k}:`, JSON.stringify(v).slice(0, 600));
for (const [k, v] of Object.entries((sup.signers ?? {}) as Record<string, unknown>)) if (k.startsWith('solana')) console.log(`supported.signers[${k}]:`, JSON.stringify(v));

const i = process.argv.indexOf('--verify');
if (i >= 0) {
  const { paymentPayload, paymentRequirements } = JSON.parse(readFileSync(process.argv[i + 1], 'utf8'));
  const v = await fac.verify(paymentPayload, paymentRequirements);
  console.log('verify:', JSON.stringify(v, null, 1));
}
