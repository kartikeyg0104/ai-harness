// BMAD Next — the one page. The extension posts state; this renders it. Nothing here calls a service or holds a key.
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const saved = vscode.getState() || {};
  const ui = {
    page: saved.page === "new" || saved.page === "history" ? saved.page : "mission",
    query: "",
    draft: typeof saved.draft === "string" ? saved.draft : "",
    open: saved.open && typeof saved.open === "object" ? saved.open : {},
    gateDrafts: saved.gateDrafts && typeof saved.gateDrafts === "object" ? saved.gateDrafts : {},
    older: false,
    sending: false,
  };
  let state = null;
  let gateKey = null;
  let talkKeys = [];
  let history = null;
  const save = () => vscode.setState({ page: ui.page, draft: ui.draft, open: ui.open, gateDrafts: ui.gateDrafts });
  const post = (message) => vscode.postMessage(message);
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const $ = (id) => document.getElementById(id);

  const svg = (body, extra) => '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' + (extra || "") + ">" + body + "</svg>";
  const ICON = {
    spark: svg('<path d="M8 1.8c.4 3.1 1.9 4.6 5 5-3.1.4-4.6 1.9-5 5-.4-3.1-1.9-4.6-5-5 3.1-.4 4.6-1.9 5-5Z" fill="currentColor" stroke="none"/>'),
    stop: svg('<rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none"/>'),
    send: svg('<path d="M8 13V3.5M3.8 7.6 8 3.4l4.2 4.2"/>'),
    mic: svg('<rect x="5.6" y="1.8" width="4.8" height="8" rx="2.4"/><path d="M3.3 7.6a4.7 4.7 0 0 0 9.4 0M8 12.3v2"/>'),
    ok: svg('<path d="m3.6 8.3 2.8 2.7 6-6.2" stroke-width="2.2"/>', ' class="ok"'),
    no: svg('<path d="m4.5 4.5 7 7m0-7-7 7" stroke-width="2.2"/>', ' class="no"'),
    caret: svg('<path d="m6 3.5 4.5 4.5L6 12.5"/>', ' class="caret"'),
    close: svg('<path d="m4.5 4.5 7 7m0-7-7 7"/>'),
    back: svg('<path d="M12.5 8h-9M7.2 4.3 3.5 8l3.7 3.7"/>'),
  };

  const IDEAS = [
    "A todo app with add, complete, delete, and items that stay after a reload",
    "A markdown notes app that works offline",
    "A pomodoro timer that keeps a daily log",
  ];

  // ------------------------------------------------------------------------------------------ the Jarvis core

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function cssColor(name) {
    const probe = document.createElement("i");
    probe.style.color = "var(" + name + ")";
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).color.match(/[\d.]+/g) || ["95", "216", "255"];
    probe.remove();
    return rgb.slice(0, 3).map(Number);
  }

  /** How the core moves in each state: energy drives the waveform and glow, spin drives the rings. */
  const MOTION = {
    standby: { energy: 0.04, spin: 0.18 },
    working: { energy: 0.2, spin: 0.7 },
    ready: { energy: 0.16, spin: 0.35 },
    starting: { energy: 0.55, spin: 1.6 },
    listening: { energy: 0.95, spin: 0.9 },
    thinking: { energy: 0.42, spin: 2.8 },
    speaking: { energy: 0.72, spin: 1.1 },
    paused: { energy: 0.05, spin: 0.08 },
    error: { energy: 0.3, spin: 0.4 },
    done: { energy: 0.12, spin: 0.25 },
  };

  class Orb {
    constructor(host) {
      this.button = host;
      this.canvas = document.createElement("canvas");
      host.appendChild(this.canvas);
      this.ctx = this.canvas.getContext("2d");
      this.mode = "standby";
      this.colorVar = "--muted";
      this.rgb = [150, 150, 150];
      this.energy = 0.04;
      this.spin = 0.18;
      this.angle = 0;
      this.power = 0;
      this.last = performance.now();
      this.tick = this.tick.bind(this);
      requestAnimationFrame(this.tick);
    }

    set(mode, colorVar) {
      if (colorVar !== this.colorVar) { this.colorVar = colorVar; this.rgb = cssColor(colorVar); }
      if (mode === "starting" && this.mode !== "starting") this.power = 0;
      this.mode = mode;
    }

    tick(now) {
      requestAnimationFrame(this.tick);
      if (!this.button.isConnected || this.button.offsetParent === null) return;
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      const target = MOTION[this.mode] || MOTION.standby;
      const still = reduceMotion.matches;
      this.energy += (target.energy - this.energy) * Math.min(1, dt * 3);
      this.spin += (target.spin - this.spin) * Math.min(1, dt * 2);
      this.angle += still ? 0 : dt * this.spin;
      this.power = Math.min(1, this.power + dt * 0.9);
      this.draw(still ? 0 : now / 1000);
    }

    draw(t) {
      const size = this.button.clientWidth;
      const dpr = window.devicePixelRatio || 1;
      if (this.canvas.width !== Math.round(size * dpr)) { this.canvas.width = Math.round(size * dpr); this.canvas.height = Math.round(size * dpr); }
      const ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      const c = size / 2;
      const R = size / 2 - 2;
      const [r, g, b] = this.rgb;
      const col = (a) => "rgba(" + r + "," + g + "," + b + "," + a + ")";
      const E = this.energy;
      const boot = this.mode === "starting" ? this.power : 1;

      // Glow and core.
      const glow = ctx.createRadialGradient(c, c, 0, c, c, R * 0.7);
      glow.addColorStop(0, col(0.5 + 0.4 * E));
      glow.addColorStop(0.28, col(0.16 + 0.2 * E));
      glow.addColorStop(1, col(0));
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(c, c, R * 0.7, 0, Math.PI * 2); ctx.fill();
      const breathe = 1 + Math.sin(t * (this.mode === "speaking" ? 9 : 2.2)) * (0.05 + E * 0.12);
      ctx.fillStyle = col(0.95);
      ctx.beginPath(); ctx.arc(c, c, R * 0.12 * breathe * (0.4 + 0.6 * boot), 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = col(0.55); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(c, c, R * 0.2, 0, Math.PI * 2); ctx.stroke();

      // Waveform: 56 bars around the core, their length driven by the state's energy.
      const bars = 56;
      ctx.lineCap = "round";
      ctx.lineWidth = Math.max(1.2, R * 0.022);
      for (let i = 0; i < bars; i++) {
        if (i / bars > boot) break;
        const a = (i / bars) * Math.PI * 2 + this.angle * 0.3;
        const n = (Math.sin(i * 1.7 + t * 3.1) + Math.sin(i * 0.37 + t * 5.3) + Math.sin(i * 2.9 - t * 1.7)) / 3;
        const beat = this.mode === "speaking" ? 0.6 + 0.4 * Math.abs(Math.sin(t * 7 + i * 0.2)) : 1;
        const len = R * (0.03 + E * 0.2 * ((n + 1) / 2) * beat);
        const r0 = R * 0.3;
        ctx.strokeStyle = col(0.35 + 0.55 * E);
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
        ctx.lineTo(c + Math.cos(a) * (r0 + len), c + Math.sin(a) * (r0 + len));
        ctx.stroke();
      }

      // Three counter-rotating arcs.
      ctx.lineWidth = Math.max(1.5, R * 0.03);
      for (let k = 0; k < 3; k++) {
        const start = -this.angle * 1.4 + (k * Math.PI * 2) / 3;
        ctx.strokeStyle = col(0.75);
        ctx.beginPath(); ctx.arc(c, c, R * 0.64, start, start + (Math.PI * 2 / 3 - 0.55) * boot); ctx.stroke();
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = col(0.22);
      ctx.beginPath(); ctx.arc(c, c, R * 0.58, 0, Math.PI * 2); ctx.stroke();

      // Outer tick ring, turning slowly the other way.
      const ticks = 72;
      for (let i = 0; i < ticks; i++) {
        if (i / ticks > boot) break;
        const a = (i / ticks) * Math.PI * 2 + this.angle * 0.45;
        const major = i % 6 === 0;
        const r1 = R * (major ? 0.8 : 0.84);
        ctx.strokeStyle = col(major ? 0.8 : 0.32);
        ctx.lineWidth = major ? 1.6 : 1;
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
        ctx.lineTo(c + Math.cos(a) * R * 0.9, c + Math.sin(a) * R * 0.9);
        ctx.stroke();
      }
      ctx.strokeStyle = col(0.2);
      ctx.beginPath(); ctx.arc(c, c, R * 0.97, 0, Math.PI * 2); ctx.stroke();
      // A bright marker rides the outer ring.
      const m = -this.angle * 0.9;
      ctx.strokeStyle = col(0.95); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(c, c, R * 0.97, m, m + 0.35 * boot); ctx.stroke();
    }
  }

  // ------------------------------------------------------------------------------------------ skeleton

  app.innerHTML =
    '<header class="status">' +
      '<div class="pill" id="pill" role="status" aria-live="polite"><span class="beacon"></span><span class="pill-text" id="pill-text">Loading…</span></div>' +
      '<button class="tool stop" id="stop" hidden title="Stop the autopilot now">' + ICON.stop + "Stop</button>" +
      '<button class="tool" id="jarvis-toggle"></button>' +
    "</header>" +
    '<main class="scroll" id="scroll">' +
      '<button class="back" id="back" hidden></button>' +
      '<section id="history" class="history" hidden></section>' +
      '<section id="hero" class="hero" hidden><div class="hero-core"><button class="orb" id="hero-orb" aria-label="Jarvis core"></button></div><div id="hero-body"></div></section>' +
      '<section id="core" class="core" hidden><button class="orb" id="orb" aria-label="Jarvis core"></button><div class="core-read" id="core-read"></div></section>' +
      '<div class="telemetry" id="telemetry" hidden></div>' +
      '<section id="mission" class="mission" hidden></section>' +
      '<div id="action-slot"></div>' +
      '<section id="flow" hidden><div class="section-head"><h2>Progress</h2></div><ol class="rail" id="rail"></ol></section>' +
      '<section id="details" class="details" hidden></section>' +
      '<section id="talk-wrap" hidden><div class="section-head"><h2>Jarvis</h2><span id="talk-note"></span></div><div class="talk" id="talk"></div></section>' +
    "</main>" +
    '<footer class="dock">' +
      '<div class="suggest" id="suggest" hidden></div>' +
      '<div class="voice" id="voice" hidden></div>' +
      '<div class="composer" id="composer">' +
        '<textarea id="input" rows="1" aria-label="Message"></textarea>' +
        '<div class="composer-foot"><span class="hint" id="hint"></span>' +
          '<button class="round mic" id="mic" hidden title="Hold to talk to Jarvis" aria-label="Hold to talk">' + ICON.mic + "</button>" +
          '<button class="round send" id="send" aria-label="Send">' + ICON.send + "</button>" +
        "</div>" +
      "</div>" +
      '<p class="composer-error" id="composer-error" role="alert" hidden></p>' +
    "</footer>";

  const input = $("input");
  input.value = ui.draft;
  const orb = new Orb($("orb"));
  const heroOrb = new Orb($("hero-orb"));
  let wasOn = false;
  let bootUntil = 0;

  // ------------------------------------------------------------------------------------------ helpers

  /** The screen on show. Without a mission there is nothing to show but a clean start (or the history). */
  function page() {
    if (ui.page === "history") return "history";
    if (!state || !state.mission) return "new";
    return ui.page;
  }

  function composerMode() {
    return page() === "new" ? "new" : "ask";
  }

  function go(next) {
    if (ui.page === next) return;
    ui.page = next;
    save();
    if (next === "history") post({ type: "loadHistory" });
    const scroll = $("scroll");
    scroll.classList.remove("page-in");
    void scroll.offsetWidth;
    scroll.classList.add("page-in");
    window.scrollTo(0, 0);
    if (state) render();
    if (next !== "history") input.focus();
  }

  function fit() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  }

  function elapsed(since) {
    const seconds = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000));
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? m + "m " + String(s).padStart(2, "0") + "s" : s + "s";
  }

  function setHTML(el, html) {
    if (el.__html === html) return false;
    el.__html = html;
    el.innerHTML = html;
    return true;
  }

  function sentence(text) {
    const t = String(text || "");
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
  }

  const SKILL_WORK = {
    "forge-idea": "Questioning the idea",
    spec: "Writing the spec",
    prd: "Writing the PRD",
    architecture: "Designing the architecture",
    ux: "Designing the experience",
    "create-epics-and-stories": "Planning the tickets",
    "sprint-planning": "Planning the work",
  };

  /** The autopilot's progress line in plain words: what it is doing, not which skill file runs. */
  function humanActivity(raw) {
    const text = String(raw || "").replace(/^autopilot(?: running)?:?\s*/i, "").trim();
    let m;
    if ((m = /^Running bmad-([\w-]+)/.exec(text))) return SKILL_WORK[m[1]] || "Running " + m[1].replace(/-/g, " ");
    if ((m = /^bmad-([\w-]+): completed/.exec(text))) return (SKILL_WORK[m[1]] || m[1]) + ": done";
    if ((m = /^Building ticket (\d+(?:\.\d+)*)/.exec(text))) return "Building ticket " + m[1];
    if ((m = /^Repairing ticket (\d+(?:\.\d+)*)/.exec(text))) return "Repairing ticket " + m[1];
    if (/^Answering the forge questions/.test(text)) return "Answering the forge questions";
    if (/^Forge/.test(text)) return "Hardening the idea";
    if (/^Release gate/.test(text)) return "Running the release checks";
    if (/^Architecture:/.test(text)) return "Checking the architecture";
    if (/^Traceability:/.test(text)) return "Checking traceability";
    if ((m = /^Ticket (\d+(?:\.\d+)*):/.exec(text))) return "Checking ticket " + m[1];
    if (!text) return "Working";
    return sentence(text.split(" — ")[0].replace(/\s*\([^)]*\)\.?$/, "").replace(/\.$/, ""));
  }

  // ------------------------------------------------------------------------------------------ status bar

  function renderStatus() {
    const pill = $("pill");
    const m = state && state.mission;
    let tone = "idle";
    let text = "No mission yet";
    if (m) {
      const gate = state.gate;
      if (m.running) { tone = "run"; text = humanActivity(m.activity); }
      else if (gate && gate.kind === "forge") { tone = "you"; text = "Waiting for your answer"; }
      else if (gate && gate.kind === "accept") { tone = "you"; text = "Waiting for you to accept the tickets"; }
      else if (gate && gate.kind === "approve") { tone = "you"; text = "Ready for your release approval"; }
      else if (m.loop === "released") { tone = "pass"; text = "Released"; }
      else if (m.loop === "blocked") { tone = "fail"; text = "Stopped"; }
      else text = sentence(m.loop);
    }
    pill.dataset.tone = tone;
    $("pill-text").textContent = text;
    const stop = $("stop");
    stop.hidden = !(m && m.running);
    if (stop.hidden) { stop.disabled = false; stop.lastChild.textContent = "Stop"; }

    const j = state && state.jarvis;
    const on = j && j.state !== "JARVIS_OFF";
    const toggle = $("jarvis-toggle");
    toggle.className = "tool" + (on ? " jarvis-on" : "");
    toggle.innerHTML = ICON.spark + (on ? "Jarvis on" : "Jarvis");
    toggle.title = on ? "Turn Jarvis off (the mission keeps running)" : "Turn on Jarvis: voice, narration, and commands";
  }

  // ------------------------------------------------------------------------------------------ empty state

  function renderHero() {
    const hero = $("hero");
    const show = !!state && page() === "new";
    hero.hidden = !show;
    if (!show) return;
    const j = state.jarvis;
    heroOrb.set(j && j.state !== "JARVIS_OFF" ? jarvisMode(j) : "ready", j && j.state !== "JARVIS_OFF" ? "--jarvis" : "--jarvis");
    setHTML($("hero-body"),
      "<h1>What should BMAD build?</h1>" +
      "<p>Describe it in a sentence or two. BMAD plans it, builds it, checks it, and asks you before anything ships.</p>" +
      '<ol class="path">' +
        "<li><div><strong>Plan</strong><span>A spec, PRD, and architecture from your idea</span></div></li>" +
        "<li><div><strong>Build</strong><span>Code and tests, one ticket at a time</span></div></li>" +
        "<li><div><strong>Verify</strong><span>Tests, review, and an attack pass must all succeed</span></div></li>" +
        "<li><div><strong>Release</strong><span>Only after you approve it</span></div></li>" +
      "</ol>" +
      '<div class="ideas">' + IDEAS.map((idea, i) => '<button class="idea" data-idea="' + i + '">' + esc(idea) + "</button>").join("") + "</div>");
  }

  // ------------------------------------------------------------------------------------------ core band

  function jarvisMode(j) {
    return { JARVIS_STARTING: "starting", JARVIS_ACTIVE: "ready", JARVIS_LISTENING: "listening", JARVIS_PROCESSING: "thinking", JARVIS_SPEAKING: "speaking", JARVIS_PAUSED: "paused", JARVIS_ERROR: "error" }[j.state] || "ready";
  }

  const CORE_STATE = { starting: "Coming online", ready: "Online", listening: "Listening", thinking: "Thinking", speaking: "Speaking", paused: "Paused", error: "Needs attention" };

  function renderCore() {
    const core = $("core");
    const m = page() === "mission" && state && state.mission;
    core.hidden = !m;
    if (!m) { $("telemetry").hidden = true; return; }
    const j = state.jarvis;
    const on = !!j && j.state !== "JARVIS_OFF";
    const released = m.loop === "released" || (state.release && state.release.state === "pass");
    if (on && !wasOn) bootUntil = Date.now() + 2600;
    wasOn = on;
    const listen = (j && j.listen) || { handsFree: false, wakeWord: false, hearing: false, available: false };
    let mode, tone, colorVar, stateText;
    if (listen.hearing && (on || listen.wakeWord)) {
      mode = "listening"; tone = "jarvis"; colorVar = "--jarvis"; stateText = "Hearing you";
    } else if (on) {
      mode = jarvisMode(j);
      tone = mode === "error" ? "fail" : "jarvis";
      colorVar = mode === "error" ? "--fail" : "--jarvis";
      stateText = CORE_STATE[mode];
    } else if (released) {
      mode = "done"; tone = "pass"; colorVar = "--pass"; stateText = "Mission released";
    } else if (m.running) {
      mode = "working"; tone = "gold"; colorVar = "--gold"; stateText = "Working";
    } else if (state.gate && state.gate.kind !== "resume") {
      mode = "working"; tone = "gold"; colorVar = "--gold"; stateText = "Your turn";
    } else if (m.loop === "blocked") {
      mode = "error"; tone = "fail"; colorVar = "--fail"; stateText = "Stopped";
    } else if (listen.wakeWord) {
      mode = "ready"; tone = "jarvis"; colorVar = "--jarvis"; stateText = "Say “Hey Jarvis”";
    } else {
      mode = "standby"; tone = "standby"; colorVar = "--muted"; stateText = "On standby";
    }
    if (on && mode === "ready" && listen.handsFree) stateText = "Listening";
    orb.set(mode, colorVar);
    core.dataset.tone = tone;
    core.classList.toggle("scan", m.running || mode === "thinking" || mode === "starting");
    const agent = j && (j.agents || []).find((a) => a.status === "WORKING");
    const line = m.running ? humanActivity(m.activity) + (agent ? ", " + agent.name.toLowerCase() : "")
      : state.gate ? { forge: "BMAD has a question for you.", accept: "The tickets are ready for your acceptance.", approve: "Every check passed. The release waits for you.", resume: "The autopilot stopped. Continue it below when you are ready." }[state.gate.kind]
      : released ? "Every gate passed and the release is recorded." : "Nothing is running.";
    const voiceOk = on && j.voice.ok && j.microphone.ok && j.autoListen !== "off";
    const hint = listen.handsFree && on ? "Just talk. Jarvis answers in the language you speak."
      : listen.wakeWord && !on ? "Say “Hey Jarvis” and your request, in any language."
      : !on ? "Tap the core to wake Jarvis." : voiceOk ? "Hold the core to talk, or turn on hands-free." : "Type below to talk to Jarvis.";
    const switches = listen.available
      ? '<div class="switches"><button class="switch" role="switch" aria-checked="' + listen.handsFree + '" data-jarvis="handsFree">Hands-free</button>' +
        '<button class="switch" role="switch" aria-checked="' + listen.wakeWord + '" data-jarvis="wakeWord">Hey Jarvis</button></div>'
      : "";
    const booting = on && Date.now() < bootUntil && (j.readiness || []).length;
    const boot = booting ? '<ul class="boot">' + j.readiness.map((r, i) => '<li style="animation-delay:' + (i * 380) + 'ms"><b class="' + (r.ok ? "" : "warn") + '">' + (r.ok ? "OK" : "!!") + "</b><span>" + esc(r.label) + "</span></li>").join("") + "</ul>" : "";
    setHTML($("core-read"),
      '<div class="core-name"><span class="dot"></span>Jarvis</div>' +
      '<div class="core-state">' + esc(stateText) + "</div>" +
      (boot || '<div class="core-line">' + esc(line) + '</div><div class="core-hint">' + esc(hint) + "</div>") + switches);
    if (booting) setTimeout(() => { if (state) renderCore(); }, bootUntil - Date.now() + 50);
    $("orb").title = on ? (voiceOk ? "Hold to talk to Jarvis" : "Jarvis is on") : "Wake Jarvis";
    renderTelemetry(released);
  }

  function renderTelemetry(released) {
    const el = $("telemetry");
    const m = page() === "mission" && state && state.mission;
    el.hidden = !m;
    if (!m) return;
    const steps = (state.jarvis && state.jarvis.timeline) || [];
    const done = steps.filter((s) => s.state === "done").length;
    const crit = state.release ? state.release.criteria : [];
    const passed = crit.filter((c) => c.state === "pass" || c.state === "waived").length;
    const working = ((state.jarvis && state.jarvis.agents) || []).filter((a) => a.status === "WORKING").length;
    const cells = [
      [done + "/" + (steps.length || "–"), "Steps", released ? "good" : ""],
      [crit.length ? passed + "/" + crit.length : "–", "Checks", crit.length && passed === crit.length ? "good" : ""],
      ['<span data-clock="' + esc(m.createdAt) + '">' + clock(m.createdAt) + "</span>", "Time", ""],
      [String(working), working === 1 ? "Agent" : "Agents", working ? "hot" : ""],
    ];
    setHTML(el, cells.map((c) => '<div class="cell"><b class="' + c[2] + '">' + c[0] + "</b><span>" + c[1] + "</span></div>").join(""));
  }

  function clock(since) {
    const s = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? h + "h " + String(m).padStart(2, "0") + "m" : m + "m " + String(s % 60).padStart(2, "0") + "s";
  }

  // ------------------------------------------------------------------------------------------ mission card

  function renderMission() {
    const el = $("mission");
    const m = page() === "mission" && state && state.mission;
    el.hidden = !m;
    if (!m) return;
    const steps = (state.jarvis && state.jarvis.timeline) || [];
    const done = steps.filter((s) => s.state === "done").length;
    const released = m.loop === "released" || (state.release && state.release.state === "pass");
    const pct = steps.length ? Math.round((done / steps.length) * 100) : 0;
    if (!el.querySelector(".bar")) {
      el.innerHTML = '<h1 id="m-title"></h1><div class="meta" id="m-meta"></div>' +
        '<div class="progress" id="m-progress"><div class="bar"><i id="m-bar"></i></div><div class="progress-row"><span id="m-steps"></span><span id="m-pct"></span></div></div>';
    }
    $("m-title").textContent = m.title;
    $("m-title").title = m.title;
    setHTML($("m-meta"), '<span class="chip id" title="' + esc(sentence(m.complexity) + " " + m.mode + " mission") + '">' + esc(m.id) + "</span>" + (state.model ? '<span class="chip" title="Model">' + esc(state.model.replace(/^[^/]+\//, "")) + "</span>" : ""));
    $("m-progress").dataset.done = String(released);
    $("m-bar").style.width = (released ? 100 : pct) + "%";
    $("m-steps").textContent = steps.length ? done + " of " + steps.length + " steps" : "";
    $("m-pct").textContent = released ? "Released" : steps.length ? pct + "%" : "";
  }

  // ------------------------------------------------------------------------------------------ action card

  function renderGate() {
    const slot = $("action-slot");
    const gate = page() === "mission" && state && state.mission ? state.gate : null;
    const key = gate ? gate.key : null;
    if (key === gateKey) return;
    gateKey = key;
    if (!gate) { slot.innerHTML = ""; return; }
    const draft = ui.gateDrafts[key] || {};
    let html = "";
    if (gate.kind === "forge") {
      html = '<section class="action" aria-label="Question">' +
        "<p>Question " + gate.index + " of " + gate.total + "</p>" +
        "<h2>" + esc(gate.prompt) + "</h2>" +
        '<p class="why">' + esc(gate.why) + "</p>" +
        '<textarea class="input" id="g-text" rows="3" placeholder="Your answer"></textarea>' +
        '<div class="row-actions"><button class="primary" id="g-go">Record answer</button><span class="quiet-note">Enter to send</span></div></section>';
    } else if (gate.kind === "accept") {
      html = '<section class="action" aria-label="Accept tickets">' +
        "<h2>Accept these tickets to start building</h2>" +
        "<p>BMAD builds only a ticket tree a named person accepted.</p>" +
        "<ul>" + gate.tickets.map((t) => '<li><span class="ref">' + esc(t.ref) + "</span><span>" + esc(t.title) + "</span></li>").join("") + "</ul>" +
        '<label class="field-label" for="g-text">Your name</label>' +
        '<input class="input" id="g-text" autocomplete="name" placeholder="Recorded with the acceptance" />' +
        '<div class="row-actions"><button class="primary" id="g-go">Accept and build</button></div></section>';
    } else if (gate.kind === "approve") {
      html = '<section class="action" aria-label="Approve release">' +
        "<h2>Every automated check passed</h2>" +
        "<p>The release waits for a named person's approval and reason.</p>" +
        '<label class="field-label" for="g-text">Your name</label>' +
        '<input class="input" id="g-text" autocomplete="name" placeholder="Recorded with the approval" />' +
        '<label class="field-label" for="g-reason">Why approve it?</label>' +
        '<textarea class="input" id="g-reason" rows="2" placeholder="What you checked"></textarea>' +
        '<div class="row-actions"><button class="primary" id="g-go">Approve release</button></div></section>';
    } else if (gate.kind === "resume") {
      html = '<section class="action resume" aria-label="Mission stopped">' +
        "<h2>The mission stopped</h2>" +
        "<p>" + esc(gate.reason || "The autopilot is not running.") + "</p>" +
        '<div class="row-actions"><button class="primary" id="g-go">Continue autopilot</button></div></section>';
    }
    slot.innerHTML = html;
    const text = $("g-text");
    const reason = $("g-reason");
    const go = $("g-go");
    if (text) text.value = draft.text || (gate.kind !== "forge" ? state.acceptor || "" : "");
    if (reason) reason.value = draft.reason || "";
    const keep = () => { ui.gateDrafts[key] = { text: text ? text.value : "", reason: reason ? reason.value : "" }; save(); };
    if (text) text.addEventListener("input", keep);
    if (reason) reason.addEventListener("input", keep);
    const submit = () => {
      const t = text ? text.value.trim() : "";
      const r = reason ? reason.value.trim() : "";
      if (text && !t) { text.focus(); return; }
      if (reason && !r) { reason.focus(); return; }
      go.disabled = true;
      go.textContent = gate.kind === "resume" ? "Starting…" : "Recording…";
      delete ui.gateDrafts[key];
      save();
      if (gate.kind === "forge") post({ type: "forgeAnswer", text: t });
      else if (gate.kind === "accept") post({ type: "acceptTickets", identity: t });
      else if (gate.kind === "approve") post({ type: "approveRelease", identity: t, reason: r });
      else post({ type: "resumeAutopilot" });
    };
    go.addEventListener("click", submit);
    if (text) text.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      if (reason && !reason.value.trim()) reason.focus(); else submit();
    });
    if (reason) reason.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
    // Put the cursor where the decision is, unless the person is typing elsewhere.
    const target = text && !text.value ? text : reason && !reason.value ? reason : text;
    if (target && document.activeElement !== input) target.focus({ preventScroll: false });
  }

  // ------------------------------------------------------------------------------------------ gate rail

  function renderRail() {
    const flow = $("flow");
    const steps = page() === "mission" && state && state.mission && state.jarvis ? state.jarvis.timeline : [];
    flow.hidden = !steps.length;
    if (!steps.length) return;
    const rail = $("rail");
    const agent = (state.jarvis.agents || []).find((a) => a.status === "WORKING");
    // Finished steps before the last one fold into a single row unless the person opened them.
    const lastDone = steps.map((s) => s.state).lastIndexOf("done");
    const allDone = steps.every((s) => s.state === "done");
    const foldCount = ui.open.rail ? 0 : allDone ? steps.length : Math.max(0, lastDone);
    const visible = steps.map((step, i) => ({ step, i })).filter((x) => x.i >= foldCount);
    let fold = rail.querySelector(".fold");
    if (foldCount > 1) {
      if (!fold) {
        fold = document.createElement("li");
        fold.className = "fold";
        fold.innerHTML = '<span class="node">' + ICON.ok + '</span><button type="button" data-rail="open"></button>';
        rail.prepend(fold);
      }
      fold.classList.toggle("solo", visible.length === 0);
      fold.querySelector("button").textContent = allDone ? "All " + steps.length + " steps done" : foldCount + " steps done";
    } else if (fold) {
      fold.remove();
    }
    const shown = foldCount > 1 ? visible : steps.map((step, i) => ({ step, i }));
    const items = [...rail.querySelectorAll(".step")];
    while (items.length > shown.length) items.pop().remove();
    shown.forEach(({ step, i }, n) => {
      let li = items[n];
      if (!li) {
        li = document.createElement("li");
        li.className = "step";
        li.innerHTML = '<span class="wire"></span><span class="node">' + ICON.ok + ICON.no + '</span><span class="step-body"><span class="step-label"></span><span class="step-sub" hidden></span></span>';
        li.dataset.state = "waiting";
        rail.appendChild(li);
      }
      li.dataset.index = String(i);
      if (li.dataset.state !== step.state) li.dataset.state = step.state;
      const label = li.querySelector(".step-label");
      if (label.textContent !== step.label) label.textContent = step.label;
      const sub = li.querySelector(".step-sub");
      if (step.state === "active" && agent) {
        sub.hidden = false;
        sub.dataset.since = agent.since;
        sub.dataset.who = agent.name;
        sub.textContent = agent.name + ", " + elapsed(agent.since);
      } else {
        sub.hidden = true;
        delete sub.dataset.since;
      }
    });
    const closer = rail.querySelector("[data-rail=close]");
    if (ui.open.rail && lastDone > 1) {
      const li = closer ? closer.closest("li") : document.createElement("li");
      if (!closer) {
        li.className = "fold solo";
        li.innerHTML = '<span></span><button type="button" data-rail="close">Fold finished steps</button>';
      }
      rail.appendChild(li);
    } else if (!ui.open.rail) {
      const close = rail.querySelector("[data-rail=close]");
      if (close) close.closest("li").remove();
    }
  }

  // ------------------------------------------------------------------------------------------ details

  function group(key, title, count, tone, body) {
    const open = ui.open[key] ? " open" : "";
    return '<details class="group" data-key="' + key + '"' + open + "><summary>" + ICON.caret + "<span>" + title + '</span><span class="count ' + (tone || "") + '">' + count + "</span></summary>" +
      '<div class="group-body">' + body + "</div></details>";
  }

  function renderDetails() {
    const el = $("details");
    const m = page() === "mission" && state && state.mission;
    el.hidden = !m;
    if (!m) return;
    const parts = [];
    const release = state.release;
    if (release) {
      const passed = release.criteria.filter((c) => c.state === "pass" || c.state === "waived").length;
      parts.push(group("release", "Release checks", passed + "/" + release.criteria.length, passed === release.criteria.length ? "good" : "",
        release.criteria.map((c) => '<div class="item"><span class="tag ' + esc(c.state) + '">' + esc(c.state === "pass" ? "Passed" : c.state === "waived" ? "Waived" : sentence(c.state)) + "</span><div>" + esc(c.label) + "<p>" + esc(c.detail) + "</p></div></div>").join("")));
    }
    if (state.tickets.length) {
      parts.push(group("tickets", "Tickets", String(state.tickets.length), "",
        state.tickets.map((t) => '<div class="item"><span class="ref tag">' + esc(t.ref) + "</span><div>" + esc(t.title) + "<p>" + esc(sentence(t.risk)) + " risk</p></div></div>").join("")));
    }
    if (state.requirements.length) {
      parts.push(group("requirements", "Requirements", String(state.requirements.length), "",
        state.requirements.map((r) => '<div class="item"><span class="ref tag">' + esc(r.id) + "</span><div>" + esc(r.title) + "<p>" + esc(sentence(r.status)) + "</p></div></div>").join("")));
    }
    if (state.evidence.length) {
      const failing = state.evidence.filter((e) => e.result === "fail" || e.result === "blocked" || e.result === "error").length;
      parts.push(group("evidence", "Evidence", failing ? failing + " failing" : String(state.evidence.length), failing ? "bad" : "",
        state.evidence.map((e) => '<div class="item"><span class="tag ' + esc(e.result) + '">' + esc(sentence(e.result)) + "</span><div>" + esc(sentence(e.kind)) + (e.story ? " for ticket " + esc(e.story) : "") +
          (e.artifact ? '<p><button class="linkish" data-open="' + esc(e.artifact) + '">Open the record</button></p>' : "") + "</div></div>").join("")));
    }
    if (state.findings.length) {
      const serious = state.findings.some((f) => f.severity === "high" || f.severity === "critical");
      parts.push(group("findings", "Findings", String(state.findings.length), serious ? "bad" : "",
        state.findings.map((f) => '<div class="item"><span class="tag ' + (f.severity === "high" || f.severity === "critical" ? "fail" : "") + '">' + esc(sentence(f.severity)) + "</span><div>" + esc(f.message) + '<p class="ref">' + esc(f.code) + "</p></div></div>").join("")));
    }
    setHTML(el, parts.join("") || "");
    el.hidden = !parts.length;
  }

  // ------------------------------------------------------------------------------------------ Jarvis conversation

  function entryKey(e) { return e.at + "|" + e.who + "|" + e.text.length; }

  function entryHTML(e) {
    if (e.who === "you") return '<div class="msg you">' + esc(e.text) + "</div>";
    const cls = "msg jarvis" + (e.kind === "narration" ? " narration" : "") + (e.kind === "error" ? " error" : "");
    return '<div class="' + cls + '" data-cat="' + esc(e.category || "") + '"><span class="glyph">' + ICON.spark + '</span><span class="text">' + esc(e.text) + "</span></div>";
  }

  /** New Jarvis lines type themselves out; the full text is there from the start for screen readers. */
  function typeOut(nodes) {
    if (reduceMotion.matches) return;
    nodes.forEach((node) => {
      if (node.dataset.typed) return;
      node.dataset.typed = "1";
      const full = node.textContent;
      node.setAttribute("aria-label", full);
      node.textContent = "";
      node.classList.add("caret-type");
      let i = 0;
      const step = Math.max(1, Math.round(full.length / 90));
      const timer = setInterval(() => {
        i = Math.min(full.length, i + step);
        node.textContent = full.slice(0, i);
        if (i >= full.length) { clearInterval(timer); node.classList.remove("caret-type"); }
      }, 16);
    });
  }

  function renderTalk() {
    const wrap = $("talk-wrap");
    const m = page() === "mission" && state && state.mission;
    const j = state && state.jarvis;
    wrap.hidden = !m;
    if (!m || !j) return;
    const all = j.transcript || [];
    const shown = ui.older ? all : all.slice(-14);
    const keys = shown.map(entryKey);
    const talk = $("talk");
    const hidden = all.length - shown.length;
    $("talk-note").textContent = j.state === "JARVIS_OFF" ? "Off" : "";
    if (!all.length) {
      talkKeys = [];
      setHTML(talk, '<p class="talk-empty">Ask what is happening, what is blocked, or tell it to pause. Typing here turns Jarvis on.</p>');
      return;
    }
    const prefix = talkKeys.length > 0 && talkKeys.every((k, i) => keys[i] === k);
    if (prefix && keys.length >= talkKeys.length && !talk.querySelector(".talk-empty")) {
      // Only new entries animate in.
      const fresh = shown.slice(talkKeys.length);
      if (fresh.length) {
        const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
        talk.insertAdjacentHTML("beforeend", fresh.map(entryHTML).join(""));
        typeOut([...talk.querySelectorAll(".msg.jarvis .text")].slice(-fresh.filter((e) => e.who !== "you").length || talk.children.length));
        if (ui.followTalk || nearBottom) window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
        if (fresh.some((e) => e.who === "jarvis")) ui.followTalk = false;
      }
    } else {
      talk.__html = null;
      talk.innerHTML = (hidden > 0 ? '<button class="tool older" id="older">Show ' + hidden + " earlier</button>" : "") + shown.map(entryHTML).join("");
      talk.querySelectorAll(".msg").forEach((n) => { n.style.animation = "none"; });
    }
    talkKeys = keys;
  }

  // ------------------------------------------------------------------------------------------ composer and voice

  function renderComposer() {
    const mode = composerMode();
    const j = state && state.jarvis;
    const on = !!j && j.state !== "JARVIS_OFF";
    const composer = $("composer");
    composer.className = "composer" + (mode === "ask" ? " ask" : "");
    document.querySelector(".dock").hidden = page() === "history";
    const suggest = $("suggest");
    const showSuggest = page() === "mission" && !input.value.trim();
    suggest.hidden = !showSuggest;
    if (showSuggest) {
      const m = state.mission;
      const chips = [["What's happening?", "status"], ["What's blocked?", "what is blocked"], ["Which agents are running?", "agents"]];
      if (m && !m.running && m.loop !== "released") chips.push(["Continue", "continue"]);
      if (m && m.running) chips.push(["Pause", "pause"]);
      setHTML(suggest, chips.map((c) => '<button data-say="' + esc(c[1]) + '">' + esc(c[0]) + "</button>").join(""));
    }
    input.placeholder = mode === "new" ? "Describe what you want to build…" : "Ask Jarvis anything, in any language…";
    $("hint").textContent = ui.sending ? (mode === "new" ? "Creating the mission…" : "Sending…") : mode === "new" ? "Enter creates the mission. Shift+Enter adds a line." : on ? "Enter to send" : "Sending turns Jarvis on";
    const voiceOk = on && j.voice.ok && j.microphone.ok && j.autoListen !== "off" && !j.paused;
    const mic = $("mic");
    mic.hidden = !(on && mode === "ask" && j.microphone.ok && j.autoListen !== "off");
    mic.disabled = !voiceOk;
    mic.classList.toggle("hot", !!j && j.state === "JARVIS_LISTENING");
    mic.title = voiceOk ? "Hold to talk to Jarvis" : j && !j.voice.ok ? "Voice commands need a voice service: " + j.voice.reason : "Voice is unavailable";
    const err = $("composer-error");
    const message = state && state.composer.error;
    err.hidden = !message;
    err.textContent = message || "";
    renderVoice(j, on);
  }

  const VOICE_TEXT = {
    JARVIS_STARTING: "Jarvis is starting",
    JARVIS_ACTIVE: "Jarvis is ready",
    JARVIS_LISTENING: "Jarvis is listening. Release to send.",
    JARVIS_PROCESSING: "Jarvis is thinking",
    JARVIS_SPEAKING: "Jarvis is speaking",
    JARVIS_PAUSED: "Jarvis is paused",
    JARVIS_ERROR: "Jarvis hit a problem",
  };

  function renderVoice(j, on) {
    const voice = $("voice");
    voice.hidden = !on || page() !== "mission";
    if (voice.hidden) { voice.__html = null; return; }
    const live = ["JARVIS_LISTENING", "JARVIS_SPEAKING", "JARVIS_PROCESSING"].includes(j.state);
    const label = j.state === "JARVIS_ERROR" && j.error ? j.error : VOICE_TEXT[j.state] || "Jarvis is ready";
    setHTML(voice,
      '<span class="eq' + (live ? " live" : "") + '"><i></i><i></i><i></i><i></i></span>' +
      '<span class="label">' + esc(label) + "</span>" +
      (j.state === "JARVIS_SPEAKING" ? '<button class="mini" data-jarvis="stopSpeaking">Quiet</button>' : "") +
      '<button class="mini" data-jarvis="' + (j.paused ? "resume" : "pause") + '">' + (j.paused ? "Resume" : "Pause") + "</button>");
  }

  function send() {
    const text = input.value.trim();
    if (!text || ui.sending) return;
    const mode = composerMode();
    ui.sending = true;
    post(mode === "new" ? { type: "submit", text } : { type: "ask", text });
    input.value = "";
    ui.draft = "";
    save();
    if (mode === "new") go("mission");
    else ui.followTalk = true;
    fit();
    renderComposer();
    setTimeout(() => { ui.sending = false; if (state) renderComposer(); }, 1200);
  }

  // ------------------------------------------------------------------------------------------ events

  input.addEventListener("input", () => { ui.draft = input.value; save(); fit(); if (state) renderComposer(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    else if (e.key === "Escape" && page() === "new" && state && state.mission) go("mission");
  });
  $("send").addEventListener("click", send);
  $("stop").addEventListener("click", () => {
    const stop = $("stop");
    if (stop.disabled) return;
    stop.disabled = true;
    stop.lastChild.textContent = "Stopping…";
    post({ type: "stopAutopilot" });
  });
  $("jarvis-toggle").addEventListener("click", () => {
    const on = state && state.jarvis && state.jarvis.state !== "JARVIS_OFF";
    post({ type: "jarvis", action: on ? "exit" : "activate" });
  });

  // Push-to-talk records exactly while the button is held; the release is caught anywhere so a re-render cannot lose it.
  let holding = false;
  const jarvisOn = () => !!(state && state.jarvis && state.jarvis.state !== "JARVIS_OFF");
  const canTalk = () => { const j = state && state.jarvis; return jarvisOn() && j.voice.ok && j.microphone.ok && j.autoListen !== "off" && !j.paused; };
  for (const id of ["orb", "hero-orb"]) {
    const el = $(id);
    el.addEventListener("pointerdown", (e) => {
      if (!jarvisOn()) return;
      if (canTalk() && !holding) { e.preventDefault(); holding = true; post({ type: "jarvis", action: "pttStart" }); }
    });
    el.addEventListener("click", () => {
      if (!jarvisOn()) post({ type: "jarvis", action: "activate" });
      else if (!canTalk()) input.focus();
    });
  }
  $("mic").addEventListener("pointerdown", (e) => {
    const mic = $("mic");
    if (mic.disabled || holding) return;
    e.preventDefault();
    holding = true;
    post({ type: "jarvis", action: "pttStart" });
  });
  const release = () => { if (holding) { holding = false; post({ type: "jarvis", action: "pttStop" }); } };
  document.addEventListener("pointerup", release);
  document.addEventListener("pointercancel", release);
  window.addEventListener("blur", release);

  document.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const say = target.closest("[data-say]");
    if (say) { ui.followTalk = true; post({ type: "ask", text: say.getAttribute("data-say") }); return; }
    const idea = target.closest("[data-idea]");
    if (idea) { input.value = IDEAS[Number(idea.getAttribute("data-idea"))] || ""; ui.draft = input.value; save(); fit(); input.focus(); return; }
    const open = target.closest("[data-open]");
    if (open) { post({ type: "openFile", path: open.getAttribute("data-open") }); return; }
    const jarvis = target.closest("[data-jarvis]");
    if (jarvis) { post({ type: "jarvis", action: jarvis.getAttribute("data-jarvis") }); return; }
    if (target.closest("#older")) { ui.older = true; talkKeys = []; renderTalk(); return; }
    const railToggle = target.closest("[data-rail]");
    if (railToggle) { ui.open.rail = railToggle.getAttribute("data-rail") === "open"; save(); $("rail").innerHTML = ""; renderRail(); return; }
    if (target.closest("#back")) { go("mission"); return; }
    const pick = target.closest("[data-mission]");
    if (pick) { post({ type: "openMission", id: pick.getAttribute("data-mission") }); return; }
  });

  document.addEventListener("toggle", (e) => {
    const el = e.target;
    if (el instanceof HTMLDetailsElement && el.dataset.key) {
      ui.open[el.dataset.key] = el.open;
      save();
    }
  }, true);

  // The running step's clock and the mission clock.
  setInterval(() => {
    document.querySelectorAll("[data-clock]").forEach((el) => { el.textContent = clock(el.dataset.clock); });
    document.querySelectorAll(".step-sub[data-since]").forEach((sub) => {
      sub.textContent = sub.dataset.who + ", " + elapsed(sub.dataset.since);
    });
  }, 1000);

  window.addEventListener("message", (event) => {
    const data = event.data || {};
    if (data.type === "state") {
      const hadMission = !!(state && state.mission);
      state = data.state;
      if (!hadMission && state.mission && ui.page === "new") { ui.page = "mission"; save(); }
      render();
    } else if (data.type === "show") {
      go(data.page === "new" || data.page === "history" ? data.page : "mission");
      if (data.page === "history") post({ type: "loadHistory" });
    } else if (data.type === "history") {
      history = Array.isArray(data.items) ? data.items : [];
      renderHistory();
    } else if (data.type === "reveal") {
      ui.open[data.section] = true;
      save();
      if (state) renderDetails();
      const el = document.querySelector('[data-key="' + data.section + '"]');
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });

  function renderBack() {
    const back = $("back");
    const p = page();
    const show = (p === "new" || p === "history") && !!state && !!state.mission;
    back.hidden = !show;
    if (show) setHTML(back, ICON.back + "<span>Back to " + esc(state.mission.title) + "</span>");
  }

  const LOOP_TEXT = { released: ["Released", "pass"], blocked: ["Stopped", "fail"], draft: ["Draft", ""] };

  function ago(iso) {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    if (s < 7 * 86400) return Math.round(s / 86400) + " d ago";
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function renderHistory() {
    const el = $("history");
    const show = page() === "history";
    el.hidden = !show;
    if (!show) return;
    if (!el.querySelector("#h-list")) {
      el.innerHTML = '<h1>History</h1><input class="input search" id="h-search" type="search" placeholder="Search missions" aria-label="Search missions" /><div class="h-list" id="h-list" role="list"></div>';
      $("h-search").addEventListener("input", (e) => { ui.query = e.target.value; renderHistory(); });
    }
    const list = $("h-list");
    if (!history) { setHTML(list, '<p class="empty-note">Loading missions…</p>'); return; }
    const q = ui.query.trim().toLowerCase();
    const items = history.filter((h) => !q || h.title.toLowerCase().includes(q) || h.id.includes(q));
    if (!history.length) { setHTML(list, '<p class="empty-note">No missions yet. Start one with the plus button.</p>'); return; }
    if (!items.length) { setHTML(list, '<p class="empty-note">No mission matches “' + esc(ui.query) + '”.</p>'); return; }
    setHTML(list, items.map((h) => {
      const known = LOOP_TEXT[h.loop];
      const label = known ? known[0] : "In progress";
      const tone = known ? known[1] : "run";
      return '<button class="h-item' + (h.active ? " current" : "") + '" role="listitem" data-mission="' + esc(h.id) + '">' +
        '<span class="h-title">' + esc(h.title) + "</span>" +
        '<span class="h-meta"><span class="h-state" data-tone="' + tone + '">' + label + "</span><span>" + esc(ago(h.updatedAt)) + "</span>" +
        (h.active ? '<span class="h-current">Open now</span>' : "") + "</span></button>";
    }).join(""));
  }

  function render() {
    app.removeAttribute("aria-busy");
    renderBack();
    renderHistory();
    renderStatus();
    renderHero();
    renderCore();
    renderMission();
    renderGate();
    renderRail();
    renderDetails();
    renderTalk();
    renderComposer();
  }

  fit();
  post({ type: "ready" });
})();
