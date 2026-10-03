#!/usr/bin/env bash
# Prove a deployed contract was built from this source. Rebuilds it in cargo-stylus's pinned Docker image and compares
# the result, byte for byte, with the code that the deployment transaction installed.
#   ./scripts/verify.sh <deployment tx hash>     # printed by VERIFY=1 ./scripts/deploy.sh; RPC_URL comes from .env
# Needs Docker. A deployment made without VERIFY=1 was not built reproducibly, so it will usually not match.
set -euo pipefail
cd "$(dirname "$0")/.."

tx="${1:-}"
if [[ ! "$tx" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  echo "Usage: ./scripts/verify.sh <deployment tx hash>  (0x and 64 hex characters)" >&2
  exit 2
fi
caller_rpc="${RPC_URL:-}"   # an RPC_URL set on the command line wins over .env
if [ -f .env ]; then set -a; . ./.env; set +a; fi
[ -z "$caller_rpc" ] || RPC_URL="$caller_rpc"
RPC_URL="${RPC_URL:-https://sepolia-rollup.arbitrum.io/rpc}"
command -v docker >/dev/null 2>&1 || { echo "verify.sh needs Docker: cargo-stylus rebuilds inside a pinned image." >&2; exit 1; }
command -v cargo-stylus >/dev/null 2>&1 || { echo "cargo-stylus not found. Install it with: cargo install --locked cargo-stylus" >&2; exit 1; }

log="$(mktemp)"
trap 'rm -f "$log"' EXIT
echo "==> Rebuilding in cargo-stylus's Docker image and comparing with $tx on $RPC_URL"
set +e
cargo stylus verify --endpoint "$RPC_URL" --deployment-tx "$tx" 2>&1 | tee "$log"
set -e
# Read the verdict from the output: in Docker mode cargo-stylus exits 0 even when verification fails.
if grep -q "Verification successful" "$log"; then
  echo
  echo "Verified: the code deployed by $tx is exactly what this source builds to."
  exit 0
fi
echo >&2
echo "Not verified: the deployed code does not match what this source builds to (or the check could not run; see above)." >&2
exit 1
