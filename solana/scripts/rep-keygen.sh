#!/usr/bin/env bash
# Generates the LOCALNET rep_registry program keypair into solana/keys/ (gitignored) if missing. The localnet id is
# compiled into rep_registry (declare_id!) and the SDK (src/solana/reputation.ts REP_PROGRAM_ID). Never a mainnet key:
# the mainnet build refuses to compile while declare_id is this key.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
mkdir -p "$SOLANA_DIR/keys"
f="$SOLANA_DIR/keys/rep_registry-keypair.json"
[ -f "$f" ] || solana-keygen new --no-bip39-passphrase --silent --outfile "$f" >/dev/null
echo "rep_registry $(solana-keygen pubkey "$f")"
