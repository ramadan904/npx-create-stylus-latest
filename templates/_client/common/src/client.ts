import { createPublicClient, createWalletClient, http, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in ../.env (see ../.env.example)`);
  return value;
}

// Reads RPC_URL, CONTRACT_ADDRESS and (for writes) PRIVATE_KEY from ../.env.
// The default chain is Arbitrum Sepolia; swap `arbitrumSepolia` for another viem chain
// (or defineChain(...) for Robinhood Chain) to target a different network.
export function connect() {
  const rpc = process.env.RPC_URL ?? arbitrumSepolia.rpcUrls.default.http[0];
  const address = need("CONTRACT_ADDRESS");
  if (!isAddress(address)) throw new Error("CONTRACT_ADDRESS is not a valid address");

  const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(rpc) });

  const key = process.env.PRIVATE_KEY;
  const account = key ? privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex) : undefined;
  const walletClient = account
    ? createWalletClient({ account, chain: arbitrumSepolia, transport: http(rpc) })
    : undefined;

  return { publicClient, walletClient, account, address: address as Address };
}

// Runs a script and prints a one-line error (viem's shortMessage for RPC failures) instead of a stack trace.
export async function run(main: () => Promise<void>) {
  try {
    await main();
  } catch (err) {
    const e = err as { shortMessage?: string; message?: string };
    console.error(`Error: ${e.shortMessage ?? e.message ?? String(err)}`);
    process.exit(1);
  }
}
