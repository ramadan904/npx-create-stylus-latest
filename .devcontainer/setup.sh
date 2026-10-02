#!/usr/bin/env bash
# Runs once when the Codespace (or any dev container) is created. Safe to run again.
set -euo pipefail

echo "==> Rust toolchain the templates pin (1.91.0) with the wasm target"
rustup toolchain install 1.91.0 --profile minimal --target wasm32-unknown-unknown
rustup target add wasm32-unknown-unknown

echo "==> cargo-stylus"
if ! command -v cargo-stylus >/dev/null 2>&1; then
  # A prebuilt binary when one is published for this platform (seconds); otherwise build it (several minutes).
  if curl -fsSL --proto '=https' https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.sh | bash \
    && cargo binstall -y --locked cargo-stylus; then
    :
  else
    cargo install --locked cargo-stylus
  fi
fi

cat <<'MSG'

Ready. Try:
  npx create-stylus-latest my-app -t stream --with-client     # or: node bin/create-stylus-latest.js ...
  cd my-app && cargo test
  cp .env.example .env && ./scripts/devnode.sh                 # local Nitro node in Docker, funds a throwaway key
  RPC_URL=http://127.0.0.1:8547 ./scripts/deploy.sh -- 0xYourTokenAddress
MSG
