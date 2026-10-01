// Only run this as a WASM contract if the export-abi feature is not set.
#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

use stylus_sdk::{
    alloy_primitives::{Address, U256},
    alloy_sol_types::sol,
    prelude::*,
};

sol_interface! {
    interface IERC20 {
        function transfer(address to, uint256 value) external returns (bool);
        function transferFrom(address from, address to, uint256 value) external returns (bool);
    }
}

sol! {
    event Deposited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error InsufficientDeposit(uint256 have, uint256 want);
    error TokenTransferFailed();
}

#[derive(SolidityError)]
pub enum VaultError {
    ZeroAddress(ZeroAddress),
    ZeroAmount(ZeroAmount),
    InsufficientDeposit(InsufficientDeposit),
    TokenTransferFailed(TokenTransferFailed),
}

sol_storage! {
    #[entrypoint]
    pub struct Vault {
        address asset;
        uint256 total_deposits;
        mapping(address => uint256) deposits;
    }
}

#[public]
impl Vault {
    /// Runs once, atomically, when the contract is deployed: chooses the ERC-20 this vault holds
    /// (e.g. USDC or USDG). Nobody can race the deployer to set a different token.
    #[constructor]
    pub fn constructor(&mut self, asset: Address) -> Result<(), Vec<u8>> {
        if asset == Address::ZERO {
            return Err(VaultError::ZeroAddress(ZeroAddress {}).into());
        }
        self.asset.set(asset);
        Ok(())
    }

    pub fn asset(&self) -> Address {
        self.asset.get()
    }

    pub fn total_deposits(&self) -> U256 {
        self.total_deposits.get()
    }

    pub fn deposit_of(&self, account: Address) -> U256 {
        self.deposits.get(account)
    }

    /// Pull `amount` from the caller (who must have approved this vault first).
    pub fn deposit(&mut self, amount: U256) -> Result<(), VaultError> {
        if amount.is_zero() {
            return Err(VaultError::ZeroAmount(ZeroAmount {}));
        }
        let account = self.vm().msg_sender();
        let vault = self.vm().contract_address();

        // Effects before interaction: update accounting, then call the token.
        let balance = self.deposits.get(account);
        self.deposits.setter(account).set(balance + amount);
        self.total_deposits.set(self.total_deposits.get() + amount);

        let token = IERC20::new(self.asset.get());
        let call = Call::new_mutating(self);
        let ok = token
            .transfer_from(self.vm(), call, account, vault, amount)
            .map_err(|_| VaultError::TokenTransferFailed(TokenTransferFailed {}))?;
        if !ok {
            return Err(VaultError::TokenTransferFailed(TokenTransferFailed {}));
        }
        self.vm().log(Deposited { account, amount });
        Ok(())
    }

    /// Send `amount` of the caller's deposit back to them.
    pub fn withdraw(&mut self, amount: U256) -> Result<(), VaultError> {
        if amount.is_zero() {
            return Err(VaultError::ZeroAmount(ZeroAmount {}));
        }
        let account = self.vm().msg_sender();
        let have = self.deposits.get(account);
        if have < amount {
            return Err(VaultError::InsufficientDeposit(InsufficientDeposit {
                have,
                want: amount,
            }));
        }

        self.deposits.setter(account).set(have - amount);
        self.total_deposits.set(self.total_deposits.get() - amount);

        let token = IERC20::new(self.asset.get());
        let call = Call::new_mutating(self);
        let ok = token
            .transfer(self.vm(), call, account, amount)
            .map_err(|_| VaultError::TokenTransferFailed(TokenTransferFailed {}))?;
        if !ok {
            return Err(VaultError::TokenTransferFailed(TokenTransferFailed {}));
        }
        self.vm().log(Withdrawn { account, amount });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use stylus_sdk::{alloy_primitives::address, alloy_sol_types::SolCall, testing::*};

    sol! {
        function transfer(address to, uint256 value) external returns (bool);
        function transferFrom(address from, address to, uint256 value) external returns (bool);
    }

    const TOKEN: Address = address!("0x7007000000000000000000000000000000000001");
    const ALICE: Address = address!("0xA11CE00000000000000000000000000000000001");

    // ABI encoding of `true`.
    fn yes() -> Vec<u8> {
        U256::from(1).to_be_bytes_vec()
    }

    fn deployed() -> (TestVM, Vault) {
        let vm = TestVM::default();
        vm.set_sender(ALICE);
        let mut vault = Vault::from(&vm);
        assert!(vault.constructor(TOKEN).is_ok());
        (vm, vault)
    }

    #[test]
    fn constructor_sets_the_asset_and_rejects_the_zero_address() {
        let (vm, vault) = deployed();
        assert_eq!(vault.asset(), TOKEN);
        let mut fresh = Vault::from(&vm);
        assert!(fresh.constructor(Address::ZERO).is_err());
    }

    #[test]
    fn deposit_pulls_tokens_and_credits_the_caller() {
        let (vm, mut vault) = deployed();
        let amount = U256::from(250u64);
        let pull = transferFromCall {
            from: ALICE,
            to: vm.contract_address(),
            value: amount,
        };
        vm.mock_call(TOKEN, pull.abi_encode(), U256::ZERO, Ok(yes()));

        assert!(vault.deposit(amount).is_ok());
        assert_eq!(vault.deposit_of(ALICE), amount);
        assert_eq!(vault.total_deposits(), amount);
    }

    #[test]
    fn failed_token_transfer_reverts_the_deposit() {
        let (vm, mut vault) = deployed();
        let amount = U256::from(5u64);
        let pull = transferFromCall {
            from: ALICE,
            to: vm.contract_address(),
            value: amount,
        };
        vm.mock_call(TOKEN, pull.abi_encode(), U256::ZERO, Err(Vec::new()));

        assert!(vault.deposit(amount).is_err());
    }

    #[test]
    fn withdraw_returns_tokens_and_cannot_overdraw() {
        let (vm, mut vault) = deployed();
        let pull = transferFromCall {
            from: ALICE,
            to: vm.contract_address(),
            value: U256::from(100u64),
        };
        vm.mock_call(TOKEN, pull.abi_encode(), U256::ZERO, Ok(yes()));
        assert!(vault.deposit(U256::from(100u64)).is_ok());

        let send = transferCall {
            to: ALICE,
            value: U256::from(40u64),
        };
        vm.mock_call(TOKEN, send.abi_encode(), U256::ZERO, Ok(yes()));
        assert!(vault.withdraw(U256::from(40u64)).is_ok());
        assert_eq!(vault.deposit_of(ALICE), U256::from(60u64));

        assert!(vault.withdraw(U256::from(61u64)).is_err());
        assert!(vault.withdraw(U256::ZERO).is_err());
    }
}

/// Model-based property test: after any sequence of deposits and withdrawals, the vault must agree
/// with a simple reference model, and a failed call must change nothing.
#[cfg(test)]
mod properties {
    use super::*;
    use proptest::prelude::*;
    use stylus_sdk::{alloy_primitives::address, alloy_sol_types::SolCall, testing::*};

