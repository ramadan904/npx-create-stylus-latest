import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toCrateName, validateName } from "./names.js";
import { DEFAULT_NETWORK, TOKEN_TEMPLATES, envBlock, resolveNetwork } from "./networks.js";
import { AGENT_TEMPLATES, TEMPLATES } from "./templates.js";

const TEMPLATES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");

// npm never publishes a file named .gitignore, so templates ship it as _gitignore.
const RENAMES = { _gitignore: ".gitignore" };

export function render(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in vars)) throw new Error(`Unknown template placeholder {{${key}}}`);
    return vars[key];
  });
}

function copyDir(src, dest, vars, written) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, RENAMES[entry.name] ?? entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to, vars, written);
    } else {
      fs.writeFileSync(to, render(fs.readFileSync(from, "utf8"), vars));
      fs.chmodSync(to, fs.statSync(from).mode);
      written.push(path.relative(written.root, to));
    }
  }
}

export function scaffold({ targetDir, name, template, versions, withClient = false, network = DEFAULT_NETWORK, usdg = false }) {
  const nameError = validateName(name);
  if (nameError) throw new Error(nameError);
  if (!(template in TEMPLATES)) {
    throw new Error(`Unknown template "${template}". Available: ${Object.keys(TEMPLATES).join(", ")}`);
  }
  const net = resolveNetwork(network);
  if (usdg && !TOKEN_TEMPLATES.includes(template)) {
    throw new Error(`--usdg applies to the templates that move a token (${TOKEN_TEMPLATES.join(", ")}), not "${template}"`);
  }
  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
    throw new Error(`Directory ${targetDir} already exists and is not empty`);
  }

  const vars = {
    name,
    crate_name: toCrateName(name),
    stylus_sdk_version: versions.stylusSdk,
    alloy_version: versions.alloy,
    network_env: envBlock(net, { usdg, feed: template === "oracle" }),
  };
  const written = [];
  written.root = targetDir;
  copyDir(path.join(TEMPLATES_DIR, "_shared"), targetDir, vars, written);
  copyDir(path.join(TEMPLATES_DIR, template), targetDir, vars, written);
  if (withClient) {
    copyDir(path.join(TEMPLATES_DIR, "_client", "common"), path.join(targetDir, "client"), vars, written);
    copyDir(path.join(TEMPLATES_DIR, "_client", template), path.join(targetDir, "client", "src"), vars, written);
    if (AGENT_TEMPLATES.includes(template)) {
      copyDir(path.join(TEMPLATES_DIR, "_client", "_agent"), path.join(targetDir, "client", "src"), vars, written);
    }
  }
  return written.sort();
}
