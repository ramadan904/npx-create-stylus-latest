#!/usr/bin/env bash
# A web page for your deployed contract: every function as a form, reads and writes, errors decoded by name.
#   ./scripts/ui.sh            # then open http://127.0.0.1:5173 (in a Codespace, the forwarded port)
#   ./scripts/ui.sh 8080       # another port
# It reads RPC_URL, CHAIN_ID and CONTRACT_ADDRESS from .env each time the page loads, so after a redeploy just update
# .env and reload. After changing the contract's functions, run this again to re-export its interface.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v node >/dev/null 2>&1 || { echo "Node.js 18+ is required for the UI." >&2; exit 1; }
echo "Exporting the contract's interface (cargo stylus export-abi)..."
./scripts/export-abi.sh > ui/abi.sol
exec node ui/serve.mjs "${1:-5173}"
