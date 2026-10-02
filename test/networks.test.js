import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { NETWORKS, TOKEN_TEMPLATES, envBlock, resolveNetwork } from "../src/networks.js";
import { scaffold } from "../src/scaffold.js";

const versions = { stylusSdk: "9.8.7", alloy: "6.5.4" };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "csl-net-")), "proj");
const env = (dir) => fs.readFileSync(path.join(dir, ".env.example"), "utf8");
const line = (text, key) => text.split("\n").find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1);

test("every network has a positive chain id, an rpc and a usable USDG entry", () => {
  const ids = new Set();
  for (const [name, n] of Object.entries(NETWORKS)) {
    assert.ok(Number.isInteger(n.chainId) && n.chainId > 0, name);
    assert.ok(!ids.has(n.chainId), `duplicate chain id ${n.chainId}`);
    ids.add(n.chainId);
    assert.match(n.rpc, /^https?:\/\//, name);
    if (n.usdg !== null) {
      assert.match(n.usdg, /^0x[0-9a-fA-F]{40}$/, name);
      assert.ok(n.mainnet, `${name}: Paxos lists USDG only on mainnets here; a testnet address would be a guess`);
    }
  }
  assert.throws(() => resolveNetwork("nope"), /Unknown network "nope"/);
});

test("the default .env.example targets Arbitrum Sepolia and has no token line", () => {
  const dir = tmp();
  scaffold({ targetDir: dir, name: "my-app", template: "counter", versions });
  const text = env(dir);
  assert.equal(line(text, "RPC_URL"), NETWORKS["arbitrum-sepolia"].rpc);
  assert.equal(line(text, "CHAIN_ID"), "421614");
  assert.equal(line(text, "TOKEN_ADDRESS"), undefined);
  assert.equal(line(text, "PRIVATE_KEY"), "");
  assert.doesNotMatch(text, /MAINNET/);
});

for (const name of Object.keys(NETWORKS)) {
  test(`--network ${name} writes its rpc and chain id`, () => {
    const dir = tmp();
    scaffold({ targetDir: dir, name: "my-app", template: "stream", versions, network: name, usdg: true });
    const text = env(dir);
    const n = NETWORKS[name];
    assert.equal(line(text, "RPC_URL"), n.rpc);
    assert.equal(line(text, "CHAIN_ID"), String(n.chainId));
    // --usdg: the official address where Paxos lists one, otherwise an empty value and an explanation, never a guess.
    assert.equal(line(text, "TOKEN_ADDRESS"), n.usdg ?? "");
    if (!n.usdg) assert.match(text, /Paxos publishes no USDG/);
    assert.equal(/MAINNET=1/.test(text), n.mainnet, "mainnets carry the warning, testnets do not");
  });
}

test("--usdg on a mainnet uses Paxos's addresses", () => {
  assert.match(envBlock(resolveNetwork("arbitrum-one"), { usdg: true }), /TOKEN_ADDRESS=0x004B506865409877C9fA29bfb1ebA929984B9bbC/);
  assert.match(envBlock(resolveNetwork("robinhood"), { usdg: true }), /TOKEN_ADDRESS=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168/);
});

test("--usdg is refused for templates that do not move a token, before anything is written", () => {
  for (const template of ["counter", "erc20", "faucet"]) {
    assert.ok(!TOKEN_TEMPLATES.includes(template));
    const dir = tmp();
    assert.throws(() => scaffold({ targetDir: dir, name: "my-app", template, versions, usdg: true }), /--usdg applies to/);
    assert.ok(!fs.existsSync(dir), `${template}: nothing should be written`);
  }
});

function cli(args) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "csl-cli-"));
  const r = spawnSync(process.execPath, [path.resolve("bin/create-stylus-latest.js"), ...args, "-y", "--no-git", "--offline"], { cwd, encoding: "utf8" });
  return { ...r, cwd };
}

