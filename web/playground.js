// The playground: try the faucet, stream, escrow and vault contracts on Arbitrum Sepolia from the browser.
//
// No build step and no dependencies, like the rest of the page. Selectors, event topics and the custom-error table come
// from abi.js (generated from the templates by e2e/gen-web-abi.mjs). Wallet connection, eth_call, receipt polling and the
// small DOM helpers (connect, account, waitReceipt, explain, el, setMsg, short, units) come from the inline script in
// index.html, which loads first.
"use strict";

const PG = {
  token: "0xe4d2350d1dfd8474053a4d131e94056bdd93bb83", // Buildathon Token (BUIDL), 18 decimals
  stream: "0xa97f7f79dd79b6c72c8daa452f68baf1ca7bade5",
  escrow: "0x5c3766164e3a2d4abb61f605879c18234b36a60e",
  vault: "0xddcf208635bfdce4379a2535f228473310995915",
  faucet: "0x05bdd4d122896a638f7ff41ed58c7d90a84142d8", // the faucet template: 100 BUIDL per drip, hourly
};
const DECIMALS = 18;
const SYMBOL = "BUIDL";
const DEMO_PAYEE = "0x000000000000000000000000000000000000dEaD"; // a stream or deal needs someone other than you
const STREAM_STATES = ["unknown", "active", "cancelled"];
const DEAL_STATES = ["unknown", "funded", "released", "refunded"];

// ---- ABI encoding and decoding (static types only, which is all these contracts use) -------------------------------
const word = (hex) => hex.replace(/^0x/, "").padStart(64, "0");
const encUint = (n) => word(BigInt(n).toString(16));
const encAddr = (a) => word(a.toLowerCase());
const callData = (selector, ...words) => selector + words.join("");
const words = (hex) => (hex.replace(/^0x/, "").match(/.{64}/g) || []);
const asUint = (w) => BigInt("0x" + w);
const asAddr = (w) => "0x" + w.slice(24);
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** "12.5" -> 12500000000000000000n (18 decimals). Rejects anything that is not a plain positive decimal. */
function parseAmount(text) {
  const t = String(text).trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error("Enter an amount like 10 or 2.5");
  const [whole, frac = ""] = t.split(".");
  if (frac.length > DECIMALS) throw new Error(`At most ${DECIMALS} decimal places`);
  const value = BigInt(whole) * 10n ** BigInt(DECIMALS) + BigInt((frac + "0".repeat(DECIMALS)).slice(0, DECIMALS));
  if (value === 0n) throw new Error("The amount must be more than zero");
  return value;
}
const fmt = (v) => units(v, DECIMALS) + " " + SYMBOL;

// ---- chain access -----------------------------------------------------------------------------------------------------
const eth = (method, params) => window.ethereum.request({ method, params });

/** eth_call through the wallet once connected (the same node that will send our transactions, so reads are consistent
 *  with them), else the public RPC. */
async function read(to, data) {
  if (account && window.ethereum) return eth("eth_call", [{ to, data }, "latest"]);
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }) });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}
const readUint = async (to, data) => asUint(word(await read(to, data)));

async function chainNow() {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }) });
  const block = (await res.json()).result;
  return Math.max(Math.floor(Date.now() / 1000), parseInt(block.timestamp, 16));
}

// ---- errors: turn a revert into a sentence, using the contracts' own custom errors ---------------------------------------
const HINTS = {
  TooSoon: (a) => `The faucet gives each address one drip per cooldown. Try again at ${new Date(Number(a.availableAt) * 1000).toLocaleTimeString()}.`,
  TokenTransferFailed: () => `The token transfer failed. Check your ${SYMBOL} balance (or the faucet's, if you were dripping).`,
  InsufficientBalance: (a) => `Not enough ${SYMBOL}: you have ${fmt(a.have)}, this needs ${fmt(a.want)}. Use the faucet first.`,
  InsufficientAllowance: () => "The contract was not allowed to take that much. Try again: the page approves it first.",
  InsufficientDeposit: (a) => `You only have ${fmt(a.have)} in the vault.`,
  NotAuthorized: () => "Your address is not allowed to do this right now (see the rules under the buttons).",
  NothingToWithdraw: () => "Nothing new has been earned since the last withdrawal. Wait a few seconds.",
  NotActive: () => "This stream was already cancelled.",
  NotFunded: () => "This deal was already released or refunded.",
  NoSuchStream: () => "There is no stream with that id.",
  NoSuchDeal: () => "There is no deal with that id.",
  StartInPast: () => "The confirmation took longer than the start delay. Try again and confirm a little faster.",
  DeadlineInPast: () => "The deadline had already passed when the transaction ran. Pick a later one.",
  SelfStream: () => "You cannot stream to yourself. Use another address as the recipient.",
  SelfDeal: () => "You cannot be your own seller. Use another address.",
  ZeroAmount: () => "The amount must be more than zero.",
  ZeroAddress: () => "That address is the zero address.",
};

