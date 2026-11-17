#!/usr/bin/env bash
# solana-test-validator for the rep_registry suite: rpc 8899 / websocket 8900 (defaults), ledger under this worktree
# (solana/test-ledger/rep, gitignored). Loads rep_registry.so (solana/target-so) as an UPGRADEABLE program with the
# public localnet upgrade authority (initialize requires it), and the stream_loan fixture accounts from
# solana/test-ledger/rep-accounts (scripts/solana-rep-localnet.mjs fixtures). Localnet only.
# Gossip, faucet and the dynamic ports are pinned next to the rpc port (8902, 8903, 8910-8990): the defaults (8000,
# 9900, 8000-10000) collide with other local validators running at the same time on their own rpc ports.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
LEDGER="$SOLANA_DIR/test-ledger/rep"
ACCTS="$SOLANA_DIR/test-ledger/rep-accounts"
REP_ID=$(solana-keygen pubkey "$SOLANA_DIR/keys/rep_registry-keypair.json")
# Keypair.fromSeed(sha256("h081 localnet stipend_pool upgrade authority")): LOCALNET_UPGRADE_AUTHORITY in test/solana/config-authority.ts
UPGRADE_AUTHORITY=6CMruTpcTHYowyPcKHkh8YATGUgwBrSfjsHsVDtBV77g
# the localnet stream_loan id (declare_id! in programs/stream_loan; LOCALNET_LOAN_PROGRAM_ID in the SDK): no keypair needed
LOAN_ID=FvM9Xczax1TCU15imjdNAMg8JXP4apSs2pn9LWCdjyPc
mkdir -p "$LEDGER"
# stream_loan built from this worktree (rep-loan-build.sh), at its localnet id: the fixture Slots are its accounts, and
# the lender-close test runs its real close_slot. Required: the suite fails without it rather than skip that test.
exec solana-test-validator \
  --ledger "$LEDGER" --reset --quiet --rpc-port 8899 \
  --gossip-port 8902 --faucet-port 8903 --dynamic-port-range 8910-8990 \
  --account-dir "$ACCTS" \
  --upgradeable-program "$REP_ID" "$SOLANA_DIR/target-so/rep_registry.so" "$UPGRADE_AUTHORITY" \
  --upgradeable-program "$LOAN_ID" "$SOLANA_DIR/target-so/stream_loan.so" "$UPGRADE_AUTHORITY"
