#!/usr/bin/env bash
# Builds the Phase 2 staking programs (capacity_stake, safety_pool), production and localnet `fast`
# builds, into their own CARGO_TARGET_DIR, and copies the .so files into solana/target-so/ (gitignored).
# Usage: staking-build.sh [capacity_stake|safety_pool ...]   (default: both)
set -euo pipefail
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/stipend-solana-target-stake}"
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cd "$SOLANA_DIR"
mkdir -p target-so
filter() { grep -vE '^\s+(Compiling|Downloaded|Downloading|Checking)' | tail -80; }
progs=("$@")
[ ${#progs[@]} -gt 0 ] || progs=(capacity_stake safety_pool)
for p in "${progs[@]}"; do
  M="programs/$p/Cargo.toml"
  cargo build-sbf --manifest-path "$M" --sbf-out-dir "$CARGO_TARGET_DIR/deploy-prod" 2>&1 | filter
  cp "$CARGO_TARGET_DIR/deploy-prod/$p.so" "target-so/$p.so"
  cargo build-sbf --manifest-path "$M" --sbf-out-dir "$CARGO_TARGET_DIR/deploy-fast" --features fast 2>&1 | filter
  cp "$CARGO_TARGET_DIR/deploy-fast/$p.so" "target-so/${p}_fast.so"
done
ls -l target-so
