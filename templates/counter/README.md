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

## Validate without a testnet

Public RPC endpoints may refuse the activation check (we saw `stylus activations not allowed for this request` from
the public Arbitrum Sepolia RPC). A local Nitro dev node accepts it and needs Docker:

```bash
./scripts/devnode.sh
RPC_URL=http://127.0.0.1:8547 ./scripts/deploy.sh --check-only
docker rm -f stylus-devnode   # when done
```
