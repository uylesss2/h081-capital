#!/usr/bin/env bash
# LOCALNET ONLY: upgrades the program <program_id> on the stream_loan test validator (rpc 127.0.0.1:9099, never any other
# cluster) to <so>, signed and paid by <authority.json> (the public-seed localnet upgrade authority the tests use).
# Used by the upgrade-migration test in test/solana/lending.test.ts. Never pass --final: the authority stays.
# Usage (WSL): loan-upgrade-localnet.sh <so> <authority.json> <program_id>
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
SO=$1; AUTH=$2; PROG=$3
[ "$PROG" = FvM9Xczax1TCU15imjdNAMg8JXP4apSs2pn9LWCdjyPc ] || { echo "only the localnet stream_loan id may be upgraded here"; exit 1; }
[ "$(solana-keygen pubkey "$AUTH")" = 6CMruTpcTHYowyPcKHkh8YATGUgwBrSfjsHsVDtBV77g ] || { echo "not the localnet upgrade authority"; exit 1; }
solana program deploy --url http://127.0.0.1:9099 --keypair "$AUTH" --upgrade-authority "$AUTH" --program-id "$PROG" "$SO" 2>&1 | tail -3
