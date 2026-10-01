# Gas benchmark: Stylus counter vs Solidity counter

`src/Counter.sol` is a line-for-line functional twin of the `counter` template. The `Benchmark` workflow deploys both to a
local Nitro dev node (the same Nitro version CI uses), sends identical transactions to each, and reads `gasUsed` from
the receipts. Results are written to the run's summary and are not hand-edited anywhere in this repo.

Caveats, so the numbers are read correctly:

- A dev node is not mainnet pricing. Gas units here are still ArbOS gas units, but L1 data costs are not modelled.
- Tiny contracts are not where Stylus wins; the savings come from compute-heavy code. A counter mostly pays for the
  storage write, which costs the same in both. We report whatever the run measures.
- Solidity is compiled with Foundry's default optimizer settings.

## What is measured

- `increment`, `addNumber`, `setNumber`: storage-bound, so expect the two languages to be close (or Stylus slightly
  worse, from the cost of entering a WASM program).
- `work(n)`: a pure 64-bit LCG loop with identical semantics in both. The script fails the run if the two results
  differ, so the comparison cannot silently be between different computations.
- `gasUsed` on Arbitrum includes `gasUsedForL1`, a data-posting component independent of the language. The table shows
  execution gas, `gasUsed - gasUsedForL1`, read from the raw receipts.
