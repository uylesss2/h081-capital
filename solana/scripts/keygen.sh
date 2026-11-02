#!/usr/bin/env bash
# Generates localnet program keypairs into solana/keys/ (gitignored) if missing, and prints their ids.
# These are LOCALNET ids only; nothing here is ever deployed to a public cluster.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
mkdir -p "$SOLANA_DIR/keys"
for name in stipend_pool stipend_pool_probe; do
  f="$SOLANA_DIR/keys/$name-keypair.json"
  [ -f "$f" ] || solana-keygen new --no-bip39-passphrase --silent --outfile "$f" >/dev/null
  echo "$name $(solana-keygen pubkey "$f")"
done
