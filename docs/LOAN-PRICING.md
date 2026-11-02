# Loan pricing for the safety pool (design, not implemented)

Status 2026-10-31: **design only.** Nothing in this document is implemented, deployed or audited. The
`safety_pool` program (`solana/programs/safety_pool`) and its EVM reference `contracts/token/SafetyPool.sol`
are unchanged by it and still behave as described in `docs/tokenomics.md` section 4. Every number below
marked "proposed" is a starting value for the owner to accept or change, not a measured or tested figure.
Every price figure in an example is hypothetical; this document does not state the market price of H081.

## 1. The problem today

`safety_pool` has two placeholders that make it unsafe to stake into for anyone who does not trust every
insurable lender:

1. **Valuation is 1:1 in base units.** `slash` pays `min(shortfall, assets)` of the pool's token, where the
   shortfall is in the loan asset's base units. For an H081 pool insuring a USDG loan (both 6 decimals: H081
   per the launch configuration, USDG per the asset list), 1 USDG of shortfall pays 1 H081. That is correct
   only if H081 trades at exactly 1 USDG. At any other price either the lender receives cover worth a
   fraction of its loss, or the stakers pay out many times the loss.
2. **Premiums are lender-chosen.** `insure(loan_ref, premium)` accepts any premium, including 0.

Behind both sits a third problem that no price fixes: **self-dealing.** A lender can fund a loan to an
allowance it owns itself. The principal goes to itself, the stream routes to itself, and every step costs
it nothing but fees. It then lets the loan lapse past expiry plus the 7-day grace and slashes. Its profit is
the cover minus the premium. For a self-lender the default probability is 1, so any premium below 100% of
the cover leaves the attack profitable. A risk curve prices honest credit risk; it cannot price this.
Section 5 deals with it separately.

What must not change: the **shortfall** stays chain state produced by the spend circuit's routing
(`stream_loan`'s `principal`, `repaid`, the unsynced inbox and the pool escrow). No price, oracle or keeper
decides whether a loan defaulted. A price is needed only to decide how many H081 tokens a given shortfall
is worth. And `stipend_pool` keeps never reading the token, `capacity_stake` or `safety_pool`
(`docs/tokenomics.md` section 1); every change below is inside `safety_pool`.

## 2. Market facts the design rests on

| | |
|---|---|
| H081 mint | `EgqxxR7zowzaLEm24oep5qqBieLVAWYX78LhgeqAJAo`, SPL token, 1,000,000,000 fixed supply, no mint or freeze authority |
| Venue | graduated from the Meteora Dynamic Bonding Curve to a Meteora DAMM v2 pool, `CryBbh9QQttrUrfLVXLLEuhkM5wZ8W1DUZFYNhUEhYqs`, paired with SOL |
| Trade fee | flat 2% per buy and sell (README); whether the DAMM v2 pool's fee schedule is exactly this must be read from the pool account |
| Loan assets | USDG (6 decimals) and xStocks; the shortfall is denominated in the loan asset |

Consequences:

- **H081 is priced in SOL, not in USD.** Valuing H081 against a USDG shortfall needs two legs: H081/SOL
  from the DAMM v2 pool and SOL/USD from somewhere else. USDG is then taken as 1 USD (an assumption with
  its own depeg risk). An xStock shortfall would need a third leg, the stock price.
- **A single pool is the only venue we control references for.** Aggregators (Jupiter) route through it;
  other pools may appear. The design reads one named pool and treats a migration of liquidity elsewhere as
  a reason to create a new safety pool, not to repoint an existing one (there is no admin to repoint it).
- **DAMM v2 keeps the current price, not a price history.** To our knowledge the DAMM v2 (`cp-amm`) pool
  account holds the current `sqrt_price` (Q64.64), the active `liquidity`, the two mints and vaults and the
  fee state, but no cumulative-price accumulator or observation buffer like Uniswap v3's. This must be
  confirmed against Meteora's published IDL and program id (`cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`
  as we understand it) before any code is written. If it holds, a TWAP has to be built by `safety_pool`
  itself from samples (option D below).
