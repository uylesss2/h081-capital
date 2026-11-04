# Relayer (MVP)

A small HTTP service that submits operations the SDK already produces, so the wallet that proves an
operation does not have to pay gas or reveal its own address. The relayer is paid in the asset: the fee
and the relayer's address are bound into the proof (`extDataHash`), so the relayer can only choose to
submit or not; it cannot change the fee or the destination.

**Status: MVP, hosted for mainnet** as the Vercel project `h081-relayer` (serverless, `relayer/vercel.ts`; bundle with
`node scripts/relayer-vercel.mjs`, then `vercel deploy --prod` in `deploy/relayer-vercel/`), served at `https://api.h081.xyz` (the old
`https://h081-relayer.vercel.app` alias still answers). Hot wallet
`DWp7dJ6QZxqtUDhMy7JB6UJru47J94bQSJNEdG4QrjjA` (pays transaction fees only); fees go to the treasury
`EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq`; minimum fee 0.05 USDG, 0.20% above that; capacity_stake on.
Unit tests (`npm run test:relayer`) and the localnet suites; not load-tested, not audited yet. The x402 paid
endpoints (below) are in the code and tested with a mocked facilitator; they are off until the owner sets the
CDP credentials (`docs/X402-SELLER.md`).

## Run

```
npm run relayer        # tsx relayer/main.ts
```

Configuration comes from environment variables set by the operator (nothing reads a `.env` file):

