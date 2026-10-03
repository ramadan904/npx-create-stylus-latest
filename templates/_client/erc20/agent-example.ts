// A runnable example of an agent using the token tools. It is deliberately not an LLM: it makes the same calls an LLM
// would make through tool use, so you can see the exact requests and responses.
//
//   TO=0x... npx tsx --env-file=../.env src/agent-example.ts     (TO: who receives 1 token; default: the agent itself)
//
// To hand the same tools to a model, pass `tools` as its tool list and answer each tool call with `runIntent`, or serve
// them over MCP with src/agent-mcp.ts (`--config` prints the setup for Claude Desktop, Claude Code or Cursor).
//
// Before letting a model spend, set AGENT_MAX_AMOUNT (and AGENT_ALLOWED_COUNTERPARTIES) in ../.env: they are enforced
// before anything is signed, so the model cannot argue its way past them.
import { runIntent } from "./agent-kit.js";
import { handlers } from "./agent.js";

const show = (label: string, value: unknown) => console.log(`\n${label}\n${JSON.stringify(value, null, 2)}`);

// 1. The goal: "pay 1 token". Look first, then send.
const info = (await runIntent(handlers, { intent: "get_token" })) as { ok: boolean; account?: string };
show("get_token", info);
const to = process.env.TO ?? info.account;
show("send_tokens", await runIntent(handlers, { intent: "send_tokens", to, amountTokens: "1" }));

// 2. A mistake is refused before anything is signed, with a stable error code the agent can act on.
show(
  "send_tokens (to the zero address)",
  await runIntent(handlers, { intent: "send_tokens", to: "0x0000000000000000000000000000000000000000", amountTokens: "1" }),
);
