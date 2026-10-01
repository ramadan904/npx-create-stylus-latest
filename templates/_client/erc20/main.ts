import { isAddress, parseAbi, parseUnits } from "viem";
import { confirm, connect, run } from "./client.js";

// Keep in sync with the contract: run `../scripts/export-abi.sh` to see the interface.
const abi = parseAbi([
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
    // The constructor sets the name at deploy time, so an empty name means this is not our token contract.
    throw new Error("name() is empty: check CONTRACT_ADDRESS, and that you deployed with constructor arguments");
  }
  const decimals = await read("decimals");
  console.log(`${name} (${await read("symbol")}), ${decimals} decimals`);
  console.log("total supply:", await read("totalSupply"));
  if (account) {
    console.log("your balance:", await publicClient.readContract({ address, abi, functionName: "balanceOf", args: [account.address] }));
  }

  // Optional: TRANSFER_TO=0x... sends 1 token from your account.
  const to = process.env.TRANSFER_TO;
  if (to) {
    if (!isAddress(to)) throw new Error("TRANSFER_TO is not a valid address");
    if (!walletClient) throw new Error("Set PRIVATE_KEY in ../.env to send a transfer");
    const hash = await walletClient.writeContract({ address, abi, functionName: "transfer", args: [to, parseUnits("1", decimals)] });
    await confirm(publicClient, hash, "transfer()");
  }
});
