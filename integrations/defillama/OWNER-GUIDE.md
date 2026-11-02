# Owner guide: fork, push and open the two DefiLlama PRs

Everything below is the owner's call: it creates public forks and PRs under the `uylesss2` GitHub
account. Nothing here sends a transaction or moves funds. Paths assume Git Bash on Windows and the
repo checked out at `C:/Users/Joseph/Documents/Websites/stipend-protocol` (adjust `SRC` if you use
the `feat/defillama` worktree).

```bash
SRC=C:/Users/Joseph/Documents/Websites/stipend-protocol/integrations/defillama
WORK=C:/Users/Joseph/Documents/Websites/defillama-prs
mkdir -p "$WORK"
```

## 0. Before you start

- Confirm the public text in `PR-TVL.md`, `PR-FEES.md` and both adapter files names only the H081
  project and token `EgqxxR7zowzaLEm24oep5qqBieLVAWYX78LhgeqAJAo` (it does today; re-check if you edit).
- Have a square high-resolution logo (PNG or SVG, 512x512 or larger) ready: both PR forms ask for it
  and the repo ships no such file yet (`public/og.png` on the site is a wide social card, not a logo).
- Commit as the GitHub noreply address: `git config user.name uylesss2`,
  `git config user.email 347924692+uylesss2@users.noreply.github.com` in each clone below.
- `gh auth status` must show the `uylesss2` account (`gh auth login` otherwise).

## 1. TVL adapter -> DefiLlama/DefiLlama-Adapters

```bash
cd "$WORK"
gh repo fork DefiLlama/DefiLlama-Adapters --clone=true --default-branch-only   # creates uylesss2/DefiLlama-Adapters
cd DefiLlama-Adapters
git config user.name uylesss2 && git config user.email 347924692+uylesss2@users.noreply.github.com
git checkout -b h081-tvl origin/main
mkdir -p projects/h081
cp "$SRC/tvl/projects/h081/index.js" projects/h081/index.js

# prove it runs (read-only mainnet RPC; the public endpoint rate-limits, so set SOLANA_RPC to any RPC you use)
npm i --ignore-scripts          # the repo uses pnpm; npm is fine for a local run. Do NOT commit package-lock.json
SOLANA_RPC=<your mainnet rpc url> node test.js projects/h081/index.js
#   expected: --- tvl ---  USDG 29.00 (whatever the vault holds), staking: 3,000 H081 (USD 0 until priced)
npx eslint -c eslint.config.js projects/h081/index.js

git status --short              # must show ONLY projects/h081/index.js (and an untracked package-lock.json you leave out)
git add projects/h081/index.js
git commit -m "feat: add H081 Capital (Solana)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin h081-tvl
```

Open the PR (title and body from `PR-TVL.md`; fill in the logo line first):

```bash
gh pr create --repo DefiLlama/DefiLlama-Adapters --base main --head uylesss2:h081-tvl \
  --title "feat: add H081 Capital (Solana)" --body-file "$SRC/PR-TVL.body.md"
```

(`PR-TVL.body.md` = the fenced markdown block of `PR-TVL.md` saved to a file, with the logo attached
or linked. Or open it in the browser: `gh pr create --web` and paste.) **Tick "Allow edits by
maintainers"** (the default for forks; verify in the PR sidebar).

## 2. Fees adapter -> DefiLlama/dimension-adapters

