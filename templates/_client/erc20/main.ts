import { parseAbi } from "viem";
import { confirm, connect, run } from "./client.js";

// Keep in sync with the contract: run `../scripts/export-abi.sh` to see the interface.
const abi = parseAbi([
  "function init(string name, string symbol, uint256 supply)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
]);

await run(async () => {
  const { publicClient, walletClient, account, address } = connect();
  const read = <T extends "name" | "symbol" | "decimals" | "totalSupply">(functionName: T) =>
    publicClient.readContract({ address, abi, functionName });

  const name = await read("name");
  if (name === "") {
    console.log("Not initialized yet. Call init(name, symbol, supply) once after deploying.");
    if (walletClient) {
      const hash = await walletClient.writeContract({
        address,
        abi,
        functionName: "init",
        args: ["Buildathon Token", "BUIDL", 1_000_000n * 10n ** 18n],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      console.log("initialized in", hash);
    }
  } else {
    console.log(`${name} (${await read("symbol")}), ${await read("decimals")} decimals`);
    console.log("total supply:", await read("totalSupply"));
    if (account) {
      console.log("your balance:", await publicClient.readContract({ address, abi, functionName: "balanceOf", args: [account.address] }));
    }
  }
});
