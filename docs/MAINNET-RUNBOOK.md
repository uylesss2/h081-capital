# Mainnet runbook: core-only release (stipend_pool)

The first mainnet release deploys **one program, `stipend_pool`** (the private bank). `stream_loan`,
`capacity_stake` and `safety_pool` are **not** deployed; the site shows loans as "coming soon". Their mainnet
preparation (builds, exact cost, checked inits, rehearsal, commands) is in "Phase 2" at the end of this file.

Nothing in this file has been run against mainnet. Every step that sends a transaction needs the owner's
explicit go, and the SOL figure in step 2 must be stated to the owner and approved **before** it is sent.

## 0. Fixed values

| What | Value |
|---|---|
| Program id (stipend_pool) | `E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM` |
| Deployer = upgrade authority = initialize signer | `5WCpirBe1wHUk6PL2nU97pj87PtyaqH9S6UJUbd5z2W1` |
| Config authority (caps, deposit pause) | `4eySgHKMNGMpWtbtpfxfSyJZK8LGYxEZLzJwHXCsoPX2` |
| Keys (gitignored, back up offline) | `solana/keys/mainnet/{deployer,config_authority,stipend_pool}-keypair.json` |
| Fee wallet (funds the deploy, receives the sweep) | `2wjxKzH7fVGpjcA9KpjDBDHjSAhz7u8ZgMLnVPVGSkDP`, key `stipend-site/scripts/launch/.keys/mainnet-2-wallet.json` |
| USDG mint (Token-2022, 6 decimals) | `2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH` |
| Caps | 1,000 USDG per deposit (`1000000000`), 10,000 USDG total (`10000000000`) |
| Program source | `feat/mainnet` @ `540faa7` (program code unchanged since; later commits are scripts/SDK/docs) |
| Snapshot built | `../h081-deploy-staging/snap-540faa7.tar` (`snapshot-commit.txt` there is stale: it says 5660055) |
| `.so` | `../h081-deploy-staging/so-mainnet/stipend_pool.so`, 350,568 bytes |
| `.so` sha256 | `4e1fbbc3d1c7d094824ce323f34bbc671f68334b15a2467da4533e11052c1a51` |
| Mainnet genesis | `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` |
| SOL cap (owner) | **3.6 SOL** peak in the deployer for the core-only release |

The `.so` was built by `../h081-deploy-staging/build-mainnet.sh` (WSL; size profile opt-level "z", strip,
feature `no-log-ix-name`, program id patched from the localnet `AzES8…` to `E16DK…`). It passed the private
local-validator rehearsal 46/46 (`scripts/mainnet-rehearsal-localnet.mts`, mainnet feature set cloned, a byte
copy of the real USDG mint): initialize gated on the upgrade authority, caps, pause, deposit, grant, agent
payment, refused payments, disclosure, withdraw, the issuer's permanent-delegate and freeze powers. Largest
compute use: grant, 623,581 of 1,400,000 CU.

To rebuild it (only if the program source changes; then every figure below must be recomputed):

```bash
# Windows, Git Bash, from stipend-protocol (working tree clean)
git archive -o ../h081-deploy-staging/snap-$(git rev-parse --short HEAD).tar HEAD
# WSL Ubuntu: ABSOLUTE paths (the script cd's before the final copy)
bash /mnt/c/Users/Joseph/documents/websites/h081-deploy-staging/build-mainnet.sh \
  /mnt/c/Users/Joseph/documents/websites/h081-deploy-staging/snap-<sha>.tar \
  /mnt/c/Users/Joseph/documents/websites/stipend-protocol/solana/keys/mainnet/stipend_pool-keypair.json \
  /mnt/c/Users/Joseph/documents/websites/h081-deploy-staging/so-mainnet        # prints size, sha256, BUILD_OK
```

### Shells used below

**Git Bash** (Windows), from `C:/Users/Joseph/documents/websites/stipend-protocol`:

```bash
export RPC=https://api.mainnet-beta.solana.com   # or a private mainnet RPC (recommended: the deploy sends ~372 txs)
export MAINNET_RPC=$RPC
```

**WSL Ubuntu** (the Solana CLI, `solana-cli 4.3.2` at the time of writing):

```bash
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
P=/mnt/c/Users/Joseph/documents/websites/stipend-protocol
K=$P/solana/keys/mainnet
FEEKEY=/mnt/c/Users/Joseph/documents/websites/stipend-site/scripts/launch/.keys/mainnet-2-wallet.json
URL=https://api.mainnet-beta.solana.com          # same RPC as $RPC above
PRICE=100000                                     # micro-lamports per CU (deploy-cluster.mjs's mainnet price)
```

