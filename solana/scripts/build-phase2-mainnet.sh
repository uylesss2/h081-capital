#!/usr/bin/env bash
# Builds the MAINNET stream_loan, safety_pool and capacity_stake .so files (feature `mainnet`, size profile,
# no-log-ix-name) from a git-archive snapshot of the protocol repo (never the working tree), then checks the
# program ids compiled into each .so before anything is deployed.
#
# Usage (WSL): bash build-phase2-mainnet.sh <snapshot.tar> <mainnet_keys_dir> <out_dir> [program ...]
#   <mainnet_keys_dir> holds stream_loan-keypair.json, safety_pool-keypair.json, capacity_stake-keypair.json
#   (only their PUBLIC keys are read, with solana-keygen pubkey).
#
# What the `mainnet` feature does (and why this script exists; security review 2026-10-31):
#   - stream_loan and safety_pool talk to the mainnet stipend_pool E16DKmtr... (cfg-selected constant, no sed);
#   - each program refuses to compile while its declare_id is still the localnet key, and safety_pool refuses
#     while STREAM_LOAN_ID is the localnet stream_loan key (whoever holds a localnet/devnet key could deploy a
#     forged program at that address on mainnet);
#   - stream_loan also refuses while fee::TREASURY is the placeholder (set it to the treasury multisig first).
# Only the declare_id! lines and safety_pool's STREAM_LOAN_ID line are patched here, never a global replace.
# After the build, every .so must contain its own mainnet id (and E16DK where it talks to the pool) and must
# not contain any localnet id (AzES8, FvM9, EvKj, 6yzL, the *_fast ids) or a devnet id from keys/devnet.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
TAR=$1; KEYS=$2; OUT=$3; shift 3
PROGS=("$@"); [ ${#PROGS[@]} -gt 0 ] || PROGS=(stream_loan safety_pool capacity_stake)
SRC=$HOME/h081-phase2-mainnet-src; export CARGO_TARGET_DIR=$HOME/h081-phase2-mainnet-target
rm -rf "$SRC"; mkdir -p "$SRC" "$OUT"; tar -xf "$TAR" -C "$SRC"; cd "$SRC/solana"

declare -A LOCAL=([stream_loan]=FvM9Xczax1TCU15imjdNAMg8JXP4apSs2pn9LWCdjyPc [safety_pool]=EvKjwxVQX1RhyoBXisdbzk1JGLb5fMgZzHVLQAiPKJwe [capacity_stake]=6yzLZPu3JcLQHZQqLKWpGnHUpNTGAkoRcW8Ji8oSgCd3)
POOL=E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM
declare -A NEW
for p in stream_loan safety_pool capacity_stake; do
  [ -f "$KEYS/$p-keypair.json" ] && NEW[$p]=$(solana-keygen pubkey "$KEYS/$p-keypair.json")
done
for p in "${PROGS[@]}"; do
  [ -n "${NEW[$p]:-}" ] || { echo "missing $KEYS/$p-keypair.json"; exit 1; }
  sed -i "s/^declare_id!(\"${LOCAL[$p]}\");/declare_id!(\"${NEW[$p]}\");/" "programs/$p/src/lib.rs"
  grep -q "^declare_id!(\"${NEW[$p]}\");" "programs/$p/src/lib.rs" || { echo "$p: declare_id not patched"; exit 1; }
  echo "$p declare_id ${LOCAL[$p]} -> ${NEW[$p]}"
done
if printf '%s\n' "${PROGS[@]}" | grep -qx safety_pool; then
  [ -n "${NEW[stream_loan]:-}" ] || { echo "safety_pool needs the mainnet stream_loan key"; exit 1; }
  sed -i "s/^pub const STREAM_LOAN_ID: Pubkey = pubkey!(\"${LOCAL[stream_loan]}\");/pub const STREAM_LOAN_ID: Pubkey = pubkey!(\"${NEW[stream_loan]}\");/" programs/safety_pool/src/stream_loan_view.rs
  grep -q "^pub const STREAM_LOAN_ID: Pubkey = pubkey!(\"${NEW[stream_loan]}\");" programs/safety_pool/src/stream_loan_view.rs || { echo "safety_pool: STREAM_LOAN_ID not patched"; exit 1; }
fi

FORBIDDEN=(AzES8Vd7NmoxdSrEBbwDNAwn2pyoAz5m5w7bmVas5Si3 FvM9Xczax1TCU15imjdNAMg8JXP4apSs2pn9LWCdjyPc EvKjwxVQX1RhyoBXisdbzk1JGLb5fMgZzHVLQAiPKJwe
  6yzLZPu3JcLQHZQqLKWpGnHUpNTGAkoRcW8Ji8oSgCd3 5K2L3eNBzmeznEZpY4vav74UHRaBHgQJv582W5i4kT7 DoiRuuwMkN8M4CWQy45Lne2wGP7JCPUtPDiC1pE9QM1q)
DEVNET_KEYS="$(dirname "$KEYS")/devnet"
if [ -d "$DEVNET_KEYS" ]; then
  for f in "$DEVNET_KEYS"/*-keypair.json; do [ -f "$f" ] && FORBIDDEN+=("$(solana-keygen pubkey "$f")"); done
fi

# so_has <file.so> <base58 pubkey>: exit 0 when the 32 raw bytes of the key occur in the file
so_has() {
  python3 - "$1" "$2" <<'PY'
import sys
A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
n = 0
for ch in sys.argv[2]:
    n = n * 58 + A.index(ch)
key = n.to_bytes(32, 'big')
sys.exit(0 if key in open(sys.argv[1], 'rb').read() else 1)
PY
}

fail=0
for p in "${PROGS[@]}"; do
  echo "== $p"
  cargo build-sbf --manifest-path "programs/$p/Cargo.toml" --sbf-out-dir "$CARGO_TARGET_DIR/out/$p" --features mainnet,no-log-ix-name 2>&1 | grep -vE '^\s+(Compiling|Downloaded|Downloading)' | tail -15
  so="$CARGO_TARGET_DIR/out/$p/$p.so"
  cp "$so" "$OUT/$p.so"
  so_has "$so" "${NEW[$p]}" && echo "  ok: own id ${NEW[$p]}" || { echo "  FAIL: own id ${NEW[$p]} missing"; fail=1; }
  if [ "$p" != capacity_stake ]; then
    so_has "$so" "$POOL" && echo "  ok: mainnet stipend_pool $POOL" || { echo "  FAIL: mainnet stipend_pool id missing"; fail=1; }
  fi
  if [ "$p" = safety_pool ]; then
    so_has "$so" "${NEW[stream_loan]}" && echo "  ok: stream_loan ${NEW[stream_loan]}" || { echo "  FAIL: mainnet stream_loan id missing"; fail=1; }
  fi
  for k in "${FORBIDDEN[@]}"; do
    if so_has "$so" "$k"; then echo "  FAIL: contains non-mainnet id $k"; fail=1; fi
  done
  stat -c '  %s bytes' "$OUT/$p.so"; sha256sum "$OUT/$p.so"
done
[ $fail -eq 0 ] || { echo "BUILD_CHECK_FAILED: do not deploy these files"; exit 1; }
echo BUILD_OK
