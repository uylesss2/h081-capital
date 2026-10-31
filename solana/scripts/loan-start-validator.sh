#!/usr/bin/env bash
# Private solana-test-validator for the stream_loan tests. Loads stipend_pool.so and stream_loan.so (latest from
# solana/target-so) as UPGRADEABLE programs (both `initialize`s require the upgrade authority), plus nothing else.
#   rpc 9099, faucet 9913, gossip 8092, dynamic 8300-8400, ledger ~/stipend-loan-ledger
# Never touches other validators (8899/8900 belong to another project; 8999 is the pool suite's).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
LEDGER="$HOME/stipend-loan-ledger"
SO="$SOLANA_DIR/target-so"
POOL_ID=$(solana-keygen pubkey "$SOLANA_DIR/keys/stipend_pool-keypair.json")
LOAN_ID=$(solana-keygen pubkey "$SOLANA_DIR/keys/stream_loan-keypair.json")
# Localnet-only upgrade authority: Keypair.fromSeed(sha256("h081 localnet stipend_pool upgrade authority")),
# LOCALNET_UPGRADE_AUTHORITY in test/solana/config-authority.ts. Public seed: never use it off localnet.
UPGRADE_AUTHORITY=6CMruTpcTHYowyPcKHkh8YATGUgwBrSfjsHsVDtBV77g
mkdir -p "$HOME/stipend-loan-so"
cp "$SO/stipend_pool.so" "$SO/stream_loan.so" "$HOME/stipend-loan-so/"
exec solana-test-validator \
  --ledger "$LEDGER" --reset --quiet \
  --rpc-port 9099 --faucet-port 9913 --gossip-port 8092 --dynamic-port-range 8300-8400 \
  --upgradeable-program "$POOL_ID" "$HOME/stipend-loan-so/stipend_pool.so" "$UPGRADE_AUTHORITY" \
  --upgradeable-program "$LOAN_ID" "$HOME/stipend-loan-so/stream_loan.so" "$UPGRADE_AUTHORITY"
