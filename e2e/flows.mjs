// Real-money flows against a local Nitro dev node: the actual erc20 template as the token, and the actual stream and
// escrow templates moving it. The contracts' unit tests mock the token; this proves the real cross-contract calls
// (approve -> transferFrom -> transfer) work, balances end up exactly where the rules say, and reverts are atomic.
//
// Env: RPC_URL, CHAIN_ID, E2E_KEY (funded deployer, also the buyer/sender), TOKEN, STREAM, ESCROW.
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const need = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name}`);
  return v;
};
const rpc = need("RPC_URL");
const chain = defineChain({
  id: Number(process.env.CHAIN_ID ?? 412346),
  name: "devnode",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
});
const TOKEN = need("TOKEN");
const STREAM = need("STREAM");
const ESCROW = need("ESCROW");
const ZERO = "0x0000000000000000000000000000000000000000";

const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);
const streamAbi = parseAbi([
  "function streamCount() view returns (uint256)",
  "function stream(uint256 id) view returns (address, address, uint256, uint256, uint256, uint256, uint8)",
  "function streamed(uint256 id) view returns (uint256)",
  "function create(address recipient, uint256 amount, uint256 start, uint256 stop) returns (uint256)",
  "function withdraw(uint256 id) returns (uint256)",
  "function cancel(uint256 id)",
]);
const escrowAbi = parseAbi([
  "function dealCount() view returns (uint256)",
  "function deal(uint256 id) view returns (address, address, address, uint256, uint256, uint8)",
  "function create(address seller, uint256 amount, uint256 deadline, address arbiter) returns (uint256)",
  "function release(uint256 id)",
  "function refund(uint256 id)",
]);

const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = (account) => createWalletClient({ account, chain, transport: http(rpc) });
const deployer = privateKeyToAccount(need("E2E_KEY"));
const seller = privateKeyToAccount(generatePrivateKey()); // also the stream recipient
const stranger = privateKeyToAccount(generatePrivateKey());

let checks = 0;
function check(cond, label) {
  checks++;
  if (!cond) throw new Error(`FAILED: ${label}`);
  console.log(`  ok  ${label}`);
}
function same(actual, expected, label) {
  check(actual === expected, `${label} (got ${actual}, want ${expected})`);
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const nowChain = async () => Number((await pub.getBlock()).timestamp);

// Gas is set explicitly so the node does not call eth_estimateGas first. Estimation simulates against the latest block's
// timestamp, so it cannot see time-dependent behaviour: a stream that started earning since the last block looks empty
// and the call "reverts" before it is ever sent. A sent transaction executes in a fresh block with the real time.
const GAS = 3_000_000n;
async function send(account, address, abi, functionName, args = []) {
  const hash = await wallet(account).writeContract({ address, abi, functionName, args, gas: GAS });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted (tx ${hash})`);
  const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
  return { receipt, time: Number(block.timestamp) };
}

async function expectRevert(label, fn) {
  let reverted = false;
  try {
    await fn();
  } catch {
    reverted = true;
  }
  check(reverted, `${label} is rejected`);
}

const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
const bal = (who) => read(TOKEN, tokenAbi, "balanceOf", [who]);

// Same arithmetic as the contract: linear, rounded down, complete at `stop`.
const earnedAt = (deposit, start, stop, t) =>
  t <= start ? 0n : t >= stop ? deposit : (deposit * BigInt(t - start)) / BigInt(stop - start);