Never print or paste a secret key. `solana program deploy` prints a buffer-recovery seed phrase when an
upload fails; `deploy-cluster.mjs` filters it out, do not copy it anywhere.

## 1. Preflight (read-only)

```bash
npm run typecheck
npx tsx scripts/mainnet-core-check.mts preflight
```

`mainnet-core-check.mts preflight` sends nothing. It checks, and exits 1 on any failure:

- the RPC's genesis hash is mainnet-beta;
- the `.so` sha256 is `4e1fbbc3…2c1a51`, it carries `E16DK…` and not the localnet `AzES8…`;
- the three mainnet keypairs exist and their public keys are the ones in section 0;
- the program id and pool are not on chain yet (a re-run after the deploy says "EXISTS");
- the deployer and fee wallet balances;
- the USDG gate (same as step 4);
- the **exact funding figure** from live rent: program data (`.so`+45 B) + program account (36 B) + upload
  buffer (`.so`+37 B, refunded at the end of the deploy) + deploy fees at the worst case (372 txs × 25,000
  lamports: 5,000 base + 100,000 µlamports × 200,000 CU), plus one failed upload attempt (fees only; the
  buffer is closed and refunded), rounded up to 0.001 SOL, and that it is ≤ 3.6.

Output on 2026-10-31 (read-only run):

```
rent: programdata 1.7818, program 0.0008, buffer 1.7817 (refunded), pool+config+cap+vault(183 B) 0.1739
deploy fees worst case 0.0093 (372 tx x 25000 lamports); peak 3.5736; +1 retry 3.5829
after deploy (buffer refunded): 1.7911 SOL left for init 0.1739 + smoke test
OK    FUND EXACTLY 3.583 SOL to the deployer (cap 3.6)
deployer 5WCpirBe… balance 0.0000 SOL; fee wallet 2wjxKz… balance 4.7278 SOL
```

Margins: peak with no retry 3.5736 (0.0264 under the cap), with one retry 3.5829. A second failed upload
would need 3.5922; if two attempts fail, stop and find out why before spending more.

Also confirm the program's public hash tooling agrees with the file (offline):

```bash
npx tsx scripts/solana-program-hash.mts --so ../h081-deploy-staging/so-mainnet/stipend_pool.so
```

## 2. Fund the deployer (MAINNET TX — owner approves the exact figure first)

State to the owner: **"send exactly 3.583 SOL from the fee wallet 2wjxKz… to the deployer 5WCpirBe…"**
(or the figure the preflight prints on the day, if rent changed; never above 3.6 without a new OK). Then, in WSL:

```bash
solana transfer --from "$FEEKEY" --fee-payer "$FEEKEY" \
  5WCpirBe1wHUk6PL2nU97pj87PtyaqH9S6UJUbd5z2W1 3.583 \
  --allow-unfunded-recipient --with-compute-unit-price $PRICE --url $URL
solana balance 5WCpirBe1wHUk6PL2nU97pj87PtyaqH9S6UJUbd5z2W1 --url $URL      # expect 3.583 SOL
```

## 3. Deploy stipend_pool (MAINNET TXS)

`deploy-cluster.mjs` (in `../h081-deploy-staging/`) checks the genesis hash, deploys only the programs in
`--programs`, and does **not** initialize stipend_pool (it prints the `mainnet-init.mts` command instead).

**Always pass `--maxlen-factor 1`.** The script's default ×1.25 `--max-len` makes the program-data account
438,255 B (2.2270 SOL rent) and the peak 4.0095 SOL: over the cap. Factor 1 leaves no room for a larger
upgrade later (see "Upgrades").

