#!/usr/bin/env bash
# Validate and deploy this Stylus contract.
# Usage: ./scripts/deploy.sh [--check-only] [-- <constructor args>...]
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

run_with_hints() {
  local log status
  log="$(mktemp)"
  set +e
  "$@" 2>&1 | tee "$log"
  status="${PIPESTATUS[0]}"
  set -e
  if [ "$status" -ne 0 ]; then hints "$log"; rm -f "$log"; exit "$status"; fi
  rm -f "$log"
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
run_with_hints cargo stylus deploy --no-verify --endpoint "$RPC_URL" --private-key-path "$keyfile" \
  ${fee_args[@]+"${fee_args[@]}"} ${ctor_args[@]+"${ctor_args[@]}"}
