#!/usr/bin/env bash
# Verifiable build of the four PRODUCTION programs (stipend_pool, stream_loan, capacity_stake, safety_pool).
# Never builds the localnet-only probe/fast/localnet-treasury variants (no --features is ever passed), so
# stream_loan fails to compile here until its fee::TREASURY placeholder is set to the treasury multisig vault.
#
# Reproducibility rests on four things, all pinned or fixed here:
#   1. the source: a tar of the `solana/` tree at one commit (git archive), unpacked at a fixed path;
#   2. Cargo.lock: the build runs with `--locked`, so no dependency version can float;
#   3. the toolchain: Solana CLI 4.3.2 (Agave), cargo-build-sbf 4.4.0, platform-tools v1.57, host rustc 1.99.1;
#   4. the paths: CARGO_HOME and CARGO_TARGET_DIR live under the fixed work dir, and cargo-build-sbf remaps the
#      working directory, so no user name or checkout location ends up in the binaries.
# The pinned Docker image (solana/verify/Dockerfile) fixes (3) for anyone; natively, the version check below
# refuses a mismatched toolchain unless ALLOW_UNPINNED=1 (and then the output is marked unverifiable).
#
# Usage (WSL or Linux, or inside the Docker image):
#   bash solana/scripts/verifiable-build.sh [--src-tar FILE] [--commit HASH] [--ref GITREF] [--out DIR]
#     --src-tar  tar holding `solana/...` (what `git archive --format=tar <ref> solana` writes). Default: run
#                git archive on this checkout at --ref (HEAD); use --src-tar when git cannot read the checkout
#                (a Windows worktree seen from WSL), which is what `npm run solana:verifiable-build` does.
#     --commit   the commit the tar was made from, recorded in build-info.txt
#     --out      where the .so files, SHA256SUMS, EXECUTABLE-HASHES and build-info.txt go
#                (default: solana/target-verifiable, gitignored)
# Env: VB_WORK (default /tmp/h081-verifiable; keep the default to reproduce someone else's build byte for
#      byte), KEEP_TARGET=1 (reuse the previous target dir; a clean build is the default), ALLOW_UNPINNED=1.
# Nothing here touches a network other than crates.io for the locked dependencies (and, on first use, the
# platform-tools download by cargo-build-sbf). Nothing is deployed.
set -euo pipefail

PIN_SOLANA="4.3.2"
PIN_SBF="4.4.0"
PIN_TOOLS="v1.57"
PIN_RUSTC="1.99.1"
PROGRAMS=(stipend_pool stream_loan capacity_stake safety_pool)

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SRC_TAR="" COMMIT="" REF="HEAD" OUT="$REPO/solana/target-verifiable"
while [ $# -gt 0 ]; do
  case "$1" in
    --src-tar) SRC_TAR="$2"; shift 2 ;;
    --commit) COMMIT="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

source ~/.profile >/dev/null 2>&1 || true
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

# ---- toolchain pin check
first_word_after() { awk -v k="$1" '{ for (i = 1; i < NF; i++) if ($i == k) { print $(i + 1); exit } }'; }
have_solana=$(solana --version 2>/dev/null | first_word_after solana-cli || true)
sbf_out=$(cargo-build-sbf --version 2>/dev/null || true)
have_sbf=$(printf '%s\n' "$sbf_out" | first_word_after cargo-build-sbf || true)
have_tools=$(printf '%s\n' "$sbf_out" | first_word_after platform-tools || true)
have_rustc=$(rustc --version 2>/dev/null | first_word_after rustc || true)
pinned=1
check() { # <what> <have> <want>
  if [ "$2" = "$3" ]; then echo "  $1 $2 (pinned)"; else echo "  $1 ${2:-missing}, pinned $3  MISMATCH"; pinned=0; fi
}
echo "== toolchain"
check "solana-cli      " "$have_solana" "$PIN_SOLANA"
check "cargo-build-sbf " "$have_sbf" "$PIN_SBF"
check "platform-tools  " "$have_tools" "$PIN_TOOLS"
check "host rustc      " "$have_rustc" "$PIN_RUSTC"
if [ "$pinned" != 1 ]; then
  if [ "${ALLOW_UNPINNED:-}" != 1 ]; then
    echo "REFUSED: toolchain differs from the pins (use solana/verify/Dockerfile, or ALLOW_UNPINNED=1 for an unverifiable build)" >&2
    exit 3
  fi
  echo "WARNING: unpinned toolchain; the hashes below are NOT comparable with a verifiable build" >&2