- **Whether the pool's liquidity is locked** depends on the migration configuration the launch used. If LP
  positions are permanently locked, depth cannot be withdrawn suddenly; if not, depth can vanish. The
  design does not rely on either and measures depth at each sample.

## 3. Options for valuing H081 against a shortfall

Two questions are separate and are often mixed up:

- **What price source** (A to F below).
- **When the conversion happens**: at `slash` (the pool owes a USD amount and pays however many tokens that
  is on the day) or at `insure` (the cover is fixed as a number of tokens on the day it is bought).

### When to convert: at insure, not at slash

Converting at slash has three defects. The price must be read exactly when a defaulting party has the
strongest incentive to push it down (fewer USD per token means more tokens out). It is reflexive: slashes
are paid in H081, lenders sell it, the price falls, the next slash takes more tokens. And it makes payout
liveness depend on the oracle: a stale feed blocks a lender from being paid.

Converting at insure fixes the cover as `cover_tokens` H081 when the lender buys it. Stakers know their
maximum loss in tokens per cover; premiums are a fraction of `cover_tokens` and need no price at all; the
slash needs no price and works when every feed is down. The cost is that the lender carries H081 price risk
between insure and slash. That risk is wrong-way: defaults and an H081 drawdown are likely to coincide. The
lender can compensate by buying a buffer (parameter `b` below), and the alternative of a USDG-denominated
pool (option B) removes it entirely.

**Recommendation: convert at insure, pay pro rata in tokens at slash.** The rest of this section is about
the price used at insure.

### A. Keep 1:1 (status quo)

Correct only when the loan asset is the pool's mint. For an H081 pool insuring USDG loans it is an implicit
price of 1 USDG per H081 with no relation to the market. Not acceptable for any deployment that takes
stakers' H081 against USDG loans.

### B. Same-asset pools, no price at all

`safety_pool` is already per mint. A pool whose mint is USDG insuring USDG loans is priced correctly by the
existing 1:1 rule. The only change is one check in `insure`: `slot.asset == config.mint`. This needs no
oracle, no TWAP and no new accounts. It does not give H081 a role in insurance; H081 would keep its
capacity role only, or act through a separate first-loss mechanism. It still needs sections 4 and 5
(premiums, self-dealing), which are independent of price.

### C. Spot price from the DAMM v2 pool

Read `sqrt_price` in the `insure` transaction. Rejected: an attacker can swap the price down, insure, and
swap back inside one transaction, paying only the trade fee on the round trip (about 4% at a 2% fee) plus
the impact it gives back, against a cover that can be many times that. Spot is used only as a guard next
to a TWAP (option D).

### D. TWAP built by `safety_pool` from the DAMM v2 pool, plus Pyth SOL/USD

`safety_pool` keeps its own observation buffer for the pool's named DAMM v2 pool and a permissionless
`observe` instruction that anyone may call:

- `observe` checks the account is owned by the DAMM v2 program, has the expected address and pool
  discriminator, and that its two mints are H081 and wrapped SOL (the order is recorded once at init). It
  writes one sample `(unix_time, slot, sqrt_price, h081_reserve)` into a ring buffer of `N` samples.
- **At most one sample per `MIN_INTERVAL`** (proposed 60 s) and at most one per Solana slot, so an attacker
  cannot fill the window from one transaction or one slot.
- **Per-sample clamp.** A sample whose price moved more than `MAX_STEP_BPS` (proposed 1,000, i.e. 10%) from
  the previous recorded sample is recorded at the clamped value (a truncated oracle). A real move is
  followed after a few samples; a one-slot spike is not.
- **Median, not mean**, over the samples in the last `WINDOW` (proposed 1 h, needing at least `MIN_SAMPLES`,
  proposed 30). To move the median, an attacker must hold the price off market at more than half of the
  sample times, across separate slots, while arbitrage trades against it each time and every round trip
  pays the trade fee. The median is taken over `sqrt_price`, which is monotone in price, so no squaring or
  logs are needed to compare.
