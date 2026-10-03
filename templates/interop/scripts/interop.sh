#!/usr/bin/env bash
# Solidity calling Rust: compiles solidity/Consumer.sol, deploys it pointed at your deployed MathLib, and checks the
# results and the errors on-chain. Needs CONTRACT_ADDRESS (the deployed MathLib), RPC_URL, CHAIN_ID and PRIVATE_KEY,
# from .env or the environment. Try it on the local dev node:
#   ./scripts/devnode.sh && ./scripts/deploy.sh      # then put the address it prints in .env as CONTRACT_ADDRESS
#   ./scripts/interop.sh
set -euo pipefail
cd "$(dirname "$0")/.."
command -v node >/dev/null 2>&1 || { echo "Node.js 18+ is required." >&2; exit 1; }
# The Rust contract's real interface, so the script can check Consumer.sol's IMathLib against it.
mkdir -p target && ./scripts/export-abi.sh > target/MathLib.sol
if [ ! -d scripts/interop/node_modules ]; then
  echo "Installing the Solidity compiler (solc-js) and viem for the interop script ..."
  (cd scripts/interop && npm install --silent --no-audit --no-fund)
fi
exec node scripts/interop/interop.mjs
