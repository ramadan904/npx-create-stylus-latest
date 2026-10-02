# create-stylus-latest: Buildathon submission

**Arbitrum Open House Singapore Online Buildathon**

| | |
|---|---|
| **Live site** | https://npx-create-stylus-latest-web-mocha.vercel.app/ (the playground, and a live AI-agent demo you run with your wallet) |
| **npm** | https://www.npmjs.com/package/create-stylus-latest: `npx create-stylus-latest my-app`. Published from CI with provenance ([run](https://github.com/ramadan904/npx-create-stylus-latest/actions/runs/37043469397)) |
| **Latest CI** | All 13 jobs green: [main](https://github.com/ramadan904/npx-create-stylus-latest/actions/runs/37056631397), and [with the live agent demo](https://github.com/ramadan904/npx-create-stylus-latest/actions/runs/37059195125) (29/29 browser checks against the agent CLI). [All runs](https://github.com/ramadan904/npx-create-stylus-latest/actions/workflows/ci.yml) |
| **Zero install** | [Open in Codespaces](https://codespaces.new/ramadan904/npx-create-stylus-latest?quickstart=1), then `.devcontainer/quickstart.sh`: a Stylus contract deployed and called on a local Arbitrum chain in 105 s, measured inside that container in CI ([run](https://github.com/ramadan904/npx-create-stylus-latest/actions/runs/37061245097)) |
| **Source** | https://github.com/ramadan904/npx-create-stylus-latest |

## Why we win

Each claim links to its proof, with the limit after it.

**1. Smart contract quality: seven contracts checked against a reference model, all eight run on real nodes.**
- `counter`, `erc20`, `erc721`, `vault`, `escrow`, `stream`, `oracle` and `faucet` use custom Solidity errors, checks-effects-interactions,
  and `#[constructor]` initialization where they have state to set, so nobody can front-run an `init`.
- All but the counter have unit tests plus a property test against a reference model (every token movement for the
  six that move tokens; every answer, age and decimals for the Chainlink oracle) (the stream: 15 tests). The tests are tested: deliberately broken contracts fail them. They also found a real
  bug: a failed `transfer_from` left partial state behind (see below).
- Every template is formatted, linted, tested, built to WASM and deployed to a Nitro dev node on every change. The
  cross-contract money flows run against a real ERC-20 in CI.
- The stream survives a token that blocks an address: a refused payout is held for `claim`, so a blocked recipient
  cannot strand the sender's refund.
- *Limit:* not audited.

**2. Product-market fit: the user is every new Stylus builder, and the hard first hour is gone.**
- One command (`npx create-stylus-latest`) gives a project pinned to the newest compatible `stylus-sdk` and `alloy`,
  with deploy scripts that have been run on Arbitrum Sepolia.
- A one-click Codespace deploys and calls a contract on a local Arbitrum chain in 105 s, with no wallet, faucet or install.
- Presets go straight to production stablecoins: `--usdg --network arbitrum-one|robinhood` wires Paxos USDG, with
  addresses checked on-chain in CI. Robinhood Chain and its testnet are first-class networks.
- *Limit:* published on 2026-10-02, so no adoption data yet.

**3. Innovation: contracts and tooling built for AI agents, proven rather than promised.**
- `--with-client` adds a JSON tool interface: schemas an LLM can be handed, results using the contract's own error
  names, whole-token amounts converted with the token's decimals, and operator spending limits enforced before signing.
- The contracts answer "what would happen" before an agent commits (`previewCancel`, `canRelease`, `canRefund`), using
  the same logic as the real call.
- 98 agent checks run the CLI against real contracts on every change.
- On the site, a visitor's own wallet runs the agent's `open_stream` → `withdraw_from_stream` → `cancel_stream` on
  Arbitrum Sepolia. CI holds that page to the CLI: same fields, and byte-for-byte the same JSON for the same calls.
- *Limit:* the agent is the interface plus scripted intents; there is no hosted LLM.

**4. Real problem solving: every fix came from running the real tools, and CI keeps it fixed.**
Each of these broke a real deploy, and each is now handled by the generated scripts and covered by CI:
- `cargo stylus deploy` defaulting to a Docker build that cannot read the key;
- the public Arbitrum Sepolia RPC refusing the activation check;
- a gas cap that lost a race with the base fee;
- a bare dev node that cannot deploy constructor contracts;
- a test VM that hides wrong token amounts.

The gas comparison is measured, not claimed, and reported honestly: Stylus pays about 2× on plain storage calls and
about 31× less on compute ([run](https://github.com/ramadan904/npx-create-stylus-latest/actions/runs/36935538361)).
*Limit:* fixes were found on one team's deploys; more pitfalls will surface with more users.

## How it compares to the existing tools

- **`cargo stylus new`** (official): one counter contract. create-stylus-latest adds seven more templates, deploy scripts
  proven on live networks, a local dev node that can deploy constructors, and CI that deploys every template.
- **[Scaffold-Stylus](https://github.com/Arb-Stylus/scaffold-stylus)** (`npx create-stylus`, a different tool despite
  the similar name): a full-stack dApp kit with a Next.js frontend and contract hot reload. create-stylus-latest is
  contract-first instead: money contracts (vault, escrow, stream, faucet, ERC-20, ERC-721) and a Chainlink oracle with
  reference-model property tests, an AI-agent interface with operator spending limits, and USDG / Robinhood Chain presets checked on-chain. It
  does not generate a frontend; its typed client works with any. The two are complementary.
- None of the code here comes from either project.

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
- **Eight templates.** `counter` (minimal), `erc20` (events, custom errors), `erc721` (NFT with metadata, receiver-checked safe
  transfers and the standard ERC-6093 errors), `oracle` (a Chainlink price-feed consumer that refuses stale or bad
  prices; `--network` presets the ETH / USD feed, checked on-chain in CI), `vault` (a stablecoin vault using
  cross-contract ERC-20 calls), `escrow` (buyer-funded deals with an optional arbiter and a deadline refund), `stream`
  (linear per-second stablecoin payments with keeper-friendly `withdraw` and a `cancel` that splits earned from remaining)
  and `faucet` (rate-limited test-token drips, so visitors can try a dApp without asking for tokens).
- **USDG and Robinhood Chain presets.** `--network arbitrum-one|robinhood|arbitrum-sepolia|robinhood-testnet|devnode`
  (`--robinhood` for short) writes the chain into `.env.example`, and `--usdg` wires `vault`, `escrow` and `stream` to
  Paxos USDG (`./scripts/deploy.sh -- env:TOKEN_ADDRESS`). The addresses are Paxos's own and CI checks them on-chain
  (contract present, symbol `USDG`, 6 decimals). Paxos lists no USDG on Arbitrum Sepolia or Robinhood testnet, so there
  the project says so and asks for a stand-in instead of guessing. `deploy.sh` asks the RPC which chain it is and
  refuses a mainnet deploy without `MAINNET=1`.
- **Agent-native money contracts.** `stream` and `escrow` can tell a caller what will happen before it commits
  (`previewCancel`, `canRelease`, `canRefund`), and for them and `vault` `--with-client` adds a JSON-in/JSON-out interface for AI agents: tool
  schemas an LLM can be given, results like `{ ok: false, error: { code: "NotAuthorized", hint } }` using the contract's own
  error names, amounts in base units or in whole tokens (`"amountTokens": "25"`, converted exactly with the token's
  own decimals, so a model never does 6-vs-18-decimal arithmetic), spending limits the operator sets in the
  environment, enforced before anything is signed, and a
  `claim_held_payment` intent for a cancel payout the token refused (a blocked address) and the stream now holds instead.
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
  - Current versions, redeployed from this branch with the same token: stream `0x8f318a966bbc75bca53d9251e86ae8b97d578712`
    (https://sepolia.arbiscan.io/address/0x8f318a966bbc75bca53d9251e86ae8b97d578712; with `previewCancel`, `claim` and
    `claimable`; run https://github.com/ramadan904/npx-create-stylus-latest/actions/runs/37020525139) and escrow
    `0x91336c54f5df938fdd1ac36d0ce08bc1f6e327bb` (https://sepolia.arbiscan.io/address/0x91336c54f5df938fdd1ac36d0ce08bc1f6e327bb;
    with `canRelease` / `canRefund`; run https://github.com/ramadan904/npx-create-stylus-latest/actions/runs/37024243460).
    In both, the client read back `token()` equal to BUIDL and zero streams / deals. The playground uses this pair.
  - Faucet: `0x05bdd4d122896a638f7ff41ed58c7d90a84142d8`
    (https://sepolia.arbiscan.io/address/0x05bdd4d122896a638f7ff41ed58c7d90a84142d8), the `faucet` template constructed with
    the token above, 100 BUIDL per drip and a one-hour cooldown, then stocked with 500,000 BUIDL in the same run (block
    314972034); the client read back the configuration. It is what lets anyone use the playground. Run:
    https://github.com/ramadan904/npx-create-stylus-latest/actions/runs/37002745266
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
with unauthorized and repeated calls rejected. A second step, `e2e/agent.mjs`, drives the generated agent CLIs as subprocesses, the way a tool-using AI agent would: 98 checks
passed across stream, escrow and vault (run: https://github.com/ramadan904/npx-create-stylus-latest/actions/runs/37021498649). An agent opens a stream, reads it,
withdraws a partial amount and cancels, with paid + paid-on-cancel + refunded equal to the deposit exactly; spending limits, an
unknown counterparty, an amount above the balance and a malformed address are all refused before anything is signed; a second
cancel comes back as the contract's own error name (`NotActive`) with a hint; nothing is reported held after a normal cancel and
an empty `claim_held_payment` fails with `NothingToClaim`; amounts given in whole tokens (`amountTokens`) convert exactly
with the token's own decimals, and too many decimal places is refused rather than rounded; and for escrow, `canRelease` / `canRefund` correctly
predict that an early buyer refund fails with `NotAuthorized` before the agent releases the deal. For the vault, an agent
deposits exactly 900 base units (given in whole tokens), is refused an overdraw with the numbers, withdraws part, then
`all: true` returns exactly the rest, leaving the vault empty and the agent whole.
This job found three real problems before any user did: constructor deploys cannot work on a bare dev node (now fixed in the
shipped `devnode.sh`), gas estimation on an idle node simulates against a stale block, and a plain gas estimate can be too low
for `cancel`, whose work depends on how much is owed by the block it lands in (the agent kit now doubles the estimate; only gas
actually used is charged).

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
- **Blocked addresses (fixed in the `stream` template).** A token that blocks an address (USDC can) used to make every
  `stream.cancel` revert, stranding the sender's unvested remainder. Now a refused payout is held for that party to `claim()`
  later and the cancel completes; unit and property tests cover it and breaking it fails them. The first `stream` deployed on Arbitrum
  Sepolia predates this fix; the redeployed one (`0x8f318a96…`) has it. `withdraw` to a blocked recipient still reverts (nothing is lost; the stream keeps running), and
  `escrow` was never affected because its deadline refund and the arbiter pay the buyer.
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
- **No testnet USDG on Arbitrum or Robinhood.** Paxos publishes testnet USDG only on Ethereum Sepolia, Ink Sepolia and X
  Layer testnet, so a testnet build uses a stand-in token; the mainnet USDG addresses are real money behind the
  `MAINNET=1` guard.

## Tech

Stylus (Rust, `stylus-sdk` 0.10.x, Solidity-ABI compatible), Node 18+ zero-dependency CLI, TypeScript/viem client,
GitHub Actions, Nitro dev node. Deployed on Arbitrum Sepolia and Robinhood Chain testnet.

## Live evidence index

- On npm: https://www.npmjs.com/package/create-stylus-latest (`npx create-stylus-latest my-app`). Version 0.1.0 was published by the tag-triggered workflow after
  `npm test` and the packed-tarball smoke test, with a provenance statement: https://github.com/ramadan904/npx-create-stylus-latest/actions/runs/37043469397

- Latest all-green CI (13 jobs: real-token flows, the agent CLIs, a real local deploy of every template, the npm package
  smoke test, the site in a real browser, the live agent demo against the agent CLI, and the USDG addresses and network
  RPCs checked on-chain): https://github.com/ramadan904/npx-create-stylus-latest/actions/runs/37059195125 (main:
  https://github.com/ramadan904/npx-create-stylus-latest/actions/runs/37056631397)
- The Codespace, built and used in CI: the published package scaffolds, tests and builds inside it, and the one-command
  quickstart deploys and calls a contract on a local Nitro node in 105 s:
  https://github.com/ramadan904/npx-create-stylus-latest/actions/runs/37061245097
- The demo video (submitted separately; also [`media/demo.mp4`](media/demo.mp4)) is generated from a real run (`e2e/video/chain.sh` + `e2e/video/record.mjs`):
  real `npx` and `cargo test` output, and real transactions to contracts the tool deployed on a local Nitro node.
- USDG on-chain verification (Arbitrum One and Robinhood Chain: contract present, symbol USDG, name "Global Dollar",
  6 decimals; all four RPC chain ids): https://github.com/ramadan904/npx-create-stylus-latest/actions/runs/37006932863/job/110837305641
- Real-token end-to-end flows (40 checks): https://github.com/ramadan904/npx-create-stylus-latest/actions/runs/36989741978
- Arbitrum Sepolia, current versions: stream `0x8f318a966bbc75bca53d9251e86ae8b97d578712`, escrow
  `0x91336c54f5df938fdd1ac36d0ce08bc1f6e327bb`, both used by the playground; faucet
  `0x05bdd4d122896a638f7ff41ed58c7d90a84142d8` holding 500,000 BUIDL. Earlier versions: escrow
  `0x5c3766164e3a2d4abb61f605879c18234b36a60e`, stream `0xa97f7f79dd79b6c72c8daa452f68baf1ca7bade5` (details in the
  Evidence section above).
- The playground (https://npx-create-stylus-latest-web-mocha.vercel.app/, source in `web/`): take BUIDL from the faucet, then stream, escrow or use the vault from your
  own wallet on Arbitrum Sepolia.

## Roadmap

1. A Foundry interop template (Solidity test calling a Stylus contract).
2. `cargo stylus verify` support with a Docker-friendly key path.
3. Testnet USDG presets, as soon as Paxos lists USDG on Arbitrum Sepolia or Robinhood Chain testnet.

## Try it

```bash
npx create-stylus-latest my-app -t stream --with-client
cd my-app && cargo test
```

Or with nothing installed: [open the Codespace](https://codespaces.new/ramadan904/npx-create-stylus-latest?quickstart=1) and run
`.devcontainer/quickstart.sh`.
