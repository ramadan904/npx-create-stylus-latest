# {{name}}

A Stylus (Rust) rate-limited ERC-20 faucet, scaffolded with `create-stylus-latest` against `stylus-sdk`
{{stylus_sdk_version}}. Put it in front of a test token so anyone trying your dApp can get tokens themselves: one drip
per address per cooldown.

## Contract

- a **constructor** `(token, amount, cooldown)` fixes the token, the amount per drip (base units) and the cooldown in
  seconds, atomically at deploy time
- `drip()` sends `amount` to the caller, at most once per `cooldown` per address; too soon reverts with
  `TooSoon(availableAt)`
- `availableAt(who)` tells a UI or an agent when an address may drip next (0 if never), using the same rule as `drip`
- `token()`, `amount()`, `cooldown()` for reads
- **fund it** by transferring tokens to its address; when it runs dry, `drip` reverts with `TokenTransferFailed`, so check
  `token.balanceOf(faucet)` in your UI

The drip is recorded before the token transfer, and a failed transfer reverts everything, so an empty faucet does not use
up anyone's cooldown. Not audited. A cooldown per address does not stop someone with many addresses: this is a convenience
for test tokens, not an anti-sybil system.

## Develop

```bash
cargo test                       # unit tests plus a model-based property test with a token-movement ledger
./scripts/export-abi.sh
cargo build --release --target wasm32-unknown-unknown --lib
```

### Deploy locally first

```bash
cp .env.example .env     # a throwaway PRIVATE_KEY is fine; the dev node funds it
./scripts/devnode.sh     # needs Docker and Node: starts a dev node, funds your key, installs the Stylus deployer
RPC_URL=http://127.0.0.1:8547 ./scripts/deploy.sh -- 0xTokenAddress 100000000000000000000 3600
docker rm -f stylus-devnode
```

## Deploy

```bash
cargo install --locked cargo-stylus # once
cp .env.example .env                # add a funded testnet PRIVATE_KEY
./scripts/deploy.sh --check-only
./scripts/deploy.sh -- 0xTokenAddress 100000000000000000000 3600   # 100 tokens (18 decimals) per drip, hourly
```
