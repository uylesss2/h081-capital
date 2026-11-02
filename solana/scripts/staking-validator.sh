#!/usr/bin/env bash
# Private solana-test-validator for the Phase 2 staking tests (capacity_stake, safety_pool).
#   rpc 9199, faucet 9914, gossip 8093, dynamic 8500-8600, ledger ~/stipend-staking-ledger
# Loads capacity_stake(+_fast), safety_pool(+_fast) and, if built, stream_loan, as UPGRADEABLE programs (their
# init instructions require the upgrade authority), plus the stream_loan fixture accounts written by
# test/solana/staking-fixtures.ts (--account-dir).
# Never touches other validators (8899/8900 belong to another project; 8999 is the pool suite's).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
LEDGER="$HOME/stipend-staking-ledger"
SO="$SOLANA_DIR/target-so"
K="$SOLANA_DIR/keys"
W="$HOME/stipend-staking-so"
# Localnet-only upgrade authority: LOCALNET_UPGRADE_AUTHORITY in test/solana/config-authority.ts (public seed).
UPGRADE_AUTHORITY=6CMruTpcTHYowyPcKHkh8YATGUgwBrSfjsHsVDtBV77g
rm -rf "$W" && mkdir -p "$W/fixtures"
args=()
for p in capacity_stake capacity_stake_fast safety_pool safety_pool_fast; do
  cp "$SO/$p.so" "$W/"
  args+=(--upgradeable-program "$(solana-keygen pubkey "$K/$p-keypair.json")" "$W/$p.so" "$UPGRADE_AUTHORITY")
done
if [ -f "$SO/stream_loan.so" ] && [ -f "$K/stream_loan-keypair.json" ]; then
  cp "$SO/stream_loan.so" "$W/"
  args+=(--upgradeable-program "$(solana-keygen pubkey "$K/stream_loan-keypair.json")" "$W/stream_loan.so" "$UPGRADE_AUTHORITY")
fi
cp "$SO/staking-fixtures/"*.json "$W/fixtures/" 2>/dev/null || true
rm -f "$W/fixtures/meta.json"
exec solana-test-validator \
  --ledger "$LEDGER" --reset --quiet \
  --rpc-port 9199 --faucet-port 9914 --gossip-port 8093 --dynamic-port-range 8500-8600 \
  --account-dir "$W/fixtures" \
  "${args[@]}"
