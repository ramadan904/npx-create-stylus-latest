// Only run this as a WASM contract if the export-abi feature is not set.
#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

use alloc::vec::Vec;
use stylus_sdk::{
    alloy_primitives::{Address, I256, U256},
    alloy_sol_types::sol,
    prelude::*,
};

sol_interface! {
    interface IAggregatorV3 {
        function decimals() external view returns (uint8);
        function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
    }
}

sol! {
    error ZeroAddress();
    error InvalidConfig();
    error FeedUnavailable();
    error InvalidPrice(int256 answer);
    error IncompleteRound();
    error StalePrice(uint256 updatedAt, uint256 now, uint256 maxAge);
    error Overflow();
}

#[derive(SolidityError)]
pub enum OracleError {
    ZeroAddress(ZeroAddress),
    InvalidConfig(InvalidConfig),
    FeedUnavailable(FeedUnavailable),
    InvalidPrice(InvalidPrice),
    IncompleteRound(IncompleteRound),
    StalePrice(StalePrice),
    Overflow(Overflow),
}

sol_storage! {
    #[entrypoint]
    pub struct PriceOracle {
        address feed;
        uint8 feed_decimals;
        uint256 max_age;
    }
}

#[public]
impl PriceOracle {
    /// Runs once, atomically, at deploy time. `feed` is a Chainlink AggregatorV3 (for example ETH / USD), `decimals` its
    /// `decimals()` (8 for Chainlink's USD feeds; `decimalsMatch()` checks it), and `max_age` how old, in seconds, a
    /// price may be before it is refused (a feed's heartbeat plus a margin, e.g. 3600 + 600 for an hourly feed).
    /// The constructor calls nothing, so it deploys anywhere, including a dev node with no feed.
    #[constructor]
    pub fn constructor(
        &mut self,
        feed: Address,
        decimals: u8,
        max_age: U256,
    ) -> Result<(), OracleError> {
        if feed == Address::ZERO {
            return Err(OracleError::ZeroAddress(ZeroAddress {}));
        }
        if decimals > 36 || max_age.is_zero() {
            return Err(OracleError::InvalidConfig(InvalidConfig {}));
        }
        self.feed.set(feed);
        self.feed_decimals
            .set(stylus_sdk::alloy_primitives::Uint::from(decimals));
        self.max_age.set(max_age);
        Ok(())
    }

    pub fn feed(&self) -> Address {
        self.feed.get()
    }

    pub fn decimals(&self) -> u8 {
        self.feed_decimals.get().to::<u8>()
    }

    pub fn max_age(&self) -> U256 {
        self.max_age.get()
    }

    /// The feed's latest answer and when it was updated, refused if it cannot be trusted: a failed read, a round that
    /// never completed, a zero or negative price, or one older than `maxAge`. The answer has `decimals()` decimals.
    pub fn latest_price(&self) -> Result<(I256, U256), OracleError> {
        let feed = IAggregatorV3::new(self.feed.get());
        let (_round, answer, _started, updated_at, _answered) = feed
            .latest_round_data(self.vm(), Call::new())
            .map_err(|_| OracleError::FeedUnavailable(FeedUnavailable {}))?;
        if updated_at.is_zero() {
            return Err(OracleError::IncompleteRound(IncompleteRound {}));
        }
        if answer <= I256::ZERO {
            return Err(OracleError::InvalidPrice(InvalidPrice { answer }));
        }
        let now = U256::from(self.vm().block_timestamp());
        let max_age = self.max_age.get();
        if now.saturating_sub(updated_at) > max_age {
            return Err(OracleError::StalePrice(StalePrice {
                updatedAt: updated_at,
                now,
                maxAge: max_age,
            }));
        }
        Ok((answer, updated_at))
    }

    /// What `amount` of the priced asset is worth, with 18 decimals: for an ETH / USD feed, `valueOf(1e18, 18)` is the
    /// USD value of 1 ETH times 1e18. `amount_decimals` is the asset's own decimals (18 for ETH). Same checks as
    /// `latestPrice`; rounds down.
    pub fn value_of(&self, amount: U256, amount_decimals: u8) -> Result<U256, OracleError> {
        if amount_decimals > 36 {
            return Err(OracleError::InvalidConfig(InvalidConfig {}));
        }
        let (answer, _) = self.latest_price()?;
        let price = answer.into_raw(); // positive, checked above
        let scale = U256::from(10).pow(U256::from(18));
        let divisor = U256::from(10).pow(U256::from(amount_decimals) + U256::from(self.decimals()));
        amount
            .checked_mul(price)
            .and_then(|v| v.checked_mul(scale))
            .map(|v| v / divisor)
            .ok_or(OracleError::Overflow(Overflow {}))
    }

