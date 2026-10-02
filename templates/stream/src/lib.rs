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
    event StreamCreated(uint256 indexed id, address indexed sender, address indexed recipient, uint256 amount, uint256 start, uint256 stop);
    event Withdrawn(uint256 indexed id, address indexed recipient, uint256 amount);
    event Cancelled(uint256 indexed id, uint256 toRecipient, uint256 toSender);

    error ZeroAddress();
    error ZeroAmount();
    error SelfStream();
    error StartInPast(uint256 start, uint256 now);
    error BadTimeRange(uint256 start, uint256 stop);
    error AmountTooLarge();
    error NoSuchStream(uint256 id);
    error NotActive(uint256 id);
    error NotAuthorized();
    error NothingToWithdraw(uint256 id);
    error TokenTransferFailed();
}

#[derive(SolidityError)]
pub enum StreamError {
    ZeroAddress(ZeroAddress),
    ZeroAmount(ZeroAmount),
    SelfStream(SelfStream),
    StartInPast(StartInPast),
    BadTimeRange(BadTimeRange),
    AmountTooLarge(AmountTooLarge),
    NoSuchStream(NoSuchStream),
    NotActive(NotActive),
    NotAuthorized(NotAuthorized),
    NothingToWithdraw(NothingToWithdraw),
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

/// A stream is active until it is cancelled. A fully paid-out stream stays active with nothing left to withdraw.
pub const ACTIVE: u8 = 1;
pub const CANCELLED: u8 = 2;

sol_storage! {
    #[entrypoint]
    pub struct Stream {
        address token;
        uint256 next_id;
        mapping(uint256 => address) senders;
        mapping(uint256 => address) recipients;
        mapping(uint256 => uint256) deposits;
        mapping(uint256 => uint256) starts;
        mapping(uint256 => uint256) stops;
        mapping(uint256 => uint256) withdrawn;
        mapping(uint256 => uint8) states;
    }
}

#[public]
impl Stream {
    /// Runs once, atomically, at deploy time: fixes the ERC-20 this contract streams (USDC, USDG, ...).
    #[constructor]
    pub fn constructor(&mut self, token: Address) -> Result<(), Vec<u8>> {
        if token == Address::ZERO {
            return Err(StreamError::ZeroAddress(ZeroAddress {}).into());
        }
        self.token.set(token);
        // Ids start at 1 so that id 0 is never a real stream.
        self.next_id.set(U256::from(1));
        Ok(())
    }

    pub fn token(&self) -> Address {
        self.token.get()
    }

    pub fn stream_count(&self) -> U256 {
        self.next_id.get() - U256::from(1)
    }

    /// `(sender, recipient, deposit, start, stop, withdrawn, state)`; state is 1 active, 2 cancelled, 0 unknown.
    pub fn stream(&self, id: U256) -> (Address, Address, U256, U256, U256, U256, u8) {
        (
            self.senders.get(id),
            self.recipients.get(id),
            self.deposits.get(id),
            self.starts.get(id),
            self.stops.get(id),
            self.withdrawn.get(id),
            self.state(id),
        )
    }

    /// How much of the deposit has been earned by the recipient so far: nothing before `start`, everything from
    /// `stop`, and linear in between (rounded down, so the last second always completes the exact deposit).
    /// For a cancelled stream this is what the recipient actually received.
    pub fn streamed(&self, id: U256) -> U256 {
        match self.state(id) {
            0 => U256::ZERO,
            CANCELLED => self.withdrawn.get(id),
            _ => self.earned(id),
        }
    }

    /// What the recipient could withdraw right now.
    pub fn withdrawable(&self, id: U256) -> U256 {
        if self.state(id) != ACTIVE {
            return U256::ZERO;
        }
        self.earned(id) - self.withdrawn.get(id)
    }

