# stream_loan overpay cap (option 2): merged final spec

Status: built, reviewed and tested on localnet (review fixes and upgrade steps: §8–§9; R2 is closed in the program); not deployed yet. The SDK and integration changes (npm 0.2.1) ship first: they are valid against the program live now.
Program: stream_loan (mainnet `8JBd7epQXxdcKRMaWM1S5PC7nsQKoZq3uCetpiJ684g4`, upgradeable). Never `--final`.

## 0. The rule and the merged design

**Guarantee.** For every loan, from the upgrade on, the lender's receipts out of the slot inbox plus the safety pool's subrogation together total at most `max(0, principal - repaid_at_upgrade)` in the loan asset, and 0 in every other mint. Everything beyond that belongs to the borrower. It goes to `slot.payout_to`, the account the principal was paid to and that the borrower proved at `fund`. Until it can be delivered, it waits in the inbox, claimable for the borrower.

**How it works.** Design B is the base, with three pieces of Design A.

1. **The cap lives in `sync_inbox`.** Anything that would push `repaid` past `principal` is not credited, not added to `held`, and not moved. It stays in the inbox above `ledger.held`. The program keeps no counter for it: "inbox minus held, once repaid >= principal" *is* the borrower's claimable balance, and it stays correct across repeated syncs.
2. **`claim` is strict** (Design B). It refuses once the loan is repaid, and it refuses any claim whose `lender_amount` exceeds what is still owed. This keeps the borrower's allowance money private instead of moving it into the public inbox and back out to the payout account.
3. **New permissionless `return_excess`** sends the borrower's excess to `payout_to`. One instruction serves both open slots and closed slots.
4. **`close_slot` keeps today's shape** (Design B). The Slot is closed and a ClosedSlot receipt is created, but the new receipt is 130 bytes: the unchanged 98-byte struct followed by `payout_to` in 32 trailing bytes. This lets refunds keep working after a close.
5. **`sweep_closed` is capped** at `principal - closed.repaid`. From Design A it takes "writable only when needed": the account constraint stays read-only, and the handler requires `is_writable` only when it actually has something to record.

**Why B's close design beats A's keep-the-Slot design:**
- **Cost per loan.** Keeping the Slot leaves about 155 bytes of rent behind per loan (Slot 253 B against receipt 98 B, roughly 0.00108 SOL). B adds 32 bytes, about 0.00022 SOL.
- **Old clients keep working.** A gives old SDK and npm `close()` a `NothingToClose` loop and makes them misread status. Under B, `close()` keeps working.
- **Meaning stays the same.** Under B, "closed" still means the Slot is gone and a receipt exists.

**Why strict claim beats tolerant claim.** Under tolerant claim, the borrower's own allowance money would move into the public inbox and then the public payout account. Strict claim prevents that. The cost is that old claim callers fail cleanly on the last instalment, and the updated SDK clamps the amount for them.

**Claims I checked against the code:**
- **Trailing bytes are safe.** Anchor 1.2.1 (`anchor-attribute-account`, `try_deserialize_unchecked`) uses `AnchorDeserialize::deserialize` on `&buf[8..]` and ignores trailing bytes. A 130-byte receipt therefore decodes as `ClosedSlot`, and serializing the 98-byte prefix leaves the trailing `payout_to` untouched.
- **Slash is bounded.** safety_pool `slash` pays `pay = min(shortfall, balance, limit)`, with `shortfall = principal - repaid - pending` (safety_pool lib.rs ~416-424). At the slash, `owed <= principal - repaid - pending`. Pending value is synced to the pool first, so the pool can always recover `owed` inside the cap.
- **The bug is real.** In `sync_inbox` (lib.rs ~284) `repaid += delta` has no cap, and all of `delta - to_pool` is forwarded. Shares in other mints are forwarded with `credited: false`.
- **Byte counts.** Slot is 8 + 245 = 253 B, ClosedSlot is 8 + 90 = 98 B, Ledger is 8 + 57 = 65 B.

## 1. Rule per instruction

### 1.1 Pure helper (`state.rs`, unit-tested)

```rust
pub struct Split { pub credit: u64, pub to_pool: u64, pub to_lender: u64, pub excess: u64 }
/// room = principal - repaid for the loan asset, 0 for any other mint.
pub fn split_receipt(principal: u64, repaid: u64, delta: u64, is_asset: bool, sub_left: u64) -> Split {
    let room = if is_asset { principal.saturating_sub(repaid) } else { 0 };
    let credit = delta.min(room);
    let to_pool = credit.min(sub_left);
    Split { credit, to_pool, to_lender: credit - to_pool, excess: delta - credit }
}
/// What the lender may still take after a close.
pub fn closed_room(principal: u64, repaid: u64, is_asset: bool) -> u64 { if is_asset { principal.saturating_sub(repaid) } else { 0 } }
```

### 1.2 `sync` / `sync_inbox` (accounts and args unchanged; also used inside `claim`)

1. Existing checks, the unfunded early return and `reconcile_held` stay as they are.
2. **Legacy release** (loan asset only). This handles an over-repaid loan that still has held overage from before the upgrade.
   - Condition: `repaid > principal && held > 0`.
   - Compute `x = min(held, repaid - principal)`, then `held -= x` and `repaid -= x`, and emit `LegacyExcessReleased { loan_ref, amount: x }`.
   - Afterwards `repaid >= principal` still holds, and the condition is false (either `held == 0` or `repaid == principal`), so the release runs at most once per loan.
   - The released `x` becomes unsynced borrower excess.
   - Amounts already forwarded to the lender before the upgrade are not clawed back.
