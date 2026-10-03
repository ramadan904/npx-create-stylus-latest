#!/usr/bin/env bash
# Validate and deploy this Stylus contract.
# Usage: ./scripts/deploy.sh [--check-only] [-- <constructor args>...]
# VERIFY=1 deploys reproducibly (needs Docker), so anyone can later check the code with ./scripts/verify.sh <tx>.
# Contracts with a constructor (erc20, vault, escrow, stream, faucet) take their arguments after `--`, e.g.
#   ./scripts/deploy.sh -- "My Token" MTK 1000000000000000000000000 0xYourAddress
# An argument written env:NAME is replaced by NAME from .env (or the environment), e.g. -- env:TOKEN_ADDRESS.
# Deploying to a mainnet (Arbitrum One, Arbitrum Nova, Robinhood Chain) also needs MAINNET=1.
set -euo pipefail
cd "$(dirname "$0")/.."

# Run a command; if it fails, print plain-English hints for the errors we know how to fix.
hints() {
  local log="$1" text
  text="$(sed 's/\x1b\[[0-9;]*m//g' "$log")"
  echo >&2
  case "$text" in
    *"stylus activations not allowed"*)
      echo "Hint: this RPC refuses Stylus activation checks (the public Arbitrum RPC does). Use a provider endpoint" >&2
      echo "      (Alchemy, QuickNode, ...) for Arbitrum Sepolia and set RPC_URL in .env, or run ./scripts/devnode.sh." >&2 ;;
  esac
  case "$text" in
    *"max fee per gas less than block base fee"*)
      echo "Hint: the gas cap lost a race with the base fee. Retry with MAX_FEE_GWEI=0.5 ./scripts/deploy.sh ..." >&2 ;;
  esac
  case "$text" in
    *"insufficient funds"*|*"gas required exceeds allowance"*)
      echo "Hint: the deploy wallet has too little ETH on this network. Fund it from a faucet and retry." >&2 ;;
  esac
  case "$text" in
    *"missing Stylus.toml"*)
      echo "Hint: run this from the project root, next to Stylus.toml." >&2 ;;
  esac
  case "$text" in
    *"could not open private key file"*)
      echo "Hint: cargo-stylus could not read the key file. Do not remove --no-verify unless Docker can see it." >&2 ;;
  esac
}

# The last command's output, kept so the deploy step can read what it reported.
last_output="$(mktemp)"
trap 'rm -f "$last_output"' EXIT

run_with_hints() {
  local status
  set +e
  "$@" 2>&1 | tee "$last_output"
  status="${PIPESTATUS[0]}"
  set -e
  if [ "$status" -ne 0 ]; then hints "$last_output"; exit "$status"; fi
}

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