    /// The caller (sender) locks `amount` of the token, to be paid to `recipient` linearly between `start` and
    /// `stop` (unix seconds). The sender must `approve` this contract first. Returns the stream id.
    pub fn create(
        &mut self,
        recipient: Address,
        amount: U256,
        start: U256,
        stop: U256,
    ) -> Result<U256, StreamError> {
        let sender = self.vm().msg_sender();
        if recipient == Address::ZERO {
            return Err(StreamError::ZeroAddress(ZeroAddress {}));
        }
        if recipient == sender {
            return Err(StreamError::SelfStream(SelfStream {}));
        }
        if amount.is_zero() {
            return Err(StreamError::ZeroAmount(ZeroAmount {}));
        }
        let now = U256::from(self.vm().block_timestamp());
        if start < now {
            return Err(StreamError::StartInPast(StartInPast { start, now }));
        }
        if stop <= start {
            return Err(StreamError::BadTimeRange(BadTimeRange { start, stop }));
        }
        // Checked once here so that `earned` can multiply without ever overflowing.
        if amount.checked_mul(stop - start).is_none() {
            return Err(StreamError::AmountTooLarge(AmountTooLarge {}));
        }

        // Effects before interaction: record the stream, then pull the funds.
        let id = self.next_id.get();
        self.next_id.set(id + U256::from(1));
        self.senders.setter(id).set(sender);
        self.recipients.setter(id).set(recipient);
        self.deposits.setter(id).set(amount);
        self.starts.setter(id).set(start);
        self.stops.setter(id).set(stop);
        self.set_state(id, ACTIVE);

        let this = self.vm().contract_address();
        self.pull(sender, this, amount)?;
        self.vm().log(StreamCreated {
            id,
            sender,
            recipient,
            amount,
            start,
            stop,
        });
        Ok(id)
    }

    /// Pay out everything earned and not yet withdrawn. Anyone may call this (a keeper, the sender, an agent); the
    /// tokens always go to the recipient, so there is nothing to steal by calling it.
    pub fn withdraw(&mut self, id: U256) -> Result<U256, StreamError> {
        self.require_active(id)?;
        let due = self.withdrawable(id);
        if due.is_zero() {
            return Err(StreamError::NothingToWithdraw(NothingToWithdraw { id }));
        }
        let recipient = self.recipients.get(id);
        let total = self.withdrawn.get(id) + due;
        self.withdrawn.setter(id).set(total);
        self.push(recipient, due)?;
        self.vm().log(Withdrawn {
            id,
            recipient,
            amount: due,
        });
        Ok(due)
    }

    /// Stop the stream. The recipient receives what has been earned and not yet withdrawn, the sender gets the rest
    /// of the deposit back. Allowed for the sender or the recipient.
    pub fn cancel(&mut self, id: U256) -> Result<(), StreamError> {
        self.require_active(id)?;
        let caller = self.vm().msg_sender();
        let (sender, recipient) = (self.senders.get(id), self.recipients.get(id));
        if caller != sender && caller != recipient {
            return Err(StreamError::NotAuthorized(NotAuthorized {}));
        }
        let earned = self.earned(id);
        let to_recipient = earned - self.withdrawn.get(id);
        let to_sender = self.deposits.get(id) - earned;

        // After this, `streamed` reports exactly what the recipient received over the stream's life.
        self.withdrawn.setter(id).set(earned);
        self.set_state(id, CANCELLED);
        if !to_recipient.is_zero() {
            self.push(recipient, to_recipient)?;
        }
        if !to_sender.is_zero() {
            self.push(sender, to_sender)?;
        }
        self.vm().log(Cancelled {
            id,
            toRecipient: to_recipient,
            toSender: to_sender,
        });
        Ok(())
    }
}

impl Stream {
    fn state(&self, id: U256) -> u8 {
        self.states.get(id).to::<u8>()
    }

    fn set_state(&mut self, id: U256, state: u8) {
        self.states.setter(id).set(U8::from(state));
    }

