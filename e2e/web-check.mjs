import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { encodeFunctionData, parseAbi, encodeErrorResult, parseUnits, formatUnits, getAddress } from "viem";
import { randomBytes } from "node:crypto";

// Serves web/ locally and checks the playground in a real browser: no script errors, phone layout, and the pure logic
// that is easy to get wrong without a library (amount parsing, calldata, revert decoding, the earning curve), compared
// with viem. Live chain reads are not needed. CHROME_PATH picks the browser (GitHub runners ship Google Chrome).
const web = new URL("../web/", import.meta.url).pathname;
const server = createServer((req, res) => {
  if (req.url === "/favicon.ico") { res.statusCode = 204; return res.end(); }
  const path = req.url === "/" ? "index.html" : req.url.slice(1);
  try { res.end(readFileSync(web + path)); } catch { res.statusCode = 404; res.end(); }
}).listen(Number(process.env.PORT || 8811));

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome" });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } }); // phone width
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
await page.goto(`http://localhost:${process.env.PORT || 8811}/`, { waitUntil: "load" });
await page.waitForTimeout(2500);

let fail = 0;
const check = (cond, label, extra = "") => { console.log((cond ? "ok   " : "FAIL ") + label + (cond ? "" : " " + extra)); if (!cond) fail++; };

// 1. the page has no script errors, apart from network reads the sandbox may block
// Until CI has produced web/agent-demo.json, loading it 404s; the page handles that, so it is not a script error.
const demoMissing = !existsSync(web + "agent-demo.json");
const scriptErrors = errors.filter((e) => !/Failed to fetch|net::|ERR_|fetch/i.test(e) && !(demoMissing && /status of 404/.test(e)));
check(scriptErrors.length === 0, "no script errors on load", JSON.stringify(scriptErrors));
check(await page.evaluate(() => typeof ABI === "object" && typeof PG === "object"), "abi.js and playground.js loaded");
if (await page.evaluate(() => PG.faucet === null)) {
  check(await page.locator("#pg-drip").isDisabled(), "the drip button is disabled while no faucet is configured");
  check((await page.locator("#pg-faucet-next").textContent()).includes("not deployed yet"), "and the page says why");
} else {
  check(await page.evaluate(() => /^0x[0-9a-f]{40}$/.test(PG.faucet)), "the configured faucet is a lowercase address");
}
check(await page.locator("#pg-stream-to").inputValue() === "0x000000000000000000000000000000000000dEaD", "a non-self demo recipient is prefilled");
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check(!overflow, "no horizontal scroll at phone width");

// 2. amounts: decimal text -> base units, compared with viem's parseUnits
for (const t of ["10", "2.5", "0.000000000000000001", "1234567.891"]) {
  const got = await page.evaluate((x) => parseAmount(x).toString(), t);
  check(got === parseUnits(t, 18).toString(), `parseAmount("${t}")`, got);
}
for (const t of ["0", "-1", "1e3", "abc", "1.0000000000000000001", ""]) {
  const threw = await page.evaluate((x) => { try { parseAmount(x); return false; } catch { return true; } }, t);
  check(threw, `parseAmount rejects "${t}"`);
}

