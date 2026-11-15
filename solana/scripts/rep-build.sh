#!/usr/bin/env bash
# Builds rep_registry (localnet: trusts the localnet stream_loan id) into solana/target-so/rep_registry.so.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cd "$SOLANA_DIR"
mkdir -p target-so
OUT="$CARGO_TARGET_DIR/rep-registry"
cargo build-sbf --manifest-path programs/rep_registry/Cargo.toml --sbf-out-dir "$OUT" 2>&1 | grep -vE '^\s+(Compiling|Downloaded|Downloading|Checking)' | tail -20
cp "$OUT/rep_registry.so" target-so/rep_registry.so
ls -l target-so/rep_registry.so | awk '{print "rep_registry.so " $5 " bytes"}'
