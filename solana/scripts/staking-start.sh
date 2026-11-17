#!/usr/bin/env bash
# Starts the staking test validator detached (if not running) and waits for RPC on 9199 (STAKING_RPC_PORT and
# STAKING_LEDGER override them: see staking-validator.sh).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEDGER="${STAKING_LEDGER:-$HOME/stipend-staking-ledger}"
PORT="${STAKING_RPC_PORT:-9199}"
LOG="${STAKING_LOG:-/tmp/stipend-staking-validator.log}"
if pgrep -f "solana-test-validator.*--ledger $LEDGER" >/dev/null; then
  echo "already running"
else
  setsid nohup bash "$DIR/staking-validator.sh" > "$LOG" 2>&1 < /dev/null &
fi
for i in $(seq 1 120); do
  if curl -s -m 2 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "http://127.0.0.1:$PORT" | grep -q '"ok"'; then
    echo "staking validator healthy on $PORT"; exit 0
  fi
  sleep 1
done
echo "staking validator did not become healthy"; tail -30 "$LOG"; exit 1
