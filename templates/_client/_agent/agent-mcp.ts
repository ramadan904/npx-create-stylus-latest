// MCP server for this contract's agent tools: the same intents as agent-cli.ts, for Claude Desktop, Claude Code, Cursor
// or any MCP client. `npx tsx src/agent-mcp.ts --config` prints the setup to paste, with this project's absolute paths.
import { mcpMain } from "./agent-kit.js";
import { handlers, tools } from "./agent.js";

await mcpMain({ name: "{{name}}", version: "0.1.0" }, tools, handlers);
