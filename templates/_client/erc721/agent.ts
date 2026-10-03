// Agent-native interface to the NFT contract: intents an AI agent can call with JSON. See agent-kit.ts for the
// conventions (decimal-string ids, `{ ok, ... }` results, operator-set safety limits, the contract's own error names).
//
//   npx tsx --env-file=../.env src/agent-cli.ts --tools                                  # tool schemas for an LLM
//   npx tsx --env-file=../.env src/agent-cli.ts '{"intent":"get_nft","tokenId":"1"}'
//   npx tsx --env-file=../.env src/agent-cli.ts '{"intent":"transfer_nft","to":"0x...","tokenId":"1"}'
import { parseAbi, parseEventLogs, zeroAddress } from "viem";
import { connect } from "./client.js";
import { checkCounterparty, IntentError, needWallet, parseAddress, parseUint, policyFromEnv, write, type Handler, type ToolSpec } from "./agent-kit.js";

// Keep in sync with the contract: run `../scripts/export-abi.sh` to see the interface.
const abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function minter() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function mint(address to) returns (uint256)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "error ERC721InvalidOwner(address owner)",
  "error ERC721NonexistentToken(uint256 tokenId)",
  "error ERC721IncorrectOwner(address sender, uint256 tokenId, address owner)",
  "error ERC721InsufficientApproval(address operator, uint256 tokenId)",
  "error ERC721InvalidApprover(address approver)",
  "error ERC721InvalidOperator(address operator)",
  "error ERC721InvalidReceiver(address receiver)",
  "error NotMinter(address caller)",
  "error ZeroAddress()",
]);

export const tools: ToolSpec[] = [
  {
    name: "get_nft",
    description:
      "Read the collection: name, symbol, minter, how many exist, and how many an account (default: the agent's own) holds. " +
      "With `tokenId`, also that token's owner, metadata URI and approved address; an id that does not exist is refused " +
      "as ERC721NonexistentToken.",
    input_schema: {
      type: "object",
      properties: {
        tokenId: { type: "string", description: "Token id to look up, as a decimal string." },
        who: { type: "string", description: "0x address whose balance to read. Default: the agent's own account." },
      },
    },
  },
  {
    name: "mint_nft",
    description:
      "Mint the next token to an account (default: the agent itself). Only the collection's minter may mint: refused " +
      "before signing as NotMinter otherwise. Returns the new token id.",
    input_schema: {
      type: "object",
      properties: { to: { type: "string", description: "0x address to receive the new token. Default: the agent's own account." } },
    },
  },
  {
    name: "transfer_nft",
    description:
      "Send a token the agent owns to another account. Uses the safe transfer, so a contract that cannot hold NFTs is " +
      "refused (ERC721InvalidReceiver) instead of locking the token forever. Refused before signing if the agent does not " +
      "own it, if `to` is the zero address or this contract, or if the operator's allow-list forbids the recipient.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "0x address of the recipient." },
        tokenId: { type: "string", description: "Token id to send, as a decimal string." },
      },
      required: ["to", "tokenId"],
    },
  },
];

export const handlers: Record<string, Handler> = {
  async get_nft(input) {
    const tokenId = input.tokenId === undefined ? undefined : parseUint("tokenId", input.tokenId);
    const who = input.who === undefined ? undefined : parseAddress("who", input.who);
    const ctx = connect();
    const c = { address: ctx.address, abi } as const;
    const account = who ?? ctx.account?.address;
    const [name, symbol, minter, totalSupply, balance] = await Promise.all([
      ctx.publicClient.readContract({ ...c, functionName: "name" }),
      ctx.publicClient.readContract({ ...c, functionName: "symbol" }),
      ctx.publicClient.readContract({ ...c, functionName: "minter" }),
      ctx.publicClient.readContract({ ...c, functionName: "totalSupply" }),
      account ? ctx.publicClient.readContract({ ...c, functionName: "balanceOf", args: [account] }) : undefined,
    ]);
    // ownerOf first: for an id that does not exist it reverts with ERC721NonexistentToken, which the agent gets by name.
    const owner = tokenId === undefined ? undefined : await ctx.publicClient.readContract({ ...c, functionName: "ownerOf", args: [tokenId] });
    const [tokenURI, approved] =
      tokenId === undefined
        ? [undefined, undefined]
        : await Promise.all([
            ctx.publicClient.readContract({ ...c, functionName: "tokenURI", args: [tokenId] }),
            ctx.publicClient.readContract({ ...c, functionName: "getApproved", args: [tokenId] }),
          ]);
    return {
      collection: { address: ctx.address, name, symbol, minter, totalSupply },
      account: account ?? null,
      balance: balance ?? null,
      ...(tokenId === undefined
        ? {}
        : { token: { id: tokenId, owner, tokenURI, approved: approved === zeroAddress ? null : approved, youOwnIt: owner === ctx.account?.address } }),
    };
  },

  async mint_nft(input) {
    const ctx = connect();
    const me = needWallet(ctx).account.address;
    const to = input.to === undefined ? me : parseAddress("to", input.to);
    if (to === zeroAddress) throw new IntentError("InvalidInput", "to is the zero address", { field: "to" });
    if (to !== me) checkCounterparty(policyFromEnv(), "recipient", to);
    const minter = await ctx.publicClient.readContract({ address: ctx.address, abi, functionName: "minter" });
    if (minter !== me) {
      throw new IntentError("NotMinter", `only the minter (${minter}) may mint; the agent is ${me}`, { minter, agent: me });
    }
    const { hash, receipt } = await write(ctx, { address: ctx.address, abi, functionName: "mint", args: [to] });
    const [event] = parseEventLogs({ abi, logs: receipt.logs, eventName: "Transfer" });
    if (!event) throw new IntentError("Failed", `mint ${hash} succeeded but emitted no Transfer event`, { txHash: hash });
    return { txHash: hash, tokenId: event.args.tokenId, to };
  },

  async transfer_nft(input) {
    const to = parseAddress("to", input.to);
    const tokenId = parseUint("tokenId", input.tokenId);
    if (to === zeroAddress) throw new IntentError("InvalidInput", "to is the zero address: a token sent there is lost", { field: "to" });
    const ctx = connect();
    if (to.toLowerCase() === ctx.address.toLowerCase()) {
      throw new IntentError("InvalidInput", "to is this NFT contract itself: a token sent there is lost", { field: "to" });
    }
    checkCounterparty(policyFromEnv(), "recipient", to);
    const me = needWallet(ctx).account.address;
    // Checked here so the agent learns the owner without paying for a failed transaction; the contract enforces it too.
    const owner = await ctx.publicClient.readContract({ address: ctx.address, abi, functionName: "ownerOf", args: [tokenId] });
    if (owner !== me) {
      throw new IntentError("ERC721IncorrectOwner", `token ${tokenId} belongs to ${owner}, not the agent (${me})`, {
        tokenId: tokenId.toString(),
        owner,
      });
    }
    const { hash } = await write(ctx, { address: ctx.address, abi, functionName: "safeTransferFrom", args: [me, to, tokenId] });
    const ownerNow = await ctx.publicClient.readContract({ address: ctx.address, abi, functionName: "ownerOf", args: [tokenId] });
    return { txHash: hash, tokenId, from: me, to, ownerNow };
  },
};
