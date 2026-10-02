# Welcome to create-stylus-latest

This Codespace has everything a Stylus project needs: the Rust toolchain the templates pin (with the WASM target),
`cargo-stylus`, Node for `npx` and the TypeScript clients, and Docker for a local Arbitrum Nitro dev node.

## One command: deploy and call a Stylus contract

Open a terminal (<kbd>Ctrl</kbd>+<kbd>`</kbd>) and run:

```bash
.devcontainer/quickstart.sh
```

It scaffolds a contract, starts a local Arbitrum chain, deploys the contract there with a throwaway key, calls it, and
tells you how long that took. No wallet, no faucet, no real funds. CI runs this exact script inside this container.

## Or step by step

```bash
npx create-stylus-latest my-app -t stream --with-client   # counter, erc20, vault, escrow, stream, faucet
cd my-app
cargo test                                                # unit and property tests
cp .env.example .env                                      # set PRIVATE_KEY to a throwaway key (any 0x + 64 hex)
./scripts/devnode.sh                                      # local Nitro node; funds that key, ready for constructors
./scripts/deploy.sh -- 0xYourTokenAddress                 # the stream takes its token as a constructor argument
```

The stream, escrow and vault clients include a JSON tool interface for AI agents:
`cd client && npx tsx --env-file=../.env src/agent-cli.ts --tools`.

## Links

- Live site, with a playground and a live AI-agent demo on Arbitrum Sepolia: https://npx-create-stylus-latest-web-mocha.vercel.app/
- npm: https://www.npmjs.com/package/create-stylus-latest
- Full docs: [README.md](../README.md)
