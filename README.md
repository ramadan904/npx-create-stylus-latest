# create-stylus-latest

Scaffold an [Arbitrum Stylus](https://docs.arbitrum.io/stylus/gentle-introduction) (Rust) smart contract project in
one command, **always pinned to the newest `stylus-sdk`**.

Built for the Arbitrum Open House Singapore Online Buildathon.

```bash
npx create-stylus-latest my-app            # prompts for a template
npx create-stylus-latest my-token -t erc20 # skip the prompt
```

## Why "latest"

Stylus templates go stale quickly: SDK APIs and the `alloy` version they depend on change between releases, and a
mismatched pair fails to compile. At scaffold time this CLI reads the [crates.io sparse index](https://index.crates.io),
picks the newest stable `stylus-sdk`, and pins the exact `alloy-primitives` / `alloy-sol-types` version that release
requires. If you are offline it falls back to a bundled known-good pair (`--offline` forces this).

Every template is built, tested and validated with `cargo stylus check` against a local Nitro dev node in CI, using live crates.io versions, so a broken release shows up as a red
build here rather than in your project.

## Templates

| Name | What you get |
| --- | --- |
| `counter` | Minimal storage contract with unit tests. Best first step. |
| `erc20` | ERC-20 token with events, custom Solidity errors and tests. |
| `vault` | Stablecoin vault for any ERC-20 (USDC, USDG): deposits and withdrawals through cross-contract calls, with mocked-token tests. |

## What you get in the generated project

- `src/lib.rs` contract plus `src/main.rs` ABI-export entry point
- Unit tests that run with plain `cargo test` (the SDK's `TestVM`, no node needed)
- `scripts/export-abi.sh` to print the Solidity interface
- `scripts/deploy.sh` to validate and deploy with `cargo-stylus` (key passed via a private temp file, not argv)
- `Stylus.toml` and a pinned `rust-toolchain.toml` (1.91.0 + wasm target) matching `cargo stylus new`, `.env.example` defaulting to Arbitrum Sepolia, `.gitignore`

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

## Options

```
-t, --template <name>  counter | erc20 | vault (default: counter)
-y, --yes              Skip prompts and use defaults
    --no-git           Do not run git init
    --with-client      Also generate a TypeScript (viem) client in client/
    --offline          Use bundled known-good versions instead of querying crates.io
-l, --list             List templates
```

The CLI checks for `cargo`, the `wasm32-unknown-unknown` target and `cargo-stylus`, and prints the install command for
anything missing. It never installs anything for you.

## Deploying from GitHub Actions

`.github/workflows/deploy.yml` is a manual workflow that scaffolds a template and deploys it to Arbitrum Sepolia.
Add a repository secret `DEPLOYER_PRIVATE_KEY` (a funded throwaway testnet key), then run **Actions → Deploy to
Arbitrum Sepolia → Run workflow**. The key stays in GitHub's secret store. If the public RPC rejects the activation check
(see each template's README), add an `RPC_URL` secret with a provider endpoint. Manual workflows only appear in the
Actions tab once the file is on the default branch.

## Develop

```bash
npm test   # unit tests for version resolution, naming and scaffolding (no network)
```

Zero runtime dependencies. Requires Node 18.17+.

## License

MIT
