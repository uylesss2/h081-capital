#!/usr/bin/env bash
# Starts the solvency validator in the background (if not already up) and waits for RPC on 28899.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$SOLANA_DIR/test-ledger/solvency-validator.log"
PAT="solana-test-validator.*--ledger $SOLANA_DIR/test-ledger/solvency "
mkdir -p "$SOLANA_DIR/test-ledger"
if pgrep -f "$PAT" >/dev/null; then
  echo "already running"
else
  # another suite's validator on 28899 is never touched: refuse instead
  if curl -s -m 2 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' http://127.0.0.1:28899 | grep -q 'jsonrpc'; then
    echo "rpc 28899 is held by another validator; not starting"; exit 1
  fi
  setsid nohup bash "$DIR/solvency-start-validator.sh" > "$LOG" 2>&1 < /dev/null &
fi
for i in $(seq 1 120); do
  if curl -s -m 2 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' http://127.0.0.1:28899 | grep -q '"ok"'; then
    if pgrep -f "$PAT" >/dev/null; then echo "validator healthy on 28899"; exit 0; fi
    echo "rpc 28899 answers but this suite's validator is not running (another validator holds the port)"; tail -30 "$LOG"; exit 1
  fi
  sleep 1
done
echo "validator did not become healthy"; tail -30 "$LOG"; exit 1
