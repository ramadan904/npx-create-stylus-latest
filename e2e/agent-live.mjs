// Runs the site's "Run the AI agent demo" section for real, in a browser, against the contracts on the dev node, and holds
// its results to the agent CLI's. Runs in the e2e-flows job after agent.mjs, with the same env (see agent.mjs).
//
// The page talks to a stand-in wallet: window.ethereum forwards every call to the dev node and signs with E2E_KEY, so the
// page code runs unchanged, transactions and all. Then:
//   - the three intents succeed, and each result has the same fields, nested the same way, as the CLI's result for the same
//     intent in this job's agent run (AGENT_LOG, the agent.mjs output);
//   - the same read, a failing intent and a refused amount, sent to the page's port and to the CLI, give identical JSON;
//   - the chain agrees with what the page reported: the stream is cancelled, the recipient holds exactly what was paid, and
//     paid plus refunded is the deposit.
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, parseAbi, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const need = (n) => {
  const v = process.env[n];
  if (!v) throw new Error(`Set ${n}`);
  return v;
};
const rpc = need("RPC_URL");
const chainId = Number(process.env.CHAIN_ID ?? 412346);
const chain = defineChain({ id: chainId, name: "devnode", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const [TOKEN, STREAM, key, sdir] = [need("TOKEN"), need("STREAM"), need("E2E_KEY"), need("STREAM_DIR")];
const me = privateKeyToAccount(key);
const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ account: me, chain, transport: http(rpc) });
const streamAbi = parseAbi(["function stream(uint256) view returns (address, address, uint256, uint256, uint256, uint256, uint8)"]);
const balanceOf = (who) => pub.readContract({ address: TOKEN, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [who] });

let checks = 0;
function check(cond, label, detail) {
  checks++;
  if (!cond) throw new Error(`FAILED: ${label}${detail === undefined ? "" : `\n  ${JSON.stringify(detail)}`}`);
  console.log(`  ok  ${label}`);
}

/** The agent CLI, called as agent.mjs calls it. */
function cli(intent) {
  const r = spawnSync("npx", ["tsx", "src/agent-cli.ts", JSON.stringify(intent)], {
    cwd: `${sdir}/client`,
    encoding: "utf8",
    env: { ...process.env, CONTRACT_ADDRESS: STREAM, PRIVATE_KEY: key, RPC_URL: rpc, CHAIN_ID: String(chainId) },
  });
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`The agent CLI did not print JSON for ${JSON.stringify(intent)}:\n${r.stdout}\n${r.stderr}`);
  }
}

/** The shape of a JSON value: every field, nested, with its JSON type. Values (hashes, ids, times) differ run to run. */
function shape(v) {
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape(v[k])]));
  return typeof v;
}

// The page, served from web/, with the stand-in wallet.
const web = new URL("../web/", import.meta.url).pathname;
const port = Number(process.env.PORT || 8812);
const server = createServer((req, res) => {
  const path = req.url === "/" ? "index.html" : req.url.slice(1).split("?")[0];
  try { res.end(readFileSync(web + path)); } catch { res.statusCode = 404; res.end(); }
}).listen(port);

// The dev node only mines when something is sent, so its clock stops between transactions; a real chain never idles.
// A second account sends itself nothing every two seconds so time-dependent estimates see the current time. (Not the
// page's key, so the two never race for a nonce.)
const ticker = privateKeyToAccount(generatePrivateKey());
await pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: ticker.address, value: parseEther("0.01") }) });
const tickWallet = createWalletClient({ account: ticker, chain, transport: http(rpc) });
let ticking = true;
const tickLoop = (async () => {
  while (ticking) {
    try { await pub.waitForTransactionReceipt({ hash: await tickWallet.sendTransaction({ to: ticker.address, value: 0n }) }); } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
})();

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome" });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.exposeFunction("__wallet", async (method, params) => {
  switch (method) {
    case "eth_requestAccounts":
    case "eth_accounts":
      return { result: [me.address.toLowerCase()] };
    case "eth_chainId":
      return { result: "0x66eee" }; // the page asks for Arbitrum Sepolia; the stand-in says yes and talks to the dev node
    case "wallet_switchEthereumChain":
      return { result: null };
    case "eth_sendTransaction": {
      const [tx] = params;
      const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, gas: tx.gas ? BigInt(tx.gas) : undefined });
      return { result: hash };
    }
    default: {
      const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const json = await res.json();
      return json.error ? { error: json.error } : { result: json.result };
    }
  }
});
await page.addInitScript((stream) => {
  window.AGENT_LIVE_CONFIG = { stream };
  window.ethereum = {
    async request({ method, params }) {
      const r = await window.__wallet(method, params || []);
      if (r.error) throw Object.assign(new Error(r.error.message), r.error);
      return r.result;
    },
    on() {},
  };
}, STREAM);
await page.goto(`http://localhost:${port}/`, { waitUntil: "load" });

