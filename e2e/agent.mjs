// Drives the generated agent CLIs (client/src/agent-cli.ts of the stream and escrow templates) exactly as an AI agent
// would: a JSON intent in, a JSON result out, as a subprocess. Against the real contracts and the real erc20 on the dev node.
//
// Env: RPC_URL, CHAIN_ID, E2E_KEY (the funded key; it is the agent's key), TOKEN, STREAM, ESCROW, STREAM_DIR, ESCROW_DIR
// (the scaffolded projects, with `client/` installed).
import { spawnSync } from "node:child_process";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const need = (n) => {
  const v = process.env[n];
  if (!v) throw new Error(`Set ${n}`);
  return v;
};
const rpc = need("RPC_URL");
const chainId = Number(process.env.CHAIN_ID ?? 412346);
const chain = defineChain({ id: chainId, name: "devnode", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const [TOKEN, STREAM, ESCROW] = [need("TOKEN"), need("STREAM"), need("ESCROW")];
const key = need("E2E_KEY");
const agent = privateKeyToAccount(key);
const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ account: agent, chain, transport: http(rpc) });
const balanceOf = (who) => pub.readContract({ address: TOKEN, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [who] });

let checks = 0;
function check(cond, label, detail) {
  checks++;
  if (!cond) throw new Error(`FAILED: ${label}${detail === undefined ? "" : `\n  ${JSON.stringify(detail)}`}`);
  console.log(`  ok  ${label}`);
}
/** An intent that must succeed: on failure, print the agent's own structured error so the cause is visible. */
const succeeded = (result, label) => check(result.ok === true, label, result.error ?? result);
const same = (a, b, label) => check(a === b, `${label} (got ${a}, want ${b})`);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

/** Calls the agent CLI the way a tool-use harness would and returns the parsed JSON result. */
function call(dir, contract, intent, extraEnv = {}) {
  const r = spawnSync("npx", ["tsx", "src/agent-cli.ts", JSON.stringify(intent)], {
    cwd: `${dir}/client`,
    encoding: "utf8",
    env: { ...process.env, CONTRACT_ADDRESS: contract, PRIVATE_KEY: key, RPC_URL: rpc, CHAIN_ID: String(chainId), ...extraEnv },
  });
  let result;
  try {
    result = JSON.parse(r.stdout);
  } catch {
    throw new Error(`The agent CLI did not print JSON for ${JSON.stringify(intent)}:\n${r.stdout}\n${r.stderr}`);
  }
  check((r.status === 0) === result.ok, `exit code ${r.status} agrees with ok=${result.ok} for ${intent.intent}`);
  return result;
}

// The dev node only mines a block when something is sent, so its latest block gets stale; estimation then simulates
// against old time. A real chain never idles like that. This tick keeps the clock current for time-dependent calls.
async function tick() {
  await pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: agent.address, value: 0n }) });
}

