// Prepares a freshly started Nitro dev node so you can deploy to it like a real chain. ./scripts/devnode.sh runs this.
//
// 1. Funds your deploy key. A `--dev` node only funds its own chain-owner account, so without this your PRIVATE_KEY
//    (from the environment or ../../.env) would have no ETH to deploy with.
// 2. Installs the helper contracts that Stylus constructor deploys need. `cargo stylus deploy` runs a constructor
//    through the canonical StylusDeployer at 0xcEcba2F1DC234f70Dd89F2041029807F8D03A990. A bare node has no code there,
//    so the deploy is a plain transfer that emits no logs and cargo-stylus fails with "missing address: from receipt
//    logs". This mirrors what the stylus-tools crate does when it boots its own dev node: become chain owner, zero the
//    L1 price so the CREATE2 factory's presigned transaction fits, deploy that factory, then StylusDeployer through it.
//    The two bytecodes are vendored in bytecode.json (from stylus-tools, MIT OR Apache-2.0).
//
// If you started the node with FUND_ADDRESS (which replaces the chain owner's own funding), your funded PRIVATE_KEY is
// used to fund the chain owner instead.
//
// Env: RPC_URL (default http://127.0.0.1:8547), CHAIN_ID (default 412346), PRIVATE_KEY (optional, else read from ../../.env).
import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, concatHex, http, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const rpc = process.env.RPC_URL ?? "http://127.0.0.1:8547";
const chain = defineChain({
  id: Number(process.env.CHAIN_ID ?? 412346),
  name: "devnode",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
});
const bytecode = JSON.parse(readFileSync(new URL("./bytecode.json", import.meta.url), "utf8"));

// The well-known key of the dev chain's owner (public in nitro's docs and in stylus-tools). Dev node only.
const owner = privateKeyToAccount("0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659");
// Addresses are lowercase on purpose: viem rejects a mixed-case address whose checksum does not match.
const ARB_DEBUG = "0x00000000000000000000000000000000000000ff";
const ARB_OWNER = "0x0000000000000000000000000000000000000070";
const FACTORY = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const FACTORY_DEPLOYER = "0x3fab184622dc19b6109349b94811493bf2a45362";
const STYLUS_DEPLOYER = "0xcecba2f1dc234f70dd89f2041029807f8d03a990";

const pub = createPublicClient({ chain, transport: http(rpc) });
const walletFor = (account) => createWalletClient({ account, chain, transport: http(rpc) });

// The deploy key: PRIVATE_KEY from the environment, else from the project's .env.
function deployAccount() {
  let key = process.env.PRIVATE_KEY;
  const envFile = new URL("../../.env", import.meta.url);
  if (!key && existsSync(envFile)) {
    const line = readFileSync(envFile, "utf8").split(/\r?\n/).find((l) => /^\s*PRIVATE_KEY\s*=/.test(l));
    key = line?.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
  }
  if (!key) return undefined;
  try {
    return privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
  } catch {
    console.warn("  PRIVATE_KEY is not a valid private key; not funding it");
    return undefined;
  }
}

async function ok(hash, label) {
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted (tx ${hash})`);
  console.log(`  ${label}`);
}
const hasCode = async (address) => ((await pub.getCode({ address })) ?? "0x") !== "0x";
const balance = (address) => pub.getBalance({ address });

const user = deployAccount();

// Make sure the chain owner can pay for the setup transactions below.
if ((await balance(owner.address)) < parseEther("0.5")) {
  if (!user || (await balance(user.address)) < parseEther("2")) {
    throw new Error(
      `The chain owner ${owner.address} has no ETH on this node. It was probably started with FUND_ADDRESS. ` +
        "Put the funded key in PRIVATE_KEY (environment or .env) so it can pay for the setup, or start the node without FUND_ADDRESS.",
    );
  }
  await ok(
    await walletFor(user).sendTransaction({ to: owner.address, value: parseEther("1") }),
    "funded the chain owner from your deploy key",
  );
}

// Give the deploy key some ETH to work with.
if (user && (await balance(user.address)) < parseEther("1")) {
  await ok(
    await walletFor(owner).sendTransaction({ to: user.address, value: parseEther("10") }),
    `funded your deploy key ${user.address} with 10 ETH`,
  );
}

if (await hasCode(STYLUS_DEPLOYER)) {
  console.log("StylusDeployer is already on this node");
  process.exit(0);
}

console.log("Installing the helper contracts on the dev node");
const wallet = walletFor(owner);
await ok(
  await wallet.writeContract({
    address: ARB_DEBUG,
    abi: parseAbi(["function becomeChainOwner()"]),
    functionName: "becomeChainOwner",
  }),
  "became chain owner",
);
await ok(
  await wallet.writeContract({
    address: ARB_OWNER,
    abi: parseAbi(["function setL1PricePerUnit(uint256 value)"]),
    functionName: "setL1PricePerUnit",
    args: [0n],
  }),
  "set the L1 price to zero",
);
await ok(await wallet.sendTransaction({ to: FACTORY_DEPLOYER, value: parseEther("0.1") }), "funded the CREATE2 factory deployer");
if (!(await hasCode(FACTORY))) {
  const hash = await pub.sendRawTransaction({ serializedTransaction: `0x${bytecode.create2FactoryRawTx}` });
  await ok(hash, "deployed the CREATE2 factory");
}
// A zero salt followed by the init code: the factory's calling convention.
const data = concatHex([`0x${"00".repeat(32)}`, `0x${bytecode.stylusDeployer}`]);
await ok(await wallet.sendTransaction({ to: FACTORY, data }), "deployed StylusDeployer through the factory");

if (!(await hasCode(STYLUS_DEPLOYER))) {
  throw new Error(`No code at ${STYLUS_DEPLOYER} after setup; the CREATE2 address did not match`);
}
console.log(`StylusDeployer is ready at ${STYLUS_DEPLOYER}`);