- **Staleness fails closed.** Fewer than `MIN_SAMPLES` in the window, or a newest sample older than
  `2 * MIN_INTERVAL`, and `insure` refuses (`PriceStale`). Slashes are unaffected.
- **Spot divergence guard.** `insure` also reads the live `sqrt_price`; if it differs from the median by
  more than `MAX_DIVERGENCE_BPS` (proposed 1,000), `insure` refuses. This stops buying cover at a stale
  median during a real crash, and makes in-block manipulation of spot pointless.

SOL/USD comes from a Pyth pull-oracle price update account (`PriceUpdateV2`, posted by the caller in the
same transaction or earlier) for the SOL/USD feed id fixed at pool init. Checks: the account is owned by
the Pyth receiver program, the feed id matches, `publish_time` is within `MAX_PYTH_AGE` (proposed 60 s),
and `conf / price` is below `MAX_CONF_BPS` (proposed 100, i.e. 1%). USDG is valued at 1 USD.

The reference price used at insure is the **higher** of the TWAP median and spot, times the **upper** end of
the Pyth confidence interval. A higher H081 price means fewer tokens per USD of cover, so this choice is the
one that is bad for the party who would manipulate it (the lender buying cover, who wants a low price).

Cost and liveness: someone has to call `observe` roughly every minute or `insure` stops working. Each call is
one transaction fee (the base fee is 5,000 lamports per signature at the time of writing, plus any priority
fee). The natural callers are the pool's underwriter (section 5) or a relayer; a lender about to insure can
also post the remaining samples itself, but cannot do it in less than `WINDOW`. Compute cost is not measured;
a median over 60 `u128` values and two account decodes should be far below the existing grant budget, but
this has to be measured on the local validator.

### E. An external H081 oracle

No Pyth feed for H081 is known to us. A Switchboard On-Demand feed could be defined from DEX or Jupiter
prices. It moves the trust from our own sampling to the feed definition and its oracle operators, adds a
dependency the protocol cannot audit end to end, and for a thinly traded token its sources ultimately
read the same DAMM v2 pool. It is a reasonable fallback if option D's keeper cost or compute cost proves a
problem; it is not better on manipulation, because the underlying market is the same.

### F. A fixed rate declared at pool creation

The pool creator fixes `usd_per_h081` (and so the pool's terms) at `init_pool`, immutable. Stakers who
disagree do not deposit. No oracle at all, but the rate is wrong the day after it is set, and with no admin
it can never be corrected, only abandoned for a new pool. Useful only as a short-lived bootstrap, or as an
upper bound on the price combined with option D (`price = min(twap, declared_cap)`), which limits the damage
of an upward manipulation that nobody has an incentive to do anyway.

### Haircut, depth and caps (apply to D, E or F)

A large block of H081 cannot be sold at the mid price. If the lender is to be made whole in USD, the cover
must be valued at what it would fetch, not at the mid. With the pool's H081 reserve `X` (from the minimum of
`h081_reserve` over the window, so a temporary liquidity deposit cannot inflate it) and a full-range
constant-product approximation, selling `T` tokens fetches on average `P / (1 + T / X)` before fees. The
effective haircut is

```
h(T) = H0 + T / (X + T) + fee
```

where `H0` (proposed 2,000 bps, 20%) covers price drift between insure and slash. The haircut works for the
lender: the lower the value per token, the more tokens a given USD exposure needs. Stakers are protected not
by the haircut but by the caps on tokens:

- **Per loan:** `cover_tokens <= MAX_COVER_BPS * assets / 10000` (proposed 500, 5% of the pool) and
  `cover_tokens <= MAX_DEPTH_BPS * X / 10000` (proposed 1,000, 10% of the DAMM v2 H081 reserve), so no single
  payout is unsellable.
