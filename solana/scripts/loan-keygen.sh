#!/usr/bin/env bash
# Generates the LOCALNET stream_loan program keypair into solana/keys/ (gitignored) if missing.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
mkdir -p "$SOLANA_DIR/keys"
f="$SOLANA_DIR/keys/stream_loan-keypair.json"
[ -f "$f" ] || solana-keygen new --no-bip39-passphrase --silent --outfile "$f" >/dev/null
echo "stream_loan $(solana-keygen pubkey "$f")"
