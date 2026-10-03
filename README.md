# create-stylus-latest

Scaffold an [Arbitrum Stylus](https://docs.arbitrum.io/stylus/gentle-introduction) (Rust) smart contract project in
one command, **always pinned to the newest `stylus-sdk`**.

Built for the Arbitrum Open House Singapore Online Buildathon. **Live site and playground:** https://npx-create-stylus-latest-web-mocha.vercel.app/
**Demo video (narrated, 2 min 46 s):** [media/demo-narrated.mp4](media/demo-narrated.mp4)

```bash
npm create stylus-latest my-app            # prompts for a template (same as npx create-stylus-latest my-app)
npx create-stylus-latest my-token -t erc20 # skip the prompt
```

Published on npm as [`create-stylus-latest`](https://www.npmjs.com/package/create-stylus-latest), with a provenance statement linking the package to the
commit and workflow that built it ([0.5.0 publish run](https://github.com/ramadan904/npx-create-stylus-latest/actions/runs/37127822293)). New versions publish automatically from a version tag
(see [RELEASING.md](RELEASING.md)).

The templates are tested hard but **not audited**: [SECURITY.md](SECURITY.md) lists what each one does not do yet and a
checklist before mainnet. CI also runs weekly against the newest crates.io releases, so "always latest" stays tested.

### Try it without installing anything

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/ramadan904/npx-create-stylus-latest?quickstart=1)

A browser workspace with everything already set up: the Rust toolchain the templates pin (with the WASM target),
`cargo-stylus`, Node for `npx`, and Docker for the local Nitro dev node. Once it opens, one command scaffolds a contract,
starts a local Arbitrum chain, deploys the contract with a throwaway key and calls it, timing each step:

```bash
.devcontainer/quickstart.sh
```

No wallet, faucet or real funds needed. The first start of the Codespace takes a few minutes. The environment
(`.devcontainer/`) is built in CI by the `Dev container` workflow, which runs this quickstart inside it.

## Why "latest"

Stylus templates go stale quickly: SDK APIs and the `alloy` version they depend on change between releases, and a
mismatched pair fails to compile. At scaffold time this CLI reads the [crates.io sparse index](https://index.crates.io),
picks the newest stable `stylus-sdk`, and pins the exact `alloy-primitives` / `alloy-sol-types` version that release
requires. If you are offline it falls back to a bundled known-good pair (`--offline` forces this).

Every template is built, tested and validated with `cargo stylus check` against a local Nitro dev node in CI, using live crates.io versions, so a broken release shows up as a red
build here rather than in your project.

## How it compares

Not to be confused with `npx create-stylus` (Scaffold-Stylus): a different tool, with a different job.

| | `cargo stylus new` | [Scaffold-Stylus](https://github.com/Arb-Stylus/scaffold-stylus) (`npx create-stylus`) | **create-stylus-latest** |
| --- | --- | --- | --- |
| Focus | The official minimal starter | A full-stack dApp: Next.js frontend, wallet connect, contract hot reload | The contract and its path to a live deploy: payments and AI agents |
| Contracts | A counter | A sample contract; ERC-20, ERC-721 and Chainlink extensions | Nine templates: counter, ERC-20, ERC-721, vault, escrow, stream, Chainlink oracle, Rust-Solidity interop, faucet |
| Tests | Example tests | `yarn stylus:test` | Unit tests plus reference-model property tests; every template deployed to a Nitro node in CI |
| AI agents | – | – | JSON tool interface and an MCP server, with operator spending limits, checked against real contracts in CI |
| Stablecoins and chains | – | Arbitrum Sepolia, mainnet, Orbit | Paxos USDG presets checked on-chain; Arbitrum One, Robinhood Chain and their testnets |
| Frontend | – | Full Next.js app | A generated contract page (`--with-ui`) and a typed TypeScript client (`--with-client`) |

Pick Scaffold-Stylus for a ready-made dApp frontend; pick this when the contract has to move money correctly and an
agent has to drive it. They combine: the contracts here are plain Stylus projects that any frontend can call.

## Templates

| Name | What you get |
| --- | --- |
| `counter` | Minimal storage contract with unit tests. Best first step. |
| `erc20` | ERC-20 token with events, custom Solidity errors and tests. With `--with-client`, an agent can `get_token`, `send_tokens` and `approve_spender` (CLI or MCP): sends to the zero address or the token itself, and anything over the operator's limits, are refused before signing; revoking an allowance is always allowed. |
| `erc721` | ERC-721 NFT with metadata (`tokenURI`), safe transfers that ask a receiving contract, a minter, `burn`, and the standard ERC-6093 errors. Unit tests plus a model-based property test of every mint, approval, transfer and burn. With `--with-client`, an agent can `get_nft`, `mint_nft` and `transfer_nft` (CLI or MCP); a send to a contract that cannot hold NFTs is refused as `ERC721InvalidReceiver` instead of locking the token. |
| `vault` | Stablecoin vault for any ERC-20 (USDC, USDG): deposits and withdrawals through cross-contract calls, with mocked-token tests. |
| `escrow` | Stablecoin escrow for payments between parties or agents: buyer-funded deals, release by buyer or arbiter, refund by seller or arbiter, and a buyer-side refund after a deadline. Unit tests plus a model-based property test. |
| `stream` | Stablecoin payment streams (payroll, vesting, agent subscriptions): linear per-second payouts, keeper-friendly `withdraw`, and `cancel` that splits earned from remaining. Unit tests plus a model-based property test that tracks every token movement. |
| `interop` | Rust and Solidity on one chain: a Stylus math library (`mulDiv` with a 512-bit intermediate, `isqrt`) and a Solidity contract that calls it, catching its custom errors by name. `./scripts/interop.sh` compiles the Solidity (solc-js, no Foundry needed), deploys it and checks every answer and error on a real Nitro node, in CI too. Property tests check each result against its definition. |
| `oracle` | Reads a Chainlink price feed safely: refuses stale, zero, negative or incomplete prices with named errors, and values amounts in USD with both decimals handled. `--network` presets Chainlink's ETH / USD feed (checked on-chain in CI). With `--with-client`, an agent can `get_price`, `value_of` and `amount_for_value` ("how much ETH is $50", rounded up so a payment is never short), and a stale or zero price is refused by name instead of used. Unit tests plus a model-based property test. |
| `faucet` | Rate-limited ERC-20 faucet for testnets and demos: anyone can `drip` once per cooldown, and `availableAt(who)` says when. Lets visitors try your dApp without asking you for tokens. With `--with-client`, an agent can `get_faucet` and `request_tokens` (CLI or MCP), refused early as `TooSoon` or `FaucetEmpty`. Unit tests plus a model-based property test. |

## What you get in the generated project

- `src/lib.rs` contract plus `src/main.rs` ABI-export entry point
- Unit tests that run with plain `cargo test` (the SDK's `TestVM`, no node needed)
- `scripts/export-abi.sh` to print the Solidity interface
- `scripts/deploy.sh` to validate and deploy with `cargo-stylus` (key passed via a private temp file, not argv)
- `scripts/verify.sh` to prove a deployment was built from your source (see below)
- `Stylus.toml` and a pinned `rust-toolchain.toml` (1.91.0 + wasm target) matching `cargo stylus new`, `.env.example` for the network you chose (Arbitrum Sepolia by default), `.gitignore`

## Verifiable deploys

Anyone can check that a contract deployed this way was built from your source:

```bash
VERIFY=1 ./scripts/deploy.sh        # builds and deploys inside cargo-stylus's pinned Docker image
./scripts/verify.sh 0x<deploy tx>   # rebuilds the source there and compares it, byte for byte, with the deployed code
```

`deploy.sh` prints the exact `verify.sh` command after a reproducible deploy.

**Why it needs `VERIFY=1`:** by default `deploy.sh` builds locally (`--no-verify`), which needs no Docker but isn't
reproducible. Such a deployment won't verify: in our test, a local build of the counter came out 15 bytes different
from the reproducible one.

**How the key reaches Docker:** the container sees only the project directory, so with `VERIFY=1` the key is written
to `.stylus-deploy-key` inside the project. It is readable only by you, git-ignored, passed by a relative path, and
deleted when the script exits.

**Exit codes can't be trusted here:** cargo-stylus doesn't pass Docker's exit code on. So `deploy.sh` treats a run with
no reported deployment as a failure, and `verify.sh` decides from cargo-stylus's printed verdict, not its exit status.

**Proven in CI:** the `verify` job deploys reproducibly to a Nitro dev node, verifies, then changes one line of the
source and requires verification to fail.

**On Linux:** the build runs as root inside the container, so `target/` may end up root-owned. Fix it with
`sudo chown -R "$USER" target`.

## Networks and USDG

```bash
npx create-stylus-latest pay -t stream --robinhood                    # Robinhood Chain testnet (chain 46630)
npx create-stylus-latest pay -t escrow --network arbitrum-one --usdg  # Arbitrum One, wired to Paxos USDG
```

`--network` takes `arbitrum-sepolia` (default), `arbitrum-one`, `robinhood-testnet`, `robinhood` or `devnode`, and writes
that chain's `RPC_URL` and `CHAIN_ID` into `.env.example`; `--robinhood` is short for `--network robinhood-testnet`.

`--usdg` (for `vault`, `escrow` and `stream`) puts the token in `.env.example` as `TOKEN_ADDRESS`, and you deploy with
`./scripts/deploy.sh -- env:TOKEN_ADDRESS`. The addresses are Paxos's own
([USDG on main networks](https://docs.paxos.com/guides/stablecoin/usdg/mainnet)):

| Network | Chain id | USDG (6 decimals) |
| --- | --- | --- |
| Arbitrum One | 42161 | `0x004B506865409877C9fA29bfb1ebA929984B9bbC` |
| Robinhood Chain | 4663 | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |

Paxos publishes testnet USDG only on Ethereum Sepolia, Ink Sepolia and X Layer testnet
([USDG on test networks](https://docs.paxos.com/guides/stablecoin/usdg/testnet)), **not on Arbitrum Sepolia or Robinhood
Chain testnet**. On those, `--usdg` leaves `TOKEN_ADDRESS` empty with a note rather than guess: deploy the `erc20`
template as a stand-in dollar, and switch to the real address when you go to mainnet. CI (the `networks` job,
`e2e/verify-networks.mjs`) checks every entry against the chain: the RPC's chain id, and that each USDG address holds a
contract reporting symbol `USDG` and 6 decimals.

`deploy.sh` asks the RPC which chain it is. On a mainnet (Arbitrum One, Nova, Robinhood Chain) it refuses to deploy
unless you set `MAINNET=1`, because these templates are unaudited; `--check-only` is always allowed.

## Optional web page for your contract

`--with-ui` adds `./scripts/ui.sh`: it exports the contract's interface and serves a page on `http://127.0.0.1:5173`
(in a Codespace, the forwarded port) with every function as a form. Reads run on load; writes are simulated first, so a
revert shows the contract's own error by name (`StalePrice(...)`, `ERC721NonexistentToken(...)`) before you sign, then
sent through your browser wallet with the emitted events shown. On the local dev node only, it can also sign with the
throwaway key in `.env`, like a burner wallet; on any other chain the page never sees a key. It reads `.env` on each
load, so after a redeploy update `CONTRACT_ADDRESS` and reload. One HTML file and a small Node server, no build step;
CI drives it in a browser against a deployed counter.

## Optional TypeScript client

`--with-client` adds a `client/` folder with a small [viem](https://viem.sh) script wired to the template's ABI,
so you can call your deployed contract right away:

```bash
npx create-stylus-latest my-app --with-client
# deploy, then put the address in .env as CONTRACT_ADDRESS
cd my-app/client && npm install && npm start
```

It defaults to Arbitrum Sepolia and reads `RPC_URL`, `CONTRACT_ADDRESS` and `PRIVATE_KEY` from the project's `.env`.
CI type-checks the generated client for every template, and a unit test fails if the client's ABI lists a function
the contract does not define.

### Use the contract from Claude, Cursor or any MCP client

For every template, the client also includes an MCP server (`src/agent-mcp.ts`). It serves the same tools as the agent CLI,
so an assistant can send tokens or NFTs, price a payment, do exact 256-bit math in Rust, open, read and cancel streams, or
use the escrow or vault, by itself:

```bash
cd my-app/client && npm install
npx tsx src/agent-mcp.ts --config   # prints `claude mcp add ...` and the JSON for Claude Desktop, Cursor or .mcp.json
```

Every call goes through the same code as the CLI:

- The operator's limits in `.env` (`AGENT_MAX_AMOUNT`, `AGENT_ALLOWED_COUNTERPARTIES`) are enforced before anything is
  signed.
- Errors arrive by the contract's own names, with a hint.

It speaks MCP over stdio with no extra dependencies. CI drives it with the official MCP SDK client: it checks the tools
match the CLI's, opens and cancels a real stream on a Nitro node, refuses an amount over the limit with the CLI's exact
JSON, sends, approves and revokes the real ERC-20 with exact balances checked, mints and transfers an NFT (refusing a contract that
cannot hold it), refuses to wrap the counter past 2^256 - 1, gets exact `mulDiv` results and named errors from the Rust
library, prices amounts through the oracle against a
feed it then makes stale, zero and incomplete (each refused by name), and returns the contract's errors by name.

## Options

```
-t, --template <name>  counter | erc20 | erc721 | vault | escrow | stream | interop | oracle | faucet (default: counter)
-y, --yes              Skip prompts and use defaults
    --no-git           Do not run git init
    --with-client      Also generate a TypeScript (viem) client in client/
    --offline          Use bundled known-good versions instead of querying crates.io
    --rpc <url>        With `doctor`: probe this endpoint (default: $RPC_URL)
-l, --list             List templates
```

### `doctor`

```bash
npx create-stylus-latest doctor --rpc "$RPC_URL"
```

Checks Node, `cargo`, the wasm target and `cargo-stylus` (against the newest `stylus-sdk`), then asks the RPC whether it
is an Arbitrum chain with Stylus enabled (it reads the `ArbSys` and `ArbWasm` system contracts; nothing is sent or
spent). Exits non-zero if something required is missing. Only the RPC host is printed, never the path, so API keys stay
out of logs. For public `arbitrum.io` endpoints it adds an advisory note: during our own deploy the public Sepolia RPC refused
cargo-stylus's activation check, which `doctor` cannot detect ahead of time (a provider RPC or the dev node worked).

The CLI checks for `cargo`, the `wasm32-unknown-unknown` target and `cargo-stylus`, and prints the install command for
anything missing. It never installs anything for you.

## Deploying from GitHub Actions

`.github/workflows/deploy.yml` is a manual workflow that scaffolds a template and deploys it to Arbitrum Sepolia.
Add a repository secret `DEPLOYER_PRIVATE_KEY` (a funded throwaway testnet key), then run **Actions → Deploy to
Arbitrum Sepolia → Run workflow**. The key stays in GitHub's secret store. If the public RPC rejects the activation check
(see each template's README), add an `RPC_URL` secret with a provider endpoint. Manual workflows only appear in the
Actions tab once the file is on the default branch.

The workflow also has a **network** choice (`arbitrum-sepolia` or `robinhood-testnet`; the latter needs a
`ROBINHOOD_RPC_URL` secret holding an Alchemy URL for Robinhood Chain testnet) and a **check_only** switch that
validates the contract against the network without deploying or spending gas. The chain id is read from the RPC, and
the run stops if it contradicts the `chain_id` input.

## Robinhood Chain testnet

Robinhood Chain testnet (chain id 46630) accepts Stylus contracts, including constructor deploys. The deploy workflow's
**network** input can target it: add a repository secret `ROBINHOOD_RPC_URL` (an Alchemy URL for the testnet, never the
mainnet one), run with `check_only` first to validate for free, then deploy. The chain id is read from the RPC.

## Develop

```bash
npm test   # unit tests for version resolution, naming and scaffolding (no network)
```

Zero runtime dependencies. Requires Node 18.17+.

## License

MIT
