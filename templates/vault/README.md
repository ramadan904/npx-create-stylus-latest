# {{name}}

A Stylus (Rust) vault that holds any ERC-20 (for example USDC or Paxos USDG), scaffolded with `create-stylus-latest`
against `stylus-sdk` {{stylus_sdk_version}}.

## Contract

`Vault` tracks a per-account deposit of one ERC-20 chosen at setup:

- `init(asset)` sets the token once (Stylus has no constructor, so call it right after deploying)
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

Then point it at a token and use it, for example with Foundry's `cast`:

```bash
cast send <VAULT> "init(address)" <TOKEN> --rpc-url $RPC_URL --private-key $PRIVATE_KEY
cast send <TOKEN> "approve(address,uint256)" <VAULT> 1000000 --rpc-url $RPC_URL --private-key $PRIVATE_KEY
cast send <VAULT> "deposit(uint256)" 1000000 --rpc-url $RPC_URL --private-key $PRIVATE_KEY
```

## Validate without a testnet

Public RPC endpoints may refuse the activation check (we saw `stylus activations not allowed for this request` from
the public Arbitrum Sepolia RPC). A local Nitro dev node accepts it and needs Docker:

```bash
./scripts/devnode.sh
RPC_URL=http://127.0.0.1:8547 ./scripts/deploy.sh --check-only
docker rm -f stylus-devnode   # when done
```
