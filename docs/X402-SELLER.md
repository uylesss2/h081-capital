# x402 seller: paid endpoints on the relayer (owner runbook)

The H081 private bank is live on Solana mainnet. It is not audited yet; use at your own risk. This document
is for the owner: what the x402 seller in the relayer does, the exact addresses it is pinned to, every
environment variable, and the steps that only the owner can take to switch it on, make the first settlement
and get the service indexed in Coinbase's x402 Bazaar. Nothing in this document happens on its own; the
relayer ships with the seller off.

Public text about this service names only the H081 project and its token
`EgqxxR7zowzaLEm24oep5qqBieLVAWYX78LhgeqAJAo`.

## 1. What the code does

AI agents pay per call with x402 (HTTP 402, v2, scheme `exact`, Solana mainnet
`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`). The relayer is the **seller**: it answers a paid route with a
`402` and a `PAYMENT-REQUIRED` header, the agent signs a token transfer and retries with a
`PAYMENT-SIGNATURE` header, and the relayer has Coinbase's CDP facilitator verify and settle the transfer
(the facilitator co-signs as fee payer and broadcasts it). The payment goes to the treasury:

| What | Value |
|---|---|
| `payTo` (owner of the payment accounts) | `EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq` (the Squads treasury vault; must equal `RELAYER_SOLANA_TREASURY`) |
| USDG payment account (ATA of payTo) | `DxpmCZYAoDKpHmA5vWuopUrf3UVuGnPvditVrN9xDwDo` (Token-2022; exists on mainnet, owned by the treasury) |
| USDC payment account, if USDC is enabled | `4WdndFn46EUEt5gY4kC2D2LA1Nsos9YzvPi1bMNQuLiT` (derived ATA; create it from the vault yourself and pin it: the relayer never creates it, and while it is missing the seller stays off) |
| USDG mint | `2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH` (Token-2022, 6 decimals) |
| USDC mint (optional) | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (6 decimals) |
| Facilitator | `https://api.cdp.coinbase.com/platform/v2/x402` (`/verify`, `/settle`, `/supported`, each with a CDP JWT) |
| stream_loan read by the loan-market service | `8JBd7epQXxdcKRMaWM1S5PC7nsQKoZq3uCetpiJ684g4` (registry `5MMWdQWZB3JWTCZXZsEGSLWegi9bk9iSitT9avdLo4Kt`) |
| stipend_pool (roots for prove-disclose, relay checks) | `E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM` |

In the x402 `exact` scheme on Solana, `payTo` is the merchant's **owner** key and the funds land in the
associated token account of (`payTo`, `asset`). That is why `payTo` is the vault address and not the token
account: the relayer derives the ATA at startup and refuses to start if it differs from the pinned
`RELAYER_X402_PAY_TO_TOKEN_ACCOUNTS` entry. `extra.feePayer` (the facilitator's sponsor key) is not a
constant: it is read from the facilitator's `GET /supported` and cached for 10 minutes.

Revenue rule (docs/FLYWHEEL.md section 2 and 3): these payments are platform revenue, next to the relay
fee and the loan origination fee. The H081 token's trading creator fees are the team's and never pass
through here. The relayer refuses any `payTo` other than the treasury and any launch wallet, at startup and
in code (`relayer/config.ts`, `relayer/x402/seller.ts`).

### The services

| Route | Flow | Default price (6-decimal base units) | What it does |
|---|---|---|---|
| `POST /v1/x402/solana/relay-priority` | settle-first | `250000` (0.25) | The `/v1/solana/relay` body through a dedicated lane: its own in-flight count (`RELAYER_X402_PRIORITY_MAX_IN_FLIGHT`) and higher priority-fee caps on every transaction (a paid call still takes one token of the per-client rate limit, like every other paid call). The in-proof relay fee (0.20%, minimum 0.05 USDG, to the treasury fee account) is still required. Fee, root, nullifier, timestamp and capacity refusals happen **before** settlement and are never charged; a staging, simulation or send failure after settlement is answered with the receipt attached (`charged: true`): the charge buys the lane and the attempt. |
| `POST /v1/x402/solana/preflight` | settle-after | `2000` (0.002) | "Would this relay land": fee rule, capacity, known root, unspent nullifiers, fresh timestamp, the accounts the final transaction needs, the transaction plan, and every refusal the relay API would answer with. A payload that does not decode is a 400 and not charged. |
| `GET /v1/x402/loans/market` | settle-after | `1000` (0.001) | The stream_loan registry and every slot read from the chain, with shortfalls at chain time; cached 30 s. |
| `POST /v1/x402/prove/disclose` | settle-first | `20000` (0.02) | A Groth16 proof of the `disclose` circuit for an allowance (remaining at least / spent at most / window spent at most a bound, bound to an audience, as of a known root), plus the base64 payload for `verify_disclosure`. Input shape, field ranges, the Merkle path and the root are checked before settlement (400 `bad_input` / `bad_path`, 409 `unknown_root`, not charged). Privacy: the agent sends its allowance figures, policy and Merkle path, never a spending key (disclose proofs need none), so the prover learns what the note holds but cannot spend it; the service description says so. Off (503 `service_disabled`) until the circuit artifacts ship with the function. |
| `GET /v1/x402/catalog` | free | | The services, prices, assets, payTo, the facilitator's fee payer and each service's input example and schema. `enabled:false` with a `note: "x402_disabled"` while the seller is off. |

Prices are placeholders for the owner (`RELAYER_X402_PRICES`). The priority lane spends the hot wallet's
SOL on higher priority fees (up to `RELAYER_X402_PRIORITY_MAX_LAMPORTS` per transaction, several
transactions per relay); the USDG price has to cover that at the SOL price of the day.

### Request flow (what an agent sees)

1. `GET /v1/x402/loans/market` without a payment → `402`, header `PAYMENT-REQUIRED` = base64 JSON:
   `{ x402Version: 2, error, resource: { url, description, mimeType, serviceName, tags }, accepts: [{ scheme: "exact",
   network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: "1000", asset: "2u1tsz…", payTo: "EGvxic665…",
   maxTimeoutSeconds: 120, extra: { feePayer } }, …], extensions: { bazaar: { info, schema } } }`; the same JSON is the body.
2. The agent's x402 client (for example `@x402/fetch` with `@x402/svm`, or CDP's agentic wallet) builds a
   partially signed v0 transaction (compute budget, `TransferChecked` of at least `amount` into the treasury's
   ATA, a memo), puts it in `PAYMENT-SIGNATURE` = base64 `{ x402Version: 2, resource, accepted, payload: { transaction },
   extensions: { bazaar } }` and retries.
