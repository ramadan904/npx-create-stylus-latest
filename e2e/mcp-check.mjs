// Drives the generated MCP server (client/src/agent-mcp.ts) with the official MCP SDK client, the way Claude Desktop or
// Claude Code would: launched with the command its own `--config` prints, from another directory, over stdio. Then
// uses it against the real contracts on the dev node, and compares its results with the agent CLI's.
//
// Env: RPC_URL, CHAIN_ID, E2E_KEY (the funded agent key), TOKEN, STREAM, ESCROW, VAULT, FAUCET, ORACLE, and their *_DIR
// projects (TOKEN_DIR for the token), and FEED (the mock price feed ORACLE reads; see mock-feed.mjs).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync, spawnSync } from "node:child_process";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { setFeed } from "./mock-feed.mjs";

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

const [tdir, sdir, edir, vdir, fdir, odir] = [need("TOKEN_DIR"), need("STREAM_DIR"), need("ESCROW_DIR"), need("VAULT_DIR"), need("FAUCET_DIR"), need("ORACLE_DIR")];
const [STREAM, ESCROW, VAULT, FAUCET, ORACLE, FEED] = [need("STREAM"), need("ESCROW"), need("VAULT"), need("FAUCET"), need("ORACLE"), need("FEED")];

console.log("\nevery agent template serves its CLI's tools over MCP");
for (const [dir, contract] of [[tdir, TOKEN], [sdir, STREAM], [edir, ESCROW], [vdir, VAULT], [fdir, FAUCET], [odir, ORACLE]]) {
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

console.log("\nfaucet, through MCP: read it, find it empty, refill it, take a drip, be refused within the cooldown");
const tokenAbi = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
const faucet = await connect(fdir, FAUCET);
const info = await call(faucet, "get_faucet", {});
check(info.ok && info.amountPerDrip === "100" && info.cooldownSeconds === "30" && info.token?.symbol === "TST", "get_faucet reads the drip, the cooldown and the token", info);
const infoCli = cli(fdir, FAUCET, { intent: "get_faucet" });
check(infoCli.amountPerDrip === info.amountPerDrip && infoCli.faucetHolds === info.faucetHolds && infoCli.account === info.account, "the CLI reads the faucet identically");
// The flows above leave the faucet holding less than one drip, so the agent's first request finds it empty.
check(info.empty === true && info.canDripNow === false, `the faucet holds ${info.faucetHolds}, less than one drip`, info);
const dry = await call(faucet, "request_tokens", {});
check(!dry.ok && dry.error.code === "FaucetEmpty" && dry.error.hint, "request_tokens on an empty faucet is refused before sending, with a hint", dry);
await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: TOKEN, abi: tokenAbi, functionName: "transfer", args: [FAUCET, 250n] }) });
const mine = await balanceOf(agent.address);
const drip = await call(faucet, "request_tokens", {});
check(drip.ok && drip.received === "100", "after a refill, request_tokens takes one drip of 100", drip);
check((await balanceOf(agent.address)) === mine + 100n && drip.balanceNow === String(mine + 100n), "the agent holds exactly 100 more, as the result says");
const soon = await call(faucet, "request_tokens", {});
check(!soon.ok && soon.error.code === "TooSoon" && Number(soon.error.details.secondsUntilNext) > 0 && soon.error.hint, `a second request is refused as TooSoon, ${soon.error?.details?.secondsUntilNext} s left`, soon);
check((await balanceOf(agent.address)) === mine + 100n, "the refusal moved nothing");
await faucet.close();

