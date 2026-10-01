import { parseAbi } from "viem";
import { connect, run } from "./client.js";

// Keep in sync with the contract: run `../scripts/export-abi.sh` to see the interface.
const abi = parseAbi([
  "function init(address asset)",
  "function asset() view returns (address)",
  "function totalDeposits() view returns (uint256)",
  "function depositOf(address account) view returns (uint256)",
  "function deposit(uint256 amount)",
  "function withdraw(uint256 amount)",
]);

await run(async () => {
  const { publicClient, account, address } = connect();

  console.log("asset:", await publicClient.readContract({ address, abi, functionName: "asset" }));
  console.log("total deposits:", await publicClient.readContract({ address, abi, functionName: "totalDeposits" }));
  if (account) {
    console.log("your deposit:", await publicClient.readContract({ address, abi, functionName: "depositOf", args: [account.address] }));
  }
  console.log("To deposit: approve the vault on the token first, then call deposit(amount).");
});
