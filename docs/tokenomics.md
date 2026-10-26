# H081 tokenomics (Phase 2)

Status 2026-10-26: **no token is launched, and nothing in this repository is deployed to any chain.**
**Route decided: the main trading token H081 launches on Solana through the launchpad** (owner decision of
2026-10-26; guide in the launch guide). It is a Token-2022 coin with a fixed 1,000,000,000 supply. The
the EVM launchpad plan for Robinhood Chain is superseded. The bank product itself still targets Robinhood Chain; the two
are independent because the pool never reads the token (section 1). `contracts/token/StipendToken.sol` is a
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

Phase 2 consequence: `CapacityStake` and `SafetyPool` are EVM contracts for Robinhood Chain and cannot hold a
Solana token. Capacity needs no bridge, because relayers enforce it and can read H081 stakes on Solana
directly. The safety pool pays lenders from Robinhood loan shortfalls, so with a Solana token it needs a
bridge or a redesign before it can ship. Neither is built yet.

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
- The 1:1 valuation ignores the H081 price entirely. It is a placeholder for a priced design.
- A loan on an allowance that never expires has no due date and never reports a shortfall, so it cannot be
  insured (`insure` requires an expiry).

## 5. Fee capture: none at launch

The protocol charges no fee. There is no fee switch, no treasury cut on spends, and the pool has no owner
who could add one. Relayer fees are paid in the spent asset to the relayer named in the proof, and only for
operations with a public leg. H081 captures no protocol revenue.

The EVM launchpad launch pays the 90% beneficiary share of the 2% trading tax in ETH straight to the creator wallet
(owner decision of 2026-10-26: no receiver, timelock or restriction). That is the team's income, not fee
capture by the protocol and not a holder payout.

## 6. What is tested

`test/e2e/token.test.ts` (12 tests, in-process EVM, real Groth16 grant and stream proofs): token metadata
and the single mint; the absence of mint, owner, pause and upgrade selectors on all three contracts; the
capacity curve against `src/token.ts`; the unstake cooldown; two real pledged loans funded through
`StreamLoan`; share accounting; insure permissions and preconditions; slash refusals before the due date
and inside the grace period; a full slash paid to the lender with pro-rata staker loss; a shortfall larger
than the pool retiring every share.
