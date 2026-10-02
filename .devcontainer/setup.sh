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

# The note a new terminal shows once in a Codespace.
notice=$'\n  create-stylus-latest: deploy and call a Stylus contract on a local Arbitrum chain in one command:\n\n      .devcontainer/quickstart.sh\n\n  More in .devcontainer/WELCOME.md\n'
for dir in /usr/local/etc/vscode-dev-containers /workspaces/.codespaces/shared; do
  if [ -d "$dir" ] && { [ -w "$dir" ] || sudo -n true 2>/dev/null; }; then
    printf '%s\n' "$notice" | { [ -w "$dir" ] && cat > "$dir/first-run-notice.txt" || sudo tee "$dir/first-run-notice.txt" >/dev/null; } || true
  fi
done

cat <<'MSG'

Ready. Deploy and call a Stylus contract on a local Arbitrum chain in one command:
  .devcontainer/quickstart.sh

Or step by step (see .devcontainer/WELCOME.md):
  npx create-stylus-latest my-app -t counter --with-client && cd my-app
  cargo test
  cp .env.example .env    # set PRIVATE_KEY to a throwaway key
  ./scripts/devnode.sh && ./scripts/deploy.sh
MSG
