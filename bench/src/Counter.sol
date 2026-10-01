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
}