3. The relayer matches `accepted` against **its own** requirement (never the client's amount or payTo), asks the
   facilitator to `verify`, then settles and runs in the order of the service's flow. `200` carries
   `PAYMENT-RESPONSE` = base64 `{ success, transaction (signature), network, payer }`.
4. Refusals: 402 `invalid_payload`, `invalid_x402_version` (v1 `X-PAYMENT` clients are not served),
   `invalid_payment_requirements`, `payment_invalid` (`reason` = the facilitator's `invalidReason`),
   `settlement_failed` (`reason` = `errorReason`); 409 `payment_replayed` (one signed payment buys one call on an
   instance); 503 `facilitator_unavailable` (nothing charged), `x402_disabled`, `service_disabled`.

## 2. Environment variables

Set in the `h081-relayer` Vercel project (production). The relayer reads nothing from disk except the
artifacts the bundle ships.

| Variable | Set to |
|---|---|
| `CDP_API_KEY_ID` | the Secret API Key id from the CDP portal (`organizations/…/apiKeys/…`) |
| `CDP_API_KEY_SECRET` | its secret: the base64 Ed25519 key (64 bytes) the portal shows once; an EC PEM (ES256) is accepted too, with `\n` escapes |
| `RELAYER_X402_PAY_TO` | leave unset (defaults to `RELAYER_SOLANA_TREASURY`), or `EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq` |
| `RELAYER_X402_PAY_TO_TOKEN_ACCOUNTS` | `2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH=DxpmCZYAoDKpHmA5vWuopUrf3UVuGnPvditVrN9xDwDo` (add `EPjF…=4Wdnd…` with USDC) |
| `RELAYER_X402_ASSETS` | unset = the fee mints (USDG); `2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` to accept USDC as well |
| `RELAYER_X402_PRICES` | `relay-priority=250000,preflight=2000,loans-market=1000,prove-disclose=20000` (your numbers; `0` disables a service) |
| `RELAYER_X402_NETWORK` | unset (mainnet); checked against the RPC genesis hash at startup |
| `RELAYER_X402_RESOURCE_BASE` | unset (`https://h081-relayer.vercel.app`) |
| `RELAYER_X402_SERVICE_NAME`, `RELAYER_X402_TAGS`, `RELAYER_X402_ICON_URL` | `H081 Capital`; up to 5 tags; optional https png/jpg/webp/gif on h081.xyz (no SVG) |
| `RELAYER_X402_PRIORITY_MAX_IN_FLIGHT`, `RELAYER_X402_PRIORITY_MAX_LAMPORTS`, `RELAYER_X402_PRIORITY_PRICE_CEIL` | defaults 4, 4000000, 5000000 |
| `RELAYER_X402_FACILITATOR_URL`, `RELAYER_X402_FACILITATOR_TIMEOUT_MS`, `RELAYER_X402_MAX_TIMEOUT_SECONDS`, `RELAYER_X402_LOAN_PROGRAM_ID` | defaults (CDP, 30000, 120, `8JBd7epQXxdcKRMaWM1S5PC7nsQKoZq3uCetpiJ684g4`) |
| `RELAYER_X402_CIRCUITS_DIR`, `RELAYER_X402_DISCLOSE_VKEY_SHA256` | see step 5; on Vercel the bundle sets the directory itself |

Rules the relayer enforces at startup: both CDP variables or neither (one alone refuses to start); Solana
relaying must be configured; `payTo` must equal the treasury and is never a launch wallet; every payment
asset must have 6 decimals; the derived ATA must equal the pinned one; the network must match the cluster.
Those are configuration refusals and stop the relayer. Anything else that keeps the seller from starting (the
RPC not answering, a payment account that does not exist yet, unusable disclose artifacts) only switches the
seller (or just prove-disclose) off with an `x402: seller off:` / `x402: disclose prover off:` log line: the
free relay API keeps working, the catalog says `enabled: false` and the paid routes answer 503
`x402_disabled` until the next start. Nothing is sent on chain at startup for the seller, and the facilitator
is **not** called at startup: an outage there never blocks the free relay API. A paid request runs the
service's own checks (body, fee, root, nullifiers, timestamp, lane capacity) before the facilitator is asked
to verify, so a refused request costs no facilitator call, and every paid call takes one per-client
rate-limit token.

## 3. Go-live steps (owner only)

1. **CDP account and key.** At https://portal.cdp.coinbase.com create a project and a Secret API Key (choose
   Ed25519; copy the base64 secret, it is shown once). Nobody else can do this. Facilitator pricing at the time
   of writing: verification free, 1,000 on-chain settlements per month free, then $0.001 each; check the portal.
2. **Decide the terms.** Prices (`RELAYER_X402_PRICES`), the priority caps, whether to accept USDC next to
   USDG, the Bazaar name/tags/icon. Prove-disclose: see step 5 or leave it off at launch.
3. **Set the environment** in the Vercel project: `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`,
   `RELAYER_X402_PAY_TO_TOKEN_ACCOUNTS`, `RELAYER_X402_PRICES` and whatever else you decided in step 2.
4. **Bundle and deploy** (from the repository root, with the branch merged):
   ```
   node scripts/relayer-vercel.mjs
   cd deploy/relayer-vercel && vercel deploy --prod
   ```
   Then `curl https://h081-relayer.vercel.app/v1/x402/catalog` must show `"enabled": true`, the services with
   your prices, `payTo` = `EGvxic665…` and `assets[0].payToTokenAccount` = `DxpmCZ…`. `GET /v1/info` shows
   `x402.enabled: true`. If a configuration rule refused, the function answers 503 `unavailable` and `vercel logs`
   shows the `config:` reason; if the catalog says `enabled: false` with the credentials set, the relay API is
   up but the seller is off, and `vercel logs` shows the `x402: seller off:` reason (fix it and redeploy).
5. **Prove-disclose (optional).** Put the official disclose artifacts (the ones behind
   `stipend-site/public/circuits/disclose.*`, which the deployed verifier matches) in a `build/circuits/disclose/`
   layout (`disclose.zkey`, `disclose.vkey.json`, `disclose_js/disclose.wasm`,
   `disclose_js/witness_calculator.js`; `npm run circuits:setup` produces that layout) and bundle with
   `RELAYER_X402_CIRCUITS_DIR=build/circuits node scripts/relayer-vercel.mjs`. The script copies them into
   `deploy/relayer-vercel/circuits/` (about 11 MB, shipped with the function through `includeFiles`) and prints
   the vkey's sha256; set it as `RELAYER_X402_DISCLOSE_VKEY_SHA256` so the function refuses other artifacts. The
   site's current `disclose.vkey.json` has sha256
   `c34de1a64c403bc5f37372efbae8fe9ed82a2afd85f7ab20246d959b3e84b1b4`. Without the artifacts the route answers
   503 `service_disabled`.
6. **Validate each paid route with CDP's public preflight** (no key needed; it fetches the live 402 and checks
   the requirement and the Bazaar declaration):
   ```
   curl -s -X POST https://api.cdp.coinbase.com/platform/v2/x402/validate \
     -H 'content-type: application/json' \
     -d '{"resource":"https://h081-relayer.vercel.app/v1/x402/loans/market","method":"GET"}'
   ```
   and the same with `/v1/x402/solana/preflight` (`POST`), `/v1/x402/solana/relay-priority` (`POST`) and, when
   enabled, `/v1/x402/prove/disclose` (`POST`). Every preflight check must pass (`valid: true`,
   `simulation.outcome: "accepted"`); fix anything it flags before the first payment. Before the deploy the same
   call answers `404 not a route`, which proves the validator reaches the live relayer.
