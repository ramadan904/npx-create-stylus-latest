#!/usr/bin/env bash
# From nothing to a Stylus contract deployed and called on a local Arbitrum chain, in one command, with no wallet and no
# faucet. Made for the Codespace (everything it needs is installed there), and works anywhere with Rust, cargo-stylus,
# Node and Docker.
#
#   .devcontainer/quickstart.sh            # creates ~/stylus-quickstart (or -2, -3, ... if that exists)
#   .devcontainer/quickstart.sh ~/my-app   # or a directory of your choice
#
# Steps: scaffold the counter template with its TypeScript client, start a Nitro dev node in Docker and fund a throwaway
# key on it, deploy the contract with the project's own deploy script, then call it through the generated client.
# CI runs this exact script inside the dev container (.github/workflows/devcontainer.yml).
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
app="${1:-$HOME/stylus-quickstart}"
if [ -z "${1:-}" ]; then
  base="$app"
  n=2
  while [ -e "$app" ]; do app="$base-$n"; n=$((n + 1)); done
elif [ -e "$app" ]; then
  echo "$app already exists; pass a new directory." >&2
  exit 1
fi

start=$(date +%s)
since() { echo $(($(date +%s) - $1)); }
step() { printf '\n\033[1;36m==> %s\033[0m \033[2m(%ss)\033[0m\n' "$1" "$(since "$start")"; }

for tool in node npm cargo docker; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required (the Codespace has it)." >&2; exit 1; }
done
cargo stylus --version >/dev/null 2>&1 || { echo "cargo-stylus is required: run .devcontainer/setup.sh first." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running. In a Codespace it starts with the container; wait a moment and retry." >&2; exit 1; }

step "1/4  Scaffold a Stylus contract (counter template) with its TypeScript client"
node "$repo/bin/create-stylus-latest.js" "$app" -t counter -y --no-git --with-client
(cd "$app/client" && npm install --silent --no-audit --no-fund)

step "2/4  Start a local Arbitrum Nitro dev node and fund a throwaway key"
key=0x$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
printf 'RPC_URL=http://127.0.0.1:8547\nCHAIN_ID=412346\nPRIVATE_KEY=%s\n' "$key" > "$app/.env"
(cd "$app" && ./scripts/devnode.sh)

step "3/4  Build to WASM and deploy with the project's own deploy script"
deploy_start=$(date +%s)
(cd "$app" && ./scripts/deploy.sh 2>&1 | tee deploy.log)
address=$(sed 's/\x1b\[[0-9;]*m//g' "$app/deploy.log" | grep -iE 'deployed code at address' | grep -oE '0x[0-9a-fA-F]{40}' | head -1)
[ -n "$address" ] || { echo "Could not find the deployed address in the output above." >&2; exit 1; }
echo "CONTRACT_ADDRESS=$address" >> "$app/.env"
deploy_secs=$(since "$deploy_start")

step "4/4  Call it through the generated client (read, increment, read again)"
(cd "$app/client" && npm start 2>&1 | tee ../call.log)
grep -q 'number: 1n' "$app/call.log" || { echo "The counter did not reach 1; see the output above." >&2; exit 1; }

total=$(since "$start")
cat <<MSG

$(printf '\033[1;32m')Deployed and called a Stylus contract in ${total}s (build + deploy: ${deploy_secs}s).$(printf '\033[0m')

  Project:   $app
  Contract:  $address  (local Nitro dev node, chain 412346, RPC http://127.0.0.1:8547)

Next:
  cd $app && cargo test                          # the template's unit and property tests
  edit src/lib.rs, then ./scripts/deploy.sh      # redeploy your change to the same node
  npx create-stylus-latest pay -t stream --with-client   # streams, escrow, vault, faucet; agent tools included
  docker rm -f stylus-devnode                    # stop the dev node

QUICKSTART OK
MSG
