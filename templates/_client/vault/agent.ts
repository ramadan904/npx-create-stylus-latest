// Agent-native interface to the vault contract: intents an AI agent can call with JSON. See agent-kit.ts for the
// conventions (decimal-string amounts or whole tokens, `{ ok, ... }` results, operator-set safety limits).
//
//   npx tsx --env-file=../.env src/agent-cli.ts --tools                                  # tool schemas for an LLM
//   npx tsx --env-file=../.env src/agent-cli.ts '{"intent":"deposit_to_vault","amountTokens":"10"}'
//   npx tsx --env-file=../.env src/agent-cli.ts '{"intent":"withdraw_from_vault","all":true}'
import { parseAbi, parseEventLogs, type Address } from "viem";
import { connect } from "./client.js";
import {
  amountSchema,
  checkAmount,
  ensureFunds,
  formatTokens,
  IntentError,
  needWallet,
  parseAddress,
  parseAmount,
  policyFromEnv,
  tokenInfo,
  write,
  type Handler,
  type ToolSpec,
} from "./agent-kit.js";

// Keep in sync with the contract: run `../scripts/export-abi.sh` to see the interface.
const abi = parseAbi([
  "function asset() view returns (address)",
  "function totalDeposits() view returns (uint256)",
  "function depositOf(address account) view returns (uint256)",
  "function deposit(uint256 amount)",
  "function withdraw(uint256 amount)",
  "event Deposited(address indexed account, uint256 amount)",
  "event Withdrawn(address indexed account, uint256 amount)",
  "error ZeroAddress()",
  "error ZeroAmount()",
  "error InsufficientDeposit(uint256 have, uint256 want)",
  "error TokenTransferFailed()",
]);

export const tools: ToolSpec[] = [
  {
    name: "get_vault",
    description: "Read the vault: which token it holds, the total deposited, and how much an account (default: the agent's own) has in it.",
    input_schema: {
      type: "object",
      properties: { who: { type: "string", description: "0x address to look up. Default: the agent's own account." } },
    },
  },
  {
    name: "deposit_to_vault",
    description:
      "Move tokens from the agent's account into the vault. They stay the agent's: withdraw_from_vault returns them at any time. " +
      "Approves exactly this amount first if needed, never an unlimited allowance.",
    input_schema: { type: "object", properties: amountSchema("Amount to deposit") },
  },
  {
    name: "withdraw_from_vault",
    description: "Take tokens the agent deposited back out of the vault. Give an amount, or `all: true` for the agent's whole deposit.",
    input_schema: {
      type: "object",
      properties: {
        ...amountSchema("Amount to withdraw"),
        all: { type: "boolean", description: "Withdraw the agent's entire deposit. Use instead of an amount." },
      },
    },
  },
];

async function setup() {
  const ctx = connect();
  const address = await ctx.publicClient.readContract({ address: ctx.address, abi, functionName: "asset" });
  return { ctx, token: await tokenInfo(ctx, address), contract: ctx.address };
}

async function depositOf(ctx: ReturnType<typeof connect>, contract: Address, who: Address) {
  return ctx.publicClient.readContract({ address: contract, abi, functionName: "depositOf", args: [who] });
}

export const handlers: Record<string, Handler> = {
  async get_vault(input) {
    const who = input.who === undefined ? undefined : parseAddress("who", input.who);
    const { ctx, token, contract } = await setup();
    const account = who ?? ctx.account?.address;
    const total = await ctx.publicClient.readContract({ address: contract, abi, functionName: "totalDeposits" });
    const deposit = account === undefined ? undefined : await depositOf(ctx, contract, account);
    return {
      token,
      totalDeposits: total,
      totalDepositsTokens: formatTokens(total, token),
      account: account ?? null,
      deposit: deposit ?? null,
      depositTokens: deposit === undefined ? null : formatTokens(deposit, token),
    };
  },

  async deposit_to_vault(input) {
    const policy = policyFromEnv();
    const { ctx, token, contract } = await setup();
    const amount = parseAmount(input, token);
    checkAmount(policy, amount);
    const approvalTxHash = await ensureFunds(ctx, token.address, contract, amount);
    const { hash, receipt } = await write(ctx, { address: contract, abi, functionName: "deposit", args: [amount] });
    const [event] = parseEventLogs({ abi, logs: receipt.logs, eventName: "Deposited" });
    const after = await depositOf(ctx, contract, needWallet(ctx).account.address);
    return {
      txHash: hash,
      approvalTxHash,
      deposited: event?.args.amount,
      depositedTokens: event ? formatTokens(event.args.amount, token) : undefined,
      depositNow: after,
      depositNowTokens: formatTokens(after, token),
    };
  },

  async withdraw_from_vault(input) {
    const hasAmount = input.amount !== undefined || input.amountTokens !== undefined;
    if (input.all === true && hasAmount) {
      throw new IntentError("InvalidInput", "Give either all: true or an amount, not both", { field: "all" });
    }
    const { ctx, token, contract } = await setup();
    const me = needWallet(ctx).account.address;
    const have = await depositOf(ctx, contract, me);
    const amount = input.all === true ? have : parseAmount(input, token);
    // Checked here too so the agent gets the numbers without paying for a failed transaction; the contract enforces it.
    if (amount > have) {
      throw new IntentError("InsufficientDeposit", `The agent has ${formatTokens(have, token)} in the vault, not ${formatTokens(amount, token)}`, {
        have: have.toString(),
        want: amount.toString(),
      });
    }
    const { hash, receipt } = await write(ctx, { address: contract, abi, functionName: "withdraw", args: [amount] });
    const [event] = parseEventLogs({ abi, logs: receipt.logs, eventName: "Withdrawn" });
    return {
      txHash: hash,
      withdrawn: event?.args.amount,
      withdrawnTokens: event ? formatTokens(event.args.amount, token) : undefined,
      depositNow: have - amount,
      depositNowTokens: formatTokens(have - amount, token),
    };
  },
};
