// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Functional twin of templates/counter/src/lib.rs, used only for the gas comparison in
// .github/workflows/benchmark.yml.
contract Counter {
    uint256 public number;

    function setNumber(uint256 newNumber) external {
        number = newNumber;
    }

    function increment() external {
        number += 1;
    }

    function addNumber(uint256 value) external {
        number += value;
    }

    /// 64-bit LCG iterated n times; the twin of `work` in bench/stylus-lib.rs.
    function work(uint64 n) external pure returns (uint64 acc) {
        acc = 1;
        unchecked {
            for (uint64 i = 0; i < n; i++) {
                acc = acc * 6364136223846793005 + 1442695040888963407;
            }
        }
    }
}
