#!/usr/bin/env bash
# Stops only the stream_loan test validator (matched by its own ledger path).
pids=$(pgrep -f "solana-test-validator.*--ledger $HOME/stipend-loan-ledger" || true)
if [ -n "$pids" ]; then kill $pids; for i in $(seq 1 20); do pgrep -f "solana-test-validator.*--ledger $HOME/stipend-loan-ledger" >/dev/null || break; sleep 0.5; done; echo "stopped $pids"; else echo "not running"; fi
