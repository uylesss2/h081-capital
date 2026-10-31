#!/usr/bin/env bash
# Local, private solana-test-validator for the stipend_pool tests. Loads the built programs as UPGRADEABLE
# programs (--upgradeable-program; `initialize` requires the upgrade authority) at their localnet ids. Own
# ports and ledger; never touches other validators (another project uses 8899/8900).
#   rpc 8999, faucet 9912, gossip 8091, dynamic 8100-8200, ledger ~/stipend-ledger
# Start detached:  setsid nohup bash solana/scripts/start-validator.sh > /tmp/stipend-validator.log 2>&1 < /dev/null &
# Stop:            bash solana/scripts/stop-validator.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
LEDGER="$HOME/stipend-ledger"
SO="$SOLANA_DIR/target-so"
POOL_ID=$(solana-keygen pubkey "$SOLANA_DIR/keys/stipend_pool-keypair.json")
PROBE_ID=$(solana-keygen pubkey "$SOLANA_DIR/keys/stipend_pool_probe-keypair.json")
# Localnet-only upgrade authority: Keypair.fromSeed(sha256("h081 localnet stipend_pool upgrade authority")),
# LOCALNET_UPGRADE_AUTHORITY in test/solana/config-authority.ts. Public seed: never use it off localnet.
UPGRADE_AUTHORITY=6CMruTpcTHYowyPcKHkh8YATGUgwBrSfjsHsVDtBV77g
# copy the .so files into the WSL filesystem so the validator does not read them over /mnt/c
mkdir -p "$HOME/stipend-so"
cp "$SO/stipend_pool.so" "$SO/stipend_pool_probe.so" "$HOME/stipend-so/"
exec solana-test-validator \
  --ledger "$LEDGER" --reset --quiet \
  --rpc-port 8999 --faucet-port 9912 --gossip-port 8091 --dynamic-port-range 8100-8200 \
  --upgradeable-program "$POOL_ID" "$HOME/stipend-so/stipend_pool.so" "$UPGRADE_AUTHORITY" \
  --upgradeable-program "$PROBE_ID" "$HOME/stipend-so/stipend_pool_probe.so" "$UPGRADE_AUTHORITY"