async function main() {
  const [sdir, edir] = [need("STREAM_DIR"), need("ESCROW_DIR")];
  const payee = privateKeyToAccount(generatePrivateKey()).address;
  const stranger = privateKeyToAccount(generatePrivateKey()).address;

  console.log("\nthe tool schemas an LLM would be given");
  for (const [dir, expected] of [[sdir, ["open_stream", "get_stream", "withdraw_from_stream", "preview_cancel_stream", "cancel_stream", "claim_held_payment"]], [edir, ["create_escrow", "get_escrow", "check_escrow_permissions", "release_escrow", "refund_escrow"]]]) {
    const r = spawnSync("npx", ["tsx", "src/agent-cli.ts", "--tools"], { cwd: `${dir}/client`, encoding: "utf8" });
    const tools = JSON.parse(r.stdout);
    check(JSON.stringify(tools.map((t) => t.name).sort()) === JSON.stringify([...expected].sort()), `tools: ${expected.join(", ")}`);
    check(tools.every((t) => t.description && t.input_schema?.type === "object"), "every tool has a description and an object schema");
  }

  console.log("\nstream: an agent opens, inspects, withdraws and cancels");
  const before = await balanceOf(agent.address);
  const opened = call(sdir, STREAM, { intent: "open_stream", recipient: payee, amount: "1000", durationSeconds: 90, startInSeconds: 5 });
  succeeded(opened, "open_stream succeeded"); check(/^\d+$/.test(opened.streamId), `open_stream returned a stream id (${opened.streamId})`, opened);
  same(opened.amount, "1000", "the result echoes the amount as a decimal string");
  same(await balanceOf(agent.address), before - 1000n, "the agent was debited exactly the deposit");
  const id = opened.streamId;

  const got = call(sdir, STREAM, { intent: "get_stream", id });
  check(got.ok && got.state === "active" && got.deposit === "1000" && got.recipient === payee && got.youAre === "sender", "get_stream describes the stream and who the agent is in it");
  same(BigInt(got.cancelPreview.toRecipient) + BigInt(got.cancelPreview.toSender) + BigInt(got.withdrawn), 1000n, "the cancel preview plus what is withdrawn always equals the deposit");
  check(got.heldForClaim?.sender === "0" && got.heldForClaim?.recipient === "0", "get_stream reports nothing held for either party", got.heldForClaim);
  check(got.token?.address?.toLowerCase() === TOKEN.toLowerCase() && got.token.decimals === 18 && got.token.symbol === "TST", "get_stream names the token, read from the token itself", got.token);
  same(got.depositTokens, "0.000000000000001 TST", "and shows the deposit in whole tokens");

  // the limits the operator sets in the environment, enforced before anything is signed
  const capped = call(sdir, STREAM, { intent: "open_stream", recipient: payee, amount: "1000", durationSeconds: 40 }, { AGENT_MAX_AMOUNT: "500" });
  check(!capped.ok && capped.error.code === "PolicyViolation", "an amount over AGENT_MAX_AMOUNT is refused");
  const walled = call(sdir, STREAM, { intent: "open_stream", recipient: stranger, amount: "10", durationSeconds: 40 }, { AGENT_ALLOWED_COUNTERPARTIES: payee });
  check(!walled.ok && walled.error.code === "PolicyViolation", "a recipient outside AGENT_ALLOWED_COUNTERPARTIES is refused");
  const broke = call(sdir, STREAM, { intent: "open_stream", recipient: payee, amount: "1000000000000000000000000000000", durationSeconds: 40 });
  check(!broke.ok && broke.error.code === "InsufficientBalance", "more than the agent holds is refused up front");
  // amountTokens is converted with the token's decimals before the limits apply: 0.000000000000001 TST is 1000 base units.
  const cappedTokens = call(sdir, STREAM, { intent: "open_stream", recipient: payee, amountTokens: "0.000000000000001", durationSeconds: 40 }, { AGENT_MAX_AMOUNT: "500" });
  check(!cappedTokens.ok && cappedTokens.error.code === "PolicyViolation", "an amountTokens over AGENT_MAX_AMOUNT is refused too");
  const both = call(sdir, STREAM, { intent: "open_stream", recipient: payee, amount: "1", amountTokens: "1", durationSeconds: 40 });
  check(!both.ok && both.error.code === "InvalidInput", "amount and amountTokens together are refused");
  const tooFine = call(sdir, STREAM, { intent: "open_stream", recipient: payee, amountTokens: "0.0000000000000000001", durationSeconds: 40 });
  check(!tooFine.ok && tooFine.error.code === "InvalidInput" && /19 decimal places/.test(tooFine.error.message), "more decimal places than the token has is refused, not rounded");
  const bad = call(sdir, STREAM, { intent: "open_stream", recipient: "0x123", amount: "1", durationSeconds: 40 });
  check(!bad.ok && bad.error.code === "InvalidInput", "a malformed address is refused");
  same(await balanceOf(STREAM) >= 1000n, true, "none of the refused calls moved tokens");

  await sleep(8); // each CLI call takes seconds, so by now the stream has been running for roughly 20 s of its 90
  await tick();
  const paid = call(sdir, STREAM, { intent: "withdraw_from_stream", id });
  succeeded(paid, "withdraw_from_stream succeeded"); check(BigInt(paid.paidToRecipient) > 0n && BigInt(paid.paidToRecipient) < 1000n, `withdraw_from_stream paid a partial amount (${paid.paidToRecipient} of 1000)`);
  same(await balanceOf(payee), BigInt(paid.paidToRecipient), "the recipient holds exactly what the result says was paid");

  await tick();
  const cancelled = call(sdir, STREAM, { intent: "cancel_stream", id });
  succeeded(cancelled, "cancel_stream succeeded");
  same(BigInt(paid.paidToRecipient) + BigInt(cancelled.paidToRecipient) + BigInt(cancelled.refundedToSender), 1000n, "paid + paid on cancel + refunded equals the deposit exactly");
  same(await balanceOf(payee), BigInt(paid.paidToRecipient) + BigInt(cancelled.paidToRecipient), "the recipient's total matches the results");
  same(await balanceOf(agent.address), before - 1000n + BigInt(cancelled.refundedToSender), "the agent got the remainder back");
  const again = call(sdir, STREAM, { intent: "cancel_stream", id });
  check(!again.ok && again.error.code === "NotActive" && again.error.hint, `a second cancel fails with the contract's own error name (${again.error?.code}) and a hint`);
  // The erc20 template never refuses a transfer, so nothing is held; the refusal path itself is covered by the contract's tests.
  check(Array.isArray(cancelled.held) && cancelled.held.length === 0, "cancel_stream reports no held payouts when the token paid both sides", cancelled.held);
  const owed = call(sdir, STREAM, { intent: "claim_held_payment", checkOnly: true, who: payee });
  check(owed.ok && owed.who === payee && owed.claimable === "0", "claim_held_payment checkOnly reads what is held for any address", owed);
  const empty = call(sdir, STREAM, { intent: "claim_held_payment" });
  check(!empty.ok && empty.error.code === "NothingToClaim" && empty.error.hint, `claiming with nothing held fails with ${empty.error?.code} and a hint`);
  const wrong = call(sdir, STREAM, { intent: "claim_held_payment", who: payee });
  check(!wrong.ok && wrong.error.code === "InvalidInput", "claiming for someone else is refused before signing (claim always pays the caller)");

  console.log("\nescrow: an agent locks, checks permissions, and releases");
  const eBefore = await balanceOf(agent.address);
  // In whole tokens this time: 0.0000000000000007 TST = 700 base units.
  const created = call(edir, ESCROW, { intent: "create_escrow", seller: payee, amountTokens: "0.0000000000000007", deadlineSeconds: 3600 });
  succeeded(created, "create_escrow succeeded"); check(/^\d+$/.test(created.dealId), `create_escrow returned a deal id (${created.dealId})`, created);
  same(created.amount, "700", "amountTokens was converted exactly with the token's 18 decimals");
  same(created.amountTokens, "0.0000000000000007 TST", "and the result shows it back in whole tokens");
  same(await balanceOf(agent.address), eBefore - 700n, "the agent was debited exactly the amount");
  const deal = created.dealId;

  const view = call(edir, ESCROW, { intent: "get_escrow", id: deal });
  check(view.ok && view.state === "funded" && view.seller === payee && view.arbiter === null && view.amountTokens === "0.0000000000000007 TST", "get_escrow describes the deal, in base units and whole tokens", view);
  check(view.permissions.canRelease === true && view.permissions.canRefund === false, "as buyer the agent can release but not yet refund");
  const asSeller = call(edir, ESCROW, { intent: "check_escrow_permissions", id: deal, who: payee });
  check(asSeller.canRelease === false && asSeller.canRefund === true, "the contract says the seller can refund but not release");
  const asStranger = call(edir, ESCROW, { intent: "check_escrow_permissions", id: deal, who: stranger });
  check(asStranger.canRelease === false && asStranger.canRefund === false, "and a stranger can do neither");

  const early = call(edir, ESCROW, { intent: "refund_escrow", id: deal });
  check(!early.ok && early.error.code === "NotAuthorized", "refunding before the deadline fails with the decoded error NotAuthorized, as can_refund predicted");
  const blocked = call(edir, ESCROW, { intent: "create_escrow", seller: stranger, amount: "5", deadlineSeconds: 60 }, { AGENT_ALLOWED_COUNTERPARTIES: payee });
  check(!blocked.ok && blocked.error.code === "PolicyViolation", "a seller outside the allow-list is refused");

  const released = call(edir, ESCROW, { intent: "release_escrow", id: deal });
  succeeded(released, "release_escrow succeeded"); check(released.state === "released", "release_escrow settled the deal", released);
  same(await balanceOf(payee) >= 700n, true, "the seller was paid");
  const after = call(edir, ESCROW, { intent: "get_escrow", id: deal });
  check(after.permissions.canRelease === false && after.permissions.canRefund === false, "once settled the contract allows nothing");
  const twice = call(edir, ESCROW, { intent: "release_escrow", id: deal });
  check(!twice.ok && ["NotFunded", "NotAuthorized"].includes(twice.error.code), `a second release fails (${twice.error?.code})`);

  console.log(`\nE2E AGENT FLOWS PASSED (${checks} checks)`);
}

main().catch((err) => {
  console.error(`\n${err.shortMessage ?? err.message ?? err}`);
  process.exit(1);
});
