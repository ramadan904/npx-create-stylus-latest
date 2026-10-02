import { formatUnits, parseAbi, parseUnits } from "viem";
import { connect, run } from "./client.js";

// Keep in sync with the contract: run `../scripts/export-abi.sh` to see the interface.
const abi = parseAbi([
  "function feed() view returns (address)",
  "function decimals() view returns (uint8)",
  "function maxAge() view returns (uint256)",
  "function latestPrice() view returns (int256, uint256)",
  "function valueOf(uint256 amount, uint8 amountDecimals) view returns (uint256)",
  "function decimalsMatch() view returns (bool)",
]);

await run(async () => {
  const { publicClient, address } = connect();
  const read = <T extends "feed" | "decimals" | "maxAge" | "decimalsMatch">(functionName: T) =>
    publicClient.readContract({ address, abi, functionName });

  const decimals = await read("decimals");
  console.log(`feed ${await read("feed")}, ${decimals} decimals, prices older than ${await read("maxAge")} s are refused`);
  console.log("decimals match the feed:", await read("decimalsMatch"));
  // The contract reverts with StalePrice / InvalidPrice / IncompleteRound / FeedUnavailable rather than return a bad price;
  // run() prints that error by name.
  const [answer, updatedAt] = await publicClient.readContract({ address, abi, functionName: "latestPrice" });
  console.log(`price: ${formatUnits(answer, decimals)}, updated ${Math.floor(Date.now() / 1000) - Number(updatedAt)} s ago`);
  const value = await publicClient.readContract({ address, abi, functionName: "valueOf", args: [parseUnits("1", 18), 18] });
  console.log("value of 1 unit (18 decimals):", formatUnits(value, 18));
});
