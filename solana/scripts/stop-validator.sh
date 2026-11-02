#!/usr/bin/env bash
# Stops only the stipend test validator (matched by its own ledger path).
pids=$(pgrep -f "solana-test-validator.*--ledger $HOME/stipend-ledger" || true)
if [ -n "$pids" ]; then kill $pids; echo "stopped $pids"; else echo "not running"; fi
