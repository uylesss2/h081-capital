# Private backer (sponsor) for H081 agent credit: implementation spec

Status 2026-11-16: **design only.** None of this is built, deployed or audited. Every constant marked
"proposed" is a starting value for the owner to accept or change. Nothing here has been sent to any cluster.

Branch: `feat/private-backer` (worktree `stipend-protocol-wt/private-backer`, based on `d01d882`).

## 0. Summary

A brand-new agent has no allowance and no cashflow, so it cannot produce a stream proof and cannot borrow.
This spec adds a **backed line**:

- A backer stakes the loan asset (USDG on mainnet) in a vault.
- The agent draws a loan from any lender against that stake.
- On every repayment the backer's fee is paid first. The rest goes to the lender.
- If the agent defaults, the stake pays the lender's shortfall, up to the cover the backer committed. The
  backer then gets the agent's later repayments until that payout is recovered.
- When nothing is outstanding, the backer withdraws what is left in the vault: free stake, fees and
  recoveries.

**Decision: extend `stream_loan` with 8 additive instructions and 2 new account types.** There is no new
program, no new circuit, no `stipend_pool` change and no `safety_pool` change.

The trick that keeps it small: the backer's fee and its default recovery both reuse the existing
**Subrogation** account and the unchanged `sync_inbox`. A backed loan's Subrogation names the backing PDA
as `safety_config` and the backing vault as `to`. `sync_inbox` already forwards receipts to `to` first while
`paid < owed`, and its only owner check is `to.owner == safety_config`, which the vault satisfies. So `sync`,
`settle`, `close_slot`, `sweep_closed`, `return_excess` and every existing caller work on backed loans as
they are.

**What "shielded" means here, plainly.** v1 hides who the backer and the borrower are. It does not hide
amounts:

- The backer and the agent act through fresh per-line keys.
- The stake comes out of the shielded pool, and repayments can come out of it too.
- Stake size, line terms, the loan amount, the lender and any default are public on chain, as every
  `stream_loan` loan is today.

Section 9 is the full leak list. Hiding amounts needs a pool-level "bond note" with a new circuit and a
ceremony (section 12, v2). It is out of scope here.

## 1. Why not the alternatives

| Option | Result |
|---|---|
| Owner-funded pledged allowance (exists today: `grant`/`wallet.pledge`) | 100% collateral, no leverage. With `pledgeBps` = 10000 every spend routes to the lender. The circuit cannot read loan state, so there is no conditional release back to the sponsor after repayment. Not a backer. |
| `capacity_stake` | No slashing, no loss path, no yield. Not usable. |
| `safety_pool` per-agent covers | Pooled per mint, valued 1:1 in H081, needs the underwriter to co-sign, and underwriting is off on mainnet. A USDG per-line stake would need new account types there plus a USDG `SafetyConfig`. This is about the same code as below, in a program that also needs extending, and stream_loan's `record_slash` path adds a CPI per default. |
| **New backer program** | About 200-260 KB of new ProgramData, roughly 1.0-1.3 SOL locked. It *still* needs a stream_loan upgrade, because `record_slash` accepts only compiled-in safety_pool config PDAs (`safety.rs` 28-33) and `close_slot` checks only the safety_pool Cover. That is about 1.1-1.4 SOL in total. |
| **Extend stream_loan (chosen)** | About 45-75 KB of extend, roughly 0.23-0.38 SOL locked (section 10). The backing lives next to the Slot, writes its Subrogation directly and needs no CPI. |
| New circuit | Not needed for v1. Every check is on public token balances and loan state. |

## 2. Roles, keys and the flow

- **Backer B.** Holds an H081 account secret `sk_B`. For each line it derives a fresh ed25519 key
  `backerKey = ed25519(seed = sha256("h081/backer/v1" ‖ be32(sk_B) ‖ le64(nonce)))`. That key is the
  Backing's authority. B's main wallet never appears on chain.
- **Agent A.** Derives `drawKey = ed25519(seed = sha256("h081/draw/v1" ‖ be32(sk_A) ‖ le64(lineNonce)))`.
  `payout_to` is drawKey's ATA for the asset. `agent_pk` is the pk A wants recorded in the Slot. By default
  it is a per-line pk `PublicKey(skLine)` with `skLine = Poseidon(14, sk_A, lineNonce)` (domain tag 14 = DOM_LINE; 13 is taken by the reputation branch); see section 13 for the ZK
  reputation interplay. A real `PublicKey(sk_A)` also works, at the cost of linkability.
- **Lender L.** An ordinary stream_loan lender with a public wallet, exactly as today.
- **Fee payer.** The relayer when the owner turns it on (section 11, decision D4). Otherwise each ephemeral
  key needs about 0.006 SOL from somewhere: an honest leak if that SOL comes from a known wallet.

Flow:

```
A --draw-key code (kind 9)--> B
B: back_open  (Backing + vault ATA)        ; stake = shielded withdraw from the pool -> vault ATA (PDA owner)
B --backing code (kind 8)--> A
L: open_slot (existing)  --loan terms code (kind 1, existing)--> A
A: back_request(loan_ref, advance, lender_fee_bps, expiry, agent_pk)   ; reserves the cover in the Backing
A --backing code with loan_ref (kind 8)--> L
L: fund_backed(loan_ref)        ; advance - 0.25% -> payout_to, fee -> treasury, Subrogation{to: vault, owed: backer_fee}
A: repays: any transfer into the slot inbox, normally a shielded withdraw/spend public payout to the slot PDA
anyone: sync (existing)         ; first backer_fee -> vault, rest -> L's ATA, capped at principal
happy:   L settle -> anyone back_release -> L close_slot (existing) -> B back_withdraw -> B back_close
default: after expiry + GRACE: anyone back_claim -> vault pays L min(lender shortfall, reserve); Subrogation.owed
         becomes paid + payout; later receipts recover it into the vault first; then release/withdraw/close as above
```

## 3. Data model (stream_loan, new accounts; existing layouts unchanged)

All amounts are base units of the loan asset. All sizes include the 8-byte Anchor discriminator. Rent uses
the mainnet figure measured 2026-10-31: 5,080 lamports per byte including the 128-byte overhead
(MAINNET-RUNBOOK P2).

### 3.1 `Backing`: PDA `["backing", backer, nonce u64 LE]`, **251 B**, rent ≈ 0.00193 SOL (refunded at `back_close`)

| field | type | bytes | meaning |
|---|---|---|---|
| backer | Pubkey | 32 | authority (the per-line ephemeral key); signs withdraw/close/cancel |
| draw_key | Pubkey | 32 | the only key that may request draws |
| lender | Pubkey | 32 | optional lender pin; `Pubkey::default()` = any lender |
| asset | Pubkey | 32 | loan asset mint (mainnet: USDG only, decision D3) |
| token_program | Pubkey | 32 | SPL Token or Token-2022 |
| payer | Pubkey | 32 | who paid the rent; receives it back at close |
| nonce | u64 | 8 | line nonce (part of the seeds) |
| cover_bps | u16 | 2 | share of each draw's lender exposure the stake guarantees, `MIN_COVER_BPS..=10000` |
| fee_bps | u16 | 2 | backer fee on each draw's advance, `0..=MAX_BACKER_FEE_BPS` |
| expiry | u64 | 8 | last unix time a draw may be due |
| reserved | u64 | 8 | sum of `reserve` over requested and funded, unclaimed draws |
| open_draws | u16 | 2 | draws not yet claimed, cancelled or released |
| draws_total | u32 | 4 | lifetime count, for status displays |
| covered_out | u64 | 8 | total paid to lenders by `back_claim` |
| created_at | i64 | 8 | |
| bump | u8 | 1 | |

**Stake is not a field.** The stake is the balance of the vault, the Backing PDA's associated token account
for `asset`. Anyone may top it up with a plain transfer. **Free stake** = `vault.amount - reserved`.
**Draw capacity** = `free * 10000 / cover_bps`.

### 3.2 `Draw`: PDA `["draw", loan_ref u64 LE]`, **202 B**, rent ≈ 0.00168 SOL (refunded to `payer` at cancel/release)

| field | type | bytes |
|---|---|---|
| loan_ref | u64 | 8 |
| backing | Pubkey | 32 |
| payer | Pubkey | 32 |
| payout_to | Pubkey | 32 |
| agent_pk | [u8; 32] | 32 (BE field element, copied to `Slot.agent_pk` at funding) |
| advance | u64 | 8 (gross amount the lender pays out) |
| backer_fee | u64 | 8 = floor(advance * fee_bps / 10000) |
| lender_fee | u64 | 8 = floor(advance * lender_fee_bps / 10000) |
| reserve | u64 | 8 = ceil((advance + lender_fee) * cover_bps / 10000) |
| expiry | u64 | 8 |
| requested_at | i64 | 8 |
| claimed | u64 | 8 (what `back_claim` paid) |
| state | u8 | 1 (0 requested, 1 funded, 2 claimed) |
| bump | u8 | 1 |

Since one Draw exists per loan_ref and loan refs are never reused, a slot can be backed at most once.

### 3.3 Reused, unchanged layouts

- **Slot** (253 B). A backed slot is funded with `pledge_bps = 0`, `min_remaining = 0`, `min_rate = 0`,
  `stream_start = 0`, `principal = advance + backer_fee + lender_fee`, `expiry = draw.expiry`,
  `agent_pk = draw.agent_pk` and `payout_to = draw.payout_to`. `pledge_bps == 0 && funded` is the marker,
  because a stream-funded slot always has `pledge_bps > 0`: `fund` requires principal > 0 =
  max_principal(..., bps).
- **Subrogation** (97 B). Created by `fund_backed` with `safety_config = Backing PDA`, `to = vault`,
  `owed = backer_fee` and `paid = 0`. Its rent (≈ 0.00114 SOL) is paid by the lender and, as today, is never
  closed. Because the account exists from funding onwards, a safety_pool `slash` on a backed loan fails at
  `record_slash`'s `init`. That makes backing and safety-pool cover mutually exclusive without touching
  safety_pool (decision D6).
- `account_sizes_are_unchanged` stays as it is. New size tests are added for Backing and Draw.

## 4. Instructions (all additive; no existing account list or behaviour changes)

