# {{name}}

A Stylus (Rust) stablecoin payment-streaming contract, scaffolded with `create-stylus-latest` against `stylus-sdk`
{{stylus_sdk_version}}. Money flows to the recipient every second instead of in one lump: payroll, vesting, grants,
or an agent paying another agent for ongoing work, in USDC or Paxos USDG.

## Contract

`Stream` pays out one ERC-20 chosen at deploy time:

- a **constructor** `(token)` fixes the token atomically, so nobody can race you to set a different one
- `create(recipient, amount, start, stop)` locks the caller's tokens (call `approve` on the token first) and returns a
  stream id. `start` is a unix timestamp that may be now or later, `stop` must be after it
- `streamed(id)` is what the recipient has earned so far: zero before `start`, linear until `stop`, then the full
  deposit. Rounding is down, and the final second always completes the exact deposit, so no dust is left behind
- `withdraw(id)` pays out everything earned and not yet withdrawn. Anyone can call it (a keeper, the sender, an agent)
  but the tokens always go to the recipient, so calling it is harmless
- `cancel(id)` is for the sender or the recipient: the recipient receives what is earned and not yet withdrawn, and the
  sender gets the rest back. Cancelling before `start` refunds everything. A cancelled stream is final
- `stream(id)`, `withdrawable(id)`, `streamCount()`, `token()` for reads. State is `1` active, `2` cancelled
- if the token refuses one of `cancel`'s two payments (USDC, for example, can block an address), that share is held for its
  owner instead of reverting the whole cancel: `claimable(who)` shows it and `claim()` pays it once the token allows. Without
  this, a blocked recipient could stop the sender from ever recovering the unvested remainder

State is updated before the external token call, `create` rejects deposits whose `amount * duration` would overflow, and a
failed or false-returning transfer reverts the whole call.

Not audited, and deliberately small: fee-on-transfer and rebasing tokens are not handled, streams cannot be topped up
or transferred, and either side can cancel at any time. Decide those before holding real funds.

## Use it from an AI agent

The stream contract is easy for a program to call: every intent is one function with a plain result, and the contract can
tell you what will happen before you commit (`previewCancel`). `--with-client` adds a ready-made, JSON-in/JSON-out agent
interface in `client/src`:

```bash
cd client && npm install
npx tsx --env-file=../.env src/agent-cli.ts --tools          # the tool schemas, ready to give to an LLM
npx tsx --env-file=../.env src/agent-cli.ts '{"intent":"open_stream","recipient":"0x...","amount":"1000000","durationSeconds":3600}'
npx tsx --env-file=../.env src/agent-cli.ts '{"intent":"get_stream","id":"1"}'
npx tsx --env-file=../.env src/agent-example.ts               # a runnable example agent
```

Six intents: `open_stream`, `get_stream`, `withdraw_from_stream`, `preview_cancel_stream`, `cancel_stream`, `claim_held_payment`
(collect a cancel payout the token refused at the time; `{"checkOnly":true}` only reads it). Amounts are decimal
strings, never floats: `amount` in the token's base units, or `amountTokens` in whole tokens (`"25"` is 25 USDG), which
the agent converts exactly with the token's own `decimals()` and refuses if it has more decimal places than the token.
Results show both (`amountTokens: "25 USDG"`). Every call prints one JSON object, `{ "ok": true, ... }` or
`{ "ok": false, "error": { "code": "NotAuthorized", "message": "...", "hint": "..." } }`, where `code` is the contract's own custom
error name, so an agent can branch on it.

**Limit what an agent can spend.** Set these in `../.env`; they are enforced before anything is signed:
`AGENT_MAX_AMOUNT` (largest single amount, base units) and `AGENT_ALLOWED_COUNTERPARTIES` (comma-separated addresses it may pay).
Use a dedicated key holding only what the agent may spend, never your main wallet. `GAS_LIMIT` skips gas estimation, which is
only useful on an idle local dev node (errors then lose their contract error name).

## Develop

```bash
cargo test                       # unit tests plus a model-based property test with a token-movement ledger
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

Scaffolded with `--usdg`? The token is already in `.env` as `TOKEN_ADDRESS` (Paxos USDG on Arbitrum One and Robinhood
Chain; on testnets, where Paxos publishes none, put a stand-in ERC-20 there), so deploy with
`./scripts/deploy.sh -- env:TOKEN_ADDRESS`. USDG has 6 decimals: 1 USDG = `1000000`. On a mainnet `deploy.sh` also
needs `MAINNET=1`; these templates are unaudited, so start on a testnet.

### Deploy locally first

```bash
cp .env.example .env     # a throwaway PRIVATE_KEY is fine; the dev node funds it
./scripts/devnode.sh     # needs Docker and Node: starts a dev node, funds your key, installs the Stylus deployer
RPC_URL=http://127.0.0.1:8547 ./scripts/deploy.sh -- 0xTokenAddress
docker rm -f stylus-devnode
```

Constructor deploys need that deployer contract, which a bare dev node does not have; `devnode.sh` installs it.
