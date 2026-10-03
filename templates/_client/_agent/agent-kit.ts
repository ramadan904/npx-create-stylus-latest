// Building blocks for an AI-agent interface to a contract: JSON in, JSON out, safety limits, machine-readable errors.
//
// An agent (an LLM with tool use, or any script) calls an *intent* such as `open_stream` with a JSON object and gets back a
// JSON object: `{ ok: true, ... }` or `{ ok: false, error: { code, message, hint } }`. Amounts are decimal strings, never
// floats: `amount` in the token's base units, or `amountTokens` in whole tokens ("2.5"), converted exactly with the
// token's own decimals (USDG has 6, most tokens 18). Stdout carries only that JSON; logs go to stderr.
import {
  BaseError,
  ContractFunctionRevertedError,
  formatUnits,
  getAddress,
  isAddress,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import type { connect } from "./client.js";

export type Ctx = ReturnType<typeof connect>;

/** A tool description in the shape LLM tool-use APIs take (Anthropic `tools`, OpenAI function parameters). */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export type Handler = (input: Record<string, unknown>) => Promise<unknown>;

/** A failure an agent can act on: a stable `code`, a human sentence, and optional structured details. */
export class IntentError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

// ---- input parsing -------------------------------------------------------------------------------------------------

export function parseUint(name: string, value: unknown): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  throw new IntentError(
    "InvalidInput",
    `${name} must be a non-negative whole number (a decimal string such as "1000000" for token amounts)`,
    { field: name },
  );
}

export function parseAddress(name: string, value: unknown): Address {
  if (typeof value === "string" && isAddress(value, { strict: false })) return getAddress(value);
  throw new IntentError("InvalidInput", `${name} must be a 0x-prefixed 20-byte address`, { field: name });
}

// ---- token amounts -------------------------------------------------------------------------------------------------

const erc20Meta = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
}

/** The token's address, symbol and decimals, read from the token itself. */
export async function tokenInfo(ctx: Ctx, address: Address): Promise<TokenInfo> {
  const [decimals, symbol] = await Promise.all([
    ctx.publicClient.readContract({ address, abi: erc20Meta, functionName: "decimals" }),
    ctx.publicClient.readContract({ address, abi: erc20Meta, functionName: "symbol" }).catch(() => "?"),
  ]);
  return { address, symbol, decimals };
}