- **Per pool:** `outstanding_cover + cover_tokens <= MAX_UTIL_BPS * active_assets / 10000` (proposed 5,000),
  where `active_assets` excludes the value of shares already unbonding (section 6).
- **Per loan, against its exposure:** `cover_tokens * P_ref * (1 - h(cover_tokens)) <= covered_amount * (1 + b)`
  in USD, where `covered_amount <= principal - repaid` is in the loan asset and `b` (proposed at most 2,000
  bps) is a buffer the lender may buy against H081 falling before a slash.

If the caps bind, the lender gets partial cover and the cover records the ratio; it is never silently
over-insured.

## 4. Pricing premiums

Because cover is fixed in tokens and premiums are paid in the same token, the premium is a rate on
`cover_tokens` and needs no price:

```
premium_tokens = cover_tokens * rate_bps / 10000
rate = (BASE_APR * m(C) + u(U)) * term / YEAR
```

All inputs are on chain at insure time, mostly in the stream_loan slot `safety_pool` already reads
(`stream_loan_view.rs` mirrors every field used here):

- **term** = `expiry - now` at insure. Capped: `term <= MAX_TERM` (proposed 90 days), so exposure is bounded.
- **C, the stream-secured ratio.** The stream proof the lender checked at funding put `min_remaining`,
  `min_rate`, `pledge_bps`, `stream_start` and `expiry` into the slot. If the borrower keeps delivering memos
  and the lender claims, the routing alone should return at least
  `F = pledge_bps * min(min_remaining, min_rate * (expiry - max(stream_start, funded_at))) / 10000`
  by expiry (spends and owner reclaims both route the share; claims pull vested shares). `C = min(1, (repaid + F) / principal)`.
  A loan whose pledge covers its principal is safer than one that relies on the borrower choosing to repay.
  `C` measures what should come back, not what will: a borrower who spends once and withholds the
  successor memo leaves the lender unable to claim (`opaque`), and that is exactly the default the cover
  insures.
- **m(C)**, a piecewise-linear multiplier in bps over a small fixed table, proposed: `C >= 1.0` gives 1.0x,
  `0.75` gives 1.5x, `0.5` gives 2x, `0.25` gives 3x, `0` gives 4x.
- **U, utilization after this cover**, `(outstanding_cover + cover_tokens) / active_assets`, and a kinked
  add-on in the style of lending-market rate curves:
  `u(U) = S1 * U / U_KINK` for `U <= U_KINK`, `S1 + S2 * (U - U_KINK) / (MAX_UTIL - U_KINK)` above it, and a
  refusal above `MAX_UTIL`. Proposed `BASE_APR` 800 bps, `S1` 400 bps, `S2` 4,000 bps, `U_KINK` 3,000 bps,
  `MAX_UTIL` 5,000 bps.
- **Floor, not a price.** The program computes `min_premium` from the curve and refuses a smaller premium.
  The lender may pay more, and an underwriter (section 5) may require more by quoting a higher rate. The
  rounding direction is up, in favour of stakers.

Worked example (every figure hypothetical): principal 10,000 USDG, `repaid` 0, `pledge_bps` 4,000 and a
stream proof giving `F` = 5,000 USDG, so `C = 0.5`, `m = 2.0x`. Term 60 days. The lender covers
`covered_amount` = 6,000 USDG with no buffer. Suppose `P_ref` = 0.002 USD per H081 and `h` = 30% in total.
Then `cover_tokens = 6,000 / (0.002 * 0.7)` = 4,285,714 H081. With a pool of 100,000,000 H081 active and
20,000,000 already outstanding, the per-loan cap (5,000,000) holds and `U` = 24.3%, so `u` = 400 * 24.3 / 30
= 324 bps a year. `rate = (800 * 2.0 + 324) * 60 / 365` = 316 bps, and the minimum premium is about
135,500 H081 (3.16% of the cover). Against a self-lender (section 5) that premium buys a 4.29M-token payout,
which is why the curve alone is not enough.