| Variable | Meaning |
| --- | --- |
| `RELAYER_HOST`, `RELAYER_PORT` | listen address (default `127.0.0.1:8787`) |
| `RELAYER_RATE_PER_MIN`, `RELAYER_BURST` | token-bucket rate limit per client (default 30/min, burst 10) |
| `RELAYER_TRUST_PROXY` | `1` to key the rate limit on the first `X-Forwarded-For` hop |
| `RELAYER_CORS_ORIGINS` | comma-separated browser origins allowed to call the API (e.g. `https://www.h081.xyz`); default none |
| `RELAYER_ALLOW_UNPAID` | `1` to also relay operations that pay no fee (grant, delegate, shielded transfer) |
| `RELAYER_SOLANA_RPC` | enables Solana relaying |
| `RELAYER_SOLANA_KEYPAIR` | path to the relayer's keypair JSON (pays transaction fees; relay fees go to the treasury, not here) |
| `RELAYER_SOLANA_KEYPAIR_JSON` | the keypair JSON itself, instead of a path (serverless hosts); set exactly one of the two |
| `RELAYER_SOLANA_TREASURY` | required: owner of the fee token accounts (the platform treasury multisig vault); never an H081 launch wallet |
| `RELAYER_FEE_BPS` | platform fee on the public amount (withdrawal, or a spend's public amount plus lender share), basis points (default 20 = 0.20%); the fee is max(minimum, this) |
| `RELAYER_SOLANA_PROGRAM_ID` | stipend_pool program id (default: the localnet id) |
| `RELAYER_SOLANA_MIN_FEES` | `mint=amount,...` minimum fee per mint, base units |
| `RELAYER_SOLANA_LOOKUP_TABLES` | comma-separated lookup tables to build v0 transactions against |
| `RELAYER_SOLANA_MIN_LAMPORTS`, `RELAYER_SOLANA_MAX_IN_FLIGHT` | refuse when underfunded / busy |
| `RELAYER_SOLANA_CAPACITY_MINT` | enables capacity_stake enforcement for this staked mint (H081) |
| `RELAYER_SOLANA_CAPACITY_ASSETS` | required with the above: comma-separated 6-decimal (USDG) mints whose amounts count against capacity (other decimals are refused at startup) |
| `RELAYER_SOLANA_CAPACITY_FREE_TIER`, `RELAYER_SOLANA_CAPACITY_PROGRAM_ID` | anonymous free tier in base units (default 100 USDG); capacity_stake program id (default: localnet id; required, and never the localnet id, when `RELAYER_SOLANA_PROGRAM_ID` is set) |
| `RELAYER_EVM_RPC`, `RELAYER_EVM_POOL`, `RELAYER_EVM_KEY` | enables EVM relaying (key: 0x hex) |
| `RELAYER_EVM_MIN_FEES` | `asset=amount,...` minimum fee per ERC-20 |
| `RELAYER_EVM_MAX_GAS` | refuse calls estimated above this (default 8,000,000) |

x402 paid endpoints (settled through Coinbase's CDP facilitator; off unless both CDP variables are set, in
which case Solana relaying must be configured):

| Variable | Meaning |
| --- | --- |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | the CDP Secret API Key (id, and the base64 Ed25519 secret or an EC PEM); both enable the seller, exactly one is a configuration error, none disables it (paid routes answer 503 `x402_disabled`) |
| `RELAYER_X402_FACILITATOR_URL` | default `https://api.cdp.coinbase.com/platform/v2/x402` |
| `RELAYER_X402_FACILITATOR_TIMEOUT_MS` | per facilitator call (default 30000) |
| `RELAYER_X402_NETWORK` | CAIP-2 id, default `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (mainnet); checked against the RPC's genesis hash at startup |
| `RELAYER_X402_PAY_TO` | owner of the payment token accounts; default = `RELAYER_SOLANA_TREASURY` and must equal it (`EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq`); never a launch wallet |
| `RELAYER_X402_ASSETS` | comma-separated 6-decimal mints accepted for payment; default: the Solana fee mints (USDG); **set it to USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` with the CDP facilitator, which refuses USDG at verify preflight** (docs/X402-SELLER.md section 5) |
| `RELAYER_X402_PAY_TO_TOKEN_ACCOUNTS` | `mint=tokenAccount,...` pins: startup asserts ATA(payTo, mint) equals each (USDG: `DxpmCZYAoDKpHmA5vWuopUrf3UVuGnPvditVrN9xDwDo`); a mismatch refuses to start; a missing ATA leaves the seller off (`x402: seller off:` in the log, free relay API unaffected) until the owner creates it from the vault; the relayer never sends a transaction for it |
| `RELAYER_X402_PRICES` | `service=amount,...` in 6-decimal base units; defaults `relay-priority=250000,preflight=2000,loans-market=1000,prove-disclose=20000`; `0` disables a service |
| `RELAYER_X402_RESOURCE_BASE` | https origin the resource URLs advertise (default `https://api.h081.xyz`) |
| `RELAYER_X402_MAX_TIMEOUT_SECONDS` | `maxTimeoutSeconds` in the requirements (default 120) |
| `RELAYER_X402_SERVICE_NAME`, `RELAYER_X402_TAGS`, `RELAYER_X402_ICON_URL` | Bazaar listing: name (default `H081 Capital`, at most 32 ASCII), at most 5 tags (default `solana,privacy,bank,agents,loans`), optional https png/jpg/webp/gif icon |
| `RELAYER_X402_PRIORITY_MAX_IN_FLIGHT`, `RELAYER_X402_PRIORITY_MAX_LAMPORTS`, `RELAYER_X402_PRIORITY_PRICE_CEIL` | the priority lane: its own in-flight count (default 4), priority fee cap per transaction in lamports (default 4,000,000) and ceiling in micro-lamports per CU (default 5,000,000) |
| `RELAYER_X402_LOAN_PROGRAM_ID` | stream_loan program the loan-market service reads (default the mainnet id `8JBd7epQXxdcKRMaWM1S5PC7nsQKoZq3uCetpiJ684g4`) |
| `RELAYER_X402_CIRCUITS_DIR`, `RELAYER_X402_DISCLOSE_VKEY_SHA256` | `build/circuits`-style directory with `disclose/` artifacts (enables prove-disclose; the Vercel bundle sets it when the artifacts ship with the function) and the pinned sha256 of `disclose.vkey.json` |

## API

```
GET  /v1/health
GET  /v1/info                 chains, relayer addresses, minimum fees, fee accounts, lookup tables, x402 { enabled, catalog }
POST /v1/solana/relay         { op, payload (base64), mint?, recipientOwner?, lenderToken? } -> { signature, computeUnits, op, fee }
POST /v1/evm/relay            { to, data }                                                   -> { hash, fn, fee }

GET  /v1/x402/catalog                 free: { enabled, network, payTo, assets, services: [{ id, method, url, price, input, output }] }
POST /v1/x402/solana/relay-priority   paid, settle-first:  the relay body -> { signature, computeUnits, op, fee, lane, priorityFee }
POST /v1/x402/solana/preflight        paid, settle-after:  the relay body -> { ok, op, fee, capacity, chain, accounts, plan, refusals }
GET  /v1/x402/loans/market            paid, settle-after:  -> { programId, registry, counts, loans, openSlots, ... }
POST /v1/x402/prove/disclose          paid, settle-first:  { root, kind, bound, audience, windowId?, allowance, path } -> { proof, publicSignals, args, payload, policyHash }
```

Errors are `{ error: { code, message } }`: 400 malformed, 402 fee not acceptable, 409 stale root or spent
nullifier, 413 body too large, 422 simulation failed, 429 rate limited, 503 chain disabled or busy.

x402 flow (v2, `exact` scheme on Solana): a paid route without a `PAYMENT-SIGNATURE` header answers 402
with the `PAYMENT-REQUIRED` header (base64 JSON `PaymentRequired`: `resource`, `accepts` = one `exact`
requirement per accepted asset with `payTo` = the treasury and `extra.feePayer` from the facilitator,
`extensions.bazaar` = the discovery declaration) and the same JSON as the body. With the header, the
seller matches the client's `accepted` against its own requirement (scheme, network, asset, amount at least
the price, payTo), asks the facilitator to verify, then either settles first and runs (relay-priority,
prove-disclose: the charge buys the attempt; cheap refusals such as a low relay fee or a bad Merkle path happen
before settlement and are not charged) or runs first and settles (preflight, loans-market: no charge when the
work fails). A 200 carries `PAYMENT-RESPONSE` (base64 settlement). The unpaid challenge is not rate-limited;
paid calls take one limiter token (the priority lane has its own capacity instead). Error codes: 503
`x402_disabled` (no CDP credentials), 503 `facilitator_unavailable`, 503 `service_disabled` (price 0, or
prove-disclose without artifacts), 402 `invalid_payload`, `invalid_x402_version` (v1 `X-PAYMENT` clients are
not served), `invalid_payment_requirements`, `payment_invalid` (`reason` = the facilitator's `invalidReason`),
`settlement_failed` (`reason` = `errorReason`), 409 `payment_replayed`, and for prove-disclose 400 `bad_input` /
`bad_path`, 409 `unknown_root`, 422 `statement_false`. A `settlement_pending` answer is retried once, then the
result is served with the pending receipt and a `x402 pending <signature>` log line for reconciliation.
Owner runbook: `docs/X402-SELLER.md`.

Solana flow: decode `borsh(Proof, Args, ext)` for the named op, check the fee (mint listed, amount at least
the minimum, paid to the treasury's fee account), check root/nullifiers/timestamp, stage the payload in a
buffer the relayer owns, simulate the final transaction, then send. Deposits and lender claims are never
relayed (the depositor or lender must sign).

## SDK side

```ts
const relayer = new RelayerClient('http://127.0.0.1:8787');
const t = await relayer.solanaTerms(mint.toBase58());
await wallet.withdraw(mint, amount, recipient, {
  relayer: new PublicKey(t.relayer), feeRecipient: new PublicKey(t.feeRecipient), fee: t.fee, via: relayer,
});
```

Without `via` the wallet sends exactly as before. Lookup tables for the v0 path: `createLookupTable`,
`extendLookupTable`, `poolLookupAddresses`, `buildV0Transaction`, `planOperation` in `src/solana/alt.ts`, and
`SolanaPool.useLookupTables(tables)`.

## Not yet

- Not run end to end against a validator in this pass (the localnet suites are run separately).
- No persistence: in-flight relays are lost on restart; no queue, retries or nonce management across restarts.
- No priority-fee or dynamic fee pricing; minimum fees are static per asset.
- EVM path is minimal (one signer, sequential sends).
- No auth, metrics or multi-instance coordination; run it behind a proxy you control.
- x402: v1 clients (`X-PAYMENT`) are not served; the replay set, the loan snapshot and the facilitator's fee
  payer are cached per instance (the facilitator and the chain are the authority across instances);
  `settlement_pending` reconciliation is manual (the logged signature, checked on chain).