/** Converts whole tokens ("2.5") to base units exactly. More decimal places than the token has is an error, not a rounding. */
export function tokensToUnits(name: string, value: unknown, decimals: number): bigint {
  const text = typeof value === "number" ? String(value) : value;
  const match = typeof text === "string" ? /^(\d+)(?:\.(\d+))?$/.exec(text.trim()) : null;
  if (!match) {
    throw new IntentError("InvalidInput", `${name} must be a decimal number of tokens such as "2.5"`, { field: name });
  }
  const [, whole, fraction = ""] = match;
  if (fraction.length > decimals) {
    throw new IntentError("InvalidInput", `${name} has ${fraction.length} decimal places but the token has only ${decimals}`, {
      field: name,
      decimals,
    });
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** Schema properties for an amount: an intent takes exactly one of them. */
export function amountSchema(what: string) {
  return {
    amount: { type: "string", description: `${what}, in the token's base units, as a decimal string (USDG: "1000000" = 1 USDG).` },
    amountTokens: {
      type: "string",
      description: `${what}, in whole tokens, as a decimal string (e.g. "2.5"); converted exactly using the token's own decimals. Use instead of amount.`,
    },
  };
}

/** Reads `amount` (base units) or `amountTokens` (whole tokens); exactly one must be given. */
export function parseAmount(input: Record<string, unknown>, token: TokenInfo): bigint {
  const hasUnits = input.amount !== undefined && input.amount !== null;
  const hasTokens = input.amountTokens !== undefined && input.amountTokens !== null;
  if (hasUnits === hasTokens) {
    throw new IntentError("InvalidInput", "Give exactly one of amount (base units) or amountTokens (whole tokens)", { field: "amount" });
  }
  return hasUnits ? parseUint("amount", input.amount) : tokensToUnits("amountTokens", input.amountTokens, token.decimals);
}

/** An amount as whole tokens, for results an agent (or a person) reads. */
export const formatTokens = (amount: bigint, token: TokenInfo) => `${formatUnits(amount, token.decimals)} ${token.symbol}`;

// ---- safety limits ---------------------------------------------------------------------------------------------------
// An agent that holds a key can spend. These limits are enforced before anything is signed, from the environment, so the
// operator sets them and the model cannot talk its way past them.

export interface Policy {
  /** Largest amount (token base units) any single intent may move. Unset means no cap: set one for an autonomous agent. */
  maxAmount?: bigint;
  /** If set, the agent may only deal with these counterparties (recipient, seller, arbiter). */
  allowedCounterparties?: Address[];
}

export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): Policy {
  const policy: Policy = {};
  if (env.AGENT_MAX_AMOUNT) policy.maxAmount = parseUint("AGENT_MAX_AMOUNT", env.AGENT_MAX_AMOUNT);
  if (env.AGENT_ALLOWED_COUNTERPARTIES) {
    policy.allowedCounterparties = env.AGENT_ALLOWED_COUNTERPARTIES.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((a) => parseAddress("AGENT_ALLOWED_COUNTERPARTIES", a));
  }
  return policy;
}

export function checkAmount(policy: Policy, amount: bigint) {
  if (policy.maxAmount !== undefined && amount > policy.maxAmount) {
    throw new IntentError("PolicyViolation", `amount ${amount} exceeds the operator's limit of ${policy.maxAmount} (AGENT_MAX_AMOUNT)`, {
      amount: amount.toString(),
      maxAmount: policy.maxAmount.toString(),
    });
  }
}

export function checkCounterparty(policy: Policy, role: string, address: Address) {
  const allowed = policy.allowedCounterparties;
  if (allowed && !allowed.some((a) => a.toLowerCase() === address.toLowerCase())) {
    throw new IntentError("PolicyViolation", `${role} ${address} is not on the operator's allow-list (AGENT_ALLOWED_COUNTERPARTIES)`, {
      role,
      address,
    });
  }
}

// ---- chain helpers -----------------------------------------------------------------------------------------------------

/** Optional fixed gas limit (GAS_LIMIT). Skips estimation, which matters on an idle local dev node: it simulates against the
 *  latest block's timestamp, so a time-dependent call can look like it will revert when it will not. Leave unset on real chains. */
export function gasFromEnv(env: NodeJS.ProcessEnv = process.env): bigint | undefined {
  return env.GAS_LIMIT ? parseUint("GAS_LIMIT", env.GAS_LIMIT) : undefined;
}

export function needWallet(ctx: Ctx) {
  if (!ctx.walletClient || !ctx.account) {
    throw new IntentError("NoKey", "This intent sends a transaction, so PRIVATE_KEY must be set in ../.env");
  }
  return { wallet: ctx.walletClient, account: ctx.account };
}

/** Seconds since the epoch, never behind the chain: the later of the wall clock and the latest block. */
export async function chainNow(ctx: Ctx): Promise<number> {
  const block = await ctx.publicClient.getBlock();
  return Math.max(Math.floor(Date.now() / 1000), Number(block.timestamp));
}

const erc20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const satisfies Abi;

/** The gas limit for a call: twice the node's estimate, capped. Estimation runs against the latest block, and the work a call does
 *  can change by the block it lands in. Example: `cancel` on a stream skips paying the recipient when nothing is owed yet, but a
 *  second later something is owed, so a whole token transfer is added and a 30% margin is not enough. A transaction that runs out
 *  of gas still costs gas and does nothing. Only gas actually used is charged; the rest of the limit is refunded. */
export function gasWithMargin(estimate: bigint): bigint {
  const doubled = estimate * 2n;
  return doubled > MAX_GAS ? (estimate > MAX_GAS ? estimate : MAX_GAS) : doubled;
}
const MAX_GAS = 30_000_000n; // below Arbitrum's per-transaction gas cap

/** Sends a transaction and waits for it. Set GAS_LIMIT to use a fixed gas limit instead of `gasWithMargin(estimate)`. */
export async function write(
  ctx: Ctx,
  call: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] },
) {
  const { wallet, account } = needWallet(ctx);
  // Estimation also reverts with the contract's own error for a call that cannot succeed, which becomes a named error code.
  const gas = gasFromEnv() ?? gasWithMargin(await ctx.publicClient.estimateContractGas({ ...call, account } as never));
  const hash = await wallet.writeContract({ ...call, gas } as never);
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    const { gas: limit } = await ctx.publicClient.getTransaction({ hash });
    const outOfGas = receipt.gasUsed >= limit;
    throw new IntentError(
      outOfGas ? "OutOfGas" : "Reverted",
      outOfGas ? `transaction ${hash} ran out of gas (used all ${limit}); retry, or set a higher GAS_LIMIT` : `transaction ${hash} reverted`,
      { txHash: hash, gasUsed: receipt.gasUsed.toString(), gasLimit: limit.toString() },
    );
  }
  return { hash, receipt };
}

