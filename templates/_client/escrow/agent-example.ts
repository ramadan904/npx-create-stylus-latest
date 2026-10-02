// A runnable example of an agent using the escrow tools. It is deliberately not an LLM: it makes the same calls an LLM would
// make through tool use, so you can see the exact requests and responses.
//
//   SELLER=0x... npx tsx --env-file=../.env src/agent-example.ts          (SELLER is optional: a throwaway address is used)
//
// To hand the same tools to a model, pass `tools` as its tool list and answer each tool call with `runIntent`:
//
//   const reply = await anthropic.messages.create({ model, max_tokens: 1024, tools, messages });
//   for (const block of reply.content) {
//     if (block.type === "tool_use") result = await runIntent(handlers, { intent: block.name, ...block.input });
//   }
//
// Before letting a model spend, set AGENT_MAX_AMOUNT (and ideally AGENT_ALLOWED_COUNTERPARTIES) in ../.env: they are
// enforced before anything is signed, so the model cannot argue its way past them.
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { runIntent } from "./agent-kit.js";
import { handlers } from "./agent.js";

const seller = process.env.SELLER ?? privateKeyToAddress(generatePrivateKey());
const show = (label: string, value: unknown) => console.log(`\n${label}\n${JSON.stringify(value, null, 2)}`);

// 1. The goal: "hold 5000 base units for this seller until I accept their work; I can get it back after a day".
const created = await runIntent(handlers, { intent: "create_escrow", seller, amount: process.env.AMOUNT ?? "5000", deadlineSeconds: 86_400 });
show("create_escrow", created);
if (!created.ok) process.exit(1);
const id = (created as unknown as { dealId: string }).dealId;

// 2. Ask the contract what each side may do, instead of sending a transaction that would revert.
show("check_escrow_permissions (the agent, as buyer)", await runIntent(handlers, { intent: "check_escrow_permissions", id }));
show("check_escrow_permissions (the seller)", await runIntent(handlers, { intent: "check_escrow_permissions", id, who: seller }));
console.log(`\nThe deal is funded. When the work is accepted: release_escrow with id ${id}.`);
