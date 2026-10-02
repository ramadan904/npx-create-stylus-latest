# {{name}}

A Stylus (Rust) contract that reads a Chainlink price feed safely, scaffolded with `create-stylus-latest` against
`stylus-sdk` {{stylus_sdk_version}}.

## Contract

`PriceOracle` wraps a Chainlink `AggregatorV3` feed (for example ETH / USD) and refuses the prices you should not act on:

- `latestPrice()` returns `(answer, updatedAt)`, or reverts with a named error: `FeedUnavailable` (the read failed),
  `IncompleteRound` (no update time), `InvalidPrice(answer)` (zero or negative) or `StalePrice(updatedAt, now, maxAge)`.
- `valueOf(amount, amountDecimals)` prices an amount of the asset with 18 decimals, using the feed's decimals: for
  ETH / USD, `valueOf(1.5e18, 18)` is 4500e18 at $3000. Same checks; rounds down; `Overflow` instead of wrapping.
- `decimalsMatch()` asks the feed whether the decimals you configured are right.
- `feed()`, `decimals()`, `maxAge()` read the configuration.

**Constructor** `(feed, decimals, maxAge)`: it calls nothing, so it deploys on any chain, including a dev node with no
feed. `maxAge` is the oldest price, in seconds, you accept: the feed's heartbeat plus a margin.

## Develop

```bash
cargo test     # unit tests, and a property test of any answer, age and decimals against a reference model
./scripts/export-abi.sh
cargo build --release --target wasm32-unknown-unknown --lib
```

## Deploy

With `--network arbitrum-sepolia` (the default) or `--network arbitrum-one`, `.env.example` already holds Chainlink's
ETH / USD feed as `FEED_ADDRESS` (checked on-chain in create-stylus-latest's CI). Everything after `--` goes to the
constructor:

```bash
cp .env.example .env                 # add a funded PRIVATE_KEY
./scripts/deploy.sh --check-only
./scripts/deploy.sh -- env:FEED_ADDRESS 8 90000
```

Other feeds and chains: https://docs.chain.link/data-feeds/price-feeds/addresses (set `FEED_ADDRESS` and its decimals).
With `--with-client`: `cd client && npm install && npm start` prints the price, its age, the value of 1 unit and
whether the decimals match.
