// A runnable example of an agent using the MathLib tools. It is deliberately not an LLM: it makes the same calls an LLM
// would make through tool use, so you can see the exact requests and responses.
//
//   npx tsx --env-file=../.env src/agent-example.ts
//
// To hand the same tools to a model, pass `tools` as its tool list and answer each tool call with `runIntent`, or serve
// them over MCP with src/agent-mcp.ts (`--config` prints the setup for Claude Desktop, Claude Code or Cursor).
import { runIntent } from "./agent-kit.js";
import { handlers } from "./agent.js";

const show = (label: string, value: unknown) => console.log(`\n${label}\n${JSON.stringify(value, null, 2)}`);

// 1e40 * 1e40 overflows 256 bits, but the result of dividing by 1e36 does not: exact, where a float would round.
show("mul_div", await runIntent(handlers, { intent: "mul_div", a: "1" + "0".repeat(40), b: "1" + "0".repeat(40), denominator: "1" + "0".repeat(36) }));
show("mul_div_up (a 30 bps fee on 1001)", await runIntent(handlers, { intent: "mul_div_up", a: "1001", b: "30", denominator: "10000" }));
show("isqrt", await runIntent(handlers, { intent: "isqrt", n: "36000000000000000000000000000000000000" }));
// The contract's own error, by name.
show("mul_div by zero", await runIntent(handlers, { intent: "mul_div", a: "1", b: "1", denominator: "0" }));