    /// Whether `decimals()` agrees with the feed's own `decimals()`. Check it once after deploying.
    pub fn decimals_match(&self) -> Result<bool, OracleError> {
        let feed = IAggregatorV3::new(self.feed.get());
        let actual = feed
            .decimals(self.vm(), Call::new())
            .map_err(|_| OracleError::FeedUnavailable(FeedUnavailable {}))?;
        Ok(actual == self.decimals())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use stylus_sdk::{
        alloy_primitives::address,
        alloy_sol_types::{SolCall, sol},
        testing::*,
    };

    sol! {
        function decimals() external view returns (uint8);
        function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
    }

    pub(crate) const FEED: Address = address!("0xFEED000000000000000000000000000000000001");
    pub(crate) const NOW: u64 = 1_800_000_000;

    /// The ABI encoding of latestRoundData's five return values.
    pub(crate) fn round(answer: I256, updated_at: u64) -> Vec<u8> {
        let mut out = Vec::new();
        for word in [
            U256::from(7),
            answer.into_raw(),
            U256::from(updated_at),
            U256::from(updated_at),
            U256::from(7),
        ] {
            out.extend_from_slice(&word.to_be_bytes::<32>());
        }
        out
    }

    /// Answers the next latestRoundData() read. The test VM serves the most recent mock, one call at a time.
    pub(crate) fn feed_says(vm: &TestVM, answer: I256, updated_at: u64) {
        vm.mock_static_call(
            FEED,
            latestRoundDataCall {}.abi_encode(),
            Ok(round(answer, updated_at)),
        );
    }

    fn deployed() -> (TestVM, PriceOracle) {
        let vm = TestVM::default();
        vm.set_block_timestamp(NOW);
        let mut oracle = PriceOracle::from(&vm);
        assert!(oracle.constructor(FEED, 8, U256::from(3600)).is_ok());
        (vm, oracle)
    }

    fn usd(dollars: i64) -> I256 {
        I256::try_from(dollars).unwrap_or_default()
            * I256::try_from(100_000_000i64).unwrap_or_default()
    }

    #[test]
    fn constructor_checks_its_configuration() {
        let (_vm, oracle) = deployed();
        assert_eq!(oracle.feed(), FEED);
        assert_eq!(oracle.decimals(), 8);
        assert_eq!(oracle.max_age(), U256::from(3600));
        let vm = TestVM::default();
        let mut bad = PriceOracle::from(&vm);
        assert!(matches!(
            bad.constructor(Address::ZERO, 8, U256::from(1)),
            Err(OracleError::ZeroAddress(_))
        ));
        assert!(matches!(
            bad.constructor(FEED, 37, U256::from(1)),
            Err(OracleError::InvalidConfig(_))
        ));
        assert!(matches!(
            bad.constructor(FEED, 8, U256::ZERO),
            Err(OracleError::InvalidConfig(_))
        ));
    }

    #[test]
    fn a_fresh_positive_price_is_returned() {
        let (vm, oracle) = deployed();
        feed_says(&vm, usd(3000), NOW - 60);
        let (answer, updated) = oracle.latest_price().ok().unwrap_or_default();
        assert_eq!(answer, usd(3000));
        assert_eq!(updated, U256::from(NOW - 60));
    }

    #[test]
    fn stale_zero_negative_and_incomplete_answers_are_refused() {
        let (vm, oracle) = deployed();
        feed_says(&vm, usd(3000), NOW - 3601);
        assert!(matches!(
            oracle.latest_price(),
            Err(OracleError::StalePrice(_))
        ));
        feed_says(&vm, I256::ZERO, NOW);
        assert!(matches!(
            oracle.latest_price(),
            Err(OracleError::InvalidPrice(_))
        ));
        feed_says(&vm, usd(-5), NOW);
        assert!(matches!(
            oracle.latest_price(),
            Err(OracleError::InvalidPrice(_))
        ));
        feed_says(&vm, usd(3000), 0);
        assert!(matches!(
            oracle.latest_price(),
            Err(OracleError::IncompleteRound(_))
        ));
        vm.mock_static_call(FEED, latestRoundDataCall {}.abi_encode(), Err(Vec::new()));
        assert!(matches!(
            oracle.latest_price(),
            Err(OracleError::FeedUnavailable(_))
        ));
    }

    #[test]
    fn value_of_converts_with_both_decimals() {
        let (vm, oracle) = deployed();
        feed_says(&vm, usd(3000), NOW);
        // 1.5 ETH (18 decimals) at $3000 = $4500, with 18 decimals
        let one_and_half = U256::from(15) * U256::from(10).pow(U256::from(17));
        let expect = U256::from(4500) * U256::from(10).pow(U256::from(18));
        assert_eq!(oracle.value_of(one_and_half, 18).ok(), Some(expect));
        // 2 units of a 6-decimals asset at $3000 = $6000
        assert_eq!(
            oracle.value_of(U256::from(2_000_000), 6).ok(),
            Some(U256::from(6000) * U256::from(10).pow(U256::from(18)))
        );
        assert!(matches!(
            oracle.value_of(U256::MAX, 18),
            Err(OracleError::Overflow(_))
        ));
        assert!(matches!(
            oracle.value_of(one_and_half, 37),
            Err(OracleError::InvalidConfig(_))
        ));
    }

    #[test]
    fn decimals_match_asks_the_feed() {
        let (vm, oracle) = deployed();
        vm.mock_static_call(
            FEED,
            decimalsCall {}.abi_encode(),
            Ok(U256::from(8).to_be_bytes_vec()),
        );
        assert_eq!(oracle.decimals_match().ok(), Some(true));
        vm.mock_static_call(
            FEED,
            decimalsCall {}.abi_encode(),
            Ok(U256::from(18).to_be_bytes_vec()),
        );
        assert_eq!(oracle.decimals_match().ok(), Some(false));
    }
}

/// Property-based tests: any answer, age and configuration, checked against a reference model of what the oracle must
/// accept, refuse and compute.
#[cfg(test)]
mod properties {
    use super::tests::{FEED, NOW, feed_says};
    use super::*;
    use proptest::prelude::*;
    use stylus_sdk::testing::*;

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(256))]

        #[test]
        fn accepts_exactly_fresh_positive_answers_and_values_them_exactly(
            answer in -1_000_000_000_000i64..1_000_000_000_000i64,
            age in 0u64..20_000,
            updated_zero in proptest::bool::weighted(0.05),
            max_age in 1u64..10_000,
            feed_decimals in 0u8..=18,
            amount in 0u128..1_000_000_000_000_000_000_000u128,
            amount_decimals in 0u8..=18,
        ) {
            let vm = TestVM::default();
            vm.set_block_timestamp(NOW);
            let mut oracle = PriceOracle::from(&vm);
            prop_assert!(oracle.constructor(FEED, feed_decimals, U256::from(max_age)).is_ok());
            let updated = if updated_zero { 0 } else { NOW - age };
            let answer = I256::try_from(answer).unwrap_or_default();

            feed_says(&vm, answer, updated);
            let got = oracle.latest_price();
            let fresh = updated != 0 && age <= max_age;
            prop_assert_eq!(got.is_ok(), fresh && answer > I256::ZERO);
            if let Ok((a, u)) = got {
                prop_assert_eq!(a, answer);
                prop_assert_eq!(u, U256::from(updated));
            }

            feed_says(&vm, answer, updated);
            let value = oracle.value_of(U256::from(amount), amount_decimals);
            if fresh && answer > I256::ZERO {
                // reference: amount * price * 10^18 / 10^(amount_decimals + feed_decimals), in plain U256 arithmetic
                let expect = U256::from(amount) * answer.into_raw() * U256::from(10).pow(U256::from(18))
                    / U256::from(10).pow(U256::from(amount_decimals as u64 + feed_decimals as u64));
                prop_assert_eq!(value.ok(), Some(expect));
            } else {
                prop_assert!(value.is_err());
            }
        }
    }
}
