#!/usr/bin/env bash
# Generates localnet keypairs for the Phase 2 staking programs into solana/keys/ (gitignored) if
# missing, and prints their ids. The *_fast ids are localnet-only test builds with short cooldowns.
# LOCALNET ids only; nothing here is ever deployed to a public cluster.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
mkdir -p "$SOLANA_DIR/keys"
for name in capacity_stake capacity_stake_fast safety_pool safety_pool_fast; do
  f="$SOLANA_DIR/keys/$name-keypair.json"
  [ -f "$f" ] || solana-keygen new --no-bip39-passphrase --silent --outfile "$f" >/dev/null
  echo "$name $(solana-keygen pubkey "$f")"
done
