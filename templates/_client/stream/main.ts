import { parseAbi } from "viem";
import { connect, run } from "./client.js";

// Keep in sync with the contract: run `../scripts/export-abi.sh` to see the interface.
const abi = parseAbi([
  "function token() view returns (address)",
  "function streamCount() view returns (uint256)",
  "function stream(uint256 id) view returns (address, address, uint256, uint256, uint256, uint256, uint8)",
  "function streamed(uint256 id) view returns (uint256)",
  "function withdrawable(uint256 id) view returns (uint256)",
  "function create(address recipient, uint256 amount, uint256 start, uint256 stop) returns (uint256)",
  "function withdraw(uint256 id) returns (uint256)",
  "function cancel(uint256 id)",
]);

const STATES = ["unknown", "active", "cancelled"];

await run(async () => {
  const { publicClient, address } = connect();
  const read = <T extends "token" | "streamCount">(functionName: T) => publicClient.readContract({ address, abi, functionName });

  console.log("token:", await read("token"));
  const count = await read("streamCount");
  console.log("streams:", count);

  // STREAM_ID=3 npm start prints one stream; by default the newest one.
  const id = process.env.STREAM_ID ? BigInt(process.env.STREAM_ID) : count;
  if (id > 0n) {
    const [sender, recipient, deposit, start, stop, withdrawn, state] = await publicClient.readContract({ address, abi, functionName: "stream", args: [id] });
    const [streamed, due] = await Promise.all([
      publicClient.readContract({ address, abi, functionName: "streamed", args: [id] }),
      publicClient.readContract({ address, abi, functionName: "withdrawable", args: [id] }),
    ]);
    const iso = (t: bigint) => new Date(Number(t) * 1000).toISOString();
    console.log(`stream ${id}: ${STATES[state] ?? state}, ${deposit} from ${sender} to ${recipient}, ${iso(start)} .. ${iso(stop)}`);
    console.log(`  streamed ${streamed}, withdrawn ${withdrawn}, withdrawable now ${due}`);
  }
  console.log("To open a stream: approve this contract on the token first, then call create(recipient, amount, start, stop).");
});
