// Agent-native interface to the price oracle: intents an AI agent can call with JSON. See agent-kit.ts for the
// conventions (decimal-string amounts, `{ ok, ... }` results, the contract's own error names).
//
// Every price comes through the contract, so a stale, zero or incomplete price is refused by name (StalePrice,
// InvalidPrice, IncompleteRound) instead of being returned: an agent cannot price a payment with bad data.
//
//   npx tsx --env-file=../.env src/agent-cli.ts --tools                                  # tool schemas for an LLM
//   npx tsx --env-file=../.env src/agent-cli.ts '{"intent":"get_price"}'
//   npx tsx --env-file=../.env src/agent-cli.ts '{"intent":"amount_for_value","value":"50"}'
import { formatUnits, parseAbi } from "viem";
import { connect } from "./client.js";
import { chainNow, IntentError, parseUint, tokensToUnits, type Handler, type ToolSpec } from "./agent-kit.js";

// Keep in sync with the contract: run `../scripts/export-abi.sh` to see the interface.
const abi = parseAbi([
  "function feed() view returns (address)",
  "function decimals() view returns (uint8)",
  "function maxAge() view returns (uint256)",
  "function latestPrice() view returns (int256, uint256)",
  "function valueOf(uint256 amount, uint8 amountDecimals) view returns (uint256)",
  "function decimalsMatch() view returns (bool)",
  "error ZeroAddress()",
  "error InvalidConfig()",
  "error FeedUnavailable()",
  "error InvalidPrice(int256 answer)",
  "error IncompleteRound()",
  "error StalePrice(uint256 updatedAt, uint256 now, uint256 maxAge)",
  "error Overflow()",
]);

// valueOf returns values with 18 decimals, in the feed's quote currency (USD for Chainlink's USD feeds).
const VALUE_DECIMALS = 18;

const assetDecimalsSchema = {
  type: "integer",
  description: "Decimals of the priced asset's base units (18 for ETH, 6 for USDC). Default 18.",
};

export const tools: ToolSpec[] = [
  {
    name: "get_price",
    description:
      "Read the feed's latest price through the contract, with when it was updated and how old it is. Refused by name " +
      "(StalePrice, InvalidPrice, IncompleteRound, FeedUnavailable) if the price cannot be trusted. Check this before " +
      "pricing a payment.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "value_of",
    description:
      "What an amount of the priced asset is worth in the feed's quote currency (USD for a USD feed), computed by the " +
      "contract from a fresh price and rounded down. Example: amountTokens \"1.5\" of ETH on an ETH / USD feed.",
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "string", description: "Amount in the asset's base units, as a decimal string (\"1500000000000000000\")." },
        amountTokens: { type: "string", description: "Amount in whole units of the asset (\"1.5\"). Use instead of amount." },
        decimals: assetDecimalsSchema,
      },
    },
  },
  {
    name: "amount_for_value",
    description:
      "The smallest amount of the priced asset worth at least `value` in the quote currency (for example: how much ETH is " +
      "$50), from a fresh price. Rounded up, so a payment of this amount is never short; the contract's valueOf confirms it.",
    input_schema: {
      type: "object",
      properties: {
        value: { type: "string", description: "The value wanted, in whole units of the quote currency, as a decimal string (\"50\" or \"12.34\")." },
        decimals: assetDecimalsSchema,
      },
      required: ["value"],
    },
  },
];

function parseDecimals(input: Record<string, unknown>): number {
  if (input.decimals === undefined || input.decimals === null) return 18;
  const decimals = Number(parseUint("decimals", input.decimals));
  if (decimals > 36) throw new IntentError("InvalidInput", "decimals must be at most 36", { field: "decimals" });
  return decimals;
}

