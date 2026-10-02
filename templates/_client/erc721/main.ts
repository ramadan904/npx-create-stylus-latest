import { isAddress, parseAbi, parseEventLogs } from "viem";
import { confirm, connect, run } from "./client.js";

// Keep in sync with the contract: run `../scripts/export-abi.sh` to see the interface.
const abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function minter() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function mint(address to) returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

await run(async () => {
  const { publicClient, walletClient, account, address } = connect();
  const read = <T extends "name" | "symbol" | "minter" | "totalSupply">(functionName: T) =>
    publicClient.readContract({ address, abi, functionName });

  const name = await read("name");
  if (name === "") {
    // The constructor sets the name at deploy time, so an empty name means this is not our NFT contract.
    throw new Error("name() is empty: check CONTRACT_ADDRESS, and that you deployed with constructor arguments");
  }
  console.log(`${name} (${await read("symbol")}), ${await read("totalSupply")} minted and not burned`);
  if (account) {
    console.log("you own:", await publicClient.readContract({ address, abi, functionName: "balanceOf", args: [account.address] }));
  }

  // Optional: MINT_TO=0x... mints the next token to that address (only the minter can).
  const to = process.env.MINT_TO;
  if (to) {
    if (!isAddress(to)) throw new Error("MINT_TO is not a valid address");
    if (!walletClient || !account) throw new Error("Set PRIVATE_KEY in ../.env (the minter's key) to mint");
    const minter = await read("minter");
    if (minter.toLowerCase() !== account.address.toLowerCase()) throw new Error(`only the minter (${minter}) can mint`);
    const hash = await walletClient.writeContract({ address, abi, functionName: "mint", args: [to] });
    const receipt = await confirm(publicClient, hash, "mint()");
    const [minted] = parseEventLogs({ abi, logs: receipt.logs, eventName: "Transfer" });
    const id = minted?.args.tokenId;
    if (id === undefined) throw new Error("mint() confirmed but emitted no Transfer event");
    console.log(`minted #${id} to`, await publicClient.readContract({ address, abi, functionName: "ownerOf", args: [id], blockNumber: receipt.blockNumber }));
    console.log("tokenURI:", await publicClient.readContract({ address, abi, functionName: "tokenURI", args: [id], blockNumber: receipt.blockNumber }) || "(no base URI)");
  }
});
