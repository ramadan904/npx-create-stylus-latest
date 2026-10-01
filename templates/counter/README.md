# {{name}}

A minimal [Stylus](https://docs.arbitrum.io/stylus/gentle-introduction) smart contract in Rust, scaffolded with
`create-stylus-latest` against `stylus-sdk` {{stylus_sdk_version}}.

## Contract

`Counter` stores one `uint256` and exposes `number()`, `setNumber(uint256)`, `increment()` and `addNumber(uint256)`.

## Develop

```bash
cargo test                          # unit tests (no node needed)
./scripts/export-abi.sh             # print the Solidity interface
cargo build --release --target wasm32-unknown-unknown --lib
```

## Deploy to Arbitrum Sepolia

```bash
cargo install --locked cargo-stylus # once
cp .env.example .env                # add a funded testnet PRIVATE_KEY
./scripts/deploy.sh --check-only    # validate on-chain activation
./scripts/deploy.sh                 # deploy
```

Call it from any Solidity or ethers/viem client using the ABI from `export-abi.sh`.
