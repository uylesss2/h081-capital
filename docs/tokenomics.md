# H081 tokenomics (Phase 2)

> **Update 2026-10-31:** H081 is live on Solana, launched on Meteora's Dynamic Bonding Curve, not the launchpad.
> Official contract: `EgqxxR7zowzaLEm24oep5qqBieLVAWYX78LhgeqAJAo` (SPL token, 1,000,000,000 fixed supply, no mint or
> freeze authority, flat 2% trade fee: 0.4% Meteora, 1.6% creator; no presale, no dev buy). Website https://h081.xyz,
> X https://x.com/H081CAP. The launchpad route, fee split and vault described below are superseded; the Phase 2
> staking and insurance design still stands and is not deployed.

Status 2026-10-26: **no token is launched, and nothing in this repository is deployed to any chain.**
**Route decided: the main trading token H081 launches on Solana through the launchpad** (owner decision of
2026-10-26; guide in the launch guide). It is a Token-2022 coin with a fixed 1,000,000,000 supply. The
the EVM launchpad plan for Robinhood Chain is superseded. The bank product itself now also moves to Solana (owner decision
2026-10-26, `docs/SOLANA-PORT.md`); the two stay independent because the pool never reads the token (section 1). `contracts/token/StipendToken.sol` is a
testnet and test stand-in only; it is not deployed to any mainnet.
The contracts described here (`contracts/token/`) are built and tested in-process (`test/e2e/token.test.ts`)
and exist so that the economics are code, not a promise. The ticker `H081` is the working symbol of
H0.81 Capital, not a commitment; the name, symbol and supply are confirmed only at launch. The binding
design is `docs/PRD-V2-DESIGN.md` section 6.3.

## 1. The invariant: the pool never reads the token

`StipendPool` and `StreamLoan` have no reference to the token, to `CapacityStake` or to `SafetyPool`.
A pool user needs no H081 for anything: depositing, granting, spending, delegating, pledging, proving and
claiming all work without it. Capacity (section 3) is honoured by relayers and hosted endpoints, which can
refuse to submit a proof; the pool itself accepts any valid proof from anyone. This keeps the pool's
no-admin, no-pause, no-upgrade guarantee independent of the token, and it means a failed or never-launched
token cannot touch any user's funds.

## 2. Supply and emissions

| Item | Value |
|---|---|
| Contract | `contracts/token/StipendToken.sol`, OpenZeppelin ERC-20 |
| Name / symbol / decimals | "H0.81 Capital" / `H081` / 18 |
| Supply | fixed at deployment: the constructor's `supply` argument, minted once to the deployer |
| Emissions | none; there is no `mint`, no owner and no inflation path |
| Burn | none built in (holders may send to a dead address like any ERC-20) |
| Governance | none; the token carries no votes |

The table above describes the testnet stand-in `StipendToken.sol`. **The main trading token is the
the launchpad coin on Solana**: name "H0 81 Capital", symbol `H081`, X https://x.com/H081CAP, Token-2022,
1,000,000,000 supply, no transfer tax. The team alone funds the opening buy with 10 SOL (self-funded raise,
whitelist = the creator's wallet), which buys about 22% of supply into the launchpad's launch vault; there is no
presale and no free allocation. Curve trades pay 1.25%: 0.25% Raydium, 0.5% the launchpad, 0.5% creator fee,
which the launchpad's program splits 75% to the launch vault, 15% to the launchpad's buyback and 10% to backers (the
team, as sole backer). Holders receive nothing. At graduation the coin moves to a Raydium CPMM pool with
locked liquidity. Details, rehearsal and risks: the launch guide.

Phase 2 consequence: with the bank on Solana, staking and the safety pool sit on the same chain as the
token, so no bridge is needed. `CapacityStake.sol` and `SafetyPool.sol` stay in the repo as the EVM reference
implementation; they are being ported as the Solana programs `capacity_stake` and `safety_pool` for the H081
Token-2022 mint (`docs/SOLANA-PORT.md` section 3.3). Those programs are in build, not deployed to devnet or
mainnet, and ship only after Phase 1 and an external audit.

## 3. Capacity (`CapacityStake.sol`)

Staked H081 buys capacity, the thing that scales with the agent economy rather than with fees.

| Constant | Value | Meaning |
|---|---|---|
| `DESK_UNIT` | 100e18 (100 H081) | one desk (an allowance line an operator may run) per unit staked |
| `SHIELD_UNIT` | 100e18 (100 H081) | one shielding unit per unit staked |
| `SHIELD_PER_UNIT` | 10,000e6 (10,000 USDG, 6 decimals) | USDG a shielding unit lets you shield per 30 days |
| `COOLDOWN` | 7 days | from an unstake request to the tokens leaving |

The curve is linear and integer: `deskCapacity(a) = staked / DESK_UNIT`,
`shieldCap(a) = (staked / SHIELD_UNIT) * SHIELD_PER_UNIT`. 100 H081 buys one desk and 10,000 USDG of
shielding per month; 1,000 H081 buys ten desks and 100,000 USDG per month. `src/token.ts` exports the same
function in TypeScript so a relayer can price capacity without a chain call; the test checks the two agree.

Rules: `stake(amount)` counts at once; `requestUnstake(amount)` removes the amount from capacity at once and
starts the cooldown (a second request adds to the pending amount and restarts the cooldown for all of it);
`unstake()` pays the whole pending amount after the cooldown. No owner, no slashing, no rewards.

## 4. Safety pool (`SafetyPool.sol`)

A proof-settled insurance market for stream-backed loans. Stakers put H081 at risk; a lender buys cover for
a loan; if the loan goes unpaid the pool pays the lender. The settlement fact is chain state produced by
the spend circuit's routing (the `StreamLoan` registry's `repaid` and `shortfall`), so no oracle, keeper
or committee decides.

