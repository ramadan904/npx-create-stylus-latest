// Agent-native interface to the faucet contract: intents an AI agent can call with JSON. See agent-kit.ts for the
// conventions (decimal-string amounts, `{ ok, ... }` results, the contract's own error names).
//
//   npx tsx --env-file=../.env src/agent-cli.ts --tools                                  # tool schemas for an LLM
//   npx tsx --env-file=../.env src/agent-cli.ts '{"intent":"get_faucet"}'
//   npx tsx --env-file=../.env src/agent-cli.ts '{"intent":"request_tokens"}'
import { parseAbi, parseEventLogs, type Address } from "viem";
import { connect } from "./client.js";
import { chainNow, formatTokens, IntentError, needWallet, parseAddress, tokenInfo, write, type Handler, type ToolSpec } from "./agent-kit.js";

// Keep in sync with the contract: run `../scripts/export-abi.sh` to see the interface.
const abi = parseAbi([
  "function token() view returns (address)",
  "function amount() view returns (uint256)",
  "function cooldown() view returns (uint256)",
  "function availableAt(address who) view returns (uint256)",
  "function drip() returns (uint256)",
  "event Dripped(address indexed to, uint256 amount)",
  "error ZeroAddress()",
  "error ZeroAmount()",
  "error TooSoon(uint256 availableAt)",
  "error TokenTransferFailed()",
]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export const tools: ToolSpec[] = [
  {
    name: "get_faucet",
    description:
      "Read the faucet: which token it gives, how much per drip, the cooldown between drips, how much it holds, and when an " +
      "account (default: the agent's own) may drip next. Check this before request_tokens.",
    input_schema: {
      type: "object",
      properties: { who: { type: "string", description: "0x address to look up. Default: the agent's own account." } },
    },
  },
  {
    name: "request_tokens",
    description:
      "Take one drip of test tokens from the faucet into the agent's own account. Allowed once per cooldown per account. " +
      "Refused before sending, with the time left, if the cooldown has not passed or the faucet is empty.",
    input_schema: { type: "object", properties: {} },
  },
];

async function setup() {
  const ctx = connect();
  const address = await ctx.publicClient.readContract({ address: ctx.address, abi, functionName: "token" });
  return { ctx, token: await tokenInfo(ctx, address), contract: ctx.address };
}

async function state(ctx: ReturnType<typeof connect>, contract: Address, tokenAddress: Address, who: Address | undefined) {
  const [amount, cooldown, held, now] = await Promise.all([
    ctx.publicClient.readContract({ address: contract, abi, functionName: "amount" }),
    ctx.publicClient.readContract({ address: contract, abi, functionName: "cooldown" }),
    ctx.publicClient.readContract({ address: tokenAddress, abi: erc20, functionName: "balanceOf", args: [contract] }),
    chainNow(ctx),
  ]);
  const availableAt = who === undefined ? undefined : await ctx.publicClient.readContract({ address: contract, abi, functionName: "availableAt", args: [who] });
  // `now` is never behind the chain (the later of the wall clock and the latest block), so this never refuses early; if
  // the chain is behind, the contract's own TooSoon comes back by name instead.
  const secondsUntilNext = availableAt === undefined ? undefined : availableAt > BigInt(now) ? availableAt - BigInt(now) : 0n;
  return { amount, cooldown, held, availableAt, secondsUntilNext };
}

export const handlers: Record<string, Handler> = {
  async get_faucet(input) {
    const who = input.who === undefined ? undefined : parseAddress("who", input.who);
    const { ctx, token, contract } = await setup();
    const account = who ?? ctx.account?.address;
    const s = await state(ctx, contract, token.address, account);
    return {
      token,
      amountPerDrip: s.amount,
      amountPerDripTokens: formatTokens(s.amount, token),
      cooldownSeconds: s.cooldown,
      faucetHolds: s.held,
      faucetHoldsTokens: formatTokens(s.held, token),
      empty: s.held < s.amount,
      account: account ?? null,
      availableAt: s.availableAt ?? null,
      secondsUntilNext: s.secondsUntilNext ?? null,
      canDripNow: s.secondsUntilNext === undefined ? null : s.secondsUntilNext === 0n && s.held >= s.amount,
    };
  },

  async request_tokens() {
    const { ctx, token, contract } = await setup();
    const me = needWallet(ctx).account.address;
    const s = await state(ctx, contract, token.address, me);
    // Checked here so the agent gets the time left without paying for a failed transaction; the contract enforces both.
    if (s.secondsUntilNext !== undefined && s.secondsUntilNext > 0n) {
      throw new IntentError("TooSoon", `This account dripped recently: the next drip is allowed in ${s.secondsUntilNext} s`, {
        availableAt: s.availableAt?.toString(),
        secondsUntilNext: s.secondsUntilNext.toString(),
      });
    }
    if (s.held < s.amount) {
      throw new IntentError("FaucetEmpty", `The faucet holds ${formatTokens(s.held, token)}, less than one drip of ${formatTokens(s.amount, token)}`, {
        held: s.held.toString(),
        amountPerDrip: s.amount.toString(),
      });
    }
    const { hash, receipt } = await write(ctx, { address: contract, abi, functionName: "drip" });
    const [event] = parseEventLogs({ abi, logs: receipt.logs, eventName: "Dripped" });
    const balance = await ctx.publicClient.readContract({ address: token.address, abi: erc20, functionName: "balanceOf", args: [me] });
    const received = event?.args.amount ?? s.amount;
    return {
      txHash: hash,
      received,
      receivedTokens: formatTokens(received, token),
      balanceNow: balance,
      balanceNowTokens: formatTokens(balance, token),
      nextAvailableAt: await ctx.publicClient.readContract({ address: contract, abi, functionName: "availableAt", args: [me] }),
    };
  },
};
