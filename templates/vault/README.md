# {{name}}

A Stylus (Rust) vault that holds any ERC-20 (for example USDC or Paxos USDG), scaffolded with `create-stylus-latest`
against `stylus-sdk` {{stylus_sdk_version}}.

## Contract

`Vault` tracks a per-account deposit of one ERC-20 chosen at setup:

- a **constructor** `(asset)` sets the token atomically at deploy time, so nobody can race you to set a different one
- `deposit(amount)` pulls tokens with `transferFrom`, so the caller must `approve` the vault first
- `withdraw(amount)` sends the caller's tokens back
- `asset()`, `totalDeposits()`, `depositOf(account)` for reads

State is updated before the external token call, and any failed or false-returning transfer reverts the whole call.
This is a starting point, not audited: add pausing, caps or fee-on-transfer handling before holding real funds.

## Develop

```bash
cargo test                       # token calls are mocked with the SDK's TestVM
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

Deploy it pointed at a token (the constructor argument goes after `--`):

```bash
./scripts/deploy.sh -- 0xTokenAddress
```

Then use it, for example with Foundry's `cast`:

```bash
cast send <TOKEN> "approve(address,uint256)" <VAULT> 1000000 --rpc-url $RPC_URL --private-key $PRIVATE_KEY
cast send <VAULT> "deposit(uint256)" 1000000 --rpc-url $RPC_URL --private-key $PRIVATE_KEY
```