Its own cost printout uses a flat 0.05 SOL for fees, NEED adds the buffer and the inits although they never
coexist, and its vault estimate falls back to 300 B (spl-token 0.4.13 cannot parse USDG's extension 16). With
`--maxlen-factor 1` it prints about **NEED 3.79 / peak 3.61**: higher than the 3.583 funded. That is expected;
the preflight figure is the exact one. With a balance below NEED the script only prints a WARNING and goes on.

Dry run first (no transaction; mainnet needs the flag even for a dry run and waits 15 s):

```bash
node ../h081-deploy-staging/deploy-cluster.mjs --cluster mainnet --programs stipend_pool \
  --keys-dir C:/Users/Joseph/documents/websites/stipend-protocol/solana/keys/mainnet \
  --so-dir C:/Users/Joseph/documents/websites/h081-deploy-staging/so-mainnet \
  --asset-mint 2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH \
  --maxlen-factor 1 --rpc $RPC --i-understand-mainnet --dry-run
```

Check: `stipend_pool 350568 B`, `maxlen x1`, deployer balance 3.583, and the line ends with
`dry run: stopping before any transaction`. Then the real run (same command without `--dry-run`; Ctrl-C
within 15 s aborts):

```bash
node ../h081-deploy-staging/deploy-cluster.mjs --cluster mainnet --programs stipend_pool \
  --keys-dir C:/Users/Joseph/documents/websites/stipend-protocol/solana/keys/mainnet \
  --so-dir C:/Users/Joseph/documents/websites/h081-deploy-staging/so-mainnet \
  --asset-mint 2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH \
  --maxlen-factor 1 --rpc $RPC --i-understand-mainnet
```

It runs `solana program deploy … --max-len 350568 --upgrade-authority deployer --use-rpc
--with-compute-unit-price 100000`, up to 3 attempts, and closes leftover buffers after a failed attempt.
Record: `../h081-deploy-staging/deployments/solana-mainnet.json` (deploy signature, `.so` sha256). Leave
`--out` at that default: `sync-protocol.mjs` would read a record in `stipend-protocol/deployments/` and take
its `rpc` (api.mainnet-beta refuses browser origins). If it stops midway, re-run the same command: an
executable program is skipped. If an upload failed and the CLI left a buffer, recover it (WSL):

```bash
solana program show --buffers --keypair $K/deployer-keypair.json --url $URL
solana program close --buffers --keypair $K/deployer-keypair.json --url $URL --bypass-warning
```

Check what is on chain equals the file:

```bash
npx tsx scripts/solana-program-hash.mts --program E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM \
  --cluster mainnet-beta --so ../h081-deploy-staging/so-mainnet/stipend_pool.so   # exit 0 = match
```

## 4. USDG gate, right before create_vault (read-only)

```bash
npx tsx scripts/mainnet-core-check.mts usdg
```

Must pass: Token-2022, 6 decimals, **no Pausable**, **no DefaultAccountState**, **TransferHook program unset**,
transfer fee 0 bps (older and newer), no unreviewed extension type. If any fails, **do not run step 5**:
the pool would be initialized but no vault created; stop and review (the vault can be created later).
It prints the issuer's powers (freeze, mint, permanent delegate, close authority: `2apBGMs…`, mint `2e99Q…`),
which the site's RiskNotice discloses. Run step 5 immediately after this check.

## 5. Initialize + grow_pool + create_vault (MAINNET TXS, immediately after the deploy)

`initialize` only succeeds when signed by the program's upgrade authority (the deployer), so nobody can take
the Config first; still run it right after the deploy.

```bash
DEPLOYER_KEY=solana/keys/mainnet/deployer-keypair.json KEYS_DIR=solana/keys/mainnet \
POOL_SO=../h081-deploy-staging/so-mainnet/stipend_pool.so \
CONFIG_AUTHORITY=4eySgHKMNGMpWtbtpfxfSyJZK8LGYxEZLzJwHXCsoPX2 \
MAX_TOTAL_DEPOSITS=10000000000 MAX_PER_DEPOSIT=1000000000 \
npx tsx scripts/mainnet-init.mts
```

What it does, refusing before any signature if a check fails:

1. genesis = mainnet-beta; program id from `KEYS_DIR` (never the localnet id); program upgradeable;
   upgrade authority = `DEPLOYER_KEY`; deployed executable hash = `POOL_SO` (reads at `finalized`: if it says
   "not deployed" right after step 3, wait ~30 s and re-run);
2. one transaction: `initialize` (config authority `4eyS…`, caps 10,000 / 1,000 USDG) + 3× `grow_pool`
   (Pool 33,424 B); reads Config back and checks `config.authority`;
3. `create_vault(USDG)` (183-byte Token-2022 vault; AssetCap inherits the default caps);
4. a free smoke test: a real disclose proof is accepted and a tampered one rejected by the live program
   through `simulateTransaction` (no state change); the proof buffers are closed (rent back).

Re-running is safe: finished steps print "already done". Cost ≈ 0.1739 SOL rent + fees.

## 6. Verify on chain (read-only)

```bash
npx tsx scripts/mainnet-core-check.mts verify
npx tsx scripts/mainnet-admin.mts show
```

Must pass: upgradeable, upgrade authority = deployer, executable = the `.so`, pool 33,424 B,
`config.authority = 4eySgHKM…`, default caps 10,000 / 1,000 USDG, USDG AssetCap 10,000 / 1,000, vault exists
and is not frozen, `depositsPaused: false`.

## 7. Tiny real deposit + withdraw (MAINNET TXS)

The owner sends **1 USDG** to the deployer `5WCpirBe…` (any wallet; this creates the deployer's USDG account,
~0.0021 SOL rent paid by the sender). Then:

```bash
SMOKE_KEY=solana/keys/mainnet/deployer-keypair.json SMOKE_AMOUNT=1000000 \
npx tsx scripts/mainnet-smoke.mts --i-understand-mainnet
```

`mainnet-smoke.mts` writes the shielded account secret to `solana/keys/mainnet/smoke-account.json`
(gitignored) **before** the deposit, deposits 1 USDG (checks caps/pause first), withdraws it back to the same
wallet and checks the balances (`SMOKE OK`). If it stops after the deposit, re-run the same command: it finds
the note on chain and withdraws it. Signatures go to stdout and `solana/target-so/mainnet-smoke.json`; they
appear on `/proof` automatically. Delete `smoke-account.json` after `SMOKE OK`. Tested on a local validator
(fresh run, and resume after a deposit-only run); not run on mainnet.

Optional, return the USDG and close the account (WSL; `<OWNER>` = the wallet that sent it):

```bash
spl-token transfer --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb 2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH \
  ALL <OWNER> --owner $K/deployer-keypair.json --fee-payer $K/deployer-keypair.json --url $URL
spl-token close --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb 2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH \
  --owner $K/deployer-keypair.json --fee-payer $K/deployer-keypair.json \
  --recipient 2wjxKzH7fVGpjcA9KpjDBDHjSAhz7u8ZgMLnVPVGSkDP --url $URL
```

## 8. Fund the config authority, sweep the rest back (MAINNET TXS)

The config authority needs a little SOL to sign an emergency pause. From the deployer (WSL):

```bash
solana transfer --from $K/deployer-keypair.json --fee-payer $K/deployer-keypair.json \
  4eySgHKMNGMpWtbtpfxfSyJZK8LGYxEZLzJwHXCsoPX2 0.002 --allow-unfunded-recipient --url $URL
solana transfer --from $K/deployer-keypair.json --fee-payer $K/deployer-keypair.json \
  2wjxKzH7fVGpjcA9KpjDBDHjSAhz7u8ZgMLnVPVGSkDP ALL --url $URL
solana balance 5WCpirBe1wHUk6PL2nU97pj87PtyaqH9S6UJUbd5z2W1 --url $URL      # 0
```

Expected: ~1.6 SOL back to the fee wallet; locked for good ≈ 1.9565 SOL (program data 1.7818 + program
0.0008 + pool 0.1704 + config 0.0009 + AssetCap 0.0009 + vault 0.0016). The deployer stays the upgrade
authority with 0 SOL; it needs SOL again only to upgrade or close the program.

## 9. Site (stipend-site; owner decides on commits and the deploy)

```bash
cd C:/Users/Joseph/documents/websites/stipend-site
node scripts/sync-protocol.mjs mainnet-beta --pool E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM \
  --mint 2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH --rpc https://solana-rpc.publicnode.com --live
npm run build
npm run deploy            # Vercel production; the owner may have to run it
```

`sync-protocol.mjs` refuses `--live` unless the pool is an executable program and the mint exists on that RPC.
Pass `--pool` explicitly: the deploy record stores `programs.stipend_pool` as an object, not an id. After the
deploy, open h081.xyz `/app` (Live tab, risk notice before the first deposit) and `/proof` (the smoke-test
signatures).

## Emergency and rollback

**Pause deposits** (withdrawals and agent payments keep working; nothing can pause them):

```bash
npx tsx scripts/mainnet-admin.mts pause --i-understand-mainnet     # signed by config_authority-keypair.json
npx tsx scripts/mainnet-admin.mts unpause --i-understand-mainnet
npx tsx scripts/mainnet-admin.mts caps <maxTotal> <maxPerDeposit> --i-understand-mainnet   # USDG base units
```

Tested on a local validator (pause, unpause, caps). The site can also be switched off: re-run step 9 without
`--live` (Live mode returns to "opening soon"), build, deploy.

**USDG issuer action** (freeze of the vault, permanent-delegate transfer, transfer fee or hook switched on):
pause deposits, take the site's Live mode down, tell users. The program cannot prevent these (disclosed in the
RiskNotice); caps keep the exposure at most 10,000 USDG.

