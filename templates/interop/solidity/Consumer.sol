// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The Stylus (Rust) contract in src/lib.rs, as Solidity sees it. To Solidity it is an ordinary contract: same ABI,
/// same custom errors. Keep it in sync with `./scripts/export-abi.sh`.
interface IMathLib {
    function mulDiv(uint256 a, uint256 b, uint256 denominator) external view returns (uint256);
    function mulDivUp(uint256 a, uint256 b, uint256 denominator) external view returns (uint256);
    function isqrt(uint256 n) external view returns (uint256);

    error DivisionByZero();
    error MulDivOverflow(uint256 a, uint256 b, uint256 denominator);
}

/// A Solidity contract that does its exact arithmetic in Rust. Deploy MathLib first, then this with its address
/// (`./scripts/interop.sh` does both checks and the deploy for you).
contract Consumer {
    IMathLib public immutable math;

    constructor(IMathLib math_) {
        math = math_;
    }

    /// What `amount` is worth at `price`, where `price` is scaled by `priceScale`. Exact even when `amount * price`
    /// does not fit in 256 bits, where `amount * price / priceScale` in Solidity reverts. A Rust error (division by
    /// zero, a result too big) is not caught here, so it reaches the caller unchanged, by name.
    function value(uint256 amount, uint256 price, uint256 priceScale) external view returns (uint256) {
        return math.mulDiv(amount, price, priceScale);
    }

    /// A fee of `bps` basis points on `amount`, rounded up so the protocol never undercharges.
    function fee(uint256 amount, uint256 bps) external view returns (uint256) {
        return math.mulDivUp(amount, bps, 10_000);
    }

    /// sqrt(a * b): for example the first liquidity tokens a constant-product pool mints for deposits a and b.
    /// The product uses Solidity's checked math, so it reverts with Panic(0x11) if a * b overflows.
    function geometricMean(uint256 a, uint256 b) external view returns (uint256) {
        return math.isqrt(a * b);
    }

    /// The same as `value`, but catching the Rust contract's errors by name instead of reverting.
    function tryValue(uint256 amount, uint256 price, uint256 priceScale)
        external
        view
        returns (bool ok, uint256 result, string memory error_)
    {
        try math.mulDiv(amount, price, priceScale) returns (uint256 v) {
            return (true, v, "");
        } catch (bytes memory reason) {
            bytes4 selector = bytes4(reason);
            if (selector == IMathLib.DivisionByZero.selector) return (false, 0, "DivisionByZero");
            if (selector == IMathLib.MulDivOverflow.selector) return (false, 0, "MulDivOverflow");
            // Anything else (out of gas, a bug) is not ours to swallow.
            assembly {
                revert(add(reason, 32), mload(reason))
            }
        }
    }
}