// 3. calldata the page builds == viem's encodeFunctionData for the same call
const abi = parseAbi([
  "function create(address recipient, uint256 amount, uint256 start, uint256 stop)",
  "function approve(address spender, uint256 value)",
  "function allowance(address owner, address spender)",
  "function deposit(uint256 amount)",
]);
const escrowAbi = parseAbi(["function create(address seller, uint256 amount, uint256 deadline, address arbiter)"]);
const A = "0x1111111111111111111111111111111111111111", B = "0xabcdef0123456789abcdef0123456789abcdef01";
const cases = [
  ["stream.create", `callData(ABI.sel.stream.create, encAddr("${B}"), encUint(10n**19n), encUint(1790000000), encUint(1790000120))`,
    encodeFunctionData({ abi, functionName: "create", args: [B, 10n ** 19n, 1790000000n, 1790000120n] })],
  ["escrow.create", `callData(ABI.sel.escrow.create, encAddr("${B}"), encUint(5n), encUint(99), encAddr("0x0000000000000000000000000000000000000000"))`,
    encodeFunctionData({ abi: escrowAbi, functionName: "create", args: [B, 5n, 99n, "0x0000000000000000000000000000000000000000"] })],
  ["token.approve", `callData(ABI.sel.token.approve, encAddr("${A}"), encUint(2n**256n-1n))`,
    encodeFunctionData({ abi, functionName: "approve", args: [A, 2n ** 256n - 1n] })],
  ["token.allowance", `callData(ABI.sel.token.allowance, encAddr("${B}"), encAddr("${A}"))`,
    encodeFunctionData({ abi, functionName: "allowance", args: [B, A] })],
  ["vault.deposit", `callData(ABI.sel.vault.deposit, encUint(12345))`, encodeFunctionData({ abi, functionName: "deposit", args: [12345n] })],
];
for (const [label, expr, want] of cases) {
  const got = await page.evaluate(expr);
  check(got.toLowerCase() === want.toLowerCase(), `calldata for ${label} matches viem`, `\n  got  ${got}\n  want ${want}`);
}

// 4. revert decoding: real ABI-encoded custom errors, wrapped the way wallets nest them
const errAbi = parseAbi(["error TooSoon(uint256 availableAt)", "error NotAuthorized()", "error InsufficientBalance(address from, uint256 have, uint256 want)"]);
const tooSoon = encodeErrorResult({ abi: errAbi, errorName: "TooSoon", args: [1790000000n] });
const notAuth = encodeErrorResult({ abi: errAbi, errorName: "NotAuthorized" });
const broke = encodeErrorResult({ abi: errAbi, errorName: "InsufficientBalance", args: [A, 10n ** 18n, 5n * 10n ** 18n] });
for (const [label, err, expect] of [
  ["TooSoon in err.data", { message: "execution reverted", data: tooSoon }, "(TooSoon)"],
  ["NotAuthorized nested like MetaMask", { code: -32603, message: "Internal JSON-RPC error.", data: { code: 3, message: "execution reverted", data: notAuth } }, "(NotAuthorized)"],
  ["InsufficientBalance with amounts", { error: { data: broke } }, "you have 1 BUIDL, this needs 5 BUIDL"],
]) {
  const text = await page.evaluate((e) => describe(e), err);
  check(text.includes(expect), `describe: ${label}`, JSON.stringify(text));
}
const plain = await page.evaluate(() => describe({ code: 4001, message: "User rejected" }));
check(plain === "Cancelled in your wallet.", "a wallet rejection is described plainly", JSON.stringify(plain));

// 5. the earning curve the page animates matches the contract's arithmetic
const curve = await page.evaluate(() => {
  const s = { deposit: 1000n, start: 100, stop: 140 };
  return [99, 100, 101, 118, 139, 140, 500].map((t) => earnedAt(s, t).toString());
});
check(JSON.stringify(curve) === JSON.stringify(["0", "0", "25", "450", "975", "1000", "1000"]), "earnedAt matches the contract (450 of 1000 at 18 s of 40)", JSON.stringify(curve));

// 7. the gas comparison shows exactly the numbers the benchmark measured (bench/README.md), so it cannot drift
const bench = readFileSync(new URL("../bench/README.md", import.meta.url), "utf8");
const measured = Object.fromEntries([...bench.matchAll(/^\| (.+?) \| ([\d,]+) \| ([\d,]+) \|$/gm)]
  .map(([, label, sty, sol]) => [label.replaceAll("`", ""), [sty, sol]]));
const shown = await page.evaluate(() => [...document.querySelectorAll("#gas .grow")].map((r) => [r.dataset.key, [...r.querySelectorAll("em")].map((e) => e.textContent)]));
check(shown.length >= 4, `the gas comparison has rows (${shown.length})`);
for (const [key, [sty, sol]] of shown) {
  check(JSON.stringify(measured[key]) === JSON.stringify([sty, sol]), `gas row "${key}" matches bench/README.md`, `page ${sty}/${sol}, README ${measured[key]}`);
}