/** Makes sure `spender` may pull `amount` of `token` from the agent, approving exactly that amount (not unlimited) if needed.
 *  Also refuses early if the agent does not hold enough. Returns the approval transaction hash, if one was sent. */
export async function ensureFunds(ctx: Ctx, token: Address, spender: Address, amount: bigint): Promise<Hex | undefined> {
  const { account } = needWallet(ctx);
  const balance = await ctx.publicClient.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [account.address] });
  if (balance < amount) {
    throw new IntentError("InsufficientBalance", `the agent holds ${balance} but needs ${amount}`, {
      balance: balance.toString(),
      needed: amount.toString(),
      token,
    });
  }
  const allowance = await ctx.publicClient.readContract({ address: token, abi: erc20, functionName: "allowance", args: [account.address, spender] });
  if (allowance >= amount) return undefined;
  return (await write(ctx, { address: token, abi: erc20, functionName: "approve", args: [spender, amount] })).hash;
}

// ---- errors, output, dispatch ----------------------------------------------------------------------------------------------

const HINTS: Record<string, string> = {
  NotAuthorized: "This account is not allowed to do this right now. Check the permission or status intent to see who can.",
  NothingToWithdraw: "Nothing has been earned since the last withdrawal. Try again later.",
  InsufficientDeposit: "The account has less than that in the vault. Check get_vault, or withdraw with all: true.",
  ZeroAmount: "The amount must be greater than zero.",
  NothingToClaim: "Nothing is held for this account. Check with claim_held_payment and checkOnly, or get_stream's heldForClaim.",
  NotActive: "This stream was already cancelled.",
  NotFunded: "This deal was already released or refunded.",
  NoSuchStream: "No stream has this id.",
  NoSuchDeal: "No deal has this id.",
  TooSoon: "This account already dripped within the cooldown. get_faucet shows secondsUntilNext.",
  FaucetEmpty: "The faucet holds less than one drip. Someone has to send it tokens first.",
  StartInPast: "The start time had already passed when the transaction ran. Use a larger startInSeconds.",
  DeadlineInPast: "The deadline had already passed when the transaction ran. Use a larger deadlineSeconds.",
  TokenTransferFailed: "The token transfer failed: check the agent's balance and allowance.",
  OutOfGas: "The transaction used all its gas. Nothing changed on-chain. Retry it, or set a higher GAS_LIMIT.",
};

/** Turns anything thrown into `{ ok: false, error: { code, message, hint? } }`, decoding contract custom errors by name. */
export function toErrorResult(err: unknown) {
  if (err instanceof IntentError) {
    return { ok: false as const, error: { code: err.code, message: err.message, hint: HINTS[err.code], details: err.details } };
  }
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = reverted?.data?.errorName;
    if (name) {
      return { ok: false as const, error: { code: name, message: reverted?.shortMessage ?? err.shortMessage, hint: HINTS[name], details: { args: reverted?.data?.args } } };
    }
    return { ok: false as const, error: { code: "RpcError", message: err.shortMessage } };
  }
  return { ok: false as const, error: { code: "Failed", message: err instanceof Error ? err.message : String(err) } };
}

/** JSON.stringify cannot print bigint, so amounts and ids become decimal strings. */
export function jsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

