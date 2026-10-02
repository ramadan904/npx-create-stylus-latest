import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { scaffold } from "../src/scaffold.js";
import { DEV_NODE_CHAIN_ID, pageConfig, parseEnv } from "../templates/_ui/ui/serve.mjs";

const versions = { stylusSdk: "9.8.7", alloy: "6.5.4" };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "csl-ui-")), "proj");
const KEY = `0x${"ab".repeat(32)}`;

test("--with-ui adds the page, its server and an executable ui.sh; without it, none of them", () => {
  const dir = tmp();
  const files = scaffold({ targetDir: dir, name: "my-app", template: "counter", versions, withUi: true });
  for (const f of ["ui/index.html", "ui/serve.mjs", "scripts/ui.sh"]) assert.ok(files.includes(f), f);
  assert.ok(fs.statSync(path.join(dir, "scripts/ui.sh")).mode & 0o100, "ui.sh is executable");
  assert.match(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), /ui\/abi\.sol/);
  const plain = tmp();
  assert.ok(!scaffold({ targetDir: plain, name: "my-app", template: "counter", versions }).some((f) => f.startsWith("ui/")));
});

test("the page gets the PRIVATE_KEY only on the local dev node, never on a real chain", () => {
  assert.equal(DEV_NODE_CHAIN_ID, 412346);
  const dev = pageConfig({ RPC_URL: "http://127.0.0.1:8547", CHAIN_ID: "412346", CONTRACT_ADDRESS: "0x1", PRIVATE_KEY: KEY });
  assert.equal(dev.devKey, KEY);
  for (const chainId of ["421614", "42161", "46630", "4663", "", "0"]) {
    const c = pageConfig({ RPC_URL: "https://x", CHAIN_ID: chainId, PRIVATE_KEY: KEY });
    assert.equal(c.devKey, undefined, `chain ${chainId || "(unset)"} must not expose the key`);
    assert.ok(!JSON.stringify(c).includes(KEY.slice(2)));
  }
  assert.equal(pageConfig({ CHAIN_ID: "412346", PRIVATE_KEY: "not-a-key" }).devKey, undefined);
});

test("parseEnv reads KEY=value lines, strips quotes and skips comments", () => {
  assert.deepEqual(parseEnv('# c\nRPC_URL="http://h"\n\nCHAIN_ID=412346\n#X=1\nCONTRACT_ADDRESS=0xab\n'), {
    RPC_URL: "http://h",
    CHAIN_ID: "412346",
    CONTRACT_ADDRESS: "0xab",
  });
});