**Upgrade key.** The deployer is a single hot key that can replace the program code, including code that
moves the vault. Keep `solana/keys/mainnet/` backed up offline and off shared machines. Later, move the
authority to a multisig (e.g. a Squads vault) or make the program immutable; both are owner decisions:

```bash
solana program set-upgrade-authority E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM \
  --upgrade-authority $K/deployer-keypair.json --new-upgrade-authority <MULTISIG_VAULT> \
  --skip-new-upgrade-authority-signer-check --keypair $K/deployer-keypair.json --url $URL
# irreversible: no upgrade ever again, and initialize can never be run again (it needs the authority)
solana program set-upgrade-authority E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM --final \
  --upgrade-authority $K/deployer-keypair.json --keypair $K/deployer-keypair.json --url $URL
```

If the deployer key may have leaked: there is no on-chain defence besides moving the authority first (command
above, to a fresh key or multisig). Pause deposits and take Live mode down at once.

**Upgrades** (a fix to stipend_pool). Rebuild from a clean snapshot (section 0), rerun the rehearsal against the
new `.so`, then fund the deployer with the new buffer rent (≈ `.so`+37 B, refunded) + fees. Program data is
exactly 350,568 B; a larger `.so` first needs `solana program extend E16DK… <extra bytes>` (extra rent, locked).

