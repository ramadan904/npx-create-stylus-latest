// A runnable example of an agent using the NFT tools. It is deliberately not an LLM: it makes the same calls an LLM
// would make through tool use, so you can see the exact requests and responses.
//
//   TO=0x... npx tsx --env-file=../.env src/agent-example.ts     (the agent's key must be the minter; TO receives the NFT)
//
// To hand the same tools to a model, pass `tools` as its tool list and answer each tool call with `runIntent`, or serve
// them over MCP with src/agent-mcp.ts (`--config` prints the setup for Claude Desktop, Claude Code or Cursor).
// Set AGENT_ALLOWED_COUNTERPARTIES in ../.env to limit who the agent may send tokens to.
import { runIntent } from "./agent-kit.js";
import { handlers } from "./agent.js";

const show = (label: string, value: unknown) => console.log(`\n${label}\n${JSON.stringify(value, null, 2)}`);

// 1. The goal: "mint one and give it to TO". Mint to the agent first, then look at it.
const minted = (await runIntent(handlers, { intent: "mint_nft" })) as { ok: boolean; tokenId?: string };
show("mint_nft", minted);
if (!minted.ok) process.exit(1);
show("get_nft", await runIntent(handlers, { intent: "get_nft", tokenId: minted.tokenId }));

// 2. Send it on. Without TO, show a refusal instead: the zero address is never a valid recipient.
const to = process.env.TO ?? "0x0000000000000000000000000000000000000000";
show("transfer_nft", await runIntent(handlers, { intent: "transfer_nft", to, tokenId: minted.tokenId }));