Options considered and not recommended: a pure lender-chosen premium (status quo; no floor); an on-chain
auction per cover (heavy, slow, and still gamed by a self-lender who is also the only bidder's
counterparty); premiums streamed over the term (more instructions, and a lapsed stream leaves stakers
uncompensated exactly when risk is highest). Premium refunds on early repayment are left out to keep the
accounting monotone; an owner decision can add them later.

## 5. Self-dealing: underwritten pools

No valuation or curve makes self-lending unprofitable, because a self-lender's expected loss is zero and
its payout is the cover. The options are:

1. **Keep pools open and say so.** Today's caveat: only stakers who trust every possible lender should
   deposit. In practice, nobody should.
2. **Underwritten pools (recommended).** The pool's PDA becomes `["safety", mint, underwriter]`, with an
   immutable `underwriter` pubkey set at `init_pool`. `insure` requires the underwriter's signature in the
   same transaction (a second signer; no ed25519 introspection is needed). The underwriter decides off chain
   which lenders and borrowers it believes, and can quote above the on-chain floor. It **cannot** move
   funds, change parameters, pause or block slashes and withdrawals; it can only approve or decline covers,
   and every cover it approves is still bound by every on-chain cap and floor in sections 3 and 4. Stakers
   choose which underwriter's pool to stake in. A colluding underwriter can still approve self-lent covers;
   the per-loan cap, the utilization cap and the premium floor bound how fast it can drain the pool, and
   the full trail is public (`Insured` events name the loan and lender). `Pubkey::default()` as underwriter
   keeps an open pool for those who want it, with the caveat restated in the program docs.
3. **Seasoning.** Cover only becomes slashable if the loan had already repaid some fraction of principal
   before expiry, or only covers `principal - repaid` above a deductible. Self-dealers repay themselves for
   free, so this raises the attacker's capital lock-up but not its cost. Useful as a parameter, not as the
   defence.

This is the one place the design introduces a trusted role. It is opt-in per pool, it holds no funds and
no admin power over the program, and the shortfall that triggers a slash stays oracle-free and
underwriter-free.

## 6. Failure modes and defences

| Failure | Mechanism | Defence in this design | Residual risk |
|---|---|---|---|
| Price manipulation down at insure | lender sells H081 to lower the price, buys cover for more tokens | TWAP median over a window with per-sample clamp and one sample per interval; reference price is max(median, spot); spot-divergence refusal; per-loan token caps | an attacker with enough capital to hold the price down for over half of the window, paying arbitrage losses and fees each sample; bounded per loan by the caps |
| Price manipulation at slash | defaulter pushes price to change the payout | slash uses no price (tokens fixed at insure) | none from price |
| Price manipulation up | a higher price gives the lender fewer tokens, so no insuring party gains | optional declared cap (option F) | the lender is under-covered in USD; premiums, being in tokens, are unaffected |
| Thin liquidity | a large payout cannot be sold near the mid; a temporary liquidity deposit inflates depth | haircut includes impact `T / (X + T)`; `X` is the window minimum of the H081 reserve; per-loan cap of 10% of `X` | the lender may still realize less than its loss in a crash; it chose the buffer |
| Liquidity moves venue | the DAMM v2 pool stops being the main market | samples track depth; a pool with low `X` simply allows little cover | the pool's price source is immutable; a new safety pool must be created for a new venue |
| Oracle risk (Pyth SOL/USD) | stale, wide or wrong SOL/USD | staleness and confidence checks fail closed at insure; the slash never reads Pyth | a wrong but confident Pyth price at insure mis-sizes covers taken in that window, bounded by caps |
| Keeper failure | nobody calls `observe` | insure refuses until the window is refilled | no new covers for up to `WINDOW`; existing covers and slashes unaffected |
| USDG depeg | USDG is valued at 1 USD | none in-program | covers in a depeg are mis-sized by the depeg; owner decision whether to read a USDG feed too |
| xStock loans | need a stock price | not insurable under the recommendation (`slot.asset` must be in an allow-list fixed at init, proposed USDG only) | none; feature deferred |
| Bank run on unbonding | stakers see `repaid` lag (public) and unbond before a slash lands | see below | stakers who unbonded before a cover was bound leave without sharing its loss, as intended |
| Correlated defaults with an H081 drawdown | many loans default while H081 falls | utilization cap 50%, per-loan cap 5%, cover fixed in tokens so the drawdown does not raise the pool's token loss | lenders' covers are worth less in USD exactly then (wrong-way risk); option B avoids it |
| Self-dealing | section 5 | underwriter gate, caps, floor premium | a colluding underwriter |

