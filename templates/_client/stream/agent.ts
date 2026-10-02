// Agent-native interface to the stream contract: six intents an AI agent can call with JSON. See agent-kit.ts for the
// conventions (decimal-string amounts, `{ ok, ... }` results, operator-set safety limits).
//
//   npx tsx --env-file=../.env src/agent-cli.ts --tools                                   # tool schemas for an LLM
//   npx tsx --env-file=../.env src/agent-cli.ts '{"intent":"open_stream","recipient":"0x...","amountTokens":"25","durationSeconds":3600}'
import { parseAbi, parseEventLogs, type Address } from "viem";
import { connect } from "./client.js";
import {
  amountSchema,
  chainNow,
  checkAmount,
  checkCounterparty,
  ensureFunds,
  formatTokens,
  IntentError,
  parseAddress,
  parseAmount,
  parseUint,
  policyFromEnv,
  tokenInfo,
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
  "function claimable(address who) view returns (uint256)",
  "function claim() returns (uint256)",
  "event Withdrawn(uint256 indexed id, address indexed recipient, uint256 amount)",
  "event Cancelled(uint256 indexed id, uint256 toRecipient, uint256 toSender)",
  "event PaymentHeld(address indexed to, uint256 amount)",
  "event Claimed(address indexed to, uint256 amount)",
  "event StreamCreated(uint256 indexed id, address indexed sender, address indexed recipient, uint256 amount, uint256 start, uint256 stop)",
  "error NothingToWithdraw(uint256 id)",
  "error NothingToClaim()",
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
        ...amountSchema("Total to stream"),
        durationSeconds: { type: "integer", minimum: 1, description: "How long the stream runs." },
        startInSeconds: { type: "integer", minimum: 0, description: "Delay before it starts earning. Default 10 (covers block time)." },
      },
      required: ["recipient", "durationSeconds"],
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
    description:
      "Stop the stream. The recipient receives what is earned and not yet withdrawn; the sender gets the rest back. Only the sender or the recipient can do this. " +
      "If the token refuses to pay one side (for example a blocked address), that share is held in the contract for them to claim later; the result lists it under `held`.",
    input_schema: { type: "object", properties: { id: idSchema }, required: ["id"] },
  },
  {
    name: "claim_held_payment",
    description:
      "Collect tokens the contract is holding for the agent's own account because the token refused a payout when a stream was cancelled. " +
      "Set `checkOnly` to just read how much is held, for the agent or for any `who`, without sending anything.",
    input_schema: {
      type: "object",
      properties: {
        checkOnly: { type: "boolean", description: "Only report the held amount; send nothing. Default false." },
        who: { type: "string", description: "With checkOnly: the 0x address to check. Default: the agent's own address." },
      },
    },
  },
];

async function setup() {
  const ctx = connect();
  const address = await ctx.publicClient.readContract({ address: ctx.address, abi, functionName: "token" });
  return { ctx, token: await tokenInfo(ctx, address), contract: ctx.address };
}

async function readStream(id: bigint) {
  const { ctx, contract, token } = await setup();
  const read = <T extends "stream" | "streamed" | "withdrawable" | "previewCancel">(functionName: T) =>
    ctx.publicClient.readContract({ address: contract, abi, functionName, args: [id] } as never) as Promise<never>;
  const [sender, recipient, deposit, start, stop, withdrawn, state] = (await read("stream")) as unknown as [Address, Address, bigint, bigint, bigint, bigint, number];
  const [streamed, withdrawable, preview] = (await Promise.all([read("streamed"), read("withdrawable"), read("previewCancel")])) as unknown as [bigint, bigint, [bigint, bigint]];
  const held = (who: Address) => ctx.publicClient.readContract({ address: contract, abi, functionName: "claimable", args: [who] });
  const [heldForSender, heldForRecipient] = await Promise.all([held(sender), held(recipient)]);
  return {
    id,
    state: STATES[state] ?? String(state),
    token,
    depositTokens: formatTokens(deposit, token),
    sender,
    recipient,
    deposit,
    start,
    stop,
    withdrawn,
    streamed,
    withdrawable,
    cancelPreview: { toRecipient: preview[0], toSender: preview[1] },
    // Held for each party across all their streams, from payouts the token refused (see claim_held_payment).
    heldForClaim: { sender: heldForSender, recipient: heldForRecipient },
    youAre: ctx.account ? (ctx.account.address === sender ? "sender" : ctx.account.address === recipient ? "recipient" : "neither") : "read-only",
  };
}

export const handlers: Record<string, Handler> = {
  async open_stream(input) {
    const policy = policyFromEnv();
    const recipient = parseAddress("recipient", input.recipient);
    const duration = parseUint("durationSeconds", input.durationSeconds);
    const startIn = input.startInSeconds === undefined ? 10n : parseUint("startInSeconds", input.startInSeconds);
    checkCounterparty(policy, "recipient", recipient);

    const { ctx, token, contract } = await setup();
    const amount = parseAmount(input, token);
    checkAmount(policy, amount);
    // Approve first, then fix the start: a slow approval cannot eat into startInSeconds and make the start land in the past.
    const approvalTxHash = await ensureFunds(ctx, token.address, contract, amount);
    const start = BigInt(await chainNow(ctx)) + startIn;
    const stop = start + duration;
    const { hash, receipt } = await write(ctx, { address: contract, abi, functionName: "create", args: [recipient, amount, start, stop] });
    const [created] = parseEventLogs({ abi, logs: receipt.logs, eventName: "StreamCreated" });
    return {
      streamId: created?.args.id,
      txHash: hash,
      approvalTxHash,
      recipient,
      amount,
      amountTokens: formatTokens(amount, token),
      start,
      stop,
      ratePerSecond: amount / duration,
    };
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
    // A share the token refused to send is held for its owner instead; it is still theirs, collected with claim_held_payment.
    const held = parseEventLogs({ abi, logs: receipt.logs, eventName: "PaymentHeld" }).map((e) => ({ to: e.args.to, amount: e.args.amount }));
    return { id, txHash: hash, paidToRecipient: event?.args.toRecipient, refundedToSender: event?.args.toSender, held };
  },

  async claim_held_payment(input) {
    if (input.checkOnly !== true && input.who !== undefined) {
      throw new IntentError("InvalidInput", "claim always pays the caller; `who` is only for checkOnly");
    }
    const { ctx, contract } = await setup();
    if (input.checkOnly === true) {
      const who = input.who !== undefined ? parseAddress("who", input.who) : ctx.account?.address;
      if (!who) throw new IntentError("InvalidInput", "Without PRIVATE_KEY there is no own address: pass `who`");
      return { who, claimable: await ctx.publicClient.readContract({ address: contract, abi, functionName: "claimable", args: [who] }) };
    }
    const { hash, receipt } = await write(ctx, { address: contract, abi, functionName: "claim" });
    const [event] = parseEventLogs({ abi, logs: receipt.logs, eventName: "Claimed" });
    return { txHash: hash, claimed: event?.args.amount, to: event?.args.to };
  },
};
