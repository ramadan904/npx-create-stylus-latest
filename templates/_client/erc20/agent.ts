// Agent-native interface to the token contract: intents an AI agent can call with JSON. See agent-kit.ts for the
// conventions (decimal-string amounts or whole tokens, `{ ok, ... }` results, operator-set safety limits).
//
//   npx tsx --env-file=../.env src/agent-cli.ts --tools                                  # tool schemas for an LLM
//   npx tsx --env-file=../.env src/agent-cli.ts '{"intent":"get_token"}'
//   npx tsx --env-file=../.env src/agent-cli.ts '{"intent":"send_tokens","to":"0x...","amountTokens":"2.5"}'
import { parseAbi, parseEventLogs, zeroAddress, type Address } from "viem";
import { connect } from "./client.js";
import {
  amountSchema,
  checkAmount,
  checkCounterparty,
  formatTokens,
  IntentError,
  needWallet,
  parseAddress,
  parseAmount,
  policyFromEnv,
  type Handler,
  type TokenInfo,
  type ToolSpec,
  write,
} from "./agent-kit.js";

// Keep in sync with the contract: run `../scripts/export-abi.sh` to see the interface.
const abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function approve(address spender, uint256 value) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "error InsufficientBalance(address from, uint256 have, uint256 want)",
  "error InsufficientAllowance(address owner, address spender, uint256 have, uint256 want)",
]);

export const tools: ToolSpec[] = [
  {
    name: "get_token",
    description:
      "Read the token: name, symbol, decimals, total supply, and the balance of an account (default: the agent's own). " +
      "With `spender`, also how much that spender may still take from the account.",
    input_schema: {
      type: "object",
      properties: {
        who: { type: "string", description: "0x address to look up. Default: the agent's own account." },
        spender: { type: "string", description: "0x address of a spender, to also read its allowance from `who`." },
      },
    },
  },
  {
    name: "send_tokens",
    description:
      "Send tokens from the agent's account to another account. Refused before signing if the agent holds less, if the " +
      "recipient is the zero address or this token contract (tokens sent there are lost), or if the operator's limits forbid it.",
    input_schema: {
      type: "object",
      properties: { to: { type: "string", description: "0x address of the recipient." }, ...amountSchema("Amount to send") },
      required: ["to"],
    },
  },
  {
    name: "approve_spender",
    description:
      "Set how much a spender (for example a vault or an escrow contract) may take from the agent's account. Replaces the " +
      "previous allowance; 0 revokes it. The operator's limits apply, since an allowance lets the spender move that much.",
    input_schema: {
      type: "object",
      properties: { spender: { type: "string", description: "0x address allowed to spend." }, ...amountSchema("Allowance") },
      required: ["spender"],
    },
  },
];

async function setup() {
  const ctx = connect();
  const token = ctx.address;
  const [decimals, symbol] = await Promise.all([
    ctx.publicClient.readContract({ address: token, abi, functionName: "decimals" }),
    ctx.publicClient.readContract({ address: token, abi, functionName: "symbol" }),
  ]);
  const info: TokenInfo = { address: token, symbol, decimals };
  return { ctx, token: info };
}

export const handlers: Record<string, Handler> = {
  async get_token(input) {
    const who = input.who === undefined ? undefined : parseAddress("who", input.who);
    const spender = input.spender === undefined ? undefined : parseAddress("spender", input.spender);
    const { ctx, token } = await setup();
    const account = who ?? ctx.account?.address;
    if (spender && !account) throw new IntentError("InvalidInput", "Give `who` (or set PRIVATE_KEY) to read an allowance", { field: "who" });
    const c = { address: token.address, abi } as const;
    const [name, totalSupply, balance, allowance] = await Promise.all([
      ctx.publicClient.readContract({ ...c, functionName: "name" }),
      ctx.publicClient.readContract({ ...c, functionName: "totalSupply" }),
      account ? ctx.publicClient.readContract({ ...c, functionName: "balanceOf", args: [account] }) : undefined,
      account && spender ? ctx.publicClient.readContract({ ...c, functionName: "allowance", args: [account, spender] }) : undefined,
    ]);
    return {
      token: { ...token, name },
      totalSupply,
      totalSupplyTokens: formatTokens(totalSupply, token),
      account: account ?? null,
      balance: balance ?? null,
      balanceTokens: balance === undefined ? null : formatTokens(balance, token),
      ...(spender && allowance !== undefined ? { spender, allowance, allowanceTokens: formatTokens(allowance, token) } : {}),
    };
  },

  async send_tokens(input) {
    const to = parseAddress("to", input.to);
    if (to === zeroAddress) throw new IntentError("InvalidInput", "to is the zero address: tokens sent there are lost", { field: "to" });
    const { ctx, token } = await setup();
    if (to.toLowerCase() === token.address.toLowerCase()) {
      throw new IntentError("InvalidInput", "to is the token contract itself: tokens sent there are lost", { field: "to" });
    }
    const amount = parseAmount(input, token);
    if (amount === 0n) throw new IntentError("ZeroAmount", "amount must be greater than zero", { field: "amount" });
    const policy = policyFromEnv();
    checkAmount(policy, amount);
    checkCounterparty(policy, "recipient", to);
    const me = needWallet(ctx).account.address;
    const have = await ctx.publicClient.readContract({ address: token.address, abi, functionName: "balanceOf", args: [me] });
    // Checked here so the agent learns its balance without paying for a failed transaction; the contract enforces it too.
    if (have < amount) {
      throw new IntentError("InsufficientBalance", `the agent holds ${formatTokens(have, token)} but tried to send ${formatTokens(amount, token)}`, {
        balance: have.toString(),
        needed: amount.toString(),
        token: token.address,
      });
    }
    const { hash, receipt } = await write(ctx, { address: token.address, abi, functionName: "transfer", args: [to, amount] });
    const [event] = parseEventLogs({ abi, logs: receipt.logs, eventName: "Transfer" });
    const sent = event?.args.value ?? amount;
    const balance = await ctx.publicClient.readContract({ address: token.address, abi, functionName: "balanceOf", args: [me] });
    return {
      txHash: hash,
      to,
      sent,
      sentTokens: formatTokens(sent, token),
      balanceNow: balance,
      balanceNowTokens: formatTokens(balance, token),
    };
  },

  async approve_spender(input) {
    const spender = parseAddress("spender", input.spender);
    if (spender === zeroAddress) throw new IntentError("InvalidInput", "spender is the zero address", { field: "spender" });
    const { ctx, token } = await setup();
    const amount = parseAmount(input, token);
    // Revoking (0) is always allowed: it only reduces what can be spent.
    if (amount > 0n) {
      const policy = policyFromEnv();
      checkAmount(policy, amount);
      checkCounterparty(policy, "spender", spender);
    }
    const me = needWallet(ctx).account.address;
    const previous = await ctx.publicClient.readContract({ address: token.address, abi, functionName: "allowance", args: [me, spender] });
    const { hash } = await write(ctx, { address: token.address, abi, functionName: "approve", args: [spender, amount] });
    const allowance = await ctx.publicClient.readContract({ address: token.address, abi, functionName: "allowance", args: [me, spender] });
    return {
      txHash: hash,
      spender,
      previousAllowance: previous,
      allowance,
      allowanceTokens: formatTokens(allowance, token),
    };
  },
};
