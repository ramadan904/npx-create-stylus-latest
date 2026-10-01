import assert from "node:assert/strict";
import { test } from "node:test";
import { runDoctor } from "../src/doctor.js";
import { hostOf, probeRpc } from "../src/probe.js";

const KEY_URL = "https://eth-sepolia.example.com/v2/SECRETKEY123";
const word = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");

// Fake JSON-RPC server keyed by eth_call target address.
function fakeRpc({ chainId = 421614, arbSys = true, stylusVersion = 2, overrides = true, down = false } = {}) {
  return async (_url, init) => {
    if (down) throw new Error("connect ECONNREFUSED");
    const { method, params } = JSON.parse(init.body);
    const reply = (result) => ({ ok: true, json: async () => ({ result }) });
    const fail = (message) => ({ ok: true, json: async () => ({ error: { message } }) });
    if (method === "eth_chainId") return reply("0x" + chainId.toString(16));
    const [{ to }, , override] = params;
    if (override && !overrides) return fail("state overrides not supported");
    if (to === "0x0000000000000000000000000000000000000064") return arbSys ? reply(word(30)) : fail("execution reverted");
    if (to === "0x0000000000000000000000000000000000000071") return stylusVersion === null ? fail("execution reverted") : reply(word(stylusVersion));
    return reply("0x");
  };
}

const tools = (missing = []) => (cmd, args) => {
  const key = [cmd, ...args].join(" ");
  if (missing.some((m) => key.startsWith(m))) return null;
  if (key.startsWith("rustup")) return "wasm32-unknown-unknown\nx86_64-unknown-linux-gnu";
  if (key.startsWith("cargo stylus")) return "cargo-stylus 0.10.9";
  if (key.startsWith("cargo")) return "cargo 1.91.0";
  return "ok";
};

const collect = () => {
  const lines = [];
  return { lines, log: (s = "") => lines.push(s) };
};

test("hostOf never exposes the path or key", () => {
  assert.equal(hostOf(KEY_URL), "eth-sepolia.example.com");
  assert.equal(hostOf("not a url"), "(invalid URL)");
});

test("probe: a Stylus-enabled Arbitrum chain", async () => {
  const p = await probeRpc(KEY_URL, { fetchImpl: fakeRpc() });
  assert.deepEqual([p.reachable, p.chainId, p.arbitrum, p.stylus, p.stylusVersion], [true, 421614, true, true, 2]);
});

test("probe: stylusVersion 0 or a revert means no Stylus", async () => {
  assert.equal((await probeRpc(KEY_URL, { fetchImpl: fakeRpc({ stylusVersion: 0 }) })).stylus, false);
  assert.equal((await probeRpc(KEY_URL, { fetchImpl: fakeRpc({ stylusVersion: null, arbSys: false }) })).stylus, false);
});

test("probe: unreachable endpoint does not leak the URL", async () => {
  const p = await probeRpc(KEY_URL, { fetchImpl: async (url) => { throw new Error(`failed to fetch ${url}`); } });
  assert.equal(p.reachable, false);
  assert.ok(!JSON.stringify(p).includes("SECRETKEY123"));
});

test("doctor passes with a healthy toolchain and Stylus RPC, and prints no key", async () => {
  const { lines, log } = collect();
  const code = await runDoctor({ rpc: KEY_URL, run_: tools(), nodeVersion: "20.11.0", fetchImpl: fakeRpc(), offline: true, log });
  assert.equal(code, 0);
  const out = lines.join("\n");
  assert.match(out, /Stylus enabled/);
  assert.ok(!out.includes("SECRETKEY123"));
});

test("doctor fails and hints when cargo-stylus is missing", async () => {
  const { lines, log } = collect();
  const code = await runDoctor({ run_: tools(["cargo stylus"]), nodeVersion: "20.0.0", offline: true, log });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /cargo install --locked cargo-stylus/);
});

test("doctor fails on old Node", async () => {
  const { log } = collect();
  assert.equal(await runDoctor({ run_: tools(), nodeVersion: "16.20.0", offline: true, log }), 1);
});

test("doctor fails when the RPC has no Stylus or is down", async () => {
  for (const fetchImpl of [fakeRpc({ stylusVersion: 0 }), fakeRpc({ arbSys: false, stylusVersion: null }), fakeRpc({ down: true })]) {
    const { log } = collect();
    assert.equal(await runDoctor({ rpc: KEY_URL, run_: tools(), nodeVersion: "20.0.0", fetchImpl, offline: true, log }), 1);
  }
});

test("doctor warns, not fails, when state overrides are rejected", async () => {
  const { lines, log } = collect();
  const code = await runDoctor({ rpc: KEY_URL, run_: tools(), nodeVersion: "20.0.0", fetchImpl: fakeRpc({ overrides: false }), offline: true, log });
  assert.equal(code, 0);
  assert.match(lines.join("\n"), /state overrides/);
});
