# @h081lll/agent

H081, the private bank for AI agents on Solana, on your own machine. One package gives you:

- a **TypeScript SDK** (`import { H081 } from '@h081lll/agent'`),
- the **`h081` CLI**,
- a **local JSON API** on `http://127.0.0.1:8081/v1` that any language can call,
- the **MCP server** (`h081 mcp`) for Claude and other MCP clients.

Your agent key, notes and viewing keys stay on your machine. Nothing H081 runs ever holds or sees them. The program talks only to your Solana RPC, to the H081 relayer (`https://api.h081.xyz`, with payloads that are already proven) and to `https://www.h081.xyz/circuits/` (downloads checked against pinned sha256 hashes).

H081 is **live on Solana mainnet**. It is **not audited yet**. **Use at your own risk**, with a key that holds only what the agent should spend.

## First private payment in about 5 minutes

You need Node 20.11 or newer and a little SOL.

**1. Create the agent key.** Offline. It prints the agent's address.

```sh
npx -y @h081lll/agent init --rpc <your Solana RPC URL>
```

This writes `~/.h081/agent.json` (the key, readable only by you), `~/.h081/config.json` and `~/.h081/api-token`. Run it again and it keeps the key it has.

**2. Fund it.** Send 0.05 SOL and a few USDG to the printed address (0.15 SOL if you will grant budgets or lend). The first proof downloads about 98 MB of proving files, once.

**3. Deposit, then withdraw to a fresh wallet.**

```sh
npx -y @h081lll/agent deposit 5 --yes
npx -y @h081lll/agent fee 2
npx -y @h081lll/agent withdraw 2 --to <a wallet that never touched the agent> --yes
npx -y @h081lll/agent balance
```

Withdrawing to the wallet that deposited, right after depositing, links the two. Use a fresh wallet and wait a while.

Without `--yes` a command prints its plan (fee, what arrives, SOL needed, what is public) and sends nothing.

**4. The local API, for any language.**

```sh
npx -y @h081lll/agent serve
```

```sh
TOKEN=$(cat ~/.h081/api-token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8081/v1/balance
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "Idempotency-Key: wd-1" \
  -d '{"usdg":"2","to":"<fresh wallet>","confirm":true}' http://127.0.0.1:8081/v1/withdraw
```

PowerShell:

```powershell
$h = @{ Authorization = "Bearer $(Get-Content $HOME\.h081\api-token)"; "Idempotency-Key" = "wd-1" }
Invoke-RestMethod -Headers $h http://127.0.0.1:8081/v1/balance
Invoke-RestMethod -Method Post -Headers $h -ContentType application/json -Body '{"usdg":"2","to":"<fresh wallet>","confirm":true}' http://127.0.0.1:8081/v1/withdraw
```

**5. Or the SDK.**

```ts
import { H081 } from '@h081lll/agent';

const bank = await H081.open();                 // ~/.h081/agent.json + ~/.h081/config.json + env
await bank.deposit('5', { confirm: true });
const plan = await bank.withdraw('2', { to: 'FreshWallet111…' });           // the plan: nothing is sent
console.log(plan.result);
await bank.withdraw('2', { to: 'FreshWallet111…', confirm: true, idempotencyKey: 'wd-1' });
console.log(await bank.balance());
```

**6. Or an AI agent (MCP).** `init` prints this line with your real path:

```sh
claude mcp add --scope user h081 -e H081_SOLANA_KEYPAIR=<absolute path to ~/.h081/agent.json> -e H081_RPC_URL=<your RPC> -- npx -y @h081lll/agent mcp
claude mcp list        # h081 should show Connected
```

On Windows (not WSL) it is `-- cmd /c npx -y @h081lll/agent mcp`. Then ask, for example: "Deposit 5 USDG into my H081 account, then withdraw 2 USDG to my fresh wallet 9xQe…".

## Commands

