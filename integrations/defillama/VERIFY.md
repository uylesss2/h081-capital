# VERIFY: commands run and their output (2026-11-02)

All runs on the Windows machine, read-only mainnet RPC, no transaction sent, no key used. Upstream
clones live outside the worktree in `C:/Users/Joseph/AppData/Local/Temp/claude/defillama-upstream/`.
`<SOLANA_RPC>` is the project's own read-only mainnet RPC URL (from the site's `src/data/protocol.json`);
the public `https://api.mainnet-beta.solana.com` endpoint answered the batched owner query with 429.

## 1. Upstream clones

```
git clone --depth 1 https://github.com/DefiLlama/DefiLlama-Adapters   -> HEAD ae138910c66bf78f3585fbbcb330e3de3a25b65c (Mon Nov 2 15:23:22 2026 +0100), branch main
git clone --depth 1 https://github.com/DefiLlama/dimension-adapters   -> HEAD 77dbdffab6476b131510cad8e31ed3e24411a2ac (Mon Nov 2 14:30:00 2026 +0000), branch master
DefiLlama-Adapters: npm i --ignore-scripts --no-audit --no-fund       -> added 266 packages in 53s (creates an untracked package-lock.json; not committed)
dimension-adapters: corepack pnpm i --ignore-scripts                   -> pnpm 12.16.1, exit 0, pnpm-lock.yaml unchanged
```

Helper signatures at these HEADs match the adapters: `projects/helper/solana.js` exports
`sumTokensExport({ owners, tokenAccounts, ... })` (owners path queries Token and Token-2022 via
getTokenAccountsByOwner and skips accounts under 1e6 base units; tokenAccounts path uses
getTokenAccountBalance); `helpers/token.ts` exports
`getSolanaReceived({ options, balances, target, targets, mints, blacklists, blacklist_signers, blacklist_mints, ... })`
querying Allium `solana.assets.transfers` with `to_address IN targets AND mint IN mints AND from_address NOT IN blacklists AND signer NOT IN blacklist_signers`.

## 2. Address derivation proof

```
$ node integrations/defillama/scripts/derive-addresses.mjs
RPC https://api.mainnet-beta.solana.com
vaultAuthority   9JnWo2rJ1MpB14NKNSEXCV2iMtMim6oUpHpgJFSVb2B7 OK
usdgVault        FaRG7DV8e7XF3RyoZrBb3h1oLiFFWFFCuYDSXsDoyyzG OK
capacityConfig   7QuqMc95ry9sjeem5gsS4SNQzoQfoHqVwSvAcSFq8uKS OK
capacityVault    EUMsBu6yj1DAXriTMSaGQCs6Ff4H6Rb7QTueGa7AN6Nh
safetyConfig     91QLL95oPgJF8yjWeKb41yMs5Z48UPd9mTXMH7xppoQA OK
safetyVault      4qM5m3UGiJnn9G3rVUC9b2uMxJmnxKcDXDetX7UDXT8g
loanRegistry     5MMWdQWZB3JWTCZXZsEGSLWegi9bk9iSitT9avdLo4Kt OK
treasuryUsdg     DxpmCZYAoDKpHmA5vWuopUrf3UVuGnPvditVrN9xDwDo OK

usdgVault        FaRG7DV8e7XF3RyoZrBb3h1oLiFFWFFCuYDSXsDoyyzG exists=true owner=9JnWo2rJ1MpB14NKNSEXCV2iMtMim6oUpHpgJFSVb2B7 mint=2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH amount=29 slot=464532875 OK
capacityVault    EUMsBu6yj1DAXriTMSaGQCs6Ff4H6Rb7QTueGa7AN6Nh exists=true owner=7QuqMc95ry9sjeem5gsS4SNQzoQfoHqVwSvAcSFq8uKS mint=EgqxxR7zowzaLEm24oep5qqBieLVAWYX78LhgeqAJAo amount=2000 slot=464532876 OK
safetyVault      4qM5m3UGiJnn9G3rVUC9b2uMxJmnxKcDXDetX7UDXT8g exists=true owner=91QLL95oPgJF8yjWeKb41yMs5Z48UPd9mTXMH7xppoQA mint=EgqxxR7zowzaLEm24oep5qqBieLVAWYX78LhgeqAJAo amount=1000 slot=464532878 OK
treasuryUsdg     DxpmCZYAoDKpHmA5vWuopUrf3UVuGnPvditVrN9xDwDo exists=true owner=EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq mint=2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH amount=0 slot=464532878 OK
vault_auth owns   FaRG7DV8e7XF3RyoZrBb3h1oLiFFWFFCuYDSXsDoyyzG mint=2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH amount=29 (Token-2022)

all checks passed
```

