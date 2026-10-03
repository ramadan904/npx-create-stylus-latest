// A runnable example of an agent using the counter tools. It is deliberately not an LLM: it makes the same calls an LLM
// would make through tool use, so you can see the exact requests and responses.
//
//   npx tsx --env-file=../.env src/agent-example.ts
//
// To hand the same tools to a model, pass `tools` as its tool list and answer each tool call with `runIntent`, or serve
// them over MCP with src/agent-mcp.ts (`--config` prints the setup for Claude Desktop, Claude Code or Cursor).
import { runIntent } from "./agent-kit.js";
import { handlers } from "./agent.js";

const show = (label: string, value: unknown) => console.log(`\n${label}\n${JSON.stringify(value, null, 2)}`);

show("get_number", await runIntent(handlers, { intent: "get_number" }));
show("increment", await runIntent(handlers, { intent: "increment" }));
show("add_number", await runIntent(handlers, { intent: "add_number", value: "5" }));
// A mistake is refused before anything is signed, with a stable error code.
show("add_number (not a number)", await runIntent(handlers, { intent: "add_number", value: "-1" }));
