# PR to DefiLlama/DefiLlama-Adapters

Branch: `h081-tvl` (from upstream `main`). File added: `projects/h081/index.js`. Nothing else changed.

## Title

```
feat: add H081 Capital (Solana)
```

## Body (paste as-is; the template is the repo's pull_request_template.md)

```markdown
**NOTE**

#### Please enable "Allow edits by maintainers" while putting up the PR.

---

1. If you would like to add a `volume/fees/revenue` adapter please submit the PR [here](https://github.com/DefiLlama/dimension-adapters).

2. Once your adapter has been merged, it takes time to show on the UI. If more than 24 hours have passed, please let us know in Discord.
3. Sorry, We no longer accept fetch adapter for new projects, we prefer the tvl to computed from blockchain data, if you have trouble with creating a the adapter, please hop onto our discord, we are happy to assist you.
4. **For updating listing info** Please send a mail to metadata@defillama.com
5. Please do not add new npm dependencies, do not edit/push `pnpm-lock.yaml` file as part of your changes

---
## (Needs to be filled only for new listings)

##### Name (to be shown on DefiLlama):
H081 Capital

##### Twitter Link:
https://x.com/H081CAP

##### List of audit links if any:
None yet (the protocol is live on Solana mainnet, not audited yet; use at your own risk).

##### Website Link:
https://h081.xyz

##### Logo (High resolution, will be shown with rounded borders):
![H081 Capital](https://h081.xyz/brand/h081-512.png)

(512x512 PNG; the same file is attached to this PR)

##### Current TVL:
~$29 (29 USDG in the bank vault) plus 3,000 H081 staked (reported under staking)

##### Treasury Addresses (if the protocol has treasury)
solana:EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq

##### Chain:
Solana

##### Coingecko ID (so your TVL can appear on Coingecko, leave empty if not listed): (https://api.coingecko.com/api/v3/coins/list)


##### Coinmarketcap ID (so your TVL can appear on Coinmarketcap, leave empty if not listed): (https://api.coinmarketcap.com/data-api/v3/map/all?listing_status=active,inactive,untracked&start=1&limit=10000)


##### Short Description (to be shown on DefiLlama):
H081 Capital is a private bank for AI agents on Solana: shielded USDG deposits with programmable spending policies, streamed allowances and loans pledged against them. Live on Solana mainnet, not audited yet, use at your own risk.

##### Token address and ticker if any:
solana:EgqxxR7zowzaLEm24oep5qqBieLVAWYX78LhgeqAJAo (H081)

##### Category (full list at https://defillama.com/categories) \*Please choose only one:
Lending

##### Oracle Provider(s): Specify the oracle(s) used (e.g., Chainlink, Band, API3, TWAP, etc.):
None. Deposits, allowances and loans are denominated in the deposited asset (USDG); no price oracle is used.

##### Implementation Details: Briefly describe how the oracle is integrated into your project:
Not applicable (no oracle).

##### Documentation/Proof: Provide links to documentation or any other resources that verify the oracle's usage:
Not applicable (no oracle).

##### forkedFrom (Does your project originate from another project):
No

##### methodology (what is being counted as tvl, how is tvl being calculated):
TVL = the balance of the bank's accepted deposit mints (USDG 2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH today) in the token accounts owned by the stipend_pool vault authority PDA ["vault_auth"] of program E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM (the USDG vault FaRG7DV8e7XF3RyoZrBb3h1oLiFFWFFCuYDSXsDoyyzG plus any lender escrow of the same owner), read on-chain via getTokenAccountsByOwner with a mint filter (Token-2022). Only listed mints count, so a token account someone else creates for the vault authority is never TVL. Staking = the H081 (the protocol's own token) held by the capacity_stake vault PDA ["vault", H081] of CH1rrfFyJMVn158UHL2fLpKTtoLJojrz5f68toMQdQKU and the safety_pool vault PDA ["vault", H081] of HmzKNPn8LaRyjmggt2uT95B7KvphtoVXQkeVc2HHARTt, reported in the staking bucket. Loan principal is paid by the lender directly to the borrower's named account and never passes through the bank vault; only the borrower's pledged deposit (already in the vault) is in TVL, so no borrowed bucket is reported. Every address is derived at runtime from the program ids and mints; no API is used.

##### Github org/user (Optional, if your code is open source, we can track activity):
https://github.com/uylesss2/h081-capital

##### Does this project have a referral program?
No
```

## Validation run before opening (see VERIFY.md)

```
node test.js projects/h081/index.js    -> tvl USDG 29.00, staking 3,000 H081 (unpriced), total $29.00 (public RPC, 2 Solana calls)
npx eslint -c eslint.config.js projects/h081/index.js    -> clean
git status --short                      -> only projects/h081/ (no package/lockfile change)
```
