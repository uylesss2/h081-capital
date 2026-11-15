#!/usr/bin/env bash
# Starts the rep_registry validator in the background (if not already up) and waits for RPC on 8899.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$SOLANA_DIR/test-ledger/rep-validator.log"
mkdir -p "$SOLANA_DIR/test-ledger"
if pgrep -f "solana-test-validator.*--ledger $SOLANA_DIR/test-ledger/rep " >/dev/null; then
  echo "already running"
else
  setsid nohup bash "$DIR/rep-start-validator.sh" > "$LOG" 2>&1 < /dev/null &
fi
for i in $(seq 1 120); do
  if curl -s -m 2 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' http://127.0.0.1:8899 | grep -q '"ok"'; then
    echo "validator healthy on 8899"; exit 0
  fi
  sleep 1
done
echo "validator did not become healthy"; tail -30 "$LOG"; exit 1
