// Drives the generated MCP server (client/src/agent-mcp.ts) with the official MCP SDK client, the way Claude Desktop or
// Claude Code would: launched with the command its own `--config` prints, from another directory, over stdio. Then
// uses it against the real contracts on the dev node, and compares its results with the agent CLI's.
//
// Env: RPC_URL, CHAIN_ID, E2E_KEY (the funded agent key), TOKEN, STREAM, ESCROW, VAULT, STREAM_DIR, ESCROW_DIR, VAULT_DIR.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync, spawnSync } from "node:child_process";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const need = (n) => process.env[n] || (() => { throw new Error(`Set ${n}`); })();
const rpc = need("RPC_URL");
const chainId = Number(process.env.CHAIN_ID ?? 412346);
const key = need("E2E_KEY");
const chain = defineChain({ id: chainId, name: "devnode", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const agent = privateKeyToAccount(key);
const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ account: agent, chain, transport: http(rpc) });
const TOKEN = need("TOKEN");
const balanceOf = (who) => pub.readContract({ address: TOKEN, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [who] });
// The dev node only mines when something is sent; a no-op transaction brings its clock up to date.
const tick = async () => pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: agent.address, value: 0n }) });

let checks = 0;
function check(cond, label, detail) {
  checks++;
  if (!cond) throw new Error(`FAILED: ${label}${detail === undefined ? "" : `\n  ${JSON.stringify(detail)}`}`);
  console.log(`  ok  ${label}`);
}

/** The server as an MCP client launches it: the command and args its `--config` prints, from the filesystem root. */
async function connect(dir, contract, extraEnv = {}) {
  const printed = execFileSync(`${dir}/client/node_modules/.bin/tsx`, [`${dir}/client/src/agent-mcp.ts`, "--config"], { encoding: "utf8" });
  const json = printed.slice(printed.indexOf("{"), printed.lastIndexOf("}") + 1);
  const [server] = Object.values(JSON.parse(json).mcpServers);
  const client = new Client({ name: "mcp-check", version: "1.0.0" });
  const env = { ...process.env, CONTRACT_ADDRESS: contract, PRIVATE_KEY: key, RPC_URL: rpc, CHAIN_ID: String(chainId), ...extraEnv };
  await client.connect(new StdioClientTransport({ command: server.command, args: server.args, cwd: "/", env, stderr: "inherit" }));
  return client;
}

/** Calls a tool and returns its JSON result, checking that isError agrees with ok. */
async function call(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
  const result = JSON.parse(response.content[0].text);
  check(Boolean(response.isError) === !result.ok, `${name}: isError=${Boolean(response.isError)} agrees with ok=${result.ok}`);
  return result;
}

/** The same intent through the agent CLI, for comparison. */
function cli(dir, contract, intent, extraEnv = {}) {
  const r = spawnSync("npx", ["tsx", "src/agent-cli.ts", JSON.stringify(intent)], {
    cwd: `${dir}/client`,
    encoding: "utf8",
    env: { ...process.env, CONTRACT_ADDRESS: contract, PRIVATE_KEY: key, RPC_URL: rpc, CHAIN_ID: String(chainId), ...extraEnv },
  });
  return JSON.parse(r.stdout);
}

const [sdir, edir, vdir] = [need("STREAM_DIR"), need("ESCROW_DIR"), need("VAULT_DIR")];
const [STREAM, ESCROW, VAULT] = [need("STREAM"), need("ESCROW"), need("VAULT")];

console.log("\nevery agent template serves its CLI's tools over MCP");
for (const [dir, contract] of [[sdir, STREAM], [edir, ESCROW], [vdir, VAULT]]) {
  const client = await connect(dir, contract);
  check(client.getServerCapabilities()?.tools !== undefined, `${dir.split("/").pop()}: the server offers tools`);
  const { tools } = await client.listTools();
  const cliTools = JSON.parse(spawnSync("npx", ["tsx", "src/agent-cli.ts", "--tools"], { cwd: `${dir}/client`, encoding: "utf8" }).stdout);
  check(
    JSON.stringify(tools.map((t) => [t.name, t.description, t.inputSchema])) === JSON.stringify(cliTools.map((t) => [t.name, t.description, t.input_schema])),
    `${dir.split("/").pop()}: tools/list is the CLI's ${cliTools.length} tools, schemas and descriptions included`,
  );
  await client.ping();
  await client.close();
}

console.log("\nstream, through MCP: open, read, refuse over the limit, cancel twice");
const payee = privateKeyToAccount(generatePrivateKey()).address;
const client = await connect(sdir, STREAM);
const before = await balanceOf(agent.address);
await tick();
const opened = await call(client, "open_stream", { recipient: payee, amount: "300", durationSeconds: 120, startInSeconds: 30 });
check(opened.ok && /^\d+$/.test(opened.streamId), `open_stream opened stream ${opened.streamId}`, opened);
check((await balanceOf(agent.address)) === before - 300n, "the agent was debited exactly 300 on-chain");
const got = await call(client, "get_stream", { id: opened.streamId });
check(got.ok && got.state === "active", `get_stream reads it back (${got.state})`, got);
check(got.deposit === "300" && got.recipient === payee && got.youAre === "sender", "with the deposit, the recipient and the agent's role", got);
const viaCli = cli(sdir, STREAM, { intent: "get_stream", id: opened.streamId });
check(viaCli.deposit === got.deposit && viaCli.recipient === got.recipient && viaCli.sender === got.sender && JSON.stringify(viaCli.token) === JSON.stringify(got.token), "the CLI reads the same stream identically");

const capped = await connect(sdir, STREAM, { AGENT_MAX_AMOUNT: "100" });
const refused = await call(capped, "open_stream", { recipient: payee, amount: "300", durationSeconds: 60 });
check(!refused.ok && refused.error.code === "PolicyViolation", "with AGENT_MAX_AMOUNT=100, an MCP call for 300 is refused before signing", refused);
const refusedCli = cli(sdir, STREAM, { intent: "open_stream", recipient: payee, amount: "300", durationSeconds: 60 }, { AGENT_MAX_AMOUNT: "100" });
check(JSON.stringify(refusedCli) === JSON.stringify(refused), "and the CLI refuses it with the identical JSON");
check((await balanceOf(agent.address)) === before - 300n, "the refusal moved nothing");
await capped.close();

await tick();
const cancelled = await call(client, "cancel_stream", { id: opened.streamId });
check(cancelled.ok && BigInt(cancelled.paidToRecipient) + BigInt(cancelled.refundedToSender) === 300n, "cancel_stream splits the 300 exactly", cancelled);
const again = await call(client, "cancel_stream", { id: opened.streamId });
check(!again.ok && again.error.code === "NotActive" && again.error.hint, `a second cancel fails with the contract's own error, ${again.error?.code}, and a hint`, again);
const unknown = await call(client, "no_such_tool", {});
check(!unknown.ok && unknown.error.code === "UnknownIntent", "an unknown tool is a structured error, not a crash");
await client.close();

console.log(`\nMCP: ${checks} checks passed`);