```bash
solana program extend E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM <EXTRA_BYTES> --keypair $K/deployer-keypair.json --url $URL
solana program deploy <new stipend_pool.so> --program-id E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM \
  --upgrade-authority $K/deployer-keypair.json --keypair $K/deployer-keypair.json \
  --use-rpc --with-compute-unit-price $PRICE --max-sign-attempts 30 --url $URL
```

**Closing the program to recover rent** (last resort). It returns the program-data rent (~1.78 SOL) but the
program id can **never** be used again, and every account it owns stays locked forever: the pool, the config
and **the vault with any USDG still in it**. Only close after the vault is empty (all users withdrew; check
with `mainnet-core-check.mts verify`, vault balance 0):

```bash
solana program close E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM \
  --authority $K/deployer-keypair.json --keypair $K/deployer-keypair.json \
  --recipient 2wjxKzH7fVGpjcA9KpjDBDHjSAhz7u8ZgMLnVPVGSkDP --url $URL --bypass-warning
```

## Checklist

- [ ] 1 preflight passes; funding figure stated: ______ SOL (≤ 3.6), owner OK given
- [ ] 2 deployer funded (balance = figure)
- [ ] 3 deploy (`--programs stipend_pool --maxlen-factor 1`); `solana-program-hash` matches
- [ ] 4 USDG gate passes (no Pausable / DefaultAccountState / hook program / fee)
- [ ] 5 `mainnet-init.mts`: config.authority verified, vault created, proof smoke accepted / tampered rejected
- [ ] 6 `mainnet-core-check.mts verify` passes
- [ ] 7 `mainnet-smoke.mts`: SMOKE OK; `smoke-account.json` deleted
- [ ] 8 config authority 0.002 SOL; deployer swept to the fee wallet
- [ ] 9 site synced (`--live`), built, deployed; `/app` and `/proof` checked
- [ ] HANDOFF.md updated with the signatures and the final balances

---

# Phase 2: stream_loan, safety_pool, capacity_stake (deployed and initialized on mainnet 2026-10-31)

Nothing below has been sent to mainnet. Every MAINNET TX step needs the owner's explicit go on the exact SOL
figure first (owner cap for all four programs: **7.5 SOL peak in the deployer**).

## P0. Fixed values

