// Only run this as a WASM contract if the export-abi feature is not set.
#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

use alloc::{string::String, vec::Vec};
use stylus_sdk::{
    alloy_primitives::{Address, U256},
    alloy_sol_types::sol,
    prelude::*,
};

sol! {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientBalance(address from, uint256 have, uint256 want);
    error InsufficientAllowance(address owner, address spender, uint256 have, uint256 want);
}

#[derive(SolidityError)]
pub enum Erc20Error {
    InsufficientBalance(InsufficientBalance),
    InsufficientAllowance(InsufficientAllowance),
}

sol_storage! {
    #[entrypoint]
    pub struct Token {
        string name;
        string symbol;
        uint256 total_supply;
        mapping(address => uint256) balances;
        mapping(address => mapping(address => uint256)) allowances;
    }
}

#[public]
impl Token {
    /// Runs once, atomically, when the contract is deployed (cargo-stylus sends it through the
    /// StylusDeployer, so there is no window in which someone else can initialize it first).
    /// The SDK reverts any second call. Pass the recipient explicitly: `msg_sender` here would be the
    /// deployer contract, not you.
    #[constructor]
    pub fn constructor(
        &mut self,
        name: String,
        symbol: String,
        supply: U256,
        owner: Address,
    ) -> Result<(), Vec<u8>> {
        self.name.set_str(name);
        self.symbol.set_str(symbol);
        self.mint(owner, supply);
        Ok(())
    }

    pub fn name(&self) -> String {
        self.name.get_string()
    }

    pub fn symbol(&self) -> String {
        self.symbol.get_string()
    }

    pub fn decimals(&self) -> u8 {
        18
    }

    pub fn total_supply(&self) -> U256 {
        self.total_supply.get()
    }

    pub fn balance_of(&self, owner: Address) -> U256 {
        self.balances.get(owner)
    }

    pub fn allowance(&self, owner: Address, spender: Address) -> U256 {
        self.allowances.getter(owner).get(spender)
    }

    pub fn transfer(&mut self, to: Address, value: U256) -> Result<bool, Erc20Error> {
        let from = self.vm().msg_sender();
        self.move_tokens(from, to, value)?;
        Ok(true)
    }

    pub fn approve(&mut self, spender: Address, value: U256) -> bool {
        let owner = self.vm().msg_sender();
        self.allowances.setter(owner).insert(spender, value);
        self.vm().log(Approval {
            owner,
            spender,
            value,
        });
        true
    }

    pub fn transfer_from(
        &mut self,
        from: Address,
        to: Address,
        value: U256,
    ) -> Result<bool, Erc20Error> {
        let spender = self.vm().msg_sender();
        let have = self.allowances.getter(from).get(spender);
        if have < value {
            return Err(Erc20Error::InsufficientAllowance(InsufficientAllowance {
                owner: from,
                spender,
                have,
                want: value,
            }));
        }
        // Validate everything before changing anything, so a failed call leaves no partial state
        // even if a caller catches the error instead of letting the transaction revert.
        self.ensure_balance(from, value)?;
        self.allowances.setter(from).insert(spender, have - value);
        self.move_tokens(from, to, value)?;
        Ok(true)
    }
}

// Internal helpers (not exposed in the ABI).
impl Token {
    fn mint(&mut self, to: Address, value: U256) {
        let balance = self.balances.get(to);
        self.balances.setter(to).set(balance + value);
        self.total_supply.set(self.total_supply.get() + value);
        self.vm().log(Transfer {
            from: Address::ZERO,
            to,
            value,
        });
    }

    fn ensure_balance(&self, from: Address, value: U256) -> Result<(), Erc20Error> {
        let have = self.balances.get(from);
        if have < value {
            return Err(Erc20Error::InsufficientBalance(InsufficientBalance {
                from,
                have,
                want: value,
            }));
        }
        Ok(())
    }