# env:NAME arguments: read after .env is loaded, so the address lives in one place. An unset or empty NAME stops here.
for ((i = 0; i < ${#ctor[@]}; i++)); do
  case "${ctor[$i]}" in
    env:*)
      var="${ctor[$i]#env:}"
      if [[ ! "$var" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then echo "Bad argument ${ctor[$i]}: expected env:NAME" >&2; exit 2; fi
      if [ -z "${!var:-}" ]; then
        echo "${ctor[$i]}: $var is not set. Put it in .env (see the comment above it in .env.example)." >&2
        exit 2
      fi
      ctor[$i]="${!var}"
      ;;
  esac
done

# Which chain is this, really? Ask the RPC (curl is optional; without it, trust CHAIN_ID from .env).
rpc_chain=""
if command -v curl >/dev/null 2>&1; then
  hex="$(curl -sS -m 10 -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC_URL" 2>/dev/null |
    sed -n 's/.*"result" *: *"0x\([0-9a-fA-F]*\)".*/\1/p')" || true
  if [ -n "$hex" ]; then rpc_chain="$((16#$hex))"; fi
fi
if [ -n "$rpc_chain" ] && [ -n "${CHAIN_ID:-}" ] && [ "$rpc_chain" != "$CHAIN_ID" ]; then
  echo "Note: RPC_URL is chain $rpc_chain but CHAIN_ID in .env says $CHAIN_ID. The client uses CHAIN_ID; update it to match." >&2
fi
chain="${rpc_chain:-${CHAIN_ID:-}}"
case "$chain" in
  42161|42170|4663)
    if [ "$check_only" = 0 ] && [ "${MAINNET:-}" != 1 ]; then
      echo "Chain $chain is a mainnet: this deploy would spend real ETH, and the contract would hold real money." >&2
      echo "These templates are unaudited. Deploy to a testnet or ./scripts/devnode.sh first; to go ahead anyway, run" >&2
      echo "  MAINNET=1 ./scripts/deploy.sh ..." >&2
      exit 1
    fi
    ;;
esac

command -v cargo-stylus >/dev/null 2>&1 || {
  echo "cargo-stylus not found. Install it with: cargo install --locked cargo-stylus" >&2
  exit 1
}

# cargo-stylus builds with --locked, which fails on a fresh project that has no Cargo.lock yet.
[ -f Cargo.lock ] || cargo generate-lockfile

echo "==> Checking contract against $RPC_URL"
run_with_hints cargo stylus check --endpoint "$RPC_URL"

if [ "$check_only" = 1 ]; then exit 0; fi
: "${PRIVATE_KEY:?Set PRIVATE_KEY in .env to deploy}"

# By default (--no-verify) cargo-stylus builds and deploys here: no Docker needed, but the deployment cannot be
# checked against the source later. With VERIFY=1 it re-runs this deploy inside its pinned build image, so the code
# is reproducible and ./scripts/verify.sh <deployment tx> can prove it came from this source. That container sees only
# the project directory (mounted at /source, as its working directory), so the key file must live in the project
# and be passed by a relative path; it is git-ignored, readable only by you, and deleted when this script exits.
verify_args=(--no-verify)
keyfile=""
if [ "${VERIFY:-}" = 1 ]; then
  command -v docker >/dev/null 2>&1 || { echo "VERIFY=1 needs Docker: cargo-stylus builds inside a pinned image." >&2; exit 1; }
  verify_args=()
  keyfile=".stylus-deploy-key"
else
  keyfile="$(mktemp)"
fi
# Hand the key over via a private file so it never shows up in `ps`.
trap 'rm -f "$keyfile" "$last_output"' EXIT
rm -f .stylus-deploy-key   # a fresh file, so its permissions are always the ones set here
(umask 077 && printf '%s' "${PRIVATE_KEY#0x}" > "$keyfile")

# Optional gas-price cap in gwei, e.g. MAX_FEE_GWEI=0.5. cargo-stylus otherwise picks a cap equal to the
# current base fee, and the deploy fails with "max fee per gas less than block base fee" if it ticks up
# before the transaction lands. You only ever pay the actual base fee, never the cap.
fee_args=()
if [ -n "${MAX_FEE_GWEI:-}" ]; then fee_args+=(--max-fee-per-gas-gwei "$MAX_FEE_GWEI"); fi

ctor_args=()
if [ ${#ctor[@]} -gt 0 ]; then ctor_args=(--constructor-args "${ctor[@]}"); fi

if [ "${VERIFY:-}" = 1 ]; then
  echo "==> Deploying reproducibly, inside cargo-stylus's Docker image (the first run builds that image)"
else
  echo "==> Deploying"
fi
run_with_hints cargo stylus deploy ${verify_args[@]+"${verify_args[@]}"} --endpoint "$RPC_URL" \
  --private-key-path "$keyfile" ${fee_args[@]+"${fee_args[@]}"} ${ctor_args[@]+"${ctor_args[@]}"}

if [ "${VERIFY:-}" = 1 ]; then
  # cargo-stylus does not pass the container's exit code on, so a failed deploy inside Docker can still exit 0 here.
  # Trust only a deployment it actually reported.
  tx="$(sed 's/\x1b\[[0-9;]*m//g' "$last_output" | grep -i 'deployment tx hash' | grep -oE '0x[0-9a-fA-F]{64}' | tail -1)"
  if [ -z "$tx" ]; then
    echo "The reproducible deploy did not report a deployment transaction; see the output above for what failed." >&2
    exit 1
  fi
  echo
  echo "Reproducible deploy. Anyone with this source can check the deployed code with:"
  echo "  ./scripts/verify.sh $tx"
fi
