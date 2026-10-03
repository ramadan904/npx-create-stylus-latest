# {{name}}

Rust and Solidity on one chain: a Stylus (Rust) contract that a Solidity contract calls like any other, scaffolded
with `create-stylus-latest` against `stylus-sdk` {{stylus_sdk_version}}.

## What is in it

- `src/lib.rs`, **MathLib** (Rust): exact 256-bit math for Solidity to call.
  - `mulDiv(a, b, d)` is `a * b / d` rounded down, computed with a 512-bit intermediate. It stays correct when `a * b`
    overflows 256 bits, which is exactly where `a * b / d` reverts in Solidity (prices, shares, fees, interest).
  - `mulDivUp(a, b, d)` is the same, rounded up.
  - `isqrt(n)` is the integer square root.
  - Errors: `DivisionByZero()` and `MulDivOverflow(a, b, denominator)`, an ABI-standard custom error that Solidity sees
    by name.
- `solidity/Consumer.sol`, **Consumer** (Solidity): calls MathLib through an ordinary interface (`IMathLib`).
  - `value` lets a Rust error pass through to the caller unchanged.
  - `tryValue` catches the error in Solidity with `try/catch` and matches it by selector
    (`IMathLib.DivisionByZero.selector`).

To Solidity, a Stylus contract is a contract: same ABI, same calls, same errors. Rust is a good place for the math;
your app can stay in Solidity.

## Develop

```bash
cargo test     # unit tests, and property tests checking every result against its definition in 512-bit math
./scripts/export-abi.sh
cargo build --release --target wasm32-unknown-unknown --lib
```

The property tests check `q * d <= a * b < (q + 1) * d` for `mulDiv`, and `r * r <= n < (r + 1)^2` for `isqrt`, over
values weighted towards 0, 1 and 2^256.

## Solidity calling Rust, on a local chain

```bash
cp .env.example .env     # add any PRIVATE_KEY (the dev node funds it); set RPC_URL=http://127.0.0.1:8547 and
                         # CHAIN_ID=412346, or scaffold with --network devnode, which writes those for you
./scripts/devnode.sh     # a local Arbitrum Nitro node (Docker)
./scripts/deploy.sh      # deploys MathLib (no constructor arguments); put the address it prints in .env as CONTRACT_ADDRESS
./scripts/interop.sh
```

`interop.sh` needs only Node. It runs four steps:

1. It checks that `IMathLib` in `Consumer.sol` matches the Rust contract's exported interface, every function and
   error by signature. If they drift apart, it names the mismatch and fails.
2. It compiles `Consumer.sol` with solc-js (an npm package, so no Foundry or solc install).
3. It deploys `Consumer` pointing at your MathLib.
4. It checks each answer on-chain:
   - a value whose product overflows in Solidity;
   - a fee rounded up;
   - a geometric mean;
   - a Rust error caught by name in Solidity;
   - a Rust error passed through Solidity with its arguments.

It works the same on Arbitrum Sepolia: deploy MathLib there and point `.env` at it.

Why not a Foundry test? Foundry's EVM cannot run Stylus (WASM) code, so a Solidity test there could only call a mock.
`interop.sh` runs both contracts on a real Nitro node instead.

With `--with-client`, `cd client && npm install && npm start` calls MathLib from TypeScript.

## Let an AI agent use it

`--with-client` also adds a JSON-in/JSON-out agent interface and an MCP server (Claude Desktop, Claude Code, Cursor), so
an agent gets exact 256-bit math from the same Rust contract Solidity calls, instead of doing it in floats:

```bash
cd client && npm install
npx tsx --env-file=../.env src/agent-cli.ts '{"intent":"mul_div_up","a":"1001","b":"30","denominator":"10000"}'
npx tsx src/agent-mcp.ts --config      # prints the MCP setup, with absolute paths
```

The tools are `mul_div`, `mul_div_up` and `isqrt`. Errors come back by the contract's names: `DivisionByZero`, and
`MulDivOverflow` with its arguments.
