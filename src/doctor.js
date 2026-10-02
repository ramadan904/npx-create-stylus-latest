import { spawnSync } from "node:child_process";
import { probeRpc } from "./probe.js";
import { resolveVersions } from "./versions.js";

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return r.error || r.status !== 0 ? null : (r.stdout ?? "").trim();
}

// Reports missing prerequisites as hints; never installs anything on the user's behalf.
export function checkToolchain(run_ = run) {
  const hints = [];
  if (!run_("cargo", ["--version"])) {
    hints.push("Install Rust: https://rustup.rs");
    return hints;
  }
  const targets = run_("rustup", ["target", "list", "--installed"]);
  if (targets !== null && !targets.split("\n").includes("wasm32-unknown-unknown")) {
    hints.push("rustup target add wasm32-unknown-unknown");
  }
  if (!run_("cargo", ["stylus", "--version"])) {
    hints.push("cargo install --locked cargo-stylus");
  }
  return hints;
}

export function gitInit(dir) {
  return run("git", ["-C", dir, "init", "-q"]) !== null;
}

const OK = "\u2714";
const BAD = "\u2716";
const WARN = "!";

function majorMinor(v) {
  const m = /(\d+)\.(\d+)/.exec(v ?? "");
  return m ? `${m[1]}.${m[2]}` : null;
}

// Prints a checklist and returns the process exit code: 1 if a required tool is missing or the RPC cannot run Stylus.
// Everything is injectable so it can be tested without Rust, Docker or a network.
export async function runDoctor({
  rpc,
  network,
  run_ = run,
  nodeVersion = process.versions.node,
  fetchImpl = fetch,
  offline = false,
  log = console.log,
} = {}) {
  let failed = false;
  const line = (mark, text, hint) => {
    log(`  ${mark} ${text}`);
    if (hint) log(`      ${hint}`);
    if (mark === BAD) failed = true;
  };

  log("Toolchain");
  const [major, minor] = nodeVersion.split(".").map(Number);
  if (major > 18 || (major === 18 && minor >= 17)) line(OK, `Node ${nodeVersion}`);
  else line(BAD, `Node ${nodeVersion}`, "Node 18.17 or newer is required: https://nodejs.org");

  const cargo = run_("cargo", ["--version"]);
  if (cargo) line(OK, cargo);
  else line(BAD, "cargo not found", "Install Rust: https://rustup.rs");

  if (cargo) {
    const targets = run_("rustup", ["target", "list", "--installed"]);
    if (targets === null || targets.split("\n").includes("wasm32-unknown-unknown")) {
      line(OK, "wasm32-unknown-unknown target");
    } else {
      line(BAD, "wasm32-unknown-unknown target missing", "rustup target add wasm32-unknown-unknown");
    }
    const stylus = run_("cargo", ["stylus", "--version"]);
    if (!stylus) {
      line(BAD, "cargo-stylus not found", "cargo install --locked cargo-stylus");
    } else {
      const versions = await resolveVersions({ offline, fetchImpl });
      const have = majorMinor(stylus);
      const want = majorMinor(versions.stylusSdk);
      if (have && want && have !== want) {
        line(WARN, `${stylus} (newest stylus-sdk is ${versions.stylusSdk})`, "cargo install --locked --force cargo-stylus");
      } else {
        line(OK, stylus);
      }
    }
  }
  if (run_("docker", ["--version"])) line(OK, "docker (only needed for the local dev node)");
  else line(WARN, "docker not found", "Optional: scripts/devnode.sh needs it; deploying to a public network does not");

  if (rpc) {
    log("\nRPC");
    const p = await probeRpc(rpc, { fetchImpl });
    if (!p.reachable) {
      line(BAD, `${p.host} is not reachable`, p.notes.join("; "));
    } else {
      line(OK, `${p.host} answers (chain id ${p.chainId})`);
      if (network && p.chainId !== network.chainId) {
        line(BAD, `expected chain id ${network.chainId} for ${network.label}`, "This RPC is a different chain: check RPC_URL or --network");
      }
      if (!p.arbitrum) line(BAD, "not an Arbitrum chain", "ArbSys (0x64) did not answer; Stylus needs an Arbitrum Nitro chain");
      else if (!p.stylus) line(BAD, "Stylus is not enabled", "ArbWasm.stylusVersion() returned 0 or reverted");
      else line(OK, `Stylus enabled (ArbWasm version ${p.stylusVersion})`);
      if (p.stylus && /(^|\.)arbitrum\.io$/.test(p.host.split(":")[0])) {
        line(
          WARN,
          "public Arbitrum endpoint",
          "Observed once: the public Sepolia RPC refused cargo-stylus's activation check during deploy. If that happens, use a provider endpoint (Alchemy, QuickNode) or the local dev node. doctor cannot detect this ahead of time.",
        );
      }
    }
  }

  log(failed ? "\nSome required checks failed." : "\nAll required checks passed.");
  return failed ? 1 : 0;
}
