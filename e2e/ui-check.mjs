// Drives the page that `--with-ui` generates, in a real browser, against a deployed counter on the local dev node:
// it lists every function, reads `number` on load, signs `increment` with the dev-node key, and reads the new value.
//
//   UI_URL=http://127.0.0.1:5173 node ui-check.mjs        (with ./scripts/ui.sh running in the scaffolded project)
//
// The page loads viem from esm.sh. Where esm.sh is unreachable, VIEM_BUNDLE_DIR may point at a local build of the same
// viem (viem.js and accounts.js); in CI the page loads it from esm.sh like a user's browser does.
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const url = process.env.UI_URL || "http://127.0.0.1:5173";
let failures = 0;
const check = (cond, label, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond ? "" : ` ${extra}`}`);
  if (!cond) failures++;
};

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome" });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
if (process.env.VIEM_BUNDLE_DIR) {
  const dir = process.env.VIEM_BUNDLE_DIR;
  await page.route(/^https:\/\/esm\.sh\/viem@[^/]+(\/accounts)?$/, (route) =>
    route.fulfill({ contentType: "text/javascript", body: readFileSync(join(dir, route.request().url().endsWith("/accounts") ? "accounts.js" : "viem.js")) }));
}

await page.goto(url, { waitUntil: "load" });
await page.waitForFunction(() => window.__ui?.ready, null, { timeout: 30_000 });
const out = (fn) => page.locator(`.fn[data-fn="${fn}"] .out`);

const names = await page.locator(".fn").evaluateAll((cards) => cards.map((c) => c.dataset.fn).sort());
check(JSON.stringify(names) === JSON.stringify(["addNumber", "increment", "number", "setNumber"]), "every function of the counter has a card", JSON.stringify(names));
await page.waitForFunction(() => document.querySelector('.fn[data-fn="number"] .out.ok'), null, { timeout: 20_000 });
const before = BigInt(JSON.parse(await out("number").textContent()));
check(true, `number() was read on load: ${before}`);

check(await page.locator("#devkey").isVisible(), "the dev node key is offered (chain 412346)");
await page.click("#devkey");
check(/dev node key: 0x[0-9a-fA-F]{40}/.test(await page.locator("#who").textContent()), "signing with the dev node key");

await page.locator('.fn[data-fn="increment"] button').click();
await page.waitForFunction(() => /confirmed in block/.test(document.querySelector('.fn[data-fn="increment"] .out')?.textContent || "") || document.querySelector('.fn[data-fn="increment"] .out.bad'), null, { timeout: 60_000 });
check(/confirmed in block \d+ · tx 0x[0-9a-f]{64}/.test(await out("increment").textContent()), "increment() was sent and confirmed", await out("increment").textContent());
await page.waitForFunction((b) => { const t = document.querySelector('.fn[data-fn="number"] .out')?.textContent; return t && BigInt(JSON.parse(t)) === BigInt(b) + 1n; }, before.toString(), { timeout: 20_000 }).catch(() => {});
check(BigInt(JSON.parse(await out("number").textContent())) === before + 1n, `number() went from ${before} to ${before + 1n}`);

await page.locator('.fn[data-fn="setNumber"] input').fill("not a number");
await page.locator('.fn[data-fn="setNumber"] button').click();
await page.waitForFunction(() => document.querySelector('.fn[data-fn="setNumber"] .out.bad'), null, { timeout: 10_000 });
check(/whole number/.test(await out("setNumber").textContent()), "a bad argument is refused before anything is sent");

await page.locator('.fn[data-fn="setNumber"] input').fill("42");
await page.locator('.fn[data-fn="setNumber"] button').click();
await page.waitForFunction(() => /confirmed in block/.test(document.querySelector('.fn[data-fn="setNumber"] .out')?.textContent || ""), null, { timeout: 60_000 });
await page.waitForFunction(() => document.querySelector('.fn[data-fn="number"] .out')?.textContent === "42", null, { timeout: 20_000 }).catch(() => {});
check((await out("number").textContent()) === "42", "setNumber(42) then number() is 42");
check(errors.length === 0, "no script errors", JSON.stringify(errors));

await browser.close();
console.log(failures ? `\n${failures} UI checks FAILED` : "\nall UI checks passed");
process.exit(failures ? 1 : 0);
