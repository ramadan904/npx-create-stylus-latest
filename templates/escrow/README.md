# {{name}}

A Stylus (Rust) stablecoin escrow, scaffolded with `create-stylus-latest` against `stylus-sdk` {{stylus_sdk_version}}.
It is meant for payments between parties that do not trust each other, including software agents: lock USDC or Paxos
USDG for a counterparty, release it when the work is accepted, and never get stuck if they disappear.

## Contract

`Escrow` settles deals in one ERC-20 chosen at deploy time:

- a **constructor** `(token)` fixes the token atomically, so nobody can race you to set a different one
- `create(seller, amount, deadline, arbiter)` locks the caller's tokens (call `approve` on the token first) and returns a
  deal id. A deal is funded the moment it exists, so there is no half-created state. `arbiter` may be the zero address
  for "no arbiter"
- `release(id)` pays the seller: the buyer or the arbiter, while the deal is funded
- `refund(id)` returns the tokens to the buyer: the seller or the arbiter at any time, and the buyer after `deadline`
- `deal(id)`, `dealCount()`, `token()` for reads. Deal state is `1` funded, `2` released, `3` refunded

A deal can be settled exactly once. State is updated before the external token call, and a failed or false-returning
transfer reverts the whole call. The zero address is never treated as an arbiter.

Not audited, and deliberately small: fee-on-transfer and rebasing tokens are not handled, there is no partial release,
and the arbiter is trusted by both sides. Decide those before holding real funds.

## Develop

```bash
cargo test                       # unit tests plus a model-based property test; token calls are mocked
./scripts/export-abi.sh
cargo build --release --target wasm32-unknown-unknown --lib
```

## Deploy

```bash
cargo install --locked cargo-stylus # once
cp .env.example .env                # add a funded testnet PRIVATE_KEY
./scripts/deploy.sh --check-only
./scripts/deploy.sh -- 0xTokenAddress
```

### Deploy locally first

```bash
cp .env.example .env     # a throwaway PRIVATE_KEY is fine; the dev node funds it
./scripts/devnode.sh     # needs Docker and Node: starts a dev node, funds your key, installs the Stylus deployer
RPC_URL=http://127.0.0.1:8547 ./scripts/deploy.sh -- 0xTokenAddress
docker rm -f stylus-devnode
```

Constructor deploys need that deployer contract, which a bare dev node does not have; `devnode.sh` installs it.
