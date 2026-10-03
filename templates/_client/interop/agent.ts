// Agent-native interface to MathLib: intents an AI agent can call with JSON. See agent-kit.ts for the conventions
// (decimal-string numbers, `{ ok, ... }` results, the contract's own error names). Every answer comes from the Rust
// contract on-chain, the same code Solidity calls, so an agent gets exact 256-bit math instead of doing it in floats.
//
//   npx tsx --env-file=../.env src/agent-cli.ts --tools                                  # tool schemas for an LLM
//   npx tsx --env-file=../.env src/agent-cli.ts '{"intent":"mul_div","a":"1000","b":"3","denominator":"7"}'
import { parseAbi } from "viem";
import { connect } from "./client.js";
import { parseUint, type Handler, type ToolSpec } from "./agent-kit.js";

// Keep in sync with the contract: run `../scripts/export-abi.sh` to see the interface.
const abi = parseAbi([
  "function mulDiv(uint256 a, uint256 b, uint256 denominator) view returns (uint256)",
  "function mulDivUp(uint256 a, uint256 b, uint256 denominator) view returns (uint256)",
  "function isqrt(uint256 n) view returns (uint256)",
  "error DivisionByZero()",
  "error MulDivOverflow(uint256 a, uint256 b, uint256 denominator)",
]);

const uint = (what: string) => ({ type: "string", description: `${what}, a non-negative whole number below 2^256, as a decimal string.` });
const mulDivSchema = {
  type: "object" as const,
  properties: { a: uint("First factor"), b: uint("Second factor"), denominator: uint("Divisor (not zero)") },
  required: ["a", "b", "denominator"],
};

export const tools: ToolSpec[] = [
  {
    name: "mul_div",
    description:
      "a * b / denominator, rounded down, exact even when a * b exceeds 256 bits (prices, shares, fees, interest). Fails " +
      "as DivisionByZero, or MulDivOverflow if the result itself does not fit in 256 bits.",
    input_schema: mulDivSchema,
  },
  {
    name: "mul_div_up",
    description: "The same as mul_div, rounded up: for amounts that must never come out short (fees owed, collateral).",
    input_schema: mulDivSchema,
  },
  {
    name: "isqrt",
    description: "The integer square root of n: the largest r with r * r <= n.",
    input_schema: { type: "object", properties: { n: uint("The number") }, required: ["n"] },
  },
];

function mulDivArgs(input: Record<string, unknown>) {
  return [parseUint("a", input.a), parseUint("b", input.b), parseUint("denominator", input.denominator)] as const;
}

export const handlers: Record<string, Handler> = {
  async mul_div(input) {
    const args = mulDivArgs(input);
    const ctx = connect();
    return { result: await ctx.publicClient.readContract({ address: ctx.address, abi, functionName: "mulDiv", args }) };
  },
  async mul_div_up(input) {
    const args = mulDivArgs(input);
    const ctx = connect();
    return { result: await ctx.publicClient.readContract({ address: ctx.address, abi, functionName: "mulDivUp", args }) };
  },
  async isqrt(input) {
    const n = parseUint("n", input.n);
    const ctx = connect();
    return { result: await ctx.publicClient.readContract({ address: ctx.address, abi, functionName: "isqrt", args: [n] }) };
  },
};
