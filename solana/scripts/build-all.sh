#!/usr/bin/env bash
# Builds every program with cargo build-sbf and copies the .so files into solana/target-so/ (gitignored):
#   stipend_pool.so, stipend_pool_probe.so (feature merkle-probe, localnet only),
#   stream_loan.so,
#   capacity_stake.so, capacity_stake_fast.so, safety_pool.so, safety_pool_fast.so (feature fast, localnet only).
# Build artifacts live in $CARGO_TARGET_DIR (WSL home, for speed).
# NO_COPY=1 compiles only (leaves solana/target-so untouched).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cd "$SOLANA_DIR"
mkdir -p target-so
OUT="$CARGO_TARGET_DIR/deploy-all"
filter() { grep -vE '^\s+(Compiling|Downloaded|Downloading|Checking)' | tail -40; }
build() { # <program> <out-name> [features]
  local p=$1 name=$2 feat=${3:-}
  local dir="$OUT/$name"
  mkdir -p "$dir"
  echo "== $name"
  if [ -n "$feat" ]; then
    cargo build-sbf --manifest-path "programs/$p/Cargo.toml" --sbf-out-dir "$dir" --features "$feat" 2>&1 | filter
  else
    cargo build-sbf --manifest-path "programs/$p/Cargo.toml" --sbf-out-dir "$dir" 2>&1 | filter
  fi
  test -f "$dir/$p.so"
  ls -l "$dir/$p.so" | awk '{print "   " $5 " bytes"}'
  if [ "${NO_COPY:-}" != "1" ]; then cp "$dir/$p.so" "target-so/$name.so"; fi
}
build stipend_pool stipend_pool
build stipend_pool stipend_pool_probe merkle-probe
build stream_loan stream_loan
build capacity_stake capacity_stake
build capacity_stake capacity_stake_fast fast
build safety_pool safety_pool
build safety_pool safety_pool_fast fast
echo "all programs built"
[ "${NO_COPY:-}" = "1" ] || ls -l target-so/*.so
