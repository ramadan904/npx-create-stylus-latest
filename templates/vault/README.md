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

## Use it from an AI agent

`--with-client` adds a ready-made, JSON-in/JSON-out agent interface in `client/src`, so an AI agent can park funds in the
vault and take them back:

```bash
cd client && npm install
npx tsx --env-file=../.env src/agent-cli.ts --tools          # the tool schemas, ready to give to an LLM
npx tsx --env-file=../.env src/agent-cli.ts '{"intent":"deposit_to_vault","amountTokens":"10"}'
npx tsx --env-file=../.env src/agent-cli.ts '{"intent":"withdraw_from_vault","all":true}'
npx tsx --env-file=../.env src/agent-example.ts              # a runnable example agent
```

Three intents: `get_vault`, `deposit_to_vault`, `withdraw_from_vault` (an amount, or `all: true`). Amounts are decimal
strings, never floats: `amount` in the token's base units, or `amountTokens` in whole tokens (`"10"` is 10 USDG), which
the agent converts exactly with the token's own `decimals()`. A deposit approves exactly what it moves, never an
unlimited allowance. Withdrawing more than the agent deposited comes back as
`{ "ok": false, "error": { "code": "InsufficientDeposit", "details": { "have": ..., "want": ... }, "hint": ... } }` before any
transaction is sent. `AGENT_MAX_AMOUNT` in `../.env` caps a single deposit; use a dedicated key holding only what the
agent may spend.

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
./scripts/deploy.sh -- 0xTokenAddress
```

Scaffolded with `--usdg`? The token is already in `.env` as `TOKEN_ADDRESS` (Paxos USDG on Arbitrum One and Robinhood
Chain; on testnets, where Paxos publishes none, put a stand-in ERC-20 there), so deploy with
`./scripts/deploy.sh -- env:TOKEN_ADDRESS`. USDG has 6 decimals: 1 USDG = `1000000`. On a mainnet `deploy.sh` also
needs `MAINNET=1`; these templates are unaudited, so start on a testnet.

Deploy it pointed at a token (the constructor argument goes after `--`):

```bash
./scripts/deploy.sh -- 0xTokenAddress
```

Then use it, for example with Foundry's `cast`:

```bash
cast send <TOKEN> "approve(address,uint256)" <VAULT> 1000000 --rpc-url $RPC_URL --private-key $PRIVATE_KEY
cast send <VAULT> "deposit(uint256)" 1000000 --rpc-url $RPC_URL --private-key $PRIVATE_KEY
```

### Deploy locally first

```bash
cp .env.example .env     # a throwaway PRIVATE_KEY is fine; the dev node funds it
./scripts/devnode.sh     # needs Docker and Node: starts a dev node, funds your key, installs the Stylus deployer
RPC_URL=http://127.0.0.1:8547 ./scripts/deploy.sh -- 0xTokenAddress
docker rm -f stylus-devnode
```

Constructor deploys need that deployer contract, which a bare dev node does not have; `devnode.sh` installs it.
