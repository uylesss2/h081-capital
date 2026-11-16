#!/usr/bin/env bash
# Private solana-test-validator for the backed-line tests (test/solana/backer.test.ts). LOCALNET ONLY.
#   start [base]: loads stipend_pool.so, stream_loan.so (or, with `base`, target-so/stream_loan_base.so: the program
#                 before backed lines, for the upgrade rehearsal) and stream_loan_fast.so as UPGRADEABLE programs under the
#                 public-seed localnet upgrade authority.
#   stop:         stops only this validator (matched by its ledger path).
#   rpc 18899 (websocket 18900), faucet 18901, gossip 18902, dynamic 18910-18990; ledger solana/test-ledger/backer
#   (gitignored). Never touches the other suites' validators (8899, 8999, 9099, ...).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
LEDGER="${BACKER_LEDGER:-$SOLANA_DIR/test-ledger/backer}"
RPC_PORT="${BACKER_RPC_PORT:-18899}"
SO="$SOLANA_DIR/target-so"
UPGRADE_AUTHORITY=6CMruTpcTHYowyPcKHkh8YATGUgwBrSfjsHsVDtBV77g
pids() { pgrep -f "solana-test-validator.*--ledger $LEDGER" || true; }
case "${1:-start}" in
  stop)
    p=$(pids); if [ -n "$p" ]; then kill $p; for i in $(seq 1 40); do [ -z "$(pids)" ] && break; sleep 0.5; done; echo "stopped $p"; else echo "not running"; fi ;;
  start)
    [ -n "$(pids)" ] && { echo "already running"; exit 0; }
    LOAN_SO="$SO/stream_loan.so"; [ "${2:-}" = base ] && LOAN_SO="$SO/stream_loan_base.so"
    POOL_ID=$(solana-keygen pubkey "$SOLANA_DIR/keys/stipend_pool-keypair.json")
    LOAN_ID=$(solana-keygen pubkey "$SOLANA_DIR/keys/stream_loan-keypair.json")
    FAST_ID=$(solana-keygen pubkey "$SOLANA_DIR/keys/stream_loan_fast-keypair.json")
    STAGE="$HOME/stipend-backer-so"; mkdir -p "$STAGE" "$(dirname "$LEDGER")"
    cp "$SO/stipend_pool.so" "$STAGE/"; cp "$LOAN_SO" "$STAGE/stream_loan.so"; cp "$SO/stream_loan_fast.so" "$STAGE/"
    setsid nohup solana-test-validator --ledger "$LEDGER" --reset --quiet \
      --rpc-port "$RPC_PORT" --faucet-port 18901 --gossip-port 18902 --dynamic-port-range 18910-18990 \
      --upgradeable-program "$POOL_ID" "$STAGE/stipend_pool.so" "$UPGRADE_AUTHORITY" \
      --upgradeable-program "$LOAN_ID" "$STAGE/stream_loan.so" "$UPGRADE_AUTHORITY" \
      --upgradeable-program "$FAST_ID" "$STAGE/stream_loan_fast.so" "$UPGRADE_AUTHORITY" \
      > "$STAGE/validator.log" 2>&1 < /dev/null &
    for i in $(seq 1 120); do
      if curl -s -m 2 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "http://127.0.0.1:$RPC_PORT" | grep -q '"ok"'; then
        echo "validator healthy on $RPC_PORT ($(basename "$LOAN_SO"))"; exit 0
      fi
      sleep 1
    done
    echo "validator did not become healthy"; tail -30 "$STAGE/validator.log"; exit 1 ;;
  *) echo "usage: backer-validator.sh start [base] | stop"; exit 2 ;;
esac