    sol! {
        function transfer(address to, uint256 value) external returns (bool);
        function transferFrom(address from, address to, uint256 value) external returns (bool);
    }

    const TOKEN: Address = address!("0x7007000000000000000000000000000000000001");
    const ACTORS: [Address; 3] = [
        address!("0xA11CE00000000000000000000000000000000001"),
        address!("0xB0B0000000000000000000000000000000000002"),
        address!("0xCA40100000000000000000000000000000000003"),
    ];

    #[derive(Debug, Clone)]
    enum Op {
        Deposit { who: usize, amount: u64 },
        Withdraw { who: usize, amount: u64 },
    }

    fn op() -> impl Strategy<Value = Op> {
        let who = 0..ACTORS.len();
        let amount = 0u64..1_000; // includes zero, which must be rejected
        prop_oneof![
            (who.clone(), amount.clone()).prop_map(|(who, amount)| Op::Deposit { who, amount }),
            (who, amount).prop_map(|(who, amount)| Op::Withdraw { who, amount }),
        ]
    }

    fn yes() -> Vec<u8> {
        U256::from(1).to_be_bytes_vec()
    }

    proptest! {
        #[test]
        fn vault_matches_a_reference_model(ops in prop::collection::vec(op(), 0..60)) {
            let vm = TestVM::default();
            let mut vault = Vault::from(&vm);
            prop_assert!(vault.constructor(TOKEN).is_ok());

            let mut model = [0u64; ACTORS.len()];
            for op in ops {
                match op {
                    Op::Deposit { who, amount } => {
                        vm.set_sender(ACTORS[who]);
                        let pull = transferFromCall {
                            from: ACTORS[who],
                            to: vm.contract_address(),
                            value: U256::from(amount),
                        };
                        vm.mock_call(TOKEN, pull.abi_encode(), U256::ZERO, Ok(yes()));
                        let ok = vault.deposit(U256::from(amount)).is_ok();
                        prop_assert_eq!(ok, amount > 0, "only a zero deposit may be rejected");
                        if ok { model[who] += amount; }
                    }
                    Op::Withdraw { who, amount } => {
                        vm.set_sender(ACTORS[who]);
                        let send = transferCall { to: ACTORS[who], value: U256::from(amount) };
                        vm.mock_call(TOKEN, send.abi_encode(), U256::ZERO, Ok(yes()));
                        let ok = vault.withdraw(U256::from(amount)).is_ok();
                        prop_assert_eq!(ok, amount > 0 && amount <= model[who], "withdraw succeeds only within the deposit");
                        if ok { model[who] -= amount; }
                    }
                }
                for (i, actor) in ACTORS.iter().enumerate() {
                    prop_assert_eq!(vault.deposit_of(*actor), U256::from(model[i]));
                }
                prop_assert_eq!(vault.total_deposits(), U256::from(model.iter().sum::<u64>()));
            }
        }
    }
}