fi

# ---- source at a fixed path
WORK="${VB_WORK:-/tmp/h081-verifiable}"
mkdir -p "$WORK"
rm -rf "$WORK/src"
mkdir -p "$WORK/src"
if [ -n "$SRC_TAR" ]; then
  tar -x -f "$SRC_TAR" -C "$WORK/src"
else
  COMMIT="${COMMIT:-$(git -C "$REPO" rev-parse "$REF")}"
  git -C "$REPO" archive --format=tar "$REF" solana | tar -x -C "$WORK/src"
fi
[ -f "$WORK/src/solana/Cargo.lock" ] || { echo "REFUSED: the source has no solana/Cargo.lock" >&2; exit 4; }
for p in "${PROGRAMS[@]}"; do
  [ -f "$WORK/src/solana/programs/$p/Cargo.toml" ] || { echo "REFUSED: missing programs/$p" >&2; exit 4; }
done
# The source must not carry anything the git tree would not (keys, built artifacts).
for d in keys target target-so test-ledger target-verifiable; do
  [ ! -e "$WORK/src/solana/$d" ] || { echo "REFUSED: the source tar contains solana/$d" >&2; exit 4; }
done

export CARGO_HOME="$WORK/cargo-home"
export CARGO_TARGET_DIR="$WORK/target"
export SOURCE_DATE_EPOCH=0
unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS CARGO_BUILD_RUSTFLAGS
[ "${KEEP_TARGET:-}" = 1 ] || rm -rf "$CARGO_TARGET_DIR"
mkdir -p "$CARGO_HOME" "$CARGO_TARGET_DIR"

# ---- build
cd "$WORK/src/solana"
rm -rf "$WORK/out"
mkdir -p "$WORK/out"
filter() { grep -vE '^\s+(Compiling|Downloaded|Downloading|Checking|Locking|Adding|Updating)' | tail -20; }
for p in "${PROGRAMS[@]}"; do
  echo "== $p"
  cargo build-sbf --manifest-path "programs/$p/Cargo.toml" --sbf-out-dir "$WORK/out/$p" \
    --tools-version "$PIN_TOOLS" -- --locked 2>&1 | filter
  test -f "$WORK/out/$p/$p.so"
done

# ---- outputs
mkdir -p "$OUT"
for p in "${PROGRAMS[@]}"; do cp "$WORK/out/$p/$p.so" "$OUT/$p.so"; done
(cd "$OUT" && sha256sum "${PROGRAMS[@]/%/.so}" > SHA256SUMS)
# solana-verify's executable hash: sha256 of the ELF with trailing zero bytes removed, which is what a
# deployed program's data hashes to once the loader header and the zero padding up to max-len are dropped.
if command -v python3 >/dev/null; then
  (cd "$OUT" && for p in "${PROGRAMS[@]}"; do
    printf '%s  %s.so\n' "$(python3 -c 'import hashlib,sys; d=open(sys.argv[1],"rb").read().rstrip(b"\0"); print(hashlib.sha256(d).hexdigest())' "$p.so")" "$p"
  done > EXECUTABLE-HASHES)
fi
{
  echo "commit            ${COMMIT:-unknown}"
  echo "source tar sha256 $( [ -n "$SRC_TAR" ] && sha256sum "$SRC_TAR" | awk '{print $1}' || echo '(git archive)')"
  echo "Cargo.lock sha256 $(sha256sum "$WORK/src/solana/Cargo.lock" | awk '{print $1}')"
  echo "solana-cli        $have_solana"
  echo "cargo-build-sbf   $have_sbf"
  echo "platform-tools    $have_tools"
  echo "host rustc        $have_rustc"
  echo "pinned toolchain  $([ "$pinned" = 1 ] && echo yes || echo NO, not verifiable)"
  echo "work dir          $WORK"
  echo "built             $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$OUT/build-info.txt"
echo "== outputs in $OUT"
cat "$OUT/build-info.txt"
echo "-- SHA256SUMS"; cat "$OUT/SHA256SUMS"
[ -f "$OUT/EXECUTABLE-HASHES" ] && { echo "-- EXECUTABLE-HASHES (compare with the deployed program)"; cat "$OUT/EXECUTABLE-HASHES"; }
