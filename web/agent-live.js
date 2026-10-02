// "Run the AI agent demo": three intents of the stream template's agent interface, run for real from the visitor's wallet
// on Arbitrum Sepolia: open_stream, then withdraw_from_stream once something is earned, then cancel_stream.
//
// The handlers below are a port of templates/_client/stream/agent.ts and its agent-kit.ts: the same reads, the same
// checks in the same order, the same result fields and the same error codes and hints (the hints come from agent-kit.ts
// through abi.js). So the JSON shown is what `agent-cli` prints for the same calls. CI holds it to that: e2e/agent-live.mjs
// runs this section against real contracts on a dev node and compares every result, field by field, with the agent CLI's.
//
// Uses the helpers of the inline script in index.html and of playground.js, which load first. No build step, no libraries.
"use strict";
(() => {
  const byId = (id) => document.getElementById(id);
  const box = byId("al-log");
  const button = byId("al-run");
  if (!box || !button) return;
  // The contract the demo drives. A test or a recording can point it elsewhere, or shorten the waits (startIn, earnFor,
  // in seconds), by setting window.AGENT_LIVE_CONFIG before the page loads.
  const CFG = Object.assign({ stream: PG.stream, scan: SCAN }, window.AGENT_LIVE_CONFIG || {});
  const STATES = ["unknown", "active", "cancelled"];
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- EIP-55 checksummed addresses, as viem's getAddress returns them (keccak-256 over the lowercase hex) -------------
  const MASK = (1n << 64n) - 1n;
  const RC = ["0x1", "0x8082", "0x800000000000808a", "0x8000000080008000", "0x808b", "0x80000001", "0x8000000080008081",
    "0x8000000000008009", "0x8a", "0x88", "0x80008009", "0x8000000a", "0x8000808b", "0x800000000000008b", "0x8000000000008089",
    "0x8000000000008003", "0x8000000000008002", "0x8000000000000080", "0x800a", "0x800000008000000a", "0x8000000080008081",
    "0x8000000000008080", "0x80000001", "0x8000000080008008"].map(BigInt);
  const ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
  const rotl = (v, n) => (n ? ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK : v);
  function keccak256(bytes) { // one-block messages only (under 136 bytes), which is all an address needs
    const block = new Uint8Array(136);
    block.set(bytes);
    block[bytes.length] ^= 0x01;
    block[135] ^= 0x80;
    const s = new Array(25).fill(0n);
    for (let i = 0; i < 17; i++) for (let b = 7; b >= 0; b--) s[i] = (s[i] << 8n) | BigInt(block[i * 8 + b]);
    for (let round = 0; round < 24; round++) {
      const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
      for (let x = 0; x < 5; x++) {
        const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
        for (let y = 0; y < 5; y++) s[x + 5 * y] ^= d;
      }
      const b = new Array(25);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x][y]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
        s[x + 5 * y] = (b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & b[((x + 2) % 5) + 5 * y])) & MASK;
      }
      s[0] ^= RC[round];
    }
    let hex = "";
    for (let i = 0; i < 4; i++) for (let b = 0; b < 8; b++) hex += ((s[i] >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, "0");
    return hex;
  }
  function checksum(address) {
    const lower = address.toLowerCase().replace(/^0x/, "");
    const hash = keccak256(new TextEncoder().encode(lower));
    return "0x" + [...lower].map((ch, i) => (parseInt(hash[i], 16) >= 8 ? ch.toUpperCase() : ch)).join("");
  }

  // ---- agent-kit.ts, ported --------------------------------------------------------------------------------------------
  class IntentError extends Error {
    constructor(code, message, details) { super(message); this.code = code; this.details = details; }
  }
  function parseUint(name, value) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
    if (typeof value === "string" && /^\d+$/.test(value.trim())) return BigInt(value.trim());
    throw new IntentError("InvalidInput", `${name} must be a non-negative whole number (a decimal string such as "1000000" for token amounts)`, { field: name });
  }
  function parseAddress(name, value) {
    if (typeof value === "string" && isAddr(value)) return checksum(value);
    throw new IntentError("InvalidInput", `${name} must be a 0x-prefixed 20-byte address`, { field: name });
  }
  function tokensToUnits(name, value, decimals) {
    const text = typeof value === "number" ? String(value) : value;
    const match = typeof text === "string" ? /^(\d+)(?:\.(\d+))?$/.exec(text.trim()) : null;
    if (!match) throw new IntentError("InvalidInput", `${name} must be a decimal number of tokens such as "2.5"`, { field: name });
    const [, whole, fraction = ""] = match;
    if (fraction.length > decimals) {
      throw new IntentError("InvalidInput", `${name} has ${fraction.length} decimal places but the token has only ${decimals}`, { field: name, decimals });
    }
    return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  }
  function parseAmountInput(input, token) {
    const hasUnits = input.amount !== undefined && input.amount !== null;
    const hasTokens = input.amountTokens !== undefined && input.amountTokens !== null;
    if (hasUnits === hasTokens) throw new IntentError("InvalidInput", "Give exactly one of amount (base units) or amountTokens (whole tokens)", { field: "amount" });
    return hasUnits ? parseUint("amount", input.amount) : tokensToUnits("amountTokens", input.amountTokens, token.decimals);
  }
  function formatUnits(value, decimals) { // viem's formatUnits: no grouping, trailing zeros dropped
    const neg = value < 0n;
    const digits = (neg ? -value : value).toString().padStart(decimals + 1, "0");
    const whole = digits.slice(0, digits.length - decimals);
    const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
    return (neg ? "-" : "") + whole + (fraction ? "." + fraction : "");
  }
  const formatTokens = (amount, token) => `${formatUnits(amount, token.decimals)} ${token.symbol}`;
  const jsonSafe = (value) => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

  // Chain access goes through the wallet, like the agent's single RPC client: reads and writes see the same node.
  const call = async (to, data) => eth("eth_call", [{ to, data }, "latest"]);
  const uintAt = async (to, data) => words(await call(to, data)).map(asUint);
  async function chainNow() {
    const block = await eth("eth_getBlockByNumber", ["latest", false]);
    return Math.max(Math.floor(Date.now() / 1000), parseInt(block.timestamp, 16));
  }

  /** agent-kit's write(): gas is twice the estimate; an estimate that reverts becomes the contract's own error, by name. */
  async function write(to, data, fn) {
    let estimate;
    try {
      estimate = BigInt(await eth("eth_estimateGas", [{ from: account, to, data }]));
    } catch (err) {
      throw revertError(err, fn);
    }
    const doubled = estimate * 2n;
    const gas = doubled > 30000000n ? (estimate > 30000000n ? estimate : 30000000n) : doubled;
    const hash = await eth("eth_sendTransaction", [{ from: account, to, data, gas: "0x" + gas.toString(16) }]);
    logTx(`Agent: ${fn}`, hash, "sent");
    const receipt = await waitReceipt(hash);
    if (receipt.status !== "0x1") {
      logTx(`Agent: ${fn}`, hash, "reverted");
      const outOfGas = BigInt(receipt.gasUsed) >= gas;
      throw new IntentError(outOfGas ? "OutOfGas" : "Reverted", outOfGas ? `transaction ${hash} ran out of gas (used all ${gas}); retry, or set a higher GAS_LIMIT` : `transaction ${hash} reverted`,
        { txHash: hash, gasUsed: BigInt(receipt.gasUsed).toString(), gasLimit: gas.toString() });
    }
    logTx(`Agent: ${fn}`, hash, "confirmed");
    return { hash, receipt };
  }

  /** A failed estimate, decoded the way viem decodes it for the agent: the custom error's name and arguments. */
  function revertError(err, fn) {
    const data = findRevertData(err);
    const spec = data && ABI.errors[data.slice(0, 10).toLowerCase()];
    if (spec) {
      const w = words(data.slice(10));
      const args = spec.types.length ? spec.types.map((t, i) => (t === "address" ? checksum(asAddr(w[i] || "")) : asUint(w[i] || "0"))) : undefined;
      return Object.assign(new IntentError(spec.name, `The contract function "${fn}" reverted.`), { args, decoded: true });
    }
    return err;
  }

  function toErrorResult(err) {
    if (err && err.decoded) return { ok: false, error: { code: err.code, message: err.message, hint: ABI.agentHints[err.code], details: { args: err.args } } };
    if (err instanceof IntentError) return { ok: false, error: { code: err.code, message: err.message, hint: ABI.agentHints[err.code], details: err.details } };
    if (err && err.code === 4001) return { ok: false, error: { code: "Rejected", message: "The transaction was rejected in the wallet." } };
    return { ok: false, error: { code: "RpcError", message: (err && (err.shortMessage || err.message)) || String(err) } };
  }

  async function runIntent(request) {
    try {
      const { intent, ...input } = request;
      return jsonSafe({ ok: true, intent, ...(await handlers[intent](input)) });
    } catch (err) {
      return jsonSafe(toErrorResult(err));
    }
  }

  // ---- stream/agent.ts, ported -----------------------------------------------------------------------------------------
  async function setup() {
    const [tokenWord] = words(await call(CFG.stream, ABI.sel.stream.token));
    const address = checksum(asAddr(tokenWord));
    const [[decimals], symbol] = await Promise.all([
      uintAt(address, ABI.sel.token.decimals),
      call(address, ABI.sel.token.symbol).then(str).catch(() => "?"),
    ]);
    return { token: { address, symbol, decimals: Number(decimals) }, contract: CFG.stream };
  }

  async function ensureFunds(token, spender, amount) {
    const [balance] = await uintAt(token.address, callData(ABI.sel.token.balanceOf, encAddr(account)));
    if (balance < amount) {
      throw new IntentError("InsufficientBalance", `the agent holds ${balance} but needs ${amount}`, { balance: balance.toString(), needed: amount.toString(), token: token.address });
    }
    const [allowance] = await uintAt(token.address, callData(ABI.sel.token.allowance, encAddr(account), encAddr(spender)));
    if (allowance >= amount) return undefined;
    return (await write(token.address, callData(ABI.sel.token.approve, encAddr(spender), encUint(amount)), "approve")).hash;
  }

  async function readStream(id) {
    const { contract, token } = await setup();
    const at = (sel, arg) => call(contract, callData(sel, arg));
    const [s, streamed, withdrawable, preview] = await Promise.all([
      at(ABI.sel.stream.stream, encUint(id)), at(ABI.sel.stream.streamed, encUint(id)),
      at(ABI.sel.stream.withdrawable, encUint(id)), at(ABI.sel.stream.previewCancel, encUint(id)),
    ]);
    const w = words(s);
    const [sender, recipient] = [checksum(asAddr(w[0])), checksum(asAddr(w[1]))];
    const [deposit, start, stop, withdrawn, state] = w.slice(2, 7).map(asUint);
    const held = async (who) => asUint(words(await at(ABI.sel.stream.claimable, encAddr(who)))[0]);
    const [heldForSender, heldForRecipient] = await Promise.all([held(sender), held(recipient)]);
    const p = words(preview).map(asUint);
    return {
      id,
      state: STATES[Number(state)] ?? String(state),
      token,
      depositTokens: formatTokens(deposit, token),
      sender,
      recipient,
      deposit,
      start,
      stop,
      withdrawn,
      streamed: asUint(words(streamed)[0]),
      withdrawable: asUint(words(withdrawable)[0]),
      cancelPreview: { toRecipient: p[0], toSender: p[1] },
      heldForClaim: { sender: heldForSender, recipient: heldForRecipient },
      youAre: same(account, sender) ? "sender" : same(account, recipient) ? "recipient" : "neither",
    };
  }

  const logsOf = (receipt, contract, topic) => receipt.logs.filter((l) => same(l.address, contract) && l.topics[0] === topic);

  const handlers = {
    async open_stream(input) {
      const recipient = parseAddress("recipient", input.recipient);
      const duration = parseUint("durationSeconds", input.durationSeconds);
      const startIn = input.startInSeconds === undefined ? 10n : parseUint("startInSeconds", input.startInSeconds);
      const { token, contract } = await setup();
      const amount = parseAmountInput(input, token);
      const approvalTxHash = await ensureFunds(token, contract, amount);
      const start = BigInt(await chainNow()) + startIn;
      const stop = start + duration;
      const { hash, receipt } = await write(contract, callData(ABI.sel.stream.create, encAddr(recipient), encUint(amount), encUint(start), encUint(stop)), "create");
      const [created] = logsOf(receipt, contract, ABI.topics.StreamCreated);
      return {
        streamId: created ? BigInt(created.topics[1]) : undefined,
        txHash: hash,
        approvalTxHash,
        recipient,
        amount,
        amountTokens: formatTokens(amount, token),
        start,
        stop,
        ratePerSecond: amount / duration,
      };
    },

    async get_stream(input) {
      return readStream(parseUint("id", input.id));
    },

    async withdraw_from_stream(input) {
      const id = parseUint("id", input.id);
      const { contract } = await setup();
      const { hash, receipt } = await write(contract, callData(ABI.sel.stream.withdraw, encUint(id)), "withdraw");
      const [event] = logsOf(receipt, contract, ABI.topics.Withdrawn);
      return { id, txHash: hash, paidToRecipient: event ? asUint(words(event.data)[0]) : undefined, stream: await readStream(id) };
    },

    async cancel_stream(input) {
      const id = parseUint("id", input.id);
      const { contract } = await setup();
      const { hash, receipt } = await write(contract, callData(ABI.sel.stream.cancel, encUint(id)), "cancel");
      // The exact split comes from the contract's own event, not from a preview taken before the transaction ran.
      const [event] = logsOf(receipt, contract, ABI.topics.Cancelled);
      const split = event ? words(event.data).map(asUint) : [];
      const held = logsOf(receipt, contract, ABI.topics.PaymentHeld).map((l) => ({ to: checksum(asAddr(l.topics[1].slice(2))), amount: asUint(words(l.data)[0]) }));
      return { id, txHash: hash, paidToRecipient: split[0], refundedToSender: split[1], held };
    },
  };

  // ---- the demo ----------------------------------------------------------------------------------------------------------
  const AMOUNT = "10";
  const DURATION = 60;
  const START_IN = CFG.startIn ?? 20; // seconds for you to confirm the create in the wallet before the stream starts
  const EARN_FOR = CFG.earnFor ?? 12; // the agent waits until the stream has run this long before paying out
  const status = byId("al-status");
  const summary = byId("al-summary");
  const recipientInput = byId("al-to");
  const state = (window.__agentLive = { running: false, done: false, results: [] });

  const node = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text === undefined ? {} : { textContent: text });
  const txLink = (hash, label) => Object.assign(node("a", "", label), { href: CFG.scan + "tx/" + hash, target: "_blank", rel: "noopener" });
  let shown = { decimals: 18, symbol: "BUIDL" }; // replaced by the token's own, read from the chain, once the stream exists
  const tokenText = (units) => formatTokens(BigInt(units), shown);

  function stepRow(n, say, request) {
    const row = node("li", "astep");
    row.append(node("div", "say", `${n}. ${say}`));
    const line = node("div", "call");
    line.append(node("span", "who", "agent"), node("code", "fn", JSON.stringify(request)));
    row.append(line);
    box.append(row);
    if (!calm) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return row;
  }

  function showResult(row, result, sum) {
    row.classList.add(result.ok ? "good" : "bad", "done");
    const out = node("div", "out");
    out.append(node("span", "mark", result.ok ? "✓" : "✗"), node("span", "sum", sum(result)));
    const links = ["approvalTxHash", "txHash"].filter((k) => result[k]).map((k) => txLink(result[k], k === "txHash" ? "transaction" : "approval"));
    if (links.length) {
      const span = node("span", "txs");
      links.forEach((a) => span.append(" · ", a));
      out.append(span);
    }
    const raw = node("details", "raw");
    raw.open = true;
    raw.append(node("summary", "", "JSON the agent got back"), node("pre", "", JSON.stringify(result, null, 2)));
    out.append(raw);
    row.append(out);
  }

  const fail = (r) => `${r.error.code}: ${r.error.hint || r.error.message}`;

  async function step(n, say, request, sum) {
    const row = stepRow(n, say, request);
    const result = await runIntent(request);
    state.results.push({ request, result });
    showResult(row, result, (r) => (r.ok ? sum(r) : fail(r)));
    return result;
  }

  async function demo() {
    if (state.running) return;
    state.running = true;
    state.done = false;
    state.results = [];
    button.disabled = true;
    box.replaceChildren();
    summary.hidden = true;
    try {
      if (!account) await connect();
      const recipient = recipientInput.value.trim();
      status.textContent = "Step 1: confirm in your wallet (an approval first, if this contract may not take your BUIDL yet).";
      const opened = await step(1, `Open a ${DURATION}-second stream of ${AMOUNT} BUIDL to the recipient.`,
        { intent: "open_stream", recipient, amountTokens: AMOUNT, durationSeconds: DURATION, startInSeconds: START_IN },
        (r) => `stream #${r.streamId} opened · ${r.amountTokens} locked · starts in ${START_IN}s`);
      if (!opened.ok) {
        status.textContent = opened.error.code === "InsufficientBalance"
          ? "The agent's wallet needs 10 BUIDL first: use the faucet in the playground below, then run it again."
          : "The agent stopped: see its error above.";
        return;
      }
      const id = opened.streamId;
      shown = (await setup()).token;

      const wait = stepRow(2, "Wait for the stream to earn something.", { wait: `until ${EARN_FOR}s after the start` });
      const until = Number(opened.start) + EARN_FOR;
      for (;;) {
        const left = until - (await chainNow());
        if (left <= 0) break;
        status.textContent = `The stream is running. The agent pays out in ${left}s…`;
        wait.querySelector(".fn").textContent = JSON.stringify({ wait: `${left}s left` });
        await sleep(1000);
      }
      wait.classList.add("good", "done");
      wait.querySelector(".fn").textContent = JSON.stringify({ wait: "done" });

      status.textContent = "Step 3: confirm the payout in your wallet.";
      const paid = await step(3, "Pay out what the recipient has earned so far.", { intent: "withdraw_from_stream", id },
        (r) => `${tokenText(r.paidToRecipient)} paid to the recipient · ${r.stream.withdrawable === "0" ? "nothing more due yet" : tokenText(r.stream.withdrawable) + " due now"} · cancelling now → ${tokenText(r.stream.cancelPreview.toRecipient)} / ${tokenText(r.stream.cancelPreview.toSender)}`);
      if (!paid.ok) { status.textContent = "The agent stopped: see its error above."; return; }

      status.textContent = "Step 4: confirm the cancel in your wallet.";
      const cancelled = await step(4, "Stop the stream: the earned part to the recipient, the rest back to you.", { intent: "cancel_stream", id },
        (r) => `${tokenText(r.paidToRecipient)} to the recipient · ${tokenText(r.refundedToSender)} back to you · ${r.held.length ? r.held.length + " payout held for claim" : "nothing held"}`);
      if (!cancelled.ok) { status.textContent = "The agent stopped: see its error above."; return; }

      const toRecipient = BigInt(paid.paidToRecipient) + BigInt(cancelled.paidToRecipient);
      summary.replaceChildren(
        node("b", "", "On-chain result: "),
        `stream #${id} paid the recipient ${tokenText(toRecipient)} in two transfers and returned ${tokenText(cancelled.refundedToSender)} to you; `,
        `together exactly the ${opened.amountTokens} deposited. `,
        Object.assign(node("a", "", "See the stream contract on Arbiscan"), { href: CFG.scan + "address/" + CFG.stream, target: "_blank", rel: "noopener" }),
        ".",
      );
      summary.hidden = false;
      status.textContent = "Done: three intents, three real transactions, every result shown exactly as the agent receives it.";
      state.done = true;
    } catch (err) {
      status.textContent = explain(err);
    } finally {
      state.running = false;
      button.disabled = false;
      button.textContent = "▶ Run it again";
      if (typeof refreshAll === "function") refreshAll();
    }
  }

  recipientInput.value = DEMO_PAYEE;
  button.disabled = false;
  button.addEventListener("click", demo);
  // For the tests: the pure helpers (compared with viem in e2e/web-check.mjs) and the intent runner (compared with the agent
  // CLI in e2e/agent-live.mjs). Same wallet, same rules as the button.
  Object.assign(window.__agentLive, { helpers: { checksum, formatUnits, tokensToUnits }, runIntent });
})();
