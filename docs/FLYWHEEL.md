# H081 flywheel: platform fees buy back H081

Status 2026-10-31: **design, in build on branch `feat/flywheel`. Nothing in this document is live.** No platform
fee is charged today, no treasury multisig exists yet, and no buyback has happened. Every step that moves real
money needs an explicit go from the owner (section 9).

This document is the specification for how fees the bank earns are used to buy H081 on the open market. It is
not an offer or a promise of any price or return. Holding H081 pays nothing. Once the safety pool is live, half
of the bought H081 is added to the safety pool, which raises what every safety-pool share redeems for: stakers
who back loans in that pool benefit pro rata (section 6).

## 1. Summary

```
agents use the bank ──► platform fees (USDG/SOL) ──► treasury (Squads 2-of-3 multisig)
        ▲                                                   │ weekly buyback on the DAMM v2 pool
        │                                                   ▼
 operators stake H081 for capacity            H081 ──► burn  (+ safety-pool top-up once live)
```

The protocol earns small fees for services it actually provides (relaying, loan origination, hosted paid
tools). Those fees collect in a treasury multisig. Once a week the treasury buys H081 on the official pool and
burns it; once the safety pool is live, half of what is bought goes into the safety pool instead.

## 2. The creator-fee firewall

**The H081 token's trading creator fees are NEVER part of the flywheel.** They are the team's income. They are
not claimed, routed, swept, swapped, bought back with, burned, or counted as a source by anything in this
design or in `scripts/flywheel/`. Only platform fees (section 3) feed the flywheel.

The launch wallets below are on a hard deny-list everywhere the flywheel moves money:

| Wallet | Role |
|---|---|
| `2wjxKzH7fVGpjcA9KpjDBDHjSAhz7u8ZgMLnVPVGSkDP` | launch wallet (creator-fee recipient) |
| `FZEMfMN7hhQcKPHRt2kb9ig5XArMvK5LqfSTXpQ1j4DZ` | launch wallet |
| `5XJNtM7a9ocRL8f8vsyNVmQoekutCFJkGNXNQbkJP4bw` | launch wallet |

Rules enforced in code and process:

- The treasury is a new Squads multisig whose address and members are distinct from every wallet on the
  deny-list.
- The flywheel scripts refuse to run if any signer, fee payer, source account or destination is on the
  deny-list.
- The flywheel scripts never import or call fee-claim code (the launch scripts' claim paths are out of scope
  and are not referenced).
- The treasury's inflows are only the platform-fee accounts in section 3. A transfer into the treasury from
  a deny-listed wallet is a bug and is reported in the ledger, not spent.

## 3. Platform fee sources (v1)

| Source | Rate | Mechanism | `stipend_pool` change? |
|---|---|---|---|
| Our relayer | 0.20% of the operation's public leg, with a per-asset minimum that covers transaction costs | the proof's existing `fee` field; the relayer requires `fee >= max(min, 0.20% x public amount)` and requires the fee account to be the treasury's token account for that asset (`RELAYER_SOLANA_TREASURY`, required; there is no fallback to the relayer's own wallet) | no |
| Loan origination (`stream_loan::fund`) | 0.25% of principal, deducted from the payout | compile-time `TREASURY` and `ORIGINATION_FEE_BPS = 25` constants in `stream_loan`, no admin key; the borrower's slot still owes the full principal | no (`stream_loan` only) |
| Paid services we host (MCP tools via x402) | per call, priced per tool | the x402 `payTo` address is the treasury | no |

Notes:

- `stipend_pool` charges no fee and does not change. It stays immutable, ownerless and blind to the token.
  Anyone can run their own relayer with its own fee, or submit proofs directly and pay only network fees.
- The relayer fee applies to withdrawals and public spends. The public leg is what leaves the pool's vault:
  the withdrawal amount, or a spend's public amount plus its lender share. Deposits are sent by the depositor
  and are not relayed.
- For small loans the 0.25% fee rounds down, so a loan under 400 base units pays no origination fee.
- If the treasury's token account for a loan asset is frozen (the asset's issuer froze it, or the mint creates
  accounts frozen), `fund` takes no fee rather than blocking every loan in that asset.
- `stream_loan`'s `TREASURY` is a placeholder until the treasury multisig exists. Every production build
  (including `solana/scripts/verifiable-build.sh`) refuses to compile while it is the placeholder; only the
  localnet test builds opt in with the `localnet-treasury` feature. It must be set to the Squads vault before
  any deploy.
- Fees are collected in whatever asset the operation used (USDG, SOL). They are not converted until the
  weekly buyback.
- Rates are fixed for v1. `ORIGINATION_FEE_BPS` is a constant in an immutable program, so changing it means a
  new program; the relayer rate is relayer configuration and any change is announced and recorded in the
  ledger.

## 4. Treasury

- A Squads multisig, threshold 2 of 3. Its members are owner-held keys that are not any launch wallet.
- It holds the platform-fee token accounts (one associated token account per fee asset) and pays for the
  buyback transactions.
- It signs nothing alone: `scripts/flywheel/buyback.mts` builds a Squads proposal; two members approve and
  execute it.
- The treasury address and every fee account are published in `flywheel-ledger.json` and on
  https://h081.xyz/token once the treasury exists.

## 5. Buyback schedule

- **Frequency:** weekly.
- **Venue:** H081 is bought only on the official Meteora DAMM v2 pool
  `CryBbh9QQttrUrfLVXLLEuhkM5wZ8W1DUZFYNhUEhYqs` (H081/SOL) for the mint
  `EgqxxR7zowzaLEm24oep5qqBieLVAWYX78LhgeqAJAo`, using `@meteora-ag/cp-amm-sdk`. No other H081 pool or
  aggregator route.
