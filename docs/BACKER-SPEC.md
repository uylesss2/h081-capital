# Private backer (sponsor) for H081 agent credit

Status: **built on branch `feat/private-backer`, localnet only.** Nothing is deployed and nothing was sent to any
public cluster. The stream_loan upgrade, its extend and its go are the owner's (section 11).

## 0. Summary

A brand-new agent has no allowance and no cashflow, so it cannot produce a stream proof and cannot borrow. A
**backed line** lets another agent vouch for it with money:

- A backer stakes the loan asset (USDG on mainnet) in a vault behind one borrower's per-line draw key.
- The borrower requests an advance from the lender of any open loan slot; the lender funds exactly the terms on chain.
- Every repayment pays the backer's fee first; the rest goes to the lender, capped at the principal (the existing
  overpay cap).
- If the borrower defaults, anyone can make the stake pay the lender's shortfall, up to the cover the line promised.
  The backer then gets the borrower's later repayments until that payout is recovered.
- When nothing is outstanding, the backer withdraws or closes: stake, fees and recoveries come back.

**How it is built: stream_loan gains 6 additive instructions and 2 account types.** No new program, no new circuit,
no stipend_pool or safety_pool change, no change to any existing layout, discriminator, account list or error code.

The backer's fee and its recovery reuse the existing **Subrogation** account and the unchanged `sync`: a backed
loan's Subrogation names the Backing PDA as `safety_config` and the vault (the Backing PDA's associated token account)
as `to`. `sync_inbox` already forwards receipts to `to` first while `paid < owed` and checks only
`to.owner == safety_config`, which the vault satisfies. So `sync`, `settle`, `close_slot`, `sweep_closed`,
`return_excess` and the SDK's `syncIx` work on backed loans unchanged.

**What v1 does not hide.** The per-line keys are fresh, but nothing pays their SOL fees privately: the agent wallet
pays them, so the chain links each line to the wallet that paid (section 9). Stake size, line terms, the advance, the
lender and any default are public, as for every loan today. v1 claims no hidden identity and no hidden amounts.

## 1. Alternatives rejected

- **Owner-funded pledged allowance (exists).** 100% collateral: with bps = 10000 every spend routes to the lender, and
  the circuit cannot read loan state, so nothing releases back to the sponsor after repayment.
- **capacity_stake.** No slashing, no loss path, no yield.
- **safety_pool per-agent covers.** Pooled per mint, valued 1:1 in H081, needs the underwriter's co-sign
  (off on mainnet), and would need new account types in a program that also needs an extend.
- **A new backer program.** About 200-260 KB of ProgramData, and it would still need a stream_loan upgrade
  (`record_slash` accepts only compiled-in safety_pool config PDAs, `close_slot` checks only the safety_pool Cover).
- **Chosen: extend stream_loan.** The Backing sits next to the Slot and writes its Subrogation directly, no CPI.

## 2. Roles, keys and flow

| role | key on chain | how it is derived |
|---|---|---|
| backer B | `backerKey` | ed25519 seed `sha256("h081/backer/v1" ‖ be32(sk_B) ‖ le64(nonce))` (SDK `backerKeyFor`) |
| borrower A | `drawKey` | seed `sha256("h081/draw/v1" ‖ be32(sk_A) ‖ le64(lineNonce))` (SDK `drawKeyFor`) |
| lender L | its wallet | an ordinary stream_loan lender (owns the slot) |
| fee payer | the agent wallet | pays fees and rent for the line keys and gets the rent back |

Both keys are re-derivable from the agent key, so a line can be managed again after a reinstall. The advance goes to
`payout_to`, by default the draw key's USDG account.

```
A: h081_back_draw key                               -> "h081-draw-key:" code (kind 13) -> B
B: h081_back open (Backing + vault), stake          -> "h081-backing:" code (kind 12, loanRef 0) -> A
L: h081_lend open (existing open_slot)              -> loan ref -> A
A: h081_back_draw request(loanRef, advance, lender fee, term, ttl)   reserves the cover
                                                    -> "h081-backing:" code with loanRef -> L
L: h081_lend fund with backingCode: fund_backed at exactly the Draw's terms
   advance - 0.25% -> payout_to, 0.25% -> treasury, Subrogation{safety_config: Backing, to: vault, owed: backer_fee}
A: repays: any transfer into the slot inbox (from the draw key's account, or a pool withdraw to the slot PDA), then sync
anyone: sync (existing): first backer_fee -> vault, the rest -> L, capped at the principal
happy:   L settle -> anyone back_settle (release: reserve freed, Draw closed) -> L close_slot -> B back_withdraw(close)
default: after expiry + GRACE anyone back_claim (after syncing): vault pays L min(L's unpaid due, reserve, vault);
         Subrogation.owed = paid + payout (unpaid fee forfeited); later receipts recover the payout into the vault first
```

## 3. Data model

Sizes include the 8-byte discriminator. Rent at the runbook's 5,080 lamports per byte including the 128-byte
overhead.

### 3.1 `Backing`: PDA `["backing", backer, nonce u64 LE]`, **278 B**, ≈ 0.00206 SOL, refunded at close

