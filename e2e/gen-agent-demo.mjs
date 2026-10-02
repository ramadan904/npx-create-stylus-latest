// Builds web/agent-demo.json, the "watch an agent move money" replay on the project site, from a real agent run.
//
//   node gen-agent-demo.mjs <ci-log-file> <run-url>
//
// The log is the e2e-flows job log; e2e/agent.mjs prints the whole run as one `AGENT_TRANSCRIPT {...}` line: every intent
// the agent sent and the exact JSON its CLI returned, against real contracts on a local Nitro node. This script only
// picks a story out of it and adds a sentence per step. It never invents a result: each step's `result` is copied
// verbatim, and the script fails if a step it wants is missing from the run.
import { readFileSync, writeFileSync } from "node:fs";

const [logFile, runUrl] = process.argv.slice(2);
if (!logFile || !runUrl) throw new Error("usage: node gen-agent-demo.mjs <ci-log-file> <run-url>");
const line = readFileSync(logFile, "utf8").split("\n").find((l) => l.includes("AGENT_TRANSCRIPT {"));
if (!line) throw new Error("no AGENT_TRANSCRIPT line in the log");
const run = JSON.parse(line.slice(line.indexOf("AGENT_TRANSCRIPT ") + "AGENT_TRANSCRIPT ".length));

const short = (a) => (typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const tx = (h) => (h ? ` · tx ${h.slice(0, 10)}…` : "");

// The story, in order. Each entry picks the first unused step matching `when`, and says what the agent was doing.
const story = [
  { when: (s) => s.contract === "stream" && s.intent.intent === "open_stream" && s.result.ok,
    say: "Goal: pay a contractor 1,000 units continuously over 90 seconds.",
    sum: (r) => `stream #${r.streamId} opened · ${r.amount} locked · ${r.ratePerSecond}/s${tx(r.txHash)}` },
  { when: (s) => s.intent.intent === "get_stream" && s.result.ok,
    say: "Read the stream back, including what cancelling would pay each side right now.",
    sum: (r) => `${r.state} · deposit ${r.depositTokens} · cancel now → ${r.cancelPreview.toRecipient} to recipient, ${r.cancelPreview.toSender} back` },
  { when: (s) => s.intent.intent === "open_stream" && s.policy.AGENT_MAX_AMOUNT && s.intent.amount,
    say: "Try to overspend. The operator capped any single payment at 500 units in the environment.",
    sum: (r) => `refused before signing: ${r.error.code}` },
  { when: (s) => s.intent.intent === "open_stream" && s.policy.AGENT_ALLOWED_COUNTERPARTIES,
    say: "Try to pay someone who is not on the operator's allow-list.",
    sum: (r) => `refused before signing: ${r.error.code}` },
  { when: (s) => s.intent.intent === "withdraw_from_stream" && s.result.ok,
    say: "Pay out what the contractor has earned so far.",
    sum: (r) => `${r.paidToRecipient} paid to the recipient${tx(r.txHash)}` },
  { when: (s) => s.intent.intent === "cancel_stream" && s.result.ok,
    say: "Stop the stream: the earned part goes to the contractor, the rest comes back.",
    sum: (r) => `${r.paidToRecipient} to the recipient · ${r.refundedToSender} refunded · ${r.held?.length ? `${r.held.length} payout held for claim` : "nothing held"}${tx(r.txHash)}` },
  { when: (s) => s.intent.intent === "cancel_stream" && !s.result.ok,
    say: "Cancel again by mistake. The contract's own error comes back, with a hint.",
    sum: (r) => `${r.error.code}: ${r.error.hint}` },
  { when: (s) => s.intent.intent === "create_escrow" && s.result.ok,
    say: "Hire someone: lock the payment in escrow, given in whole tokens.",
    sum: (r) => `deal #${r.dealId} funded · ${r.amountTokens} (= ${r.amount} base units)${tx(r.txHash)}` },
  { when: (s) => s.intent.intent === "check_escrow_permissions" && s.intent.who,
    say: "Before acting, ask the contract what the seller is allowed to do.",
    sum: (r) => `seller can release: ${r.canRelease} · can refund: ${r.canRefund}` },
  { when: (s) => s.intent.intent === "refund_escrow" && !s.result.ok,
    say: "Try to take the money back before the deadline.",
    sum: (r) => `${r.error.code}, as the permission check predicted` },
  { when: (s) => s.intent.intent === "release_escrow" && s.result.ok,
    say: "The work is accepted: release the payment to the seller.",
    sum: (r) => `deal ${r.state}${tx(r.txHash)}` },
  { when: (s) => s.intent.intent === "deposit_to_vault" && s.result.ok,
    say: "Park spare funds in the vault.",
    sum: (r) => `deposited ${r.depositedTokens}${tx(r.txHash)}` },
  { when: (s) => s.intent.intent === "withdraw_from_vault" && !s.result.ok && s.result.error.code === "InsufficientDeposit",
    say: "Try to withdraw more than was deposited.",
    sum: (r) => `refused before sending: ${r.error.code} (have ${r.error.details?.have}, want ${r.error.details?.want})` },
  { when: (s) => s.intent.intent === "withdraw_from_vault" && s.intent.all && s.result.ok,
    say: "Take everything back out.",
    sum: (r) => `withdrew ${r.withdrawnTokens} · ${r.depositNowTokens} left${tx(r.txHash)}` },
];

const used = new Set();
const steps = story.map(({ when, say, sum }, n) => {
  const i = run.steps.findIndex((s, j) => !used.has(j) && when(s));
  if (i < 0) throw new Error(`story step ${n + 1} ("${say}") is not in this run`);
  used.add(i);
  const s = run.steps[i];
  const input = Object.fromEntries(Object.entries(s.intent).filter(([k]) => k !== "intent").map(([k, v]) => [k, short(v)]));
  const policy = Object.fromEntries(Object.entries(s.policy).map(([k, v]) => [k, String(v).split(",").map(short).join(",")]));
  return { say, contract: s.contract, tool: s.intent.intent, input, policy, ok: s.result.ok, summary: sum(s.result), ms: s.ms, result: s.result };
});

writeFileSync(
  new URL("../web/agent-demo.json", import.meta.url),
  `${JSON.stringify({ source: runUrl, chainId: run.chainId, checks: run.checks, totalCalls: run.steps.length, steps }, null, 1)}\n`,
);
console.log(`wrote web/agent-demo.json: ${steps.length} steps from ${run.steps.length} calls (${runUrl})`);
