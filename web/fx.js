// Visual effects for the page: count-up stats, reveal on scroll, a glow that follows the cursor on cards, and confetti
// when a transaction in the playground succeeds. Purely cosmetic: nothing here touches wallets or contracts, every
// effect is skipped for people who ask for reduced motion, and the page reads the same without this file.
(() => {
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Count the stat numbers up from zero once they scroll into view.
  function countUp(el) {
    const target = Number(el.dataset.count);
    if (!Number.isFinite(target) || calm) return;
    const start = performance.now();
    const ms = 1100;
    const step = (now) => {
      const t = Math.min(1, (now - start) / ms);
      el.textContent = String(Math.round(target * (1 - Math.pow(1 - t, 3))));
      if (t < 1) requestAnimationFrame(step);
    };
    el.textContent = "0";
    requestAnimationFrame(step);
  }

  // Sections and cards fade up as they arrive. Only added when IntersectionObserver exists, so nothing stays hidden.
  if ("IntersectionObserver" in window && !calm) {
    const seen = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("in");
        e.target.querySelectorAll("[data-count]").forEach(countUp);
        seen.unobserve(e.target);
      }
    }, { threshold: 0.12 });
    document.querySelectorAll("section, .stat").forEach((el) => {
      el.classList.add("reveal");
      seen.observe(el);
    });
  }

  // A soft light that follows the pointer across a card.
  document.addEventListener("pointermove", (ev) => {
    const card = ev.target instanceof Element ? ev.target.closest(".card") : null;
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty("--x", `${ev.clientX - r.left}px`);
    card.style.setProperty("--y", `${ev.clientY - r.top}px`);
  }, { passive: true });

  // Confetti when the playground reports a success (its status lines turn `.msg.ok`).
  let canvas;
  function confetti(originX, originY) {
    if (calm) return;
    canvas ??= Object.assign(document.body.appendChild(document.createElement("canvas")), { id: "confetti" });
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = innerWidth;
    canvas.height = innerHeight;
    const css = getComputedStyle(document.documentElement);
    const colors = ["--c1", "--c2", "--c3", "--c4", "--c5"].map((v) => css.getPropertyValue(v).trim() || "#28a0f0");
    const bits = Array.from({ length: 140 }, () => ({
      x: originX, y: originY,
      vx: (Math.random() - 0.5) * 12, vy: -Math.random() * 11 - 4,
      s: 4 + Math.random() * 5, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
      c: colors[(Math.random() * colors.length) | 0],
    }));
    const end = performance.now() + 1800;
    const frame = (now) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const b of bits) {
        b.vy += 0.32; b.x += b.vx; b.y += b.vy; b.r += b.vr;
        ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r);
        ctx.fillStyle = b.c; ctx.fillRect(-b.s / 2, -b.s / 4, b.s, b.s / 2);
        ctx.restore();
      }
      if (now < end) requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
    requestAnimationFrame(frame);
  }
  let last = -Infinity;
  new MutationObserver((changes) => {
    for (const c of changes) {
      const node = c.target.nodeType === 1 ? c.target : c.target.parentElement;
      const el = node?.closest?.(".msg.ok");
      if (!el || !el.textContent.trim() || performance.now() - last < 1500) continue;
      last = performance.now();
      const r = el.getBoundingClientRect();
      confetti(r.left + Math.min(r.width, 200) / 2, r.top);
      return;
    }
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"], childList: true, characterData: true });
})();