console.log("\nerc20, through MCP: read, send, refuse mistakes and the operator's limits, approve and revoke");
// Fresh accounts: the stream above paid its recipient, and these checks count exact balances.
const [recipient, stranger] = [privateKeyToAccount(generatePrivateKey()).address, privateKeyToAccount(generatePrivateKey()).address];
const token = await connect(tdir, TOKEN);
const tinfo = await call(token, "get_token", {});
check(tinfo.ok && tinfo.token?.name === "Test Token" && tinfo.token.symbol === "TST" && tinfo.token.decimals === 18, "get_token reads the name, the symbol and the decimals", tinfo);
check(tinfo.account === agent.address && tinfo.balance === String(await balanceOf(agent.address)), "and the agent's balance, as the chain has it", tinfo);
check(JSON.stringify(cli(tdir, TOKEN, { intent: "get_token" })) === JSON.stringify(tinfo), "the CLI reads the token with the identical JSON");
const tBefore = await balanceOf(agent.address);
const sent = await call(token, "send_tokens", { to: recipient, amountTokens: "0.5" });
check(sent.ok && sent.sent === String(5n * 10n ** 17n) && sent.to === recipient, "send_tokens sends 0.5 TST, converted exactly to 5e17 base units", sent);
check((await balanceOf(recipient)) === 5n * 10n ** 17n && (await balanceOf(agent.address)) === tBefore - 5n * 10n ** 17n, "the recipient holds exactly that, and the agent holds exactly that less");
check(sent.balanceNow === String(tBefore - 5n * 10n ** 17n), "as the result says");
const zero = await call(token, "send_tokens", { to: "0x0000000000000000000000000000000000000000", amount: "1" });
check(!zero.ok && zero.error.code === "InvalidInput" && zero.error.details?.field === "to", "sending to the zero address is refused before signing", zero);
const self = await call(token, "send_tokens", { to: TOKEN, amount: "1" });
check(!self.ok && self.error.code === "InvalidInput", "so is sending to the token contract itself", self);
const tooMuch = await call(token, "send_tokens", { to: recipient, amount: String(tBefore) });
check(!tooMuch.ok && tooMuch.error.code === "InsufficientBalance" && tooMuch.error.hint, "sending more than the agent holds is refused as InsufficientBalance, with a hint", tooMuch);
const fenced = await connect(tdir, TOKEN, { AGENT_ALLOWED_COUNTERPARTIES: stranger });
const notAllowed = await call(fenced, "send_tokens", { to: recipient, amount: "1" });
check(!notAllowed.ok && notAllowed.error.code === "PolicyViolation", "with AGENT_ALLOWED_COUNTERPARTIES set, a recipient not on it is refused", notAllowed);
check(JSON.stringify(cli(tdir, TOKEN, { intent: "send_tokens", to: recipient, amount: "1" }, { AGENT_ALLOWED_COUNTERPARTIES: stranger })) === JSON.stringify(notAllowed), "and the CLI refuses it with the identical JSON");
await fenced.close();
check((await balanceOf(recipient)) === 5n * 10n ** 17n && (await balanceOf(agent.address)) === tBefore - 5n * 10n ** 17n, "none of the refusals moved anything");
const approved = await call(token, "approve_spender", { spender: recipient, amount: "1000" });
check(approved.ok && approved.previousAllowance === "0" && approved.allowance === "1000", "approve_spender sets an allowance of exactly 1000", approved);
const withSpender = await call(token, "get_token", { spender: recipient });
check(withSpender.ok && withSpender.allowance === "1000", "get_token with a spender reads it back", withSpender);
const capped20 = await connect(tdir, TOKEN, { AGENT_MAX_AMOUNT: "100" });
const overCap = await call(capped20, "approve_spender", { spender: recipient, amount: "1000" });
check(!overCap.ok && overCap.error.code === "PolicyViolation", "with AGENT_MAX_AMOUNT=100, an allowance of 1000 is refused: it could be spent", overCap);
const revoked = await call(capped20, "approve_spender", { spender: recipient, amount: "0" });
check(revoked.ok && revoked.previousAllowance === "1000" && revoked.allowance === "0", "but revoking (0) is always allowed, and does revoke", revoked);
await capped20.close();
await token.close();

