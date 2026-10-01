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

## Results (CI run 36935538361, 2026-10-01)

https://github.com/ramadan904/npx-create-stylus-latest/actions/runs/36935538361 (local Nitro dev node, execution gas =
`gasUsed - gasUsedForL1`). The Stylus contract was deployed with `scripts/deploy.sh` and no cache bid was placed, so
this is the uncached case.

| | Stylus | Solidity |
|---|---|---|
| `increment`, first call (0 to 1) | 72,299 | 43,561 |
| `increment`, steady state | 55,199 | 26,461 |
| `addNumber` | 55,360 | 26,881 |
| `setNumber` | 55,323 | 26,596 |
| `work(20000)` | 58,800 | 1,821,893 |
| on-chain code size | 6,272 bytes | 811 bytes |

Both contracts returned the same `work(20000)` result, `10579850105631593249`.

Reading it honestly: for storage-only calls Stylus used about 2x the gas of Solidity (roughly 29k more per call) and the
contract is larger on chain. For the compute loop Stylus used about 31x less. The two effects point the same way as
Stylus's design: a fixed overhead for entering a WASM program, and a very cheap compute path. A real application's
split between the two decides which side wins; this benchmark does not claim a general speedup.
