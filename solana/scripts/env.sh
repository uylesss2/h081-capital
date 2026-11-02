#!/usr/bin/env bash
# Shared environment for the Solana toolchain in WSL.
source ~/.profile >/dev/null 2>&1 || true
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/stipend-solana-target}"
SOLANA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export SOLANA_DIR
