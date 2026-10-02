#!/usr/bin/env bash
# Start a local Arbitrum Nitro dev node (requires Docker) on http://127.0.0.1:8547.
# Then validate against it:  RPC_URL=http://127.0.0.1:8547 ./scripts/deploy.sh --check-only
# Stop it with:              docker rm -f stylus-devnode
set -euo pipefail

IMAGE="${NITRO_IMAGE:-offchainlabs/nitro-node:v3.11.4-7d5ac27}"
NAME="stylus-devnode"
URL="http://127.0.0.1:8547"

command -v docker >/dev/null 2>&1 || { echo "Docker is required to run the local dev node." >&2; exit 1; }

# Optional: FUND_ADDRESS=0x... pre-funds that address. Usually unnecessary: the setup below funds the PRIVATE_KEY in your
# .env. If you do use it, also have that key in PRIVATE_KEY (environment or .env) so the setup can fund the chain owner.
extra=()
if [ -n "${FUND_ADDRESS:-}" ]; then extra+=(--init.dev-init-address "$FUND_ADDRESS"); fi

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p 127.0.0.1:8547:8547 "$IMAGE" \
  --dev --http.addr 0.0.0.0 --http.api=net,web3,eth,debug --http.corsdomain='*' --http.vhosts='*' \
  ${extra[@]+"${extra[@]}"} >/dev/null

echo "Waiting for the dev node at $URL ..."
ready=0
for _ in $(seq 1 90); do
  if curl -fsS -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$URL" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done

if [ "$ready" != 1 ]; then
  echo "Dev node did not become ready; recent logs:" >&2
  docker logs --tail 40 "$NAME" >&2 || true
  exit 1
fi
echo "Dev node ready (chain id 412346). Stop it with: docker rm -f $NAME"

# A bare dev node cannot deploy contracts that have a constructor (erc20, vault, escrow, stream) and does not fund your
# deploy key. scripts/devnode/setup.mjs fixes both; it needs Node and installs viem next to itself the first time.
# A failure here is not fatal: --check-only and constructor-less contracts still work without it.
here="$(cd "$(dirname "$0")" && pwd)"
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  echo "Preparing the dev node (funding your PRIVATE_KEY, installing the Stylus deployer) ..."
  if (cd "$here/devnode" && npm install --silent --no-audit --no-fund >/dev/null 2>&1) && node "$here/devnode/setup.mjs"; then
    echo "Dev node is ready to deploy to: RPC_URL=$URL ./scripts/deploy.sh"
  else
    echo "Warning: the dev node setup failed (see above). Contracts with a constructor will not deploy until it succeeds." >&2
  fi
else
  echo "Warning: Node.js and npm are needed to prepare the dev node (constructor deploys); skipped." >&2
fi
