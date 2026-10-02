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
- **Five templates.** `counter` (minimal), `erc20` (events, custom errors), `vault` (a stablecoin vault using
  cross-contract ERC-20 calls), `escrow` (buyer-funded deals with an optional arbiter and a deadline refund) and `stream`
  (linear per-second stablecoin payments with keeper-friendly `withdraw` and a `cancel` that splits earned from remaining).
- **Agent-native money contracts.** `stream` and `escrow` can tell a caller what will happen before it commits
  (`previewCancel`, `canRelease`, `canRefund`), and `--with-client` adds a JSON-in/JSON-out interface for AI agents: tool
  schemas an LLM can be given, results like `{ ok: false, error: { code: "NotAuthorized", hint } }` using the contract's own
  error names, and spending limits the operator sets in the environment, enforced before anything is signed.
- **A local dev node that really deploys.** `scripts/devnode.sh` also funds your key and installs the Stylus deployer that
  constructor deploys need, so every template, constructor included, deploys locally for free.
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

### Tests that check the money, not just the state

Money-moving templates (`vault`, `escrow`, `stream`) record every token movement in a test-only ledger, and their model-based
property tests assert each movement and the contract's token balance against a reference model. We added this after finding
that a mutated refund amount passed every test: the Stylus test VM answers any call it has no exact mock for with success, so
mocks alone cannot prove an amount is right. Breaking the payout amount, recipient or source on purpose now fails the tests in
all three templates (stream 6 of 6 mutations caught, escrow 3 of 3 plus 2 of 2 on the permission views, vault 3 of 3).

### Real tokens, end to end (measured in CI)

The `e2e-flows` job deploys the real `erc20` template as the token plus `stream` and `escrow` on a local Nitro node and moves real
tokens through approve, transferFrom and transfer, asserting exact balances: 40 checks passed
(run: https://github.com/ramadan904/npx-create-stylus-latest/actions/runs/36989741978). It covers a partial mid-stream payout
(450 of 1000 at 18 s of a 40 s stream, exactly), a cancel split, a finished stream paying the exact deposit with no rounding dust,
a failed `create` leaving no trace, and every escrow path (release, seller refund, buyer refund only after the deadline, arbiter),
with unauthorized and repeated calls rejected. A second step, `e2e/agent.mjs`, drives the generated agent CLIs as subprocesses.
This job found two real problems before any user did: constructor deploys cannot work on a bare dev node (now fixed in the
shipped `devnode.sh`), and gas estimation on an idle node simulates against a stale block.

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

## Security model and limitations

These are templates and a scaffolder, not audited products. Read this before putting real funds in anything generated.

- **Not audited.** No external review of any template. The tests are strong (see above) but tests are not an audit.
- **No admin keys.** `vault`, `escrow` and `stream` have no owner, no pause and no upgrade path; the token is fixed at deploy by a
  constructor. A mistake cannot be patched, which is the point and also the risk.
- **Order of operations.** State is updated before any external token call (checks-effects-interactions), and a failed or
  false-returning transfer reverts the whole call. We have not reviewed behaviour against a malicious or reentrant token.
- **Tokens we do not support.** Fee-on-transfer and rebasing tokens would break the accounting.
- **Blacklisting can strand funds in `stream`.** `cancel` pays the recipient first, then the sender. If the token blacklists the
  recipient (USDC can), every `cancel` reverts and the sender's unvested remainder cannot be recovered. `escrow` is safer here
  because the deadline refund and the arbiter pay the buyer, not the seller. A pull-payment design would fix `stream`.
- **Time.** Deadlines and stream schedules use the block timestamp, which a sequencer can skew slightly. Fine for
  minutes-to-days schedules, not for second-exact settlement.
- **Trust in the arbiter.** Where one is set, it can settle a dispute either way. Pass the zero address for none.
- **The agent limits are client-side.** `AGENT_MAX_AMOUNT` and `AGENT_ALLOWED_COUNTERPARTIES` are enforced by the agent
  interface before signing, so they stop a model from overspending but not an attacker who already holds the key. Give an agent
  a dedicated key that holds only what it may spend. On-chain limits would need a smart account with a spending policy.
- **The dev node setup is local-only.** It uses a publicly documented dev-chain key and vendored helper bytecode; never use it
  for a real network.
- **What the live deployments prove.** The Arbitrum Sepolia and Robinhood testnet deployments exercised construction and
  reads, not live deals; the money flows are proven on a local node in CI (above).
- **Not yet on npm.** The package is publish-ready (see `RELEASING.md`) but has not been published.

## Tech

Stylus (Rust, `stylus-sdk` 0.10.x, Solidity-ABI compatible), Node 18+ zero-dependency CLI, TypeScript/viem client,
GitHub Actions, Nitro dev node. Deployed on Arbitrum Sepolia and Robinhood Chain testnet.

## Why we win, criterion by criterion

- **Smart contract quality.** Five contracts with custom Solidity errors, checks-effects-interactions ordering, and constructor
  initialization (nobody can front-run a public `init`). Each ships unit tests plus a model-based property test that checks
  every token movement against a reference model, and the tests are themselves tested: deliberately breaking the contracts
  fails them. The money flows run against a real ERC-20 in CI (40 checks). Limit: unaudited, and `stream` has the blacklist
  edge case listed above.
- **Product-market fit.** The users are Stylus builders, and the pain is real and measured: we hit every deploy pitfall on a real
  network and the scripts now handle them (Docker default, RPC refusal, gas-cap race, constructor deploys on a local node). The
  agent-native contracts target the Promising Products track: an agent can open a stream or an escrow deal, and ask the
  contract what is allowed before it sends. Limit: no adoption measured yet and the npm package is not published.
- **Innovation.** The newest compatible SDK is resolved at scaffold time; "does it deploy" is a CI test, not a README promise;
  money contracts that expose a preview/permission view sharing their own logic so an agent cannot be surprised; and a test
  design that proves token amounts are right when the framework's mocks cannot.
- **Real problem solving.** Problems found by running the real tooling, each fixed and covered by CI: a Docker default that
  cannot read a key, a public RPC that refuses activation checks, a base-fee race, a bare dev node that cannot deploy
  constructor contracts, and a test VM that hides wrong amounts. A reviewer can re-run all of it from `.github/workflows/ci.yml`.

## Live evidence index

- Latest all-green CI run, including real-token flows and a real local deploy of every template:
  https://github.com/ramadan904/npx-create-stylus-latest/actions/runs/36991267896
- Real-token end-to-end flows (40 checks): https://github.com/ramadan904/npx-create-stylus-latest/actions/runs/36989741978
- Arbitrum Sepolia: escrow `0x5c3766164e3a2d4abb61f605879c18234b36a60e`, stream `0xa97f7f79dd79b6c72c8daa452f68baf1ca7bade5`
  (details in the Evidence section above).

## Roadmap

1. Publish to npm so `npx create-stylus-latest` works anywhere. The package, a smoke test of the packed tarball (every template, run
   with `npx` from an empty directory) and an automated publish-on-tag workflow with provenance are in place
   (`RELEASING.md`); the first release needs an npm token added as the `NPM_TOKEN` secret and a version tag pushed.
2. `--usdg` and `--robinhood` presets with verified Paxos USDG addresses (needs the addresses confirmed from the issuer's docs).
3. A Foundry interop template (Solidity test calling a Stylus contract).
4. `cargo stylus verify` support with a Docker-friendly key path.

## Try it

```bash
git clone https://github.com/ramadan904/npx-create-stylus-latest
cd npx-create-stylus-latest
node bin/create-stylus-latest.js my-app -t counter --with-client
cd my-app && cargo test
```