    fn require_active(&self, id: U256) -> Result<(), StreamError> {
        match self.state(id) {
            0 => Err(StreamError::NoSuchStream(NoSuchStream { id })),
            ACTIVE => Ok(()),
            _ => Err(StreamError::NotActive(NotActive { id })),
        }
    }

    /// Linear vesting of the deposit. `create` guarantees `deposit * (stop - start)` fits in a U256, and
    /// `elapsed <= duration` here, so the multiplication cannot overflow.
    fn earned(&self, id: U256) -> U256 {
        let now = U256::from(self.vm().block_timestamp());
        let (start, stop) = (self.starts.get(id), self.stops.get(id));
        let deposit = self.deposits.get(id);
        if now <= start {
            U256::ZERO
        } else if now >= stop {
            deposit
        } else {
            deposit * (now - start) / (stop - start)
        }
    }

    fn pull(&mut self, from: Address, to: Address, amount: U256) -> Result<(), StreamError> {
        #[cfg(test)]
        MOVES.with(|m| m.borrow_mut().push((from, to, amount)));
        let token = IERC20::new(self.token.get());
        let call = Call::new_mutating(self);
        let ok = token
            .transfer_from(self.vm(), call, from, to, amount)
            .map_err(|_| StreamError::TokenTransferFailed(TokenTransferFailed {}))?;
        if ok {
            Ok(())
        } else {
            Err(StreamError::TokenTransferFailed(TokenTransferFailed {}))
        }
    }