- **Size:** the treasury's platform-fee balance at the time of the run, less a small SOL reserve for
  transaction costs. Fees collected in USDG are first converted to SOL on a liquid USDG/SOL pool named in the
  run's ledger entry, under the same 1% slippage cap.
- **Execution:** split into small chunks with randomised sizes and timing within the week's window, each
  chunk with a maximum slippage of 1%. A chunk that would exceed 1% is skipped and carried to the next run.
- **Dry run by default:** the script prints the plan (amounts, quotes, accounts) and changes nothing unless it
  is run with an explicit execute flag, and even then it only creates a Squads proposal.
- **Fresh price check per chunk:** each chunk's minimum output is fixed when the proposal is built, but chunks
  execute over hours. Right before executing a chunk, the executor runs `buyback.mts check`, which re-quotes the
  pool live and answers GO only if the frozen minimum is still within 1% of the live quote and the chunk is not
  past its `notAfter` time (suggested time + 60 minutes). On NO-GO the chunk is skipped and the run re-planned.
- **Record:** `buyback.mts record` only accepts signatures that carry out a transaction of that proposal (same
  programs, accounts and data), and notes skipped chunks or a missing settle in the ledger entry.
- **Programs:** on mainnet only the official mint and pool are accepted, and the top-up only calls the pinned
  mainnet `safety_pool` program id (none until it is deployed, so until then every run is 100% burn).

**Disclosure:** a buyback is an ordinary trade on the pool. It pays the pool's normal trading fee like any
other buyer (today 2% of each trade: 0.4% to Meteora, 1.6% to the creator). The flywheel gets no discount and
no special route. Buybacks also move the price; the chunking and slippage cap limit that, they do not remove
it.

## 6. Split of bought H081

| Phase | Burn | `safety_pool.top_up` |
|---|---|---|
| Until the safety pool is live on mainnet | 100% | 0% |
| After the safety pool is live | 50% | 50% |

- **Burn** uses the SPL token `burn` instruction from the treasury's H081 account, which reduces the total
  supply. Supply is fixed (no mint authority), so burned tokens cannot be re-created.
- **Top-up** calls `safety_pool::top_up(amount)`: the H081 goes into the safety pool's vault and raises its
  assets without minting shares. It increases the cover available to lenders whose stream-backed loans
  default, and, because no shares are minted, **it raises the H081 every outstanding safety-pool share redeems
  for: stakers benefit pro rata**, funded by platform fees. This is compensation for the risk stakers carry
  (their H081 can be slashed for loan shortfalls, `docs/tokenomics.md` section 4), not a fixed or promised
  return: its size depends only on how much the bank is used, and slashes can take more than top-ups add.
  `top_up` refuses when the pool has no shares, so the flywheel only tops up a pool that has stakers.
- A top-up is credited at once to whoever holds shares when it executes (unbonding shares included), and a
  Squads proposal is visible on-chain before it executes. Someone could deposit just before a top-up and
  unbond right after, taking a pro-rata part while carrying 14 days of slashing risk. To limit this, top-ups
  are kept small and frequent (each weekly run, never accumulated). Streaming top-ups over time is a possible
  later change to `safety_pool`.
- The staker benefit described here must be part of the legal review (section 9) before it is announced.

## 7. Public ledger

Every run appends one entry to `flywheel-ledger.json` (in the repository, and mirrored as
`src/data/flywheel.json` on the site once the owner approves that page). Each entry records:

- run date, dry-run or executed, and the Squads proposal address;
- platform fees collected since the previous run, per source (relayer, origination, hosted services) and per
  asset, with the fee accounts read;
- each buyback chunk: amount in, H081 out, quoted and realised price, slippage, transaction signature;
- H081 burned and H081 topped up, with transaction signatures;
- a deny-list check result (no deny-listed wallet appeared as signer, source or destination).

Entries are append-only. A mistake is corrected by a new entry, not by editing an old one.

## 8. Demand side (utility)

Separate from the buyback, our relayer and hosted endpoints honour capacity from `capacity_stake`: 100 H081
staked buys one desk and 10,000 USDG of shielding per 30 days (`docs/tokenomics.md` section 3), with a free
tier below a threshold. Capacity counts 6-decimal (USDG) amounts only; the relayer refuses to start with any
other capacity asset. This is a service limit our infrastructure enforces; the pool itself accepts any valid
proof from anyone and never reads the token.

## 9. Owner-go gates

Each of these needs an explicit go from the owner before it happens. Without it, work stops at local
validator tests and dry runs.

- creating the treasury multisig;
- deploying `stream_loan`, `safety_pool` or `capacity_stake` to any public cluster;
- running the relayer on mainnet with the 0.20% fee;
- any mainnet buyback, burn or top-up;
- any site deploy, including the `/token` flywheel section.

A legal review of the flywheel wording, including the safety-pool staker benefit (section 6), is recommended
before it is announced.

## 10. What this is not

- It does not touch the token's trading creator fees (section 2).
- It does not change `stipend_pool`, the circuits or the proving keys.
- It pays nothing to holders for holding H081. The only party that benefits directly is safety-pool stakers,
  through top-ups that raise their shares' value in return for carrying slashing risk (section 6).
- It makes no promise about the H081 price, volume or the size of future buybacks; those depend entirely on
  how much the bank is used.