3. Compute `delta = inbox - held`. If `delta == 0`, return 0.
4. Compute `s = split_receipt(principal, repaid, delta, mint == slot.asset, sub.owed - sub.paid)`. Read the subrogation only for the loan asset, as today.
5. If `s.credit == 0`: emit `ExcessHeld { loan_ref, asset: mint, amount: s.excess }` and return 0. Nothing is written. This is a no-op that never errors.
6. Subrogation:
   - `to_pool = s.to_pool`, which comes out of `credit`, not `delta`.
   - The existing gate stays: if `to_pool > 0` and the pool account or the inbox cannot move funds, return 0 and change nothing.
7. Then:
   - `ledger.received += s.credit`. `received` now means "credited", not "everything that arrived".
   - `repaid += s.credit`. The add saturates, but it cannot pass `principal`.
8. Forward `to_lender` to the lender's ATA, or add it to `held` when that account is missing or frozen (as today). `DripRouted.credited` is now always true for forwarded amounts.
9. If `s.excess > 0`, emit `ExcessHeld`. Return `s.credit`.

Notes:
- `sync_inbox` deliberately does not pay `payout_to` inline. A memo-required, hooked, frozen or closed payout account would otherwise make every sync revert and block the lender's legitimate credit.
- **Invariant:** inbox value above `held` while `repaid < principal` is always genuine unsynced repayment, because excess only appears in the sync that fills the room. So `pending` in `shortfall`, `shortfall_of` and safety_pool's `pending_in_inbox` / `current_shortfall` stays correct. When `repaid >= principal`, the shortfall is 0 regardless.

### 1.3 `claim` (accounts and args unchanged)

1. `require!(funded, NoLoan)`.
2. New: `require_keys_eq!(mint, slot.asset, WrongAsset)`. A claim in another mint could only create borrower excess.
3. New: `check_claim_buffers` returns `Σ lender_amount`, summed as u128 over every pool-owned buffer it checks. Summing every buffer is the conservative choice if a decoy buffer is passed.
4. New: compute `owed`:
   - `owed = principal - repaid - pending_inbox - escrow`, saturating;
   - `pending_inbox = inbox.amount - ledger.held` (0 if the inbox is missing);
   - `escrow` = the balance of `escrow_address(asset, slot, loan_ref)` when that account appears in `remaining_accounts` (the pool spend list carries it), else 0.
   - Then require `repaid < principal` (`LoanRepaid`) and `owed > 0` (`LoanRepaid`).
5. New: require `Σ lender_amount <= owed` (`ClaimTooLarge`).
6. The CPI and the following `sync_inbox` stay as today. The capped sync is the backstop for anything that slips past, for example a claim delivered to the escrow. Overshoot simply becomes borrower excess.

No pre-CPI sync is needed, because subtracting the pending amount does the same job and saves compute units.

### 1.4 `collect` (unchanged)

- After the upgrade, `held` only ever receives capped `to_lender` amounts.
- Pre-upgrade held overage on an over-repaid loan is released by the first sync, under 1.2 step 2.
- `collect` cannot write the Slot (its `slot` account is read-only), so it cannot run the release itself. Without a fix a lender that calls `collect` before any sync could take legacy overage once; see risk R2, closed in the program by review fix 5 (§8.1).

### 1.5 `settle`, `fund`, `open_slot`, `record_slash`, `shortfall`, `initialize` (unchanged)

- Routing after settle goes through the capped sync.
- Pre-fund returns already go to `payout_to`.
- Design A's rejected fund-time guard stays rejected, because a borrower may legitimately prove a lower `min_remaining`.

### 1.6 `close_slot` (accounts and args unchanged)

- **Unfunded slot:** unchanged.
- **Funded slot:**
  - It must be settled, with no open cover (as today).
  - **Subrogation guard:** `sub.paid >= sub.owed || slot.repaid >= slot.principal`. Once the room is full the pool can receive nothing more, so a mis-sized slash must never lock the close. Per §0 this cannot happen with today's safety_pool; the guard is defence in depth.
  - **Inbox rule.** It replaces "the inbox must be empty":
    - require `ledger.held == 0` (`InboxNotEmpty`: collect first);
    - if `repaid < principal`, require the inbox to be empty (`InboxNotEmpty`: sync first);
    - if `repaid >= principal`, the inbox may hold borrower excess. It is closed only when empty; otherwise it stays open for `return_excess`.
  - The loan asset's Ledger is closed to the lender (as today).
  - The receipt is **v2**:
    - `create_pda_from_owned(slot, closed, 8 + ClosedSlot::INIT_SPACE + 32, ...)`, which is 130 bytes;
    - the `ClosedSlot` struct is serialized into bytes 0..98 and `slot.payout_to` is written into bytes 98..130;
    - the extra 32 bytes of rent (≈ 222,720 lamports) come from the slot's own lamports, as the receipt rent does today.
  - The Slot is closed to the lender (`close = lender`, unchanged).
- **Events:** `SlotClosed` keeps its exact layout, so existing indexers keep decoding it. Its `lamports_refunded` is 222,720 lower.

### 1.7 `sweep_closed` (accounts unchanged; the `closed` constraint stays read-only)