| What | Value |
|---|---|
| Program source | `feat/mainnet` @ `44b17f5`, snapshot `../h081-deploy-staging/snap-44b17f5.tar` (stipend_pool source unchanged since `540faa7`, so these programs talk to the deployed `E16DK…` binary) |
| stream_loan | `8JBd7epQXxdcKRMaWM1S5PC7nsQKoZq3uCetpiJ684g4`, `stream_loan.so` 242,384 B, sha256 `d8cfbca52d22b231e0c9e376a613847157676c275bb9852ee02a2f7d7205d3c0` |
| safety_pool | `HmzKNPn8LaRyjmggt2uT95B7KvphtoVXQkeVc2HHARTt`, `safety_pool.so` 300,312 B, sha256 `6415fd13484703f1e31950abfcd17c1edf6edf8a5c9ff95646ca2df0ae10bce7` |
| capacity_stake | `CH1rrfFyJMVn158UHL2fLpKTtoLJojrz5f68toMQdQKU`, `capacity_stake.so` 219,344 B, sha256 `bbe8b1a2450dc6275b0229954d6b2f1fdb706cb27ab643697aa5f6b22a1082f2` |
| Upgrade authority = init signer | deployer `5WCpirBe1wHUk6PL2nU97pj87PtyaqH9S6UJUbd5z2W1` (hot key, as for stipend_pool: `--allow-hot-upgrade-authority`) |
| Config authority (caps, pause, underwriter) | `4eySgHKMNGMpWtbtpfxfSyJZK8LGYxEZLzJwHXCsoPX2` |
| stipend_pool compiled in | `E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM` (stream_loan, safety_pool; feature `mainnet`) |
| stream_loan id compiled into safety_pool | `8JBd7…` |
| Loan fee treasury (`fee::TREASURY`) | `EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq` = Squads v4 vault 0 of multisig `G3xFLKe6An28bgdtUuyaoZCpjtPpQTh3GgKNKtWG26A6`, create key `solana/keys/mainnet/treasury_squads_create_key-keypair.json` (`4ir9vPVqWZ28ja6eTZs75LqBduhL1R8AQ9irxBu16kAd`). docs/FLYWHEEL.md requires the treasury to be the Squads vault, so it is not the config authority. Created 2026-10-31 (sig `5uGn7LibmZAFXCr37cqWaivbRAVrWSeCTV8NAhgnbng89wShxcPzuQR5MejvPFAhv62DfiBsdF7qjba3PhyaoMJR`): threshold 2 of 3, no config authority (member changes need a 2-of-3 config proposal), time lock 0. INTERIM members, generated on the team machine at the owner's request (`solana/keys/mainnet/treasury_member_{1,2,3}-keypair.json`): `3QxDPawgSmdPsvNa1xfsHuuF7cXWBaoBhPHgQgoBpnfi`, `3TGGDFAtipTMSpkmSEfm1CTcREQYdTkzWhzdVCzLLa7N`, `7815bY95r1E5FifAZMf5rM5Vjrper67BBY1wS8m216i1`. All three sit on one machine, so this is not yet real 2-of-3 protection: replace them with separately held keys (config proposal: add new members, remove these) before the treasury holds meaningful funds. The vault address does not change. Another treasury = rebuild stream_loan with another `TREASURY=` (same size) before the deploy, or an upgrade after |
| H081 mint (staking asset) | `EgqxxR7zowzaLEm24oep5qqBieLVAWYX78LhgeqAJAo` (SPL Token, 6 decimals) |
| Loan asset | USDG `2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH` (stream_loan accepts any asset; loans are pledged allowances inside the bank, bounded by its 1,000 / 10,000 USDG caps) |
| H081 caps (both programs) | 100,000 H081 per deposit / stake, 1,000,000 H081 total (0.1% of supply); safety_pool insures nothing until the config authority calls `set_underwriting` |
| Keys (gitignored, back up offline) | `solana/keys/mainnet/{stream_loan,safety_pool,capacity_stake,treasury_squads_create_key}-keypair.json` (new) |

Rebuild (only if the source changes; then every figure below must be recomputed):

```bash
git archive -o ../h081-deploy-staging/snap-$(git rev-parse --short HEAD).tar HEAD
# WSL, absolute paths
W=/mnt/c/Users/Joseph/documents/websites
TREASURY=EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq bash $W/stipend-protocol/solana/scripts/build-phase2-mainnet.sh \
  $W/h081-deploy-staging/snap-44b17f5.tar $W/stipend-protocol/solana/keys/mainnet $W/h081-deploy-staging/so-mainnet
# per program: own id, E16DK, stream_loan id (safety_pool), treasury (stream_loan), no localnet id, size, sha256; BUILD_OK
```

It never writes `so-mainnet/stipend_pool.so`. Log of the 2026-10-31 build: `../h081-deploy-staging/build-phase2-mainnet.log`.

## P1. Rehearsal (private local validator, nothing public)

```bash
npx tsx scripts/mainnet-rehearsal-phase2-localnet.mts      # 99/99 on 2026-10-31
```

The four exact `.so` files (stipend_pool's included) as upgradeable programs, mainnet feature set, byte copies of
USDG (Token-2022 extensions) and H081. It runs the real `mainnet-init.mts STEPS=loan` and `mainnet-init-h081.mts`
(and their refusals: wrong signer, wrong `.so`, wrong treasury), unauthorized inits (refused 6020 / 6007 / 6020);
loans: fund (0.25% fee into the treasury ATA), routed repayment, sync, lender claim, default (shortfall = full
principal); safety_pool: deposit, per-deposit and total caps, top_up (refused from a launch wallet), pause blocks
deposits but not unbond/withdraw, underwriting, insure, settle + release_cover, slash of the defaulted loan;
capacity_stake: stake, capacity view, caps, pause blocks stake but not request_unstake/unstake. Withdraw/unstake
after the 14/30-day cooldown and the slashed loan's Cover come from genesis fixtures (the local clock cannot be
moved); the instructions run are the real mainnet programs. Output `solana/target-so/mainnet-rehearsal-phase2.json`.

