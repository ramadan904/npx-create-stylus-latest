import assert from "node:assert/strict";
import { test } from "node:test";
import { FALLBACK, compareVersions, indexPath, minVersionOf, pickLatest, resolveVersions } from "../src/versions.js";

const line = (vers, extra = {}) =>
  JSON.stringify({
    vers,
    yanked: false,
    deps: [{ name: "alloy-primitives", kind: "normal", req: "^1.5.7" }],
    ...extra,
  });

test("indexPath follows the crates.io sparse layout", () => {
  assert.equal(indexPath("stylus-sdk"), "st/yl/stylus-sdk");
  assert.equal(indexPath("abc"), "3/a/abc");
  assert.equal(indexPath("ab"), "2/ab");
});

test("compareVersions is numeric, not lexical", () => {
  assert.ok(compareVersions("0.10.9", "0.9.0") > 0);
  assert.ok(compareVersions("1.2.3", "1.2.3") === 0);
});

test("pickLatest skips yanked and prerelease versions", () => {
  const text = [line("0.9.0"), line("0.10.9"), line("0.11.0", { yanked: true }), line("0.12.0-rc.1")].join("\n");
  assert.equal(pickLatest(text).vers, "0.10.9");
});

test("minVersionOf extracts the base version", () => {
  assert.equal(minVersionOf("^1.5.7"), "1.5.7");
  assert.equal(minVersionOf(">=1.5.7, <2"), "1.5.7");
});

test("resolveVersions reads the latest sdk and alloy requirement", async () => {
  const fetchImpl = async () => ({ ok: true, text: async () => [line("0.9.0"), line("0.10.9")].join("\n") });
  const v = await resolveVersions({ fetchImpl });
  assert.deepEqual(v, { stylusSdk: "0.10.9", alloy: "1.5.7", source: "crates.io" });
});

test("resolveVersions falls back when the network fails", async () => {
  const fetchImpl = async () => {
    throw new Error("offline");
  };
  const v = await resolveVersions({ fetchImpl });
  assert.equal(v.stylusSdk, FALLBACK.stylusSdk);
  assert.equal(v.source, "fallback");
  assert.equal(v.reason, "offline");
});

test("resolveVersions --offline never touches the network", async () => {
  const fetchImpl = async () => assert.fail("should not fetch");
  assert.equal((await resolveVersions({ offline: true, fetchImpl })).source, "offline");
});
