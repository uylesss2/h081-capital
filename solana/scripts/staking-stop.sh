#!/usr/bin/env bash
# Stops only the staking test validator (matched by its own ledger path; STAKING_LEDGER overrides it).
LEDGER="${STAKING_LEDGER:-$HOME/stipend-staking-ledger}"
pids=$(pgrep -f "solana-test-validator.*--ledger $LEDGER" || true)
if [ -n "$pids" ]; then kill $pids; for i in $(seq 1 20); do pgrep -f "solana-test-validator.*--ledger $LEDGER" >/dev/null || break; sleep 0.5; done; echo "stopped $pids"; else echo "not running"; fi