**Bank run on unbonding, in detail.** Today a staker who requests an unbond waits 14 days with the shares at
risk. A cover binds before expiry and is slashable from expiry plus 7 days, so a staker who unbonds as soon
as a loan looks weak (its `repaid` is public) can leave before the slash; those who stay take the whole
loss. Two changes close this:

- **Exposure-aware cooldown.** The config tracks `exposure_end`, the latest
  `expiry + GRACE + CLAIM_WINDOW` over covers bound so far (a running maximum). `request_unbond` sets
  `ready_at = max(now + COOLDOWN, exposure_end)`, read at request time. Covers bound after the request do not
  extend it, so the exit always ends; with `MAX_TERM` 90 days and `CLAIM_WINDOW` (proposed 30 days) the
  longest wait is about 127 days. That is a large change for stakers and is listed as an owner decision.
- **Unbonding capital does not back new cover.** The config tracks `unbonding_shares`; the capacity for new
  covers is computed on `active_assets = assets * (total_shares - unbonding_shares) / total_shares`. Departing
  stakers are not counted as backing covers they will not be there to pay.
- **Claim window.** A cover must be slashed by `expiry + GRACE + CLAIM_WINDOW`; after that a permissionless
  `release_cover` marks it lapsed and frees its `cover_tokens` from `outstanding_cover`. Without it, stale
  covers would hold capacity and exposure forever.

## 7. Recommendation

1. **Fix covers in tokens at insure; slash pays pro rata in tokens with no price read:**
   `pay = min(cover_tokens * min(shortfall, covered_amount) / covered_amount, assets)`.
2. **Value H081 at insure with option D:** a median of `safety_pool`'s own samples of the DAMM v2 pool
   `CryBbh9QQttrUrfLVXLLEuhkM5wZ8W1DUZFYNhUEhYqs`, times Pyth SOL/USD, reference = max(median, spot) at the
   upper confidence bound, refusing on staleness or divergence; USDG at 1 USD; only USDG loans insurable.
3. **Cap every cover** by 5% of active pool assets, 10% of the DAMM v2 H081 reserve, the pool's 50%
   utilization ceiling and the loan's own uncovered exposure with an exit-value haircut.
4. **Enforce a premium floor** from the curve in section 4; the lender or underwriter may go higher.
5. **Gate insure behind an immutable per-pool underwriter**, with open pools still possible and labelled.
6. **Bound exposure in time** with `MAX_TERM`, `CLAIM_WINDOW`, `release_cover`, the exposure-aware cooldown and
   unbonding shares excluded from capacity.
7. **Fix every parameter at `init_pool`**, immutable, stored in the config. There is no admin; new parameters
   mean a new pool, and stakers move if they agree.

If the owner prefers no price at all, option B (a USDG safety pool, with sections 4 to 6 still applied)
is the simpler and safer product, and H081 keeps its capacity role.

## 8. Exact changes it would need

None of these are made. They are listed so the work can be estimated and audited.

### `solana/programs/safety_pool` (the target)

State:

