// Networks a project can be scaffolded for. Written into the generated .env.example; deploy.sh and the client read them.
//
// USDG addresses are Paxos's own, from https://docs.paxos.com/guides/stablecoin/usdg/mainnet. Paxos publishes USDG on
// test networks only for Ethereum Sepolia, Ink Sepolia and X Layer testnet
// (https://docs.paxos.com/guides/stablecoin/usdg/testnet), so neither Arbitrum Sepolia nor Robinhood Chain testnet has an
// official USDG: there `usdg` is null and the project says so instead of guessing. CI (e2e/verify-networks.mjs) checks
// every entry on-chain: the RPC's chain id, and that each USDG address holds a contract reporting symbol USDG and 6 decimals.
export const NETWORKS = {
  "arbitrum-sepolia": {
    label: "Arbitrum Sepolia (testnet)",
    chainId: 421614,
    rpc: "https://sepolia-rollup.arbitrum.io/rpc",
    explorer: "https://sepolia.arbiscan.io",
    mainnet: false,
    usdg: null,
  },
  "arbitrum-one": {
    label: "Arbitrum One (mainnet)",
    chainId: 42161,
    rpc: "https://arb1.arbitrum.io/rpc",
    explorer: "https://arbiscan.io",
    mainnet: true,
    usdg: "0x004B506865409877C9fA29bfb1ebA929984B9bbC",
  },
  "robinhood-testnet": {
    label: "Robinhood Chain testnet",
    chainId: 46630,
    rpc: "https://rpc.testnet.chain.robinhood.com/rpc",
    explorer: "https://explorer.testnet.chain.robinhood.com",
    mainnet: false,
    usdg: null,
  },
  robinhood: {
    label: "Robinhood Chain (mainnet)",
    chainId: 4663,
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://explorer.chain.robinhood.com",
    mainnet: true,
    usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  },
  devnode: {
    label: "local Nitro dev node (./scripts/devnode.sh)",
    chainId: 412346,
    rpc: "http://localhost:8547",
    explorer: null,
    mainnet: false,
    usdg: null,
  },
};

export const DEFAULT_NETWORK = "arbitrum-sepolia";

/** USDG has 6 decimals on every network Paxos lists: 1 USDG = 1000000 base units. */
export const USDG_DECIMALS = 6;

/** Templates whose constructor takes the ERC-20 they move as the first argument, so `--usdg` can point them at USDG. */
export const TOKEN_TEMPLATES = ["vault", "escrow", "stream"];

export function resolveNetwork(name) {
  const network = NETWORKS[name];
  if (!network) throw new Error(`Unknown network "${name}". Available: ${Object.keys(NETWORKS).join(", ")}`);
  return { name, ...network };
}

/** The network block of the generated .env.example. */
export function envBlock(network, { usdg = false } = {}) {
  const lines = [`# ${network.label}. Change both lines together to target another Arbitrum chain.`];
  if (network.mainnet) {
    lines.push("# MAINNET: real money. The templates are unaudited; deploy.sh refuses unless you set MAINNET=1.");
  }
  if (network.name === "robinhood-testnet") {
    lines.push("# If the public RPC refuses `cargo stylus check`, use an Alchemy URL for Robinhood Chain testnet instead.");
  }
  lines.push(`RPC_URL=${network.rpc}`, "", "# Chain id of RPC_URL. deploy.sh checks the RPC agrees; the client uses it.", `CHAIN_ID=${network.chainId}`);
  if (usdg) {
    lines.push("", "# The token this contract moves. Deploy with: ./scripts/deploy.sh -- env:TOKEN_ADDRESS");
    if (network.usdg) {
      lines.push(`# Paxos USDG on ${network.label}, from docs.paxos.com. 6 decimals: 1 USDG = 1000000.`, `TOKEN_ADDRESS=${network.usdg}`);
    } else {
      lines.push(
        `# Paxos publishes no USDG on ${network.label}. Use a stand-in: deploy the erc20 template (18 decimals) or any ERC-20`,
        "# you hold here, and put its address below. The contract works with any decimals; amounts are base units.",
        "TOKEN_ADDRESS=",
      );
    }
  }
  return lines.join("\n");
}
