#!/usr/bin/env bash
# Builds the PRE-overpay-cap stream_loan (localnet ids, localnet-treasury) from a snapshot of that source and copies it
# to solana/target-so/stream_loan_legacy.so, for the upgrade-migration test in test/solana/lending.test.ts (it downgrades
# the loan validator to this build, creates legacy loan states, then upgrades back to target-so/stream_loan.so).
# Usage (WSL): loan-build-legacy.sh <dir holding the old solana/ tree>
set -euo pipefail
OLD=$1
export CARGO_TARGET_DIR="$HOME/stipend-solana-target-loan-legacy"
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
[ -f "$OLD/solana/programs/stream_loan/Cargo.toml" ] || { echo "no stream_loan source under $OLD/solana"; exit 1; }
grep -q 'pub fn return_excess' "$OLD/solana/programs/stream_loan/src/lib.rs" && { echo "$OLD already has the overpay cap: not a legacy source"; exit 1; }
cd "$OLD/solana"
cargo build-sbf --manifest-path programs/stream_loan/Cargo.toml --sbf-out-dir "$CARGO_TARGET_DIR/deploy" --features localnet-treasury 2>&1 | grep -vE '^\s+(Compiling|Downloaded|Downloading|Checking)' | tail -20
mkdir -p "$SOLANA_DIR/target-so"
cp "$CARGO_TARGET_DIR/deploy/stream_loan.so" "$SOLANA_DIR/target-so/stream_loan_legacy.so"
ls -l "$SOLANA_DIR/target-so/stream_loan_legacy.so"
