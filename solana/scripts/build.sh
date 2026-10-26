#!/usr/bin/env bash
# Builds the production stipend_pool .so and the localnet-only merkle-probe build, then copies both
# into solana/target-so/ (gitignored). Build artifacts live in $CARGO_TARGET_DIR (WSL home, for speed).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cd "$SOLANA_DIR"
mkdir -p target-so
M=programs/stipend_pool/Cargo.toml
filter() { grep -vE '^\s+(Compiling|Downloaded|Downloading|Checking)' | tail -60; }
cargo build-sbf --manifest-path "$M" --sbf-out-dir "$CARGO_TARGET_DIR/deploy-prod" 2>&1 | filter
cp "$CARGO_TARGET_DIR/deploy-prod/stipend_pool.so" target-so/stipend_pool.so
cargo build-sbf --manifest-path "$M" --sbf-out-dir "$CARGO_TARGET_DIR/deploy-probe" --features merkle-probe 2>&1 | filter
cp "$CARGO_TARGET_DIR/deploy-probe/stipend_pool.so" target-so/stipend_pool_probe.so
ls -l target-so
