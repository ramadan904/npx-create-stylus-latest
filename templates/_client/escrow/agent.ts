// Agent-native interface to the escrow contract: intents an AI agent can call with JSON. See agent-kit.ts for the
// conventions (decimal-string amounts, `{ ok, ... }` results, operator-set safety limits).
//
//   npx tsx --env-file=../.env src/agent-cli.ts --tools                                    # tool schemas for an LLM
//   npx tsx --env-file=../.env src/agent-cli.ts '{"intent":"create_escrow","seller":"0x...","amount":"5000000","deadlineSeconds":86400}'
import { parseAbi, parseEventLogs, type Address } from "viem";
import { connect } from "./client.js";
import {
  chainNow,
  checkAmount,
  checkCounterparty,
  ensureFunds,
  parseAddress,
  parseUint,
  policyFromEnv,
  write,
  type Handler,
  type ToolSpec,
} from "./agent-kit.js";

// Keep in sync with the contract: run `../scripts/export-abi.sh` to see the interface.
const abi = parseAbi([
  "function token() view returns (address)",
  "function deal(uint256 id) view returns (address, address, address, uint256, uint256, uint8)",
  "function canRelease(uint256 id, address who) view returns (bool)",
  "function canRefund(uint256 id, address who) view returns (bool)",
  "function create(address seller, uint256 amount, uint256 deadline, address arbiter) returns (uint256)",
  "function release(uint256 id)",
  "function refund(uint256 id)",
  "event DealCreated(uint256 indexed id, address indexed buyer, address indexed seller, uint256 amount, uint256 deadline)",
  "error NoSuchDeal(uint256 id)",
  "error NotFunded(uint256 id)",
  "error NotAuthorized()",
  "error SelfDeal()",
  "error DeadlineInPast(uint256 deadline, uint256 now)",
  "error TokenTransferFailed()",
]);

const ZERO: Address = "0x0000000000000000000000000000000000000000";
const STATES = ["unknown", "funded", "released", "refunded"] as const;
const idSchema = { type: ["string", "integer"], description: "The deal id (a decimal string or integer)." };

export const tools: ToolSpec[] = [
  {
    name: "create_escrow",
    description:
      "Lock funds for `seller` until the work is accepted. The buyer (this agent) or the optional arbiter can release the funds to the seller; " +
      "the seller or the arbiter can refund them to the buyer at any time; and after the deadline the buyer can take them back alone.",
    input_schema: {
      type: "object",
      properties: {
        seller: { type: "string", description: "0x address that is paid on release." },
        amount: { type: "string", description: "Amount to lock, in the token's base units, as a decimal string." },
        deadlineSeconds: { type: "integer", minimum: 1, description: "Seconds from now after which the buyer may refund alone." },
        arbiter: { type: "string", description: "Optional 0x address that can settle a dispute either way. Omit for none." },
      },
      required: ["seller", "amount", "deadlineSeconds"],
    },
  },
  {
    name: "get_escrow",
    description: "Read a deal: parties, amount, deadline and state, and what the agent's own account is currently allowed to do with it.",
    input_schema: { type: "object", properties: { id: idSchema }, required: ["id"] },
  },
  {
    name: "check_escrow_permissions",
    description: "Ask the contract whether an account could release or refund a deal right now, without sending a transaction. Defaults to the agent's own account.",
    input_schema: { type: "object", properties: { id: idSchema, who: { type: "string", description: "0x address to check. Default: the agent's own account." } }, required: ["id"] },
  },
  {
    name: "release_escrow",
    description: "Pay the seller. Allowed for the buyer or the arbiter while the deal is funded. Final.",
    input_schema: { type: "object", properties: { id: idSchema }, required: ["id"] },
  },
  {
    name: "refund_escrow",
    description: "Return the funds to the buyer. Allowed for the seller or the arbiter at any time, and for the buyer once the deadline has passed. Final.",
    input_schema: { type: "object", properties: { id: idSchema }, required: ["id"] },
  },
];

async function setup() {
  const ctx = connect();
  const token = await ctx.publicClient.readContract({ address: ctx.address, abi, functionName: "token" });
  return { ctx, token, contract: ctx.address };
}

async function readDeal(id: bigint, who?: Address) {
  const { ctx, contract } = await setup();
  const [buyer, seller, arbiter, amount, deadline, state] = await ctx.publicClient.readContract({ address: contract, abi, functionName: "deal", args: [id] });
  const account = who ?? ctx.account?.address;
  const permissions = account
    ? {
        account,
        canRelease: await ctx.publicClient.readContract({ address: contract, abi, functionName: "canRelease", args: [id, account] }),
        canRefund: await ctx.publicClient.readContract({ address: contract, abi, functionName: "canRefund", args: [id, account] }),
      }
    : undefined;
  return { id, state: STATES[state] ?? String(state), buyer, seller, arbiter: arbiter === ZERO ? null : arbiter, amount, deadline, permissions };
}

export const handlers: Record<string, Handler> = {
  async create_escrow(input) {
    const policy = policyFromEnv();
    const seller = parseAddress("seller", input.seller);
    const amount = parseUint("amount", input.amount);
    const deadlineIn = parseUint("deadlineSeconds", input.deadlineSeconds);
    const arbiter = input.arbiter === undefined || input.arbiter === null ? ZERO : parseAddress("arbiter", input.arbiter);
    checkAmount(policy, amount);
    checkCounterparty(policy, "seller", seller);
    if (arbiter !== ZERO) checkCounterparty(policy, "arbiter", arbiter);

    const { ctx, token, contract } = await setup();
    const deadline = BigInt(await chainNow(ctx)) + deadlineIn;
    const approvalTxHash = await ensureFunds(ctx, token, contract, amount);
    const { hash, receipt } = await write(ctx, { address: contract, abi, functionName: "create", args: [seller, amount, deadline, arbiter] });
    const [created] = parseEventLogs({ abi, logs: receipt.logs, eventName: "DealCreated" });
    return { dealId: created?.args.id, txHash: hash, approvalTxHash, seller, arbiter: arbiter === ZERO ? null : arbiter, amount, deadline };
  },

  async get_escrow(input) {
    return readDeal(parseUint("id", input.id));
  },

  async check_escrow_permissions(input) {
    const who = input.who === undefined ? undefined : parseAddress("who", input.who);
    const deal = await readDeal(parseUint("id", input.id), who);
    return { id: deal.id, state: deal.state, ...deal.permissions };
  },

  async release_escrow(input) {
    const id = parseUint("id", input.id);
    const { ctx, contract } = await setup();
    const { hash } = await write(ctx, { address: contract, abi, functionName: "release", args: [id] });
    return { id, txHash: hash, state: (await readDeal(id)).state };
  },

  async refund_escrow(input) {
    const id = parseUint("id", input.id);
    const { ctx, contract } = await setup();
    const { hash } = await write(ctx, { address: contract, abi, functionName: "refund", args: [id] });
    return { id, txHash: hash, state: (await readDeal(id)).state };
  },
};
