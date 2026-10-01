import { createPublicClient, createWalletClient, defineChain, http, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in ../.env (see ../.env.example)`);
  return value;
}

// Reads RPC_URL, CONTRACT_ADDRESS, CHAIN_ID and (for writes) PRIVATE_KEY from ../.env.
// Defaults to Arbitrum Sepolia. Set RPC_URL and CHAIN_ID to target another Arbitrum chain
// (a local dev node is 412346; use Robinhood Chain's values from its docs).
export function connect() {
  const rpc = process.env.RPC_URL ?? arbitrumSepolia.rpcUrls.default.http[0];
  const chainId = Number(process.env.CHAIN_ID ?? arbitrumSepolia.id);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error("CHAIN_ID must be a positive integer");
  const chain =
    chainId === arbitrumSepolia.id
      ? arbitrumSepolia
      : defineChain({
          id: chainId,
          name: `Chain ${chainId}`,
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: { default: { http: [rpc] } },
        });
  const address = need("CONTRACT_ADDRESS");
  if (!isAddress(address)) throw new Error("CONTRACT_ADDRESS is not a valid address");

  const publicClient = createPublicClient({ chain, transport: http(rpc) });

  const key = process.env.PRIVATE_KEY;
  const account = key ? privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex) : undefined;
  const walletClient = account
    ? createWalletClient({ account, chain, transport: http(rpc) })
    : undefined;

  return { publicClient, walletClient, account, address: address as Address };
}

// Waits for a transaction and fails loudly if it reverted (viem returns reverted receipts without throwing).
export async function confirm(publicClient: ReturnType<typeof connect>["publicClient"], hash: Hex, label: string) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted (tx ${hash})`);
  console.log(`${label} confirmed in block ${receipt.blockNumber} (tx ${hash})`);
  return receipt;
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