/** The latest price through the contract, which refuses one that cannot be trusted. */
async function freshPrice(ctx: ReturnType<typeof connect>) {
  const [[answer, updatedAt], feedDecimals] = await Promise.all([
    ctx.publicClient.readContract({ address: ctx.address, abi, functionName: "latestPrice" }),
    ctx.publicClient.readContract({ address: ctx.address, abi, functionName: "decimals" }),
  ]);
  return { answer, updatedAt, feedDecimals };
}

export const handlers: Record<string, Handler> = {
  async get_price() {
    const ctx = connect();
    const { answer, updatedAt, feedDecimals } = await freshPrice(ctx);
    const [feed, maxAge, decimalsMatch, now] = await Promise.all([
      ctx.publicClient.readContract({ address: ctx.address, abi, functionName: "feed" }),
      ctx.publicClient.readContract({ address: ctx.address, abi, functionName: "maxAge" }),
      ctx.publicClient.readContract({ address: ctx.address, abi, functionName: "decimalsMatch" }),
      chainNow(ctx),
    ]);
    return {
      feed,
      price: answer,
      priceDecimals: feedDecimals,
      priceFormatted: formatUnits(answer, feedDecimals),
      updatedAt,
      ageSeconds: BigInt(now) > updatedAt ? BigInt(now) - updatedAt : 0n,
      maxAgeSeconds: maxAge,
      // false means the contract was deployed with the wrong decimals for this feed: its values would be off by powers of ten.
      decimalsMatch,
    };
  },

  async value_of(input) {
    const decimals = parseDecimals(input);
    const hasUnits = input.amount !== undefined && input.amount !== null;
    const hasTokens = input.amountTokens !== undefined && input.amountTokens !== null;
    if (hasUnits === hasTokens) {
      throw new IntentError("InvalidInput", "Give exactly one of amount (base units) or amountTokens (whole units)", { field: "amount" });
    }
    const amount = hasUnits ? parseUint("amount", input.amount) : tokensToUnits("amountTokens", input.amountTokens, decimals);
    const ctx = connect();
    const [value, { answer, updatedAt, feedDecimals }] = await Promise.all([
      ctx.publicClient.readContract({ address: ctx.address, abi, functionName: "valueOf", args: [amount, decimals] }),
      freshPrice(ctx),
    ]);
    return {
      amount,
      decimals,
      value,
      valueDecimals: VALUE_DECIMALS,
      valueFormatted: formatUnits(value, VALUE_DECIMALS),
      priceUsed: formatUnits(answer, feedDecimals),
      priceUpdatedAt: updatedAt,
    };
  },

  async amount_for_value(input) {
    const decimals = parseDecimals(input);
    const wanted = tokensToUnits("value", input.value, VALUE_DECIMALS);
    if (wanted === 0n) throw new IntentError("ZeroAmount", "value must be greater than zero", { field: "value" });
    const ctx = connect();
    const { answer, updatedAt, feedDecimals } = await freshPrice(ctx);
    // valueOf(amount) = floor(amount * price * 1e18 / 10^(decimals + feedDecimals)). The smallest amount with
    // valueOf(amount) >= wanted is this ceiling division; one base unit less is worth less than `wanted`.
    const numerator = wanted * 10n ** BigInt(decimals + feedDecimals);
    const denominator = answer * 10n ** BigInt(VALUE_DECIMALS);
    const amount = (numerator + denominator - 1n) / denominator;
    const value = await ctx.publicClient.readContract({ address: ctx.address, abi, functionName: "valueOf", args: [amount, decimals] });
    if (value < wanted) {
      // Only if the price moved between the two reads; the agent should simply ask again.
      throw new IntentError("PriceMoved", "The price changed while quoting; ask again", { wanted: wanted.toString(), got: value.toString() });
    }
    return {
      amount,
      decimals,
      amountFormatted: formatUnits(amount, decimals),
      value,
      valueDecimals: VALUE_DECIMALS,
      valueFormatted: formatUnits(value, VALUE_DECIMALS),
      priceUsed: formatUnits(answer, feedDecimals),
      priceUpdatedAt: updatedAt,
    };
  },
};
