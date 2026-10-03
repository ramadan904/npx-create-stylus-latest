// Feedback polish for the playground: a card glows while its transaction waits on the wallet or the
// chain, flashes green when it lands and shakes on an error; the clicked button spins; the stream bar shimmers while it
// pays out; the activity list becomes a timeline with a state per transaction; balances flash when they change; the
// connected account gets an identicon. It only watches what playground.js already renders (status
// lines, the activity list, balances) and adds classes, so the page works the same without it. Reduced motion keeps the
// colours and drops the movement (see the CSS).
"use strict";
(() => {
  const root = document.getElementById("playground");
  if (!root) return;
  const watch = (node, fn, opts = { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] }) => {
    if (node) new MutationObserver(() => fn(node)).observe(node, opts);
  };
  const pulse = (el, cls, ms) => {
    el.classList.remove(cls);
    void el.offsetWidth; // restart the animation
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), ms);
  };

  // The button you pressed spins until its card's status line settles.
  let pressed = null;
  document.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest("button.btn") : null;
    if (b) pressed = b;
  }, true);

  // A card's status line says what its transaction is doing: waiting (wallet or chain), done, or failed.
  const BUSY = /^(Confirm|Step \d|Sent|Waiting|Replaying)|in your wallet/i;
  function track(msg, card) {
    let was = "";
    watch(msg, () => {
      const text = msg.textContent.trim();
      const state = msg.classList.contains("ok") ? "ok" : msg.classList.contains("bad") ? "bad" : BUSY.test(text) ? "busy" : "";
      if (state === was) return;
      was = state;
      card.classList.toggle("busy", state === "busy");
      if (state === "busy" && pressed && card.contains(pressed)) pressed.classList.add("spin");
      if (state !== "busy") card.querySelectorAll(".spin").forEach((b) => b.classList.remove("spin"));
      if (state === "ok") pulse(card, "won", 1300);
      if (state === "bad") pulse(card, "shake", 600);
    });
  }
  root.querySelectorAll(".card").forEach((card) => card.querySelectorAll(".msg").forEach((msg) => track(msg, card)));

  // The stream bar shimmers while the stream is paying out (its facts say how long is left).
  const facts = document.getElementById("pg-stream-facts");
  const bar = document.getElementById("pg-stream-bar");
  watch(facts, () => bar && bar.parentElement.classList.toggle("flowing", /\ds left/.test(facts.textContent)), { childList: true, subtree: true, characterData: true });

  // The activity list as a timeline: each entry gets its state (sent, confirmed, reverted) for its marker.
  const activity = document.getElementById("pg-activity");
  watch(activity, () => {
    for (const li of activity.children) {
      const m = /:\s(sent|confirmed|reverted)\b/.exec(li.textContent);
      if (m && li.dataset.state !== m[1]) {
        li.dataset.state = m[1];
        if (m[1] !== "sent") pulse(li, "landed", 900);
      }
    }
  }, { childList: true, subtree: true, characterData: true });

  // Balances flash when they change (not on the first read).
  for (const id of ["pg-balance", "pg-faucet-held"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    let last = el.textContent;
    watch(el, () => {
      const now = el.textContent;
      if (now === last) return;
      const first = !/\d/.test(last);
      last = now;
      if (!first) pulse(el, "bump", 1000);
    }, { childList: true, subtree: true, characterData: true });
  }

  // The connected account: a small identicon from the address, and the network it is on.
  const acct = document.getElementById("acct");
  watch(acct, () => {
    const text = acct.textContent;
    const m = /0x[0-9a-fA-F]{4,}/.exec(text);
    let dot = acct.previousElementSibling;
    if (!m) { if (dot && dot.classList.contains("ident")) dot.remove(); return; }
    if (!dot || !dot.classList.contains("ident")) {
      dot = Object.assign(document.createElement("span"), { className: "ident", title: "Your account (Arbitrum Sepolia)" });
      acct.before(dot);
      const net = Object.assign(document.createElement("span"), { className: "netpill", textContent: "Arbitrum Sepolia" });
      acct.after(net);
    }
    const hex = m[0].slice(2).toLowerCase().padEnd(12, "0");
    const hue = (i) => (parseInt(hex.slice(i, i + 3), 16) * 360) / 4096;
    dot.style.background = `conic-gradient(from ${hue(6)}deg, hsl(${hue(0)} 80% 60%), hsl(${hue(3)} 80% 55%), hsl(${hue(9)} 80% 60%), hsl(${hue(0)} 80% 60%))`;
  }, { childList: true, subtree: true, characterData: true });
})();
