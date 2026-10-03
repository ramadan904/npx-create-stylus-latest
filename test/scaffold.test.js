import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { toCrateName, validateName } from "../src/names.js";
import { render, scaffold } from "../src/scaffold.js";
import { TEMPLATES } from "../src/templates.js";

const versions = { stylusSdk: "9.8.7", alloy: "6.5.4" };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "csl-")), "proj");

test("validateName accepts cargo-safe names and rejects the rest", () => {
  assert.equal(validateName("my-app_2"), null);
  for (const bad of ["", "My-App", "2fast", "has space", "std", "a".repeat(65)]) {
    assert.ok(validateName(bad), `expected "${bad}" to be rejected`);
  }
  assert.equal(toCrateName("my-app"), "my_app");
});

test("render substitutes known keys and rejects unknown ones", () => {
  assert.equal(render("{{a}}-{{a}}", { a: "x" }), "x-x");
  assert.throws(() => render("{{nope}}", {}), /Unknown template placeholder/);
});

for (const template of Object.keys(TEMPLATES)) {
  test(`scaffold(${template}) writes a complete, fully-rendered project`, () => {
    const dir = tmp();
    const files = scaffold({ targetDir: dir, name: "my-app", template, versions });

    for (const f of ["Cargo.toml", "Stylus.toml", "rust-toolchain.toml", "src/lib.rs", "src/main.rs", "README.md", ".gitignore", ".env.example", "scripts/deploy.sh"]) {
      assert.ok(files.includes(f), `missing ${f}`);
    }
    const cargo = fs.readFileSync(path.join(dir, "Cargo.toml"), "utf8");
    assert.match(cargo, /name = "my-app"/);
    assert.match(cargo, /stylus-sdk = "9\.8\.7"/);
    assert.match(cargo, /alloy-primitives = "6\.5\.4"/);
    assert.match(fs.readFileSync(path.join(dir, "src/main.rs"), "utf8"), /my_app::print_from_args/);

    for (const f of files) {
      assert.ok(!/\{\{\w+\}\}/.test(fs.readFileSync(path.join(dir, f), "utf8")), `unrendered placeholder in ${f}`);
    }
    assert.ok(fs.statSync(path.join(dir, "scripts/deploy.sh")).mode & 0o111, "deploy.sh must be executable");
  });
}

test("scaffold refuses a non-empty directory and unknown templates", () => {
  const dir = tmp();
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "keep.txt"), "x");
  assert.throws(() => scaffold({ targetDir: dir, name: "a", template: "counter", versions }), /not empty/);
  assert.throws(() => scaffold({ targetDir: tmp(), name: "a", template: "nope", versions }), /Unknown template/);
  assert.equal(fs.readFileSync(path.join(dir, "keep.txt"), "utf8"), "x");
});

test("every registered template ships a contract and a README", () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "templates");
  for (const name of Object.keys(TEMPLATES)) {
    for (const f of ["Cargo.toml", "src/lib.rs", "README.md"]) {
      assert.ok(fs.existsSync(path.join(root, name, f)), `templates/${name}/${f} is missing`);
    }
  }
});

test("shipped shell scripts parse and deploy.sh needs no .env to validate", async () => {
  const { spawnSync } = await import("node:child_process");
  const dir = tmp();
  scaffold({ targetDir: dir, name: "my-app", template: "counter", versions });
  for (const script of ["deploy.sh", "export-abi.sh", "devnode.sh", "verify.sh"]) {
    const r = spawnSync("bash", ["-n", path.join(dir, "scripts", script)], { encoding: "utf8" });
    assert.equal(r.status, 0, `${script}: ${r.stderr}`);
  }
  const deploy = fs.readFileSync(path.join(dir, "scripts/deploy.sh"), "utf8");
  assert.match(deploy, /RPC_URL="\$\{RPC_URL:-https:\/\/sepolia-rollup\.arbitrum\.io\/rpc\}"/);
  assert.doesNotMatch(deploy, /RPC_URL:\?/);
  // By default deploy must not require Docker; VERIFY=1 is the opt-in to the reproducible (Docker) build.
  assert.match(deploy, /^verify_args=\(--no-verify\)$/m, "the default deploy must not require Docker");
  assert.match(deploy, /cargo stylus deploy \$\{verify_args\[@\]\+"\$\{verify_args\[@\]\}"\}/, "deploy must use verify_args");
  assert.match(deploy, /MAX_FEE_GWEI/, "deploy.sh must let callers cap the gas price");
  assert.match(deploy, /cargo generate-lockfile/, "deploy.sh must create Cargo.lock for cargo-stylus --locked builds");
});

