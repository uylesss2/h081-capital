# DefiLlama listings for H081 Capital

Two ready-to-submit adapters for DefiLlama, prepared as files here and verified against mainnet (see
`VERIFY.md`). Nothing in this folder is wired into the protocol build; it is copied into the two
upstream repositories by the owner (`OWNER-GUIDE.md`).

| Listing | Upstream repo | File to add | PR body |
|---|---|---|---|
| TVL | https://github.com/DefiLlama/DefiLlama-Adapters (branch `main`) | `tvl/projects/h081/index.js` -> `projects/h081/index.js` | `PR-TVL.md` |
| Fees / revenue | https://github.com/DefiLlama/dimension-adapters (branch `master`) | `fees/fees/h081.ts` -> `fees/h081.ts` | `PR-FEES.md` |

## What is counted

**TVL** (`projects/h081/index.js`): the balance of the bank's accepted deposit mints (`DEPOSIT_MINTS`,
USDG today) in the token accounts owned by the stipend_pool vault authority PDA `["vault_auth"]` of
`E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM` (= `9JnWo2rJ1MpB14NKNSEXCV2iMtMim6oUpHpgJFSVb2B7`).
The helper lists that owner's accounts per mint (`getTokenAccountsByOwner` with a mint filter, so the
PDA vault `FaRG7DV8e7XF3RyoZrBb3h1oLiFFWFFCuYDSXsDoyyzG` = `["vault", USDG]` and any `["owed", ...]`
lender escrow in USDG are all counted; Token-2022 is handled). Mints are listed on purpose: a token
account anyone can create for the vault authority in another mint is never touched by the program
and must not become TVL. A new deposit asset is a one-line change to `DEPOSIT_MINTS` (owner guide,
section 4).

**Staking** (own token, reported in DefiLlama's separate `staking` bucket): the H081 held by the
capacity_stake vault `["vault", H081]` of `CH1rrfFyJMVn158UHL2fLpKTtoLJojrz5f68toMQdQKU`
(= `EUMsBu6yj1DAXriTMSaGQCs6Ff4H6Rb7QTueGa7AN6Nh`) and the safety_pool vault `["vault", H081]` of
`HmzKNPn8LaRyjmggt2uT95B7KvphtoVXQkeVc2HHARTt` (= `4qM5m3UGiJnn9G3rVUC9b2uMxJmnxKcDXDetX7UDXT8g`).
H081 is the protocol's own token, so DefiLlama's rule puts it under `staking`, not `tvl`.

Loan principal is paid by the lender directly to the borrower's named account (`stream_loan::fund`
transfers `lender_source -> payout_to`) and never passes through the bank vault; only the borrower's
pledged deposit, already in the vault, is in TVL. So there is no `borrowed` bucket (it could be added
later from the stream_loan slot / registry accounts).

**Fees** (`fees/h081.ts`): USDG received by the treasury `EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq`
/ its fee-only USDG token account `DxpmCZYAoDKpHmA5vWuopUrf3UVuGnPvditVrN9xDwDo`, i.e. the 0.20%
relay fee (sent out of the bank vault by stipend_pool, transaction signed by the relayer hot wallet)
and the 0.25% loan origination fee (sent from the lender's own account in `stream_loan::fund`).
Revenue = protocol revenue = fees (100% to the treasury). Only USDG is counted (`mints`), the H081
mint is blacklisted, and transfers **from** any team wallet (deployer, config authority, fee / launch
wallets, the Squads multisig, its create key and members, the relayer hot wallet) or **signed** by any
of them except the relayer hot wallet (it signs the fee-paying relays) are excluded. Limit of the
method: a USDG transfer from an unrelated third party would count; the protocol has no such inflow
path and the treasury's USDG account must only ever be funded from a listed wallet (owner guide,
section 4). **H081 token trading / creator fees are not protocol fees and are excluded**; the
methodology text says so.

All addresses are derived at runtime from the program ids and mints in `docs/MAINNET-RUNBOOK.md`;
`scripts/derive-addresses.mjs` re-derives them and checks each one on mainnet.

## Current numbers (2026-11-02)

- tvl: 29 USDG (~$29); staking: 3,000 H081 ($0 until DefiLlama prices H081; the amount is reported)
- fees: 0 USDG every day so far (the treasury USDG account has received nothing)

## Files

- `tvl/projects/h081/index.js` - TVL adapter (CommonJS, repo helpers only, no new dependency)
- `fees/fees/h081.ts` - fees/revenue adapter (TypeScript, repo helpers only)
- `PR-TVL.md`, `PR-FEES.md` - PR titles and bodies, listing form filled in
- `OWNER-GUIDE.md` - how to fork, push the branches and open both PRs
- `VERIFY.md` - commands run and their output
- `scripts/derive-addresses.mjs` - derives every address and checks it on mainnet (read-only)
- `scripts/fees-rpc-check.mjs` - zero-dependency per-day fee cross-check straight from transactions
  (same sender / signer exclusion lists as the adapter)
- `scripts/derive-addresses.test.ts`, `scripts/adapters.test.ts`, `scripts/stubs/`, `vitest.config.ts` -
  offline unit tests: `npx vitest run --config integrations/defillama/vitest.config.ts`. The
  derivation test pins every address; the adapter test loads and runs both adapter modules against
  stubs of the DefiLlama helpers (the fees adapter's upstream-relative imports are aliased to
  `scripts/stubs/`) and asserts the exact helper arguments. The upstream `test.js` / `ts-check` runs in
  `VERIFY.md` remain the execution proof against the real helpers.

## Rules kept

- Only the H081 project and its official token `EgqxxR7zowzaLEm24oep5qqBieLVAWYX78LhgeqAJAo` are
  named in public text.
- Wording: live on Solana mainnet, not audited yet, use at your own risk.
- The treasury is the only fee recipient; never a launch wallet.
- No package, lockfile or workspace file of either upstream repo is changed.
