// Records the narrated demo: every scene is timed to the narration in timing.json (from narrate.py). The site runs from
// web/ against contracts that chain.sh deployed on a local Arbitrum Nitro dev node, with a stand-in wallet; the terminal
// scene replays real output captured from the published package. Writes raw.webm and marks.json (section start times).
//
//   node narrated.mjs <repo> <chain-dir> <term-dir>
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const [repo, chainDir, termDir] = process.argv.slice(2);
const here = new URL(".", import.meta.url).pathname;
const timing = JSON.parse(readFileSync(join(here, "timing.json"), "utf8"));
const chainInfo = JSON.parse(readFileSync(join(chainDir, "chain.json"), "utf8"));
const web = join(repo, "web/");
const rpc = "http://127.0.0.1:8547";
const chain = defineChain({ id: 412346, name: "devnode", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const pub = createPublicClient({ chain, transport: http(rpc) });
const deployer = createWalletClient({ account: privateKeyToAccount(chainInfo.key), chain, transport: http(rpc) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.log(`[rec] ${m}`);

// ---- real terminal output ------------------------------------------------------------------------------------------
const created = readFileSync(join(termDir, "created.txt"), "utf8").split("\n").filter((l) => !/^> /.test(l)).join("\n").trim().split("\n");
const tested = readFileSync(join(termDir, "tested.txt"), "utf8").split("\n").filter((l) => /^(running \d+ tests|test .* \.\.\. ok|test result:)/.test(l));
const listed = readFileSync(join(termDir, "list.txt"), "utf8").trim().split("\n");

// ---- a visitor with gas and test BUIDL; a ticker so the idle dev node's clock keeps moving ---------------------------------
const visitor = privateKeyToAccount(generatePrivateKey());
const wallet = createWalletClient({ account: visitor, chain, transport: http(rpc) });
const erc20 = parseAbi(["function transfer(address to, uint256 value) returns (bool)"]);
await pub.waitForTransactionReceipt({ hash: await deployer.sendTransaction({ to: visitor.address, value: parseEther("1") }) });
await pub.waitForTransactionReceipt({ hash: await deployer.writeContract({ address: chainInfo.token, abi: erc20, functionName: "transfer", args: [visitor.address, parseEther("100")] }) });
await pub.waitForTransactionReceipt({ hash: await deployer.writeContract({ address: chainInfo.token, abi: erc20, functionName: "transfer", args: [chainInfo.faucet, parseEther("10000")] }) });
const ticker = privateKeyToAccount(generatePrivateKey());
await pub.waitForTransactionReceipt({ hash: await deployer.sendTransaction({ to: ticker.address, value: parseEther("0.1") }) });
const tickWallet = createWalletClient({ account: ticker, chain, transport: http(rpc) });
let ticking = true;
const tickLoop = (async () => {
  while (ticking) {
    try { await pub.waitForTransactionReceipt({ hash: await tickWallet.sendTransaction({ to: ticker.address, value: 0n }) }); } catch {}
    await sleep(2000);
  }
})();

// ---- the site, pointed at the local contracts ------------------------------------------------------------------------
function rewrite(text, pairs, file) {
  for (const [from, to] of pairs) {
    if (!text.includes(from)) throw new Error(`${file}: expected ${JSON.stringify(from)}`);
    text = text.split(from).join(to);
  }
  return text;
}
const pg = readFileSync(join(web, "playground.js"), "utf8");
const sepolia = Object.fromEntries(["token", "stream", "escrow", "vault", "faucet"].map((k) => [k, new RegExp(`\\b${k}: "(0x[0-9a-f]{40})"`).exec(pg)[1]]));
const html = readFileSync(join(web, "index.html"), "utf8");
sepolia.counter = /title: "Counter"[\s\S]*?address: "(0x[0-9a-f]{40})"/.exec(html)[1];
const swaps = Object.entries(sepolia).map(([k, a]) => [a, chainInfo[k].toLowerCase()]);
const files = {
  "playground.js": rewrite(pg, [...swaps.filter(([a]) => pg.includes(a)), ["(await chainNow()) + 45", "(await chainNow()) + 3"], ["starts in about 45 seconds", "starts in about 3 seconds"]], "playground.js"),
  "index.html": rewrite(html, swaps.filter(([a]) => html.includes(a)), "index.html"),
};
const server = createServer((req, res) => {
  const path = req.url === "/" ? "index.html" : decodeURIComponent(req.url.slice(1).split("?")[0]);
  if (files[path]) {
    res.setHeader("content-type", path.endsWith(".html") ? "text/html" : "text/javascript");
    return res.end(files[path]);
  }
  try { res.end(readFileSync(join(web, path))); } catch { res.statusCode = 404; res.end(); }
}).listen(8840);

// ---- record ------------------------------------------------------------------------------------------------------------
const videoDir = join(here, "raw");
rmSync(videoDir, { recursive: true, force: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 1024, height: 576 }, colorScheme: "dark", recordVideo: { dir: videoDir, size: { width: 1024, height: 576 } } });
const t0 = Date.now();
const page = await context.newPage();
page.on("pageerror", (e) => say(`page error: ${e.message}`));
await page.route("https://sepolia-rollup.arbitrum.io/rpc", async (route) => {
  const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: route.request().postData() });
  await route.fulfill({ status: 200, contentType: "application/json", body: await res.text() });
});
await page.exposeFunction("__wallet", async (method, params) => {
  switch (method) {
    case "eth_requestAccounts":
    case "eth_accounts":
      return { result: [visitor.address.toLowerCase()] };
    case "eth_chainId":
      return { result: "0x66eee" };
    case "wallet_switchEthereumChain":
      return { result: null };
    case "eth_sendTransaction": {
      const [tx] = params;
      return { result: await wallet.sendTransaction({ to: tx.to, data: tx.data, gas: tx.gas ? BigInt(tx.gas) : undefined }) };
    }
    default: {
      const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const json = await res.json();
      return json.error ? { error: json.error } : { result: json.result };
    }
  }
});
await page.addInitScript(() => {
  window.AGENT_LIVE_CONFIG = { startIn: 3, earnFor: 5 };
  window.ethereum = {
    async request({ method, params }) {
      const r = await window.__wallet(method, params || []);
      if (r.error) throw Object.assign(new Error(r.error.message), r.error);
      return r.result;
    },
    on() {},
  };
  try { localStorage.clear(); } catch {}
  addEventListener("DOMContentLoaded", () => {
    const css = document.createElement("style");
    css.textContent = `
      #v-badge { position: fixed; top: 12px; right: 14px; z-index: 99999; font: 600 12px system-ui, sans-serif; color: #c9f7e8;
        background: rgba(8, 40, 32, .85); border: 1px solid rgba(61,220,151,.5); padding: 5px 10px; border-radius: 999px; }
      #v-cur { position: fixed; z-index: 100000; left: 980px; top: 620px; width: 22px; height: 22px; margin: -4px 0 0 -4px; pointer-events: none;
        transition: left .7s cubic-bezier(.3,.8,.3,1), top .7s cubic-bezier(.3,.8,.3,1); }
      #v-cur svg { filter: drop-shadow(0 2px 4px rgba(0,0,0,.6)); }
      #v-cur.press::after { content: ""; position: absolute; left: -14px; top: -14px; width: 36px; height: 36px; border-radius: 50%;
        border: 3px solid #ff4fa3; animation: vring .5s ease-out forwards; }
      @keyframes vring { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.5); opacity: 0; } }
      .v-glow { outline: 3px solid #ff4fa3 !important; outline-offset: 4px; border-radius: 12px; transition: outline-color .3s; }`;
    document.head.append(css);
    const badge = Object.assign(document.createElement("div"), { id: "v-badge", textContent: "● real transactions · local Arbitrum Nitro dev node" });
    const cur = Object.assign(document.createElement("div"), { id: "v-cur", innerHTML: '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l15 8-7 1.5L8 19z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>' });
    document.body.append(cur);
    if (location.protocol === "http:") document.body.append(badge);
  });
});

// Timeline helpers: section i starts at marks[i]; at(i, n) waits for line n of section i.
const marks = [];
const now = () => (Date.now() - t0) / 1000;
const begin = async (i) => {
  if (i > 0) { const end = marks[i - 1] + timing[i - 1].dur; while (now() < end) await sleep(40); }
  marks[i] = now();
  say(`section ${i + 1} at ${marks[i].toFixed(2)}s`);
};
const at = async (i, n) => { const t = marks[i] + timing[i].lines[n].s; while (now() < t) await sleep(30); };
// Content above a target can grow while it is on screen (the agent replay animates in), so every scroll pins its target:
// a loop in the page keeps it at the same place until the next scroll.
async function pinTo(find, offset) {
  await page.evaluate(([f, o]) => {
    clearInterval(window.__pin);
    const el = () => (f.text ? [...document.querySelectorAll(f.tag)].find((n) => n.textContent.includes(f.text)) : document.querySelector(f.sel));
    const target = () => { const e = el(); return e ? e.getBoundingClientRect().top + scrollY - o : scrollY; };
    scrollTo({ top: target(), behavior: "smooth" });
    const t0 = Date.now();
    window.__pin = setInterval(() => {
      if (Date.now() - t0 < 1100) return;
      const d = target() - scrollY;
      if (Math.abs(d) > 3) scrollTo({ top: target(), behavior: "instant" });
    }, 120);
  }, [find, offset]);
  await sleep(1100);
}
const scrollTo = (selector, offset = 70) => pinTo({ sel: selector }, offset);
const scrollToText = (tag, text, offset = 70) => pinTo({ tag, text }, offset);
async function pointAt(selector) {
  const box = await page.locator(selector).first().boundingBox();
  await page.evaluate(([x, y]) => { const c = document.getElementById("v-cur"); if (c) { c.style.left = x + "px"; c.style.top = y + "px"; } }, [box.x + box.width / 2, box.y + box.height / 2]);
  await sleep(750);
}
async function click(selector) {
  await pointAt(selector);
  await page.evaluate(() => { const c = document.getElementById("v-cur"); c.classList.remove("press"); void c.offsetWidth; c.classList.add("press"); });
  await page.locator(selector).first().click();
}
const glow = (selector, on = true) => page.evaluate(([s, v]) => document.querySelector(s)?.classList.toggle("v-glow", v), [selector, on]);

// 1. Hook: the top of the site.
await page.goto("http://localhost:8840/", { waitUntil: "load" });
await sleep(400);
await begin(0);
await at(0, 2);
await glow(".term");

// 2. One command: the terminal, with the real output.
await begin(1);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
await page.setContent(`<!doctype html><html><head><style>
  body { margin: 0; height: 100vh; display: grid; place-items: center; background: radial-gradient(1200px 600px at 30% 20%, #1b2a4a, #0b0f17 60%);
    color: #e6edf3; font-family: system-ui, -apple-system, Segoe UI, sans-serif; overflow: hidden; }
  .term { width: 940px; background: #0a0e14; border: 1px solid #2c3a52; border-radius: 14px; box-shadow: 0 0 0 1px #a855f744, 0 20px 80px #000a; margin-bottom: 70px; }
  .bar { padding: 10px 14px; border-bottom: 1px solid #1f2a3a; } .bar b { display: inline-block; width: 12px; height: 12px; border-radius: 50%; margin-right: 6px; }
  pre { margin: 0; padding: 14px 20px; font: 14px/1.5 ui-monospace, Menlo, Consolas, monospace; height: 380px; overflow: hidden; white-space: pre-wrap; }
  .p { color: #3ddc97; } .ok { color: #3ddc97; } .dim { color: #8b98a9; } .cmd { color: #fff; } .cur::after { content: "▍"; color: #ff4fa3; }
  .hl { color: #ffd84d; }
</style></head><body>
  <div class="term"><div class="bar"><b style="background:#ff5f57"></b><b style="background:#febc2e"></b><b style="background:#28c840"></b></div><pre id="out"></pre></div>
</body></html>`);
async function typeLine(text) {
  await page.evaluate(() => { document.getElementById("out").insertAdjacentHTML("beforeend", `<span class="p">$ </span><span class="cmd cur"></span>`); });
  for (let i = 1; i <= text.length; i += 2) {
    await page.evaluate((t) => { [...document.querySelectorAll(".cmd")].pop().textContent = t; }, text.slice(0, i));
    await sleep(26);
  }
  await page.evaluate((t) => { const c = [...document.querySelectorAll(".cmd")].pop(); c.textContent = t; c.classList.remove("cur"); document.getElementById("out").insertAdjacentText("beforeend", "\n"); }, text);
  await sleep(300);
}
async function printLines(lines, gap, cls = () => "") {
  for (const l of lines) {
    await page.evaluate(([t, c]) => { const o = document.getElementById("out"); o.insertAdjacentHTML("beforeend", `<span class="${c}">${t}</span>\n`); o.scrollTop = o.scrollHeight; }, [esc(l), cls(l)]);
    await sleep(gap);
  }
}
const clear = () => page.evaluate(() => { document.getElementById("out").textContent = ""; });
await typeLine("npm create stylus-latest my-app -- -t stream --with-client");
await printLines(created, 90, (l) => (/^Created/.test(l) ? "ok" : /stylus-sdk/.test(l) ? "hl" : /^\s/.test(l) ? "dim" : ""));
await at(1, 3);
await clear();
await typeLine("cd my-app && cargo test");
await printLines(tested, 70, (l) => (/test result: ok/.test(l) ? "ok" : /properties::/.test(l) ? "hl" : /\.\.\. ok$/.test(l) ? "dim" : ""));
await at(1, 4);
await clear();
await typeLine("npx create-stylus-latest --list");
await printLines(listed, 160, (l) => "");

// 3. Zero install: the Codespace card.
await begin(2);
await page.goto("http://localhost:8840/", { waitUntil: "load" });
await sleep(300);
await scrollTo(".cs-cta", 140);
await glow(".cs-cta");
await pointAt(".cs-cta .cs-go");
await at(2, 2);
await glow(".cs-cta", false);

// 4. Live on-chain: the contract cards, then a real stream.
await begin(3);
await scrollTo("#contracts", 150);
await at(3, 2);
await scrollTo("#pg-stream-amount", 230);
await page.fill("#pg-stream-seconds", "20");
await click("#pg-stream-create");
await page.waitForSelector("#pg-stream-msg.ok", { timeout: 60_000 }).catch(() => say("stream create not confirmed in time"));
await scrollTo("#pg-stream-view", 200);
await at(3, 4);
await scrollTo("#pg-deal-create", 260);
await at(3, 5);
await scrollTo("#pg-vault-deposit", 260);

// 5. AI agents: the live agent demo.
await begin(4);
await scrollTo("#agent-live", 20);
await click("#al-run");
await page.waitForFunction(() => window.__agentLive && window.__agentLive.done, null, { timeout: 120_000, polling: 300 }).catch(() => say("agent demo not done in time"));
await at(4, 3);
for (const n of [1, 3, 4]) {
  await scrollTo(`#al-log > li:nth-child(${n})`, 60);
  await page.evaluate((k) => { const d = document.querySelector(`#al-log > li:nth-child(${k}) details`); if (d) d.open = true; }, n);
  await sleep(1800);
}
await at(4, 6);
await scrollTo("#al-summary", 300);

// 6. Proof: gas, the comparison, the numbers, Robinhood Chain.
await begin(5);
await scrollTo("#gas", 20);
await at(5, 2);
await scrollTo("#compare", 20);
await at(5, 4);
await scrollTo(".stats", 140);
await at(5, 5);
await scrollToText("h2", "Also live on Robinhood Chain", 20);

// 7. Trust and close.
await begin(6);
await scrollTo("#security", 20);
await at(6, 3);
await page.setContent(`<!doctype html><html><head><style>
  body { margin: 0; height: 100vh; display: grid; place-items: center; background: radial-gradient(1200px 600px at 70% 20%, #2a1b4a, #0b0f17 60%);
    color: #e6edf3; font-family: system-ui, -apple-system, Segoe UI, sans-serif; text-align: center; }
  h1 { font-size: 42px; margin: 0 0 8px; letter-spacing: -1px; }
  h1 span { background: linear-gradient(90deg,#28a0f0,#a855f7,#ff4fa3,#ff9b3d); -webkit-background-clip: text; background-clip: text; color: transparent; }
  p.t { font-size: 18px; color: #9fb0c3; margin: 0 0 26px; }
  code { font: 600 24px ui-monospace, Menlo, Consolas, monospace; color: #fff; background: #0a0e14; border: 1px solid #a855f7; padding: 10px 20px; border-radius: 12px; }
  ul { list-style: none; padding: 0; margin: 26px 0 0; font-size: 17px; line-height: 1.8; color: #9fb0c3; } b { color: #e6edf3; }
  .note { margin: 18px auto 0; font-size: 12px; color: #8b98a9; max-width: 760px; }
</style></head><body><div style="margin-bottom:80px">
  <h1><span>create-stylus-latest</span></h1>
  <p class="t">From <b>npm create</b> to a live Stylus contract, on the first try.</p>
  <code>npm create stylus-latest my-app</code>
  <ul><li><b>Live site</b> · npx-create-stylus-latest-web-mocha.vercel.app</li><li><b>npm</b> · create-stylus-latest</li>
    <li><b>GitHub</b> · github.com/ramadan904/npx-create-stylus-latest</li></ul>
  <p class="note">Recorded from a real run: real npm and cargo output, and real transactions to contracts this tool deployed on a local
    Arbitrum Nitro dev node. On the live site the same page runs on Arbitrum Sepolia with your wallet.</p>
</div></body></html>`);
const end = marks[6] + timing[6].dur + 1.0;
while (now() < end) await sleep(50);

const video = page.video();
await context.close();
await browser.close();
server.close();
ticking = false;
await tickLoop;
renameSync(await video.path(), join(here, "raw.webm"));
writeFileSync(join(here, "marks.json"), JSON.stringify({ marks, end }));
say(`done: ${end.toFixed(1)}s`);
process.exit(0);
