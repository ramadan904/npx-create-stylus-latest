# create-stylus-latest: Buildathon submission

**Arbitrum Open House Singapore Online Buildathon**

## One line

`npx create-stylus-latest` scaffolds a Stylus (Rust) smart contract project that builds, tests and deploys on the
first try, pinned to the newest `stylus-sdk` and its matching `alloy` version.

## The problem

Stylus lets developers write Arbitrum contracts in Rust, but the first hours are slow. SDK APIs and the `alloy`
version they depend on change between releases, and a mismatched pair does not compile. The official generator
gives one counter example; anything beyond it (a token, a vault, a client) is written from scratch, and the path from
`cargo test` to a live deployment has pitfalls that are not obvious. In this project we hit these on a real deploy:
`cargo stylus deploy` defaulting to a Docker build that cannot read a key file, the public Arbitrum Sepolia RPC
refusing the activation check, and a gas cap that lost a race with the base fee. Each one costs a new builder time
they do not have in a 3-week buildathon.

## The solution

One command produces a working project and a deploy path that has already been run end to end:

- **Always current.** At scaffold time the CLI reads the crates.io sparse index, picks the newest stable `stylus-sdk`
  and pins the exact `alloy-primitives` / `alloy-sol-types` it requires. Offline it falls back to a bundled
  known-good pair.
- **Three templates.** `counter` (minimal), `erc20` (events, custom errors) and `vault` (a USDC/USDG-style vault using
  cross-contract ERC-20 calls, tested with a mocked token).
- **Deploy scripts that work.** `scripts/deploy.sh` validates and deploys with `cargo-stylus`, handles the lockfile,
  the Docker default, RPC override and an optional gas cap. `scripts/devnode.sh` starts a local Nitro dev node so
  everything can be validated without a funded testnet key.
- **Optional TypeScript client.** `--with-client` adds a viem client typed from the contract ABI that fails loudly on
  reverted transactions.
- **Safe by default.** The key is handed to `cargo-stylus` through a private temp file, never argv.

## Evidence (all from CI and the live run)

- Every template is scaffolded with live crates.io versions, then built, unit-tested, built to wasm and validated with
  `cargo stylus check` against a local Nitro dev node in GitHub Actions.
- An end-to-end CI job deploys a generated counter to a dev node with a throwaway key and calls it through the
  generated client.
- A manual workflow deployed the counter to **Arbitrum Sepolia**:
  - Contract: `0x41218640903eab654a555371d51d1c4fcfb28580`
  - https://sepolia.arbiscan.io/address/0x41218640903eab654a555371d51d1c4fcfb28580
  - Deployed and activated (activation tx `0xdd7fb822023b4ef20145786a32d8e8a7407c2b28e9d1b76af92f4c165479e919`).
  - A live `increment()` call through the generated client confirmed with status **Success** in block 314731830:
    https://sepolia.arbiscan.io/tx/0xbc01bc625b064026e62c28eb4b8ff0c6eedb1cfa3544610f6313bc35b506c2a7
    (The client printed a stale `number: 0n` right after, from a lagging RPC node; it now reads at the confirming
    block and checks the receipt status.)