console.log("\noracle, through MCP: price, value and amount from a fresh price; stale, zero and incomplete prices refused by name");
const oracleValueOf = (amount, decimals) =>
  pub.readContract({ address: ORACLE, abi: parseAbi(["function valueOf(uint256, uint8) view returns (uint256)"]), functionName: "valueOf", args: [amount, decimals] });
const feedAt = async (answer, age) => {
  const { timestamp } = await pub.getBlock();
  return setFeed(FEED, answer, age === null ? 0n : timestamp - BigInt(age));
};
const PRICE = 3000n * 10n ** 8n; // 3000 with the feed's 8 decimals, as an ETH / USD feed reports it
await feedAt(PRICE, 0);
const oracle = await connect(odir, ORACLE);
const price = await call(oracle, "get_price", {});
check(price.ok && price.price === String(PRICE) && price.priceDecimals === 8 && price.priceFormatted === "3000", "get_price reads 3000 through the contract", price);
check(price.feed.toLowerCase() === FEED.toLowerCase() && price.decimalsMatch === true && price.maxAgeSeconds === "3600", "with the feed, its decimals checked against the feed, and the max age", price);
const priceCli = cli(odir, ORACLE, { intent: "get_price" });
check(priceCli.price === price.price && priceCli.updatedAt === price.updatedAt && priceCli.feed === price.feed, "the CLI reads the same price and update time");
const worth = await call(oracle, "value_of", { amountTokens: "1.5" });
check(worth.ok && worth.value === String(4500n * 10n ** 18n) && worth.valueFormatted === "4500", "value_of: 1.5 ETH is worth exactly 4500", worth);
const forFifty = await call(oracle, "amount_for_value", { value: "45" });
check(forFifty.ok && forFifty.amount === String(15n * 10n ** 15n) && forFifty.amountFormatted === "0.015", "amount_for_value: 45 is exactly 0.015 ETH", forFifty);
const forOne = await call(oracle, "amount_for_value", { value: "1", decimals: 6 });
check(forOne.ok && forOne.amount === "334" && BigInt(forOne.value) >= 10n ** 18n, "amount_for_value rounds up: 1 at 3000 is 334 units of a 6-decimal asset, worth at least 1", forOne);
check((await oracleValueOf(333n, 6)) < 10n ** 18n, "and the contract confirms one unit less (333) is worth less than 1: the smallest amount that is never short");

await feedAt(PRICE, 7200);
const stale = await call(oracle, "get_price", {});
check(!stale.ok && stale.error.code === "StalePrice" && stale.error.hint && stale.error.details?.args?.[2] === "3600", "a price 2 hours old is refused as StalePrice(updatedAt, now, maxAge 3600), with a hint", stale);
const staleValue = await call(oracle, "value_of", { amountTokens: "1" });
const staleAmount = await call(oracle, "amount_for_value", { value: "50" });
check(staleValue.error?.code === "StalePrice" && staleAmount.error?.code === "StalePrice", "value_of and amount_for_value refuse it too: no payment is priced with it");
const staleCli = cli(odir, ORACLE, { intent: "get_price" });
check(staleCli.error?.code === "StalePrice" && staleCli.error.details.args[0] === stale.error.details.args[0], "the CLI refuses it the same way");
await feedAt(0n, 0);
const zeroPrice = await call(oracle, "get_price", {});
check(!zeroPrice.ok && zeroPrice.error.code === "InvalidPrice" && zeroPrice.error.hint, "a zero price is refused as InvalidPrice", zeroPrice);
await feedAt(PRICE, null);
const incomplete = await call(oracle, "amount_for_value", { value: "50" });
check(!incomplete.ok && incomplete.error.code === "IncompleteRound", "a round with no update time is refused as IncompleteRound", incomplete);
await feedAt(PRICE, 0);
const served = await call(oracle, "get_price", {});
check(served.ok && served.price === String(PRICE), "once the feed updates, prices are served again", served);
await oracle.close();

console.log(`\nMCP: ${checks} checks passed`);
