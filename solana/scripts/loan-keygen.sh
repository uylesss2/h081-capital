#!/usr/bin/env bash
# Generates the LOCALNET stream_loan program keypairs into solana/keys/ (gitignored) if missing: the program and its
# localnet-only `fast` test build. A new fast key must also go into stream_loan's lib.rs (declare_id under `fast`)
# and LOCALNET_LOAN_FAST_PROGRAM_ID in src/solana/backer.ts.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
mkdir -p "$SOLANA_DIR/keys"
for n in stream_loan stream_loan_fast; do
  f="$SOLANA_DIR/keys/$n-keypair.json"
  [ -f "$f" ] || solana-keygen new --no-bip39-passphrase --silent --outfile "$f" >/dev/null
  echo "$n $(solana-keygen pubkey "$f")"
done
