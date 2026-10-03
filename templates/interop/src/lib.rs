// Only run this as a WASM contract if the export-abi feature is not set.
#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

use stylus_sdk::{
    alloy_primitives::{U256, U512},
    alloy_sol_types::sol,
    prelude::*,
};

sol! {
    // Solidity sees these by name: `catch (bytes memory reason)` gets the same 4-byte selector, and a call that is not
    // caught bubbles them up unchanged (see solidity/Consumer.sol).
    error DivisionByZero();
    error MulDivOverflow(uint256 a, uint256 b, uint256 denominator);
}

#[derive(SolidityError)]
pub enum MathError {
    DivisionByZero(DivisionByZero),
    MulDivOverflow(MulDivOverflow),
}

/// Exact 256-bit math for Solidity contracts to call. Stateless: deploy it once, then any contract on the chain can use
/// it through an ordinary Solidity interface, like a library that runs as compiled Rust.
#[storage]
#[entrypoint]
pub struct MathLib {}

#[public]
impl MathLib {
    /// `a * b / denominator`, rounded down, computed with a 512-bit intermediate: correct even when `a * b` does not
    /// fit in 256 bits, which is where `a * b / d` in Solidity overflows (prices, shares, fees, interest).
    /// Reverts with `DivisionByZero` or, when the result itself does not fit, `MulDivOverflow(a, b, denominator)`.
    pub fn mul_div(&self, a: U256, b: U256, denominator: U256) -> Result<U256, MathError> {
        let (quotient, _) = Self::div_512(a, b, denominator)?;
        Ok(quotient)
    }

    /// Like `mulDiv`, rounded up: what a protocol charges when rounding must never favour the caller.
    pub fn mul_div_up(&self, a: U256, b: U256, denominator: U256) -> Result<U256, MathError> {
        let (quotient, exact) = Self::div_512(a, b, denominator)?;
        if exact {
            return Ok(quotient);
        }
        quotient
            .checked_add(U256::from(1))
            .ok_or(MathError::MulDivOverflow(MulDivOverflow {
                a,
                b,
                denominator,
            }))
    }

    /// The integer square root: the largest `r` with `r * r <= n`.
    pub fn isqrt(&self, n: U256) -> U256 {
        if n < U256::from(2) {
            return n;
        }
        // Newton's method from a first guess at or above the root, 2^ceil(bits / 2); it then only decreases.
        let mut x = U256::from(1) << n.bit_len().div_ceil(2);
        loop {
            let y = (x + n / x) >> 1;
            if y >= x {
                return x;
            }
            x = y;
        }
    }
}

