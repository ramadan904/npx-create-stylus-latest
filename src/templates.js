export const TEMPLATES = {
  counter: "Minimal storage contract with unit tests (best first step)",
  erc20: "ERC-20 token with events, custom errors and tests",
  vault: "Stablecoin vault (USDC/USDG): deposit/withdraw via cross-contract ERC-20 calls",
  escrow: "Stablecoin escrow with optional arbiter and a buyer-side timeout refund (agent-to-agent payments)",
  stream: "Stablecoin payment streams: linear per-second payouts with withdraw and cancel (payroll, agent subscriptions)",
};

export const DEFAULT_TEMPLATE = "counter";