test("the CLI: --robinhood selects Robinhood Chain testnet and conflicts with another --network", () => {
  const ok = cli(["app", "-t", "escrow", "--robinhood", "--usdg"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Robinhood Chain testnet, chain id 46630/);
  assert.match(ok.stdout, /Paxos publishes no USDG on Robinhood Chain testnet/);
  assert.equal(line(env(path.join(ok.cwd, "app")), "CHAIN_ID"), "46630");

  const clash = cli(["app", "--robinhood", "--network", "arbitrum-one"]);
  assert.notEqual(clash.status, 0);
  assert.match(clash.stderr, /conflicts with --network arbitrum-one/);
});

test("the CLI: a mainnet USDG project prints the token and the MAINNET=1 requirement", () => {
  const r = cli(["app", "-t", "vault", "--network", "robinhood", "--usdg"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Paxos USDG 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 \(6 decimals\)/);
  assert.match(r.stdout, /MAINNET=1/);
});

// ---- deploy.sh, run for real against a fake cargo and a fake RPC ----------------------------------------------------

function fakeRpc(chainId) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id } = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: `0x${chainId.toString(16)}` }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

/** A scaffolded project whose PATH has a `cargo` that records its arguments instead of building anything. */
function project(dotenv) {
  const dir = tmp();
  scaffold({ targetDir: dir, name: "my-app", template: "escrow", versions });
  const bin = path.join(dir, "fakebin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "cargo"), `#!/usr/bin/env bash\necho "$*" >> "${path.join(dir, "cargo.log")}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "cargo-stylus"), "#!/usr/bin/env bash\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, ".env"), dotenv);
  return { dir, bin };
}

// Async on purpose: the fake RPC lives in this process, so a blocking spawn would stop it from answering.
function deploy({ dir, bin }, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["scripts/deploy.sh", ...args], {
      cwd: dir,
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => {
      const log = fs.existsSync(path.join(dir, "cargo.log")) ? fs.readFileSync(path.join(dir, "cargo.log"), "utf8") : "";
      resolve({ status, stdout, stderr, deployed: /stylus deploy/.test(log), log });
    });
  });
}

const KEY = "PRIVATE_KEY=0x" + "11".repeat(32);
const TOKEN = "0x00000000000000000000000000000000000000aa";

test("deploy.sh: env:TOKEN_ADDRESS is replaced from .env, and an empty one stops before anything runs", async () => {
  const { server, url } = await fakeRpc(421614);
  try {
    const p = project(`RPC_URL=${url}\nCHAIN_ID=421614\n${KEY}\nTOKEN_ADDRESS=${TOKEN}\n`);
    const r = await deploy(p, ["--", "env:TOKEN_ADDRESS"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.deployed);
    assert.match(r.log, new RegExp(`--constructor-args ${TOKEN}`));

    const empty = project(`RPC_URL=${url}\nCHAIN_ID=421614\n${KEY}\nTOKEN_ADDRESS=\n`);
    const e = await deploy(empty, ["--", "env:TOKEN_ADDRESS"]);
    assert.equal(e.status, 2);
    assert.match(e.stderr, /TOKEN_ADDRESS is not set/);
    assert.equal(e.log, "", "cargo was never called");

    const bad = await deploy(p, ["--", "env:1bad"]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /expected env:NAME/);
  } finally {
    server.close();
  }
});

test("deploy.sh: a mainnet RPC needs MAINNET=1 to deploy, but --check-only is free", async () => {
  const { server, url } = await fakeRpc(42161);
  try {
    // CHAIN_ID claims a testnet: the RPC's own answer is what counts.
    const p = project(`RPC_URL=${url}\nCHAIN_ID=421614\n${KEY}\n`);
    const refused = await deploy(p, ["--", TOKEN]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Chain 42161 is a mainnet/);
    assert.match(refused.stderr, /CHAIN_ID in \.env says 421614/);
    assert.ok(!refused.deployed);

    const check = await deploy(p, ["--check-only"]);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.log, /stylus check/);

    const go = await deploy(p, ["--", TOKEN], { MAINNET: "1" });
    assert.equal(go.status, 0, go.stderr);
    assert.ok(go.deployed);
  } finally {
    server.close();
  }
});

test("deploy.sh: with the RPC unreachable, CHAIN_ID from .env still triggers the mainnet guard", async () => {
  const p = project(`RPC_URL=http://127.0.0.1:9\nCHAIN_ID=4663\n${KEY}\n`);
  const r = await deploy(p, ["--", TOKEN]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Chain 4663 is a mainnet/);
});
