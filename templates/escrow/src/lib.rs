// Only run this as a WASM contract if the export-abi feature is not set.
#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

use stylus_sdk::{
    alloy_primitives::{Address, U8, U256},
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
    event DealCreated(uint256 indexed id, address indexed buyer, address indexed seller, uint256 amount, uint256 deadline);
    event Released(uint256 indexed id, address indexed seller, uint256 amount);
    event Refunded(uint256 indexed id, address indexed buyer, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error SelfDeal();
    error DeadlineInPast(uint256 deadline, uint256 now);
    error NoSuchDeal(uint256 id);
    error NotFunded(uint256 id);
    error NotAuthorized();
    error TokenTransferFailed();
}

#[derive(SolidityError)]
pub enum EscrowError {
    ZeroAddress(ZeroAddress),
    ZeroAmount(ZeroAmount),
    SelfDeal(SelfDeal),
    DeadlineInPast(DeadlineInPast),
    NoSuchDeal(NoSuchDeal),
    NotFunded(NotFunded),
    NotAuthorized(NotAuthorized),
    TokenTransferFailed(TokenTransferFailed),
}

// Test-only record of every token movement as `(from, to, amount)`. The test VM answers any call it has no exact
// mock for with success, so without this a wrong payout amount would go unnoticed.
#[cfg(test)]
thread_local! {
    static MOVES: core::cell::RefCell<Vec<(Address, Address, U256)>> = const { core::cell::RefCell::new(Vec::new()) };
}

#[cfg(test)]
fn take_moves() -> Vec<(Address, Address, U256)> {
    MOVES.with(|m| core::mem::take(&mut *m.borrow_mut()))
}

/// Deal lifecycle. A deal is funded the moment it is created, so there is no "unfunded" state to get stuck in.
pub const FUNDED: u8 = 1;
pub const RELEASED: u8 = 2;
pub const REFUNDED: u8 = 3;

sol_storage! {
    #[entrypoint]
    pub struct Escrow {
        address token;
        uint256 next_id;
        mapping(uint256 => address) buyers;
        mapping(uint256 => address) sellers;
        mapping(uint256 => address) arbiters;
        mapping(uint256 => uint256) amounts;
        mapping(uint256 => uint256) deadlines;
        mapping(uint256 => uint8) states;
    }
}

#[public]
impl Escrow {
    /// Runs once, atomically, at deploy time: fixes the ERC-20 this escrow settles in (USDC, USDG, ...).
    #[constructor]
    pub fn constructor(&mut self, token: Address) -> Result<(), Vec<u8>> {
        if token == Address::ZERO {
            return Err(EscrowError::ZeroAddress(ZeroAddress {}).into());
        }
        self.token.set(token);
        // Ids start at 1 so that id 0 is never a real deal.
        self.next_id.set(U256::from(1));
        Ok(())
    }

    pub fn token(&self) -> Address {
        self.token.get()
    }

    pub fn deal_count(&self) -> U256 {
        self.next_id.get() - U256::from(1)
    }

    /// `(buyer, seller, arbiter, amount, deadline, state)`; state is 1 funded, 2 released, 3 refunded, 0 unknown.
    pub fn deal(&self, id: U256) -> (Address, Address, Address, U256, U256, u8) {
        (
            self.buyers.get(id),
            self.sellers.get(id),
            self.arbiters.get(id),
            self.amounts.get(id),
            self.deadlines.get(id),
            self.state(id),
        )
    }

    /// The caller (buyer) locks `amount` of the token for `seller` and gets back a deal id.
    /// The buyer must `approve` this contract first. `arbiter` may be the zero address for "no arbiter".
    ///
    /// - the buyer or the arbiter can `release` to the seller at any time
    /// - the seller or the arbiter can `refund` to the buyer at any time
    /// - after `deadline` the buyer can `refund` unilaterally, so funds are never stuck behind an absent seller
    pub fn create(
        &mut self,
        seller: Address,
        amount: U256,
        deadline: U256,
        arbiter: Address,
    ) -> Result<U256, EscrowError> {
        let buyer = self.vm().msg_sender();
        if seller == Address::ZERO {
            return Err(EscrowError::ZeroAddress(ZeroAddress {}));
        }
        if seller == buyer {
            return Err(EscrowError::SelfDeal(SelfDeal {}));
        }
        if amount.is_zero() {
            return Err(EscrowError::ZeroAmount(ZeroAmount {}));
        }
        let now = U256::from(self.vm().block_timestamp());
        if deadline <= now {
            return Err(EscrowError::DeadlineInPast(DeadlineInPast {
                deadline,
                now,
            }));
        }

        // Effects before interaction: record the deal, then pull the funds.
        let id = self.next_id.get();
        self.next_id.set(id + U256::from(1));
        self.buyers.setter(id).set(buyer);
        self.sellers.setter(id).set(seller);
        self.arbiters.setter(id).set(arbiter);
        self.amounts.setter(id).set(amount);
        self.deadlines.setter(id).set(deadline);
        self.set_state(id, FUNDED);

        let this = self.vm().contract_address();
        self.pull(buyer, this, amount)?;
        self.vm().log(DealCreated {
            id,
            buyer,
            seller,
            amount,
            deadline,
        });
        Ok(id)
    }

    /// Pay the seller. Allowed for the buyer or the arbiter while the deal is funded.
    pub fn release(&mut self, id: U256) -> Result<(), EscrowError> {
        self.require_funded(id)?;
        let caller = self.vm().msg_sender();
        if caller != self.buyers.get(id) && !self.is_arbiter(id, caller) {
            return Err(EscrowError::NotAuthorized(NotAuthorized {}));
        }
        let (seller, amount) = (self.sellers.get(id), self.amounts.get(id));
        self.set_state(id, RELEASED);
        self.push(seller, amount)?;
        self.vm().log(Released { id, seller, amount });
        Ok(())
    }

    /// Return the funds to the buyer. Allowed for the seller or the arbiter at any time, and for the buyer once the
    /// deadline has passed.
    pub fn refund(&mut self, id: U256) -> Result<(), EscrowError> {
        self.require_funded(id)?;
        let caller = self.vm().msg_sender();
        let buyer = self.buyers.get(id);
        let expired = U256::from(self.vm().block_timestamp()) >= self.deadlines.get(id);
        let allowed = caller == self.sellers.get(id)
            || self.is_arbiter(id, caller)
            || (caller == buyer && expired);
        if !allowed {
            return Err(EscrowError::NotAuthorized(NotAuthorized {}));
        }
        let amount = self.amounts.get(id);
        self.set_state(id, REFUNDED);
        self.push(buyer, amount)?;
        self.vm().log(Refunded { id, buyer, amount });
        Ok(())
    }
}

impl Escrow {
    fn state(&self, id: U256) -> u8 {
        self.states.get(id).to::<u8>()
    }

    fn set_state(&mut self, id: U256, state: u8) {
        self.states.setter(id).set(U8::from(state));
    }

    fn require_funded(&self, id: U256) -> Result<(), EscrowError> {
        match self.state(id) {
            0 => Err(EscrowError::NoSuchDeal(NoSuchDeal { id })),
            FUNDED => Ok(()),
            _ => Err(EscrowError::NotFunded(NotFunded { id })),
        }
    }

    /// The zero address means "no arbiter", so it must never match a caller.
    fn is_arbiter(&self, id: U256, who: Address) -> bool {
        let arbiter = self.arbiters.get(id);
        arbiter != Address::ZERO && arbiter == who
    }

    fn pull(&mut self, from: Address, to: Address, amount: U256) -> Result<(), EscrowError> {
        #[cfg(test)]
        MOVES.with(|m| m.borrow_mut().push((from, to, amount)));
        let token = IERC20::new(self.token.get());
        let call = Call::new_mutating(self);
        let ok = token
            .transfer_from(self.vm(), call, from, to, amount)
            .map_err(|_| EscrowError::TokenTransferFailed(TokenTransferFailed {}))?;
        if ok {
            Ok(())
        } else {
            Err(EscrowError::TokenTransferFailed(TokenTransferFailed {}))
        }
    }

    fn push(&mut self, to: Address, amount: U256) -> Result<(), EscrowError> {
        #[cfg(test)]
        MOVES.with(|m| {
            let this = self.vm().contract_address();
            m.borrow_mut().push((this, to, amount));
        });
        let token = IERC20::new(self.token.get());
        let call = Call::new_mutating(self);
        let ok = token
            .transfer(self.vm(), call, to, amount)
            .map_err(|_| EscrowError::TokenTransferFailed(TokenTransferFailed {}))?;
        if ok {
            Ok(())
        } else {
            Err(EscrowError::TokenTransferFailed(TokenTransferFailed {}))
        }
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

    const TOKEN: Address = address!("0x7007000000000000000000000000000000001001");
    const BUYER: Address = address!("0xA11CE00000000000000000000000000000000001");
    const SELLER: Address = address!("0xB0B0000000000000000000000000000000000002");
    const ARBITER: Address = address!("0xCA40100000000000000000000000000000000003");
    const STRANGER: Address = address!("0x57A4C3E000000000000000000000000000000004");
    const DEADLINE: u64 = 1_000;

    fn yes() -> Vec<u8> {
        U256::from(1).to_be_bytes_vec()
    }

    fn deployed() -> (TestVM, Escrow) {
        let vm = TestVM::default();
        vm.set_block_timestamp(100);
        let mut escrow = Escrow::from(&vm);
        assert!(escrow.constructor(TOKEN).is_ok());
        (vm, escrow)
    }

    fn mock_pull(vm: &TestVM, amount: u64) {
        let pull = transferFromCall {
            from: BUYER,
            to: vm.contract_address(),
            value: U256::from(amount),
        };
        vm.mock_call(TOKEN, pull.abi_encode(), U256::ZERO, Ok(yes()));
    }

    fn mock_push(vm: &TestVM, to: Address, amount: u64) {
        let send = transferCall {
            to,
            value: U256::from(amount),
        };
        vm.mock_call(TOKEN, send.abi_encode(), U256::ZERO, Ok(yes()));
    }

    /// Creates deal 1: BUYER locks 500 for SELLER with ARBITER and the default deadline.
    fn funded() -> (TestVM, Escrow) {
        let (vm, mut escrow) = deployed();
        vm.set_sender(BUYER);
        mock_pull(&vm, 500);
        let id = escrow
            .create(SELLER, U256::from(500u64), U256::from(DEADLINE), ARBITER)
            .unwrap_or_else(|_| panic!("create failed"));
        assert_eq!(id, U256::from(1));
        assert_eq!(
            take_moves(),
            vec![(BUYER, vm.contract_address(), U256::from(500u64))]
        );
        (vm, escrow)
    }

    fn paid(vm: &TestVM, to: Address, amount: u64) -> (Address, Address, U256) {
        (vm.contract_address(), to, U256::from(amount))
    }

    #[test]
    fn constructor_sets_the_token_and_rejects_zero() {
        let (vm, escrow) = deployed();
        assert_eq!(escrow.token(), TOKEN);
        assert_eq!(escrow.deal_count(), U256::ZERO);
        let mut fresh = Escrow::from(&vm);
        assert!(fresh.constructor(Address::ZERO).is_err());
    }

    #[test]
    fn create_locks_funds_and_records_the_deal() {
        let (_vm, escrow) = funded();
        let (buyer, seller, arbiter, amount, deadline, state) = escrow.deal(U256::from(1));
        assert_eq!((buyer, seller, arbiter), (BUYER, SELLER, ARBITER));
        assert_eq!(
            (amount, deadline),
            (U256::from(500u64), U256::from(DEADLINE))
        );
        assert_eq!(state, FUNDED);
        assert_eq!(escrow.deal_count(), U256::from(1));
    }

    #[test]
    fn create_rejects_bad_input_and_a_failed_pull() {
        let (vm, mut escrow) = deployed();
        vm.set_sender(BUYER);
        let ok_deadline = U256::from(DEADLINE);
        let amount = U256::from(5u64);
        assert!(
            escrow
                .create(Address::ZERO, amount, ok_deadline, ARBITER)
                .is_err()
        );
        assert!(escrow.create(BUYER, amount, ok_deadline, ARBITER).is_err());
        assert!(
            escrow
                .create(SELLER, U256::ZERO, ok_deadline, ARBITER)
                .is_err()
        );
        // deadline not in the future (block timestamp is 100)
        assert!(
            escrow
                .create(SELLER, amount, U256::from(100u64), ARBITER)
                .is_err()
        );

        let pull = transferFromCall {
            from: BUYER,
            to: vm.contract_address(),
            value: amount,
        };
        vm.mock_call(TOKEN, pull.abi_encode(), U256::ZERO, Err(Vec::new()));
        assert!(escrow.create(SELLER, amount, ok_deadline, ARBITER).is_err());
    }

    #[test]
    fn buyer_releases_to_the_seller_once() {
        let (vm, mut escrow) = funded();
        mock_push(&vm, SELLER, 500);
        vm.set_sender(BUYER);
        assert!(escrow.release(U256::from(1)).is_ok());
        assert_eq!(take_moves(), vec![paid(&vm, SELLER, 500)]);
        assert_eq!(escrow.deal(U256::from(1)).5, RELEASED);
        // Settled deals cannot be settled again, in either direction, and a rejected call moves nothing.
        assert!(escrow.release(U256::from(1)).is_err());
        vm.set_sender(SELLER);
        assert!(escrow.refund(U256::from(1)).is_err());
        assert!(take_moves().is_empty());
    }

    #[test]
    fn only_the_buyer_or_arbiter_can_release() {
        let (vm, mut escrow) = funded();
        mock_push(&vm, SELLER, 500);
        for who in [SELLER, STRANGER] {
            vm.set_sender(who);
            assert!(
                escrow.release(U256::from(1)).is_err(),
                "{who} must not release"
            );
        }
        assert!(take_moves().is_empty());
        vm.set_sender(ARBITER);
        assert!(escrow.release(U256::from(1)).is_ok());
        assert_eq!(take_moves(), vec![paid(&vm, SELLER, 500)]);
    }

    #[test]
    fn seller_or_arbiter_can_refund_any_time_but_the_buyer_only_after_the_deadline() {
        let (vm, mut escrow) = funded();
        mock_push(&vm, BUYER, 500);

        vm.set_sender(BUYER);
        assert!(
            escrow.refund(U256::from(1)).is_err(),
            "buyer cannot refund before the deadline"
        );
        vm.set_sender(STRANGER);
        assert!(escrow.refund(U256::from(1)).is_err());

        vm.set_block_timestamp(DEADLINE);
        vm.set_sender(STRANGER);
        assert!(
            escrow.refund(U256::from(1)).is_err(),
            "expiry does not open refunds to strangers"
        );
        vm.set_sender(BUYER);
        assert!(
            escrow.refund(U256::from(1)).is_ok(),
            "buyer can refund once the deadline has passed"
        );
        assert_eq!(take_moves(), vec![paid(&vm, BUYER, 500)]);
        assert_eq!(escrow.deal(U256::from(1)).5, REFUNDED);
    }

    #[test]
    fn seller_can_refund_before_the_deadline() {
        let (vm, mut escrow) = funded();
        mock_push(&vm, BUYER, 500);
        vm.set_sender(SELLER);
        assert!(escrow.refund(U256::from(1)).is_ok());
        assert_eq!(take_moves(), vec![paid(&vm, BUYER, 500)]);
    }

    #[test]
    fn a_deal_without_an_arbiter_is_not_controlled_by_the_zero_address() {
        let (vm, mut escrow) = deployed();
        vm.set_sender(BUYER);
        mock_pull(&vm, 10);
        assert!(
            escrow
                .create(
                    SELLER,
                    U256::from(10u64),
                    U256::from(DEADLINE),
                    Address::ZERO
                )
                .is_ok()
        );
        vm.set_sender(Address::ZERO);
        assert!(escrow.release(U256::from(1)).is_err());
        assert!(escrow.refund(U256::from(1)).is_err());
    }

    #[test]
    fn unknown_deals_are_rejected_and_a_failed_payout_surfaces_an_error() {
        let (vm, mut escrow) = funded();
        vm.set_sender(BUYER);
        assert!(escrow.release(U256::from(99)).is_err());
        assert!(escrow.release(U256::ZERO).is_err());

        let send = transferCall {
            to: SELLER,
            value: U256::from(500u64),
        };
        vm.mock_call(TOKEN, send.abi_encode(), U256::ZERO, Err(Vec::new()));
        // On a real chain the revert rolls the state change back; here we only assert the error surfaces.
        assert!(escrow.release(U256::from(1)).is_err());
    }
}

/// Model-based property test: random sequences of create / release / refund by random callers at random times are
/// checked against a reference model. Every token movement is recorded and compared with the model's exact
/// expectation, the contract's token balance is tracked from those movements and must equal the funded deals, and a
/// rejected call never changes a deal.
#[cfg(test)]
mod properties {
    use super::*;
    use proptest::prelude::*;
    use stylus_sdk::{alloy_primitives::address, alloy_sol_types::SolCall, testing::*};

    sol! {
        function transfer(address to, uint256 value) external returns (bool);
        function transferFrom(address from, address to, uint256 value) external returns (bool);
    }

    const TOKEN: Address = address!("0x7007000000000000000000000000000000001001");
    const ACTORS: [Address; 4] = [
        address!("0xA11CE00000000000000000000000000000000001"),
        address!("0xB0B0000000000000000000000000000000000002"),
        address!("0xCA40100000000000000000000000000000000003"),
        address!("0xD00D000000000000000000000000000000000004"),
    ];

    #[derive(Debug, Clone)]
    enum Op {
        Create {
            buyer: usize,
            seller: usize,
            arbiter: Option<usize>,
            amount: u64,
            deadline: u64,
        },
        Release {
            who: usize,
            id: u64,
        },
        Refund {
            who: usize,
            id: u64,
        },
        Advance {
            secs: u64,
        },
    }

    fn op() -> impl Strategy<Value = Op> {
        let a = 0..ACTORS.len();
        prop_oneof![
            (
                a.clone(),
                a.clone(),
                prop::option::of(a.clone()),
                0u64..1_000,
                0u64..400
            )
                .prop_map(|(buyer, seller, arbiter, amount, deadline)| Op::Create {
                    buyer,
                    seller,
                    arbiter,
                    amount,
                    deadline
                }),
            (a.clone(), 0u64..6).prop_map(|(who, id)| Op::Release { who, id }),
            (a, 0u64..6).prop_map(|(who, id)| Op::Refund { who, id }),
            (0u64..150).prop_map(|secs| Op::Advance { secs }),
        ]
    }

    fn yes() -> Vec<u8> {
        U256::from(1).to_be_bytes_vec()
    }

    #[derive(Clone, Debug, PartialEq)]
    struct Model {
        buyer: usize,
        seller: usize,
        arbiter: Option<usize>,
        amount: u64,
        deadline: u64,
        state: u8,
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]
        #[test]
        fn escrow_matches_a_reference_model(ops in prop::collection::vec(op(), 0..50)) {
            let vm = TestVM::default();
            let mut now = 100u64;
            vm.set_block_timestamp(now);
            let mut escrow = Escrow::from(&vm);
            prop_assert!(escrow.constructor(TOKEN).is_ok());

            let mut deals: Vec<Model> = Vec::new();
            let (mut locked, mut paid_out) = (0u64, 0u64);
            let this = vm.contract_address();
            let mut held: i128 = 0; // tokens the contract holds, from the recorded movements
            take_moves(); // drop anything left by an earlier case on this thread

            for op in ops {
                match op {
                    Op::Advance { secs } => {
                        now += secs;
                        vm.set_block_timestamp(now);
                    }
                    Op::Create { buyer, seller, arbiter, amount, deadline } => {
                        vm.set_sender(ACTORS[buyer]);
                        let pull = transferFromCall { from: ACTORS[buyer], to: vm.contract_address(), value: U256::from(amount) };
                        vm.mock_call(TOKEN, pull.abi_encode(), U256::ZERO, Ok(yes()));
                        let arbiter_addr = arbiter.map_or(Address::ZERO, |i| ACTORS[i]);
                        let result = escrow.create(ACTORS[seller], U256::from(amount), U256::from(deadline), arbiter_addr);
                        let should_pass = buyer != seller && amount > 0 && deadline > now;
                        prop_assert_eq!(result.is_ok(), should_pass);
                        let expected_moves = if should_pass { vec![(ACTORS[buyer], this, U256::from(amount))] } else { vec![] };
                        prop_assert_eq!(take_moves(), expected_moves);
                        if should_pass {
                            held += amount as i128;
                            prop_assert!(matches!(result, Ok(id) if id == U256::from(deals.len() as u64 + 1)));
                            deals.push(Model { buyer, seller, arbiter, amount, deadline, state: FUNDED });
                            locked += amount;
                        }
                    }
                    Op::Release { who, id } | Op::Refund { who, id } => {
                        let is_release = matches!(op, Op::Release { .. });
                        vm.set_sender(ACTORS[who]);
                        let idx = id.checked_sub(1).map(|i| i as usize).filter(|i| *i < deals.len());
                        let (to, amount) = match idx.map(|i| &deals[i]) {
                            Some(d) => (ACTORS[if is_release { d.seller } else { d.buyer }], d.amount),
                            None => (ACTORS[0], 0),
                        };
                        let send = transferCall { to, value: U256::from(amount) };
                        vm.mock_call(TOKEN, send.abi_encode(), U256::ZERO, Ok(yes()));
                        let before = escrow.deal(U256::from(id));

                        let expected = idx.map(|i| {
                            let d = &deals[i];
                            let is_arbiter = d.arbiter == Some(who);
                            d.state == FUNDED && if is_release {
                                who == d.buyer || is_arbiter
                            } else {
                                who == d.seller || is_arbiter || (who == d.buyer && now >= d.deadline)
                            }
                        }).unwrap_or(false);

                        let ok = if is_release { escrow.release(U256::from(id)) } else { escrow.refund(U256::from(id)) }.is_ok();
                        prop_assert_eq!(ok, expected);
                        let expected_moves = if ok { vec![(this, to, U256::from(amount))] } else { vec![] };
                        prop_assert_eq!(take_moves(), expected_moves);
                        if ok {
                            held -= amount as i128;
                            let d = &mut deals[idx.unwrap()];
                            d.state = if is_release { RELEASED } else { REFUNDED };
                            locked -= d.amount;
                            paid_out += d.amount;
                        } else {
                            prop_assert_eq!(escrow.deal(U256::from(id)), before, "a rejected call must not change the deal");
                        }
                    }
                }
                // Conservation: everything ever locked is either still funded or has been paid out exactly once.
                let still_funded: u64 = deals.iter().filter(|d| d.state == FUNDED).map(|d| d.amount).sum();
                prop_assert_eq!(still_funded, locked);
                prop_assert_eq!(held, locked as i128, "the contract holds exactly the funded deals");
                let created: u64 = deals.iter().map(|d| d.amount).sum();
                prop_assert_eq!(created, locked + paid_out);
                prop_assert_eq!(escrow.deal_count(), U256::from(deals.len() as u64));
            }
        }
    }
}