1. Existing checks stay. The slot must be empty, which it always is after a close.
2. Compute `room = closed_room(closed.principal, closed.repaid, mint == closed.asset)` and `amount = min(inbox, room)`.
3. If `amount > 0`:
   - require `closed.to_account_info().is_writable` (`ReceiptNotWritable`);
   - transfer `amount` to `destination`;
   - set `closed.repaid += amount` and write it with a manual `try_serialize` over the 98-byte prefix (the trailing `payout_to` is untouched);
   - emit `ClosedSlotSwept`.
4. If the inbox is now empty, harvest and `close_inbox` to the lender (as today).
5. Require `amount > 0 || inbox_closed` (`NothingOwed`).
6. Whatever is left belongs to the borrower and leaves through `return_excess`.

Old callers that pass `closed` read-only keep working wherever nothing is owed to the lender. They fail cleanly, and never overpay, only when the lender is still owed on that receipt.

### 1.8 NEW `return_excess(loan_ref)`: permissionless, additive

**Accounts, in order:**

| # | Account | Constraint |
|---|---|---|
| 0 | `slot` | Unchecked. The `["slot", ref]` PDA: a live Slot, or the empty PDA of a closed slot. |
| 1 | `closed` | Unchecked. The `["closed", ref]` PDA; may not exist. |
| 2 | `ledger` | Unchecked. The `["ledger", ref, mint]` PDA; may not exist, which means `held = 0`. |
| 3 | `mint` | Read-only. |
| 4 | `inbox` | Mut. Must be `ata(slot, mint, tp)`. |
| 5 | `payout_to` | Unchecked. Must equal the recorded payout. |
| 6 | `destination` | Mut. |
| 7 | `token_program` | Must be the loan's token program. |
| `remaining[0]` | owner signer | Optional. |

**Which state applies.** Every address is checked by seeds.
- **Open:** the `slot` account is owned by this program. Deserialize the `Slot` and require `funded` (`NoLoan`). Then `principal, repaid, asset, payout_to, bump` come from the Slot.
- **Closed:** the `slot` account is empty and `closed` is owned by this program. Deserialize the `ClosedSlot`:
  - require `closed.data_len() >= 130`, else `LegacyReceiptNoPayout`;
  - `payout_to` is read from bytes 98..130, and the bump is `closed.slot_bump`.

**How much can go back:**
- loan asset: `excess = (repaid >= principal) ? inbox - held : 0`;
- other mint: `excess = inbox - held`;
- require `excess > 0` (`NoExcess`).

An open subrogation does not block the refund: once `repaid >= principal` the pool's claim is against the lender, never against the borrower's overpayment. While `repaid < principal` the refund is 0 anyway.

**Where it can go:**
- **Owner redirect:** if `remaining[0]` is a signer equal to the owner of `payout_to` (the account must exist so its owner can be read), `destination` may be any token account of `mint`. This covers a frozen, memo-required or hooked `payout_to`.
- **Otherwise:**
  - loan asset: `destination == payout_to`;
  - other mint: `destination == ata(owner(payout_to), mint, tp)`.
- **Deliverability:** the inbox must not be frozen, and `destination` must be an unfrozen token account of `mint`. Otherwise fail with `PayoutCannotReceive`; the excess just keeps waiting. An ATA payout that was closed can be re-created by anyone, and the call retried.

**Transfer and events:**
- The slot PDA signs `transfer_checked` for `excess`.
- Emit `ExcessReturned { loan_ref, asset: mint, amount, to, by_owner }`.
- The inbox is not closed here. On a closed slot, the lender can close an empty inbox through `sweep_closed` (amount 0, inbox closed).

### 1.9 Errors and events

- **New `LoanError` variants:** `LoanRepaid`, `ClaimTooLarge`, `NoExcess`, `PayoutCannotReceive`, `LegacyReceiptNoPayout`, `ReceiptNotWritable`.
  - They are appended at the **end** of the enum, so existing codes and the TS `LOAN_ERROR` map do not shift.
  - `WrongAsset` and `NothingOwed` are reused.
- **New events:** `ExcessHeld`, `ExcessReturned`, `LegacyExcessReleased`. No existing event changes.

## 2. Account and layout impact

| Account | Change |
|---|---|
| Slot (253 B) | None. The safety_pool `stream_loan_view.rs` mirror stays byte-identical. |
| Ledger (65 B) | None. Doc change only: `received` now means "credited". |
| Subrogation, Registry | None. |
| ClosedSlot | Struct unchanged. New receipts are 130 B: the struct plus `payout_to` at offset 98. Old 98-B receipts still decode and still work, and they are treated as "no payout recorded". |
| New PDAs | None. |

`repaid` can drop once, through the legacy release, on a loan that was over-repaid before the upgrade. It never drops below `principal`.

## 3. Caller impact

Account lists are unchanged for `sync`, `claim`, `collect`, `settle`, `close_slot`, `sweep_closed`, `fund`, `record_slash` (safety_pool CPI) and `shortfall`. Behaviour changes are listed below.

