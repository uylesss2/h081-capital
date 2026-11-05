# @h081lll/mcp

H081 Capital, the private bank for AI agents on Solana, as a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio. Claude Code, Claude Desktop and any other MCP client get seven tools: shielded USDG deposits and withdrawals, the balance, loan quotes and pledges, H081 staking, and the protocol's facts.

H081 Capital is **live on Solana mainnet**. It is **not audited yet**. **Use at your own risk**, with a dedicated, low-balance agent key.

## What the server does

The server holds one Solana keypair, the *agent key*. That key pays transaction fees, holds the public USDG that goes in and comes out, and deterministically derives the agent's *shielded account*: the account secret is an HMAC of a fixed label under the key's 32-byte secret seed, so the same key always opens the same account, nothing has to be stored, and no signature the key makes (over any message, including the label) reveals it. Whoever holds the agent key holds the shielded balance; a signature from it does not. (`H081_DERIVE_ACCOUNT=1` selects the older construction, sha256 of the key's signature over the label `h081/agent-account/v1`; with it one such signature is as good as the key, so never pair that mode with a tool that signs arbitrary messages.)

| Tool | What it does |
|---|---|
| `h081_bank_deposit` | USDG from the agent wallet into the shielded account. Public on chain: depositor and amount. Caps, read from chain before any proof: 1,000 USDG per deposit, 10,000 USDG in the bank in total; deposits can be paused (withdrawals never). Needs ~0.02 SOL (buffer rent, refunded, plus fees). |
| `h081_bank_withdraw` | USDG from the shielded account to a wallet (default: the agent wallet). Through the relayer by default (fee max(0.05 USDG, 0.20 %) to the protocol treasury's USDG account, checked before anything is proven; the agent wallet is not the sender on chain). When the relayer is unreachable or refuses, the withdrawal is not sent and the error says why; it is never silently sent by the agent key instead. Above the relayer's anonymous free tier (100 USDG per 30 days) the agent wallet is named to the relayer as capacity operator, which needs H081 staked (`h081_stake`). `direct: true`: the agent key sends (no relay fee, no limit, sender visible on chain). |
| `h081_bank_balance` | Shielded balance (visible only to this key), sub-account allowances, wallet USDG and SOL, live caps. |
| `h081_loan_quote` | Prices a stream-backed loan: max principal = minRemaining x pledgeBps / 10000, the 0.25 % origination fee, the payout; with `loanRef`, the slot on chain. Read-only. |
| `h081_loan_borrow` | The borrower side of a loan: pledges a streaming allowance from the shielded balance to a lender's terms code and returns the `h081-loan-proof:` code the lender funds against. See "Loans" below. |
| `h081_stake` | capacity_stake: `view`, `stake`, `request_unstake` (30-day cooldown), `unstake`. Caps: 100,000 H081 per stake, 1,000,000 total. |
| `h081_protocol_info` | Cluster, program ids, mints, live caps, relayer terms, the agent's addresses, the risk notice. |

Amounts are strings: `amount` in base units (USDG and H081 have 6 decimals; `"1000000"` = 1 USDG) or `usdg` / `h081` as a decimal (`"12.5"`). Every result carries amounts both ways.

Everything runs through the H081 SDK in this repository against the deployed programs (see `docs/MAINNET-RUNBOOK.md`): stipend_pool `E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM`, stream_loan `8JBd7epQXxdcKRMaWM1S5PC7nsQKoZq3uCetpiJ684g4`, capacity_stake `CH1rrfFyJMVn158UHL2fLpKTtoLJojrz5f68toMQdQKU`, USDG `2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH` (Token-2022), H081 `EgqxxR7zowzaLEm24oep5qqBieLVAWYX78LhgeqAJAo`.

## Install

```sh
# from npm (once published)
npx -y @h081lll/mcp --help

# from this repository
npm ci
npm run build --prefix integrations/mcp      # dist/cli.js
node integrations/mcp/dist/cli.js --help
```

Node 20.11 or newer. The proving artifacts (the circuits' wasm, zkey and verifying keys, ~75 MB in all) are not in the package: they are downloaded from `https://www.h081.xyz/circuits/` into `H081_CIRCUITS_DIR` (default `~/.h081/circuits`) the first time a circuit is needed, and every file's sha256 is checked against the hashes pinned in the package (the zkey/vkey hashes are the ceremony's, `docs/CEREMONY.md`) before it is written. A deposit or withdrawal needs `transact` (15 MB); a loan pledge needs `grant` (44 MB) and `stream` as well. To download them up front:

```sh
h081-mcp fetch-circuits
```

### Make an agent key

```sh
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/h081-agent.json
solana address -k ~/.config/solana/h081-agent.json     # fund this with a little SOL and the USDG to deposit
```

Use a key that holds only what the agent should be able to spend. The server process keeps it in memory.

## Claude Code

```sh
claude mcp add h081 -e H081_SOLANA_KEYPAIR=$HOME/.config/solana/h081-agent.json -- npx -y @h081lll/mcp
```

From a checkout instead of npm:

```sh
claude mcp add h081 -e H081_SOLANA_KEYPAIR=$HOME/.config/solana/h081-agent.json -- node /path/to/stipend-protocol/integrations/mcp/dist/cli.js
```

## Claude Desktop

`claude_desktop_config.json` (Settings > Developer > Edit Config):

```json
{
  "mcpServers": {
    "h081": {
      "command": "npx",
      "args": ["-y", "@h081lll/mcp"],
      "env": {
        "H081_SOLANA_KEYPAIR": "/Users/you/.config/solana/h081-agent.json"
      }
    }
  }
}
```

## Worked example: deposit, balance, withdraw

With the server added, ask the model:

> Show me the H081 protocol info, then deposit 25 USDG into my bank account, show my balance, and withdraw 10 USDG back to my wallet.

What happens, tool by tool:

1. `h081_protocol_info {}` returns the programs, the live caps (`caps.inVaultUsdg`, `caps.paused`), the relayer's terms (`minFee` 50000 = 0.05 USDG, `feeBps` 20, fee account = the treasury's USDG account) and the notice.
2. `h081_bank_deposit {"usdg": "25"}`: the server reads the caps and the wallet balances, refuses right away if the deposit is over 1,000 USDG, would push the bank over 10,000 USDG, deposits are paused, or the wallet lacks USDG or ~0.02 SOL; otherwise it makes the `transact` proof (about a second), stages it in a program buffer (a few transactions; the rent comes back) and sends the deposit. Result: `{"signature": "...", "amount": "25000000", "amountUsdg": "25", "shielded": "25000000", "shieldedUsdg": "25", "computeUnits": ...}`.
3. `h081_bank_balance {}`: `{"shieldedUsdg": "25", "walletUsdgHuman": "75", "walletSol": 0.19, "caps": {...}, ...}`.
4. `h081_bank_withdraw {"usdg": "10"}`: the relayer sends it; the fee is the smallest the relayer accepts (`max(0.05 USDG, 0.20 % of what the recipient receives)`), so `{"amount": "10000000", "fee": "50000", "received": "9950000", "receivedUsdg": "9.95", "via": "relayer", "to": "<agent wallet>"}`. With `"direct": true` the agent key sends it itself and `fee` is `0`. If the relayer is down the tool answers with an error (`the relayer ... is unreachable ... The withdrawal was not sent: retry later, or pass direct: true ...`) and nothing moves. A relayed withdrawal whose public amount is above the free tier (`{"usdg": "150"}`) names the agent wallet as capacity operator (`"operator": "<agent wallet>"` in the result) and goes through only with enough H081 staked; with none, it is refused before any proof with the staked capacity, the free tier and `direct: true` spelled out.

The same session over raw stdio, for a client of your own (one JSON-RPC message per line):

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"h081_bank_balance","arguments":{}}}' \
| H081_SOLANA_KEYPAIR=~/.config/solana/h081-agent.json npx -y @h081lll/mcp
```

A refused operation is a tool result with `isError: true` and a sentence that names the program's error (`DepositCapExceeded (6037, stipend_pool): the bank holds at most 10,000 USDG in total...`), never a protocol error; the model can read it and change course.

## Loans: what `h081_loan_borrow` is and is not

stream_loan has no offer book and no matching. A loan starts with a **lender** who opens a slot and hands the borrower an `h081-loan-terms:` code (the site makes one under Loans > Lend; it carries the slot, the pledge share in basis points and the lender's viewing key). The agent then:

1. `h081_loan_quote {"termsCode": "h081-loan-terms:...", "minRemainingUsdg": "100"}`: at 40 % (4000 bps) a 100 USDG pledge backs at most 40 USDG of principal; the protocol's origination fee is 0.25 % of the principal, taken out of the payout.
2. `h081_loan_borrow {"termsCode": "...", "budgetUsdg": "100", "dailyCapUsdg": "20", "maxPerTxUsdg": "10", "days": 30, "unlockDays": 30}`: grants a 100 USDG allowance from the shielded balance to one of the agent's 16 sub-accounts, unlocking as a stream over 30 days, with 40 % of every payment from it routed to the lender's slot; then makes the stream proof for the lender with the agent wallet's USDG account as the payout and returns it as an `h081-loan-proof:` code.
3. The agent hands `proofCode` to the lender. The lender funds the slot with exactly `principal` (the amount asked for with `principal`/`principalUsdg`, or by default the most the pledge can back; the program accepts no other figure), and the principal minus 0.25 % lands in `payoutAccount`.

Until a lender funds, nothing is borrowed: the budget sits in the pledged sub-account, spendable under its rules, with the lender's share routed if it is spent. The tool refuses terms for another cluster, program or asset, slots that do not exist or are already funded, and an unlock longer than the lifetime.

## Environment

| Variable | Meaning |
|---|---|
| `H081_SOLANA_KEYPAIR` | path to a Solana keypair JSON file: the agent key |
| `H081_SOLANA_KEY` | the same key as a base58 secret (or a JSON byte array); the file wins when both are set |
| `H081_ACCOUNT_SK` | optional shielded account secret (decimal or 0x hex); default: derived from the agent key's secret seed |
| `H081_DERIVE_ACCOUNT` | optional; `1` derives the account from the key's ed25519 signature over `h081/agent-account/v1` instead of its seed (the older construction). One such signature then holds the shielded balance: never combine with message-signing tools. |
| `H081_RPC_URL` | Solana RPC; default `https://api.mainnet-beta.solana.com`. The public RPC rate-limits the history scan a sync needs (`getSignaturesForAddress` / `getTransaction`); a private RPC makes the first sync much faster. The scanned public event log is cached under `<H081_CIRCUITS_DIR>/../cache`. Only the RPC's host is ever reported (tool results, `info`, logs): a private RPC's API key in the path or query stays out of transcripts. |
| `H081_RELAYER_URL` | relayer for withdrawals; default `https://api.h081.xyz`; empty = the agent key always sends directly (no relayed withdrawal is attempted). With a relayer set, a withdrawal that cannot go through it is refused, not sent directly. |
| `H081_CIRCUITS_DIR` | where the proving artifacts live; default `~/.h081/circuits` |
| `H081_CIRCUITS_URL` | where they are downloaded from; default `https://www.h081.xyz/circuits/` |
| `H081_MAX_DEPOSIT` | optional operator ceiling per deposit, base units, below the program cap |
| `H081_POOL_PROGRAM_ID`, `H081_LOAN_PROGRAM_ID`, `H081_CAPACITY_PROGRAM_ID`, `H081_SAFETY_PROGRAM_ID`, `H081_USDG_MINT`, `H081_STAKE_MINT`, `H081_LOAN_TREASURY`, `H081_CLUSTER` | override the mainnet ids (a rehearsal validator). Mainnet with a localnet id, or another cluster with the mainnet ids, is refused before anything is signed. |

`h081-mcp info` prints the resolved configuration, the live caps and the agent's addresses (read-only) and exits.

## Privacy and limits, plainly

- A deposit is public: the chain sees the agent wallet and the amount. What happens inside the bank (balances, sub-accounts, pledges) is private to the account's keys.
- A withdrawal through the relayer is sent by the relayer: the chain sees the recipient and the amount, not the agent wallet. A direct withdrawal is sent by the agent key, which the chain then links to the payout. Deposits are never relayed.
- The relayer fails closed. With `H081_RELAYER_URL` set (the default), a withdrawal that cannot go through the relayer (unreachable, wrong pool or asset, a fee account that is not the treasury's, a refusal) is not sent at all; the error says why and `direct: true` is the only way to have the agent key send it. The server never falls back to a direct send on its own.
- Relay fees go only to the protocol treasury (`EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq`, USDG account `DxpmCZYAoDKpHmA5vWuopUrf3UVuGnPvditVrN9xDwDo`): on mainnet the server checks the relayer's advertised fee account against exactly that address before a proof binds it, and refuses any other relayer. The loan origination fee goes to the same treasury.
- Relayed volume above the anonymous free tier (100 USDG per 30 days today) is put on the agent wallet's capacity: the agent key signs the relayer's capacity message and the relayer reads its H081 stake in capacity_stake (`h081_stake`). The relayer then learns which wallet the withdrawal belongs to (the chain still does not). Without enough stake the withdrawal is refused before any proof is made; `direct: true` has no limit.
- The shielded account secret comes from the agent key's secret seed, not from a signature, so a message-signing tool that shares the key cannot be tricked into revealing it. With `H081_DERIVE_ACCOUNT=1` (signature derivation) it can: signing `h081/agent-account/v1` with the agent key hands over the whole shielded balance.
- The cap checks run locally before a proof is made; a concurrent deposit can still make yours fail on chain (`DepositCapExceeded`), costing about a second of CPU and ~0.0072 SOL of refundable buffer rent.
- The SDK signs several transactions per operation; it needs the raw agent key. Hardware wallets and signer services are not supported.
- Not audited yet; use at your own risk.

## Development

```sh
npm run typecheck
npx vitest run test/integrations            # schemas, framing, the bank over a fake chain, keys, circuits, codes
H081_MAINNET_READ=1 npx vitest run test/integrations/mainnet-read.test.ts   # read-only check against mainnet
npm run build --prefix integrations/mcp
```

`src/mcp-core.ts` is the JSON-RPC framing shared with the EVM stipend server (`src/mcp.ts`); `integrations/core/` is the bank facade both this server and the Solana Agent Kit plugin (`integrations/solana-agent-kit/`) use.
