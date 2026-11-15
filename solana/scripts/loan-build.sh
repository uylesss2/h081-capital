#!/usr/bin/env bash
# Builds ONLY the stream_loan program (own target dir) and copies the .so into solana/target-so/.
# Also builds the localnet-only `fast` variant (own program id, short grace/term/claim window) as
# target-so/stream_loan_fast.so for the backed-line default tests. LOAN_TARGET_DIR overrides the target dir
# (so two worktrees building at once never share one).
set -euo pipefail
export CARGO_TARGET_DIR="${LOAN_TARGET_DIR:-$HOME/stipend-solana-target-loan}"
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cd "$SOLANA_DIR"
mkdir -p target-so
# localnet-treasury: test build, allows the placeholder fee::TREASURY (a production build refuses it)
cargo build-sbf --manifest-path programs/stream_loan/Cargo.toml --sbf-out-dir "$CARGO_TARGET_DIR/deploy" --features localnet-treasury 2>&1 | grep -vE '^\s+(Compiling|Downloaded|Downloading|Checking)' | tail -80
cp "$CARGO_TARGET_DIR/deploy/stream_loan.so" target-so/stream_loan.so
ls -l target-so/stream_loan.so
if [ "${LOAN_SKIP_FAST:-}" != "1" ]; then
  FAST_TARGET="${CARGO_TARGET_DIR}-fast"
  CARGO_TARGET_DIR="$FAST_TARGET" cargo build-sbf --manifest-path programs/stream_loan/Cargo.toml --sbf-out-dir "$FAST_TARGET/deploy" --features localnet-treasury,fast 2>&1 | grep -vE '^\s+(Compiling|Downloaded|Downloading|Checking)' | tail -40
  cp "$FAST_TARGET/deploy/stream_loan.so" target-so/stream_loan_fast.so
  ls -l target-so/stream_loan_fast.so
fi
