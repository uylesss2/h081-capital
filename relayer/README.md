# Relayer (MVP)

A small HTTP service that submits operations the SDK already produces, so the wallet that proves an
operation does not have to pay gas or reveal its own address. The relayer is paid in the asset: the fee
and the relayer's address are bound into the proof (`extDataHash`), so the relayer can only choose to
submit or not; it cannot change the fee or the destination.

**Status: MVP.** Exercised by in-process unit tests only (`npm run test:relayer`). It has not run against a
public cluster, has not been load-tested and has not been audited. Not deployed anywhere.

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
| `RELAYER_ALLOW_UNPAID` | `1` to also relay operations that pay no fee (grant, delegate, shielded transfer) |
| `RELAYER_SOLANA_RPC` | enables Solana relaying |
| `RELAYER_SOLANA_KEYPAIR` | path to the relayer's keypair JSON (pays transaction fees, receives relay fees) |
| `RELAYER_SOLANA_PROGRAM_ID` | stipend_pool program id (default: the localnet id) |
| `RELAYER_SOLANA_MIN_FEES` | `mint=amount,...` minimum fee per mint, base units |
| `RELAYER_SOLANA_LOOKUP_TABLES` | comma-separated lookup tables to build v0 transactions against |
| `RELAYER_SOLANA_MIN_LAMPORTS`, `RELAYER_SOLANA_MAX_IN_FLIGHT` | refuse when underfunded / busy |
| `RELAYER_EVM_RPC`, `RELAYER_EVM_POOL`, `RELAYER_EVM_KEY` | enables EVM relaying (key: 0x hex) |
| `RELAYER_EVM_MIN_FEES` | `asset=amount,...` minimum fee per ERC-20 |
| `RELAYER_EVM_MAX_GAS` | refuse calls estimated above this (default 8,000,000) |

## API

```
GET  /v1/health
GET  /v1/info                 chains, relayer addresses, minimum fees, fee accounts, lookup tables
POST /v1/solana/relay         { op, payload (base64), mint?, recipientOwner?, lenderToken? } -> { signature, computeUnits, op, fee }
POST /v1/evm/relay            { to, data }                                                   -> { hash, fn, fee }
```

Errors are `{ error: { code, message } }`: 400 malformed, 402 fee not acceptable, 409 stale root or spent
nullifier, 413 body too large, 422 simulation failed, 429 rate limited, 503 chain disabled or busy.

Solana flow: decode `borsh(Proof, Args, ext)` for the named op, check the fee (mint listed, amount at least
the minimum, paid to this relayer's fee account), check root/nullifiers/timestamp, stage the payload in a
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
