import { parseAbi } from "viem";
import { connect, run } from "./client.js";

// Keep in sync with the contract: run `../scripts/export-abi.sh` to see the interface.
const abi = parseAbi([
  "function token() view returns (address)",
  "function dealCount() view returns (uint256)",
  "function deal(uint256 id) view returns (address, address, address, uint256, uint256, uint8)",
  "function create(address seller, uint256 amount, uint256 deadline, address arbiter) returns (uint256)",
  "function release(uint256 id)",
  "function refund(uint256 id)",
]);

const STATES = ["unknown", "funded", "released", "refunded"];

await run(async () => {
  const { publicClient, address } = connect();
  const read = <T extends "token" | "dealCount">(functionName: T) => publicClient.readContract({ address, abi, functionName });

  console.log("token:", await read("token"));
  const count = await read("dealCount");
  console.log("deals:", count);

  // DEAL_ID=3 npm start prints one deal; by default the newest one.
  const id = process.env.DEAL_ID ? BigInt(process.env.DEAL_ID) : count;
  if (id > 0n) {
    const [buyer, seller, arbiter, amount, deadline, state] = await publicClient.readContract({ address, abi, functionName: "deal", args: [id] });
    console.log(`deal ${id}: ${STATES[state] ?? state}, ${amount} from ${buyer} to ${seller}, arbiter ${arbiter}, deadline ${new Date(Number(deadline) * 1000).toISOString()}`);
  }
  console.log("To create a deal: approve this contract on the token first, then call create(seller, amount, deadline, arbiter).");
});