- `SafetyConfig` gains: `underwriter: Pubkey`; `price_pool: Pubkey` (the DAMM v2 pool), `h081_is_token_a: bool`,
  `quote_mint: Pubkey` (wrapped SOL), `pyth_feed_id: [u8; 32]`; `insurable_asset: Pubkey` (USDG; or a short
  fixed list); a `Params` struct (`haircut_bps`, `max_buffer_bps`, `max_cover_bps`, `max_depth_bps`,
  `max_util_bps`, `u_kink_bps`, `base_apr_bps`, `s1_bps`, `s2_bps`, `m_table: [(u16, u16); 5]`, `max_term`,
  `claim_window`, `window`, `min_interval`, `min_samples`, `max_step_bps`, `max_divergence_bps`,
  `max_pyth_age`, `max_conf_bps`); `outstanding_cover: u64`; `unbonding_shares: u128`; `exposure_end: i64`.
- Config PDA seeds become `["safety", mint, underwriter]`, so a squatter cannot occupy a mint's only pool
  with bad parameters, and several underwriters can run pools for the same mint. The vault seed follows.
- New account `PriceObs`, PDA `["obs", config]`: ring buffer of `N` (proposed 64) samples
  `{ ts: i64, slot: u64, sqrt_price: u128, h081_reserve: u64 }`, a head index and the last recorded price.
- `Cover` gains: `asset: Pubkey`, `covered_amount: u64` (loan asset units), `cover_tokens: u64`,
  `rate_bps: u32`, `price_ref` (the reference sqrt price and SOL/USD used, for audit), `expiry: u64` (snapshot),
  `lapsed: bool`.
- `Position` is unchanged in layout; `request_unbond` and `withdraw` maintain `config.unbonding_shares`.

Instructions:

