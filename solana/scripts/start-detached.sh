#!/usr/bin/env bash
# Starts the stipend test validator in the background (if not already up) and waits for RPC on 8999.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if pgrep -f "solana-test-validator.*--ledger $HOME/stipend-ledger" >/dev/null; then
  echo "already running"
else
  setsid nohup bash "$DIR/start-validator.sh" > /tmp/stipend-validator.log 2>&1 < /dev/null &
fi
for i in $(seq 1 90); do
  if curl -s -m 2 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' http://127.0.0.1:8999 | grep -q '"ok"'; then
    echo "validator healthy on 8999"; exit 0
  fi
  sleep 1
done
echo "validator did not become healthy"; tail -30 /tmp/stipend-validator.log; exit 1