| Caller | Change |
|---|---|
| `src/solana/lender.ts` `prepareClaim` | Default `want = min(lenderClaimable, principal - repaid - (inbox - held) - escrow)`. If that is 0, throw "loan repaid". An explicit `amount` above `owed` throws client-side. This also works against the old program, so ship it first. |
| `src/solana/lender.ts` `sweepClosedIx` | `r(closedSlotPda)` → `w(closedSlotPda)`. |
| `src/solana/lender.ts` new | Add `returnExcessIx(loanRef, mint, payoutTo, destination, tp, programId, ownerSigner?)` and `SolanaLoanLenderWallet.returnExcess()`, plus a borrower-side helper. |
| `src/solana/lender.ts` `close()` | After sync and collect, a repaid loan with excess may close with the inbox still open. Afterwards, best effort, call `returnExcess` (the payout ATA is permissionless to re-create). |
| `src/solana/lender.ts` `sweepClosed()` | Sweep up to the cap, then `returnExcess` the rest when a v2 receipt exists. |
| `src/solana/lender.ts` `closedSlots` / `byLender(..., CLOSED_SLOT_ACCOUNT_SIZE)` | They filter on `dataSize: 98` and would miss the 130-B receipts. Switch to a discriminator memcmp plus the lender memcmp, or run two queries (98 and 130). `decodeClosedSlot` gains an optional `payoutTo` when the data is at least 130 B. `CLOSED_SLOT_ACCOUNT_SIZE` keeps its value as a minimum. |
| `src/solana/lender.ts` status / `LOAN_ERROR` | Add the new errors. Show "repaid, excess waiting" when `repaid >= principal` and `inbox > held`. |
| `relayer/x402/loans.ts` | `isClosedSlotAccount` / `decodeClosedSlot` already tolerate the longer length. Check that `payoutTo` is surfaced if it is shown. |
| `integrations/core/bank.ts` | No instruction calls. Its comment "payoutTo no longer on chain" is now false for v2 receipts; read it when present. |
| `src/lender.ts` | Uses `lender.ts`, so it is covered by the changes above. |
| `test/sdk/solana-close-slot.test.ts` | The sweep account test (`closed` writable), the `returnExcessIx` order test, and the 130-B receipt decode test. |
| npm 0.2.0 tools | They keep working, except that over-cap claims fail cleanly, sweeps on a receipt that still owes the lender need a writable `closed`, and 130-B receipts are not listed. 0.2.1 carries the `lender.ts` changes; its `h081_lend` claim, collect, close and the new sweep use the clamp. |
| The site's bundled SDK | Re-bundle from the updated `lender.ts` (it builds claim and sweep instructions). |
| safety_pool | No code change. `shortfall_of`, `release_cover` and `slash` stay correct; the cap only makes `repaid <= principal`. |

**Deploy order:**
1. SDK, site bundle and npm 0.2.1. The clamped claim is valid against the old program.
2. Inventory (§4).
3. Rehearse the upgrade on localnet with the mainnet `.so`.
4. Program upgrade by the upgrade authority, with an extend if the new `.so` needs one.

## 4. Live-loan migration

**Before the upgrade**, run read-only `getProgramAccounts` and count:
- (a) open Slots with `repaid > principal`, and of those, the ones with `ledger.held > 0`;
- (b) ClosedSlot receipts with `repaid >= principal` whose slot inbox or pool escrow is non-zero, or could become non-zero because the pledge is still routing;
- (c) open Subrogations;
- (d) other-mint Ledgers with `held > 0`.


| Loan state at upgrade | After the upgrade |
|---|---|
| Open, `repaid < principal` | Capped from the next sync. Lender plus pool receive exactly `principal - repaid` more. |
| Open, `repaid > principal` | The first sync releases held overage to the borrower. New arrivals are excess, claim fails with `LoanRepaid`, `return_excess` pays `payout_to`, and settle and close work. Overpay that was already forwarded is not clawed back. |
| Open with a subrogation | The pool is recovered first, inside the room (§0). Close is never locked, thanks to the relaxed guard. |
| Closed, 98-B receipt, `repaid < principal` | `sweep_closed` is capped at `principal - closed.repaid`; the read-only `closed` that old callers pass fails only while the lender is still owed. |
| Closed, 98-B receipt, `repaid >= principal` | No payout is recorded on chain, so post-upgrade arrivals stay in the inbox or pool escrow; nothing pays them out. See R1. |
| Funded after the upgrade | Full guarantee. |

Nothing is bricked. Every path that worked before either works or ends in a clear, retryable error. The one exception is claims above what is owed, which are refused by design.

## 5. Test plan

**Rust unit tests (stream_loan):**
- `split_receipt`:
  - below the room, exactly at it, and crossing it;
  - `repaid == principal`;
  - legacy `repaid > principal`;
  - another mint;
  - subrogation: `to_pool <= credit` and `to_pool + to_lender == credit`;
  - u64 extremes.
- Property test over random sequences: `Σ(pool + lender) <= principal - repaid₀`, and `repaid <= max(principal, repaid₀)`.
- Legacy release arithmetic and its idempotence.
- `closed_room`.
- `ClosedSlot::try_deserialize` on 98-B and 130-B buffers; reading the payout gives None for 98 B; serializing the prefix keeps the trailing bytes.
- Error-code ordinals unchanged.
- `check_claim_buffers` sums over two buffers.

**Localnet** (`test/solana/lending.test.ts` with the WSL validator via `scripts/solana-loan-localnet.mjs`):

