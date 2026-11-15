#!/usr/bin/env bash
# solana-test-validator for the rep_registry suite: rpc 8899 / websocket 8900 (defaults), ledger under this worktree
# (solana/test-ledger/rep, gitignored). Loads rep_registry.so (solana/target-so) as an UPGRADEABLE program with the
# public localnet upgrade authority (initialize requires it), and the stream_loan fixture accounts from
# solana/test-ledger/rep-accounts (scripts/solana-rep-localnet.mjs fixtures). Localnet only.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
LEDGER="$SOLANA_DIR/test-ledger/rep"
ACCTS="$SOLANA_DIR/test-ledger/rep-accounts"
REP_ID=$(solana-keygen pubkey "$SOLANA_DIR/keys/rep_registry-keypair.json")
# Keypair.fromSeed(sha256("h081 localnet stipend_pool upgrade authority")): LOCALNET_UPGRADE_AUTHORITY in test/solana/config-authority.ts
UPGRADE_AUTHORITY=6CMruTpcTHYowyPcKHkh8YATGUgwBrSfjsHsVDtBV77g
mkdir -p "$LEDGER"
exec solana-test-validator \
  --ledger "$LEDGER" --reset --quiet --rpc-port 8899 \
  --account-dir "$ACCTS" \
  --upgradeable-program "$REP_ID" "$SOLANA_DIR/target-so/rep_registry.so" "$UPGRADE_AUTHORITY"
