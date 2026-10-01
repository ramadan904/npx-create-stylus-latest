#!/usr/bin/env bash
# Start a local Arbitrum Nitro dev node (requires Docker) on http://127.0.0.1:8547.
# Then validate against it:  RPC_URL=http://127.0.0.1:8547 ./scripts/deploy.sh --check-only
# Stop it with:              docker rm -f stylus-devnode
set -euo pipefail

IMAGE="${NITRO_IMAGE:-offchainlabs/nitro-node:v3.11.4-7d5ac27}"
NAME="stylus-devnode"
URL="http://127.0.0.1:8547"

command -v docker >/dev/null 2>&1 || { echo "Docker is required to run the local dev node." >&2; exit 1; }

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p 127.0.0.1:8547:8547 "$IMAGE" \
  --dev --http.addr 0.0.0.0 --http.api=net,web3,eth,debug --http.corsdomain='*' --http.vhosts='*' >/dev/null

echo "Waiting for the dev node at $URL ..."
for _ in $(seq 1 90); do
  if curl -fsS -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$URL" >/dev/null 2>&1; then
    echo "Dev node ready (chain id 412346). Stop it with: docker rm -f $NAME"
    exit 0
  fi
  sleep 1
done

echo "Dev node did not become ready; recent logs:" >&2
docker logs --tail 40 "$NAME" >&2 || true
exit 1