test("CLI accepts a path and names the project after its last segment", async () => {
  const { spawnSync } = await import("node:child_process");
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "bin", "create-stylus-latest.js");
  const dir = path.join(path.dirname(tmp()), "nested", "path-app");
  const r = spawnSync("node", [cli, dir, "-y", "--no-git", "--offline"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(dir, "Cargo.toml"), "utf8"), /name = "path-app"/);

  // "." scaffolds into an existing empty directory, named after it.
  const empty = path.join(path.dirname(tmp()), "dot-app");
  fs.mkdirSync(empty);
  const dot = spawnSync("node", [cli, ".", "-y", "--no-git", "--offline"], { cwd: empty, encoding: "utf8" });
  assert.equal(dot.status, 0, dot.stderr);
  assert.match(fs.readFileSync(path.join(empty, "Cargo.toml"), "utf8"), /name = "dot-app"/);
});

for (const template of Object.keys(TEMPLATES)) {
  test(`scaffold(${template}, withClient) adds a rendered client and omits it by default`, () => {
    const without = tmp();
    assert.ok(!scaffold({ targetDir: without, name: "my-app", template, versions }).some((f) => f.startsWith("client/")));

    const dir = tmp();
    const files = scaffold({ targetDir: dir, name: "my-app", template, versions, withClient: true });
    for (const f of ["client/package.json", "client/tsconfig.json", "client/.gitignore", "client/src/client.ts", "client/src/main.ts"]) {
      assert.ok(files.includes(f), `missing ${f}`);
    }
    assert.match(fs.readFileSync(path.join(dir, "client/package.json"), "utf8"), /"name": "my-app-client"/);

    // Any client that sends a transaction must go through confirm() so a revert fails loudly.
    const clientMain = fs.readFileSync(path.join(dir, "client/src/main.ts"), "utf8");
    if (clientMain.includes("writeContract")) {
      assert.match(clientMain, /await confirm\(/, "client sends transactions but never calls confirm()");
      assert.ok(!clientMain.includes("waitForTransactionReceipt"), "use confirm() instead of waiting for the receipt directly");
    }
    if (clientMain.includes("import { confirm")) {
      assert.match(clientMain, /await confirm\(/, "confirm is imported but never used");
    }

    // Every function the client calls must exist in the contract (snake_case there, camelCase in the ABI).
    const lib = fs.readFileSync(path.join(dir, "src/lib.rs"), "utf8");
    const contractFns = new Set([...lib.matchAll(/pub fn (\w+)/g)].map((m) => m[1].replace(/_(\w)/g, (_, c) => c.toUpperCase())));
    // Functions renamed with #[selector(name = "...")] (tokenURI, the safeTransferFrom overloads) keep their ABI name.
    for (const m of lib.matchAll(/#\[selector\(name = "(\w+)"\)\]/g)) contractFns.add(m[1]);
    const main = fs.readFileSync(path.join(dir, "client/src/main.ts"), "utf8");
    // Only the contract's own ABI (`const abi = parseAbi([...])`); a client may also call the token through another ABI.
    const contractAbi = main.match(/const abi = parseAbi\(\[([\s\S]*?)\]\);/)?.[1] ?? "";
    const abiFns = [...contractAbi.matchAll(/"function (\w+)\(/g)].map((m) => m[1]);
    assert.ok(abiFns.length > 0);
    for (const fn of abiFns) assert.ok(contractFns.has(fn), `client ABI lists ${fn}() which the contract does not define`);
  });
}

test("erc20, erc721, vault, escrow, stream, oracle and faucet initialize through a constructor, not a callable init()", () => {
  for (const template of ["erc20", "erc721", "vault", "escrow", "stream", "oracle", "faucet"]) {
    const dir = tmp();
    scaffold({ targetDir: dir, name: "my-app", template, versions });
    const lib = fs.readFileSync(path.join(dir, "src/lib.rs"), "utf8");
    assert.match(lib, /#\[constructor\]/, `${template} must use #[constructor]`);
    assert.doesNotMatch(lib, /pub fn init\(/, `${template} must not expose a front-runnable init()`);
  }
});

test("deploy.sh forwards constructor arguments after --", () => {
  const dir = tmp();
  scaffold({ targetDir: dir, name: "my-app", template: "erc20", versions });
  const deploy = fs.readFileSync(path.join(dir, "scripts/deploy.sh"), "utf8");
  assert.match(deploy, /--constructor-args/);
  assert.match(deploy, /--\) shift; ctor=\("\$@"\); break/);
});

test("deploy.sh turns known cargo-stylus failures into plain-English hints and keeps the exit code", async () => {
  const { spawnSync } = await import("node:child_process");
  const dir = tmp();
  scaffold({ targetDir: dir, name: "my-app", template: "counter", versions });
  fs.writeFileSync(path.join(dir, "Cargo.lock"), "");

  const bin = path.join(dir, "fakebin");
  fs.mkdirSync(bin);
  const fake = (message, code) => {
    const body = `#!/usr/bin/env bash\nif [ "$1" = stylus ]; then echo '${message}'; exit ${code}; fi\n`;
    for (const name of ["cargo", "cargo-stylus"]) {
      fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
    }
  };
  const run = () =>
    spawnSync("bash", [path.join(dir, "scripts/deploy.sh")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PRIVATE_KEY: "0xabc", RPC_URL: "http://example.invalid" },
    });

  const cases = [
    ["error code -32000: stylus activations not allowed for this request", /Hint: this RPC refuses Stylus activation/],
    ["rpc error: max fee per gas less than block base fee", /Hint: the gas cap lost a race/],
    ["rpc error: insufficient funds for gas * price + value", /Hint: the deploy wallet has too little ETH/],
  ];
  for (const [message, expected] of cases) {
    fake(message, 1);
    const r = run();
    assert.equal(r.status, 1, "exit code must be preserved");
    assert.match(r.stderr, expected);
  }

  fake("some error nobody has seen before", 1);
  const unknown = run();
  assert.equal(unknown.status, 1);
  assert.doesNotMatch(unknown.stderr, /Hint:/);

  fake("all good", 0);
  assert.equal(run().status, 0);
});

test("erc20, erc721, vault, escrow, stream, oracle, interop and faucet ship property-based tests", () => {
  for (const template of ["erc20", "erc721", "vault", "escrow", "stream", "oracle", "interop", "faucet"]) {
    const dir = tmp();
    scaffold({ targetDir: dir, name: "my-app", template, versions });
    assert.match(fs.readFileSync(path.join(dir, "Cargo.toml"), "utf8"), /proptest = /, `${template} needs proptest`);
    const lib = fs.readFileSync(path.join(dir, "src/lib.rs"), "utf8");
    assert.match(lib, /mod properties/, `${template} needs a properties test module`);
    assert.match(lib, /proptest!/, `${template} needs a proptest! block`);
  }
});

test("interop ships the Solidity side, and its IMathLib names every public function and error of lib.rs", () => {
  const dir = tmp();
  const files = scaffold({ targetDir: dir, name: "my-app", template: "interop", versions });
  for (const f of ["solidity/Consumer.sol", "scripts/interop.sh", "scripts/interop/interop.mjs", "scripts/interop/package.json"]) {
    assert.ok(files.includes(f), f);
  }
  assert.ok(fs.statSync(path.join(dir, "scripts/interop.sh")).mode & 0o100, "interop.sh is executable");
  const sol = fs.readFileSync(path.join(dir, "solidity/Consumer.sol"), "utf8");
  const iface = /interface IMathLib \{([\s\S]*?)\n\}/.exec(sol)?.[1] ?? "";
  const lib = fs.readFileSync(path.join(dir, "src/lib.rs"), "utf8");
  // Rust snake_case `pub fn` in the #[public] impl is camelCase in the ABI.
  const camel = (name) => name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const publicImpl = /#\[public\]\s*impl MathLib \{([\s\S]*?)\n\}/.exec(lib)?.[1] ?? "";
  const fns = [...publicImpl.matchAll(/pub fn (\w+)/g)].map((m) => camel(m[1]));
  assert.deepEqual(fns, ["mulDiv", "mulDivUp", "isqrt"]);
  for (const fn of fns) assert.match(iface, new RegExp(`function ${fn}\\(`), `IMathLib lacks ${fn}`);
  const errors = [...(/sol! \{([\s\S]*?)\n\}/.exec(lib)?.[1] ?? "").matchAll(/error (\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(errors, ["DivisionByZero", "MulDivOverflow"]);
  for (const e of errors) assert.match(iface, new RegExp(`error ${e}\\(`), `IMathLib lacks error ${e}`);
});

test("every project can deploy reproducibly and verify: verify.sh, VERIFY=1 in deploy.sh, the key file git-ignored", () => {
  for (const template of Object.keys(TEMPLATES)) {
    const dir = tmp();
    scaffold({ targetDir: dir, name: "my-app", template, versions });
    assert.ok(fs.statSync(path.join(dir, "scripts/verify.sh")).mode & 0o100, `${template}: verify.sh is executable`);
    const deploy = fs.readFileSync(path.join(dir, "scripts/deploy.sh"), "utf8");
    assert.match(deploy, /VERIFY:-}" = 1/, `${template}: deploy.sh has the VERIFY=1 mode`);
    // The Docker container sees only the project, so the key must be passed by a relative path inside it.
    assert.match(deploy, /keyfile=".stylus-deploy-key"/);
    assert.match(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), /^\.stylus-deploy-key$/m, `${template}: key file ignored`);
  }
});

test("agent templates ship an MCP server beside the agent CLI, serving the same tools and handlers", async () => {
  const { AGENT_TEMPLATES } = await import("../src/templates.js");
  for (const template of Object.keys(TEMPLATES)) {
    const dir = tmp();
    scaffold({ targetDir: dir, name: "my-app", template, versions, withClient: true });
    const mcp = path.join(dir, "client/src/agent-mcp.ts");
    if (!AGENT_TEMPLATES.includes(template)) {
      assert.ok(!fs.existsSync(mcp), `${template} has no agent, so no MCP server`);
      continue;
    }
    const src = fs.readFileSync(mcp, "utf8");
    assert.match(src, /import \{ handlers, tools \} from "\.\/agent\.js"/, `${template}: same tools and handlers as the CLI`);
    assert.match(src, /mcpMain\(\{ name: "my-app"/, `${template}: the server is named after the project`);
    const kit = fs.readFileSync(path.join(dir, "client/src/agent-kit.ts"), "utf8");
    assert.match(kit, /await runIntent\(handlers, \{ \.\.\.args, intent: params\.name \}\)/, "tools/call goes through runIntent, like the CLI");
  }
});

test("devnode.sh ships the setup that constructor deploys need, and it is wired in", async () => {
  const { spawnSync } = await import("node:child_process");
  const dir = tmp();
  scaffold({ targetDir: dir, name: "my-app", template: "escrow", versions });
  const devnode = path.join(dir, "scripts", "devnode");
  for (const f of ["setup.mjs", "bytecode.json", "package.json"]) {
    assert.ok(fs.existsSync(path.join(devnode, f)), `scripts/devnode/${f} is missing`);
  }
  const sh = fs.readFileSync(path.join(dir, "scripts/devnode.sh"), "utf8");
  assert.match(sh, /devnode\/setup\.mjs/, "devnode.sh must run the setup");
  assert.match(sh, /npm install/, "devnode.sh must install the setup's dependency");
  assert.doesNotMatch(sh, /^\s*exit 0\s*$/m, "devnode.sh must not exit before the setup runs");
  const check = spawnSync(process.execPath, ["--check", path.join(devnode, "setup.mjs")], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);

  const bytecode = JSON.parse(fs.readFileSync(path.join(devnode, "bytecode.json"), "utf8"));
  for (const key of ["stylusDeployer", "create2FactoryRawTx"]) {
    assert.match(bytecode[key], /^[0-9a-f]+$/, `${key} must be lowercase hex without a 0x prefix`);
    assert.equal(bytecode[key].length % 2, 0, `${key} must be whole bytes`);
  }
  assert.equal(bytecode.create2FactoryRawTx.length / 2, 167, "the presigned CREATE2 factory transaction is 167 bytes");
  assert.ok(bytecode.stylusDeployer.startsWith("6080604052"), "stylusDeployer must be init code");
  const setup = fs.readFileSync(path.join(devnode, "setup.mjs"), "utf8");
  const code = setup.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n"); // comments may show checksummed addresses
  for (const address of code.match(/0x[0-9a-fA-F]{40}\b/g) ?? []) {
    assert.equal(address, address.toLowerCase(), `${address}: addresses must be lowercase (viem rejects a bad checksum)`);
  }
});

test("stream, escrow and vault ship an agent interface with the client, and other templates do not", () => {
  for (const [template, minimum] of [["stream", 5], ["escrow", 5], ["vault", 3]]) {
    const dir = tmp();
    scaffold({ targetDir: dir, name: "my-app", template, versions, withClient: true });
    for (const f of ["agent.ts", "agent-cli.ts", "agent-example.ts", "agent-kit.ts"]) {
      assert.ok(fs.existsSync(path.join(dir, "client/src", f)), `${template}: client/src/${f} is missing`);
    }
    const agent = fs.readFileSync(path.join(dir, "client/src/agent.ts"), "utf8");
    // every intent an agent can call is described to the model, and every described tool has a handler
    const tools = [...agent.matchAll(/^\s*name: "(\w+)",$/gm)].map((m) => m[1]);
    const handlers = [...agent.matchAll(/^  async (\w+)\(input\)/gm)].map((m) => m[1]);
    assert.ok(tools.length >= minimum, `${template}: expected at least ${minimum} tools, found ${tools.length}`);
    assert.deepEqual([...tools].sort(), [...handlers].sort(), `${template}: tool schemas and handlers must match`);
  }
  const counter = tmp();
  scaffold({ targetDir: counter, name: "my-app", template: "counter", versions, withClient: true });
  for (const f of ["agent.ts", "agent-kit.ts", "agent-cli.ts"]) {
    assert.ok(!fs.existsSync(path.join(counter, "client/src", f)), `counter must not ship client/src/${f}`);
  }
});
