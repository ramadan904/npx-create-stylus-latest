// Part 2 of the site's demo video: records the real thing, end to end, and encodes web/demo.mp4 and web/demo-poster.jpg.
//
//   e2e/video/chain.sh <dir> && node e2e/video/record.mjs <dir> [--reuse-terminal]   (after npm install in e2e/)
//
// Nothing in the video is mocked:
//   1. The terminal scene types the real commands and shows their real output: this script runs
//      `npx create-stylus-latest my-app -t stream --with-client` (the published package) and `cargo test` first.
//   2. The site scenes are the site itself (web/), driven in Chromium. Its transactions go to the contracts chain.sh
//      deployed on a local Arbitrum Nitro dev node, signed by a stand-in wallet for a fresh visitor key. While serving the
//      page, this script swaps the Sepolia addresses for the local ones and shortens two waits that exist to give a person
//      time to confirm in a wallet (the playground's stream start, the agent demo's start and earn waits). A badge in the
//      video says it runs on a local node.
// Needs: Docker dev node from chain.sh still running, Chromium (CHROME_PATH), ffmpeg with libx264.
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node e2e/video/record.mjs <dir written by chain.sh>");
const chainInfo = JSON.parse(readFileSync(join(dir, "chain.json"), "utf8"));
const repo = new URL("../../", import.meta.url).pathname;
const web = join(repo, "web/");
const rpc = "http://127.0.0.1:8547";
const chain = defineChain({ id: 412346, name: "devnode", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const pub = createPublicClient({ chain, transport: http(rpc) });
const deployer = createWalletClient({ account: privateKeyToAccount(chainInfo.key), chain, transport: http(rpc) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.log(`[record] ${m}`);

// ---- 1. the real terminal output ------------------------------------------------------------------------------------
const term = join(dir, "term");
const out = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", CARGO_TERM_COLOR: "never" } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
};
// --reuse-terminal replays the output captured by the previous run in <dir>/term instead of running the commands again.
const captured = join(term, "captured.json");
let created, tested;
if (process.argv.includes("--reuse-terminal") && existsSync(captured)) {
  ({ created, tested } = JSON.parse(readFileSync(captured, "utf8")));
} else {
  rmSync(term, { recursive: true, force: true });
  mkdirSync(term, { recursive: true });
  say("running npx create-stylus-latest (the published package)");
  created = out("npx", ["--yes", "create-stylus-latest@latest", "my-app", "-t", "stream", "--with-client"], term).trim().split("\n");
  say("running cargo test in the new project");
  tested = out("cargo", ["test", "--lib"], join(term, "my-app")).split("\n").filter((l) => /^(running \d+ tests|test .* \.\.\. ok|test result:)/.test(l));
  writeFileSync(captured, JSON.stringify({ created, tested }));
}
if (!tested.some((l) => l.startsWith("test result: ok"))) throw new Error("cargo test did not pass");

// ---- 2. a visitor with ETH for gas, and a faucet with tokens to give ----------------------------------------------------
const visitor = privateKeyToAccount(generatePrivateKey());
const wallet = createWalletClient({ account: visitor, chain, transport: http(rpc) });
const erc20 = parseAbi(["function transfer(address to, uint256 value) returns (bool)"]);
await pub.waitForTransactionReceipt({ hash: await deployer.sendTransaction({ to: visitor.address, value: parseEther("1") }) });
await pub.waitForTransactionReceipt({ hash: await deployer.writeContract({ address: chainInfo.token, abi: erc20, functionName: "transfer", args: [chainInfo.faucet, parseEther("10000")] }) });

// The dev node only mines when something is sent, so its clock stops between transactions; a real chain never idles.
// A third account sends itself nothing every two seconds so time-dependent calls see the current time.
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

// ---- 3. the site, pointed at the local contracts --------------------------------------------------------------------------
function rewrite(text, pairs, file) {
  for (const [from, to] of pairs) {
    if (!text.includes(from)) throw new Error(`${file}: expected to find ${JSON.stringify(from)}; the site changed, update record.mjs`);
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
}).listen(8830);

// ---- 4. record ----------------------------------------------------------------------------------------------------------
const videoDir = join(dir, "raw");
rmSync(videoDir, { recursive: true, force: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome" });
// The page is laid out at 1024x576 and scaled up to 720p when encoding, so the text reads larger in the video.
const context = await browser.newContext({ viewport: { width: 1024, height: 576 }, colorScheme: "dark", recordVideo: { dir: videoDir, size: { width: 1024, height: 576 } } });
const page = await context.newPage();
const videoStart = Date.now(); // for picking the poster frame
let posterAt = 5;
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
  // The video's own overlay: a caption bar, a "local node" badge and a visible pointer. Not part of the site.
  addEventListener("DOMContentLoaded", () => {
    const css = document.createElement("style");
    css.textContent = `
      #v-cap { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); z-index: 99999; max-width: 900px;
        font: 600 17px/1.35 system-ui, -apple-system, Segoe UI, sans-serif; color: #fff; padding: 12px 22px; border-radius: 14px;
        background: rgba(8, 12, 20, .86); border: 1px solid rgba(255,255,255,.18); box-shadow: 0 10px 40px rgba(0,0,0,.45);
        transition: opacity .35s; text-align: center; }
      #v-cap b { background: linear-gradient(90deg,#28a0f0,#a855f7,#ff4fa3); -webkit-background-clip: text; background-clip: text; color: transparent; }
      #v-cap:empty { opacity: 0; }
      #v-badge { position: fixed; top: 14px; right: 16px; z-index: 99999; font: 600 12.5px system-ui, sans-serif; color: #c9f7e8;
        background: rgba(8, 40, 32, .85); border: 1px solid rgba(61,220,151,.5); padding: 6px 11px; border-radius: 999px; }
      #v-cur { position: fixed; z-index: 100000; left: 640px; top: 760px; width: 22px; height: 22px; margin: -4px 0 0 -4px; pointer-events: none;
        transition: left .7s cubic-bezier(.3,.8,.3,1), top .7s cubic-bezier(.3,.8,.3,1); }
      #v-cur svg { filter: drop-shadow(0 2px 4px rgba(0,0,0,.6)); }
      #v-cur.press::after { content: ""; position: absolute; left: -14px; top: -14px; width: 36px; height: 36px; border-radius: 50%;
        border: 3px solid #ff4fa3; animation: vring .5s ease-out forwards; }
      @keyframes vring { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.5); opacity: 0; } }`;
    document.head.append(css);
    const cap = Object.assign(document.createElement("div"), { id: "v-cap" });
    const badge = Object.assign(document.createElement("div"), { id: "v-badge", textContent: "● real transactions · local Arbitrum Nitro dev node" });
    const cur = Object.assign(document.createElement("div"), { id: "v-cur", innerHTML: '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l15 8-7 1.5L8 19z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>' });
    document.body.append(cap, cur);
    if (location.protocol === "http:") document.body.append(badge);
  });
});

const caption = (htmlText) => page.evaluate((t) => { const c = document.getElementById("v-cap"); if (c) c.innerHTML = t; }, htmlText);
async function scrollTo(selector, offset = 70) {
  await page.evaluate(([s, o]) => { const e = document.querySelector(s); scrollTo({ top: e.getBoundingClientRect().top + scrollY - o, behavior: "smooth" }); }, [selector, offset]);
  await sleep(1100);
}
async function click(selector) {
  const box = await page.locator(selector).boundingBox();
  await page.evaluate(([x, y]) => { const c = document.getElementById("v-cur"); c.style.left = x + "px"; c.style.top = y + "px"; }, [box.x + box.width / 2, box.y + box.height / 2]);
  await sleep(800);
  await page.evaluate(() => { const c = document.getElementById("v-cur"); c.classList.remove("press"); void c.offsetWidth; c.classList.add("press"); });
  await page.locator(selector).click();
}

// Scene 1: title, then the terminal.
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
await page.setContent(`<!doctype html><html><head><style>
  body { margin: 0; height: 100vh; display: grid; place-items: center; background: radial-gradient(1200px 600px at 30% 20%, #1b2a4a, #0b0f17 60%);
    color: #e6edf3; font-family: system-ui, -apple-system, Segoe UI, sans-serif; overflow: hidden; }
  .card { text-align: center; } h1 { font-size: 54px; margin: 0 0 14px; letter-spacing: -1px; }
  h1 span { background: linear-gradient(90deg,#28a0f0,#a855f7,#ff4fa3,#ff9b3d); -webkit-background-clip: text; background-clip: text; color: transparent; }
  p { font-size: 20px; color: #9fb0c3; margin: 0; }
  .term { display: none; width: 920px; background: #0a0e14; border: 1px solid #2c3a52; border-radius: 14px; box-shadow: 0 0 0 1px #a855f744, 0 20px 80px #000a; }
  .bar { padding: 10px 14px; border-bottom: 1px solid #1f2a3a; } .bar b { display: inline-block; width: 12px; height: 12px; border-radius: 50%; margin-right: 6px; }
  pre { margin: 0; padding: 16px 20px; font: 14.5px/1.5 ui-monospace, Menlo, Consolas, monospace; height: 400px; overflow: hidden; white-space: pre-wrap; }
  .p { color: #3ddc97; } .ok { color: #3ddc97; } .dim { color: #8b98a9; } .cmd { color: #fff; } .cur::after { content: "▍"; color: #ff4fa3; }
</style></head><body>
  <div class="card" id="title"><h1><span>create-stylus-latest</span></h1><p>Scaffold, test and deploy Arbitrum Stylus contracts, ready for AI agents.</p></div>
  <div class="term" id="term"><div class="bar"><b style="background:#ff5f57"></b><b style="background:#febc2e"></b><b style="background:#28c840"></b></div><pre id="out"></pre></div>
</body></html>`);
await page.evaluate(() => {
  const css = document.createElement("style");
  css.textContent = `#v-cap{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);font:600 17px system-ui,sans-serif;color:#fff;padding:12px 22px;border-radius:14px;background:rgba(8,12,20,.86);border:1px solid rgba(255,255,255,.18)}#v-cap:empty{opacity:0}#v-cap b{background:linear-gradient(90deg,#28a0f0,#a855f7,#ff4fa3);-webkit-background-clip:text;background-clip:text;color:transparent}`;
  document.head.append(css);
  if (!document.getElementById("v-cap")) document.body.append(Object.assign(document.createElement("div"), { id: "v-cap" }));
});
await sleep(4000);
await page.evaluate(() => { document.getElementById("title").style.display = "none"; document.getElementById("term").style.display = "block"; });
await caption("<b>1</b> · One command scaffolds a Stylus project: contract, tests, deploy scripts, TypeScript client");
async function typeLine(text) {
  await page.evaluate((t) => { const o = document.getElementById("out"); o.insertAdjacentHTML("beforeend", `<span class="p">$ </span><span class="cmd cur"></span>`); }, text);
  for (let i = 1; i <= text.length; i += 2) {
    await page.evaluate((t) => { const c = [...document.querySelectorAll(".cmd")].pop(); c.textContent = t; }, text.slice(0, i));
    await sleep(28);
  }
  await page.evaluate((t) => { const c = [...document.querySelectorAll(".cmd")].pop(); c.textContent = t; c.classList.remove("cur"); document.getElementById("out").insertAdjacentText("beforeend", "\n"); }, text);
  await sleep(350);
}
async function printLines(lines, gap, cls = (l) => "") {
  for (const l of lines) {
    await page.evaluate(([t, c]) => { const o = document.getElementById("out"); o.insertAdjacentHTML("beforeend", `<span class="${c}">${t}</span>\n`); o.scrollTop = o.scrollHeight; }, [esc(l), cls(l)]);
    await sleep(gap);
  }
}
await typeLine("npx create-stylus-latest my-app -t stream --with-client");
await printLines(created, 110, (l) => (/^Created/.test(l) ? "ok" : /^\s/.test(l) ? "dim" : ""));
await sleep(2600);
await page.evaluate(() => { document.getElementById("out").textContent = ""; });
await caption("<b>2</b> · It compiles and its tests pass, including a property test against a reference model");
await typeLine("cd my-app && cargo test");
await printLines(tested, 120, (l) => (/test result: ok/.test(l) ? "ok" : /\.\.\. ok$/.test(l) ? "dim" : ""));
await sleep(2600);

// Scene 2: the site.
await page.goto("http://localhost:8830/", { waitUntil: "load" });
await caption("<b>3</b> · The project site: contracts deployed by the tool, and a playground to use them");
await sleep(3600);
await scrollTo("#playground");
await caption("<b>4</b> · Get test BUIDL from the faucet contract");
await click("#pg-drip");
await page.waitForSelector("#pg-faucet-msg.ok", { timeout: 60_000 });
await sleep(2800);
await caption("<b>5</b> · Stream 10 BUIDL to a recipient: it is paid out second by second");
await page.fill("#pg-stream-seconds", "30");
await click("#pg-stream-create");
await page.waitForSelector("#pg-stream-msg.ok", { timeout: 60_000 });
await scrollTo("#pg-stream-view", 220);
await sleep(9000);
await scrollTo("#agent-live");
await caption("<b>6</b> · An AI agent does the same through JSON tool calls: open, pay out, cancel");
await click("#al-run");
await page.waitForFunction(() => window.__agentLive && window.__agentLive.done, null, { timeout: 120_000, polling: 300 });
await sleep(800);
await caption("<b>7</b> · Under each call: the exact JSON the agent gets back, with the transaction");
for (const n of [1, 3, 4]) {
  await scrollTo(`#al-log > li:nth-child(${n})`, 60);
  if (n === 3) posterAt = (Date.now() - videoStart) / 1000; // the payout and its JSON: the poster
  await sleep(2400);
}
await scrollTo("#al-summary", 300);
await caption("<b>8</b> · On-chain: the recipient got what was earned, the rest came back; paid + refunded = the deposit");
await sleep(5000);

// Scene 3: the end card.
await page.setContent(`<!doctype html><html><head><style>
  body { margin: 0; height: 100vh; display: grid; place-items: center; background: radial-gradient(1200px 600px at 70% 20%, #2a1b4a, #0b0f17 60%);
    color: #e6edf3; font-family: system-ui, -apple-system, Segoe UI, sans-serif; text-align: center; }
  code { font: 600 30px ui-monospace, Menlo, Consolas, monospace; color: #fff; background: #0a0e14; border: 1px solid #a855f7; padding: 12px 22px; border-radius: 12px; }
  ul { list-style: none; padding: 0; margin: 34px 0 0; font-size: 18px; line-height: 1.8; color: #9fb0c3; } b { color: #e6edf3; }
  .note { margin: 26px auto 0; font-size: 13px; color: #8b98a9; max-width: 800px; }
</style></head><body><div>
  <code>npx create-stylus-latest</code>
  <ul><li><b>Live site</b> · npx-create-stylus-latest-web-mocha.vercel.app</li><li><b>npm</b> · create-stylus-latest</li>
    <li><b>GitHub</b> · ramadan904/npx-create-stylus-latest</li></ul>
  <p class="note">Recorded from a real run by e2e/video/record.mjs: real npx and cargo output, and real transactions to contracts this tool
    deployed on a local Arbitrum Nitro dev node. On the live site the same page runs on Arbitrum Sepolia with your wallet.</p>
</div></body></html>`);
await sleep(5500);

const video = page.video();
await context.close();
await browser.close();
server.close();
ticking = false;
await tickLoop;

// ---- 5. encode ------------------------------------------------------------------------------------------------------------
const raw = await video.path();
const mp4 = join(web, "demo.mp4");
const poster = join(web, "demo-poster.jpg");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-ss", "0.4", "-vf", "scale=1280:720:flags=lanczos", "-c:v", "libx264", "-preset", "slow", "-crf", "27", "-pix_fmt", "yuv420p", "-r", "25", "-movflags", "+faststart", "-an", mp4]);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(Math.max(0, posterAt + 0.6)), "-i", mp4, "-frames:v", "1", "-q:v", "4", poster]);
const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4], { encoding: "utf8" }));
say(`wrote web/demo.mp4 (${seconds.toFixed(1)} s, ${(statSync(mp4).size / 1e6).toFixed(2)} MB) and web/demo-poster.jpg`);
process.exit(0);