// 6. the recorded agent run: every step renders with its result, it links its CI run, and it fits a phone.
// Reduced motion makes the replay render at once instead of animating.
let demo = null;
try { demo = JSON.parse(readFileSync(web + "agent-demo.json", "utf8")); } catch { console.log("skip agent replay checks: web/agent-demo.json not generated yet"); }
if (demo) {
check(demo.steps.length >= 10 && demo.steps.every((s) => s.result && typeof s.result.ok === "boolean" && s.ok === s.result.ok), "agent-demo.json holds verbatim results for every step");
check(/^https:\/\/github\.com\/ramadan904\/npx-create-stylus-latest\/actions\/runs\/\d+/.test(demo.source), "the replay names the CI run it was recorded from", demo.source);
const still = await browser.newPage({ viewport: { width: 390, height: 900 }, reducedMotion: "reduce" });
still.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await still.goto(`http://localhost:${process.env.PORT || 8811}/`, { waitUntil: "load" });
await still.waitForTimeout(1500);
check(await still.locator("#agent-log .astep.done").count() === demo.steps.length, "the agent replay renders every step and its result");
check(await still.locator("#agent-log .astep.bad").count() === demo.steps.filter((s) => !s.ok).length, "refused steps are shown as refusals");
check(!(await still.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), "no horizontal scroll at phone width with the replay shown");
check(errors.filter((e) => !/Failed to fetch|net::|ERR_|fetch/i.test(e)).length === 0, "still no script errors", JSON.stringify(errors));
}

// 8. the live agent demo: ready to run, and its hand-written helpers agree with viem, which the agent itself uses.
// (Running it needs a chain: e2e/agent-live.mjs does that in the e2e-flows job and compares the results with the agent CLI's.)
check(await page.locator('a.btn[href="#agent-live"]').count() === 1, "the hero links to the live agent demo");
check(await page.locator("#al-run").isEnabled(), "the agent demo button is enabled");
check(await page.locator("#al-to").inputValue() === "0x000000000000000000000000000000000000dEaD", "the agent demo prefills a non-self recipient");
const addrs = ["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead", "0xffffffffffffffffffffffffffffffffffffffff",
  ...Array.from({ length: 40 }, () => "0x" + randomBytes(20).toString("hex"))];
const sums = await page.evaluate((list) => list.map((a) => __agentLive.helpers.checksum(a)), addrs);
check(sums.every((c, i) => c === getAddress(addrs[i])), `EIP-55 checksums match viem's getAddress (${addrs.length} addresses)`, JSON.stringify(sums.filter((c, i) => c !== getAddress(addrs[i]))));
const amounts = [[0n, 18], [1n, 18], [10n ** 18n, 18], [1500000000000000000n, 18], [123456789n, 6], [100n, 0], [-25n, 1]];
const formatted = await page.evaluate((list) => list.map(([v, d]) => __agentLive.helpers.formatUnits(BigInt(v), d)), amounts.map(([v, d]) => [v.toString(), d]));
check(formatted.every((f, i) => f === formatUnits(...amounts[i])), "formatUnits matches viem", JSON.stringify(formatted));
for (const [t, d] of [["10", 18], ["2.5", 6], ["0.000001", 6], ["7", 0]]) {
  const got = await page.evaluate(([x, n]) => __agentLive.helpers.tokensToUnits("amountTokens", x, n).toString(), [t, d]);
  check(got === parseUnits(t, d).toString(), `tokensToUnits("${t}", ${d})`, got);
}
check(await page.evaluate(() => { try { __agentLive.helpers.tokensToUnits("amountTokens", "1.0000001", 6); return false; } catch (e) { return e.code === "InvalidInput"; } }),
  "tokensToUnits refuses more decimals than the token has, with the agent's error code");
await page.locator("#al-run").click();
await page.waitForTimeout(300);
check(/No browser wallet/.test(await page.locator("#al-status").textContent()), "without a wallet the demo says what is missing");

await browser.close(); server.close();
console.log(fail ? `\n${fail} FAILED` : "\nall page checks passed");
process.exit(fail ? 1 : 0);