| Command | What it does |
|---|---|
| `h081 init [--rpc <url>] [--cluster mainnet-beta\|localnet]` | Offline. Creates `~/.h081/agent.json` (0600) if missing, else keeps it. Writes `config.json` and `api-token`. Prints the address, the `h081-address:` code, the key path and the `claude mcp add` line. |
| `h081 address` | Offline. The agent wallet and its `h081-address:` code. |
| `h081 info` | Protocol facts, where the key comes from, the RPC host, the SOL each use needs. |
| `h081 fetch-circuits` | Downloads the proving files (about 98 MB), hash-checked. |
| `h081 balance [--fresh]` | Shielded and wallet balances, caps, allowances. |
| `h081 history [--limit N]` | What this machine sent (from `~/.h081/ops.jsonl`). |
| `h081 deposit <usdg> [--yes]` | Wallet USDG into the shielded account. |
| `h081 withdraw <usdg> --to <wallet\|self> [--direct] [--yes]` | To a wallet through the relayer. `--to` is required; `self` is the agent wallet. |
| `h081 fee <usdg>` | The withdraw fee quote. No proof is made. |
| `h081 pay <usdg> (--to <wallet> \| --to-code <h081-address:…>) [--allowance <id>] [--yes]` | Pay from an allowance this agent holds. |
| `h081 transfer <usdg> --to-code <h081-address:…> [--yes]` | Pay from the main shielded balance to another account's code. |
| `h081 allow <usdg> [--daily-cap X] [--max-per-tx X] [--days N] [--agent-index N] [--yes]` | Give a sub-account (or `--to-code`, another agent) a budget. |
| `h081 reclaim <id> [--yes]` | Take back what is left of an allowance you granted. |
| `h081 loan quote <termsCode>` | Price a loan from a lender's terms code. |
| `h081 loan borrow <termsCode> --days N --unlock-days N [--principal X] [--yes]` | Pledge an allowance and get the proof code for the lender. |
| `h081 lend <open\|fund\|status\|collect\|claim\|settle> […] [--yes]` | The lender side. |
| `h081 stake <view\|stake\|request-unstake\|unstake> [amount] [--yes]` | H081 in capacity_stake. |
| `h081 check <code>` | Validates any `h081-*` code: kind, network, checksum. |
| `h081 serve [--port 8081] [--poll 20] [--allow-origin <url>]` | The local API on 127.0.0.1. Downloads the proving files in the background. |
| `h081 token [--rotate]` | Prints or replaces the API token. |
| `h081 backup` / `h081 restore <code> [--force]` | The agent key as an `h081-key:` code. CLI only. |
| `h081 openapi` | Prints the OpenAPI document. |
| `h081 mcp` | The MCP server on stdio. |