function findRevertData(err, depth = 0) {
  if (!err || depth > 5) return null;
  if (typeof err === "string") return /^0x[0-9a-fA-F]{8}/.test(err) ? err : null;
  if (typeof err !== "object") return null;
  for (const key of ["data", "error", "originalError", "cause"]) {
    const found = findRevertData(err[key], depth + 1);
    if (found) return found;
  }
  const m = /(0x[0-9a-fA-F]{8}[0-9a-fA-F]*)/.exec(String(err.message || ""));
  return m && m[1].length >= 10 && ABI.errors[m[1].slice(0, 10)] ? m[1] : null;
}

function describe(err) {
  const data = findRevertData(err);
  const spec = data && ABI.errors[data.slice(0, 10).toLowerCase()];
  if (spec) {
    const w = words(data.slice(10));
    const args = Object.fromEntries(spec.names.map((n, i) => [n, spec.types[i] === "address" ? asAddr(w[i] || "") : asUint(w[i] || "0")]));
    return (HINTS[spec.name] ? HINTS[spec.name](args) : "") + ` (${spec.name})`;
  }
  return explain(err);
}

// ---- transactions -------------------------------------------------------------------------------------------------------
const activity = () => document.getElementById("pg-activity");
function logTx(label, hash, state) {
  document.getElementById("pg-activity-empty")?.remove();
  const li = document.getElementById("tx-" + hash) || el("li", { id: "tx-" + hash });
  li.replaceChildren(document.createTextNode(`${label}: ${state} `), el("a", { href: SCAN + "tx/" + hash, target: "_blank", rel: "noopener" }, "view"));
  activity().prepend(li);
}

/** Sends one transaction and waits for it. Gas is twice the estimate: what a call does can change by the block it lands
 *  in (a stream that earned a little more pays out more), and running out of gas still costs gas. Only gas used is
 *  charged. An estimate that reverts is shown as the contract's own error before you are asked to sign anything. */
async function send(to, data, label) {
  if (!account) await connect();
  let estimate;
  try {
    estimate = BigInt(await eth("eth_estimateGas", [{ from: account, to, data }]));
  } catch (err) {
    throw new Error(describe(err));
  }
  const hash = await eth("eth_sendTransaction", [{ from: account, to, data, gas: "0x" + (estimate * 2n).toString(16) }]);
  logTx(label, hash, "sent");
  const receipt = await waitReceipt(hash);
  if (receipt.status !== "0x1") { logTx(label, hash, "reverted"); throw new Error(label + " reverted on-chain."); }
  logTx(label, hash, "confirmed");
  return receipt;
}

/** Lets `spender` take `amount` of the token from you, approving exactly that amount (never unlimited) when needed. */
async function ensureAllowance(spender, amount, msg) {
  const have = await readUint(PG.token, callData(ABI.sel.token.allowance, encAddr(account), encAddr(spender)));
  if (have >= amount) return;
  setMsg(msg, `Step 1 of 2: approve ${fmt(amount)} in your wallet…`);
  await send(PG.token, callData(ABI.sel.token.approve, encAddr(spender), encUint(amount)), "Approve " + fmt(amount));
}

/** Runs a button's action with consistent busy / success / error handling. */
async function run(button, msg, action) {
  button.disabled = true;
  try {
    if (!account) await connect();
    setMsg(msg, "Confirm in your wallet…");
    const text = await action();
    setMsg(msg, text || "Done.", "ok");
  } catch (err) {
    setMsg(msg, err && err.code === 4001 ? "Cancelled in your wallet." : (err.message || String(err)), "bad");
  } finally {
    button.disabled = false;
    refreshAll();
  }
}

const idFromLogs = (receipt, address, topic) => {
  const log = receipt.logs.find((l) => same(l.address, address) && l.topics[0] === topic);
  return log ? BigInt(log.topics[1]) : null;
};