    fn move_tokens(&mut self, from: Address, to: Address, value: U256) -> Result<(), Erc20Error> {
        self.ensure_balance(from, value)?;
        let have = self.balances.get(from);
        self.balances.setter(from).set(have - value);
        let to_balance = self.balances.get(to);
        self.balances.setter(to).set(to_balance + value);
        self.vm().log(Transfer { from, to, value });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use stylus_sdk::{alloy_primitives::address, testing::*};

    const ALICE: Address = address!("0xA11CE00000000000000000000000000000000001");
    const BOB: Address = address!("0xB0B0000000000000000000000000000000000002");

    fn deployed() -> (TestVM, Token) {
        let vm = TestVM::default();
        vm.set_sender(ALICE);
        let mut token = Token::from(&vm);
        let built = token.constructor(
            "Buildathon".into(),
            "BUIDL".into(),
            U256::from(1_000u64),
            ALICE,
        );
        assert!(built.is_ok());
        (vm, token)
    }

    #[test]
    fn constructor_sets_metadata_and_mints_to_the_named_owner() {
        let (_vm, token) = deployed();
        assert_eq!(token.balance_of(ALICE), U256::from(1_000u64));
        assert_eq!(token.total_supply(), U256::from(1_000u64));
        assert_eq!(token.name(), "Buildathon");
        assert_eq!(token.symbol(), "BUIDL");
    }

    #[test]
    fn transfer_moves_balance_and_rejects_overdraft() {
        let (_vm, mut token) = deployed();
        assert!(token.transfer(BOB, U256::from(400u64)).is_ok());
        assert_eq!(token.balance_of(BOB), U256::from(400u64));
        assert_eq!(token.balance_of(ALICE), U256::from(600u64));
        assert!(token.transfer(BOB, U256::from(601u64)).is_err());
    }

    #[test]
    fn transfer_from_spends_allowance() {
        let (vm, mut token) = deployed();
        token.approve(BOB, U256::from(100u64));
        vm.set_sender(BOB);
        assert!(token.transfer_from(ALICE, BOB, U256::from(60u64)).is_ok());
        assert_eq!(token.allowance(ALICE, BOB), U256::from(40u64));
        assert!(token.transfer_from(ALICE, BOB, U256::from(41u64)).is_err());
    }
}

/// Property-based tests: random operation sequences must never break the token's core invariants.
#[cfg(test)]
mod properties {
    use super::*;
    use proptest::prelude::*;
    use stylus_sdk::{alloy_primitives::address, testing::*};

    const ACTORS: [Address; 4] = [
        address!("0xA11CE00000000000000000000000000000000001"),
        address!("0xB0B0000000000000000000000000000000000002"),
        address!("0xCA40100000000000000000000000000000000003"),
        address!("0xDA7E000000000000000000000000000000000004"),
    ];
    const SUPPLY: u64 = 1_000_000;

    #[derive(Debug, Clone)]
    enum Op {
        Transfer {
            from: usize,
            to: usize,
            value: u64,
        },
        Approve {
            owner: usize,
            spender: usize,
            value: u64,
        },
        TransferFrom {
            spender: usize,
            from: usize,
            to: usize,
            value: u64,
        },
    }

    fn op() -> impl Strategy<Value = Op> {
        let who = 0..ACTORS.len();
        let value = 0..(SUPPLY * 2); // up to double the supply, so overdrafts happen
        prop_oneof![
            (who.clone(), who.clone(), value.clone()).prop_map(|(from, to, value)| Op::Transfer {
                from,
                to,
                value
            }),
            (who.clone(), who.clone(), value.clone()).prop_map(|(owner, spender, value)| {
                Op::Approve {
                    owner,
                    spender,
                    value,
                }
            }),
            (who.clone(), who.clone(), who.clone(), value).prop_map(
                |(spender, from, to, value)| Op::TransferFrom {
                    spender,
                    from,
                    to,
                    value
                }
            ),
        ]
    }

    /// Every balance and every allowance, in a fixed order.
    fn snapshot(token: &Token) -> Vec<U256> {
        let mut state: Vec<U256> = ACTORS.iter().map(|a| token.balance_of(*a)).collect();
        for owner in ACTORS {
            for spender in ACTORS {
                state.push(token.allowance(owner, spender));
            }
        }
        state
    }

    fn balances_sum(token: &Token) -> U256 {
        ACTORS
            .iter()
            .fold(U256::ZERO, |sum, a| sum + token.balance_of(*a))
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        #[test]
        fn supply_is_conserved_and_failed_calls_change_nothing(ops in prop::collection::vec(op(), 0..60)) {
            let vm = TestVM::default();
            let mut token = Token::from(&vm);
            prop_assert!(token.constructor("T".into(), "T".into(), U256::from(SUPPLY), ACTORS[0]).is_ok());

            for op in ops {
                let before = snapshot(&token);
                let ok = match op {
                    Op::Transfer { from, to, value } => {
                        vm.set_sender(ACTORS[from]);
                        token.transfer(ACTORS[to], U256::from(value)).is_ok()
                    }
                    Op::Approve { owner, spender, value } => {
                        vm.set_sender(ACTORS[owner]);
                        token.approve(ACTORS[spender], U256::from(value))
                    }
                    Op::TransferFrom { spender, from, to, value } => {
                        vm.set_sender(ACTORS[spender]);
                        let allowance = token.allowance(ACTORS[from], ACTORS[spender]);
                        let ok = token.transfer_from(ACTORS[from], ACTORS[to], U256::from(value)).is_ok();
                        if ok {
                            // a successful delegated transfer spends exactly `value` of the allowance
                            let after = token.allowance(ACTORS[from], ACTORS[spender]);
                            prop_assert_eq!(after, allowance - U256::from(value));
                        }
                        ok
                    }
                };
                if !ok {
                    prop_assert_eq!(snapshot(&token), before, "a failed call must not change state");
                }
                prop_assert_eq!(balances_sum(&token), U256::from(SUPPLY));
                prop_assert_eq!(token.total_supply(), U256::from(SUPPLY));
            }
        }
    }
}
