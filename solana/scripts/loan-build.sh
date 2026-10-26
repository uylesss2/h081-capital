#!/usr/bin/env bash
# Builds ONLY the stream_loan program (own target dir) and copies the .so into solana/target-so/.
set -euo pipefail
export CARGO_TARGET_DIR="$HOME/stipend-solana-target-loan"
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cd "$SOLANA_DIR"
mkdir -p target-so
cargo build-sbf --manifest-path programs/stream_loan/Cargo.toml --sbf-out-dir "$CARGO_TARGET_DIR/deploy" 2>&1 | grep -vE '^\s+(Compiling|Downloaded|Downloading|Checking)' | tail -80
cp "$CARGO_TARGET_DIR/deploy/stream_loan.so" target-so/stream_loan.so
ls -l target-so/stream_loan.so
