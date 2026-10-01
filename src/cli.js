import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { checkToolchain, gitInit } from "./doctor.js";
import { validateName } from "./names.js";
import { scaffold } from "./scaffold.js";
import { DEFAULT_TEMPLATE, TEMPLATES } from "./templates.js";
import { resolveVersions } from "./versions.js";

const VERSION = "0.1.0";

const HELP = `create-stylus-latest ${VERSION}
Scaffold an Arbitrum Stylus (Rust) project pinned to the latest stylus-sdk.

Usage
  npx create-stylus-latest [project-name | path] [options]

Options
  -t, --template <name>  ${Object.keys(TEMPLATES).join(" | ")} (default: ${DEFAULT_TEMPLATE})
  -y, --yes              Skip prompts and use defaults
      --no-git           Do not run git init
      --with-client      Also generate a TypeScript (viem) client in client/
      --offline          Do not query crates.io; use the bundled known-good versions
  -l, --list             List templates
  -v, --version          Print version
  -h, --help             Show this help
`;

async function prompt(question, fallback) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} (${fallback}): `)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

export async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      template: { type: "string", short: "t" },
      yes: { type: "boolean", short: "y", default: false },
      "no-git": { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
      "with-client": { type: "boolean", default: false },
      list: { type: "boolean", short: "l", default: false },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) return console.log(HELP);
  if (values.version) return console.log(VERSION);
  if (values.list) {
    for (const [name, desc] of Object.entries(TEMPLATES)) console.log(`${name.padEnd(10)}${desc}`);
    return;
  }

  const interactive = process.stdin.isTTY && !values.yes;
  let name = positionals[0];
  if (!name) name = interactive ? await prompt("Project name", "my-stylus-app") : "my-stylus-app";
  // The argument may be a path (./apps/my-app, ., /tmp/x); the project name is its last segment.
  const targetDir = path.resolve(process.cwd(), name);
  name = path.basename(targetDir);
  const nameError = validateName(name);
  if (nameError) throw new Error(nameError);

  let template = values.template;
  if (!template) {
    template = interactive
      ? await prompt(`Template [${Object.keys(TEMPLATES).join("/")}]`, DEFAULT_TEMPLATE)
      : DEFAULT_TEMPLATE;
  }

  const versions = await resolveVersions({ offline: values.offline });
  const files = scaffold({ targetDir, name, template, versions, withClient: values["with-client"] });

  console.log(`\nCreated ${path.relative(process.cwd(), targetDir) || "."}/ from the "${template}" template (${files.length} files)`);
  console.log(`  stylus-sdk ${versions.stylusSdk}, alloy ${versions.alloy} (${versions.source})`);
  if (versions.reason) console.log(`  note: could not reach crates.io (${versions.reason}); used known-good versions`);

  if (!values["no-git"] && gitInit(targetDir)) console.log("  initialized a git repository");

  const hints = checkToolchain();
  if (hints.length > 0) {
    console.log("\nBefore you build, run:");
    for (const h of hints) console.log(`  ${h}`);
  }
  if (values["with-client"]) {
    console.log("\nClient: set CONTRACT_ADDRESS in .env after deploying, then");
    console.log("  cd client && npm install && npm start");
  }
  console.log(`\nNext:\n${path.relative(process.cwd(), targetDir) ? `  cd ${path.relative(process.cwd(), targetDir)}\n` : ""}  cargo test\n  ./scripts/deploy.sh --check-only\n`);
}