Compute units (limit): grant 630,165 (1.4M); stream_loan claim 257,717 (1.4M); spend with lender share 240,066;
fund 228,280; slash 42,409 (200k); insure 34,691; init_config 34,563; safety deposit 34,587; capacity stake 32,017;
sync 29,144; init_pool 26,801; safety withdraw 23,844; unstake 21,157; release_cover 18,370; top_up 17,799;
request_unstake 13,096; request_unbond 11,565; settle 7,711; admin setters 6,767-7,641. All with >= 25% headroom.

## P2. Cost (read-only RPC, mainnet rent 2026-10-31: 5,080 lamports per byte incl. the 128-byte overhead)

| | lamports |
|---|---|
| program data (`.so`+45 B): stream_loan / safety_pool / capacity_stake | 1,232,189,560 / 1,526,463,800 / 1,115,146,360 |
| program accounts (36 B) x3 | 2,499,360 |
| **locked program rent** | **3,876,299,080** |
| inits: registry 17 B 736,600; treasury USDG ATA 187 B 1,600,200; capacity config 188 B 1,605,280 + vault 165 B 1,488,440; safety config 246 B 1,899,920 + vault 165 B 1,488,440 | 8,818,880 |
| upload buffer (`.so`+37 B, refunded after each deploy): largest safety_pool / first in order capacity_stake | 1,526,423,160 / 1,115,105,720 |
| fees (flat 0.05 SOL per program, generous) | 150,000,000 |

- **Locked for good: 3.8851 SOL** (3.8763 programs + 0.0088 inits).
- **Peak in the deployer: 5.5615 SOL** counting the largest buffer (conservative); 5.1503 SOL in the order
  `deploy-cluster.mjs` uses (smallest first: capacity_stake, stream_loan, safety_pool).
- The deployer holds 1.6075 SOL (2026-10-31): a top-up of **3.954 SOL** brings it to the conservative peak.
- With stipend_pool's 1.9565 SOL already locked, all four programs lock about 5.84 SOL; the 7.5 SOL cap holds.

`deploy-cluster.mjs --dry-run` (P4) prints the same figures from live rent; it is read-only.

## P3. Fund the deployer (MAINNET TX, owner approves the exact figure)

```bash
solana balance 5WCpirBe1wHUk6PL2nU97pj87PtyaqH9S6UJUbd5z2W1 --url $URL
solana transfer --from "$FEEKEY" --fee-payer "$FEEKEY" 5WCpirBe1wHUk6PL2nU97pj87PtyaqH9S6UJUbd5z2W1 <TOPUP> \
  --allow-unfunded-recipient --with-compute-unit-price $PRICE --url $URL     # TOPUP = 5.5615 - balance
```

## P4. Deploy (MAINNET TXS)

Dry run first. It refuses on any `.so` gate (sha256, own id, E16DK, stream_loan id, treasury, localnet ids):

```bash
node ../h081-deploy-staging/deploy-cluster.mjs --cluster mainnet --programs stream_loan,safety_pool,capacity_stake \
  --keys-dir C:/Users/Joseph/documents/websites/stipend-protocol/solana/keys/mainnet \
  --so-dir C:/Users/Joseph/documents/websites/h081-deploy-staging/so-mainnet \
  --asset-mint 2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH --h081-mint EgqxxR7zowzaLEm24oep5qqBieLVAWYX78LhgeqAJAo \
  --loan-treasury EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq \
  --expect-sha256 stream_loan=d8cfbca52d22b231e0c9e376a613847157676c275bb9852ee02a2f7d7205d3c0 \
  --expect-sha256 safety_pool=6415fd13484703f1e31950abfcd17c1edf6edf8a5c9ff95646ca2df0ae10bce7 \
  --expect-sha256 capacity_stake=bbe8b1a2450dc6275b0229954d6b2f1fdb706cb27ab643697aa5f6b22a1082f2 \
  --maxlen-factor 1 --allow-hot-upgrade-authority --rpc $RPC --i-understand-mainnet --dry-run
```

Expect `[gate] .so checks passed`, `peak with the largest buffer 5.5615 SOL, with this order 5.1502 SOL`,
`dry run: stopping before any transaction` (checked read-only on 2026-10-31). Then the same command without
`--dry-run`. On mainnet the script only deploys (smallest first) and prints the two checked init commands of P5.
If it stops midway, re-run it (deployed programs are skipped); stray buffers:
`solana program close --buffers --keypair $K/deployer-keypair.json --url $URL --bypass-warning`. Then:

```bash
for p in stream_loan:8JBd7epQXxdcKRMaWM1S5PC7nsQKoZq3uCetpiJ684g4 safety_pool:HmzKNPn8LaRyjmggt2uT95B7KvphtoVXQkeVc2HHARTt capacity_stake:CH1rrfFyJMVn158UHL2fLpKTtoLJojrz5f68toMQdQKU; do
  npx tsx scripts/solana-program-hash.mts --program ${p#*:} --cluster mainnet-beta --so ../h081-deploy-staging/so-mainnet/${p%%:*}.so || echo "MISMATCH ${p%%:*}"
done
```

## P5. Initialize (MAINNET TXS, right after P4)

Both scripts check before signing: mainnet genesis, ids not localnet, upgradeable loader, upgrade authority =
`DEPLOYER_KEY`, deployed executable = the `.so`, and that the `.so` carries the pool id (+ treasury / stream_loan
id). Re-running is safe ("already done"; the read-back checks still run). Only the upgrade authority can init
(refused 6020 / 6007 / 6020 otherwise), so nobody can take the configs first.

```bash
# stream_loan: registry + the treasury's USDG account (fund refuses a fee-paying loan without it). The pool is only checked.
DEPLOYER_KEY=solana/keys/mainnet/deployer-keypair.json KEYS_DIR=solana/keys/mainnet \
POOL_SO=../h081-deploy-staging/so-mainnet/stipend_pool.so STEPS=loan \
LOAN_PROGRAM_ID=8JBd7epQXxdcKRMaWM1S5PC7nsQKoZq3uCetpiJ684g4 LOAN_SO=../h081-deploy-staging/so-mainnet/stream_loan.so \
LOAN_TREASURY=EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq \
npx tsx scripts/mainnet-init.mts

# capacity_stake config + safety_pool pool for H081 (config authority 4eyS..., caps 1,000,000 / 100,000 H081)
DEPLOYER_KEY=solana/keys/mainnet/deployer-keypair.json H081_MINT=EgqxxR7zowzaLEm24oep5qqBieLVAWYX78LhgeqAJAo \
CAPACITY_PROGRAM_ID=CH1rrfFyJMVn158UHL2fLpKTtoLJojrz5f68toMQdQKU SAFETY_PROGRAM_ID=HmzKNPn8LaRyjmggt2uT95B7KvphtoVXQkeVc2HHARTt \
LOAN_PROGRAM_ID=8JBd7epQXxdcKRMaWM1S5PC7nsQKoZq3uCetpiJ684g4 \
CAPACITY_SO=../h081-deploy-staging/so-mainnet/capacity_stake.so SAFETY_SO=../h081-deploy-staging/so-mainnet/safety_pool.so \
CONFIG_AUTHORITY=4eySgHKMNGMpWtbtpfxfSyJZK8LGYxEZLzJwHXCsoPX2 \
npx tsx scripts/mainnet-init-h081.mts        # must print "OK   capacity_stake config" and "OK   safety_pool config"
```

Underwriting stays off (nothing insurable) until the owner decides. Cover is paid in H081 valued 1:1 in base
units against a USDG shortfall (docs/tokenomics.md caveat): size `max_cover` / `max_exposure` accordingly.

## P6. Sweep (MAINNET TX)

Leftover deployer SOL back to the fee wallet (section 8 commands). The deployer stays the upgrade authority of
all four programs.

## Phase-2 emergency

The config authority `4eyS…` signs (SDK builders in `src/solana/token.ts`): `setStakingPausedIx`, `setStakeCapsIx`
(capacity_stake; unstaking is never paused) and `safetySetDepositsPausedIx`, `safetySetDepositCapsIx`,
`safetySetUnderwritingIx` with `loanAsset` = default (safety_pool; unbonding, withdrawals and slashes are never
paused). stream_loan has no admin; only its upgrade authority can replace it (and so change the treasury).

## Phase-2 checklist

- [ ] P1 rehearsal 99/99 on the exact `.so` files (sha256 above)
- [ ] P2 figure stated to the owner: top-up ______ SOL (peak 5.5615 with the largest buffer), OK given
- [ ] P4 dry-run gates pass; deploy; the three hashes match
- [ ] P5 both init scripts exit 0 with read-back OK
- [ ] P6 sweep; HANDOFF.md updated (signatures, balances); creating the Squads treasury is a separate owner go