- `init_pool(params, underwriter, price_pool, pyth_feed_id, insurable_asset)`: validates the DAMM v2 pool
  account (owner, discriminator, that one mint is the pool's mint and the other is wrapped SOL), records
  token order, initializes `PriceObs`. Parameters are range-checked (for example `max_util_bps <= 10000`,
  `u_kink_bps < max_util_bps`) and immutable afterwards.
- `observe()` (new, permissionless): decode the DAMM v2 pool, enforce interval and slot spacing, clamp,
  append.
- `insure(loan_ref, covered_amount, cover_tokens, premium)`: existing slot checks, plus `slot.asset ==
  insurable_asset`, `expiry - now <= max_term`, underwriter signer (unless open), TWAP freshness, Pyth checks,
  spot divergence, the exit-value bound, the three token caps, `premium >= min_premium` (rounded up). Updates
  `outstanding_cover` and `exposure_end`. New accounts: `underwriter` (signer), `price_obs`, `price_pool`,
  `pyth_price_update`.
- `slash(loan_ref)`: pay the pro-rata token amount above, capped by `assets`; refuse after
  `expiry + GRACE + claim_window` (`ClaimWindowClosed`); decrement `outstanding_cover` by `cover_tokens`.
  The generation reset on an emptied pool stays.
- `release_cover(loan_ref)` (new, permissionless): when the slot is settled, or `repaid >= principal`, or the
  claim window has passed without a slash, mark the cover lapsed and free its `cover_tokens`.
- `request_unbond`: `ready_at = max(now + COOLDOWN, exposure_end)`; `unbonding_shares += shares`.
  `withdraw` and the generation reset adjust `unbonding_shares`.
- `quote(loan_ref, covered_amount, cover_tokens)` (new view, return data like `shortfall`): the minimum
  premium and the binding cap, for the SDK and underwriters.

New modules, following the pattern of `stream_loan_view.rs` (read-only decoders, no CPI, no crate
dependency): `damm_view.rs` (DAMM v2 pool layout, program id constant, sqrt price to price), `pyth_view.rs`
(either the `pyth-solana-receiver-sdk` crate or a hand-written `PriceUpdateV2` decoder, an owner decision
on dependencies), `pricing.rs` (median, clamp, haircut, curve, all integer math in `u128` with explicit
rounding, unit-testable without a validator). New errors: `PriceStale`, `PriceDiverged`, `OracleStale`,
`OracleConfidence`, `CoverTooLarge`, `UtilizationCap`, `PremiumTooLow`, `TermTooLong`, `AssetNotInsurable`,
`ClaimWindowClosed`, `NotLapsed`, `BadPriceAccount`. New events: `Observed`, `CoverReleased`; `Insured`
gains the cover fields.

Not changed: `stipend_pool`, `stream_loan`, `capacity_stake`, the circuits. `stream_loan_view.rs` already
mirrors every slot field the curve uses.

### Tests and tooling

- Rust unit tests for `pricing.rs` (median under adversarial samples, clamp, curve monotonicity, rounding
  direction, overflow at the extremes).
- A TypeScript mirror of the curve in `src/solana/` (like `src/token.ts` mirrors the capacity curve) and a
  test that the two agree, so underwriters and lenders can quote without a chain call.
- Localnet tests (`test/solana/staking.test.ts` or a new file) need a DAMM v2 pool on the private validator:
  either the DAMM v2 program loaded from a dumped binary with a test pool, or a `fast`-feature build that
  accepts a test-owned price account. The same applies to Pyth. Not decided; both are local only and need no
  public network.
- SDK: instruction builders for `observe`, the new `insure`, `release_cover`, `quote`; PDA helper with the
  underwriter seed; event decoders.

### `contracts/token/SafetyPool.sol` (EVM reference)

The EVM reference has no DAMM v2 pool or SOL leg to read. Either leave it as the v1 reference and say so in
its header (recommended, since Robinhood Chain is no longer the target), or port the price-free parts
(tokens fixed at insure, premium floor, caps, underwriter, claim window, exposure-aware unbonding) behind an
`IPriceSource` interface and test them with a mock source.

### Docs

`README.md` ("Phase 2 contracts", "Not yet built"), `docs/tokenomics.md` section 4, `solana/README.md`
(accounts and PDAs) and `docs/SOLANA-PORT.md` section 3.3 change with the implementation. The audit scope
must include the pricing module and the decoders of third-party account layouts.

## 9. Decisions the owner must make

1. **Price or no price.** Option D (H081 cover valued by a TWAP of the DAMM v2 pool and Pyth SOL/USD) or
   option B (a USDG pool insuring USDG loans, no price, H081 not used for insurance).
2. **When to convert.** At insure with tokens fixed (recommended; lenders carry H081 price risk) or at slash
   in USD (stakers carry it, and payouts depend on the oracle).
3. **Underwriter.** Whether pools are underwritten, who underwrites the first pool, and whether open pools
   stay available.
4. **External dependencies.** Pyth for SOL/USD (and the crate or a hand decoder), and acceptance of USDG at
   1 USD with no depeg check.
5. **Insurable assets.** USDG only for now, or xStocks with a per-asset price feed.
6. **Parameter values.** Haircut `H0`, lender buffer `b`, per-loan caps (5% of pool, 10% of DAMM depth),
   utilization ceiling and kink, `BASE_APR`, `S1`, `S2`, the `m(C)` table, `MAX_TERM`, `CLAIM_WINDOW`, the TWAP
   `WINDOW`, `MIN_INTERVAL`, `MIN_SAMPLES`, `MAX_STEP_BPS`, `MAX_DIVERGENCE_BPS`, Pyth age and confidence.
   All immutable per pool once set.
7. **Unbonding.** Accept the exposure-aware cooldown (exits up to about 127 days with the proposed limits),
   or keep 14 days and accept that early leavers escape losses.
8. **Who runs `observe`** and pays its fees, and whether that is the underwriter's job.
9. **The EVM reference.** Freeze `SafetyPool.sol` as v1 or port the price-free parts.
10. **Sequencing.** The README already requires Phase 1 and an external audit before Phase 2 ships; confirm
    that pricing is built and audited before any `safety_pool` deployment rather than shipped later as a
    new pool.
