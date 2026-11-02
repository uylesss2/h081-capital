# PR to DefiLlama/dimension-adapters

Branch: `h081-fees` (from upstream `master`). File added: `fees/h081.ts`. Nothing else changed.

## Title

```
feat: add H081 Capital fees and revenue (Solana)
```

## Body (paste as-is; the template is the repo's pull_request_template.md)

```markdown
**NOTE**

#### Please enable "Allow edits by maintainers" while putting up the PR.

---

> - If you would like to add a `tvl` adapter please submit the PR [here](https://github.com/DefiLlama/DefiLlama-Adapters).

1. Once your adapter has been merged, it takes time to show on the UI. If more than 24 hours have passed, please let us know in Discord.
2. Please fill the form below **only if the PR is for listing a new protocol** else it can be ignored/replaced with reason/details about the PR
3. **For updating listing info** Please send a mail to metadata@defillama.com
4. Do not edit/push `package.json/package-lock.json` file as part of your changes
5. No need to go to our discord/other channel and announce that you've created a PR, we monitor all PRs and will review it asap

---

##### Name (to be shown on DefiLlama):
H081 Capital

##### Twitter Link:
https://x.com/H081CAP

##### List of audit links if any:
None yet (the protocol is live on Solana mainnet, not audited yet; use at your own risk).

##### Website Link:
https://h081.xyz

##### Logo (High resolution, will be shown with rounded borders):
<!-- TODO owner: attach the same square PNG/SVG used in the TVL PR -->

##### Current TVL:
~$29 (29 USDG) plus 3,000 H081 staked; TVL adapter: DefiLlama-Adapters `projects/h081` (PR link: <!-- TODO owner: paste the TVL PR URL -->)

##### Treasury Addresses (if the protocol has treasury)
solana:EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq (USDG token account solana:DxpmCZYAoDKpHmA5vWuopUrf3UVuGnPvditVrN9xDwDo)

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
None (no price oracle).

##### Implementation Details: Briefly describe how the oracle is integrated into your project:
Not applicable.

##### Documentation/Proof: Provide links to documentation or any other resources that verify the oracle's usage:
Not applicable.

##### forkedFrom (Does your project originate from another project):
No

##### methodology (what is being counted as tvl, how is tvl being calculated):
Fees = USDG received by the protocol treasury (EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq, USDG token account DxpmCZYAoDKpHmA5vWuopUrf3UVuGnPvditVrN9xDwDo) via helpers/token.ts getSolanaReceived (Allium solana.assets.transfers, mint = USDG, H081 mint blacklisted). These are the protocol's two fee sources: the 0.20% relay fee on relayed withdrawals and spends (transferred out of the bank vault FaRG7DV8e7XF3RyoZrBb3h1oLiFFWFFCuYDSXsDoyyzG by the stipend_pool program, transaction signed by the relayer hot wallet), and the 0.25% loan origination fee on funded loans (sent from the lender's own token account in stream_loan::fund). The treasury's USDG account is fee-only: the protocol sends nothing else to it and the team never funds it from an unlisted wallet. Transfers from any team wallet (treasury, deployer, config authority, the Squads multisig, its create key and members, the relayer hot wallet) are excluded, as are transfers signed by any of them except the relayer hot wallet, which signs the fee-paying relays but never holds fees. Revenue = ProtocolRevenue = Fees: 100% goes to the treasury, there is no supply-side share. H081 token trading and creator fees are not protocol fees and are excluded.

##### Github org/user (Optional, if your code is open source, we can track activity):
https://github.com/uylesss2/h081-capital

##### Does this project have a referral program?
No
```

## Validation run before opening (see VERIFY.md)

```
pnpm run ts-check                         -> clean (exit 0)
pnpm test fees h081 2026-11-02            -> module loads; throws "Allium API Key is required[Ignore this error for github bot]"
                                             (expected without ALLIUM_API_KEY; DefiLlama's CI bot runs the real query)
node integrations/defillama/scripts/fees-rpc-check.mjs 2026-10-31 2026-11-02
                                          -> 0 USDG per day (independent RPC cross-check; the ATA has 1 tx, its creation by the deployer, excluded)
git status --short                        -> only fees/h081.ts (no package/lockfile change)
```

Note for reviewers (add as a PR comment if asked): the treasury has collected 0 fees so far; the adapter
returns 0 until the first relayed withdrawal or funded loan. The ATA was created on 2026-10-31 by the
deployer (excluded by the signer blacklist). The only fee paths into the treasury's USDG account are
the bank vault (relay fee, via the stipend_pool program) and the lender's account (origination fee,
via stream_loan::fund); the account receives nothing else from the protocol, and the team commits to
never funding it from a wallet outside the adapter's exclusion list. A USDG transfer from an
unrelated third party would be counted (there is no such inflow path today).
