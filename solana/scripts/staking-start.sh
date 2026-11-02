#!/usr/bin/env bash
# Starts the staking test validator detached (if not running) and waits for RPC on 9199.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if pgrep -f "solana-test-validator.*--ledger $HOME/stipend-staking-ledger" >/dev/null; then
  echo "already running"
else
  setsid nohup bash "$DIR/staking-validator.sh" > /tmp/stipend-staking-validator.log 2>&1 < /dev/null &
fi
for i in $(seq 1 120); do
  if curl -s -m 2 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' http://127.0.0.1:9199 | grep -q '"ok"'; then
    echo "staking validator healthy on 9199"; exit 0
  fi
  sleep 1
done
echo "staking validator did not become healthy"; tail -30 /tmp/stipend-staking-validator.log; exit 1
