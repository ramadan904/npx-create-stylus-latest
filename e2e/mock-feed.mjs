// A stand-in Chainlink AggregatorV3 for the dev node, which has no price feeds: the oracle template reads it exactly as it
// would read a real feed, and the checks can make its price fresh, stale or zero.
//
//   node mock-feed.mjs <decimals> <answer>    deploys one with that answer, updated now; prints its address
//
// Env: RPC_URL, CHAIN_ID, E2E_KEY.
import solc from "solc";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
contract MockFeed {
    uint8 public decimals;
    uint80 internal round;
    int256 internal answer;
    uint256 internal updatedAt;
    constructor(uint8 decimals_) { decimals = decimals_; }
    function set(int256 answer_, uint256 updatedAt_) external { round++; answer = answer_; updatedAt = updatedAt_; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (round, answer, updatedAt, updatedAt, round);
    }
}`;

function compile() {
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: { "MockFeed.sol": { content: SOURCE } },
        settings: { evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
      }),
    ),
  );
  const errors = (output.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const { abi, evm } = output.contracts["MockFeed.sol"].MockFeed;
  return { abi, bytecode: `0x${evm.bytecode.object}` };
}

export const mockFeedAbi = compile().abi;

export function clients() {
  const rpc = process.env.RPC_URL ?? "http://127.0.0.1:8547";
  const chain = defineChain({
    id: Number(process.env.CHAIN_ID ?? 412346),
    name: "devnode",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const account = privateKeyToAccount(process.env.E2E_KEY);
  return {
    pub: createPublicClient({ chain, transport: http(rpc) }),
    wallet: createWalletClient({ account, chain, transport: http(rpc) }),
  };
}

/** Sets the feed's answer and update time, and waits for it. Returns the block it landed in. */
export async function setFeed(feed, answer, updatedAt) {
  const { pub, wallet } = clients();
  const hash = await wallet.writeContract({ address: feed, abi: mockFeedAbi, functionName: "set", args: [answer, updatedAt] });
  return pub.waitForTransactionReceipt({ hash });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [decimals, answer] = process.argv.slice(2);
  const { pub, wallet } = clients();
  const { abi, bytecode } = compile();
  const receipt = await pub.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi, bytecode, args: [Number(decimals)] }) });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("MockFeed deploy failed");
  const { timestamp } = await pub.getBlock();
  await setFeed(receipt.contractAddress, BigInt(answer), timestamp);
  console.log(receipt.contractAddress);
}
