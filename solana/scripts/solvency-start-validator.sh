#!/usr/bin/env bash
# solana-test-validator for the solvency suite (test/solana/solvency.test.ts): rpc 28899 / websocket 28900, ledger
# under this worktree (solana/test-ledger/solvency, gitignored). Loads solana/target-so/stipend_pool.so (gitignored;
# `npm run solana:build` or a build of the same sources) at the localnet pool id as an UPGRADEABLE program with the
# public localnet upgrade authority (initialize requires it). Localnet only: nothing here talks to a public cluster.
# Gossip, faucet and the dynamic ports are pinned next to the rpc port (28902, 28903, 28910-28990) so they never
# collide with other local validators (8899/89xx, 8999/8100-8200, 18899/189xx).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
LEDGER="$SOLANA_DIR/test-ledger/solvency"
# LOCALNET_POOL_PROGRAM_ID in src/solana/program.ts (declared in programs/stipend_pool/src/lib.rs)
POOL_ID="${SOLVENCY_POOL_ID:-AzES8Vd7NmoxdSrEBbwDNAwn2pyoAz5m5w7bmVas5Si3}"
# Keypair.fromSeed(sha256("h081 localnet stipend_pool upgrade authority")): LOCALNET_UPGRADE_AUTHORITY in test/solana/config-authority.ts
UPGRADE_AUTHORITY=6CMruTpcTHYowyPcKHkh8YATGUgwBrSfjsHsVDtBV77g
mkdir -p "$LEDGER"
exec solana-test-validator \
  --ledger "$LEDGER" --reset --quiet --rpc-port 28899 \
  --gossip-port 28902 --faucet-port 28903 --dynamic-port-range 28910-28990 \
  --upgradeable-program "$POOL_ID" "$SOLANA_DIR/target-so/stipend_pool.so" "$UPGRADE_AUTHORITY"
