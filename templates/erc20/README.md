# {{name}}

A Stylus (Rust) ERC-20 token scaffolded with `create-stylus-latest` against `stylus-sdk` {{stylus_sdk_version}}.

## Contract

`Token` implements `name`, `symbol`, `decimals`, `totalSupply`, `balanceOf`, `allowance`, `transfer`, `approve`
and `transferFrom`, with `Transfer`/`Approval` events and custom errors.

Stylus contracts have no constructor, so call `init(name, symbol, supply)` once after deploying. It mints the
supply to the caller and reverts with `AlreadyInitialized` on any later call.

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

Then initialize it, for example with Foundry's `cast`:

```bash
cast send <ADDRESS> "init(string,string,uint256)" "My Token" "MTK" 1000000000000000000000000 \
  --rpc-url $RPC_URL --private-key $PRIVATE_KEY
```

## Validate without a testnet

Public RPC endpoints may refuse the activation check (we saw `stylus activations not allowed for this request` from
the public Arbitrum Sepolia RPC). A local Nitro dev node accepts it and needs Docker:

```bash
./scripts/devnode.sh
RPC_URL=http://127.0.0.1:8547 ./scripts/deploy.sh --check-only
docker rm -f stylus-devnode   # when done
```
