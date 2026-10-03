// A runnable example of an agent using the oracle tools. It is deliberately not an LLM: it makes the same calls an LLM
// would make through tool use, so you can see the exact requests and responses.
//
//   npx tsx --env-file=../.env src/agent-example.ts          (VALUE, in the quote currency, is optional: 50 by default)
//
// To hand the same tools to a model, pass `tools` as its tool list and answer each tool call with `runIntent`, or serve
// them over MCP with src/agent-mcp.ts (`--config` prints the setup for Claude Desktop, Claude Code or Cursor).
import { runIntent } from "./agent-kit.js";
import { handlers } from "./agent.js";

const show = (label: string, value: unknown) => console.log(`\n${label}\n${JSON.stringify(value, null, 2)}`);

// The goal: "pay someone $50 worth of ETH". Check the price, then ask how much ETH that is (rounded up, never short).
show("get_price", await runIntent(handlers, { intent: "get_price" }));
show("amount_for_value", await runIntent(handlers, { intent: "amount_for_value", value: process.env.VALUE ?? "50" }));
// And the other way round: what 1.5 ETH is worth.
show("value_of", await runIntent(handlers, { intent: "value_of", amountTokens: "1.5" }));
