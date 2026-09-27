// BMAD Next site: the Jarvis core, a conversation that plays in two languages, and the gate rail that fills as you read.
(function () {
  "use strict";
  const still = window.matchMedia("(prefers-reduced-motion: reduce)");

  // ------------------------------------------------------------------ the Jarvis core (the extension's own drawing)

  const MOTION = {
    ready: { energy: 0.18, spin: 0.35 },
    listening: { energy: 0.95, spin: 0.9 },
    thinking: { energy: 0.42, spin: 2.8 },
    speaking: { energy: 0.72, spin: 1.1 },
  };

  function Core(canvas) {
    const ctx = canvas.getContext("2d");
    let mode = "ready";
    let energy = 0.18;
    let spin = 0.35;
    let angle = 0;
    let last = performance.now();
    let visible = true;
    new IntersectionObserver((entries) => { visible = entries[0].isIntersecting; }).observe(canvas);

    function draw(t) {
      const size = canvas.clientWidth;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(size * dpr)) { canvas.width = Math.round(size * dpr); canvas.height = Math.round(size * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      const c = size / 2;
      const R = size / 2 - 2;
      const col = (a) => "rgba(95,216,255," + a + ")";
      const E = energy;
      const glow = ctx.createRadialGradient(c, c, 0, c, c, R * 0.7);
      glow.addColorStop(0, col(0.5 + 0.4 * E));
      glow.addColorStop(0.28, col(0.16 + 0.2 * E));
      glow.addColorStop(1, col(0));
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(c, c, R * 0.7, 0, Math.PI * 2); ctx.fill();
      const breathe = 1 + Math.sin(t * (mode === "speaking" ? 9 : 2.2)) * (0.05 + E * 0.12);
      ctx.fillStyle = col(0.95);
      ctx.beginPath(); ctx.arc(c, c, R * 0.12 * breathe, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = col(0.55); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(c, c, R * 0.2, 0, Math.PI * 2); ctx.stroke();
      const bars = 64;
      ctx.lineCap = "round";
      ctx.lineWidth = Math.max(1.4, R * 0.018);
      for (let i = 0; i < bars; i++) {
        const a = (i / bars) * Math.PI * 2 + angle * 0.3;
        const n = (Math.sin(i * 1.7 + t * 3.1) + Math.sin(i * 0.37 + t * 5.3) + Math.sin(i * 2.9 - t * 1.7)) / 3;
        const beat = mode === "speaking" ? 0.6 + 0.4 * Math.abs(Math.sin(t * 7 + i * 0.2)) : 1;
        const len = R * (0.03 + E * 0.2 * ((n + 1) / 2) * beat);
        const r0 = R * 0.3;
        ctx.strokeStyle = col(0.35 + 0.55 * E);
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
        ctx.lineTo(c + Math.cos(a) * (r0 + len), c + Math.sin(a) * (r0 + len));
        ctx.stroke();
      }
      ctx.lineWidth = Math.max(1.8, R * 0.022);
      for (let k = 0; k < 3; k++) {
        const s = -angle * 1.4 + (k * Math.PI * 2) / 3;
        ctx.strokeStyle = col(0.75);
        ctx.beginPath(); ctx.arc(c, c, R * 0.64, s, s + Math.PI * 2 / 3 - 0.55); ctx.stroke();
      }
      ctx.lineWidth = 1; ctx.strokeStyle = col(0.22);
      ctx.beginPath(); ctx.arc(c, c, R * 0.58, 0, Math.PI * 2); ctx.stroke();
      for (let i = 0; i < 90; i++) {
        const a = (i / 90) * Math.PI * 2 + angle * 0.45;
        const major = i % 6 === 0;
        const r1 = R * (major ? 0.8 : 0.84);
        ctx.strokeStyle = col(major ? 0.8 : 0.3);
        ctx.lineWidth = major ? 1.8 : 1;
        ctx.beginPath(); ctx.moveTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1); ctx.lineTo(c + Math.cos(a) * R * 0.9, c + Math.sin(a) * R * 0.9); ctx.stroke();
      }
      ctx.strokeStyle = col(0.2);
      ctx.beginPath(); ctx.arc(c, c, R * 0.97, 0, Math.PI * 2); ctx.stroke();
      const m = -angle * 0.9;
      ctx.strokeStyle = col(0.95); ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.arc(c, c, R * 0.97, m, m + 0.35); ctx.stroke();
    }

    function tick(now) {
      requestAnimationFrame(tick);
      if (!visible) { last = now; return; }
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const target = MOTION[mode];
      energy += (target.energy - energy) * Math.min(1, dt * 3);
      spin += (target.spin - spin) * Math.min(1, dt * 2);
      if (!still.matches) angle += dt * spin;
      draw(still.matches ? 0 : now / 1000);
    }
    requestAnimationFrame(tick);
    return { set(next) { mode = next; } };
  }

  const canvas = document.getElementById("hero-core");
  const core = canvas ? Core(canvas) : null;

  // ------------------------------------------------------------------ the conversation

  const SCRIPT = {
    en: [
      ["you", "Hey Jarvis, build me a todo app that keeps my list after a reload."],
      ["j", "Starting the mission. I'll plan it first, then build it ticket by ticket."],
      ["n", "Specification, PRD, and architecture are complete."],
      ["you", "What's happening right now?"],
      ["j", "The Frontend Developer is building ticket 1.1. Tests and review come next."],
      ["n", "Attack passed. Every automated check is green."],
      ["you", "Approve the release. I tried it in the browser."],
      ["j", "Release approved for you, with your reason. Running the release gate."],
    ],
    hi: [
      ["you", "हे जार्विस, मेरे लिए एक टूडू ऐप बनाओ।"],
      ["j", "मिशन शुरू कर रहा हूँ। पहले योजना बनाऊँगा, फिर हर टिकट पर काम होगा।"],
      ["n", "स्पेसिफिकेशन, PRD और आर्किटेक्चर पूरे हो गए हैं।"],
      ["you", "अभी क्या चल रहा है?"],
      ["j", "फ्रंटएंड डेवलपर टिकट 1.1 बना रहा है। इसके बाद टेस्ट और रिव्यू होंगे।"],
      ["n", "अटैक पास हो गया। सभी स्वचालित जाँचें सफल हैं।"],
      ["you", "रिलीज़ मंज़ूर करो, मैंने ब्राउज़र में देख लिया है।"],
      ["j", "आपकी वजह के साथ रिलीज़ मंज़ूर। रिलीज़ गेट चला रहा हूँ।"],
    ],
  };
  const WHO = { you: "You", j: "Jarvis", n: "Update" };
  const STATE_TEXT = { ready: "Online", listening: "Listening", thinking: "Thinking", speaking: "Speaking" };
  const lines = document.getElementById("lines");
  const hudState = document.getElementById("hud-state");
  let lang = "en";
  let run = 0;

  function setState(mode) {
    if (core) core.set(mode);
    if (hudState) hudState.textContent = STATE_TEXT[mode];
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function type(node, text, id, cps) {
    if (still.matches) { node.textContent = text; return; }
    node.classList.add("typing");
    for (let i = 1; i <= text.length; i++) {
      if (id !== run) return;
      node.textContent = text.slice(0, i);
      await sleep(1000 / cps);
    }
    node.classList.remove("typing");
  }

  async function play() {
    const id = ++run;
    lines.innerHTML = "";
    for (const [who, text] of SCRIPT[lang]) {
      if (id !== run) return;
      const li = document.createElement("li");
      li.className = who;
      li.innerHTML = '<span class="who"></span><span class="text"></span>';
      li.firstChild.textContent = WHO[who];
      lines.appendChild(li);
      while (lines.children.length > 4) lines.firstChild.remove();
      const node = li.lastChild;
      if (who === "you") {
        setState("listening");
        await type(node, text, id, 34);
        await sleep(350);
        setState("thinking");
        await sleep(900);
      } else if (who === "j") {
        setState("speaking");
        await type(node, text, id, 40);
        await sleep(1100);
      } else {
        setState("ready");
        await type(node, text, id, 60);
        await sleep(1400);
      }
    }
    setState("ready");
    await sleep(2600);
    if (id === run) play();
  }

  document.querySelectorAll(".lang-switch button").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.lang === lang) return;
      lang = button.dataset.lang;
      document.querySelectorAll(".lang-switch button").forEach((b) => b.setAttribute("aria-selected", String(b === button)));
      lines.lang = lang;
      play();
    });
  });
  if (lines) play();

  // ------------------------------------------------------------------ the waveform: bars with their own rhythm

  const wave = document.getElementById("wave");
  if (wave) {
    for (let i = 0; i < 48; i++) {
      const bar = document.createElement("span");
      const edge = Math.sin((i / 47) * Math.PI);
      bar.style.setProperty("--d", (0.7 + ((i * 37) % 11) / 10).toFixed(2) + "s");
      bar.style.setProperty("--delay", (-((i * 53) % 17) / 10).toFixed(2) + "s");
      bar.style.opacity = String(0.35 + 0.65 * edge);
      wave.appendChild(bar);
    }
  }

  // ------------------------------------------------------------------ the gate rail fills as you read

  const rail = document.getElementById("rail");
  const shot = document.getElementById("rail-shot");
  const steps = rail ? Array.from(rail.children) : [];
  let current = -1;

  function onScroll() {
    const nav = document.getElementById("nav");
    if (nav) nav.classList.toggle("scrolled", window.scrollY > 8);
    if (!rail) return;
    const box = rail.getBoundingClientRect();
    const line = window.innerHeight * 0.45;
    const fill = Math.max(0, Math.min(1, (line - box.top) / box.height));
    rail.style.setProperty("--fill", fill.toFixed(4));
    let now = -1;
    steps.forEach((step, i) => {
      if (step.getBoundingClientRect().top < line) now = i;
    });
    if (now === current) return;
    current = now;
    steps.forEach((step, i) => {
      step.classList.toggle("seen", i < now);
      step.classList.toggle("now", i === now);
    });
    const next = now >= 0 ? steps[now].dataset.shot : null;
    if (shot && next && !shot.src.endsWith(next)) {
      shot.classList.add("swap");
      setTimeout(() => { shot.src = "assets/" + next; shot.onload = () => shot.classList.remove("swap"); }, 160);
    }
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  onScroll();
})();