Proposed compile-time constants live in a new `backer.rs`. There is no admin key and no setter:

| const | proposed | why |
|---|---|---|
| MIN_COVER_BPS | 2000 | a line may lever stake at most 5x |
| MAX_BACKER_FEE_BPS | 2000 | 20% of the advance |
| MAX_LENDER_FEE_BPS | 2000 | |
| MAX_DRAW | 10,000 * 10^6 | 10,000 USDG per draw |
| MAX_OPEN_DRAWS | 8 | bounds per-line state |
| MIN_TERM / MAX_LINE_TERM | 1 day / 180 days | |
| CLAIM_WINDOW | 30 days after expiry + GRACE | after this an unclaimed reserve returns to the backer |
| MAINNET_BACKED_ASSETS | [USDG `2u1tsz…`] | `--features mainnet` only; localnet accepts any mint |

The `fast` test feature (localnet only, own program id, never deployed) sets GRACE to 2 s, MIN_TERM to 1 s
and CLAIM_WINDOW to 5 s, the same way `safety_pool_fast` does.

### 4.1 `back_open(nonce, cover_bps, fee_bps, expiry, lender_pin)`

- **Signers:** `backer`, `payer`.
- **Accounts:** backing (init), backer, payer, mint, vault (ATA of backing, created idempotently),
  token_program, ata_program, system_program.
- **Checks:**
  - bps ranges;
  - `now + MIN_TERM <= expiry <= now + MAX_LINE_TERM`;
  - mint is a token mint of `token_program`;
  - the mainnet asset list.
- **Effect:** writes the Backing. Emits `BackingOpened{backing, backer, draw_key, asset, cover_bps, fee_bps, expiry, lender}`.
- The stake arrives separately, by any transfer into the vault. The SDK uses a shielded withdraw with
  `recipient = Backing PDA`; stipend_pool already pays to the canonical ATA of a PDA owner.

### 4.2 `back_request(loan_ref, advance, lender_fee_bps, expiry, agent_pk)`

- **Signers:** `draw_key`, `payer`.
- **Accounts:** backing (mut), slot, draw (init), payout_to, vault, draw_key, payer, system_program.
- **Checks:**
  - `slot` is not funded;
  - the lender pin, if set, equals `slot.lender`;
  - `0 < advance <= MAX_DRAW`;
  - `lender_fee_bps <= MAX_LENDER_FEE_BPS`;
  - `now + MIN_TERM <= expiry <= backing.expiry`;
  - `open_draws < MAX_OPEN_DRAWS`;
  - `payout_to` is a token account of `backing.asset` whose owner is none of `slot.lender`, the slot PDA,
    the backing PDA or the backer, and which is not the vault;
  - `agent_pk` < the BN254 field modulus;
  - `vault.amount - reserved >= reserve`.
- **Effect:** `reserved += reserve`, `open_draws += 1`, `draws_total += 1`. Writes the Draw.
  Emits `DrawRequested{loan_ref, backing, advance, backer_fee, lender_fee, reserve, expiry}`.
- The reserve is locked at request time, so the lender can see the cover before it pays.

### 4.3 `back_cancel(loan_ref)`

- **Signers:** the backer or the draw key, or **anyone** once `now > draw.expiry` or the slot was funded
  some other way (`slot.funded` while `draw.state == 0`).
- **Requires:** `draw.state == 0`.
- **Effect:** `reserved -= reserve`, `open_draws -= 1`. The Draw closes to `draw.payer`. Emits `DrawCancelled`.

### 4.4 `fund_backed(loan_ref)`

- **Signer:** `lender` (has_one on the slot).
- **Accounts:**
  - slot (mut), draw (mut), backing, vault;
  - lender, lender_source, mint, payout_to, inbox, ledger (init_if_needed);
  - escrow (the stipend_pool `["owed", mint, fieldOf(slot), loan_ref]`, must be empty);
  - treasury, subrogation (init), token_program, ata_program, system_program.
- **Checks:**
  - `draw.state == 0`, `!slot.funded`, `mint == backing.asset`, `payout_to == draw.payout_to`;
  - the lender pin;
  - `now <= draw.expiry - MIN_TERM`;
  - `vault.amount >= backing.reserved`, so the stake is still there (an issuer freeze or fee extension
    could change it);
  - the treasury checks and frozen-treasury rule exactly as in `fund`.
- **Effect:**
  - `fee = origination_fee(advance)`, the existing 25 bps platform fee, never creator fees;
  - `advance - fee` goes to payout_to and `fee` to the treasury ATA;
  - the inbox is created, and any pre-funding inbox balance is returned to payout_to (as `fund` does);
  - the Slot fields are set as in 3.3, with `funded_at = now`;
  - Subrogation is set to `{loan_ref, safety_config: backing, to: vault, owed: backer_fee, paid: 0}`;
  - `draw.state = 1`.
- **Events:** `LoanFunded` (unchanged shape, so existing indexers see the loan) and
  `BackedFunded{loan_ref, backing, advance, backer_fee, lender_fee, reserve}`.
- **Implementation note:** factor `fund`'s shared tail (transfers, inbox, pre-fund return, Ledger) into a
  helper that both `fund` and `fund_backed` call. Its behaviour must stay byte-for-byte the same for `fund`,
  which the lending suite already pins.