7. **First settlement (this is what gets the service indexed).** Pay one call yourself from a Solana wallet
   holding a little USDG (or USDC, if enabled). The cheapest is `GET /v1/x402/loans/market`. Use an x402 client
   that supports the Solana `exact` scheme: `@x402/fetch` + `@x402/svm` (`wrapFetchWithPayment` with a Solana
   signer), or CDP's agentic-wallet CLI ("pay for service"). Check: the response is 200 with a
   `PAYMENT-RESPONSE` whose `success` is true, and its `transaction` signature shows the transfer landing in
   `DxpmCZYAoDKpHmA5vWuopUrf3UVuGnPvditVrN9xDwDo` on an explorer. The facilitator indexes a resource on the first
   settled payment whose payload echoes `extensions.bazaar` and `resource` (x402 clients built on the CDP SDK do
   that by default).
8. **Confirm the listing.** Within about 15 minutes:
   ```
   curl -s 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=50'
   ```
   (public; filter the JSON for `h081-relayer.vercel.app`). The relayer logs the facilitator's
   `EXTENSION-RESPONSES` on every verify and settle as `x402 <service> settle bazaar success|processing|rejected: <reason>`
   (`vercel logs`); a `rejected` status names what to fix (description over 500 characters, placeholder text,
   bad icon type). Each paid route is listed separately: repeat step 7 once per route you want in the Bazaar.

