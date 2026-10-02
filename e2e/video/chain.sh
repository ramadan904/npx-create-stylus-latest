#!/usr/bin/env bash
# Part 1 of the site's demo video (see record.mjs): a local Arbitrum Nitro dev node with the six contracts the site uses,
# each scaffolded by this CLI from its template and deployed with the project's own deploy script, exactly as a user would.
#
#   e2e/video/chain.sh <out-dir>     # writes <out-dir>/chain.json: the deployer key and the contract addresses
#
# Needs Docker, Rust with the wasm target, cargo-stylus and Node (the Codespace has all of them).
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
out="$(mkdir -p "$1" && cd "$1" && pwd)"
key=0x$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
addr=$(cd "$repo/e2e" && node --input-type=module -e 'import { privateKeyToAddress } from "viem/accounts"; process.stdout.write(privateKeyToAddress(process.argv[1]))' "$key")

deploy() { # deploy <template> <constructor args...>; prints the deployed address
  local name="$1"; shift
  local dir="$out/app-$name"
  rm -rf "$dir"
  node "$repo/bin/create-stylus-latest.js" "$dir" -t "$name" -y --no-git >&2
  printf 'RPC_URL=http://127.0.0.1:8547\nCHAIN_ID=412346\nPRIVATE_KEY=%s\n' "$key" > "$dir/.env"
  (cd "$dir" && ./scripts/deploy.sh -- "$@" > deploy.log 2>&1) || { sed 's/\x1b\[[0-9;]*m//g' "$dir/deploy.log" | tail -30 >&2; return 1; }
  sed 's/\x1b\[[0-9;]*m//g' "$dir/deploy.log" | grep -iE 'deployed code at address' | grep -oE '0x[0-9a-fA-F]{40}' | head -1
}

# The dev node, prepared by the shipped script (it funds the key in .env and installs the Stylus deployer).
node "$repo/bin/create-stylus-latest.js" "$out/node-app" -t counter -y --no-git >&2
printf 'PRIVATE_KEY=%s\n' "$key" > "$out/node-app/.env"
(cd "$out/node-app" && ./scripts/devnode.sh) >&2

counter=$(deploy counter)
token=$(deploy erc20 "Buildathon Token" BUIDL 1000000000000000000000000 "$addr")
vault=$(deploy vault "$token")
escrow=$(deploy escrow "$token")
stream=$(deploy stream "$token")
faucet=$(deploy faucet "$token" 100000000000000000000 3600) # 100 BUIDL per drip, hourly, like the Sepolia faucet

cat > "$out/chain.json" <<JSON
{ "key": "$key", "deployer": "$addr", "counter": "$counter", "token": "$token", "vault": "$vault",
  "escrow": "$escrow", "stream": "$stream", "faucet": "$faucet" }
JSON
echo "contracts deployed: $out/chain.json" >&2