### 4.5 Repayment: existing `sync`, unchanged

- Anything that lands in the slot inbox in the loan asset is credited up to `principal` (the overpay cap).
- `split_receipt` sends the first `sub_left = owed - paid` (the backer fee) to the vault, then the rest to
  `ata(slot.lender)` (or held).
- The excess stays for `return_excess` to `payout_to`.
- The SDK `syncIx` already passes `subrogationTo` from the account's `to`.

### 4.6 `back_claim(loan_ref)`: the default path

- **Permissionless** (keepers and the lender's SDK call it).
- **Accounts:** slot (mut), draw (mut), backing (mut), vault (mut), subrogation (mut), inbox, escrow,
  lender_token (= ata(slot.lender)), mint, token_program.
- **Requires:**
  - `draw.state == 1`;
  - `shortfall_of(slot, now, pending) > 0`, where pending = unsynced inbox + escrow, the same as the
    `shortfall` view. That holds only after `expiry + GRACE` and only when not settled;
  - lender_token exists, is the lender's, and is not frozen.
- **Amount:** `lender_short = (principal - backer_fee) - (repaid - sub.paid) - pending` (saturating).
  `pay = min(lender_short, draw.reserve, vault.amount)`.
- **Effect:**
  - `pay` moves from the vault to lender_token, signed by the backing PDA;
  - `sub.owed = sub.paid + pay`. The unpaid part of the backer fee is forfeited, and the backer now
    recovers `pay` from later receipts first;
  - `draw.claimed = pay`, `draw.state = 2`;
  - `backing.reserved -= reserve`, `open_draws -= 1`, `covered_out += pay`.
- **Event:** `BackingClaimed{loan_ref, backing, lender, paid: pay, shortfall}`.
- One claim per draw.
- Afterwards `close_slot` stays blocked while `paid < owed && repaid < principal`. That is today's
  `subrogation_blocks_close`, so recovery cannot be bypassed.

### 4.7 `back_release(loan_ref)`

- **Permissionless.**
- **Effect:** frees the reserve of a funded draw and closes the Draw to `draw.payer`.
- **When allowed:** `state == 2` (claimed; only the close remains), or `state == 1` and any of:
  - `slot.repaid >= slot.principal`;
  - `slot.settled` (the lender gave up its claim);
  - the slot is closed (Slot account empty and ClosedSlot present);
  - `now > expiry + GRACE + CLAIM_WINDOW` (the lender never claimed).
- **Event:** `DrawReleased{loan_ref, backing, reason}`.

### 4.8 `back_withdraw(amount)`

- **Signer:** `backer`.
- **Effect:** moves `amount` from the vault to any destination token account of the asset.
- **Limit:** `amount <= vault.amount - reserved`. Fees and recoveries count as free balance.
- **Event:** `BackingWithdrawn{backing, amount}`.

### 4.9 `back_close()`

- **Signer:** `backer`.
- **Requires:** `open_draws == 0` and the vault empty.
- **Effect:** harvests any Token-2022 withheld fee and closes the vault ATA (as `close_inbox` does), then
  closes the Backing. Rent goes to `backing.payer`.
- **Event:** `BackingClosed`.

### 4.10 Errors

New `LoanError` variants are **appended** after `ReceiptNotWritable`, so existing codes keep their numbers:
`BackingTerms, NotTheBacker, NotTheDrawKey, DrawState, StakeShort, LineExpired, TooManyDraws, DrawTooLarge,
NoBackedDefault, NotReleasable, BackingBusy, LenderNotAllowed, AssetNotBackable`.

### 4.11 Compute (estimates; measure into `solana/compute-units-loan.json`)

| instruction | estimated CU |
|---|---|
| back_open | ~35k (ATA create) |
| back_request | ~20k |
| fund_backed | ~60k (3 inits, up to 3 transfers) |
| back_claim | ~35k |
| back_release / back_withdraw / back_close | ≤ 25k each |

All are far under 200k, so no budget instruction is needed.

## 5. Circuits

**None for v1.** Every rule is enforced on public token balances and Slot state. There are no new vk, no
`gen-solana-vk.mjs` run and no ceremony entry. The v2 shielded-amount design (section 12) would need one.

## 6. SDK

### 6.1 `src/solana/backer.ts` (new)

```ts
export const BACKING_SIZE = 251, DRAW_SIZE = 202;
export function backingPda(backer: PublicKey, nonce: bigint, programId?): PublicKey;
export function drawPda(loanRef: bigint, programId?): PublicKey;
export function backingVault(backing: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey;
export function backerKeyFor(sk: bigint, nonce: bigint): Keypair;     // sha256("h081/backer/v1"|be32 sk|le64 nonce)
export function drawKeyFor(sk: bigint, lineNonce: bigint): Keypair;   // sha256("h081/draw/v1"|...)
export function backedTerms(a: { advance: bigint; feeBps: number; lenderFeeBps: number; coverBps: number }):
  { principal: bigint; backerFee: bigint; lenderFee: bigint; reserve: bigint; originationFee: bigint; toPayout: bigint; lenderDue: bigint };
export function backedClaimAmount(s: { principal; repaid; pending; backerFee; subPaid; reserve; vault }): bigint;
export function releaseReason(s): 'claimed' | 'repaid' | 'settled' | 'closed' | 'unclaimed' | null;
// instruction builders (account order = section 4)
export function backOpenIx(...), backRequestIx(...), backCancelIx(...), fundBackedIx(...), backClaimIx(...),
  backReleaseIx(...), backWithdrawIx(...), backCloseIx(...): TransactionInstruction;
export function decodeBacking(data: Uint8Array): BackingAccount;
export function decodeDraw(data: Uint8Array): DrawAccount;
export async function backingStatus(conn, backing): Promise<{ stake; reserved; free; capacity; draws: DrawAccount[] }>;
export const isBackedSlot = (s: SlotAccount) => s.funded && s.pledgeBps === 0;
```

Rust/TS parity: `backedTerms` and `backedClaimAmount` are mirrored by Rust unit tests on the same vectors
(`test/data/backer-vectors.json`).

### 6.2 Role classes

- `SolanaBacker` (backer.ts):
  - `open({ nonce, coverBps, feeBps, days, lender?, drawKey, asset })`;
  - `stakeFromShielded(wallet: SolanaWallet, amount)` (a shielded withdraw to the backing PDA, through the relayer);
  - `status()`, `withdraw(amount, toShielded = true)`, `cancel(loanRef)`, `close()`.
  - With `toShielded`, the withdraw goes to the backer key's ATA and is then re-deposited into the pool,
    with the backer key as depositor.
- `SolanaBackedBorrower` (backer.ts):
  - `drawKeyCode()` (kind 9), `request({ backingCode, loanRef, advance, lenderFeeBps, days })` (returns a
    kind 8 code naming loan_ref), `cancel(loanRef)`;
  - `repay(wallet, loanRef, amount)`: a shielded withdraw to the slot PDA, then `sync`;
  - `shieldAdvance(wallet)`: deposits the payout from the draw key into the pool.
- `src/solana/lender.ts`: `SolanaLoanLenderWallet` gains `fundBacked(loanRef)`, `claimBacked(loanRef)`,
  `releaseBacked(loanRef)` and `backedStatus(loanRef)`.
  - `loanStatus` reports `backed: { backing, reserve, backerFee, lenderFee, coverBps }` when a Draw exists.
  - `decodeSubrogation` consumers label `safetyConfig == draw.backing` as "backer", not "safety pool".
  - `insure` helpers refuse a backed slot.

### 6.3 Agent SDK (`integrations/core/bank.ts`, `integrations/agent`)

- `H081Bank`:
  - `backOpen`, `backStake`, `backStatus`, `backWithdraw`, `backCancel`, `backClose`;
  - `backDrawKey`, `backDrawRequest`, `backDrawCancel`, `backRepay`;
  - `lendFundBacked`, `backClaim`, `backRelease`.
- Every write returns a **plan** unless `confirm: true`. A plan carries the exact instruction list, the
  amounts, the SOL rent, what becomes public, and an idempotency key.
- `@h081lll/agent` `H081`:
  - methods: `back(action, ...)` and `draw(action, ...)`;
  - CLI: `h081 back open|stake|status|withdraw|cancel|close|claim|release` and
    `h081 draw key|request|cancel|repay|status`;
  - local API (`server.ts`): `POST /v1/backing`, `GET /v1/backing/:id`, `POST /v1/backing/:id/{stake,withdraw,close}`,
    `POST /v1/draws`, `POST /v1/draws/:loanRef/{cancel,repay,claim,release}`;
  - regenerate `openapi.json`.

### 6.4 Operator ceilings (env; refused with no send, like `H081_MAX_LEND`)

- `H081_MAX_BACK`: the most a single `back stake` may move into a vault, and the most a backing's vault
  may hold after it.
- `H081_MAX_DRAW`: the largest advance an agent may request.
- `H081_MAX_LEND`: the existing variable, also applied to `fund_backed`'s advance.

If unset, the defaults match the existing ones (refuse above the documented default). The MCP server
prints them at start, as `mcp/src/server.ts` does for `H081_MAX_LEND`.

## 7. Integrations (MCP + solana-agent-kit)

`schemas.ts` gains `OPS`, `DESCRIPTIONS`, `ZOD`, `JSON_SCHEMA` and `EXAMPLE_INPUTS` entries.
`operations.ts` gains `OPERATIONS` entries. Each action reads only its own fields and refuses stray ones,
as `h081_lend` does.

- `h081_back`, with `action`:
  - `open {drawKeyCode, stakeUsdg, coverBps, feeBps, days, lender?}`;
  - `stake {backingCode, usdg}`;
  - `status {backingCode}`;
  - `withdraw {backingCode, usdg|all, toShielded?}`;
  - `cancel {loanRef}`;
  - `close {backingCode}`;
  - `claim {loanRef}`;
  - `release {loanRef}`.
  - Every write takes `confirm`.
- `h081_back_draw`, with `action`:
  - `key {}`, which returns a kind 9 code (read-only, no confirm);
  - `request {backingCode, loanRef | termsCode, usdg, lenderFeeBps, days}`;
  - `cancel {loanRef}`;
  - `repay {loanRef, usdg}`;
  - `status {loanRef}`.
- `h081_lend action=fund` auto-detects a backing code (kind 8) instead of a proof code and calls
  `lendFundBacked`. No new lend action is needed.
- MCP (`integrations/mcp/src/tools.ts`): it maps OPS automatically, so the two new ops appear on their own.
- solana-agent-kit: `actions/back.ts` and `actions/backDraw.ts`, registered in `index.ts`.

## 8. Code framing (v2 frame: letters and digits, checksum, kind, network tag, Copy button, live check)

These kinds must also be added to the site's `src/lib/live/codes.ts` + `frame.ts`, with unit tests there.
Kind 7 is expected to be taken by the reputation proof (`feat/zk-reputation`), so the backer uses 8 and 9.
If the reputation branch lands with other numbers, renumber before merge (decision D8).

| kind | name | from → to | body |
|---|---|---|---|
| 8 | backing code | backer → agent, agent → lender | backing PDA 32 ‖ loan_ref u64 LE (0 = none yet), 40 B |
| 9 | draw key code | agent → backer | draw_key 32 ‖ payout_to 32 ‖ agent_pk 32, 96 B |

The context tag binds cluster, the stream_loan program and the mint, as today. No raw base58 or JSON is
pasted between people.

## 9. Privacy analysis (what leaks on chain)

**Public, exactly as for every stream_loan loan today:**

- Slot: lender wallet, principal (= advance + fees), expiry, payout_to (the draw key's ATA), agent_pk, funded_at.
- `LoanFunded`, `DripRouted` and `DripSubrogated` events. The latter shows each backer-fee and recovery
  payment into the vault.
- Default: `BackingClaimed` with the amount.

**Public, new:**

- **Stake size.** The vault balance is a plain token balance. Every top-up, withdrawal, fee and recovery is
  visible.
- **Line terms.** cover_bps, fee_bps, expiry, optional lender pin, reserved, open draw count and
  covered_out.
- **The relation backer key ↔ draw key ↔ lender(s).** The line is a public edge between two pseudonyms
  and the lender.
- **The stake's origin transaction.** A shielded withdraw of amount X to the vault. It shows that *someone
  in the pool* funded it, not who.

**Hidden in v1:**

- **The backer's identity.** The backer key is fresh per line and derived from `sk_B`. The stake comes out
  of the pool. With the relayer as fee payer, no SOL trail leads to the backer's wallet. Two lines by the
  same backer are unlinkable on chain, apart from amount and timing correlation.
- **The agent's identity.** The draw key and agent_pk are per line. The advance can be re-deposited into
  the pool. Repayments can be made from the pool (a withdraw to the slot PDA's ATA), which hides the payer.
- **Where the backer's earnings go.** A withdraw to the backer key, then a re-deposit into the pool, hides
  the final destination. It does not hide the amount.

**Residual risks to state to users:**

- (1) **Amount and timing correlation.** A stake of an unusual size, withdrawn from the pool right after a
  deposit of the same size, links the two. The SDK warns and suggests round amounts and a delay.
- (2) **SOL for fees.** If the relayer does not sponsor fees, funding an ephemeral key with SOL from a known
  wallet links that wallet.
- (3) **Pinned lenders.** If the backer pins a lender it is known to work with, that is a hint.
- (4) **Reusing a real agent pk.** Using `PublicKey(sk_A)` as agent_pk links this loan to all of the
  agent's other loans (the same caveat as the reputation spec).
- (5) **The lender is never shielded.** It funds from a public account, as today.

**Not claimed:** confidential amounts, a hidden line size, a hidden default.

## 10. Cost (mainnet, SOL)

| item | estimate |
|---|---|
| stream_loan extend (8 instructions, 2 accounts, events, errors) | **45-75 KB** → 0.23-0.38 SOL locked (5,080 lamports/B). It is back only through `solana program close`, which is never done while users hold loans. For calibration, the overpay cap was estimated at 8-14 KB and came out at 22.6 KB, so the upper end of this range is the honest planning figure. |
| deploy buffer (temporary, refunded after deploy) | ≈ 1.7-2.0 SOL, the size of the whole `.so` |
| per line: Backing + vault ATA | ≈ 0.0019 + ≈ 0.0015-0.002 SOL, refunded at close |
| per draw: Draw (refunded) + Subrogation (paid by lender, not refunded) | ≈ 0.0017 + 0.0011 SOL |
| new-program alternative | ≈ 1.0-1.3 SOL program + ≈ 0.05-0.1 SOL stream_loan change |

**Planning figure: about 0.4 SOL locked, plus about 2 SOL needed only during the upgrade.** Measure the
real size with `solana/scripts/loan-build.sh` before asking for the go.

## 11. Owner decisions

- **D1. Fee order.** The backer fee is paid first from repayments. This reuses Subrogation and needs no
  `sync` change. The alternative is a pro-rata fee split inside `sync_inbox`, about +4-8 KB and a change to
  a live path.
- **D2. Constants** (section 4): MIN_COVER_BPS 2000, the fee caps of 20%, MAX_DRAW 10,000 USDG,
  MAX_OPEN_DRAWS 8, terms of 1-180 days, CLAIM_WINDOW 30 days.
- **D3. Assets.** USDG only on mainnet, or any mint.
- **D4. Relayer fee sponsorship.** The relayer would pay SOL fees and rent for the backer/draw ephemeral
  keys and charge a USDG relay fee. This needs a relayer allowlist for the new stream_loan instructions and
  costs the hot wallet SOL. Without it, privacy leak (2) applies.
- **D5. The upgrade itself.** The extend and deploy of stream_loan are owner-only and done with the
  deployer key. Keep the upgrade authority, never `--final`.
- **D6.** Backed loans and safety_pool cover are mutually exclusive in v1. The SDK refuses `insure` on a
  backed slot. Underwriting is off on mainnet today anyway.
- **D7.** Whether to fund the v2 shielded-amount design (new circuit + stipend_pool upgrade + ceremony).
- **D8.** Code kind numbers 8 and 9 (coordinate with the reputation branch's kind 7).
- **D9.** The origination fee (25 bps, platform fee) applies to the advance of backed loans, the same as
  for stream loans.

## 12. v2 (not in scope): confidential stake

A "bond" note in the stipend_pool tree, `B = Poseidon(15, asset, amount, backerPk, lineId, blinding)`, with
a new `bond.circom`:

- the backer locks a note to a line;
- stream_loan, through a new stipend_pool instruction it CPIs, can withdraw `min(shortfall, reserve)` from
  the pool vault only on a proven default;
- the backer re-spends the bond after release, against a nullifier.

This hides the stake size and keeps stake and fees inside the pool. It costs:

- a stipend_pool upgrade. ProgramData is 350,568 B with zero slack, so it needs an extend;
- a new vk outside `gen-solana-vk.mjs`'s six (never regenerate the ceremony vks);
- a production ceremony, which is the owner's step;
- about +60-100 KB on stipend_pool.

The default event and the line size would still be public, because stream_loan must know the cover.

## 13. Interplay with ZK reputation

`fund_backed` copies `agent_pk` into the Slot, so a fully repaid backed loan qualifies for the reputation
branch's `attest_repaid`. Its Subrogation is fully paid (`paid >= owed`) once the fee has been paid; a
defaulted one does not qualify until it is recovered.

This gives the onboarding funnel: a new agent borrows backed, repays, proves "N repaid loans ≥ $X"
privately, then borrows at a lower cover or unbacked. Use per-loan agent pks derived from one master, so
the reputation circuit can aggregate them. The reputation spec should treat a Subrogation whose
`safety_config` is a Backing PDA as "backer fee/recovery", not as a safety-pool slash.

## 14. Test plan

### Rust unit tests (`cargo test --manifest-path solana/programs/stream_loan/Cargo.toml`, WSL)

- `backed_terms` rounding: fees round down, the reserve rounds up, and the overflow edges at
  MAX_DRAW and 10000 bps.
- `backed_claim_amount` truth table:
  - partial repay below, at and above the fee;
  - pending inbox and escrow;
  - a vault smaller than the reserve;
  - repaid ≥ principal → 0.
- `release_reason` truth table (all 5 reasons, plus not releasable).
- Backing::INIT_SPACE + 8 == 251 and Draw == 202. Existing `account_sizes_are_unchanged` and
  `cover_offsets_match_safety_pool` unchanged.
- `split_receipt` with `sub_left = backer_fee`: the existing tests plus vectors from `test/data/backer-vectors.json`.

### TypeScript unit tests (vitest, no validator)

- `test/backer/terms.test.ts`: the same vectors as Rust; `backerKeyFor`/`drawKeyFor` are deterministic,
  differ per nonce, and never equal the account's main key.
- `test/backer/codes.test.ts`: kinds 8 and 9 round-trip; a wrong checksum, wrong network or wrong kind is
  refused with its own message.
- `test/integrations/back-ops.test.ts`:
  - zod rejects stray fields;
  - a plan without `confirm` sends nothing (mock connection asserts zero `sendTransaction`);
  - `H081_MAX_BACK` and `H081_MAX_DRAW` refuse;
  - lend fund with a kind 8 code routes to `lendFundBacked`.
- Agent: the openapi snapshot includes the new routes; CLI `--help` lists `back` and `draw`.
- The MCP tool list includes `h081_back` and `h081_back_draw`. agent-kit registers both actions.
- Site (stipend-site `test/`): mirror the code kinds 8/9 in `codes.ts`. This is a unit test only, with no
  LiveBank change in v1.

### Localnet (loan suite, private validator rpc 9099; add `test/solana/backer.test.ts` to `vitest.solana-loan.config.ts`; plus the `stream_loan_fast` id)

1. **Three wallets, happy path**:
   - backer key B, agent draw key A and lender L, with a test payer standing in for the relayer;
   - B `back_open` (cover 4000, fee 500 bps); stake 300 USDG through a **shielded withdraw from the pool**
     to the backing PDA;
   - L `open_slot`; A `back_request` advance 500, lender fee 300 bps; check `reserved` and capacity;
   - L `fund_backed`: payout gets 500 - 1.25, the treasury gets 1.25, Subrogation owed = 25,
     `LoanFunded` and `BackedFunded` are emitted, and the Slot carries `pledge_bps = 0`;
   - A repays 300 by direct transfer and 240 by a shielded withdraw to the slot PDA; `sync` sends 25 to the
     vault first and 515 to L; principal is capped and the excess goes to `return_excess`;
   - L `settle`; anyone `back_release`; L `close_slot` (ClosedSlot v2); B `back_withdraw` all (re-deposit
     into the pool); B `back_close`; every rent refund is checked.
2. **Default, fast build** (GRACE 2 s):
   - fund, then partial repay 10 (< fee); wait past expiry + grace;
   - a stranger calls `back_claim`: L gets `min(lender_short, reserve)` exactly;
   - `sub.owed = 10 + pay`; a second claim → `DrawState`;
   - a later repayment goes to the vault first until recovered, then to L;
   - `close_slot` is refused (`SubrogationOpen`) until repaid;
   - release, withdraw and close.
3. **Leveraged full default** (cover 2000, nothing repaid): the lender gets exactly 20% of its due, and
   the backer's vault drops by exactly the reserve.
4. **Four wallets, two lenders, one backing**: two draws share the stake. Reserves accumulate and free
   correctly. Claiming one does not touch the other's reserve.
5. **Negative cases**:
   - request by a non-draw key; reserve > free stake; expiry > line expiry; the 9th open draw;
   - pinned lender mismatch at request and at fund;
   - payout_to owned by the lender, the slot, the backing or the backer;
   - `back_withdraw` into reserved stake; `back_close` with an open draw or a non-empty vault;
   - `fund_backed` twice; `fund_backed` after the draw expired; regular stream `fund` on a requested slot,
     then a permissionless `back_cancel`;
   - `back_claim` before grace, on a settled loan, or with an unsynced inbox that covers the shortfall;
   - `back_release` too early.
6. **Unchanged paths**: the existing `lending.test.ts` and `lend-localnet.test.ts` pass unmodified on the
   new `.so`.
7. **Staking suite**: `insure` on a backed slot, then `slash` fails at `record_slash` (account in use);
   `release_cover` after settle lets `close_slot` proceed.
8. **Integration localnet** (`test/integrations/back-localnet.test.ts`): the same three-wallet flow through
   `H081Bank` ops with plan → `confirm:true`, and codes passed as strings between wallets.
9. **Upgrade rehearsal on localnet**:
   - load the **current mainnet** stream_loan `.so` and create loans in every state (open, funded,
     slashed, closed);
   - `solana program extend` + deploy the new `.so` *on the local validator*;
   - check every old account decodes and every old instruction behaves the same, then run 1 and 2.

Run everything with `npm run test:solana` (the pool, loan and staking suites on private validators), plus
`npx vitest run` and `npm run typecheck`. In stipend-site, `npm run test:full` also runs these.

## 15. Files to change

- **Programs:** `solana/programs/stream_loan/src/`:
  - `backer.rs` (new: constants, Backing, Draw, pure math);
  - `lib.rs` (8 entry points, Accounts structs, events, `fund` tail helper);
  - `error.rs` (appended variants);
  - `Cargo.toml` (`fast` feature); `solana/keys/stream_loan_fast-keypair.json` (localnet, via keygen);
  - `solana/scripts/loan-build.sh` (also builds fast).
- **SDK:** `src/solana/backer.ts` (new), `src/solana/lender.ts` (fundBacked/claimBacked/releaseBacked,
  backed status), `src/solana/token.ts` (insure guard), `src/index.ts` exports.
- **Integrations:**
  - `integrations/core/{bank.ts,operations.ts,schemas.ts,codes.ts,errors.ts}`;
  - `integrations/agent/src/{h081.ts,cli.ts,server.ts}`, `openapi.json`;
  - `integrations/solana-agent-kit/src/actions/{back.ts,backDraw.ts}`, `index.ts`.
- **Relayer (only if D4):** allowlist the backer instructions for fee sponsorship. `x402/loans.ts`
  labels backed slots and shows cover.
- **Tests:** as in section 14.
- **Docs:** this file. MAINNET-RUNBOOK gets a new upgrade section once D5 is given.

## 16. Migration and upgrade notes

- Additive only:
  - Slot, Ledger, Registry, ClosedSlot and Subrogation layouts are unchanged;
  - existing instruction discriminators, account lists and error codes are unchanged;
  - `fund`'s behaviour is unchanged (its tail is refactored into a helper and pinned by the existing suite).
- `safety_pool`, `stipend_pool` and `capacity_stake` are **not** upgraded.
- Readers that assume every funded Slot came from a stream proof (pledge_bps > 0): the x402 loans market,
  the site's loan views and the agent's `lendStatus`. They must handle `pledge_bps == 0` (show "backed",
  with the Draw's cover).
- The upgrade (owner): measure the `.so` → `solana program extend 8JBd7… <bytes>` → deploy → hash check.
  Rehearse on localnet first (section 14, item 9). The upgrade authority is kept, never `--final`.
- Nothing can be backed on mainnet until that upgrade. The SDK checks for the instruction by simulating
  `back_open` on localnet only. On mainnet it reads the program's ProgramData length/hash against a
  compiled-in value before offering the feature.
