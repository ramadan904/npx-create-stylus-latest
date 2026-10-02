import { parseAbi } from "viem";
import { confirm, connect, run } from "./client.js";

// Keep in sync with the contract: run `../scripts/export-abi.sh` to see the interface.
const abi = parseAbi([
  "function token() view returns (address)",
  "function amount() view returns (uint256)",
  "function cooldown() view returns (uint256)",
  "function availableAt(address who) view returns (uint256)",
  "function drip() returns (uint256)",
]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

await run(async () => {
  const { publicClient, walletClient, account, address } = connect();
  const token = await publicClient.readContract({ address, abi, functionName: "token" });
  const [amount, cooldown, held] = await Promise.all([
    publicClient.readContract({ address, abi, functionName: "amount" }),
    publicClient.readContract({ address, abi, functionName: "cooldown" }),
    publicClient.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [address] }),
  ]);
  console.log(`token ${token}: ${amount} per drip, once every ${cooldown}s; the faucet holds ${held}`);
  if (held < amount) console.log("The faucet is empty: send it some tokens first.");

  // DRIP=1 npm start takes a drip with the key in ../.env.
  if (process.env.DRIP && walletClient && account) {
    const availableAt = await publicClient.readContract({ address, abi, functionName: "availableAt", args: [account.address] });
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (availableAt > now) return console.log(`Too soon: try again after ${new Date(Number(availableAt) * 1000).toISOString()}`);
    const hash = await walletClient.writeContract({ address, abi, functionName: "drip" });
    await confirm(publicClient, hash, "drip");
    console.log("your balance:", await publicClient.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [account.address] }));
  }
});