1. **The bug repro:** budget 100, `min_remaining` 50 at 40%, principal 20.
   - A claim of 40 fails with `ClaimTooLarge`; a claim of 20 succeeds; any later claim fails with `LoanRepaid`.
   - A borrower spend followed by sync leaves the lender unchanged and emits `ExcessHeld`.
   - `return_excess` sent by a stranger pays `payout_to`. A wrong destination is refused. An owner-signed redirect works.
2. **A sync that crosses the principal:** with repaid at 15, adding 10 to the inbox gives the lender 5 and leaves 5 of excess.
3. **Slash, then an over-pledged stream:** the pool recovers `owed`, the lender gets the rest up to the principal, the borrower gets the excess, and `close_slot` succeeds.
4. **Frozen lender ATA:** `held` gets only the credit, and `collect` pays exactly that.
5. **Payout account cases:**
   - frozen `payout_to` gives `PayoutCannotReceive`, the excess stays, and the owner redirect works;
   - a closed ATA `payout_to` is refused, and works again once re-created;
   - a memo-required `payout_to` makes `return_excess` fail while `sync` for the lender is unaffected.
6. **Another mint routed to the inbox:** the lender gets 0, and the borrower's ATA for that mint is refunded.
7. **Settle and `close_slot` with excess waiting:**
   - the inbox stays open, and the receipt is 130 B with `payout_to`;
   - `return_excess` after the close works;
   - `sweep_closed` with nothing owed closes the empty inbox.
8. **Close with `repaid < principal`, then routing after the close:**
   - `sweep_closed` pays up to the cap and updates `closed.repaid`;
   - the rest goes through `return_excess`;
   - a read-only `closed` fails with `ReceiptNotWritable` only while the lender is still owed.
9. **The `close_slot` guards:**
   - `held > 0` fails with `InboxNotEmpty`;
   - an unsynced inbox while `repaid < principal` fails with `InboxNotEmpty`.
10. **Upgrade migration** (`setup-live-localnet-mainnet-so.mts`). With the mainnet `.so`, create:
    - an over-repaid open loan with held overage;
    - a 98-B receipt below the principal;
    - a 98-B receipt at or above the principal;
    - a slashed loan.

    Then upgrade on localnet to the new `.so` and check that every account decodes and that each state behaves as in §4.
11. **Token-2022:** a transfer-fee loan crossing the principal, and a permanent delegate draining an inbox that holds excess (`reconcile_held` still works).
12. **A claim delivered to the escrow:** with the inbox frozen, then a second claim. The escrow term bounds it, or the sync backstop leaves the overshoot as excess.
13. **Existing tests to update:**
    - "after the close … only the lender sweeps it": now capped;
    - the Token-2022 withheld-fee sweep: another mint now leaves through `return_excess`.
14. **staking and safety_pool suites:** unchanged, and they pass.
15. **Compute units:** measure `sync`, `claim` and `return_excess` and record them in `solana/compute-units-ops.json`. The baseline is `spend_lender_claim` at 178,585. The claim's added owed computation should stay under about 10k, far below `OP_CU_LIMIT` 1.4M.

**SDK unit tests:**
- the `returnExcessIx` account order;
- `sweepClosedIx` marks the receipt writable;
- `closedSlots` finds both 98-B and 130-B receipts;
- `prepareClaim` clamps the amount.

**Gate before any upgrade request:**
- the protocol vitest suite;
- the site's full end-to-end suite, with the numbers reported.

## 6. Size and cost

- Measured after the build: see §9.
- Estimate: **+8 to 14 KB**. Most of it is the one new instruction, plus the claim, close and sweep logic. That is about **0.056 to 0.10 SOL** of program extend at 6,960 lamports per byte, if the current ProgramData has no slack.
- Measure with `node scripts/solana-loan-localnet.mjs build`, then compare against the mainnet ProgramData length (a read-only query) before asking for the upgrade.
- Per-loan cost: a v2 receipt costs the lender 222,720 lamports more rent at close.

## 7. Open risks and decisions