Global flags: `--json` (the API's envelope on stdout, logs on stderr), `--yes` (send it), `--home <dir>`, `--cluster mainnet-beta|localnet`, `--idempotency-key <k>` (default: a new random key per call). Exit codes: `0` ok, `1` error (with `--json`, stdout carries the error envelope), `2` bad usage.

## The local API

`h081 serve` listens on `http://127.0.0.1:8081/v1`. The full document is `openapi.json` in this package, `GET /v1/openapi.json`, or `h081 openapi`.

| Method and path | What it does |
|---|---|
| `GET /v1/health` | `{version, network}` (no token) |
| `GET /v1/openapi.json` | The OpenAPI 3.1 document (no token) |
| `GET /v1/status` | Network, agent, key source, RPC host, circuits, queue depth, SOL needed |
| `GET /v1/address` | `{wallet, addressCode}` |
| `GET /v1/balance[?fresh=1]` | Balances, caps, allowances (cached for 15 s) |
| `GET /v1/history[?after=&limit=]` | What this gateway or CLI sent |
| `GET /v1/fees/withdraw?usdg=2` | Fee, payout, whether it needs H081 staked |
| `POST /v1/deposit` | `{usdg, confirm?}` |
| `POST /v1/withdraw` | `{usdg, to, direct?, confirm?}`; `to` is a wallet or `"self"` |
| `POST /v1/pay` | `{usdg, to? \| toAddressCode?, allowanceId?, confirm?}` |
| `POST /v1/transfer` | `{usdg, toAddressCode, confirm?}` |
| `POST /v1/allowances` | `{budget, dailyCap?, maxPerTx?, days?, agentIndex?, confirm?}` |
| `POST /v1/allowances/{id}/reclaim` | `{confirm?}` |
| `GET /v1/loans/quote?termsCode=` | Price a loan |
| `POST /v1/loans/borrow` | `{termsCode, days, unlockDays, principal?, confirm?}` |
| `POST /v1/loans/lend` | `{action: open\|fund\|collect\|claim\|settle, …, confirm?}` |
| `GET /v1/loans/lent[?loanRef=]` | This agent's loan slots |
| `GET /v1/stake` / `POST /v1/stake` | `{action: stake\|request_unstake\|unstake, h081?, confirm?}` |
| `POST /v1/codes/check` | `{code}` → `{kind, network, valid, reason?}` |
| `GET /v1/events` | Server-sent events: `balance.changed`, `allowance.changed`, `op.completed`, `op.failed` |

Amounts are decimal strings (`"usdg": "5.25"`); base units work too (`"amount": "5250000"`).

Every response has `network`. Success: `{"ok": true, "network": "mainnet-beta", "status": "done|plan|sent", "result": {…}, "requestId": "…"}`. Error: `{"ok": false, "network": "…", "error": {"code": "needs_sol", "message": "…", "retryable": false, "details": {…}}, "requestId": "…"}`.

**Writes.** Without `"confirm": true` a POST returns `status: "plan"` and nothing is proven, signed or sent. With `"confirm": true` it needs the header `Idempotency-Key` (1 to 128 of `A-Z a-z 0-9 _ . : -`). Writes go through one queue, one proof at a time; more than 8 waiting gives `503 busy` with `Retry-After`. At most 30 sends a minute (`H081_API_MAX_SENDS_PER_MIN`).

**Idempotency** (records in `~/.h081/ops.jsonl`, kept 7 days):

| Case | Answer |
|---|---|
| Same key, same body, finished | The stored response again (`"replayed": true`) |
| Same key, still running | `409 in_progress`, `Retry-After: 5` |
| Same key, another body | `422 idempotency_key_reused` |
| The gateway stopped while it ran, or the connection to the relayer or RPC failed mid-send | `409 outcome_unknown`: it may have been sent. Check `/v1/balance?fresh=1` before retrying with a new key. The same key keeps answering `outcome_unknown`; it is never sent again. |
| A retryable error where nothing was sent (relayer busy, 429, stale root) | The key is released: the same request may be sent again with it. |

**Errors** (`code`, HTTP status, retryable): `unauthorized` 401; `forbidden_origin` 403; `bad_request` 400; `unsupported_media_type` 415; `idempotency_key_required` 400; `idempotency_key_reused` 422; `in_progress` 409 yes; `outcome_unknown` 409; `invalid_code` 400; `insufficient_shielded`, `insufficient_wallet_usdg`, `needs_sol`, `cap_per_deposit`, `cap_total`, `deposits_paused`, `over_operator_ceiling`, `needs_stake`, `allowance_blocked` 409; `relayer_unavailable`, `relayer_busy` 503 yes; `rate_limited` 429 yes; `busy` 503 yes; `stale_root`, `in_flight` 409 yes; `already_spent` 409; `simulation_failed`, `program_error` 422; `rpc_unreachable` 502 yes; `circuits_missing`, `circuit_hash_mismatch` 503; `not_available` 501; `internal` 500. A busy or rate-limited relayer is retried once before the error is returned.

**Local security.** The gateway binds `127.0.0.1` only; there is no option to bind anywhere else. The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (this blocks DNS rebinding). A request with an `Origin` header is refused unless it equals `--allow-origin` exactly; no CORS headers are sent otherwise. A POST must be `Content-Type: application/json`. The token is compared in constant time. Keys, tokens, notes and full RPC URLs are never logged; only the RPC host is shown.

## Files in `~/.h081` (`H081_HOME`)

| File | Mode | What |
|---|---|---|
| `agent.json` | 0600 | The agent key (Solana keypair JSON). It also derives the shielded account and its sub-accounts. |
| `config.json` | 0600 | `{cluster, rpcUrl, port}`, written by `init` |
| `api-token` | 0600 | The gateway's bearer token |
| `ops.jsonl` | 0600 | Idempotency records and local history |
| `cache/`, `circuits/` | | Public chain data and proving files |

The directory is 0700 on macOS and Linux. On Windows, access is limited to your user with `icacls`; if that fails you get a warning. Settings come from the environment first, then `config.json`, then the mainnet defaults.

**Backup.** `h081 backup` prints the key as an `h081-key:` code (letters and digits, a checksum and the network). Anyone with this code controls the agent's funds. Store it offline. `h081 restore <code>` checks it and writes `agent.json` (it refuses to replace an existing key without `--force`).

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `H081_HOME` | `~/.h081` | The data directory |
| `H081_SOLANA_KEYPAIR` / `H081_SOLANA_KEY` | `~/.h081/agent.json` | The agent key (file path, or the secret itself) |
| `H081_RPC_URL` | from `config.json`, else the public mainnet RPC | Your Solana RPC; only its host is ever shown |
| `H081_CLUSTER` | `mainnet-beta` | `mainnet-beta` or `localnet` (tests only) |
| `H081_API_PORT` | `8081` | Gateway port |
| `H081_API_TOKEN_FILE` | `$H081_HOME/api-token` | Token file |
| `H081_API_MAX_SENDS_PER_MIN` | `30` | The local send limit |
| `H081_MAX_DEPOSIT`, `H081_MAX_PAY`, `H081_MAX_GRANT`, `H081_MAX_LEND` | none | Ceilings in base units, enforced before anything is proven |
| `H081_RELAYER_URL`, `H081_CIRCUITS_DIR`, `H081_CIRCUITS_URL`, `H081_*_PROGRAM_ID`, `H081_USDG_MINT` | mainnet | Overrides for a test validator |

## Privacy, plainly

- A deposit is public: the chain shows the agent wallet and the amount.
- A withdrawal through the relayer is sent by the relayer: the chain shows the recipient and the amount, not the agent wallet. Up to 100 USDG per withdrawal with nothing staked; above that, H081 staked in capacity_stake sets a 30-day limit.
- A transfer or a payment to an `h081-address:` code is sent by the agent key: the chain shows that the agent wallet used the bank, not to whom or how much.
- Withdrawing to the wallet that deposited links the two.
- Not audited yet; use at your own risk.

## Development

```sh
npm run build --prefix integrations/agent      # dist/cli.js, dist/index.js
npm run openapi --prefix integrations/agent    # regenerate openapi.json
npm run test:agent                             # from the repository root
node integrations/agent/dist/cli.js --help
```
