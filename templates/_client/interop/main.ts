import { BaseError, ContractFunctionRevertedError, parseAbi } from "viem";
import { connect, run } from "./client.js";

// Keep in sync with the contract: run `../scripts/export-abi.sh` to see the interface.
const abi = parseAbi([
  "function mulDiv(uint256 a, uint256 b, uint256 denominator) view returns (uint256)",
  "function mulDivUp(uint256 a, uint256 b, uint256 denominator) view returns (uint256)",
  "function isqrt(uint256 n) view returns (uint256)",
  "error DivisionByZero()",
  "error MulDivOverflow(uint256 a, uint256 b, uint256 denominator)",
]);

await run(async () => {
  const { publicClient, address } = connect();
  const mulDiv = (a: bigint, b: bigint, d: bigint) => publicClient.readContract({ address, abi, functionName: "mulDiv", args: [a, b, d] });
  const mulDivUp = (a: bigint, b: bigint, d: bigint) => publicClient.readContract({ address, abi, functionName: "mulDivUp", args: [a, b, d] });

  // 1e40 * 1e40 is past 2^256; the contract divides the exact 512-bit product.
  console.log("mulDiv(1e40, 1e40, 1e36):", await mulDiv(10n ** 40n, 10n ** 40n, 10n ** 36n));
  console.log("mulDivUp(1001, 30, 10000):", await mulDivUp(1001n, 30n, 10_000n), "(a 30 bps fee, rounded up)");
  console.log("isqrt(2^255):", await publicClient.readContract({ address, abi, functionName: "isqrt", args: [2n ** 255n] }));
  // The contract's errors arrive by name, here and in Solidity (see ../solidity/Consumer.sol).
  try {
    await mulDiv(1n, 1n, 0n);
  } catch (err) {
    const reverted = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : null;
    if (!(reverted instanceof ContractFunctionRevertedError)) throw err;
    console.log("mulDiv(1, 1, 0) reverts:", reverted.data?.errorName);
  }
});
