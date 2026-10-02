// Checks src/networks.js against the chains themselves, so no address in the CLI rests on someone's memory:
//   - each public RPC answers with the chain id the table claims;
//   - each USDG address is correctly checksummed, holds a contract, and that contract reports symbol USDG and 6 decimals.
// Run in CI (the `networks` job). Exits non-zero on any mismatch. The local dev node is skipped.
import { createPublicClient, defineChain, getAddress, http, parseAbi } from "viem";
import { NETWORKS, USDG_DECIMALS } from "../src/networks.js";

const erc20 = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function name() view returns (string)"]);
let failures = 0;
let checks = 0;
const ok = (label) => (checks++, console.log(`  ok  ${label}`));
const fail = (label) => (checks++, failures++, console.log(`  FAIL ${label}`));

// Public endpoints rate-limit; retry a few times before calling a network unreachable.
async function retry(fn, label) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  throw new Error(`${label}: ${last?.shortMessage ?? last?.message ?? last}`);
}

for (const [name, n] of Object.entries(NETWORKS)) {
  if (name === "devnode") continue;
  console.log(`\n${name} (${n.label})`);
  const chain = defineChain({ id: n.chainId, name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [n.rpc] } } });
  const client = createPublicClient({ chain, transport: http(n.rpc, { timeout: 15_000 }) });
  try {
    const id = await retry(() => client.getChainId(), `${n.rpc} eth_chainId`);
    id === n.chainId ? ok(`${n.rpc} is chain ${id}`) : fail(`${n.rpc} is chain ${id}, the table says ${n.chainId}`);
  } catch (err) {
    fail(err.message);
    continue;
  }
  if (!n.usdg) {
    console.log("  --  no USDG listed (Paxos publishes none here)");
    continue;
  }
  getAddress(n.usdg) === n.usdg ? ok(`USDG ${n.usdg} has a valid EIP-55 checksum`) : fail(`USDG ${n.usdg} checksum is wrong`);
  try {
    const code = await retry(() => client.getCode({ address: n.usdg }), "eth_getCode");
    code && code !== "0x" ? ok(`a contract is deployed at ${n.usdg}`) : fail(`no contract at ${n.usdg}`);
    const [symbol, decimals, tokenName] = await retry(
      () => Promise.all(["symbol", "decimals", "name"].map((functionName) => client.readContract({ address: n.usdg, abi: erc20, functionName }))),
      "token metadata",
    );
    symbol === "USDG" ? ok(`symbol() is USDG (name "${tokenName}")`) : fail(`symbol() is ${symbol}, expected USDG`);
    decimals === USDG_DECIMALS ? ok(`decimals() is ${decimals}`) : fail(`decimals() is ${decimals}, expected ${USDG_DECIMALS}`);
  } catch (err) {
    fail(err.message);
  }
}

console.log(failures === 0 ? `\nNETWORKS VERIFIED (${checks} checks)` : `\n${failures} of ${checks} checks FAILED`);
process.exit(failures === 0 ? 0 : 1);
