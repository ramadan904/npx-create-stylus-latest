// Replaces src/lib.rs of a freshly scaffolded counter for the benchmark: the same four counter functions plus
// `work`, a pure compute loop with an exact Solidity twin in src/Counter.sol.
#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

use stylus_sdk::{alloy_primitives::U256, prelude::*};

sol_storage! {
    #[entrypoint]
    pub struct Counter {
        uint256 number;
    }
}

#[public]
impl Counter {
    pub fn number(&self) -> U256 {
        self.number.get()
    }

    pub fn set_number(&mut self, new_number: U256) {
        self.number.set(new_number);
    }

    pub fn increment(&mut self) {
        let number = self.number.get();
        self.set_number(number + U256::from(1));
    }

    pub fn add_number(&mut self, value: U256) {
        let number = self.number.get();
        self.set_number(number + value);
    }

    /// 64-bit LCG iterated `n` times; returns the final state. Pure, so it can be called with eth_call.
    pub fn work(&self, n: u64) -> u64 {
        let mut acc: u64 = 1;
        for _ in 0..n {
            acc = acc
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
        }
        acc
    }
}
