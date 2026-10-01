#!/usr/bin/env bash
# Validate and deploy this Stylus contract.
# Usage: ./scripts/deploy.sh [--check-only] [-- <constructor args>...]
# Contracts with a constructor (erc20, vault) take their arguments after `--`, e.g.
#   ./scripts/deploy.sh -- "My Token" MTK 1000000000000000000000000 0xYourAddress
set -euo pipefail
cd "$(dirname "$0")/.."

check_only=0
ctor=()
while [ $# -gt 0 ]; do
  case "$1" in
    --check-only) check_only=1; shift ;;
    --) shift; ctor=("$@"); break ;;
    *) echo "Unknown argument: $1 (constructor arguments go after --)" >&2; exit 2 ;;
  esac
done

caller_rpc="${RPC_URL:-}"   # an RPC_URL set on the command line wins over .env
if [ -f .env ]; then set -a; . ./.env; set +a; fi
[ -z "$caller_rpc" ] || RPC_URL="$caller_rpc"
# Defaults to Arbitrum Sepolia so `--check-only` works on a fresh project.
RPC_URL="${RPC_URL:-https://sepolia-rollup.arbitrum.io/rpc}"

command -v cargo-stylus >/dev/null 2>&1 || {
  echo "cargo-stylus not found. Install it with: cargo install --locked cargo-stylus" >&2
  exit 1
}

# cargo-stylus builds with --locked, which fails on a fresh project that has no Cargo.lock yet.
[ -f Cargo.lock ] || cargo generate-lockfile

echo "==> Checking contract against $RPC_URL"
cargo stylus check --endpoint "$RPC_URL"

if [ "$check_only" = 1 ]; then exit 0; fi
: "${PRIVATE_KEY:?Set PRIVATE_KEY in .env to deploy}"

# Hand the key over via a private temp file so it never shows up in `ps`.
keyfile="$(mktemp)"
trap 'rm -f "$keyfile"' EXIT
chmod 600 "$keyfile"
printf '%s' "${PRIVATE_KEY#0x}" > "$keyfile"

# --no-verify skips cargo-stylus's default Docker "reproducible build". That mode re-runs the command
# inside a container that cannot read the key file above, and it needs Docker installed. The trade-off is
# that the deployment cannot be checked later with `cargo stylus verify`; drop the flag if you need that.
# Optional gas-price cap in gwei, e.g. MAX_FEE_GWEI=0.5. cargo-stylus otherwise picks a cap equal to the
# current base fee, and the deploy fails with "max fee per gas less than block base fee" if it ticks up
# before the transaction lands. You only ever pay the actual base fee, never the cap.
fee_args=()
if [ -n "${MAX_FEE_GWEI:-}" ]; then fee_args+=(--max-fee-per-gas-gwei "$MAX_FEE_GWEI"); fi

ctor_args=()
if [ ${#ctor[@]} -gt 0 ]; then ctor_args=(--constructor-args "${ctor[@]}"); fi

echo "==> Deploying"
cargo stylus deploy --no-verify --endpoint "$RPC_URL" --private-key-path "$keyfile" \
  ${fee_args[@]+"${fee_args[@]}"} ${ctor_args[@]+"${ctor_args[@]}"}
