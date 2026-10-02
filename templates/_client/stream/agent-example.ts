// A runnable example of an agent using the stream tools. It is deliberately not an LLM: it makes the same calls an LLM would
// make through tool use, so you can see the exact requests and responses.
//
//   RECIPIENT=0x... npx tsx --env-file=../.env src/agent-example.ts      (RECIPIENT is optional: a throwaway address is used)
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

const recipient = process.env.RECIPIENT ?? privateKeyToAddress(generatePrivateKey());
const show = (label: string, value: unknown) => console.log(`\n${label}\n${JSON.stringify(value, null, 2)}`);

// 1. The goal: "pay this contractor 1000 base units over the next minute".
const opened = await runIntent(handlers, { intent: "open_stream", recipient, amount: process.env.AMOUNT ?? "1000", durationSeconds: 60 });
show("open_stream", opened);
if (!opened.ok) process.exit(1);
const id = (opened as unknown as { streamId: string }).streamId;

// 2. Look at it, and ask what cancelling would do before deciding anything.
show("get_stream", await runIntent(handlers, { intent: "get_stream", id }));
show("preview_cancel_stream", await runIntent(handlers, { intent: "preview_cancel_stream", id }));
console.log(`\nThe stream is running. Later: withdraw_from_stream or cancel_stream with id ${id}.`);
