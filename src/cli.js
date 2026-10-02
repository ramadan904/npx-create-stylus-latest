import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { checkToolchain, gitInit, runDoctor } from "./doctor.js";
import { validateName } from "./names.js";
import { scaffold } from "./scaffold.js";
import { DEFAULT_TEMPLATE, TEMPLATES } from "./templates.js";
import { resolveVersions } from "./versions.js";
import { DEFAULT_NETWORK, NETWORKS, TOKEN_TEMPLATES, resolveNetwork } from "./networks.js";

const VERSION = "0.1.0";

const HELP = `create-stylus-latest ${VERSION}
Scaffold an Arbitrum Stylus (Rust) project pinned to the latest stylus-sdk.

Usage
  npx create-stylus-latest [project-name | path] [options]
  npx create-stylus-latest doctor [--rpc <url> | --network <name>]
                                                  Check your toolchain, and optionally that an RPC can run Stylus

Options
  -t, --template <name>  ${Object.keys(TEMPLATES).join(" | ")} (default: ${DEFAULT_TEMPLATE})
  -y, --yes              Skip prompts and use defaults
      --no-git           Do not run git init
      --with-client      Also generate a TypeScript (viem) client in client/
      --network <name>   ${Object.keys(NETWORKS).join(" | ")} (default: ${DEFAULT_NETWORK})
                         Sets RPC_URL and CHAIN_ID in .env.example
      --robinhood        Same as --network robinhood-testnet
      --usdg             Point ${TOKEN_TEMPLATES.join("/")} at Paxos USDG (TOKEN_ADDRESS in .env.example). Paxos lists
                         USDG on arbitrum-one and robinhood; on testnets it has none, so you supply a stand-in
      --offline          Do not query crates.io; use the bundled known-good versions
      --rpc <url>        With "doctor": probe this endpoint (default: $RPC_URL). Only the host is printed
                         With "doctor --network <name>": probe that network's public RPC and check its chain id
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
      rpc: { type: "string" },
      "with-client": { type: "boolean", default: false },
      network: { type: "string" },
      robinhood: { type: "boolean", default: false },
      usdg: { type: "boolean", default: false },
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

  if (positionals[0] === "doctor") {
    const net = values.network || values.robinhood ? resolveNetwork(values.robinhood ? "robinhood-testnet" : values.network) : undefined;
    const rpc = values.rpc ?? net?.rpc ?? process.env.RPC_URL;
    process.exitCode = await runDoctor({ rpc, network: net, offline: values.offline });
    return;
  }

  if (values.robinhood && values.network && values.network !== "robinhood-testnet") {
    throw new Error(`--robinhood means --network robinhood-testnet; it conflicts with --network ${values.network}`);
  }
  const network = resolveNetwork(values.robinhood ? "robinhood-testnet" : (values.network ?? DEFAULT_NETWORK));

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
  const files = scaffold({
    targetDir,
    name,
    template,
    versions,
    withClient: values["with-client"],
    network: network.name,
    usdg: values.usdg,
  });

  console.log(`\nCreated ${path.relative(process.cwd(), targetDir) || "."}/ from the "${template}" template (${files.length} files)`);
  console.log(`  stylus-sdk ${versions.stylusSdk}, alloy ${versions.alloy} (${versions.source})`);
  if (versions.reason) console.log(`  note: could not reach crates.io (${versions.reason}); used known-good versions`);
  console.log(`  network: ${network.label}, chain id ${network.chainId}`);
  if (network.mainnet) console.log("  MAINNET: real money, unaudited templates. deploy.sh needs MAINNET=1 to deploy here.");
  if (values.usdg) {
    console.log(
      network.usdg
        ? `  token: Paxos USDG ${network.usdg} (6 decimals). Deploy with ./scripts/deploy.sh -- env:TOKEN_ADDRESS`
        : `  token: Paxos publishes no USDG on ${network.label}; set TOKEN_ADDRESS in .env to a stand-in ERC-20 (see .env.example)`,
    );
  }

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