impl MathLib {
    /// `a * b / denominator` in 512 bits: the 256-bit quotient, and whether the division was exact.
    fn div_512(a: U256, b: U256, denominator: U256) -> Result<(U256, bool), MathError> {
        if denominator.is_zero() {
            return Err(MathError::DivisionByZero(DivisionByZero {}));
        }
        let product: U512 = a.widening_mul(b);
        let (quotient, remainder) = product.div_rem(U512::from(denominator));
        let quotient = U256::checked_from_limbs_slice(quotient.as_limbs()).ok_or(
            MathError::MulDivOverflow(MulDivOverflow { a, b, denominator }),
        )?;
        Ok((quotient, remainder.is_zero()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use stylus_sdk::testing::*;

    fn lib() -> MathLib {
        MathLib::from(&TestVM::default())
    }

    fn n(v: u128) -> U256 {
        U256::from(v)
    }

    #[test]
    fn mul_div_is_exact_where_solidity_overflows() {
        let m = lib();
        assert_eq!(m.mul_div(n(10), n(3), n(4)).ok(), Some(n(7)));
        assert_eq!(m.mul_div_up(n(10), n(3), n(4)).ok(), Some(n(8)));
        assert_eq!(m.mul_div_up(n(10), n(4), n(4)).ok(), Some(n(10)));
        // MAX * MAX overflows 256 bits, yet MAX * MAX / MAX is MAX.
        assert_eq!(
            m.mul_div(U256::MAX, U256::MAX, U256::MAX).ok(),
            Some(U256::MAX)
        );
        // 1e18 tokens at a price of 3e30 (a 30-decimal price), scaled back by 1e30.
        let wad = n(10u128.pow(18));
        let price = n(3) * n(10u128.pow(30));
        assert_eq!(
            m.mul_div(wad, price, n(10u128.pow(30))).ok(),
            Some(n(3) * wad)
        );
    }

    #[test]
    fn mul_div_names_its_errors() {
        let m = lib();
        assert!(matches!(
            m.mul_div(n(1), n(1), U256::ZERO),
            Err(MathError::DivisionByZero(_))
        ));
        assert!(matches!(
            m.mul_div_up(n(1), n(1), U256::ZERO),
            Err(MathError::DivisionByZero(_))
        ));
        assert!(matches!(
            m.mul_div(U256::MAX, n(2), n(1)),
            Err(MathError::MulDivOverflow(MulDivOverflow { a, b, denominator }))
                if a == U256::MAX && b == n(2) && denominator == n(1)
        ));
        // MAX itself fits rounded down; rounding up past it does not.
        assert_eq!(m.mul_div(U256::MAX, n(2), n(2)).ok(), Some(U256::MAX));
        assert!(matches!(
            m.mul_div_up(U256::MAX, U256::MAX, U256::MAX - n(1)),
            Err(MathError::MulDivOverflow(_))
        ));
    }

    #[test]
    fn isqrt_handles_the_edges() {
        let m = lib();
        for (input, root) in [
            (0u128, 0u128),
            (1, 1),
            (2, 1),
            (3, 1),
            (4, 2),
            (15, 3),
            (16, 4),
            (17, 4),
        ] {
            assert_eq!(m.isqrt(n(input)), n(root), "isqrt({input})");
        }
        let max_root = U256::from(u128::MAX); // floor(sqrt(2^256 - 1)) = 2^128 - 1
        assert_eq!(m.isqrt(U256::MAX), max_root);
        assert_eq!(m.isqrt(max_root * max_root), max_root);
        assert_eq!(m.isqrt(max_root * max_root - n(1)), max_root - n(1));
    }
}

#[cfg(test)]
mod properties {
    use super::*;
    use proptest::prelude::*;
    use stylus_sdk::testing::*;

    // Any U256, weighted towards the edges where math breaks: zero, one, small values and values near 2^256.
    fn word() -> impl Strategy<Value = U256> {
        prop_oneof![
            Just(U256::ZERO),
            Just(U256::from(1)),
            Just(U256::MAX),
            any::<u64>().prop_map(U256::from),
            any::<[u64; 4]>().prop_map(U256::from_limbs),
            any::<u64>().prop_map(|k| U256::MAX - U256::from(k)),
        ]
    }

    fn wide(v: U256) -> U512 {
        U512::from(v)
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(512))]

        // The definition of floor division, checked in 512 bits: q * d <= a * b < (q + 1) * d. Errors exactly when
        // d is zero or the true quotient is at least 2^256.
        #[test]
        fn mul_div_is_floor_of_the_exact_product(a in word(), b in word(), d in word()) {
            let m = MathLib::from(&TestVM::default());
            let product = wide(a) * wide(b);
            match m.mul_div(a, b, d) {
                Ok(q) => {
                    prop_assert!(!d.is_zero());
                    prop_assert!(wide(q) * wide(d) <= product);
                    prop_assert!(product < (wide(q) + U512::from(1)) * wide(d));
                }
                Err(MathError::DivisionByZero(_)) => prop_assert!(d.is_zero()),
                Err(MathError::MulDivOverflow(_)) => {
                    prop_assert!(!d.is_zero());
                    prop_assert!(product / wide(d) > wide(U256::MAX));
                }
            }
            // Rounding up adds one exactly when the division leaves a remainder.
            if let (Ok(down), Ok(up)) = (m.mul_div(a, b, d), m.mul_div_up(a, b, d)) {
                let exact = (product % wide(d)).is_zero();
                prop_assert_eq!(up, if exact { down } else { down + U256::from(1) });
            }
        }

        // r * r <= n < (r + 1)^2, in 512 bits so (r + 1)^2 cannot overflow.
        #[test]
        fn isqrt_is_the_floor_of_the_root(v in word()) {
            let r = MathLib::from(&TestVM::default()).isqrt(v);
            prop_assert!(wide(r) * wide(r) <= wide(v));
            let next = wide(r) + U512::from(1);
            prop_assert!(wide(v) < next * next);
        }
    }
}