- **R1: legacy 98-B receipts with `repaid >= principal`.** No `payout_to` is recorded on chain for these, so post-upgrade arrivals are locked in the inbox or escrow. Today they go to the lender. The options are to accept the lock or to keep the old behaviour for legacy receipts only, which breaks the guarantee for them. Decided after inventory (b): accept the lock (see §8.4, finding 3).
- **R2: legacy held overage.** A lender could call `collect` before the first post-upgrade sync and take legacy overage once, because `collect` cannot write the Slot. Closed in the program (§8.1, fix 5).
- **R3: policy for other mints.** Lenders lose shares in other mints that they used to receive (for example a third party's allowance pledged to the same slot). This follows from "never more than principal". Legacy other-mint `held` (inventory d) stays collectable on open slots, and after a close `sweep_closed` pays it first (§8.1, fix 1).
- **R4: claim compatibility.** npm 0.2.0 and older SDK bundles get `ClaimTooLarge` / `LoanRepaid` on the last instalment until they are updated. The deploy order puts the SDK first.
- **R5: excess waits for a caller.** No refund happens inside `sync`. Someone (the H081 tools, the borrower, anyone) has to call `return_excess`. A non-ATA `payout_to` that was closed, so its owner cannot be read, leaves the excess waiting for good. A Token-2022 permanent delegate can drain waiting excess, the same exposure as today. The pledge keeps routing after repayment, so tools should prompt the borrower to re-grant without the pledge.
- **R6: relaxed subrogation close guard.** If a future safety_pool ever slashed more than the room left, the pool would under-recover instead of locking the loan. Today `pay <= shortfall` rules this out.
- **R7: `repaid` can decrease once (legacy release).** Indexers that assume `repaid` never decreases need a check.
- **R8: escrow term in claim.** The escrow is only counted when it appears in `remaining_accounts`. If it is left out, the over-claim still lands as borrower excess, but it moves allowance money into the inbox.
- **R9: size.** The extend cost is unmeasured until the build (§6).

## 8. Review fixes (2026-11-10)

A review of the build raised 13 findings. Each one was re-checked against the code.

### 8.1 Fixed in the program (accounts and args of every existing instruction unchanged)

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 (medium) | Another mint's share that the pre-cap program **held** for the lender (lender had no account for that mint) was stranded once the slot closed: `close_slot` only closes the loan asset's Ledger, `sweep_closed` now pays 0 in other mints, `return_excess` leaves `held` alone, and `collect` needs the gone Slot. | `sweep_closed` takes an **optional** first remaining account: the mint's Ledger PDA (writable, address re-derived from its stored bump). Its `held` is paid to the lender first, outside the room and without touching the receipt, then the Ledger is closed to the lender (`state::sweep_split`). Callers that leave it out behave exactly as before. `sweepClosedIx` always appends it. | Migration test (b): 6 of another mint held under the legacy program before the close; after the upgrade an old-shape sweep (no Ledger) fails `NothingOwed`, the SDK sweep pays the 6 and closes the Ledger and the inbox; the receipt's `repaid` is unchanged. Rust `sweep_pays_held_first_then_the_room`; SDK `sweepSplit` and account-order tests. |
| 5 (medium) | `collect` paid all of `held`, so on a loan over-repaid before the cap a lender collecting before the first sync took the overage (R2). | `collect` pays `state::collectable` = `held` minus `legacy_release(...)` for the loan asset. The overage stays held until the next sync releases it to the borrower. Collect-then-sync now splits exactly like sync-then-collect, so **R2 is closed in the program** and no upgrade-time sync is needed for it. | Migration test (d): a legacy loan with 30 held (repaid 30 of 20) collects 20 before any sync; a second collect fails `NothingOwed`; the sync releases 10, and `return_excess` pays 10 to the borrower. Rust `collect_never_pays_legacy_overage`. |
| 8 (low) | `claim` answered `LoanRepaid` when the loan was not repaid but value already on its way (unsynced inbox, escrow) covered the rest. | The `room > 0` check is gone: such a claim now fails with `ClaimTooLarge`. `LoanRepaid` only when `repaid >= principal`. The SDK says "already on its way (sync it)". | Localnet: an escrowed 20 against a 20 loan with `repaid` 0 gives `ClaimTooLarge`. |
| 2 (low) | The payout owner could not redirect excess once `payout_to` was closed (its owner can no longer be read). | `return_excess` also accepts as owner a signer whose associated token account of the loan asset (SPL Token or Token-2022) *is* `payout_to`. A closed **non-ATA** payout still has no on-chain owner: only whoever holds that account's keypair can re-create it, which was already true (R5). | Localnet: after the borrower closes its payout ATA, its owner redirects 2 to another account; a stranger signing is refused with `BadPayout`. |
| 7 (low) | `ExcessHeld` was re-emitted with the full waiting amount on every sync, so summing it over-counts. | The event field is renamed `waiting` and documented as a **level**, not an increment. Indexers sum `ExcessReturned`. The events are new in this build, so nothing reads the old name. | Localnet: a second sync with nothing new reports the same 4, and after 4 more arrive it reports 8. |
| 9 (medium) | No test ran the relaxed `close_slot` rule (a repaid loan closes while a slash is still short). | The rule is the pure `state::subrogation_blocks_close`. Today's safety_pool cannot produce the state (it recovers first, inside the room), so the staking fixtures now write one: `REF.slashedRepaid`, settled, repaid = principal, with a Subrogation of owed 3,000,000 and paid 1,000,000. | Staking suite: that loan closes and leaves a receipt, and the Subrogation is untouched. Rust `a_repaid_loan_never_waits_on_the_pool`. |

### 8.2 Fixed in the callers (`src/solana/lender.ts`)

| # | Finding | Fix |
|---|---|---|
| 4 (**high**) | A caller that allowlists the stream_loan instructions it may send (a guard that halts on anything else) does not list the new `return_excess`. Rebuilt from the updated `lender.ts`, it would send it from `close()` and `sweepClosed()` and halt. | Sending `return_excess` from the lender wallet is **opt-in**: `close(ref, { returnExcess: true })` and `sweepClosed(ref, mint?, dest?, { returnExcess: true })`. By default they never send it. Without the flag, `sweepClosed` throws a clear error when only borrower excess is waiting. Such callers turn the flag on after listing `return_excess`. The npm 0.2.1 tools turn it on (they have no allowlist). |
| 13 (low) | No unit test of the claim clamp. | The clamp is now the pure, exported `claimAmount(vested, owed, amount, ref, repaid)`, used by `prepareClaim` and unit-tested in `test/sdk/solana-close-slot.test.ts`. |

### 8.3 Tests added for the spec's missing cases

| # | Finding | Test |
|---|---|---|
| 10, 11, 12 | Claim inputs (unsynced inbox, pool escrow) never exercised on localnet; escrow-delivered claim. | (1) 15 unsynced in the inbox: a claim of 6 fails `ClaimTooLarge`, and the SDK claims exactly 5. (2) The slot inbox is frozen so the pool escrows each claim: 8 is claimed, then 13 is refused, then the SDK claims 12, then 1 is refused; after thawing and `pull_lender_share` the lender has exactly 20. |
| 10 (5c, 11) | Memo-required payout; permanent delegate draining an inbox that holds excess. | A Token-2022 loan (permanent-delegate mint). The borrower turns on required memos after funding: sync is unaffected and the plain refund fails, but the owner redirects it. The delegate drains 3 while 5 of excess waits, and it comes out of the excess (the lender's 20 held stays). Draining below `held` gives `NoExcess` for the borrower, then a sync reconciles `held` to 16 and the lender collects 16. |
| 12 (CU) | Compute units only in console logs. | `compute-units-ops.json` is rewritten whole by the pool e2e suite, so the loan suite now writes its own `solana/compute-units-loan.json`, with a budget per instruction that the test asserts. |

### 8.4 Not fixed

- **Finding 3 (low): pre-cap 98-byte receipts.** Funds that reach a slot closed before the upgrade stay locked whenever the lender is not owed them: borrower excess in the loan asset (R1), and **every** other-mint share (the pre-cap program swept those to the lender). The program has no record of where the borrower's payout account is, and nobody can be trusted to name it except the upgrade authority. A possible fix is an authority-only `record_legacy_payout(loan_ref, payout_to)` that grows a 98-byte receipt to 130 bytes once. It costs program bytes and adds an admin action, which the program has avoided so far. The mainnet inventory (§9.1, 2026-11-10) found no over-repaid loan, so it is not built. Held other-mint shares on these receipts are reachable (finding 1).
- **Finding 6 (medium): callers that are already deployed.** These cannot be fixed from the program:
  - older SDK bundles (the site's, npm 0.2.0) build `sweep_closed` with a read-only receipt (`ReceiptNotWritable` while the lender is owed);
  - they list receipts with `dataSize: 98`, so 130-byte receipts are invisible to them;
  - they claim the full vested share, which fails with `ClaimTooLarge` or `LoanRepaid` on the last instalment.
  
  Ship the rebuilt site bundle and npm 0.2.1 (both from this `lender.ts`) **before** the upgrade. npm 0.2.0 users fail cleanly and never overpay.
- **Token-2022 transfer-fee loan crossing the principal.** stipend_pool refuses deposits that arrive short, so a fee-mint loan exists only if the issuer raises the fee after funding (as USDG could). That is epoch-gated and cannot be staged in a test run. The cap works on inbox balances: the credit and the excess are both taken from what actually arrived, and the transfer fee is withheld from each recipient. The lender can therefore receive less than the principal, never more, and the inbox empties exactly. The withheld-fee sweep test already covers the fee path for another mint.
- **Spec 10(d), a slashed loan across the upgrade.** The loan validator has no safety_pool. The Subrogation layout is unchanged and the slash paths run on the new program in the staking suite, including the fixture above.

### 8.5 Suites after the review fixes

| Suite | Result |
|---|---|
| stream_loan Rust unit tests (WSL, `--features localnet-treasury`) | 21 passed, 0 failed |
| stream_loan localnet suite, including the legacy-program migration (`npm run test:solana:loan`) | 31 passed, 0 failed |
| staking / safety_pool localnet suite (`npm run test:staking`) | 37 passed, 0 failed |
| SDK close-slot unit tests | 15 passed, 0 failed |
| SDK + relayer + integrations (`test/sdk/solana-close-slot.test.ts test/relayer test/integrations`) | 138 passed, 1 skipped. |
| `consistency.test.ts` | Its `safety.rs` constant names are fixed in this branch (`LOCALNET_SAFETY_PROGRAM_ID`, `MAINNET_SAFETY_PROGRAM_ID`). |
| `tsc --noEmit` | Clean. |

**Compute units** (localnet, `solana/compute-units-loan.json`):
- claim 259,696
- sync with excess 26,493
- return_excess on an open slot 20,545
- return_excess on a closed slot 27,278
- collect on a legacy loan 23,578
- sweep_closed paying held 18,897

## 9. Size, SOL and the upgrade steps

**Size:**
- Mainnet-feature build (`mainnet,no-log-ix-name`, mainnet ids, treasury `EGvxic66…`): **319,880 bytes**, sha256 `2900c3e6946302ef440a337b5594051a448748a20ad24195b9dd511a93100557`.
- Built from a snapshot of the reviewed tree with `solana/scripts/build-phase2-mainnet.sh` in its keyless mode (program ids from the environment). No key file was read.
- Localnet build: 320,720 bytes.

**What mainnet holds now** (read-only `getAccountInfo`, 2026-11-10):
- ProgramData `BX6i4MWz…` is 297,357 bytes: the 45-byte header plus **297,312**, exactly the current `.so`. **There is no slack.**
- The upgrade authority is still `5WCpirBe…`.
- Mainnet rent is now **5,080 lamports per byte**, not the 6,960 the earlier estimates used.

| | Bytes | SOL |
|---|---|---|
| Extend (permanent; comes back only through `solana program close`) | 319,880 - 297,312 = **22,568** | **0.1146** (114,645,440 lamports) |
| Upgrade buffer (temporary; refunded to the authority when the deploy completes) | 319,917 + 128 | ≈ 1.626 |
| Transaction fees (about 330 buffer writes, plus priority fees) | | ≈ 0.005–0.02 |
| **Keep on the authority before starting** | | **≥ 1.80** |

At the old 6,960 lamports per byte, the extend would be 0.157 SOL.

Each new v2 receipt costs its lender 32 × 5,080 = 162,560 lamports more rent at close.

### 9.1 Before the upgrade (all valid against the program live now)

1. **Callers first.** The updated `lender.ts` only ever asks the old program for less: the clamped claim, the receipt passed writable, and the extra Ledger account, which the old `sweep_closed` ignores as a remaining account.
   - **Site:** rebuild its bundled SDK from this `src/solana/lender.ts`, add an end-to-end check (a capped claim, and the closed-loan list showing a 130-byte receipt), run its full suite, deploy.
   - **npm 0.2.1** of `@h081lll/mcp` and `@h081lll/solana-agent-kit-plugin`: built from this `lender.ts`.
   - **Other bundles of `lender.ts`:** rebuild them. A caller with an instruction allowlist leaves `returnExcess` off until it lists `return_excess` (§8.2, finding 4), and checks that its indexer tolerates `repaid` dropping once (R7).
   - **Relayer** (`relayer/x402/loans.ts`): already reads both receipt sizes. Redeploy it with the new bundle, whenever convenient.
2. **Inventory** (read-only `getProgramAccounts` on `8JBd7epQ…`; done 2026-11-10: nothing over-repaid, no open Subrogation, no held other-mint Ledger). This sizes the open decisions:
   - (a) open Slots with `repaid > principal`, and their `ledger.held`. Since the review this needs no upgrade-time sync: `collect` cannot take the overage.
   - (b) 98-byte receipts, and whether their pledges still route. This is finding 3 / R1: `record_legacy_payout` is not built.
   - (c) open Subrogations.
   - (d) other-mint Ledgers with `held > 0`. These are now sweepable after a close.
3. **Localnet rehearsal of the exact bytes:**
   - Snapshot the reviewed tree (`git archive` of the release commit).
   - Run `TREASURY=EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq bash solana/scripts/build-phase2-mainnet.sh <snap.tar> - <out> stream_loan` with `STREAM_LOAN_ID=8JBd7epQXxdcKRMaWM1S5PC7nsQKoZq3uCetpiJ684g4`. Confirm the sha256 above, or record the new one.
   - Run `npx tsx scripts/mainnet-rehearsal-phase2-localnet.mts` against a private validator loaded with the **current** mainnet `.so` (297,312 bytes, sha256 `24d1efd8…`). Make loans in each §4 state, then upgrade *on localnet* to the new mainnet-feature `.so` with `solana program extend` followed by `solana program deploy`, exactly as below, and run the migration checks.
   - Also run `npm run test:solana:loan` and `npm run test:staking` on the localnet build.
4. **Fund the authority** `5WCpirBe…` to at least 1.80 SOL.

### 9.2 The upgrade (the upgrade authority runs each command)

```bash
# WSL; ALCHEMY=<mainnet Alchemy RPC URL>; AUTH=<path to the 5WCpirBe… upgrade-authority keypair>; SO=<out>/stream_loan.so
sha256sum $SO                      # must equal the rehearsed hash
solana program show 8JBd7epQXxdcKRMaWM1S5PC7nsQKoZq3uCetpiJ684g4 --url $ALCHEMY   # authority 5WCpirBe…, data length 297312
solana program extend 8JBd7epQXxdcKRMaWM1S5PC7nsQKoZq3uCetpiJ684g4 22568 --url $ALCHEMY --keypair $AUTH
solana program deploy $SO --program-id 8JBd7epQXxdcKRMaWM1S5PC7nsQKoZq3uCetpiJ684g4 \
  --upgrade-authority $AUTH --keypair $AUTH --url $ALCHEMY --with-compute-unit-price 50000 --max-sign-attempts 60
# NEVER --final, and never `solana program set-upgrade-authority --final`: the authority is how the program's SOL comes back.
# If the deploy stops halfway: `solana program show --buffers --url $ALCHEMY --keypair $AUTH`, then resume with
# `deploy --buffer <addr>`, or reclaim the buffer with `solana program close <buffer> --url $ALCHEMY --keypair $AUTH`.
solana program show 8JBd7epQXxdcKRMaWM1S5PC7nsQKoZq3uCetpiJ684g4 --url $ALCHEMY   # authority unchanged, data length 319880
solana program dump 8JBd7epQXxdcKRMaWM1S5PC7nsQKoZq3uCetpiJ684g4 /tmp/live.so --url $ALCHEMY && head -c 319880 /tmp/live.so | sha256sum
```

Then run the site's read-only production health check.

### 9.3 After the upgrade

- **Callers with an instruction allowlist:** add `return_excess` to it, optionally parse `ExcessHeld` (a level), `ExcessReturned` and `LegacyExcessReleased`, then call `close(ref, { returnExcess: true })` / `sweepClosed(..., { returnExcess: true })`.
- **Site and relayer:** turn on `returnExcess: true` where a refund should be sent automatically (npm 0.2.1 already does). Anyone may call `return_excess` at any time.
- **Rollback:** redeploy the staged 297,312-byte `.so` the same way (the ProgramData stays at the larger size). Every account still decodes: no layout changed, and v2 receipts read as the 98-byte struct.
