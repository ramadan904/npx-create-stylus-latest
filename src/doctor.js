import { spawnSync } from "node:child_process";

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