    fn push(&mut self, to: Address, amount: U256) -> Result<(), StreamError> {
        #[cfg(test)]
        MOVES.with(|m| {
            let this = self.vm().contract_address();
            m.borrow_mut().push((this, to, amount));
        });
        let token = IERC20::new(self.token.get());
        let call = Call::new_mutating(self);
        let ok = token
            .transfer(self.vm(), call, to, amount)
            .map_err(|_| StreamError::TokenTransferFailed(TokenTransferFailed {}))?;
        if ok {
            Ok(())
        } else {
            Err(StreamError::TokenTransferFailed(TokenTransferFailed {}))
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
    const PAYER: Address = address!("0xA11CE00000000000000000000000000000000001");
    const PAYEE: Address = address!("0xB0B0000000000000000000000000000000000002");
    const STRANGER: Address = address!("0x57A4C3E000000000000000000000000000000004");
    const START: u64 = 1_000;
    const STOP: u64 = 2_000;
    const AMOUNT: u64 = 1_000; // one token unit per second

    fn yes() -> Vec<u8> {
        U256::from(1).to_be_bytes_vec()
    }

    fn deployed() -> (TestVM, Stream) {
        let vm = TestVM::default();
        vm.set_block_timestamp(100);
        let mut stream = Stream::from(&vm);
        assert!(stream.constructor(TOKEN).is_ok());
        (vm, stream)
    }

    fn mock_pull(vm: &TestVM, amount: u64) {
        let call = transferFromCall {
            from: PAYER,
            to: vm.contract_address(),
            value: U256::from(amount),
        };
        vm.mock_call(TOKEN, call.abi_encode(), U256::ZERO, Ok(yes()));
    }

    fn mock_push(vm: &TestVM, to: Address, amount: u64) {
        let call = transferCall {
            to,
            value: U256::from(amount),
        };
        vm.mock_call(TOKEN, call.abi_encode(), U256::ZERO, Ok(yes()));
    }

    /// Stream 1: PAYER streams 1000 to PAYEE over seconds 1000..2000, created at t=100.
    fn funded() -> (TestVM, Stream) {
        let (vm, mut stream) = deployed();
        vm.set_sender(PAYER);
        mock_pull(&vm, AMOUNT);
        let id = stream
            .create(
                PAYEE,
                U256::from(AMOUNT),
                U256::from(START),
                U256::from(STOP),
            )
            .unwrap_or_else(|_| panic!("create failed"));
        assert_eq!(id, U256::from(1));
        assert_eq!(
            take_moves(),
            vec![(PAYER, vm.contract_address(), U256::from(AMOUNT))]
        );
        (vm, stream)
    }

    fn paid(vm: &TestVM, to: Address, amount: u64) -> (Address, Address, U256) {
        (vm.contract_address(), to, U256::from(amount))
    }

    #[test]
    fn constructor_sets_the_token_and_rejects_zero() {
        let (vm, stream) = deployed();
        assert_eq!(stream.token(), TOKEN);
        assert_eq!(stream.stream_count(), U256::ZERO);
        let mut fresh = Stream::from(&vm);
        assert!(fresh.constructor(Address::ZERO).is_err());
    }

    #[test]
    fn create_locks_funds_and_records_the_stream() {
        let (_vm, stream) = funded();
        let (sender, recipient, deposit, start, stop, withdrawn, state) =
            stream.stream(U256::from(1));
        assert_eq!((sender, recipient), (PAYER, PAYEE));
        assert_eq!(
            (deposit, start, stop),
            (U256::from(AMOUNT), U256::from(START), U256::from(STOP))
        );
        assert_eq!((withdrawn, state), (U256::ZERO, ACTIVE));
        assert_eq!(stream.stream_count(), U256::from(1));
    }

    #[test]
    fn create_rejects_bad_input_and_a_failed_pull() {
        let (vm, mut stream) = deployed();
        vm.set_sender(PAYER);
        let amount = U256::from(5u64);
        let (start, stop) = (U256::from(START), U256::from(STOP));
        assert!(stream.create(Address::ZERO, amount, start, stop).is_err());
        assert!(stream.create(PAYER, amount, start, stop).is_err());
        assert!(stream.create(PAYEE, U256::ZERO, start, stop).is_err());
        assert!(
            stream
                .create(PAYEE, amount, U256::from(99u64), stop)
                .is_err(),
            "start in the past"
        );
        assert!(
            stream.create(PAYEE, amount, start, start).is_err(),
            "empty range"
        );
        assert!(
            stream.create(PAYEE, amount, stop, start).is_err(),
            "reversed range"
        );
        assert!(
            stream.create(PAYEE, U256::MAX, start, stop).is_err(),
            "amount * duration must not overflow"
        );

        let pull = transferFromCall {
            from: PAYER,
            to: vm.contract_address(),
            value: amount,
        };
        vm.mock_call(TOKEN, pull.abi_encode(), U256::ZERO, Err(Vec::new()));
        assert!(stream.create(PAYEE, amount, start, stop).is_err());
    }

    #[test]
    fn vesting_is_zero_before_start_linear_in_between_and_complete_at_stop() {
        let (vm, stream) = funded();
        let id = U256::from(1);
        for (now, expected) in [
            (100, 0),
            (START, 0),
            (START + 1, 1),
            (1_500, 500),
            (STOP - 1, 999),
            (STOP, 1_000),
            (9_999, 1_000),
        ] {
            vm.set_block_timestamp(now);
            assert_eq!(stream.streamed(id), U256::from(expected), "at t={now}");
        }
    }

    #[test]
    fn vesting_rounds_down_but_always_completes_the_exact_deposit() {
        let (vm, mut stream) = deployed();
        vm.set_sender(PAYER);
        mock_pull(&vm, 10);
        // 10 units over 3 seconds: 3, 6, then the full 10 (not 9).
        assert!(
            stream
                .create(
                    PAYEE,
                    U256::from(10u64),
                    U256::from(200u64),
                    U256::from(203u64)
                )
                .is_ok()
        );
        for (now, expected) in [(201, 3), (202, 6), (203, 10)] {
            vm.set_block_timestamp(now);
            assert_eq!(stream.streamed(U256::from(1)), U256::from(expected));
        }
    }

    #[test]
    fn anyone_can_trigger_a_withdrawal_but_only_the_recipient_is_paid() {
        let (vm, mut stream) = funded();
        let id = U256::from(1);
        vm.set_sender(STRANGER);
        vm.set_block_timestamp(START);
        assert!(stream.withdraw(id).is_err(), "nothing earned yet");

        vm.set_block_timestamp(1_250);
        mock_push(&vm, PAYEE, 250);
        assert!(matches!(stream.withdraw(id), Ok(due) if due == U256::from(250u64)));
        assert_eq!(take_moves(), vec![paid(&vm, PAYEE, 250)]);
        assert!(stream.withdraw(id).is_err(), "nothing new has been earned");
        assert!(
            take_moves().is_empty(),
            "a rejected withdrawal moves nothing"
        );
        assert_eq!(stream.withdrawable(id), U256::ZERO);

        vm.set_block_timestamp(STOP);
        mock_push(&vm, PAYEE, 750);
        assert!(matches!(stream.withdraw(id), Ok(due) if due == U256::from(750u64)));
        assert_eq!(take_moves(), vec![paid(&vm, PAYEE, 750)]);
        assert!(stream.withdraw(id).is_err(), "fully paid out");
        assert_eq!(stream.streamed(id), U256::from(AMOUNT));
    }

    #[test]
    fn cancelling_splits_what_is_earned_from_what_is_left() {
        let (vm, mut stream) = funded();
        let id = U256::from(1);
        vm.set_block_timestamp(1_250);
        mock_push(&vm, PAYEE, 250);
        assert!(stream.withdraw(id).is_ok());
        take_moves();

        vm.set_block_timestamp(1_400);
        mock_push(&vm, PAYEE, 150); // earned 400, already withdrew 250
        mock_push(&vm, PAYER, 600); // 1000 - 400
        vm.set_sender(PAYEE);
        assert!(stream.cancel(id).is_ok());
        assert_eq!(
            take_moves(),
            vec![paid(&vm, PAYEE, 150), paid(&vm, PAYER, 600)],
            "recipient gets earned-minus-withdrawn, sender gets deposit-minus-earned"
        );
        assert_eq!(stream.stream(id).6, CANCELLED);
        assert_eq!(
            stream.streamed(id),
            U256::from(400u64),
            "what the recipient received in total"
        );
        assert_eq!(stream.withdrawable(id), U256::ZERO);

        // A cancelled stream is final, and time passing does not revive it.
        vm.set_block_timestamp(STOP);
        assert!(stream.withdraw(id).is_err());
        vm.set_sender(PAYER);
        assert!(stream.cancel(id).is_err());
        assert_eq!(stream.streamed(id), U256::from(400u64));
    }

    #[test]
    fn cancelling_before_the_start_refunds_everything_to_the_sender() {
        let (vm, mut stream) = funded();
        mock_push(&vm, PAYER, AMOUNT);
        vm.set_sender(PAYER);
        assert!(stream.cancel(U256::from(1)).is_ok());
        assert_eq!(take_moves(), vec![paid(&vm, PAYER, AMOUNT)]);
        assert_eq!(stream.streamed(U256::from(1)), U256::ZERO);
    }

    #[test]
    fn only_the_sender_or_recipient_can_cancel() {
        let (vm, mut stream) = funded();
        vm.set_sender(STRANGER);
        assert!(stream.cancel(U256::from(1)).is_err());
        assert_eq!(stream.stream(U256::from(1)).6, ACTIVE);
    }

    #[test]
    fn unknown_streams_and_failed_payouts_surface_errors() {
        let (vm, mut stream) = funded();
        vm.set_sender(PAYER);
        assert!(stream.withdraw(U256::from(99u64)).is_err());
        assert!(stream.cancel(U256::ZERO).is_err());

        vm.set_block_timestamp(1_500);
        let send = transferCall {
            to: PAYEE,
            value: U256::from(500u64),
        };
        vm.mock_call(TOKEN, send.abi_encode(), U256::ZERO, Err(Vec::new()));
        // On a real chain the revert rolls the state change back; here we only assert the error surfaces.
        assert!(stream.withdraw(U256::from(1)).is_err());
    }
}

/// Model-based property test: random sequences of create / withdraw / cancel / time travel by random callers are
/// checked against a reference model. Every token movement is recorded and compared with the model's exact expectation,
/// the contract's token balance is tracked from those movements, vesting never decreases, and a stream never pays out
/// more than its deposit.
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
    const ACTORS: [Address; 3] = [
        address!("0xA11CE00000000000000000000000000000000001"),
        address!("0xB0B0000000000000000000000000000000000002"),
        address!("0xCA40100000000000000000000000000000000003"),
    ];

    #[derive(Debug, Clone)]
    enum Op {
        Create {
            sender: usize,
            recipient: usize,
            amount: u64,
            start_in: u64,
            duration: u64,
        },
        Withdraw {
            who: usize,
            id: u64,
        },
        Cancel {
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
            (a.clone(), a.clone(), 0u64..5_000, 0u64..200, 0u64..300).prop_map(
                |(sender, recipient, amount, start_in, duration)| Op::Create {
                    sender,
                    recipient,
                    amount,
                    start_in,
                    duration
                }
            ),
            (a.clone(), 0u64..5).prop_map(|(who, id)| Op::Withdraw { who, id }),
            (a, 0u64..5).prop_map(|(who, id)| Op::Cancel { who, id }),
            (0u64..120).prop_map(|secs| Op::Advance { secs }),
        ]
    }

    fn yes() -> Vec<u8> {
        U256::from(1).to_be_bytes_vec()
    }

    fn mock_push(vm: &TestVM, to: Address, amount: u64) {
        let call = transferCall {
            to,
            value: U256::from(amount),
        };
        vm.mock_call(TOKEN, call.abi_encode(), U256::ZERO, Ok(yes()));
    }

    #[derive(Clone, Debug)]
    struct Model {
        sender: usize,
        recipient: usize,
        deposit: u64,
        start: u64,
        stop: u64,
        withdrawn: u64,
        cancelled: bool,
    }

    impl Model {
        fn earned(&self, now: u64) -> u64 {
            if now <= self.start {
                0
            } else if now >= self.stop {
                self.deposit
            } else {
                (self.deposit as u128 * (now - self.start) as u128
                    / (self.stop - self.start) as u128) as u64
            }
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]
        #[test]
        fn stream_matches_a_reference_model(ops in prop::collection::vec(op(), 0..50)) {
            let vm = TestVM::default();
            let mut now = 100u64;
            vm.set_block_timestamp(now);
            let mut stream = Stream::from(&vm);
            prop_assert!(stream.constructor(TOKEN).is_ok());

            let mut model: Vec<Model> = Vec::new();
            let mut last_streamed: Vec<u64> = Vec::new();
            let this = vm.contract_address();
            let mut held: i128 = 0; // tokens the contract holds, from the recorded movements

            for op in ops {
                match op {
                    Op::Advance { secs } => {
                        now += secs;
                        vm.set_block_timestamp(now);
                    }
                    Op::Create { sender, recipient, amount, start_in, duration } => {
                        vm.set_sender(ACTORS[sender]);
                        let start = now + start_in;
                        let stop = start + duration;
                        let pull = transferFromCall { from: ACTORS[sender], to: vm.contract_address(), value: U256::from(amount) };
                        vm.mock_call(TOKEN, pull.abi_encode(), U256::ZERO, Ok(yes()));
                        let result = stream.create(ACTORS[recipient], U256::from(amount), U256::from(start), U256::from(stop));
                        let should_pass = sender != recipient && amount > 0 && duration > 0;
                        prop_assert_eq!(result.is_ok(), should_pass);
                        let expected_moves = if should_pass { vec![(ACTORS[sender], this, U256::from(amount))] } else { vec![] };
                        prop_assert_eq!(take_moves(), expected_moves);
                        if should_pass {
                            held += amount as i128;
                            prop_assert!(matches!(result, Ok(id) if id == U256::from(model.len() as u64 + 1)));
                            model.push(Model { sender, recipient, deposit: amount, start, stop, withdrawn: 0, cancelled: false });
                            last_streamed.push(0);
                        }
                    }
                    Op::Withdraw { who, id } => {
                        vm.set_sender(ACTORS[who]);
                        let idx = id.checked_sub(1).map(|i| i as usize).filter(|i| *i < model.len());
                        let due = idx.map(|i| {
                            let m = &model[i];
                            if m.cancelled { 0 } else { m.earned(now) - m.withdrawn }
                        }).unwrap_or(0);
                        if let Some(i) = idx {
                            mock_push(&vm, ACTORS[model[i].recipient], due);
                        }
                        let result = stream.withdraw(U256::from(id));
                        prop_assert_eq!(result.is_ok(), due > 0, "withdraw outcome");
                        let expected_moves = match idx {
                            Some(i) if due > 0 => vec![(this, ACTORS[model[i].recipient], U256::from(due))],
                            _ => vec![],
                        };
                        prop_assert_eq!(take_moves(), expected_moves);
                        if due > 0 {
                            held -= due as i128;
                            prop_assert!(matches!(result, Ok(paid) if paid == U256::from(due)));
                            model[idx.unwrap()].withdrawn += due;
                        }
                    }
                    Op::Cancel { who, id } => {
                        vm.set_sender(ACTORS[who]);
                        let idx = id.checked_sub(1).map(|i| i as usize).filter(|i| *i < model.len());
                        let expected = idx.map(|i| {
                            let m = &model[i];
                            !m.cancelled && (who == m.sender || who == m.recipient)
                        }).unwrap_or(false);
                        if let Some(i) = idx {
                            let m = &model[i];
                            let earned = m.earned(now);
                            if earned > m.withdrawn {
                                mock_push(&vm, ACTORS[m.recipient], earned - m.withdrawn);
                            }
                            if m.deposit > earned {
                                mock_push(&vm, ACTORS[m.sender], m.deposit - earned);
                            }
                        }
                        let ok = stream.cancel(U256::from(id)).is_ok();
                        prop_assert_eq!(ok, expected, "cancel outcome");
                        let mut expected_moves = vec![];
                        if let (true, Some(i)) = (ok, idx) {
                            let m = &model[i];
                            let earned = m.earned(now);
                            if earned > m.withdrawn {
                                expected_moves.push((this, ACTORS[m.recipient], U256::from(earned - m.withdrawn)));
                            }
                            if m.deposit > earned {
                                expected_moves.push((this, ACTORS[m.sender], U256::from(m.deposit - earned)));
                            }
                            held -= (m.deposit - m.withdrawn) as i128;
                        }
                        prop_assert_eq!(take_moves(), expected_moves);
                        if ok {
                            let m = &mut model[idx.unwrap()];
                            m.withdrawn = m.earned(now);
                            m.cancelled = true;
                        }
                    }
                }

                prop_assert_eq!(stream.stream_count(), U256::from(model.len() as u64));
                // Conservation from real token flow: the contract holds exactly the unpaid part of live streams.
                let owed: u64 = model.iter().filter(|m| !m.cancelled).map(|m| m.deposit - m.withdrawn).sum();
                prop_assert_eq!(held, owed as i128);
                for (i, m) in model.iter().enumerate() {
                    let id = U256::from(i as u64 + 1);
                    let streamed = stream.streamed(id);
                    let expect = if m.cancelled { m.withdrawn } else { m.earned(now) };
                    prop_assert_eq!(streamed, U256::from(expect));
                    // never decreases, never exceeds the deposit, and the recipient never got more than was earned
                    prop_assert!(streamed >= U256::from(last_streamed[i]));
                    prop_assert!(streamed <= U256::from(m.deposit));
                    prop_assert!(m.withdrawn <= expect);
                    last_streamed[i] = expect;
                    let (_, _, _, _, _, withdrawn, _) = stream.stream(id);
                    prop_assert_eq!(withdrawn, U256::from(m.withdrawn));
                }
            }
        }
    }
}
