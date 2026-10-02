// A runnable example of an agent using the vault tools. It is deliberately not an LLM: it makes the same calls an LLM would
// make through tool use, so you can see the exact requests and responses.
//
//   npx tsx --env-file=../.env src/agent-example.ts          (AMOUNT, in base units, is optional: 1000 by default)
//
// To hand the same tools to a model, pass `tools` as its tool list and answer each tool call with `runIntent`:
//
//   const reply = await anthropic.messages.create({ model, max_tokens: 1024, tools, messages });
//   for (const block of reply.content) {
//     if (block.type === "tool_use") result = await runIntent(handlers, { intent: block.name, ...block.input });
//   }
//
// Before letting a model spend, set AGENT_MAX_AMOUNT in ../.env: it is enforced before anything is signed, so the model
// cannot argue its way past it.
import { runIntent } from "./agent-kit.js";
import { handlers } from "./agent.js";

const show = (label: string, value: unknown) => console.log(`\n${label}\n${JSON.stringify(value, null, 2)}`);

// 1. The goal: "park 1000 base units in the vault, then take everything back out".
show("get_vault (before)", await runIntent(handlers, { intent: "get_vault" }));
const deposited = await runIntent(handlers, { intent: "deposit_to_vault", amount: process.env.AMOUNT ?? "1000" });
show("deposit_to_vault", deposited);
if (!deposited.ok) process.exit(1);

// 2. Withdrawing more than was deposited is refused with the numbers, before any transaction is sent.
show("withdraw_from_vault (too much)", await runIntent(handlers, { intent: "withdraw_from_vault", amount: "1000000000000000000000000000000" }));
show("withdraw_from_vault (all)", await runIntent(handlers, { intent: "withdraw_from_vault", all: true }));