// Remembers the streams and deals you made in this browser so they survive a reload. Optional: works without storage.
const memory = {
  get(key) { try { return JSON.parse(localStorage.getItem("pg." + key) || "null"); } catch { return null; } },
  set(key, value) { try { localStorage.setItem("pg." + key, JSON.stringify(value)); } catch {} },
};

// ---- panels -------------------------------------------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

async function refreshBalances() {
  if (account) $("pg-balance").textContent = fmt(await readUint(PG.token, callData(ABI.sel.token.balanceOf, encAddr(account))));
  if (!PG.faucet) return;
  const [held, amount, availableAt] = await Promise.all([
    readUint(PG.token, callData(ABI.sel.token.balanceOf, encAddr(PG.faucet))),
    readUint(PG.faucet, ABI.sel.faucet.amount),
    account ? readUint(PG.faucet, callData(ABI.sel.faucet.availableAt, encAddr(account))) : Promise.resolve(0n),
  ]);
  $("pg-faucet-held").textContent = fmt(held);
  $("pg-drip").textContent = `Get ${units(amount, DECIMALS)} ${SYMBOL}`;
  const wait = Number(availableAt) - Math.floor(Date.now() / 1000);
  $("pg-faucet-next").textContent = held < amount ? "The faucet is empty right now." : wait > 0 ? `Your next drip: ${new Date(Number(availableAt) * 1000).toLocaleTimeString()}` : "";
}

// Stream ----------------------------------------------------------------------------------------------------------------
let shownStream = null; // { id, sender, recipient, deposit, start, stop, withdrawn, state }

async function loadStream(id) {
  const w = words(await read(PG.stream, callData(ABI.sel.stream.stream, encUint(id))));
  const s = { id, sender: asAddr(w[0]), recipient: asAddr(w[1]), deposit: asUint(w[2]), start: Number(asUint(w[3])),
    stop: Number(asUint(w[4])), withdrawn: asUint(w[5]), state: Number(asUint(w[6])) };
  if (s.state === 0) throw new Error("There is no stream with that id.");
  shownStream = s;
  memory.set("stream", String(id));
  drawStream();
}

function earnedAt(s, t) {
  if (t <= s.start) return 0n;
  if (t >= s.stop) return s.deposit;
  return (s.deposit * BigInt(t - s.start)) / BigInt(s.stop - s.start);
}