| field | type | meaning |
|---|---|---|
| backer | Pubkey | the per-line backer key |
| draw_key | Pubkey | the one key allowed to request draws |
| lender | Pubkey | pin; `Pubkey::default()` = any lender |
| asset, token_program | Pubkey ×2 | mainnet: USDG only |
| payer | Pubkey | rent payer of the Backing and the vault |
| nonce | u64 | |
| cover_bps | u16 | MIN_COVER_BPS..10000 |
| fee_bps | u16 | ≤ 2000 |
| max_lender_fee_bps | u16 | ≤ 2000, set by the backer at open (SDK and agent default 500): the highest lender fee a request may offer |
| expiry | u64 | the line's end; every backed loan must be due by then |
| max_advance, max_total | u64 ×2 | per-draw and lifetime limits set by the backer |
| advanced_total | u64 | sum of funded advances |
| reserved | u64 | stake locked behind requested and funded draws |
| open_draws | u16 | draws not yet closed (≤ 8) |
| draws_total | u32 | |
| covered_out | u64 | total paid out on defaults |
| cosign | bool | every request also needs the backer's signature |
| created_at | i64 | |
| bump | u8 | |

The stake is the vault balance; anyone may top it up. free = `vault - reserved` (saturating: a Token-2022 permanent
delegate can move vault funds); capacity = free × 10000 / cover_bps.

