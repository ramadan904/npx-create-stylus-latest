// "Watch an AI agent move money": replays agent-demo.json, a real agent run recorded in CI (see e2e/gen-agent-demo.mjs).
// Each step shows the sentence, the tool call the agent sent, and the result its CLI returned, verbatim in the JSON view.
// Nothing here talks to a chain or a wallet. Reduced motion shows every step at once.
(() => {
  const box = document.getElementById("agent-log");
  const play = document.getElementById("agent-play");
  const meta = document.getElementById("agent-meta");
  if (!box || !play) return;
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const h = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text === undefined ? {} : { textContent: text });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let demo;
  let runId = 0;

  function callText(step) {
    const args = Object.entries(step.input).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ");
    return `${step.tool}({ ${args} })`;
  }

  function render(step, n) {
    const row = h("li", `astep ${step.ok ? "good" : "bad"}`);
    row.append(h("div", "say", `${n + 1}. ${step.say}`));
    const call = h("div", "call");
    call.append(h("span", `who ${step.contract}`, step.contract), h("code", "fn", ""));
    const policy = Object.entries(step.policy || {});
    if (policy.length) call.append(h("span", "pol", policy.map(([k, v]) => `${k}=${v}`).join(" ")));
    row.append(call);
    const out = h("div", "out");
    out.append(h("span", "mark", step.ok ? "✓" : "✗"), h("span", "sum", step.summary));
    const raw = h("details", "raw");
    raw.append(h("summary", "", "JSON the agent got back"), h("pre", "", JSON.stringify(step.result, null, 2)));
    out.append(raw);
    row.append(out);
    return row;
  }

  async function replay() {
    const mine = ++runId;
    box.textContent = "";
    play.textContent = "Replaying…";
    for (const [n, step] of demo.steps.entries()) {
      if (mine !== runId) return;
      const row = render(step, n);
      box.append(row);
      const fn = row.querySelector(".fn");
      const text = callText(step);
      if (calm) {
        fn.textContent = text;
        row.classList.add("done");
        continue;
      }
      row.scrollIntoView({ block: "nearest", behavior: "smooth" });
      for (let i = 1; i <= text.length; i += 2) {
        if (mine !== runId) return;
        fn.textContent = text.slice(0, i);
        await wait(12);
      }
      fn.textContent = text;
      await wait(Math.min(900, 250 + step.ms / 6)); // a hint of the real latency, compressed
      row.classList.add("done");
      await wait(450);
    }
    play.textContent = "Replay";
  }

  fetch("agent-demo.json")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((d) => {
      demo = d;
      meta.innerHTML = "";
      meta.append(
        `${d.steps.length} steps picked from ${d.totalCalls} tool calls in one run (${d.checks} checks), against real contracts on a local Arbitrum Nitro node (chain ${d.chainId}). `,
        Object.assign(h("a", "", "See the CI run"), { href: d.source, target: "_blank", rel: "noopener" }),
        ".",
      );
      play.disabled = false;
      play.addEventListener("click", replay);
      if ("IntersectionObserver" in window && !calm) {
        const once = new IntersectionObserver((e) => {
          if (e.some((x) => x.isIntersecting)) { once.disconnect(); if (!box.childElementCount) replay(); }
        }, { threshold: 0.3 });
        once.observe(box);
      } else {
        replay();
      }
    })
    .catch(() => {
      meta.textContent = "The recorded run could not be loaded.";
    });
})();
