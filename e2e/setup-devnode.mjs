// Gives a bare Nitro dev node the helper contracts that Stylus constructor deploys need.
//
// `cargo stylus deploy` runs a contract's constructor through the canonical StylusDeployer at
// 0xcEcba2F1DC234f70Dd89F2041029807F8D03A990. A fresh `--dev` node has no code there, so the deploy transaction is just a
// transfer, emits no logs, and cargo-stylus fails with "missing address: from receipt logs". This mirrors what the
// stylus-tools crate does when it boots its own dev node: become chain owner, zero the L1 price so the CREATE2 factory's
// presigned transaction fits, deploy that factory, then deploy StylusDeployer through it.
//
// Env: RPC_URL (default http://127.0.0.1:8547), CHAIN_ID (default 412346), FUNDER_KEY (a funded key; needed when the
// node was started with FUND_ADDRESS, because that flag replaces the default funding of the chain owner below).
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, concatHex, http, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const rpc = process.env.RPC_URL ?? "http://127.0.0.1:8547";
const chain = defineChain({
  id: Number(process.env.CHAIN_ID ?? 412346),
  name: "devnode",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
});
const bytecode = JSON.parse(readFileSync(new URL("./devnode-bytecode.json", import.meta.url), "utf8"));

// Addresses are lowercase on purpose: viem rejects a mixed-case address whose checksum does not match.
// The well-known key of the dev chain's owner (public in nitro's docs and in stylus-tools). Dev node only.
const owner = privateKeyToAccount("0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659");
const ARB_DEBUG = "0x00000000000000000000000000000000000000ff";
const ARB_OWNER = "0x0000000000000000000000000000000000000070";
const FACTORY = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const FACTORY_DEPLOYER = "0x3fab184622dc19b6109349b94811493bf2a45362";
const STYLUS_DEPLOYER = "0xcecba2f1dc234f70dd89f2041029807f8d03a990";

const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ account: owner, chain, transport: http(rpc) });

async function ok(hash, label) {
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted (tx ${hash})`);
  console.log(`  ${label}`);
}
const hasCode = async (address) => ((await pub.getCode({ address })) ?? "0x") !== "0x";

if (await hasCode(STYLUS_DEPLOYER)) {
  console.log("StylusDeployer is already on this node");
  process.exit(0);
}

console.log("Installing the helper contracts on the dev node");
if ((await pub.getBalance({ address: owner.address })) < parseEther("0.5")) {
  if (!process.env.FUNDER_KEY) {
    throw new Error(`The chain owner ${owner.address} has no ETH on this node. Set FUNDER_KEY to a funded key (the key you passed as FUND_ADDRESS).`);
  }
  const funder = privateKeyToAccount(process.env.FUNDER_KEY);
  const hash = await createWalletClient({ account: funder, chain, transport: http(rpc) }).sendTransaction({
    to: owner.address,
    value: parseEther("1"),
  });
  await ok(hash, "funded the chain owner");
}
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