The reserve covers advance + lender fee, and the draw key picks the lender fee on each request, so `max_lender_fee_bps`
is what bounds how far one draw can reach into the stake past its advance. It does not stop a borrower from funding its
own draw: slots are open to anyone, so on a line with no lender pin and no co-sign the draw key can open a slot from a
second wallet, fund its own request (cost: the 0.25% origination fee), default, and claim up to advance + lender fee
from the stake. **The guard against that is the lender pin or `cosign`**; a backer that opens a line without either
accepts it (the agent's open plan says so).

### 3.2 `Draw`: PDA `["draw", backing, loan_ref u64 LE]`, **178 B**, ≈ 0.00155 SOL, refunded to `payer`

| field | type | meaning |
|---|---|---|
| loan_ref | u64 | |
| backing, payer, payout_to | Pubkey ×3 | |
| advance | u64 | |
| backer_fee | u64 | floor(advance × fee_bps / 10⁴) |
| lender_fee | u64 | floor(advance × lender_fee_bps / 10⁴) |
| reserve | u64 | ceil((advance + lender_fee) × cover_bps / 10⁴) |
| term | u64 | seconds; the slot's expiry is set to funding time + term |
| fund_by | i64 | the request is void after this (at most 7 days after the request) |
| requested_at | i64 | |
| claimed | u64 | what back_claim paid |
| state | u8 | 0 requested, 1 funded, 2 claimed, 3 released (reserve freed, Subrogation still routing) |
| bump | u8 | |

Seeding the Draw by `(backing, loan_ref)` means a stranger's line requesting on the same slot never blocks this one.
`term` and `fund_by` are separate fields, so a request's life and the loan's life cannot be confused.

### 3.3 Reused, unchanged layouts

- **Slot (253 B).** A backed slot is funded with `pledge_bps = 0`, `min_remaining = 0`, `min_rate = 0`,
  `stream_start = 0`, `principal = advance + backer_fee + lender_fee`, `expiry = now + term`, `payout_to` from the
  Draw and **`agent_pk = 0`**: nothing proves who the borrower is, so a backed loan must never count for or against
  any agent. Stream slots always have `pledge_bps > 0`, so `funded && pledge_bps == 0` marks a backed slot.
- **Subrogation (97 B).** Created at `fund_backed`, rent paid by the lender (≈ 0.00114 SOL, never closed, as today).
  Because it exists from funding on, a safety_pool slash of a backed loan fails at `record_slash`'s `init`.
- `account_sizes_are_unchanged` and `cover_offsets_match_safety_pool` are untouched and pass.

## 4. Instructions

Compile-time constants in `programs/stream_loan/src/backer.rs` (no admin key, no setter):

| constant | mainnet | localnet | `fast` test build |
|---|---|---|---|
| MIN_COVER_BPS | **10000** | 2000 | 2000 |
| MAX_BACKER_FEE_BPS / MAX_LENDER_FEE_BPS | 2000 / 2000 | same | same |
| MIN_ADVANCE | 1 USDG (1,000,000) | same | same |
| MAX_DRAW | 10,000 USDG | same | same |
| MAX_OPEN_DRAWS | 8 | same | same |
| MIN_TERM | 1 day | 1 day | 1 s |
| MAX_LINE_TERM | 180 days | same | same |
| MAX_REQUEST_TTL | 7 days | same | same |
| GRACE (state.rs) | 7 days | 7 days | 2 s |
| CLAIM_WINDOW | 30 days | 30 days | 5 s |
| RECOVERY_HORIZON | 365 days | 365 days | 5 s |
| BACKED_ASSETS | [USDG] | any mint | any mint |

The `fast` feature builds a separate program id (`Dbb9qZhHanDqz4zAFWhyw35PiziKEWiZ9vZ876q6a2yG`, keypair in the
gitignored `solana/keys/stream_loan_fast-keypair.json`), refuses to compile with `mainnet`, and asserts its id is
neither the localnet nor the mainnet stream_loan id. It is only ever loaded on a local test validator.

1. **`back_open(args)`**: signers backer, payer. Creates the Backing and the vault ATA (idempotent). Checks: token
   program, mint, asset list, **no transfer fee on the mint** (below), cover range, fee ≤ 2000, max_lender_fee_bps ≤ 2000,
   `now + MIN_TERM ≤ expiry ≤ now + MAX_LINE_TERM`, draw key set, `MIN_ADVANCE ≤ max_advance ≤ MAX_DRAW`,
   `max_total ≥ max_advance`. Event `BackingOpened`.
2. **`back_request(loan_ref, advance, lender_fee_bps, term, fund_by)`**: signers draw key, payer (and the backer when
   `cosign`). Checks: the slot is unfunded; the pin; `MIN_ADVANCE ≤ advance ≤ min(MAX_DRAW, max_advance)`;
   `advanced_total + advance ≤ max_total`; lender fee ≤ min(2000, the line's max_lender_fee_bps); the line's mint
   (passed last) has no transfer fee; `term ≥ MIN_TERM` and `now + term ≤ line expiry`;
   `now < fund_by ≤ now + 7 days`; `open_draws < 8`; `payout_to` is an unfrozen token account of the asset that is
   not the vault or the inbox and not owned by the lender, the slot PDA, the Backing PDA or the backer; free stake ≥
   reserve. Effect: `reserved += reserve`, `open_draws += 1`. Event `DrawRequested`.
3. **`fund_backed(loan_ref, expect)`**: signer the slot's lender (`has_one`). `expect = {advance, principal, term,
   payout_to, cover_bps, min_cover_bps}` must match the Draw and the line exactly (`TermsMismatch`), and
   `cover_bps ≥ min_cover_bps` (`CoverTooLow`). Callers must pass the terms the lender was **shown**, never a fresh
   read: the SDK's `fundBacked` takes them as `expect` and refuses a Draw that differs, and the agent's fund plan
   returns them with a `planDigest` that the confirm call must pass back. Also: state 0, unfunded, the line's mint
   (no transfer fee) and token program, the pin,
   `now ≤ fund_by`, `now + term ≤ line expiry`, `advanced_total + advance ≤ max_total`, the payout checks again (and not
   the lender's source account), `vault ≥ reserved`, an empty pool escrow, and the treasury checks of `fund`. Effect:
   origination fee (25 bps of the advance) to the treasury, the rest of the advance to `payout_to`, the inbox created
   and any pre-fund inbox balance returned to `payout_to`, the Slot set as in 3.3, the Subrogation created
   `{safety_config: Backing, to: vault, owed: backer_fee, paid: 0}`, Draw state 1. Events `LoanFunded` (unchanged
   shape) and `BackedFunded`. **It has its own body**: the live `fund` is not touched or refactored.
4. **Repayment**: the existing `sync`, unchanged.
5. **`back_claim(loan_ref)`**: permissionless. Requires Draw state 1, the Subrogation naming this Backing,
   `shortfall_of(slot, now, 0) > 0`, and **no unsynced value: inbox balance ≤ `ledger.held` and an empty pool escrow**
   (`ReceiptsPending`). Anyone can put value in the slot's pool escrow (a spend naming the slot with no lender
   account, then dust), so **a claim must bundle pull + sync + claim in one transaction**: the SDK's `claimBacked` sends
   `createAtaIdempotent(slot inbox)` + `pull_lender_share` when the escrow holds anything, then `sync`, then
   `back_claim`. Without that, an escrow left non-empty could block every claim until the claim window passed and the
   reserve went back to the backer. back_claim does not check the transfer fee: refusing a claim would let the cover
   lapse. Pays
   `min((principal - backer_fee) - (repaid - sub.paid), reserve, vault)` to the lender's associated token account, or,
   when that account is missing or frozen, **into the slot's inbox as `held`** (the lender takes it with `collect`, so
   the cover can never lapse because of the lender's account). Sets `sub.owed = sub.paid + pay` (the unpaid fee is
   forfeited), Draw state 2, frees the reserve, `covered_out += pay`. The Draw stays open. Event `BackingClaimed`.
6. **`back_settle(loan_ref, forgive)`**: one instruction for every way a draw ends (fewer instructions keep the
   upgrade smaller).
   - State 0 (request): cancelled by the backer, the draw key or **the slot's lender** at any time; by anyone after
     `fund_by`, once the slot was funded another way, or once the slot is gone. Reserve freed, Draw closed.
   - State 1 (funded): the reserve is freed once one of these holds: repaid ≥ principal, settled, slot closed, or
     `now > expiry + GRACE + CLAIM_WINDOW` (permissionless). The Draw goes to state 3.
   - Then (states 1→3, 2, 3) the Draw is **closed only when nothing more can reach the vault**: slot closed, loan
     repaid, or `sub.paid ≥ sub.owed`. Otherwise it stays open and counts in `open_draws`, so the vault cannot be closed
     while its Subrogation may still route to it. The Subrogation is cut (`owed = paid`) and the Draw closed when
     `forgive` is set and the backer signs, when the vault cannot receive (missing or frozen; receipts would otherwise
     wait in the inbox for ever), or after `expiry + GRACE + CLAIM_WINDOW + RECOVERY_HORIZON` (so a borrower that never
     repays cannot keep the lender's slot open for ever). Event `DrawReleased {reason, forgone, closed}`.
7. **`back_withdraw(amount, close)`**: signer the backer. `close = false`: `0 < amount ≤ vault - reserved`.
   `close = true`: needs `open_draws == 0` and `reserved == 0`; **sweeps the whole vault** (including dust others sent)
   to the backer's destination, harvests withheld Token-2022 fees, closes the vault and the Backing, both rents to the
   line's payer. Events `BackingWithdrawn` / `BackingClosed`.

**Transfer fees.** USDG is Token-2022 with a TransferFeeConfig extension set to 0 bps and maximum fee 0 (and a
PermanentDelegate). The program parses the TransferFeeConfig value (two authorities, withheld u64, then the older and
the newer `TransferFee {epoch u64, maximum_fee u64, basis_points u16}`) and refuses (`AssetNotBackable`) only when the
older or the newer fee has basis points > 0 or a maximum > 0, or the value is too short to read. A rate the fee
authority raises later shows in the newer fee at once, so `back_request` and `fund_backed` check again: new draws stop,
open loans repay and claim as before.

**Errors**, appended after `ReceiptNotWritable` (39), so 6040..6057: BackingTerms, NotTheBacker, NotTheDrawKey,
DrawState, StakeShort, LineExpired, TooManyDraws, DrawTooLarge, NoBackedDefault, NotReleasable, BackingBusy,
LenderNotAllowed, AssetNotBackable, TermsMismatch, CoverTooLow, RequestExpired, ReceiptsPending, BadVault.
`error_codes_never_shift` still pins 33, 34 and 39 and now also 40 and 57.

**Compute units** (localnet, `solana/compute-units-backer.json`, whole transactions): back_open 36-56k, back_request
(with the payout ATA create-idempotent) 40k, fund_backed (with the treasury ATA create-idempotent) 94k, transfer + sync
31k, sync + back_claim 72k, back_settle (release and close) 24k, back_withdraw close 23k.

## 5. Circuits

None. No new vk, no `gen-solana-vk` run, no ceremony.

## 6. SDK

**`src/solana/backer.ts`** (exported as `backer` from `src/solana/index.ts`):
- PDAs `backingPda`, `drawPda`, `backingVault`; keys `backerKeyFor`, `drawKeyFor`; `LOCALNET_LOAN_FAST_PROGRAM_ID`.
- Math mirrored from backer.rs, with shared vectors in `test/data/backer-vectors.json`: `backedTerms` (principal,
  fees, reserve, origination fee, what the payout receives, the lender's due and the uncovered part),
  `backedClaimAmount`, `releaseReason`, `routingDone`, `lineCapacity`.
- `checkLineTerms`: refuses cover below 100% unless `allowPartialCover`, and combined fees above 10% of the advance
  unless `allowHighFees`.
- Builders `backOpenIx`, `backRequestIx`, `fundBackedIx`, `backClaimIx`, `backSettleIx` (and the named wrappers
  `backCancelIx`, `backReleaseIx`, `backForgiveIx`), `backWithdrawIx` (and `backCloseIx`).
- Decoders `decodeBacking`, `decodeDraw`, `isBackedSlot`, **`isBackedSubrogation`** (the Subrogation's
  `safety_config` is owned by stream_loan and carries the Backing discriminator), `drawsOf`, `backingStatus`,
  `backedLoanView`; events `backedFundedEvents`, `backingClaimedEvents`, `drawReleasedEvents`.
- Roles: `SolanaBacker` (open, stake, stakeFromShielded, status, withdraw, cancel, forgive, release, close),
  `SolanaBackedBorrower` (quote, request, cancel, repay, repayFromShielded, sync), and `fundBacked`, `claimBacked`
  (sync + claim in one transaction), `releaseBacked`.

**`src/solana/lender.ts`**: `LOAN_ERROR` has the new codes; `loanStatus` returns `backed: true` for a backed slot;
`close()` says "the backer is still owed" for a backed Subrogation (checked with `subrogationKindOf`, not only
`pledge_bps`); `SolanaLoanLenderWallet` gains `fundBacked`, `claimBacked`, `releaseBacked` and `backedStatus`.
**`wallet.withdraw`** takes `{allowOffCurve}` so a shielded stake or repayment can go straight to a Backing or slot PDA.
stipend_pool's withdraw checks only `ta.owner == public_recipient` (ops.rs), so an off-curve owner is accepted; the
localnet H081Bank flow does both with real proofs (section 14).

**Readers** (`src/solana/backer.ts`): `SUBROGATION_LABEL` ("backer fee / recovery" or "safety-pool slash recovery"),
`subrogationKindOf` (backed when the slot is funded with `pledge_bps == 0`, or when `safety_config` is a Backing owned by
stream_loan), `subrogationKinds` (batched, 100 per call) and `backedLenderPosition` (the lender's due = principal − backer
fee, what went to the backer and to the lender, the cover paid, and the lender's own shortfall). stream_loan's
`shortfall` (principal − repaid) counts the backer's fee and ignores a cover already paid, so lender-facing views show
`lenderShortfall` for a backed loan.

**Agent SDK** (`integrations/core/backer.ts`, delegated from `H081Bank`): `backOpen`, `backStake` (wallet or shielded),
`backStatus`, `backWithdraw` (and close), `backSettle` (cancel / release / forgive), `backClaim`, `backDrawKey`,
`backRequest`, `backDrawCancel`, `backRepay`, `backTake`, `backDrawStatus`, `lendFundBacked`. Every write returns the
plan unless `confirm: true`, and every plan carries the privacy note of section 9.

**Operator ceilings** (refused before anything is sent): `H081_MAX_BACK` (per stake and for the vault after it),
`H081_MAX_DRAW` (per advance requested), `H081_MAX_LEND` (also caps a backed fund).

## 7. Integrations

- Ops `h081_back` (open, stake, status, withdraw, close, cancel, release, forgive, claim) and `h081_back_draw` (key,
  request, cancel, repay, take, status) in `schemas.ts` (OPS, DESCRIPTIONS, ZOD with strict per-action fields,
  JSON_SCHEMA, EXAMPLE_INPUTS) and `operations.ts`. `h081_lend fund` takes `backingCode` (and `minCoverBps`, default
  10000) instead of `proofCode`.
- MCP picks the ops up from OPS. Solana Agent Kit: the `H081_BACK` and `H081_BACK_DRAW` actions and the `h081Back` and
  `h081BackDraw` methods.
- `@h081lll/agent`: `H081.back` / `H081.draw`; routes `POST/GET /v1/backing` and `POST/GET /v1/draws`;
  `/v1/loans/lend` takes `backingCode` and `minCoverBps`; CLI `h081 back …` and `h081 draw …`; `h081 check` reads
  kinds 12 and 13; `openapi.json` regenerated. Nothing is published.

## 8. Codes (v2 frame, `integrations/core/codes.ts`)

| kind | prefix | body |
|---|---|---|
| 12 | `h081-backing:` | backing 32 ‖ loan_ref u64 LE (0 = none), 40 B |
| 13 | `h081-draw-key:` | draw key 32 ‖ payout account 32, 64 B |

Network tag: the loan code context (cluster, stream_loan program, USDG). **Kind allocation.** This branch first used 8
and 9, which collide with the reputation branch (`feat/zk-reputation`: 7 `h081-rep:`, 8 `h081-rep-ask:`, 9
`h081-rep-sig:`), then 10 and 11, which collide with the solvency branch (`feat/prove-solvency`: 10
`h081-solvency-ask:`, 11 `h081-solvency:`, committed before this branch moved there; its own registry note already
proposes 7-9 reputation, 10/11 solvency, 12/13 backer). No published package or the site ever shipped a kind above 6
(main, `fix/rpc-429-seed` (the published agent 0.1.2), `feat/agent-api` and the site stop at 6), so the backed-line
codes moved to **12 and 13** without breaking a shipped code. `codes.ts` carries the registry: 1-6 shipped, 7-9
(reputation) and 10-11 (solvency) in `RESERVED_CODE_KINDS`, 12-13 backed lines; a new kind takes the next free number.
`npm run check:code-kinds` (`scripts/check-code-kinds.mjs`) reads `CODE_KIND` from the working tree and every local
branch's `codes.ts` and fails when one number names two codes or another branch's kind is not reserved here. A unit
test checks every kind is used once, none is reserved, a kind 7-11 frame is never read as a backed-line code, and the
reputation and solvency tables as committed do not clash with this one. The reputation and solvency branches need no
change. Confirm the registry when the branches merge (section 11, D8). **The site's `src/lib/live/codes.ts` mirror is
not in this branch** (it lives in the site repo).

## 9. Privacy: what leaks

**Public, as for every loan today**: the Slot (lender, principal, expiry, payout account, funding time); LoanFunded,
DripRouted and DripSubrogated (fee and recovery into the vault); and any default (BackingClaimed).

**Public, new**: the stake size and every change to it; the line terms (cover, fee, expiry, pin, limits, reserved,
draw count, covered_out); the edge backer key ↔ draw key ↔ lender; the stake's origin (a pool withdraw of exactly the
vault delta, or a wallet transfer).

**Linkable in v1, not hidden**: the backer and the borrower act through fresh per-line keys, **but the agent wallet
pays their fees and rent**, so each line key is linked on chain to that wallet. There is no relayer path for
stream_loan instructions today (the relayer relays only stipend_pool ops). The descriptions, the plans and this spec
say so, and nothing claims a hidden backer or borrower.

**What a future fee sponsor needs (decision D4, not built)**: payer = relayer for every line instruction (rent refunds
already go to `payer`), a USDG fee paid up front in the same transaction, an allowlist of the exact instruction
discriminators with account checks, and per-key rate limits. Without these, anonymous callers could drain the hot
wallet with rent for accounts they never close.

**Residual risks even with a sponsor**: amount and timing correlation (an exact advance re-deposited, or a stake equal
to a pool withdraw; the SDK should split, delay and round, and the anonymity set is only the pool's USDG withdraw and
deposit volume), a pinned lender hints at who the backer is, and the lender is never shielded.

## 10. Cost (mainnet)

- **After the review fixes** (lender-fee cap, transfer-fee parse, the mint on back_request) the localnet build is
  444,984 B (+2,608 B on the figures below); the mainnet-feature scratch build was not re-measured.
- **stream_loan extend: measured, not estimated.** The localnet build of the pre-backer source is 320,720 B; with
  backed lines it is 442,376 B. That is **+121,656 B (≈ 119 KB)**, about 0.62 SOL locked at 5,080 lamports/byte (about
  0.85 SOL at 6,960 lamports/byte). The first build, with nine instructions, was +140,672 B. Merging cancel, release
  and forgive into `back_settle`, and withdraw and close into `back_withdraw`, saved 19 KB. The earlier 45-75 KB
  estimate was low, as the overpay cap's was. A `--features mainnet` build of scratch copies (declare_id and the
  treasury placeholder swapped, never deployable) gives 320,656 B before and **442,552 B after (+121,896 B)**. The
  extend needed is 442,552 B minus the current mainnet ProgramData capacity; read that capacity and rebuild with
  `build-phase2-mainnet.sh` before asking for the go.
- **Deploy buffer**: about the program size in rent, temporary and refunded.
- **Per line**: Backing ≈ 0.00205 SOL + vault ≈ 0.0015-0.002 SOL, both refunded at close.
- **Per draw**: Draw ≈ 0.00155 SOL (refunded) + Subrogation ≈ 0.00114 SOL (paid by the lender, kept).

## 11. Owner decisions

- **D1. Program size.** +119 KB (about 0.62-0.85 SOL locked). Accept it, or ask for a further cut (hand-parsed accounts
  instead of Anchor's generated ones for the backer instructions; not attempted).
- **D2. Constants** as in section 4, compiled in; changing one means another upgrade. On mainnet, full cover only.
- **D3. USDG check.** USDG is Token-2022 with TransferFeeConfig at 0 bps / maximum 0 and a PermanentDelegate (a
  read-only review check). The program accepts that and refuses any non-zero rate or maximum, current or scheduled
  (section 4). Re-check the mainnet mint's extensions (transfer fee, permanent delegate, default-frozen accounts)
  before the go.
- **D4. Fee sponsorship** (section 9). Without it, v1 lines are linkable to the paying wallet.
- **D5. The upgrade** (section 16): owner-only, rehearsed on localnet first, upgrade authority kept, never `--final`.
- **D6. The site mirror** of kinds 12 and 13, and the "backed" label in the site's loan views (section 16). The x402
  loans market and `lendStatus` in this repo are done.
- **D7. v2 confidential stake** (section 12): a new circuit, a stipend_pool upgrade and a ceremony.
- **D8. Code kinds at merge.** This branch takes 12 and 13 and reserves 7-9 for the reputation codes and 10-11 for the
  solvency codes (section 8). Run `npm run check:code-kinds` before each merge; nothing shipped changes.
- **D9. safety_pool cover on a backed loan.** safety_pool `insure` accepts a backed loan (it reads only the Slot), but
  its slash can never pay: stream_loan's `record_slash` cannot create the Subrogation the backed loan already has
  (shown on localnet, section 14). A premium paid for it buys nothing; the underwriter's co-sign (off on mainnet) is
  the only gate. Either the underwriter never co-signs a `pledge_bps == 0` loan (no code; `insureIx` says so), or a
  later safety_pool upgrade refuses one in `insure`. No safety_pool change is made here.

## 12. v2 (out of scope): confidential stake

A bond note `Poseidon(15, asset, amount, backerPk, lineId, blinding)` and a new `bond.circom`. stream_loan would CPI a
new stipend_pool instruction to pay `min(shortfall, reserve)` from the pool on a proven default. It needs a
stipend_pool extend, its own vk file (the six ceremony vks are never regenerated), a ceremony (the owner's) and about
+60-100 KB.

## 13. ZK reputation interplay

**Backed loans must not feed reputation in v1.** A backed Slot's `agent_pk` is zero, because nothing binds a key at
funding. A line where the backer, the lender and the borrower are one party under fresh keys could manufacture a
"repaid loan" for about 25 bps of the volume plus rent, and a default that is later recovered also ends with
`paid ≥ owed`. The reputation branch must skip slots with `pledge_bps == 0` (or whose Subrogation
`isBackedSubrogation`), and must label a backed Subrogation as backer fee or recovery, never as a slash. A later
version could let backed loans count, but only with a proof of the borrower key at funding, no BackingClaimed,
repayment before expiry and a minimum fee paid.

## 14. Tests

- **Rust** (`cargo test`, host): the TransferFeeConfig rule (0 bps accepted next to a PermanentDelegate; a rate or a
  maximum on the older or the newer fee refused; a short value refused), sizes (Backing 278, Draw 178; the existing size and cover-offset tests unchanged),
  terms rounding, the claim-amount table, release reasons and routing, the fee routed first through the unchanged
  `split_receipt`, error codes appended, the fast id never a deployed id, and `property_backer_and_lender_accounting`.
  That property runs 5,000 random repayment, claim and recovery sequences and checks that the lender plus the vault
  never take more than the principal from receipts, the lender never ends above principal − the fee paid before the
  default, the backer never above stake + fee, and a full repayment balances exactly.
- **TypeScript unit** (`test/sdk/backer.test.ts`, `test/integrations/backer-ops.test.ts`): the shared vectors, key
  derivation, instruction layouts, decoders, the `loanStatus` backed flag, the error table, the ops' zod checks, plan
  unless confirm, the lend-fund routing, kinds 12/13 framing and the kind registry (no duplicate, none of the reserved
  7-11, a kind 7-11 frame never read as a backed-line code, no clash with the reputation and solvency tables), and `H081_MAX_BACK` / `H081_MAX_DRAW`; the readers
  (`subrogationKindOf`, batched `subrogationKinds`, `backedLenderPosition` with fee-first pending, 100% and 20% cover);
  plus the updated plugin, MCP and OpenAPI tests.
- **Readers, unit** (`test/relayer/x402-services.test.ts`, `test/integrations/core-lend.test.ts`): the x402 market
  labels a backed loan's Subrogation "backer fee / recovery" (never "slash"), a safety-pool one a slash, reads pledge 0
  as backed, and gives the lender's due, cover paid and shortfall; `lendStatus` the same, before and after a default
  claim; `h081_lend claim` refuses a backed loan; the `settle` plan warns that settling first forfeits the cover.
- **Localnet** (`npm run test:solana:backer`): its own validator (rpc 18899, ledger `solana/test-ledger/backer`),
  started with the pre-backer program `stream_loan_base.so`.
  1. Upgrade rehearsal: a registry and slots made under the old program survive an in-place upgrade (extend
     included), the upgrade authority is kept, and an old slot is then lent through a line.
  2. Three wallets, happy path: stake 600, advance 500 at 5% + 3% (principal 540), then 300 and 250 repaid. 25 goes to
     the vault, 515 to the lender and 10 stays for the borrower. Then settle, release, close_slot and close the line,
     with every rent back.
  3. Default on the fast build: a partial repayment below the fee; an unsynced share is refused (`ReceiptsPending`);
     sync + claim pays the lender exactly 515; `owed = paid + payout`; a second claim fails; recovery goes to the
     vault; the line and the slot cannot close until the horizon release.
  4. 20% cover: the lender gets exactly 20% of its due; the SDK and the program refuse the line below the lender's
     minimum; the backer forgives the rest.
  5. Request expiry (`RequestExpired`, then anyone cancels), and a frozen lender account (the claim lands in the inbox
     as held, and `collect` delivers it).
  6. One line, two lenders: reserves per draw; free stake bounds requests and withdrawals; a lender cancels a draw on
     its own slot.
  7. Guards: every line-term bound, the draw key, the limits, the payout owner checks; the front-run (cancel and
     re-request bigger) refused with `TermsMismatch`; a stranger's line on the same slot does not block and is
     cancelled by the lender; max_total; the lender pin; co-sign; the SDK's partial-cover refusal; dust swept at close;
     a funded slot refusing a second line; the line's lender-fee cap; a re-request with the same advance but another
     term and lender fee refused against the planned terms (SDK and `TermsMismatch`).
  8. A Token-2022 mint like USDG (TransferFeeConfig at 0 bps + PermanentDelegate): a whole loan opens, funds, repays
     and closes; after `SetTransferFee` a pending request cannot be funded and a new one is refused
     (`AssetNotBackable`); mints charging 100 bps, a maximum only, or 1 bp only are refused at open.
  9. The pool escrow cannot block a default claim: a share escrowed by a spend naming the slot plus dust sent into the
     escrow; sync + claim alone is refused (`ReceiptsPending`), `claimBacked` (pull + sync + claim) pays the lender its
     whole due.
  10. The H081Bank backed flow through the agent operations (`runOp`, what MCP, Agent Kit and the agent routes call),
     three real banks on the fast build: A hands its draw-key code; B shields 300, opens a line pinned to L (plan
     first), and **stakes 250 from its shielded balance: a stipend_pool withdraw with a real `transact` proof from
     `build/circuits` to the Backing PDA's vault**; L opens a slot; A requests 100 at 3%; L funds with the planned
     `planDigest`; L's `lendStatus` says `kind: backed`, "backer fee / recovery"; `h081_lend claim` is refused; A takes
     the advance, shields 30 and **repays 8 from its shielded balance (a pool withdraw to the slot PDA)**: 5 to the
     vault first, 3 to L; after expiry + grace the lender's shortfall is 100 and the settle plan warns; A (anyone)
     claims and L gets 100 from the stake; a further shielded repayment of 10 recovers into the vault; after the
     horizon the draw is released and B closes the line and gets the whole vault (165) back. No ceremony key is
     involved: the localnet stipend_pool build verifies the `build/circuits` keys.
- **safety_pool on a backed loan** (`test/solana/staking.test.ts`, the staking suite): a fixture loan `backed` written
  as fund_backed leaves it (pledge 0, agent_pk 0, a Backing account and the Subrogation naming it, at the live expiry).
  It is fixture state, not a real fund_backed: a real backed loan on the localnet build is due a day later at the
  earliest (MIN_TERM) and safety_pool, fast build included, reads only that build's program id. `insure` **succeeds**
  (safety_pool reads only the Slot; see D9). After expiry + grace, with a real shortfall and pool assets, `slash`
  fails inside the CPI: the logs show stream_loan invoked at depth 2, `Instruction: RecordSlash`, and the Subrogation
  `init` hitting an account "already in use"; the cover stays unpaid and open, the pool's assets and exposure, its
  vault, the lender's balance and the Subrogation bytes are unchanged.
- **Runs (2026-11-17, HEAD + this change)**:
  - `cargo test --manifest-path programs/stream_loan/Cargo.toml --features localnet-treasury` (WSL,
    `CARGO_TARGET_DIR=~/stipend-target-private-backer-host`): 30 passed; with `--features localnet-treasury,fast`: 30
    passed. (Without `localnet-treasury` the crate refuses to compile by design: the treasury placeholder.)
  - `npm run test:solana:backer` (rpc 18899, from `stream_loan_base.so`, upgraded in place): 15 passed (the 14 above and the H081Bank flow, 10).
  - The lending suite on the new `.so`: `node scripts/solana-backer-localnet.mjs restart` (pool + the new
    `stream_loan.so` on 18899), then `STIPEND_LOAN_RPC=http://127.0.0.1:18899 npx vitest run --config
    vitest.solana-loan.config.ts`: `lending.test.ts` 31 passed; `lend-localnet.test.ts` failed in its `beforeAll` when run
    right after `lending.test.ts` on the same validator (a fresh deposit read back a shielded balance of 0) and passed
    5 of 5 alone on a fresh validator (`... npx vitest run test/integrations/lend-localnet.test.ts --config
    vitest.solana-loan.config.ts`). The previous commit (0d65477), run the same way on a fresh 18899 validator, fails
    the same `beforeAll` with the same assertion, so the ordering failure predates this change (not investigated
    further). (In that checkout `lending.test.ts`'s migration test also failed, only because its gitignored
    `target-so` had no `stream_loan_legacy.so`.)
  - The staking suite on 18899, from PowerShell (Git Bash rewrites `/home/...` values into Windows paths before they
    reach WSL; there, set `MSYS2_ENV_CONV_EXCL='STAKING_'` first):
    ```
    $env:STAKING_RPC_PORT='18899'; $env:STAKING_FAUCET_PORT='18901'; $env:STAKING_GOSSIP_PORT='18902'
    $env:STAKING_DYNAMIC_PORTS='18910-18990'; $env:STAKING_LEDGER='/home/joseph/stipend-private-backer-staking-ledger'
    $env:STAKING_STAGE='/home/joseph/stipend-private-backer-staking-so'; $env:STAKING_LOG='/home/joseph/stipend-private-backer-staking.log'
    $env:STAKING_RPC='http://127.0.0.1:18899'
    node scripts/solana-staking-localnet.mjs restart; npx vitest run --config vitest.staking.config.ts; node scripts/solana-staking-localnet.mjs stop
    ```
    39 passed (the two backed-loan tests included).
  - `npm test`: 463 passed, 49 failed, 8 skipped. The 49 are all in `test/e2e` (the EVM contracts on hardhat:
    "invalid proof", "not insured"); a clean checkout of the previous commit fails the same 49 with the same
    `build/circuits`, so they are not from this change. Everything else passes (`test/integrations`, `test/relayer`,
    `test/sdk`: 371 passed, 8 skipped). `npm run typecheck`: clean.
- **Not covered yet**: a real fund_backed loan slashed by safety_pool (only fixture state can reach a backed loan's
  expiry within a test run, see above); the site mirror (D6).

## 15. Files

- Program: `solana/programs/stream_loan/src/backer.rs` (new), `lib.rs`, `error.rs`, `state.rs` (GRACE under `fast`),
  `token.rs` (`transfer_fee_active`, `mint_charges_transfer_fee`), `Cargo.toml` (`fast`).
- Scripts: `solana/scripts/loan-build.sh` (also builds `stream_loan_fast.so`; `LOAN_TARGET_DIR`), `loan-keygen.sh`,
  `loan-upgrade-localnet.sh` (port), `backer-validator.sh`, `scripts/solana-backer-localnet.mjs`.
- SDK: `src/solana/backer.ts` (new), `lender.ts`, `wallet.ts`, `index.ts`.
- Integrations: core `backer.ts` (new), `bank.ts`, `codes.ts`, `constants.ts`, `errors.ts`, `operations.ts`,
  `schemas.ts`; agent `h081.ts`, `server.ts`, `cli.ts`, `README.md`, `openapi.json`; agent-kit `actions/back.ts`,
  `actions/backDraw.ts`, `tools/index.ts`, `index.ts`.
- Readers: `relayer/x402/loans.ts`, `relayer/x402/services.ts`, `integrations/core/bank.ts` (lendStatus, claim, settle,
  quote), `src/solana/lender.ts` (close), `src/solana/token.ts` (`insureIx` note).
- Tests: `test/solana/backer.test.ts`, `test/sdk/backer.test.ts`, `test/integrations/backer-ops.test.ts`,
  `test/integrations/core-lend.test.ts`, `test/relayer/x402-services.test.ts` (+ `helpers/x402.ts`),
  `test/solana/staking.test.ts` + `staking-fixtures.ts` (loan `backed`), `test/data/backer-vectors.json`,
  `vitest.solana-backer.config.ts`; `scripts/solana-staking-localnet.mjs` and `solana/scripts/staking-*.sh` take
  `STAKING_*` port and ledger overrides.

## 16. Migration and upgrade

- **Additive only**: no layout, discriminator, account-list or error-code change, and `fund` is untouched.
- **Not upgraded**: stipend_pool, safety_pool, capacity_stake.
- **Readers.** Every reader that labels a Subrogation must check `subrogationKindOf` / `subrogationKinds` (or
  `isBackedSubrogation`) first and show "backer fee / recovery", and must read `pledge_bps == 0` on a funded slot as
  "backed". Done in this repo:
  - the x402 `loans-market` (`relayer/x402/loans.ts`): every loan gets `kind` (`stream` / `backed`) and `subrogation`
    (`{kind, label, to, owed, paid}` or null), a backed loan also `backed` (`lenderDue`, `backerFee`, `toBacker`,
    `toLender`, `coverPaid`, `lenderShortfall`), and `counts.backed`. Subrogations, their `safety_config` accounts and
    the Draws are read in batches of 100. `shortfall` stays stream_loan's rule and says so. Once a backed loan's Draw
    is closed (released after the loan ended, or at the recovery horizon, which cuts `owed` to `paid`) the fee and the
    cover paid are no longer on chain: `backed.drawClosed` is true and `lenderDue`, `backerFee`, `coverPaid` and
    `lenderShortfall` are null, never guessed;
  - `lendStatus` (`integrations/core/bank.ts`): the same `kind`, `subrogation` and `backed`; for a backed loan
    `shortfall` is the lender's own (`lenderShortfall`), or stream_loan's rule with a `backed.note` once the Draw is
    closed (the localnet flow checks this after the release). `h081_lend claim` refuses a backed loan and points to
    `h081_back claim`; the `settle` plan warns that settling before the default claim forfeits the cover (back_claim needs
    an unsettled loan); `loanQuote` notes a backed slot;
  - `SolanaLoanLenderWallet.close` names a backed Subrogation by `subrogationKindOf`.
  - There is **no SlashRecorded or DripSubrogated event consumer** in this repo (nothing reads those events), so there
    was nothing to relabel.
  Still to do outside this repo: the site's loan views (D6) and the reputation branch (section 13).
- **The upgrade (owner step)**: build with `build-phase2-mainnet.sh`, measure the `.so`, `solana program extend
  8JBd7… <bytes>`, deploy, then check the hash. Rehearse first with `npm run test:solana:backer` (it starts from the
  pre-backer program and upgrades in place) and with the existing lending suite on the new `.so`. Keep the upgrade
  authority and never use `--final`.
