export const TEMPLATES = {
  counter: "Minimal storage contract with unit tests (best first step)",
  erc20: "ERC-20 token with events, custom errors and tests",
  erc721: "ERC-721 NFT with metadata, safe transfers, a minter and property tests",
  vault: "Stablecoin vault (USDC/USDG): deposit/withdraw via cross-contract ERC-20 calls",
  escrow: "Stablecoin escrow with optional arbiter and a buyer-side timeout refund (agent-to-agent payments)",
  stream: "Stablecoin payment streams: linear per-second payouts with withdraw and cancel (payroll, agent subscriptions)",
  interop: "Rust math called from Solidity: a Stylus library and a Solidity contract that uses it, errors included",
  oracle: "Chainlink price-feed consumer: refuses stale, zero or incomplete prices; values amounts in USD (payments, agents)",
  faucet: "Rate-limited ERC-20 faucet for testnets and demos (anyone can drip once per cooldown)",
};

export const DEFAULT_TEMPLATE = "counter";

// Templates that ship an AI-agent interface (tool schemas + JSON intents) in their client; see templates/_client/_agent.
export const AGENT_TEMPLATES = ["stream", "escrow", "vault", "faucet"];