console.log("\nthe page's agent demo, run from a wallet against the dev node");
const recipient = privateKeyToAccount(generatePrivateKey()).address;
const before = await balanceOf(me.address);
await page.fill("#al-to", recipient);
await page.click("#al-run");
await page.waitForFunction(() => window.__agentLive && !window.__agentLive.running && window.__agentLive.results.length > 0, null, { timeout: 180_000, polling: 500 });
const { done, results } = await page.evaluate(() => window.__agentLive);
const status = await page.locator("#al-status").textContent();
check(done === true, "the demo ran to the end", { status, results });
check(JSON.stringify(results.map((r) => r.request.intent)) === JSON.stringify(["open_stream", "withdraw_from_stream", "cancel_stream"]), "it sent open_stream, withdraw_from_stream, cancel_stream");
const [opened, paid, cancelled] = results.map((r) => r.result);
for (const r of [opened, paid, cancelled]) check(r.ok === true, `${r.intent} succeeded`, r);
check(await page.locator("#al-log .astep.good.done").count() === 4, "every step is shown as done, with the wait");
check(await page.locator("#al-log details pre").count() === 3, "each intent shows its JSON");
check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), "no horizontal scroll at phone width with the results shown");

console.log("\nthe same fields as the agent CLI's results in this job's agent run");
const log = readFileSync(need("AGENT_LOG"), "utf8");
const line = log.split("\n").find((l) => l.startsWith("AGENT_TRANSCRIPT "));
check(Boolean(line), "the agent run's transcript is in AGENT_LOG");
const transcript = JSON.parse(line.slice("AGENT_TRANSCRIPT ".length)).steps;
for (const r of [opened, paid, cancelled]) {
  const theirs = transcript.find((s) => s.contract === "stream" && s.intent.intent === r.intent && s.result.ok)?.result;
  check(Boolean(theirs), `the CLI ran ${r.intent} successfully in this job`);
  // approvalTxHash is present only when an approval was needed, in either run
  const strip = (x) => { const { approvalTxHash, ...rest } = x; return rest; };
  check(JSON.stringify(shape(strip(r))) === JSON.stringify(shape(strip(theirs))), `${r.intent}: same fields and types as the CLI`, { page: shape(r), cli: shape(theirs) });
}

console.log("\nidentical JSON from the page's port and the CLI for the same calls");
const id = opened.streamId;
const run = (intent) => page.evaluate((i) => window.__agentLive.runIntent(i), intent);
for (const intent of [
  { intent: "get_stream", id },
  { intent: "cancel_stream", id }, // already cancelled: the contract's NotActive, with its hint
  { intent: "open_stream", recipient, amountTokens: "100000000", durationSeconds: 60 }, // more than the account holds
  { intent: "open_stream", recipient, amountTokens: "0.0000000000000000001", durationSeconds: 60 }, // more decimals than the token
]) {
  const [fromPage, fromCli] = [await run(intent), cli(intent)];
  check(JSON.stringify(fromPage) === JSON.stringify(fromCli), `${intent.intent} ${fromCli.ok ? "" : `(${fromCli.error.code}) `}is byte-for-byte the CLI's result`, { page: fromPage, cli: fromCli });
}

console.log("\nthe chain agrees with what the page reported");
const amount = BigInt(opened.amount);
check(getAddress(recipient) === opened.recipient, "the recipient is reported checksummed, as the CLI reports it");
check(BigInt(paid.paidToRecipient) > 0n, `the payout paid something (${paid.paidToRecipient})`);
check(BigInt(paid.paidToRecipient) + BigInt(cancelled.paidToRecipient) + BigInt(cancelled.refundedToSender) === amount, "paid + paid on cancel + refunded = the deposit");
check(await balanceOf(recipient) === BigInt(paid.paidToRecipient) + BigInt(cancelled.paidToRecipient), "the recipient holds exactly what the page said it was paid");
check(before - (await balanceOf(me.address)) === BigInt(paid.paidToRecipient) + BigInt(cancelled.paidToRecipient), "the sender is down exactly that");
const [, , , , , , state] = await pub.readContract({ address: STREAM, abi: streamAbi, functionName: "stream", args: [BigInt(id)] });
check(state === 2, "the stream is cancelled on-chain");
for (const hash of [opened.txHash, paid.txHash, cancelled.txHash]) {
  check((await pub.getTransactionReceipt({ hash })).status === "success", `transaction ${hash.slice(0, 10)}… succeeded`);
}
check(errors.length === 0 || errors.every((e) => /fetch|net::|ERR_/i.test(e)), "no script errors", errors);

ticking = false;
await tickLoop;
await browser.close();
server.close();
console.log(`\nall ${checks} live agent demo checks passed`);
