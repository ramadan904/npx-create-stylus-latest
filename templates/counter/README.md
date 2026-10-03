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

## Validate and deploy without a testnet

Public RPC endpoints may refuse the activation check (we saw `stylus activations not allowed for this request` from
the public Arbitrum Sepolia RPC). A local Nitro dev node accepts it and needs Docker:

```bash
cp .env.example .env                    # a throwaway PRIVATE_KEY is fine; the dev node funds it
./scripts/devnode.sh                    # starts the node, funds your key, installs the Stylus deployer (needs Node)
RPC_URL=http://127.0.0.1:8547 ./scripts/deploy.sh --check-only
RPC_URL=http://127.0.0.1:8547 ./scripts/deploy.sh      # a real deploy, for free
docker rm -f stylus-devnode             # when done
```

## Let an AI agent use it

`--with-client` also adds a JSON-in/JSON-out agent interface and an MCP server (Claude Desktop, Claude Code, Cursor):

```bash
cd client && npm install
npx tsx --env-file=../.env src/agent-cli.ts '{"intent":"increment"}'
npx tsx src/agent-mcp.ts --config      # prints the MCP setup, with absolute paths
```

The tools are `get_number`, `increment`, `add_number` and `set_number`. A change that would overflow 256 bits is refused
before signing. Every other template has the same interface, with tools for its own contract.