Seeds confirmed in the program sources: stipend_pool `VAULT_AUTH_SEED = "vault_auth"`,
`VAULT_SEED = "vault"` (`solana/programs/stipend_pool/src/lib.rs`, `src/solana/pda.ts`); capacity_stake
`CONFIG_SEED = "config"`, `VAULT_SEED = "vault"`; safety_pool `SAFETY_SEED = "safety"`,
`VAULT_SEED = "vault"`; stream_loan `REGISTRY_SEED = "registry"`.

## 3. TVL adapter: DefiLlama-Adapters test

First run on the public endpoint failed with the RPC's rate limit, not with the adapter:

```
$ node test.js projects/h081/index.js
Error pulling TVL for solana: [Error: [host: https://api.mainnet-beta.solana.com] [429] [{"jsonrpc":"2.0","error":{"code":429,"message":"Too many requests for a specific RPC call"} ...
Error: Protocol doesn't have total tvl, all the tvl functions above failed to run
```

Re-run with the project's RPC:

```
$ SOLANA_RPC=<SOLANA_RPC> node test.js projects/h081/index.js
Building prices get queries for 1 tokens
Building prices get queries for 1 tokens
[callStats] tvl/h081: 4 http requests (2 not matching a known rpc, 0 getLogs, 0 indexer requests, 0 logs fetched)
┌─────────┬────────────────────────┬───────┬─────────┬──────────────┬──────┐
│ (index) │ chain                  │ calls │ getLogs │ indexerCalls │ logs │
├─────────┼────────────────────────┼───────┼─────────┼──────────────┼──────┤
│ 0       │ 'solana'               │ 2     │ 0       │ 0            │ 0    │
│ 1       │ '_other'               │ 2     │ 0       │ 0            │ 0    │
│ 2       │ 'host: coins.llama.fi' │ 2     │ 0       │ 0            │ 0    │
└─────────┴────────────────────────┴───────┴─────────┴──────────────┴──────┘
--- solana-staking ---
Total: 0.00

--- solana ---
USDG                      29.00
Total: 29.00

--- staking ---
Total: 0.00

--- tvl ---
USDG                      29.00
Total: 29.00

------ TVL ------
solana                    29.00
solana-staking            0.00
staking                   0.00

total                    29.00
```

Raw balances each section returns before pricing (scratch script calling `module.solana.tvl` /
`.staking` with an `sdk.ChainApi`):

```
tvl {"solana:2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH":"29000000"}
staking {"solana:EgqxxR7zowzaLEm24oep5qqBieLVAWYX78LhgeqAJAo":"3000000000"}
```

= 29 USDG and 3,000 H081 (2,000 capacity_stake + 1,000 safety_pool). The staking bucket prices at
$0 because DefiLlama has no price for H081:

```
$ curl -s "https://coins.llama.fi/prices/current/solana:2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH,solana:EgqxxR7zowzaLEm24oep5qqBieLVAWYX78LhgeqAJAo"
{"coins":{"solana:2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH":{"decimals":6,"symbol":"USDG","price":1,"timestamp":1793630755,"confidence":0.999}}}
```

Lint and hygiene:

```
$ npx eslint -c eslint.config.js projects/h081/index.js
eslint clean
$ git status --short
?? package-lock.json        (created by npm i; not part of the PR)
?? projects/h081/
```

A historical date was not run: past timestamps route `sumTokens2` to Allium, which needs a key only
DefiLlama's bot has.

## 4. Fees adapter: dimension-adapters checks

```
$ corepack pnpm run ts-check
$ tsc --project tsconfig.json
(exit 0, no output)

$ corepack pnpm test fees h081 2026-11-02
$ ts-node --transpile-only cli/testAdapter.ts fees h081 2026-11-02
🦙 Running H081 adapter 🦙
---------------------------------------------------
Start Date:	Sun, 01 Nov 2026 00:00:00 GMT
End Date:	Mon, 02 Nov 2026 00:00:00 GMT
---------------------------------------------------

------ ERROR ------
Error: Allium API Key is required[Ignore this error for github bot]
    at _queryAllium (...\dimension-adapters\helpers\allium.ts:85:11)
    at ...\dimension-adapters\helpers\allium.ts:10:71
Allium API Key is required[Ignore this error for github bot]
[ELIFECYCLE] Test failed. See above for more details.

$ git status --short
?? fees/h081.ts
```

The module loaded, the chain config and `start` parsed, and the run reached the Allium query; the
key is only available to DefiLlama's CI bot, which executes the real query on the PR. No
`ALLIUM_API_KEY` was available here, so no daily number from Allium was produced locally.

## 5. Independent RPC cross-check of the fees number (no key)

```
$ node integrations/defillama/scripts/fees-rpc-check.mjs 2026-10-31 2026-11-02
RPC https://api.mainnet-beta.solana.com; window 2026-10-31 .. 2026-11-02 (UTC); account DxpmCZYAoDKpHmA5vWuopUrf3UVuGnPvditVrN9xDwDo (owner EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq, mint 2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH)
1 signature(s) touch the account in total
2026-10-31 3z8YCJP8TY4kGEKK7t4xFSbjeQ2hf9qhSuUa48zwyzrdHBRYMmT3U1HqeM8gb81EkaG6sfqbSbktyEkmW7XKLZWP delta=0.000000 USDG signers=5WCpirBe1wHUk6PL2nU97pj87PtyaqH9S6UJUbd5z2W1 (EXCLUDED: team signer)

2026-10-31  dailyFees = 0.000000 USDG
2026-11-01  dailyFees = 0.000000 USDG
2026-11-02  dailyFees = 0.000000 USDG

1 tx in window, 1 excluded (team signer), 0 failed/skipped
```

The only transaction is the creation of the treasury's USDG account by the deployer (delta 0,
excluded by the signer deny-list). Expected adapter result for every day so far: 0.

## 6. Worktree hygiene and tests

```
$ npm run typecheck
> tsc --noEmit -p tsconfig.json
(exit 0)                                    tsconfig include = ["src","test","scripts","relayer"]; integrations/ is outside it

$ npx vitest run --config integrations/defillama/vitest.config.ts
 ✓ integrations/defillama/scripts/derive-addresses.test.ts (4 tests) 3ms
 Test Files  1 passed (1)
      Tests  4 passed (4)

$ npm run test:relayer
 ✓ test/sdk/solana-alt.test.ts (11 tests)
 ✓ test/relayer/server.test.ts (4 tests)
 ✓ test/relayer/platform-fee.test.ts (14 tests)
 ✓ test/relayer/solana-payload.test.ts (10 tests)
 FAIL test/relayer/evm-check.test.ts  Error: ENOENT: no such file or directory, open '...\build\artifacts\contracts\StipendPool.sol\StipendPool.json'
 Test Files  1 failed | 4 passed (5)
      Tests  39 passed (39)
```

The one failing relayer file needs the hardhat build artifacts (`build/artifacts/...`), which a
fresh worktree does not have; it is unrelated to this track (nothing outside `integrations/defillama/`
changed: `git status --short` -> `?? integrations/`).
