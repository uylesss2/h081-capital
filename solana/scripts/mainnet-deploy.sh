#!/usr/bin/env bash
# Deploy the four production programs to Solana MAINNET with the owner's key as upgrade authority.
# Owner's explicit go given 2026-10-26 ("I assume full consequences"; upgrade key = the owner's deployer key).
# Never deploys probe/fast variants. Idempotent: skips programs that are already deployed.
# Usage (WSL): DEPLOYER_KEY=/mnt/c/Users/Joseph/H081-keys/h081-deployer-upgrade-authority.json bash solana/scripts/mainnet-deploy.sh
set -uo pipefail
source ~/.profile 2>/dev/null || true
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1
KEY="${DEPLOYER_KEY:?set DEPLOYER_KEY to the deployer keypair file}"
URL="${MAINNET_RPC:-https://api.mainnet-beta.solana.com}"
PRICE="${CU_PRICE:-100000}"   # micro-lamports per CU, so uploads land under load
MIN_SOL="${MIN_SOL:-9}"

genesis=$(solana genesis-hash --url "$URL")
[ "$genesis" = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" ] || { echo "REFUSED: $URL is not mainnet-beta (genesis $genesis)"; exit 1; }
addr=$(solana-keygen pubkey "$KEY")
bal=$(solana balance "$addr" --url "$URL" | awk '{print $1}')
echo "deployer $addr  balance $bal SOL  rpc $URL"
awk -v b="$bal" -v m="$MIN_SOL" 'BEGIN{exit !(b+0 >= m+0)}' || { echo "REFUSED: fund $addr with at least $MIN_SOL SOL first"; exit 2; }

deploy() {
  local name=$1 so="target-so/$1.so" pk="keys/$1-keypair.json" id
  id=$(solana-keygen pubkey "$pk")
  if solana program show "$id" --url "$URL" >/dev/null 2>&1; then echo "[$name] already deployed at $id"; return 0; fi
  local size max; size=$(stat -c %s "$so"); max=$(( size * 5 / 4 ))
  for attempt in 1 2 3; do
    echo "[$name] deploying $id ($size bytes, max-len $max), attempt $attempt"
    if solana program deploy "$so" --program-id "$pk" --upgrade-authority "$KEY" --keypair "$KEY" \
         --url "$URL" --max-len "$max" --with-compute-unit-price "$PRICE" --max-sign-attempts 30; then
      echo "[$name] deployed"; return 0
    fi
    echo "[$name] attempt $attempt failed; reclaiming any stranded buffer"
    solana program close --buffers --keypair "$KEY" --url "$URL" --bypass-warning >/dev/null 2>&1 || true
    sleep 5
  done
  echo "[$name] FAILED after 3 attempts"; return 1
}

status=0
for p in stipend_pool stream_loan capacity_stake safety_pool; do deploy "$p" || status=1; done
echo "== on-chain state"
for p in stipend_pool stream_loan capacity_stake safety_pool; do
  id=$(solana-keygen pubkey "keys/$p-keypair.json")
  echo "-- $p $id"; solana program show "$id" --url "$URL" 2>&1 | grep -E "Program Id|Authority|Data Length|Balance|Last Deployed" || echo "   not deployed"
done
echo "deployer balance now: $(solana balance "$addr" --url "$URL")"
exit $status
