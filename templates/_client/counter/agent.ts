// Agent-native interface to the counter: intents an AI agent can call with JSON. See agent-kit.ts for the conventions
// (decimal-string numbers, `{ ok, ... }` results). The smallest end-to-end example of a contract an agent can use.
//
//   npx tsx --env-file=../.env src/agent-cli.ts --tools                                  # tool schemas for an LLM
//   npx tsx --env-file=../.env src/agent-cli.ts '{"intent":"get_number"}'
//   npx tsx --env-file=../.env src/agent-cli.ts '{"intent":"add_number","value":"5"}'
import { maxUint256, parseAbi } from "viem";
import { connect } from "./client.js";
import { IntentError, parseUint, write, type Handler, type ToolSpec } from "./agent-kit.js";

// Keep in sync with the contract: run `../scripts/export-abi.sh` to see the interface.
const abi = parseAbi([
  "function number() view returns (uint256)",
  "function setNumber(uint256 new_number)",
  "function increment()",
  "function addNumber(uint256 value)",
]);

const valueSchema = { type: "string", description: "A non-negative whole number, as a decimal string (\"5\")." };

export const tools: ToolSpec[] = [
  {
    name: "get_number",
    description: "Read the counter's current value.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "increment",
    description: "Add one to the counter. Returns the value before and after.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "add_number",
    description: "Add `value` to the counter. Refused before signing if the result would not fit in 256 bits.",
    input_schema: { type: "object", properties: { value: valueSchema }, required: ["value"] },
  },
  {
    name: "set_number",
    description: "Overwrite the counter with `value`. Anyone can call this on the template contract.",
    input_schema: { type: "object", properties: { value: valueSchema }, required: ["value"] },
  },
];

async function change(functionName: "increment" | "addNumber" | "setNumber", args: readonly bigint[], added?: bigint) {
  const ctx = connect();
  const before = await ctx.publicClient.readContract({ address: ctx.address, abi, functionName: "number" });
  if (added !== undefined && before > maxUint256 - added) {
    throw new IntentError("Overflow", `${before} + ${added} does not fit in 256 bits`, { number: before.toString(), value: added.toString() });
  }
  const { hash, receipt } = await write(ctx, { address: ctx.address, abi, functionName, args });
  // Read at the confirming block so a load-balanced RPC node cannot hand back stale state.
  const after = await ctx.publicClient.readContract({ address: ctx.address, abi, functionName: "number", blockNumber: receipt.blockNumber });
  return { txHash: hash, before, after };
}

export const handlers: Record<string, Handler> = {
  async get_number() {
    const ctx = connect();
    return { number: await ctx.publicClient.readContract({ address: ctx.address, abi, functionName: "number" }) };
  },
  async increment() {
    return change("increment", [], 1n);
  },
  async add_number(input) {
    const value = parseUint("value", input.value);
    return change("addNumber", [value], value);
  },
  async set_number(input) {
    return change("setNumber", [parseUint("value", input.value)]);
  },
};
