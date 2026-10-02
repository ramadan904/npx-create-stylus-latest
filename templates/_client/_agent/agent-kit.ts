// Building blocks for an AI-agent interface to a contract: JSON in, JSON out, safety limits, machine-readable errors.
//
// An agent (an LLM with tool use, or any script) calls an *intent* such as `open_stream` with a JSON object and gets back a
// JSON object: `{ ok: true, ... }` or `{ ok: false, error: { code, message, hint } }`. Amounts are decimal strings in the
// token's base units (never floats), so nothing is lost to rounding. Stdout carries only that JSON; logs go to stderr.
import {
  BaseError,
  ContractFunctionRevertedError,
  getAddress,
  isAddress,
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
  NotActive: "This stream was already cancelled.",
  NotFunded: "This deal was already released or refunded.",
  NoSuchStream: "No stream has this id.",
  NoSuchDeal: "No deal has this id.",
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
