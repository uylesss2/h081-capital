#!/usr/bin/env bash
# Private solana-test-validator for the stream_loan tests. Loads stipend_pool.so (latest from
# solana/target-so) and stream_loan.so as immutable programs, plus nothing else.
#   rpc 9099, faucet 9913, gossip 8092, dynamic 8300-8400, ledger ~/stipend-loan-ledger
# Never touches other validators (8899/8900 belong to another project; 8999 is the pool suite's).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
LEDGER="$HOME/stipend-loan-ledger"
SO="$SOLANA_DIR/target-so"
POOL_ID=$(solana-keygen pubkey "$SOLANA_DIR/keys/stipend_pool-keypair.json")
LOAN_ID=$(solana-keygen pubkey "$SOLANA_DIR/keys/stream_loan-keypair.json")
mkdir -p "$HOME/stipend-loan-so"
cp "$SO/stipend_pool.so" "$SO/stream_loan.so" "$HOME/stipend-loan-so/"
exec solana-test-validator \
  --ledger "$LEDGER" --reset --quiet \
  --rpc-port 9099 --faucet-port 9913 --gossip-port 8092 --dynamic-port-range 8300-8400 \
  --bpf-program "$POOL_ID" "$HOME/stipend-loan-so/stipend_pool.so" \
  --bpf-program "$LOAN_ID" "$HOME/stipend-loan-so/stream_loan.so"
