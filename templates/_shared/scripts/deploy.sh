#!/usr/bin/env bash
# Validate and deploy this Stylus contract. Usage: ./scripts/deploy.sh [--check-only]
set -euo pipefail
cd "$(dirname "$0")/.."

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

if [ "${1:-}" = "--check-only" ]; then exit 0; fi
: "${PRIVATE_KEY:?Set PRIVATE_KEY in .env to deploy}"

# Hand the key over via a private temp file so it never shows up in `ps`.
keyfile="$(mktemp)"
trap 'rm -f "$keyfile"' EXIT
chmod 600 "$keyfile"
printf '%s' "${PRIVATE_KEY#0x}" > "$keyfile"

echo "==> Deploying"
cargo stylus deploy --endpoint "$RPC_URL" --private-key-path "$keyfile"
