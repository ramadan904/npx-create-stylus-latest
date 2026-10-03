// A runnable example of an agent using the faucet tools. It is deliberately not an LLM: it makes the same calls an LLM
// would make through tool use, so you can see the exact requests and responses.
//
//   npx tsx --env-file=../.env src/agent-example.ts
//
// To hand the same tools to a model, pass `tools` as its tool list and answer each tool call with `runIntent`, or serve
// them over MCP with src/agent-mcp.ts (`--config` prints the setup for Claude Desktop, Claude Code or Cursor).
import { runIntent } from "./agent-kit.js";
import { handlers } from "./agent.js";

const show = (label: string, value: unknown) => console.log(`\n${label}\n${JSON.stringify(value, null, 2)}`);

// 1. The goal: "get some test tokens". Look first, then ask.
show("get_faucet", await runIntent(handlers, { intent: "get_faucet" }));
const first = await runIntent(handlers, { intent: "request_tokens" });
show("request_tokens", first);

// 2. Asking again within the cooldown is refused before anything is sent, with the time left.
show("request_tokens (again, too soon)", await runIntent(handlers, { intent: "request_tokens" }));
