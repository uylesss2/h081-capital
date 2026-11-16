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
A: h081_back_draw key                               -> "h081-draw-key:" code (kind 9) -> B
B: h081_back open (Backing + vault), stake          -> "h081-backing:" code (kind 8, loanRef 0) -> A
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

### 3.1 `Backing`: PDA `["backing", backer, nonce u64 LE]`, **276 B**, ≈ 0.00205 SOL, refunded at close

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
   program, mint, asset list, **no Token-2022 TransferFeeConfig on the mint**, cover range, fee ≤ 2000,
   `now + MIN_TERM ≤ expiry ≤ now + MAX_LINE_TERM`, draw key set, `MIN_ADVANCE ≤ max_advance ≤ MAX_DRAW`,
   `max_total ≥ max_advance`. Event `BackingOpened`.
2. **`back_request(loan_ref, advance, lender_fee_bps, term, fund_by)`**: signers draw key, payer (and the backer when
   `cosign`). Checks: the slot is unfunded; the pin; `MIN_ADVANCE ≤ advance ≤ min(MAX_DRAW, max_advance)`;
   `advanced_total + advance ≤ max_total`; lender fee ≤ 2000; `term ≥ MIN_TERM` and `now + term ≤ line expiry`;
   `now < fund_by ≤ now + 7 days`; `open_draws < 8`; `payout_to` is an unfrozen token account of the asset that is
   not the vault or the inbox and not owned by the lender, the slot PDA, the Backing PDA or the backer; free stake ≥
   reserve. Effect: `reserved += reserve`, `open_draws += 1`. Event `DrawRequested`.
