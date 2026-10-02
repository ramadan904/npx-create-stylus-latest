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
    }
}

sol! {
    event Dripped(address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error TooSoon(uint256 availableAt);
    error TokenTransferFailed();
}

#[derive(SolidityError)]
pub enum FaucetError {
    ZeroAddress(ZeroAddress),
    ZeroAmount(ZeroAmount),
    TooSoon(TooSoon),
    TokenTransferFailed(TokenTransferFailed),
}

// Test-only record of every token movement as `(from, to, amount)`. The test VM answers any call it has no exact
// mock for with success, so without this a wrong amount would go unnoticed.
#[cfg(test)]
thread_local! {
    static MOVES: core::cell::RefCell<Vec<(Address, Address, U256)>> = const { core::cell::RefCell::new(Vec::new()) };
}

#[cfg(test)]
fn take_moves() -> Vec<(Address, Address, U256)> {
    MOVES.with(|m| core::mem::take(&mut *m.borrow_mut()))
}

sol_storage! {
    #[entrypoint]
    pub struct Faucet {
        address token;
        uint256 amount;
        uint256 cooldown;
        mapping(address => uint256) last_drip;
    }
}

/// A rate-limited faucet for a test token: anyone may take `amount` once every `cooldown` seconds. Fund it by
/// transferring tokens to its address. Meant for testnets and demos, so visitors can try a dApp without asking you.
/// When it runs dry, `drip` reverts with `TokenTransferFailed` (the token refuses the transfer); a UI can check
/// `token.balanceOf(faucet)` first to say so.
#[public]
impl Faucet {
    /// Runs once, atomically, at deploy time: the token handed out, how much per drip and how often per address.
    #[constructor]
    pub fn constructor(
        &mut self,
        token: Address,
        amount: U256,
        cooldown: U256,
    ) -> Result<(), Vec<u8>> {
        if token == Address::ZERO {
            return Err(FaucetError::ZeroAddress(ZeroAddress {}).into());
        }
        if amount.is_zero() {
            return Err(FaucetError::ZeroAmount(ZeroAmount {}).into());
        }
        self.token.set(token);
        self.amount.set(amount);
        self.cooldown.set(cooldown);
        Ok(())
    }

    pub fn token(&self) -> Address {
        self.token.get()
    }

    /// Tokens per drip, in base units.
    pub fn amount(&self) -> U256 {
        self.amount.get()
    }

    /// Seconds an address must wait between drips.
    pub fn cooldown(&self) -> U256 {
        self.cooldown.get()
    }

    /// When `who` may drip next (unix seconds); 0 if they never have. A UI or an agent can check this instead of
    /// sending a transaction that would revert. `drip` uses the same rule.
    pub fn available_at(&self, who: Address) -> U256 {
        let last = self.last_drip.get(who);
        if last.is_zero() {
            U256::ZERO
        } else {
            last + self.cooldown.get()
        }
    }

    /// Send `amount` of the token to the caller, at most once per `cooldown` per address. A failed transfer reverts the
    /// whole call, so an empty faucet does not use up the caller's cooldown.
    pub fn drip(&mut self) -> Result<U256, FaucetError> {
        let to = self.vm().msg_sender();
        let now = U256::from(self.vm().block_timestamp());
        let available_at = self.available_at(to);
        if now < available_at {
            return Err(FaucetError::TooSoon(TooSoon {
                availableAt: available_at,
            }));
        }
        let amount = self.amount.get();

        // Effects before interaction: record the drip, then send.
        self.last_drip.setter(to).set(now);
        self.push(to, amount)?;
        self.vm().log(Dripped { to, amount });
        Ok(amount)
    }
}

impl Faucet {
    fn push(&mut self, to: Address, amount: U256) -> Result<(), FaucetError> {
        #[cfg(test)]
        MOVES.with(|m| {
            let this = self.vm().contract_address();
            m.borrow_mut().push((this, to, amount));
        });
        let token = IERC20::new(self.token.get());
        let call = Call::new_mutating(self);
        let ok = token
            .transfer(self.vm(), call, to, amount)
            .map_err(|_| FaucetError::TokenTransferFailed(TokenTransferFailed {}))?;
        if ok {
            Ok(())
        } else {
            Err(FaucetError::TokenTransferFailed(TokenTransferFailed {}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use stylus_sdk::{alloy_primitives::address, alloy_sol_types::SolCall, testing::*};

    sol! {
        function transfer(address to, uint256 value) external returns (bool);
    }

    const TOKEN: Address = address!("0x7007000000000000000000000000000000001001");
    const ALICE: Address = address!("0xA11CE00000000000000000000000000000000001");
    const BOB: Address = address!("0xB0B0000000000000000000000000000000000002");
    const AMOUNT: u64 = 100;
    const COOLDOWN: u64 = 3_600;

    fn yes() -> Vec<u8> {
        U256::from(1).to_be_bytes_vec()
    }

    /// A configured faucet at t = 1000.
    fn faucet() -> (TestVM, Faucet) {
        let vm = TestVM::default();
        vm.set_block_timestamp(1_000);
        let mut faucet = Faucet::from(&vm);
        assert!(
            faucet
                .constructor(TOKEN, U256::from(AMOUNT), U256::from(COOLDOWN))
                .is_ok()
        );
        (vm, faucet)
    }

    fn mock_send(vm: &TestVM, to: Address) {
        let call = transferCall {
            to,
            value: U256::from(AMOUNT),
        };
        vm.mock_call(TOKEN, call.abi_encode(), U256::ZERO, Ok(yes()));
    }

    #[test]
    fn constructor_rejects_a_zero_token_or_amount() {
        let vm = TestVM::default();
        let mut f = Faucet::from(&vm);
        assert!(
            f.constructor(Address::ZERO, U256::from(1), U256::ZERO)
                .is_err()
        );
        let mut f = Faucet::from(&vm);
        assert!(f.constructor(TOKEN, U256::ZERO, U256::ZERO).is_err());
    }

    #[test]
    fn drip_sends_exactly_the_amount_to_the_caller() {
        let (vm, mut faucet) = faucet();
        mock_send(&vm, ALICE);
        vm.set_sender(ALICE);
        assert!(matches!(faucet.drip(), Ok(sent) if sent == U256::from(AMOUNT)));
        assert_eq!(
            take_moves(),
            vec![(vm.contract_address(), ALICE, U256::from(AMOUNT))]
        );
        assert_eq!(faucet.available_at(ALICE), U256::from(1_000 + COOLDOWN));
    }

    #[test]
    fn the_cooldown_is_per_address_and_ends_exactly_on_time() {
        let (vm, mut faucet) = faucet();
        mock_send(&vm, ALICE);
        mock_send(&vm, BOB);
        vm.set_sender(ALICE);
        assert!(faucet.drip().is_ok());
        take_moves();

        vm.set_block_timestamp(1_000 + COOLDOWN - 1);
        assert!(faucet.drip().is_err(), "one second early");
        assert!(take_moves().is_empty(), "a rejected drip sends nothing");
        vm.set_sender(BOB);
        assert!(faucet.drip().is_ok(), "another address is not affected");
        take_moves();

        vm.set_sender(ALICE);
        vm.set_block_timestamp(1_000 + COOLDOWN);
        assert!(faucet.drip().is_ok(), "exactly at available_at");
    }

    #[test]
    fn a_refused_transfer_fails_the_drip() {
        let (vm, mut faucet) = faucet();
        let call = transferCall {
            to: ALICE,
            value: U256::from(AMOUNT),
        };
        // What the token does when the faucet has run dry.
        vm.mock_call(TOKEN, call.abi_encode(), U256::ZERO, Err(Vec::new()));
        vm.set_sender(ALICE);
        assert!(faucet.drip().is_err());
        // On a real chain the revert also rolls back the recorded drip, so the cooldown is not used up; the test VM
        // does not roll back storage, so that part is covered by the dev node flow instead.
    }

    #[test]
    fn views_report_the_configuration() {
        let (_vm, faucet) = faucet();
        assert_eq!(faucet.token(), TOKEN);
        assert_eq!(faucet.amount(), U256::from(AMOUNT));
        assert_eq!(faucet.cooldown(), U256::from(COOLDOWN));
        assert_eq!(faucet.available_at(BOB), U256::ZERO);
    }
}

/// Model-based property test: random drips by random callers at random times, against a model of who dripped when.
/// Every token movement must be exactly the one the model expects, and `available_at` must predict every outcome.
#[cfg(test)]
mod properties {
    use super::*;
    use proptest::prelude::*;
    use stylus_sdk::{alloy_primitives::address, alloy_sol_types::SolCall, testing::*};

    sol! {
        function transfer(address to, uint256 value) external returns (bool);
    }

    const TOKEN: Address = address!("0x7007000000000000000000000000000000001001");
    const ACTORS: [Address; 3] = [
        address!("0xA11CE00000000000000000000000000000000001"),
        address!("0xB0B0000000000000000000000000000000000002"),
        address!("0xCA40100000000000000000000000000000000003"),
    ];

    #[derive(Debug, Clone)]
    enum Op {
        Drip { who: usize },
        Advance { secs: u64 },
    }

    fn op() -> impl Strategy<Value = Op> {
        prop_oneof![
            (0..ACTORS.len()).prop_map(|who| Op::Drip { who }),
            (0u64..90).prop_map(|secs| Op::Advance { secs }),
        ]
    }

    proptest! {
        #[test]
        fn faucet_matches_a_reference_model(
            amount in 1u64..50,
            cooldown in 0u64..120,
            ops in prop::collection::vec(op(), 0..60),
        ) {
            let vm = TestVM::default();
            let mut now = 1_000u64;
            vm.set_block_timestamp(now);
            let mut faucet = Faucet::from(&vm);
            prop_assert!(faucet.constructor(TOKEN, U256::from(amount), U256::from(cooldown)).is_ok());
            take_moves();
            let this = vm.contract_address();

            let mut last: [Option<u64>; 3] = [None; 3];
            for op in ops {
                match op {
                    Op::Advance { secs } => {
                        now += secs;
                        vm.set_block_timestamp(now);
                    }
                    Op::Drip { who } => {
                        let send = transferCall { to: ACTORS[who], value: U256::from(amount) };
                        vm.mock_call(TOKEN, send.abi_encode(), U256::ZERO, Ok(U256::from(1).to_be_bytes_vec()));
                        vm.set_sender(ACTORS[who]);

                        let available = last[who].map_or(0, |t| t + cooldown);
                        prop_assert_eq!(faucet.available_at(ACTORS[who]), U256::from(available));
                        let expected = now >= available;
                        let ok = faucet.drip().is_ok();
                        prop_assert_eq!(ok, expected);
                        let moves = take_moves();
                        if ok {
                            prop_assert_eq!(moves, vec![(this, ACTORS[who], U256::from(amount))]);
                            last[who] = Some(now);
                        } else {
                            prop_assert!(moves.is_empty(), "a rejected drip moves nothing");
                        }
                    }
                }
            }
        }
    }
}
