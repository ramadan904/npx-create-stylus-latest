# {{name}}

A Stylus (Rust) ERC-20 token scaffolded with `create-stylus-latest` against `stylus-sdk` {{stylus_sdk_version}}.

## Contract

`Token` implements `name`, `symbol`, `decimals`, `totalSupply`, `balanceOf`, `allowance`, `transfer`, `approve`
and `transferFrom`, with `Transfer`/`Approval` events and custom errors.

The token is configured by a **constructor** that runs atomically at deploy time, so nobody can initialize it before
you. It takes `(name, symbol, supply, owner)` and mints `supply` to `owner`. Pass `owner` explicitly: `msg_sender`
inside a Stylus constructor is the deployer helper contract, not you.

## Develop

```bash
cargo test
./scripts/export-abi.sh
cargo build --release --target wasm32-unknown-unknown --lib
```

## Deploy to Arbitrum Sepolia

```bash
cargo install --locked cargo-stylus # once
cp .env.example .env                # add a funded testnet PRIVATE_KEY
./scripts/deploy.sh --check-only
./scripts/deploy.sh
```

Deploy with constructor arguments (everything after `--` goes to the constructor):

```bash
./scripts/deploy.sh -- "My Token" MTK 1000000000000000000000000 0xYourAddress
```

That mints 1,000,000 tokens (18 decimals) to your address. Then read it with the client (`--with-client`) or any tool.

### Deploy locally first

```bash
cp .env.example .env     # a throwaway PRIVATE_KEY is fine; the dev node funds it
./scripts/devnode.sh     # needs Docker and Node: starts a dev node, funds your key, installs the Stylus deployer
RPC_URL=http://127.0.0.1:8547 ./scripts/deploy.sh -- "My Token" MTK 1000000000000000000000000 0xYourAddress
docker rm -f stylus-devnode
```

Constructor deploys need that deployer contract, which a bare dev node does not have; `devnode.sh` installs it.