## 4. Operating it

- **Logs** (`vercel logs`): `x402 <service> ok <ms> settled <signature>` per paid call;
  `x402 <service> refused before payment <status> <code>` (not charged); `x402 <service> failed after settlement
  <signature>: … (charged)` for a settle-first service whose work failed after the charge; `x402 pending
  <signature> <service> (reconcile on chain …)` when the facilitator answered `settlement_pending` twice: the
  result was served; check the signature on chain and, if it never landed, the call was free (nothing to do) or,
  if it landed, it was paid normally.
- **Replays**: a presented payment is remembered per instance (10,000 entries); across instances the
  facilitator and the chain refuse a second broadcast of the same transaction.
- **Disable**: unset `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` and redeploy (or set a service's price to `0`
  to disable just that one). The free relay API is never affected by the seller.
- **Reconciliation / the flywheel ledger**: payments arrive in the treasury's token accounts like relay fees
  do; they are platform revenue (`docs/FLYWHEEL.md` section 3, "Paid services we host").

## 5. Open points for the owner

- **Payment asset: USDC only (settled 2026-11-02).** The hosted CDP facilitator refuses USDG at its preflight
  (`verify` answers `preflight_validation_failed` for a payload that is otherwise identical to a USDC one, which
  passes preflight and reaches simulation), and CDP's public validator requires `accepts[0].asset` to be USDC for a
  Bazaar listing. Production runs `RELAYER_X402_ASSETS=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` with the
  treasury USDC account `4WdndFn46EUEt5gY4kC2D2LA1Nsos9YzvPi1bMNQuLiT` pinned (created 2026-11-02, tx
  `5cCqQEc7HGpwhyWbVBiNFkJKvcsuQLsQtZ5RM6BXepDVQk7KSx8eNRGM8tAfD5jv4fKLmFpfe9LoeyHuPD8ji6c1`). Relay fees and
  loan fees stay in USDG; only the x402 per-call payments are USDC. Diagnostics: `scripts/x402-facilitator-debug.mts`
  (`/supported` and a raw `verify`), `scripts/x402-pay.mts --dry-run --dump`.
- Prices and the priority-lane SOL caps (section 1).
- Reconciliation policy for `settlement_pending`: today the result is served and the signature logged; for
  prove-disclose the opposite (withhold the result) is a one-line change in `relayer/x402/seller.ts`.
- Whether the site origin (`RELAYER_CORS_ORIGINS`) should call the paid routes from the browser at all; the
  CORS additions (`payment-signature` request header, `PAYMENT-REQUIRED` / `PAYMENT-RESPONSE` exposed) are
  harmless either way.

## 6. Local check without any CDP key

```
RELAYER_SOLANA_RPC=https://api.mainnet-beta.solana.com RELAYER_SOLANA_KEYPAIR=<throwaway keypair path> \
RELAYER_SOLANA_TREASURY=EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq \
RELAYER_SOLANA_MIN_FEES=2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH=50000 \
RELAYER_SOLANA_PROGRAM_ID=E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM npm run relayer
```
`GET /v1/x402/catalog` answers `enabled: false`, `POST /v1/x402/solana/preflight` answers 503
`x402_disabled`. The unit suite (`npm run test:relayer`) covers the seller with a mocked facilitator.