export async function runIntent(handlers: Record<string, Handler>, request: unknown) {
  try {
    if (typeof request !== "object" || request === null || typeof (request as { intent?: unknown }).intent !== "string") {
      throw new IntentError("InvalidInput", 'Send a JSON object with an "intent" field, for example {"intent":"get_stream","id":"1"}');
    }
    const { intent, ...input } = request as { intent: string } & Record<string, unknown>;
    const handler = handlers[intent];
    if (!handler) throw new IntentError("UnknownIntent", `Unknown intent "${intent}". Known intents: ${Object.keys(handlers).join(", ")}`);
    return jsonSafe({ ok: true, intent, ...((await handler(input)) as object) }) as { ok: boolean };
  } catch (err) {
    return jsonSafe(toErrorResult(err)) as { ok: boolean };
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** The command-line entry point: `agent-cli '{"intent":"..."}'`, `agent-cli -` (JSON on stdin) or `agent-cli --tools`. */
export async function agentMain(tools: ToolSpec[], handlers: Record<string, Handler>) {
  const arg = process.argv[2];
  if (!arg || arg === "--help") {
    console.error("Usage: agent-cli '<json intent>' | agent-cli - (JSON on stdin) | agent-cli --tools (print the tool schemas)");
    process.exit(2);
  }
  if (arg === "--tools") return void console.log(JSON.stringify(tools, null, 2));
  let request: unknown;
  try {
    const text = arg === "-" ? await readStdin() : arg;
    request = JSON.parse(text);
  } catch {
    console.log(JSON.stringify(toErrorResult(new IntentError("InvalidInput", "The intent is not valid JSON"))));
    process.exit(1);
  }
  const result = await runIntent(handlers, request);
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

// ---- MCP server (Model Context Protocol, stdio) ----------------------------------------------------------------------------
// The same tools and handlers as the CLI, served to any MCP client (Claude Desktop, Claude Code, Cursor, ...): newline-
// delimited JSON-RPC 2.0 on stdin/stdout. Every call goes through `runIntent`, so the operator's limits, the named errors
// and the JSON results are exactly the CLI's. Stdout carries only protocol messages; anything else goes to stderr.

const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];

type RpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

/** Answers one JSON-RPC message; `undefined` for a notification, which gets no reply. */
export async function mcpHandle(
  server: { name: string; version: string },
  tools: ToolSpec[],
  handlers: Record<string, Handler>,
  message: RpcMessage,
): Promise<object | undefined> {
  const { id, method, params = {} } = message;
  if (id === undefined || id === null) return undefined; // notifications/initialized, notifications/cancelled, ...
  const reply = (result: object) => ({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return reply({
        protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: server,
        instructions:
          "Tools for one deployed contract. Amounts are decimal strings: `amount` in base units or `amountTokens` in whole " +
          "tokens. Every result is JSON with ok: true, or ok: false and error { code, message, hint }; the operator's " +
          "spending limits are enforced before anything is signed.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) });
    case "tools/call": {
      const args = typeof params.arguments === "object" && params.arguments !== null ? params.arguments : {};
      const result = await runIntent(handlers, { ...args, intent: params.name });
      return reply({ content: [{ type: "text", text: JSON.stringify(result) }], isError: !result.ok });
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

/** The MCP entry point. `--config` prints ready-to-paste client setup with absolute paths instead of serving. */
export async function mcpMain(server: { name: string; version: string }, tools: ToolSpec[], handlers: Record<string, Handler>) {
  if (process.argv[2] === "--config") return void printMcpConfig(server.name);
  const { createInterface } = await import("node:readline");
  const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
  // One request at a time: two concurrent writes from the same key would race for the same nonce.
  let queue = Promise.resolve();
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let message: RpcMessage;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    queue = queue.then(async () => {
      try {
        const response = await mcpHandle(server, tools, handlers, message);
        if (response) send(response);
      } catch (err) {
        send({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
      }
    });
  }
  await queue;
}

function printMcpConfig(name: string) {
  const here = new URL(".", import.meta.url).pathname; // client/src/
  const client = new URL("..", new URL(".", import.meta.url)).pathname.replace(/\/$/, "");
  const project = new URL("../..", new URL(".", import.meta.url)).pathname.replace(/\/$/, "");
  const command = `${client}/node_modules/.bin/tsx`;
  const args = [`--env-file=${project}/.env`, `${here}agent-mcp.ts`];
  console.log(`# Claude Code:\nclaude mcp add ${name} -- ${command} ${args.join(" ")}\n`);
  console.log(`# Claude Desktop (claude_desktop_config.json), Cursor (.cursor/mcp.json) or a project .mcp.json:`);
  console.log(JSON.stringify({ mcpServers: { [name]: { command, args } } }, null, 2));
  console.log(`\n# The server reads RPC_URL, CHAIN_ID, CONTRACT_ADDRESS, PRIVATE_KEY and the AGENT_* limits from ${project}/.env.`);
}