function drawStream() {
  const s = shownStream, box = $("pg-stream-view");
  if (!s) { box.hidden = true; return; }
  box.hidden = false;
  const now = Math.floor(Date.now() / 1000);
  const active = STREAM_STATES[s.state] === "active";
  const earned = active ? earnedAt(s, now) : s.withdrawn;
  const pct = s.deposit === 0n ? 0 : Number((earned * 1000n) / s.deposit) / 10;
  $("pg-stream-bar").style.width = pct + "%";
  const timing = !active ? "cancelled" : now < s.start ? `starts in ${s.start - now}s` : now >= s.stop ? "finished" : `${s.stop - now}s left`;
  $("pg-stream-facts").replaceChildren(...[
    ["Stream", "#" + s.id + " · " + timing],
    ["From → to", short(s.sender) + " → " + short(s.recipient)],
    ["Earned so far", fmt(earned) + " of " + fmt(s.deposit)],
    ["Withdrawn", fmt(s.withdrawn)],
    ["Withdrawable now (about)", active ? fmt(earned - s.withdrawn) : "–"],
  ].flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
  const mine = same(account, s.sender) || same(account, s.recipient);
  $("pg-stream-withdraw").disabled = !active;
  $("pg-stream-cancel").disabled = !active || !mine;
  $("pg-stream-rule").textContent = !active ? "" : mine ? "Anyone can trigger a withdrawal; the tokens always go to the recipient. You can cancel: the recipient keeps what is earned, the sender gets the rest."
    : "Anyone can trigger a withdrawal; the tokens always go to the recipient. Only the sender or the recipient can cancel.";
}

async function createStream() {
  const recipient = $("pg-stream-to").value.trim();
  if (!isAddr(recipient)) throw new Error("The recipient must be a 0x address.");
  if (same(recipient, account)) throw new Error("You cannot stream to yourself. Use another address as the recipient.");
  const amount = parseAmount($("pg-stream-amount").value);
  const seconds = Number($("pg-stream-seconds").value);
  if (!Number.isInteger(seconds) || seconds < 10) throw new Error("The duration must be at least 10 seconds.");
  const msg = $("pg-stream-msg");
  await ensureAllowance(PG.stream, amount, msg);
  setMsg(msg, "Confirm the stream in your wallet…");
  const start = (await chainNow()) + 45; // time to confirm in the wallet; the contract refuses a start in the past
  const receipt = await send(PG.stream, callData(ABI.sel.stream.create, encAddr(recipient), encUint(amount), encUint(start), encUint(start + seconds)), "Create stream");
  const id = idFromLogs(receipt, PG.stream, ABI.topics.StreamCreated);
  if (id !== null) await loadStream(id);
  return `Stream #${id} created. It starts in about 45 seconds and pays out every second after that.`;
}

// Escrow ----------------------------------------------------------------------------------------------------------------
let shownDeal = null; // { id, buyer, seller, arbiter, amount, deadline, state }

async function loadDeal(id) {
  const w = words(await read(PG.escrow, callData(ABI.sel.escrow.deal, encUint(id))));
  const d = { id, buyer: asAddr(w[0]), seller: asAddr(w[1]), arbiter: asAddr(w[2]), amount: asUint(w[3]),
    deadline: Number(asUint(w[4])), state: Number(asUint(w[5])) };
  if (d.state === 0) throw new Error("There is no deal with that id.");
  shownDeal = d;
  memory.set("deal", String(id));
  drawDeal();
}

function drawDeal() {
  const d = shownDeal, box = $("pg-deal-view");
  if (!d) { box.hidden = true; return; }
  box.hidden = false;
  const now = Math.floor(Date.now() / 1000);
  const funded = DEAL_STATES[d.state] === "funded";
  const noArbiter = /^0x0{40}$/.test(d.arbiter);
  const expired = now >= d.deadline;
  $("pg-deal-facts").replaceChildren(...[
    ["Deal", "#" + d.id + " · " + DEAL_STATES[d.state]],
    ["Buyer → seller", short(d.buyer) + " → " + short(d.seller)],
    ["Amount", fmt(d.amount)],
    ["Arbiter", noArbiter ? "none" : short(d.arbiter)],
    ["Deadline", expired ? "passed" : `in ${d.deadline - now}s`],
  ].flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
  // The same rules as the contract's release and refund, so the buttons are only enabled when the call can succeed.
  const isArbiter = !noArbiter && same(account, d.arbiter);
  const canRelease = funded && (same(account, d.buyer) || isArbiter);
  const canRefund = funded && (same(account, d.seller) || isArbiter || (same(account, d.buyer) && expired));
  $("pg-deal-release").disabled = !canRelease;
  $("pg-deal-refund").disabled = !canRefund;
  $("pg-deal-rule").textContent = !funded ? "Settled: nothing more can happen to this deal."
    : same(account, d.buyer) && !expired ? `As the buyer you can release now, or take the funds back yourself once the deadline passes (in ${d.deadline - now}s).`
    : "The buyer or the arbiter can release to the seller. The seller or the arbiter can refund the buyer at any time, and the buyer can after the deadline.";
}

async function createDeal() {
  const seller = $("pg-deal-seller").value.trim();
  if (!isAddr(seller)) throw new Error("The seller must be a 0x address.");
  if (same(seller, account)) throw new Error("You cannot be your own seller. Use another address.");
  const amount = parseAmount($("pg-deal-amount").value);
  const minutes = Number($("pg-deal-minutes").value);
  if (!(minutes > 0)) throw new Error("The deadline must be at least a minute away.");
  const msg = $("pg-deal-msg");
  await ensureAllowance(PG.escrow, amount, msg);
  setMsg(msg, "Confirm the deal in your wallet…");
  const deadline = (await chainNow()) + Math.round(minutes * 60);
  const zero = "0x0000000000000000000000000000000000000000";
  const receipt = await send(PG.escrow, callData(ABI.sel.escrow.create, encAddr(seller), encUint(amount), encUint(deadline), encAddr(zero)), "Fund escrow");
  const id = idFromLogs(receipt, PG.escrow, ABI.topics.DealCreated);
  if (id !== null) await loadDeal(id);
  return `Deal #${id} funded. Release it to the seller, or wait for the deadline and take it back.`;
}

// Vault -----------------------------------------------------------------------------------------------------------------
async function refreshVault() {
  const total = await readUint(PG.vault, ABI.sel.vault.totalDeposits);
  const rows = [["Total in the vault", fmt(total)]];
  if (account) rows.unshift(["Your deposit", fmt(await readUint(PG.vault, callData(ABI.sel.vault.depositOf, encAddr(account))))]);
  $("pg-vault-facts").replaceChildren(...rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
}

async function vaultDeposit() {
  const amount = parseAmount($("pg-vault-amount").value);
  await ensureAllowance(PG.vault, amount, $("pg-vault-msg"));
  setMsg($("pg-vault-msg"), "Confirm the deposit in your wallet…");
  await send(PG.vault, callData(ABI.sel.vault.deposit, encUint(amount)), "Deposit " + fmt(amount));
  return `Deposited ${fmt(amount)}. Withdraw it any time.`;
}

async function vaultWithdraw() {
  const amount = parseAmount($("pg-vault-amount").value);
  await send(PG.vault, callData(ABI.sel.vault.withdraw, encUint(amount)), "Withdraw " + fmt(amount));
  return `Withdrew ${fmt(amount)}.`;
}

// ---- wiring -------------------------------------------------------------------------------------------------------------
let refreshing = false;
async function refreshAll() {
  if (refreshing) return;
  refreshing = true;
  try {
    await Promise.allSettled([
      refreshBalances(), refreshVault(),
      shownStream ? loadStream(shownStream.id) : null,
      shownDeal ? loadDeal(shownDeal.id) : null,
    ]);
  } finally { refreshing = false; }
}

function setup() {
  $("pg-stream-to").value = DEMO_PAYEE;
  $("pg-deal-seller").value = DEMO_PAYEE;
  if (!PG.faucet) {
    $("pg-drip").disabled = true;
    $("pg-faucet-next").textContent = "The public faucet is not deployed yet. Ask the team for test tokens, or run the whole thing locally (below).";
  }
  const on = (id, msgId, action) => $(id).addEventListener("click", () => run($(id), $(msgId), action));
  on("pg-drip", "pg-faucet-msg", async () => {
    await send(PG.faucet, ABI.sel.faucet.drip, "Faucet drip");
    return `Received test ${SYMBOL}. Now try a stream, an escrow or the vault.`;
  });
  on("pg-stream-create", "pg-stream-msg", createStream);
  on("pg-stream-withdraw", "pg-stream-msg", async () => {
    await send(PG.stream, callData(ABI.sel.stream.withdraw, encUint(shownStream.id)), `Withdraw from stream #${shownStream.id}`);
    return "Paid the recipient everything earned so far.";
  });
  on("pg-stream-cancel", "pg-stream-msg", async () => {
    await send(PG.stream, callData(ABI.sel.stream.cancel, encUint(shownStream.id)), `Cancel stream #${shownStream.id}`);
    return "Cancelled: the recipient kept what was earned and the sender got the rest back.";
  });
  on("pg-stream-load", "pg-stream-msg", async () => { await loadStream(BigInt($("pg-stream-id").value || "0")); return "Loaded."; });
  on("pg-deal-create", "pg-deal-msg", createDeal);
  on("pg-deal-release", "pg-deal-msg", async () => {
    await send(PG.escrow, callData(ABI.sel.escrow.release, encUint(shownDeal.id)), `Release deal #${shownDeal.id}`);
    return "Released: the seller has been paid.";
  });
  on("pg-deal-refund", "pg-deal-msg", async () => {
    await send(PG.escrow, callData(ABI.sel.escrow.refund, encUint(shownDeal.id)), `Refund deal #${shownDeal.id}`);
    return "Refunded: the buyer has the tokens back.";
  });
  on("pg-deal-load", "pg-deal-msg", async () => { await loadDeal(BigInt($("pg-deal-id").value || "0")); return "Loaded."; });
  on("pg-vault-deposit", "pg-vault-msg", vaultDeposit);
  on("pg-vault-withdraw", "pg-vault-msg", vaultWithdraw);

  const lastStream = memory.get("stream"), lastDeal = memory.get("deal");
  if (lastStream) loadStream(BigInt(lastStream)).catch(() => {});
  if (lastDeal) loadDeal(BigInt(lastDeal)).catch(() => {});
  if (window.ethereum && window.ethereum.on) window.ethereum.on("accountsChanged", () => setTimeout(refreshAll, 0));
  setInterval(() => { drawStream(); drawDeal(); }, 1000); // countdowns and the earning bar tick locally
  setInterval(refreshAll, 15000); // and the chain is re-read every 15 s
  refreshAll();
}
setup();
