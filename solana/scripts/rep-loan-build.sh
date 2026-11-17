#!/usr/bin/env bash
# Builds stream_loan from THIS worktree (localnet test build: --features localnet-treasury) into
# solana/target-so/stream_loan.so, for the rep_registry suite's lender-close test (bank.lendClose attests before
# close_slot). Own target dir, so a build in another worktree never shares or overwrites it. Localnet only.
set -euo pipefail
export CARGO_TARGET_DIR="$HOME/stipend-solana-target-rep-loan"
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cd "$SOLANA_DIR"
mkdir -p target-so
cargo build-sbf --manifest-path programs/stream_loan/Cargo.toml --sbf-out-dir "$CARGO_TARGET_DIR/deploy" --features localnet-treasury 2>&1 | grep -vE '^\s+(Compiling|Downloaded|Downloading|Checking)' | tail -40
cp "$CARGO_TARGET_DIR/deploy/stream_loan.so" target-so/stream_loan.so
ls -l target-so/stream_loan.so | awk '{print "stream_loan.so " $5 " bytes"}'
