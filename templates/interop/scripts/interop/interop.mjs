// Solidity calling Rust, on a real chain. ./scripts/interop.sh runs this after exporting the Rust contract's interface.
//
// 1. Checks that IMathLib in solidity/Consumer.sol matches the deployed Rust contract's interface (target/MathLib.sol, from
//    `cargo stylus export-abi`): every function and error, by signature. A mismatch would make calls fail.
// 2. Compiles Consumer.sol with solc-js and deploys it with your MathLib's address.
// 3. Calls it and checks each answer: a value where `a * b / c` overflows in Solidity, a fee rounded up, a geometric
//    mean, a Rust error caught by name in Solidity, and a Rust error passing through Solidity to this script, by name.
//
// Env (or ../../.env): RPC_URL, CHAIN_ID, PRIVATE_KEY, CONTRACT_ADDRESS (the deployed MathLib).
import { existsSync, readFileSync } from "node:fs";
import solc from "solc";
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  isAddress,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = new URL("../../", import.meta.url);
const env = { ...readEnv(new URL(".env", root)), ...process.env };
for (const key of ["RPC_URL", "CHAIN_ID", "PRIVATE_KEY", "CONTRACT_ADDRESS"]) {
  if (!env[key]) fail(`${key} is not set (in .env or the environment)`);
}
if (!isAddress(env.CONTRACT_ADDRESS)) fail("CONTRACT_ADDRESS is not an address: deploy MathLib first (./scripts/deploy.sh)");

const chain = defineChain({
  id: Number(env.CHAIN_ID),
  name: `chain ${env.CHAIN_ID}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.RPC_URL] } },
});
const account = privateKeyToAccount(env.PRIVATE_KEY.startsWith("0x") ? env.PRIVATE_KEY : `0x${env.PRIVATE_KEY}`);
const pub = createPublicClient({ chain, transport: http(env.RPC_URL) });
const wallet = createWalletClient({ account, chain, transport: http(env.RPC_URL) });
const mathLib = env.CONTRACT_ADDRESS;

if ((await pub.getCode({ address: mathLib })) === undefined) fail(`no contract at CONTRACT_ADDRESS ${mathLib} on ${env.RPC_URL}`);

// 1. Compile, and compare the Solidity view of the Rust contract with the Rust contract's own interface.
const output = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources: { "Consumer.sol": { content: readFileSync(new URL("solidity/Consumer.sol", root), "utf8") } },
      // Cancun: what Arbitrum chains run. The compiler's newer default may use opcodes a chain does not have yet.
      settings: { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
    }),
  ),
);
const errors = (output.errors ?? []).filter((e) => e.severity === "error");
if (errors.length) fail(`Consumer.sol does not compile:\n${errors.map((e) => e.formattedMessage).join("\n")}`);
const consumer = output.contracts["Consumer.sol"].Consumer;
const solidityView = output.contracts["Consumer.sol"].IMathLib.abi;

// By selector-defining signature (names of parameters do not matter, types do).
const signatures = (abi) =>
  abi.filter((x) => x.type === "function" || x.type === "error").map((x) => `${x.type} ${x.name}(${x.inputs.map((i) => i.type).join(",")})`).sort();
const rustAbi = parseAbi(
  [...readFileSync(new URL("target/MathLib.sol", root), "utf8").matchAll(/^\s*(?:function|error)\s[^;]*;/gm)].map((m) =>
    m[0].trim().replace(/;$/, "").replace(/\b(external|public)\b/g, "").replace(/\s+/g, " ").replace(/\s+\)/g, ")").trim(),
  ),
);
const ours = signatures(solidityView);
const theirs = signatures(rustAbi);
const missing = ours.filter((s) => !theirs.includes(s));
check(missing.length === 0, "IMathLib in Consumer.sol matches the Rust contract's interface", `not in the Rust contract: ${missing.join(", ")}`);

// 2. Deploy Consumer(mathLib).
const hash = await wallet.deployContract({ abi: consumer.abi, bytecode: `0x${consumer.evm.bytecode.object}`, args: [mathLib] });
const receipt = await pub.waitForTransactionReceipt({ hash });
if (receipt.status !== "success" || !receipt.contractAddress) fail(`deploying Consumer failed (tx ${hash})`);
const address = receipt.contractAddress;
console.log(`Consumer (Solidity) deployed at ${address}, calling MathLib (Rust) at ${mathLib}\n`);

// Consumer's own ABI plus the Rust errors, so a revert that passes through Consumer decodes by name.
const abi = [...consumer.abi, ...rustAbi.filter((x) => x.type === "error")];
const read = (functionName, args) => pub.readContract({ address, abi, functionName, args });

// 3. Each call, checked.
const e = (n) => 10n ** BigInt(n);
// 1e40 units at a price of 1e40, scaled by 1e36: the product (1e80) is past 2^256 (about 1.2e77).
check((await read("value", [e(40), e(40), e(36)])) === e(44), "value(1e40, 1e40, 1e36) = 1e44, where a * b / c overflows in Solidity");
check((await read("fee", [1001n, 30n])) === 4n, "fee(1001, 30 bps) = 4: 3.003 rounded up");
check((await read("geometricMean", [4n * e(18), 9n * e(18)])) === 6n * e(18), "geometricMean(4e18, 9e18) = 6e18");
const [ok, result, name] = await read("tryValue", [1n, 1n, 0n]);
check(!ok && result === 0n && name === "DivisionByZero", 'Solidity caught the Rust error by name: tryValue(1, 1, 0) = (false, 0, "DivisionByZero")');
const max = 2n ** 256n - 1n;
try {
  await read("value", [max, 2n, 1n]);
  check(false, "value(MAX, 2, 1) reverts");
} catch (err) {
  const revert = err instanceof BaseError ? err.walk((x) => x?.name === "ContractFunctionRevertedError") : null;
  const args = revert?.data?.args ?? [];
  check(
    revert?.data?.errorName === "MulDivOverflow" && args[0] === max && args[1] === 2n && args[2] === 1n,
    "a Rust error passed through Solidity unchanged: value(MAX, 2, 1) reverts MulDivOverflow(MAX, 2, 1)",
    revert?.data?.errorName ?? err.shortMessage,
  );
}

const gas = await pub.estimateGas({ account, to: address, data: encodeFunctionData({ abi, functionName: "value", args: [e(40), e(40), e(36)] }) });
console.log(`\nGas for one Solidity -> Rust call (value, estimated, including the transaction's base cost): ${gas}`);
console.log(`\nSolidity and Rust interoperate. Consumer: ${address}`);

function check(condition, label, detail = "") {
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition || !detail ? "" : ` (${detail})`}`);
  if (!condition) process.exitCode = 1;
}

function fail(message) {
  console.error(`interop: ${message}`);
  process.exit(1);
}

function readEnv(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}
