// Only run this as a WASM contract if the export-abi feature is not set.
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
    /// Returns the current counter value.
    pub fn number(&self) -> U256 {
        self.number.get()
    }

    /// Overwrites the counter value.
    pub fn set_number(&mut self, new_number: U256) {
        self.number.set(new_number);
    }

    /// Adds one to the counter.
    pub fn increment(&mut self) {
        let number = self.number.get();
        self.set_number(number + U256::from(1));
    }

    /// Adds `value` to the counter.
    pub fn add_number(&mut self, value: U256) {
        let number = self.number.get();
        self.set_number(number + value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use stylus_sdk::testing::*;

    #[test]
    fn counts_up() {
        let vm = TestVM::default();
        let mut counter = Counter::from(&vm);

        assert_eq!(counter.number(), U256::ZERO);
        counter.increment();
        counter.add_number(U256::from(41));
        assert_eq!(counter.number(), U256::from(42));
    }
}
