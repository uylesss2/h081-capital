#!/usr/bin/env bash
# Stops only the rep_registry validator (matched by its own ledger path).
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
pat="solana-test-validator.*--ledger $SOLANA_DIR/test-ledger/rep "
pids=$(pgrep -f "$pat" || true)
if [ -n "$pids" ]; then kill $pids; for i in $(seq 1 30); do pgrep -f "$pat" >/dev/null || break; sleep 0.5; done; echo "stopped $pids"; else echo "not running"; fi