async function main() {
  console.log(`token ${TOKEN}\nstream ${STREAM}\nescrow ${ESCROW}`);
  for (const to of [seller, stranger]) {
    const hash = await wallet(deployer).sendTransaction({ to: to.address, value: parseEther("0.05") });
    await pub.waitForTransactionReceipt({ hash });
  }

  // ---------------------------------------------------------------- streams
  console.log("\nstream: linear payout, keeper withdraw, cancel split");
  await send(deployer, TOKEN, tokenAbi, "approve", [STREAM, 2_000n]);
  const d0 = await bal(deployer.address);
  let t = await nowChain();
  const start1 = t + 12;
  const stop1 = start1 + 40;
  await send(deployer, STREAM, streamAbi, "create", [seller.address, 1_000n, BigInt(start1), BigInt(stop1)]);
  const s1 = await read(STREAM, streamAbi, "streamCount");
  same(s1, 1n, "first stream id");
  same(await bal(deployer.address), d0 - 1_000n, "sender was debited the deposit");
  same(await bal(STREAM), 1_000n, "the contract holds the deposit");
  same(await bal(seller.address), 0n, "recipient has nothing before the stream starts");

  await sleep(start1 + 18 - (await nowChain()));
  console.log(`  (wall clock ${Math.floor(Date.now() / 1000)}, latest block ${await nowChain()}, stream ${start1}..${stop1})`);
  const w = await send(stranger, STREAM, streamAbi, "withdraw", [s1]); // a stranger triggers the payout
  const e1 = earnedAt(1_000n, start1, stop1, w.time);
  check(e1 > 0n && e1 < 1_000n, `mid-stream payout is partial (${e1} of 1000 at t=${w.time - start1}s)`);
  same(await bal(seller.address), e1, "recipient received exactly the earned amount");
  same(await bal(stranger.address), 0n, "the stranger who triggered it received nothing");
  same(await bal(STREAM), 1_000n - e1, "the contract holds the rest");

  await expectRevert("a stranger cancelling", () => send(stranger, STREAM, streamAbi, "cancel", [s1]));
  const c = await send(deployer, STREAM, streamAbi, "cancel", [s1]);
  const e2 = earnedAt(1_000n, start1, stop1, c.time);
  same(await bal(seller.address), e2, "after cancel the recipient has everything earned");
  same(await bal(deployer.address), d0 - e2, "after cancel the sender got the remainder back");
  same(await bal(STREAM), 0n, "the contract is empty after cancel");
  same((await read(STREAM, streamAbi, "stream", [s1]))[6], 2, "stream is marked cancelled");
  await expectRevert("withdrawing from a cancelled stream", () => send(stranger, STREAM, streamAbi, "withdraw", [s1]));
  await expectRevert("cancelling twice", () => send(deployer, STREAM, streamAbi, "cancel", [s1]));

  console.log("\nstream: runs to completion, rounding, atomic revert");
  t = await nowChain();
  const start2 = t + 12;
  const stop2 = start2 + 8;
  await send(deployer, STREAM, streamAbi, "create", [seller.address, 777n, BigInt(start2), BigInt(stop2)]);
  const s2 = await read(STREAM, streamAbi, "streamCount");
  same(s2, 2n, "second stream id");
  await sleep(stop2 + 4 - (await nowChain()));
  await send(stranger, STREAM, streamAbi, "withdraw", [s2]);
  same(await bal(seller.address), e2 + 777n, "a finished stream pays out the exact deposit (no rounding dust)");
  same(await bal(STREAM), 0n, "nothing left in the contract");
  await expectRevert("withdrawing a fully paid stream", () => send(stranger, STREAM, streamAbi, "withdraw", [s2]));

  // The 2000 approved covered 1000 + 777; 223 of allowance remains, so ask for more than that.
  const allowance = await read(TOKEN, tokenAbi, "allowance", [deployer.address, STREAM]);
  same(allowance, 223n, "allowance left after two streams");
  t = await nowChain();
  await expectRevert("a stream larger than the approved allowance", () =>
    send(deployer, STREAM, streamAbi, "create", [seller.address, 500n, BigInt(t + 30), BigInt(t + 90)]),
  );
  same(await read(STREAM, streamAbi, "streamCount"), 2n, "the failed create left no stream behind");
  same(await bal(STREAM), 0n, "the failed create moved no tokens");

  // ----------------------------------------------------------------- escrow
  console.log("\nescrow: release, seller refund, deadline refund, arbiter");
  await send(deployer, TOKEN, tokenAbi, "approve", [ESCROW, 2_000n]);
  const b0 = await bal(deployer.address);
  const s0 = await bal(seller.address);
  t = await nowChain();

  await send(deployer, ESCROW, escrowAbi, "create", [seller.address, 500n, BigInt(t + 600), ZERO]);
  const id1 = await read(ESCROW, escrowAbi, "dealCount");
  same(await bal(ESCROW), 500n, "escrow holds the buyer's tokens");
  await expectRevert("a stranger releasing", () => send(stranger, ESCROW, escrowAbi, "release", [id1]));
  await expectRevert("the seller releasing to themselves", () => send(seller, ESCROW, escrowAbi, "release", [id1]));
  await send(deployer, ESCROW, escrowAbi, "release", [id1]);
  same(await bal(seller.address), s0 + 500n, "release paid the seller");
  same(await bal(ESCROW), 0n, "escrow is empty after release");
  await expectRevert("releasing twice", () => send(deployer, ESCROW, escrowAbi, "release", [id1]));
  await expectRevert("refunding a released deal", () => send(seller, ESCROW, escrowAbi, "refund", [id1]));

  await send(deployer, ESCROW, escrowAbi, "create", [seller.address, 400n, BigInt(t + 600), ZERO]);
  const id2 = await read(ESCROW, escrowAbi, "dealCount");
  await expectRevert("a stranger refunding", () => send(stranger, ESCROW, escrowAbi, "refund", [id2]));
  await expectRevert("the buyer refunding before the deadline", () => send(deployer, ESCROW, escrowAbi, "refund", [id2]));
  await send(seller, ESCROW, escrowAbi, "refund", [id2]);
  same(await bal(deployer.address), b0 - 500n, "the seller's refund returned the buyer's tokens");

  t = await nowChain();
  const deadline = t + 20;
  await send(deployer, ESCROW, escrowAbi, "create", [seller.address, 300n, BigInt(deadline), ZERO]);
  const id3 = await read(ESCROW, escrowAbi, "dealCount");
  await expectRevert("the buyer refunding before the deadline", () => send(deployer, ESCROW, escrowAbi, "refund", [id3]));
  await sleep(deadline + 4 - (await nowChain()));
  await expectRevert("a stranger refunding after the deadline", () => send(stranger, ESCROW, escrowAbi, "refund", [id3]));
  await send(deployer, ESCROW, escrowAbi, "refund", [id3]);
  same(await bal(deployer.address), b0 - 500n, "after the deadline the buyer got a unilateral refund");

  t = await nowChain();
  await send(deployer, ESCROW, escrowAbi, "create", [seller.address, 250n, BigInt(t + 600), stranger.address]);
  const id4 = await read(ESCROW, escrowAbi, "dealCount");
  await send(stranger, ESCROW, escrowAbi, "release", [id4]); // the arbiter decides
  same(await bal(seller.address), s0 + 750n, "the arbiter's release paid the seller");
  same(await bal(ESCROW), 0n, "escrow ends empty");
  same(await bal(deployer.address), b0 - 750n, "buyer is down exactly the two released deals");
  same(await read(ESCROW, escrowAbi, "dealCount"), 4n, "four deals were created");

  console.log(`\nE2E FLOWS PASSED (${checks} checks)`);
}

main().catch((err) => {
  console.error(`\n${err.shortMessage ?? err.message ?? err}`);
  process.exit(1);
});
