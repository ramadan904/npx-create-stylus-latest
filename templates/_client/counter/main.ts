import { parseAbi } from "viem";
import { confirm, connect, run } from "./client.js";

// Keep in sync with the contract: run `../scripts/export-abi.sh` to see the interface.
const abi = parseAbi([
  "function number() view returns (uint256)",
  "function setNumber(uint256 new_number)",
  "function increment()",
  "function addNumber(uint256 value)",
]);

await run(async () => {
  const { publicClient, walletClient, address } = connect();

  console.log("number:", await publicClient.readContract({ address, abi, functionName: "number" }));

  if (walletClient) {
    const hash = await walletClient.writeContract({ address, abi, functionName: "increment" });
    const receipt = await confirm(publicClient, hash, "increment()");
    // Read at the confirming block so a load-balanced RPC node cannot hand back stale state.
    const blockNumber = receipt.blockNumber;
    console.log("number:", await publicClient.readContract({ address, abi, functionName: "number", blockNumber }));
  } else {
    console.log("Set PRIVATE_KEY in ../.env to send an increment() transaction.");
  }
});
