// Agent-native interface to the stream contract: five intents an AI agent can call with JSON. See agent-kit.ts for the
// conventions (decimal-string amounts, `{ ok, ... }` results, operator-set safety limits).
//
//   npx tsx --env-file=../.env src/agent-cli.ts --tools                                   # tool schemas for an LLM
//   npx tsx --env-file=../.env src/agent-cli.ts '{"intent":"open_stream","recipient":"0x...","amount":"1000000","durationSeconds":3600}'
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
  "function stream(uint256 id) view returns (address, address, uint256, uint256, uint256, uint256, uint8)",
  "function streamed(uint256 id) view returns (uint256)",
  "function withdrawable(uint256 id) view returns (uint256)",
  "function previewCancel(uint256 id) view returns (uint256, uint256)",
  "function create(address recipient, uint256 amount, uint256 start, uint256 stop) returns (uint256)",
  "function withdraw(uint256 id) returns (uint256)",
  "function cancel(uint256 id)",
  "event Withdrawn(uint256 indexed id, address indexed recipient, uint256 amount)",
  "event Cancelled(uint256 indexed id, uint256 toRecipient, uint256 toSender)",
  "event StreamCreated(uint256 indexed id, address indexed sender, address indexed recipient, uint256 amount, uint256 start, uint256 stop)",
  "error NothingToWithdraw(uint256 id)",
  "error NoSuchStream(uint256 id)",
  "error NotActive(uint256 id)",
  "error NotAuthorized()",
  "error StartInPast(uint256 start, uint256 now)",
  "error BadTimeRange(uint256 start, uint256 stop)",
  "error TokenTransferFailed()",
]);

const STATES = ["unknown", "active", "cancelled"] as const;
const idSchema = { type: ["string", "integer"], description: "The stream id (a decimal string or integer)." };

export const tools: ToolSpec[] = [
  {
    name: "open_stream",
    description:
      "Start paying `recipient` continuously, second by second, from funds locked now. The agent's tokens are locked in the contract; " +
      "the recipient can withdraw what has been earned at any time, and either side can cancel (the rest returns to the sender).",
    input_schema: {
      type: "object",
      properties: {
        recipient: { type: "string", description: "0x address that receives the stream." },
        amount: { type: "string", description: "Total to stream, in the token's base units, as a decimal string (e.g. \"1000000\" = 1 USDC)." },
        durationSeconds: { type: "integer", minimum: 1, description: "How long the stream runs." },
        startInSeconds: { type: "integer", minimum: 0, description: "Delay before it starts earning. Default 10 (covers block time)." },
      },
      required: ["recipient", "amount", "durationSeconds"],
    },
  },
  {
    name: "get_stream",
    description: "Read a stream: who pays whom, the schedule, how much has been earned and withdrawn, and what cancelling would pay each side.",
    input_schema: { type: "object", properties: { id: idSchema }, required: ["id"] },
  },
  {
    name: "withdraw_from_stream",
    description: "Pay the recipient everything earned and not yet withdrawn. Anyone may call it; the tokens always go to the recipient.",
    input_schema: { type: "object", properties: { id: idSchema }, required: ["id"] },
  },
  {
    name: "preview_cancel_stream",
    description: "Show exactly what cancelling the stream right now would pay the recipient and refund to the sender, without sending anything.",
    input_schema: { type: "object", properties: { id: idSchema }, required: ["id"] },
  },
  {
    name: "cancel_stream",
    description: "Stop the stream. The recipient receives what is earned and not yet withdrawn; the sender gets the rest back. Only the sender or the recipient can do this.",
    input_schema: { type: "object", properties: { id: idSchema }, required: ["id"] },
  },
];

async function setup() {
  const ctx = connect();
  const token = await ctx.publicClient.readContract({ address: ctx.address, abi, functionName: "token" });
  return { ctx, token, contract: ctx.address };
}

async function readStream(id: bigint) {
  const { ctx, contract } = await setup();
  const read = <T extends "stream" | "streamed" | "withdrawable" | "previewCancel">(functionName: T) =>
    ctx.publicClient.readContract({ address: contract, abi, functionName, args: [id] } as never) as Promise<never>;
  const [sender, recipient, deposit, start, stop, withdrawn, state] = (await read("stream")) as unknown as [Address, Address, bigint, bigint, bigint, bigint, number];
  const [streamed, withdrawable, preview] = (await Promise.all([read("streamed"), read("withdrawable"), read("previewCancel")])) as unknown as [bigint, bigint, [bigint, bigint]];
  return {
    id,
    state: STATES[state] ?? String(state),
    sender,
    recipient,
    deposit,
    start,
    stop,
    withdrawn,
    streamed,
    withdrawable,
    cancelPreview: { toRecipient: preview[0], toSender: preview[1] },
    youAre: ctx.account ? (ctx.account.address === sender ? "sender" : ctx.account.address === recipient ? "recipient" : "neither") : "read-only",
  };
}

export const handlers: Record<string, Handler> = {
  async open_stream(input) {
    const policy = policyFromEnv();
    const recipient = parseAddress("recipient", input.recipient);
    const amount = parseUint("amount", input.amount);
    const duration = parseUint("durationSeconds", input.durationSeconds);
    const startIn = input.startInSeconds === undefined ? 10n : parseUint("startInSeconds", input.startInSeconds);
    checkAmount(policy, amount);
    checkCounterparty(policy, "recipient", recipient);

    const { ctx, token, contract } = await setup();
    const start = BigInt(await chainNow(ctx)) + startIn;
    const stop = start + duration;
    const approvalTxHash = await ensureFunds(ctx, token, contract, amount);
    const { hash, receipt } = await write(ctx, { address: contract, abi, functionName: "create", args: [recipient, amount, start, stop] });
    const [created] = parseEventLogs({ abi, logs: receipt.logs, eventName: "StreamCreated" });
    return { streamId: created?.args.id, txHash: hash, approvalTxHash, recipient, amount, start, stop, ratePerSecond: amount / duration };
  },

  async get_stream(input) {
    return readStream(parseUint("id", input.id));
  },

  async preview_cancel_stream(input) {
    const s = await readStream(parseUint("id", input.id));
    return { id: s.id, state: s.state, toRecipient: s.cancelPreview.toRecipient, toSender: s.cancelPreview.toSender };
  },

  async withdraw_from_stream(input) {
    const id = parseUint("id", input.id);
    const { ctx, contract } = await setup();
    const { hash, receipt } = await write(ctx, { address: contract, abi, functionName: "withdraw", args: [id] });
    const [event] = parseEventLogs({ abi, logs: receipt.logs, eventName: "Withdrawn" });
    return { id, txHash: hash, paidToRecipient: event?.args.amount, stream: await readStream(id) };
  },

  async cancel_stream(input) {
    const id = parseUint("id", input.id);
    const { ctx, contract } = await setup();
    const { hash, receipt } = await write(ctx, { address: contract, abi, functionName: "cancel", args: [id] });
    // The exact split comes from the contract's own event, not from a preview taken before the transaction ran.
    const [event] = parseEventLogs({ abi, logs: receipt.logs, eventName: "Cancelled" });
    return { id, txHash: hash, paidToRecipient: event?.args.toRecipient, refundedToSender: event?.args.toSender };
  },
};
