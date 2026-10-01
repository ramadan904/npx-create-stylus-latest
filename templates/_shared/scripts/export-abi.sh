#!/usr/bin/env bash
# Print the Solidity interface for this contract. Usage: ./scripts/export-abi.sh
set -euo pipefail
cd "$(dirname "$0")/.."
cargo run --quiet --features export-abi