```bash
cd "$WORK"
gh repo fork DefiLlama/dimension-adapters --clone=true --default-branch-only   # creates uylesss2/dimension-adapters
cd dimension-adapters
git config user.name uylesss2 && git config user.email 347924692+uylesss2@users.noreply.github.com
git checkout -b h081-fees origin/master
cp "$SRC/fees/fees/h081.ts" fees/h081.ts

corepack pnpm i --ignore-scripts        # pnpm via corepack (node 24 ships it)
corepack pnpm run ts-check              # must be clean
corepack pnpm test fees h081 2026-11-02
#   without ALLIUM_API_KEY this ends with "Allium API Key is required[Ignore this error for github bot]":
#   the module loaded and parsed; DefiLlama's CI bot (which has the key) runs the real query on the PR.
#   With a free Allium developer key in .env (ALLIUM_API_KEY=...) it prints the daily numbers (0 today).

git status --short              # must show ONLY fees/h081.ts
git add fees/h081.ts
git commit -m "feat: add H081 Capital fees and revenue (Solana)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin h081-fees
gh pr create --repo DefiLlama/dimension-adapters --base master --head uylesss2:h081-fees \
  --title "feat: add H081 Capital fees and revenue (Solana)" --body-file "$SRC/PR-FEES.body.md"
```

Paste the TVL PR's URL into the "Current TVL" line of the fees PR body. Tick "Allow edits by
maintainers".

## 3. After opening

- Watch the CI bot comment on each PR: the TVL bot posts the adapter's output; the dimension bot runs
  the Allium query. Zero fees is expected today and is explained in the PR body.
- Reviewers may ask:
  - *Why is H081 under staking and not tvl?* It is the protocol's own token (DefiLlama's own-token
    rule). If they prefer it elsewhere, let them edit (edits by maintainers are allowed).
  - *Why does the fees adapter return 0?* No relayed withdrawal or funded loan has paid a fee yet;
    the treasury USDG account received nothing. Offer the RPC cross-check
    (`scripts/fees-rpc-check.mjs`) if they want to see it.
  - *Treasury inflows that are not fees?* The treasury's USDG account is fee-only: the protocol sends
    nothing else to it, and every team wallet (deployer, config authority, fee / launch wallets, the
    Squads multisig, its create key and members, the relayer hot wallet) is excluded as a sender.
    A third-party donation would count; the protocol has no such inflow path. Say so if asked.
  - *Audit?* "Not audited yet; live on Solana mainnet; use at your own risk." Never say an audit is
    not planned.
- Listings usually appear within about 24 hours of the merge. Later metadata changes (logo, links,
  description) go by mail to metadata@defillama.com, not by PR.
- Optional: ask DefiLlama to price H081 (CoinGecko listing, or their DEX pricing from the H081 pool
  `CryBbh9QQttrUrfLVXLLEuhkM5wZ8W1DUZFYNhUEhYqs`) so the staking bucket shows a USD value.

## 4. Keeping the adapters current

- **Never fund the treasury's USDG account `DxpmCZYAoDKpHmA5vWuopUrf3UVuGnPvditVrN9xDwDo` from a
  wallet that is not in the adapter's exclusion list** (`INTERNAL` / `RELAYER_HOT_WALLET` in
  `fees/h081.ts`: deployer, config authority, fee / launch wallets, the Squads multisig, its create
  key and members, the relayer hot wallet). Any USDG that reaches it from another address is
  published as protocol fees and revenue. If a new team wallet may ever send USDG there (an exchange
  withdrawal, a new multisig member, a new hot wallet), add it to the list and get the
  dimension-adapters PR merged **before** the transfer. Keep `DENY_SIGNERS` / `DENY_FROM` in
  `scripts/fees-rpc-check.mjs` equal to the adapter's lists.
- A new deposit asset in the bank needs a one-line PR to DefiLlama-Adapters: add the mint to
  `DEPOSIT_MINTS` in `projects/h081/index.js` (the TVL adapter counts only listed mints, so a token
  account a stranger creates for the vault authority is never TVL).
- A new loan asset or relay-fee mint needs a PR to dimension-adapters: stream_loan charges the 0.25%
  origination fee in the loan's own asset (to the treasury's token account for that mint) and the
  relayer charges in the asset it relays, so add the mint to `mints` in `fees/h081.ts` or its fees
  are silently dropped while TVL counts the asset.
- If the treasury moves, both the fees adapter and the PR metadata must change (new PR + mail).