- The `erc20` and `vault` templates were then hardened to initialize through a Stylus `#[constructor]` (so nobody
  can call a public `init()` before the deployer) and deployed to Arbitrum Sepolia with `deploy.sh`:
  - ERC-20 token: `0xe4d2350d1dfd8474053a4d131e94056bdd93bb83`
    (https://sepolia.arbiscan.io/address/0xe4d2350d1dfd8474053a4d131e94056bdd93bb83). Deployed with
    `("Buildathon Token", "BUIDL", 1,000,000e18, deployer)`; the client read back the name, symbol, supply, and a
    deployer balance equal to the full supply, so the mint happened in the deployment itself.
  - Vault: `0xddcf208635bfdce4379a2535f228473310995915`
    (https://sepolia.arbiscan.io/address/0xddcf208635bfdce4379a2535f228473310995915), constructed with the token
    above; the client read back `asset()` equal to that token.
  - Escrow: `0x5c3766164e3a2d4abb61f605879c18234b36a60e`
    (https://sepolia.arbiscan.io/address/0x5c3766164e3a2d4abb61f605879c18234b36a60e), constructed with the token
    above; the client read back `token()` equal to it and zero deals. Only construction and reads were exercised
    on-chain; the deal logic is covered by the unit and property tests, not by a live deal. Run:
    https://github.com/ramadan904/npx-create-stylus-latest/actions/runs/36937262867
  - Stream: `0xa97f7f79dd79b6c72c8daa452f68baf1ca7bade5`
    (https://sepolia.arbiscan.io/address/0xa97f7f79dd79b6c72c8daa452f68baf1ca7bade5), constructed with the token
    above; the client read back `token()` equal to it and zero streams. Only construction and reads were exercised
    on-chain; stream vesting, withdraw and cancel are covered by the unit and property tests, not by a live stream.
    Run: https://github.com/ramadan904/npx-create-stylus-latest/actions/runs/36984521709
  - Superseded: an earlier ERC-20 (`0x45a81630ec980e8517e032d5c069a24011dedba5`) and vault
    (`0xcd542511830dbaec42f753f3b96ed8c8c66dc953`) used a callable `init()` that anyone could have called first.
    They remain on the testnet but are not the recommended design, which is why the templates changed.

### Robinhood Chain testnet (chain id 46630)

The same three templates were then deployed to Robinhood Chain testnet with the same `deploy.sh` and workflow. A
free `check_only` run first confirmed the network accepts Stylus (activation fee estimate returned), and the chain id
was read from the RPC rather than assumed. The constructor deploys work there too (the Stylus deployer helper
contract exists on that chain).

- Counter: `0x41218640903eab654a555371d51d1c4fcfb28580` (the same string as the Arbitrum Sepolia counter because the
  same wallet made its first deployment on both chains; they are separate contracts). A live `increment()` through
  the generated client confirmed in block 127297404. Run: https://github.com/ramadan904/npx-create-stylus-latest/actions/runs/36926997366
- ERC-20: `0xe1f6ff1f3efb2fb92846f97a2e4e017b311245b9`, deployed with `("Buildathon Token", "BUIDL", 1,000,000e18,
  deployer)`; the client read back the name, symbol, supply and a deployer balance equal to the full supply. Run:
  https://github.com/ramadan904/npx-create-stylus-latest/actions/runs/36927685784
- Vault: `0x141ea9d975236de4cb3720115c04440008066de1`, constructed with the ERC-20 above; the client read back
  `asset()` equal to that token and zero deposits. Run: https://github.com/ramadan904/npx-create-stylus-latest/actions/runs/36928180867

No block explorer link is given for this chain; the public deploy runs above show each address and the on-chain read-back.

### Gas benchmark: Stylus vs Solidity (measured in CI)

A `Benchmark` workflow deploys the Stylus counter and a Solidity twin to the same local Nitro node and sends both the
same transactions (run: https://github.com/ramadan904/npx-create-stylus-latest/actions/runs/36935538361). Execution gas
(`gasUsed - gasUsedForL1`, from the raw receipts):

| | Stylus | Solidity |
|---|---|---|
| `increment`, steady state | 55,199 | 26,461 |
| `work(20000)`, a pure compute loop | 58,800 | 1,821,893 |

Both returned the same compute result, which the script enforces. The honest summary: Stylus costs about 2x more on a
storage-only call and is about 31x cheaper on compute, so it is a fit for compute-heavy logic and not a free win
everywhere. The Stylus contract was not cache-bid. Details and caveats: `bench/README.md`.

### Property-based tests that found a real bug

The ERC-20 and vault templates carry proptest suites (random operation sequences checked against a reference model and
supply-conservation invariants). They found that `transfer_from` reduced the allowance before discovering an
overdraft, leaving partial state after a failed call; it now validates everything first. CI runs rustfmt and clippy with
warnings as errors on every generated project.

### `doctor`

`npx create-stylus-latest doctor --rpc <url>` checks the toolchain and asks the RPC (with free read-only calls) whether
it is an Arbitrum chain with Stylus enabled; CI exercises it against the dev node and the public Arbitrum Sepolia
endpoint (which reports Stylus enabled, ArbWasm version 3). It prints only the RPC host, so API keys stay out of logs.

## Tech

Stylus (Rust, `stylus-sdk` 0.10.x, Solidity-ABI compatible), Node 18+ zero-dependency CLI, TypeScript/viem client,
GitHub Actions, Nitro dev node. Deployed on Arbitrum Sepolia.

## Mapping to the judging criteria

- **Smart contract quality:** idiomatic `sol_storage!`/`#[public]` contracts, custom Solidity errors, checks-effects-
  interactions in the vault, unit tests for every template. They are templates, not audited: the vault README says so.
- **Product-market fit:** the users are Stylus builders, including every team in this and later Open House rounds.
  We have not yet measured adoption.
- **Innovation:** resolving the newest compatible SDK at scaffold time, and treating "does it deploy" as a CI test,
  not a README promise.
- **Real problem solving:** the deploy pitfalls above were found by running the real tooling against a real network,
  and the scripts now handle them. Several earlier bugs in our own templates (a missing `Stylus.toml`, a missing
  lockfile) were caught the same way by CI, not by reading docs.

## Roadmap

1. Publish to npm so `npx create-stylus-latest` works anywhere.
2. Add Robinhood Chain and USDG presets once their RPC details are confirmed.
3. A Foundry interop template (Solidity test calling a Stylus contract).
4. `cargo stylus verify` support with a Docker-friendly key path.

## Try it

```bash
git clone https://github.com/ramadan904/npx-create-stylus-latest
cd npx-create-stylus-latest
node bin/create-stylus-latest.js my-app -t counter --with-client
cd my-app && cargo test
```
