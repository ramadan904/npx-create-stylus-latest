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
  for (const script of ["deploy.sh", "export-abi.sh", "devnode.sh"]) {
    const r = spawnSync("bash", ["-n", path.join(dir, "scripts", script)], { encoding: "utf8" });
    assert.equal(r.status, 0, `${script}: ${r.stderr}`);
  }
  const deploy = fs.readFileSync(path.join(dir, "scripts/deploy.sh"), "utf8");
  assert.match(deploy, /RPC_URL="\$\{RPC_URL:-https:\/\/sepolia-rollup\.arbitrum\.io\/rpc\}"/);
  assert.doesNotMatch(deploy, /RPC_URL:\?/);
  assert.match(deploy, /cargo stylus deploy --no-verify/, "deploy must not require Docker or hide the key file from it");
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
    const main = fs.readFileSync(path.join(dir, "client/src/main.ts"), "utf8");
    const abiFns = [...main.matchAll(/"function (\w+)\(/g)].map((m) => m[1]);
    assert.ok(abiFns.length > 0);
    for (const fn of abiFns) assert.ok(contractFns.has(fn), `client ABI lists ${fn}() which the contract does not define`);
  });
}

test("erc20 and vault initialize through a constructor, not a callable init()", () => {
  for (const template of ["erc20", "vault"]) {
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