3. **`fund_backed(loan_ref, expect)`**: signer the slot's lender (`has_one`). `expect = {advance, principal, term,
   payout_to, cover_bps, min_cover_bps}` must match the Draw and the line exactly (`TermsMismatch`), and
   `cover_bps ≥ min_cover_bps` (`CoverTooLow`). Also: state 0, unfunded, the line's mint and token program, the pin,
   `now ≤ fund_by`, `now + term ≤ line expiry`, `advanced_total + advance ≤ max_total`, the payout checks again (and not
   the lender's source account), `vault ≥ reserved`, an empty pool escrow, and the treasury checks of `fund`. Effect:
   origination fee (25 bps of the advance) to the treasury, the rest of the advance to `payout_to`, the inbox created
   and any pre-fund inbox balance returned to `payout_to`, the Slot set as in 3.3, the Subrogation created
   `{safety_config: Backing, to: vault, owed: backer_fee, paid: 0}`, Draw state 1. Events `LoanFunded` (unchanged
   shape) and `BackedFunded`. **It has its own body**: the live `fund` is not touched or refactored.
4. **Repayment**: the existing `sync`, unchanged.
5. **`back_claim(loan_ref)`**: permissionless. Requires Draw state 1, the Subrogation naming this Backing,
   `shortfall_of(slot, now, 0) > 0`, and **no unsynced value: inbox balance ≤ `ledger.held` and an empty pool escrow**
   (`ReceiptsPending`; the SDK sends `sync` + `back_claim` in one transaction). Pays
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
`close()` says "the backer is still owed" for a backed Subrogation; `SolanaLoanLenderWallet` gains `fundBacked`,
`claimBacked`, `releaseBacked` and `backedStatus`. **`wallet.withdraw`** takes `{allowOffCurve}` so a shielded stake or
repayment can go straight to a Backing or slot PDA. stipend_pool's withdraw checks only `ta.owner == public_recipient`
(ops.rs), so an off-curve owner is accepted; no localnet test exercises it yet (section 14).

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
  kinds 8 and 9; `openapi.json` regenerated. Nothing is published.

## 8. Codes (v2 frame, `integrations/core/codes.ts`)

| kind | prefix | body |
|---|---|---|
| 8 | `h081-backing:` | backing 32 ‖ loan_ref u64 LE (0 = none), 40 B |
| 9 | `h081-draw-key:` | draw key 32 ‖ payout account 32, 64 B |

Network tag: the loan code context (cluster, stream_loan program, USDG). Kind 7 stays reserved for the reputation
proof. **The site's `src/lib/live/codes.ts` mirror is not in this branch** (it lives in the site repo).

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
- **D3. USDG check.** USDG is Token-2022. `back_open` refuses a mint with a TransferFeeConfig extension. Check the
  mainnet mint's extensions (transfer fee, permanent delegate, default-frozen accounts) before the go; nothing in this
  branch read mainnet.
- **D4. Fee sponsorship** (section 9). Without it, v1 lines are linkable to the paying wallet.
- **D5. The upgrade** (section 16): owner-only, rehearsed on localnet first, upgrade authority kept, never `--final`.
- **D6. The site mirror** of kinds 8 and 9, and the "backed" label in the site and x402 views (section 16).
- **D7. v2 confidential stake** (section 12): a new circuit, a stipend_pool upgrade and a ceremony.

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

- **Rust** (`cargo test`, host): sizes (Backing 276, Draw 178; the existing size and cover-offset tests unchanged),
  terms rounding, the claim-amount table, release reasons and routing, the fee routed first through the unchanged
  `split_receipt`, error codes appended, the fast id never a deployed id, and `property_backer_and_lender_accounting`.
  That property runs 5,000 random repayment, claim and recovery sequences and checks that the lender plus the vault
  never take more than the principal from receipts, the lender never ends above principal − the fee paid before the
  default, the backer never above stake + fee, and a full repayment balances exactly.
- **TypeScript unit** (`test/sdk/backer.test.ts`, `test/integrations/backer-ops.test.ts`): the shared vectors, key
  derivation, instruction layouts, decoders, the `loanStatus` backed flag, the error table, the ops' zod checks, plan
  unless confirm, the lend-fund routing, kinds 8/9 framing, and `H081_MAX_BACK` / `H081_MAX_DRAW`; plus the updated
  plugin, MCP and OpenAPI tests.
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
     a funded slot refusing a second line.
- **Not covered yet**: a shielded stake or repayment through a real pool withdraw to a PDA; safety_pool `insure` on a
  backed slot (expected: `slash` fails at `record_slash`); the H081Bank backed flow against a validator; the site mirror.

## 15. Files

- Program: `solana/programs/stream_loan/src/backer.rs` (new), `lib.rs`, `error.rs`, `state.rs` (GRACE under `fast`),
  `token.rs` (`mint_has_transfer_fee`), `Cargo.toml` (`fast`).
- Scripts: `solana/scripts/loan-build.sh` (also builds `stream_loan_fast.so`; `LOAN_TARGET_DIR`), `loan-keygen.sh`,
  `loan-upgrade-localnet.sh` (port), `backer-validator.sh`, `scripts/solana-backer-localnet.mjs`.
- SDK: `src/solana/backer.ts` (new), `lender.ts`, `wallet.ts`, `index.ts`.
- Integrations: core `backer.ts` (new), `bank.ts`, `codes.ts`, `constants.ts`, `errors.ts`, `operations.ts`,
  `schemas.ts`; agent `h081.ts`, `server.ts`, `cli.ts`, `README.md`, `openapi.json`; agent-kit `actions/back.ts`,
  `actions/backDraw.ts`, `tools/index.ts`, `index.ts`.
- Tests: `test/solana/backer.test.ts`, `test/sdk/backer.test.ts`, `test/integrations/backer-ops.test.ts`,
  `test/data/backer-vectors.json`, `vitest.solana-backer.config.ts`.

## 16. Migration and upgrade

- **Additive only**: no layout, discriminator, account-list or error-code change, and `fund` is untouched.
- **Not upgraded**: stipend_pool, safety_pool, capacity_stake.
- **Readers to update before mainnet** (none of them is in this branch): every reader that labels a Subrogation as a
  slash must call `isBackedSubrogation` first and show "backer fee / recovery". That covers the SlashRecorded and
  DripSubrogated consumers, the x402 loans market and its shortfall views, the site's loan views and `lendStatus`, and
  the reputation branch. They must also handle `pledge_bps == 0` and show "backed".
- **The upgrade (owner step)**: build with `build-phase2-mainnet.sh`, measure the `.so`, `solana program extend
  8JBd7… <bytes>`, deploy, then check the hash. Rehearse first with `npm run test:solana:backer` (it starts from the
  pre-backer program and upgrades in place) and with the existing lending suite on the new `.so`. Keep the upgrade
  authority and never use `--final`.