Mechanics:

- **Shares.** `deposit(amount)` mints shares at the current price `poolBalance / totalShares` (1:1 for the
  first deposit). Premiums raise the share price; slashes lower it. `redeemable(shares)` is the current value.
- **Unbonding.** `requestUnbond(shares)` starts a 14-day cooldown (`COOLDOWN`); the shares stay at risk
  until `withdraw()`, which redeems them at the price on the day of withdrawal.
- **Cover.** `insure(loanRef, premium)`: only the slot's lender in `StreamLoan`, only for a loan that is
  funded, not settled, has an expiry, and has not yet expired. The premium is transferred into the pool.
  One cover per `loanRef`.
- **Slash.** `slash(loanRef)` by anyone: the cover must exist and be unpaid, and `StreamLoan.shortfall(loanRef)`
  must be positive (expiry plus the 7-day grace passed, `repaid < principal`, not settled). The pool pays the
  cover's lender `min(shortfall, poolBalance)` of H081 and marks the cover paid. The shortfall is in the
  loan's asset base units and is paid 1:1 in H081 base units: a 6-decimal USDG shortfall of 1,000,000
  (1 USDG) pays 1,000,000 wei of H081. Pricing is explicitly out of scope for v1.
- **Empty pool.** A slash with nothing in the pool reverts (`pool empty`) so the cover stays open. A slash
  that takes the whole pool bumps the pool `generation`, which retires every share, including unbonding
  ones; the next deposit starts a fresh pool at 1:1.

Caveats the pricing work must address before any deployment:

- With lender-chosen premiums and 1:1 valuation, a lender can fund a loan to itself, let it lapse past the
  grace period and slash the pool for the principal. Until premiums are priced (or cover is underwritten),
  only stakers who trust the set of insurable lenders should deposit.
- The 1:1 valuation ignores the H081 price entirely. It is a placeholder for a priced design; the proposed
  design (not implemented) is `docs/LOAN-PRICING.md`.
- A loan on an allowance that never expires has no due date and never reports a shortfall, so it cannot be
  insured (`insure` requires an expiry).

## 5. Fee capture: platform fees buy back H081 (designed, not live)

Status 2026-10-31: **no platform fee is charged today and no buyback has happened.** The design below is in
build on branch `feat/flywheel`; the full specification is `docs/FLYWHEEL.md`. Every mainnet step needs an
explicit go from the owner.

**Only platform fees feed the flywheel.** These are fees the bank earns for services it provides:

| Source | Rate (v1) | Where it is charged |
|---|---|---|
| Our relayer | 0.20% of the public leg (withdrawals; public spends including the lender share), with a per-asset minimum that covers transaction costs | the proof's existing `fee` field, paid to the treasury's token account |
| Loan origination | 0.25% of principal, deducted from the payout (the slot still owes the full principal) | `stream_loan::fund`, compile-time constants, no admin |
| Paid services we host (MCP tools via x402) | per call | x402 `payTo` = treasury |

`stipend_pool` itself charges no fee and does not change: it has no owner, no fee switch and no treasury cut,
and anyone may run their own relayer or submit proofs directly.

Fees collect in a Squads 2-of-3 treasury multisig that is distinct from every launch wallet. Once a week the
treasury buys H081 on the official DAMM v2 pool (`CryBbh9QQttrUrfLVXLLEuhkM5wZ8W1DUZFYNhUEhYqs`) in
randomised small chunks with at most 1% slippage. Until the safety pool (section 4) is live, 100% of the
bought H081 is burned; after that, 50% is burned and 50% goes to `safety_pool.top_up`, which adds insurance
capital for lenders without minting shares. Because no shares are minted, a top-up raises what every
safety-pool share redeems for, so stakers who back loans benefit pro rata in return for carrying slashing
risk (section 4); it is not a fixed or promised return. Holding H081 outside the safety pool pays nothing. Every run is recorded in the public ledger `flywheel-ledger.json`.
Buybacks are ordinary trades and pay the pool's normal trading fee like any buyer.

**The token's trading creator fees are never part of the flywheel.** The 1.6% creator share of the 2% trade
fee is the team's income. It is not claimed, routed, swept or bought back with by any flywheel code, and the
launch wallets `2wjxKzH7fVGpjcA9KpjDBDHjSAhz7u8ZgMLnVPVGSkDP`, `FZEMfMN7hhQcKPHRt2kb9ig5XArMvK5LqfSTXpQ1j4DZ`
and `5XJNtM7a9ocRL8f8vsyNVmQoekutCFJkGNXNQbkJP4bw` are on a hard deny-list wherever the flywheel moves money.

The amount bought back depends only on how much the bank is used. Nothing here is a promise about the H081
price.

## 6. What is tested

`test/e2e/token.test.ts` (12 tests, in-process EVM, real Groth16 grant and stream proofs): token metadata
and the single mint; the absence of mint, owner, pause and upgrade selectors on all three contracts; the
capacity curve against `src/token.ts`; the unstake cooldown; two real pledged loans funded through
`StreamLoan`; share accounting; insure permissions and preconditions; slash refusals before the due date
and inside the grace period; a full slash paid to the lender with pro-rata staker loss; a shortfall larger
than the pool retiring every share.
