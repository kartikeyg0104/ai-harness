import * as vscode from "vscode";
import crypto from "node:crypto";
import type { JarvisSnapshot } from "./session";

export type JarvisAction =
  | { type: "activate" }
  | { type: "exit" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stopSpeaking" }
  | { type: "pttStart" }
  | { type: "pttStop" }
  | { type: "text"; text: string }
  | { type: "ready" };

/**
 * The Jarvis panel. It renders snapshots the extension posts; it holds no credentials and calls no service.
 * Every button posts an action back to the extension host, which owns the session.
 */
export class JarvisView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private last: JarvisSnapshot | null = null;

  constructor(private readonly onAction: (action: JarvisAction) => void) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    const nonce = crypto.randomBytes(16).toString("base64");
    view.webview.html = page(nonce);
    view.webview.onDidReceiveMessage((message: JarvisAction) => {
      if (message.type === "ready" && this.last) void view.webview.postMessage({ type: "snapshot", snapshot: this.last });
      else this.onAction(message);
    });
    view.onDidDispose(() => {
      this.view = null;
    });
  }

  post(snapshot: JarvisSnapshot): void {
    this.last = snapshot;
    void this.view?.webview.postMessage({ type: "snapshot", snapshot });
  }

  reveal(): void {
    this.view?.show?.(true);
  }
}

function page(nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<title>Jarvis</title>
<style>
  body { margin: 0; padding: 10px 12px; color: var(--vscode-foreground); font: 13px/1.45 var(--vscode-font-family); }
  button { font: inherit; cursor: pointer; border: none; }
  button:disabled { opacity: 0.55; cursor: default; }
  .main { width: 100%; padding: 12px; font-size: 15px; font-weight: 700; letter-spacing: 0.04em; border-radius: 6px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .main.on { background: #b3261e; color: #fff; }
  .main.on:hover .idle, .main.on .exit { display: none; }
  .main.on:hover .exit { display: inline; }
  .card { border: 1px solid var(--vscode-panel-border, #444); border-radius: 6px; padding: 10px; margin: 10px 0; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .muted { opacity: 0.75; font-size: 12px; }
  .ok { color: var(--vscode-testing-iconPassed, #3fb950); }
  .bad { color: var(--vscode-errorForeground, #f85149); }
  .warn { color: var(--vscode-editorWarning-foreground, #d29922); }
  h3 { margin: 12px 0 6px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.85; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { margin: 3px 0; }
  .mic { display: block; width: 100%; padding: 16px 8px; border-radius: 10px; font-size: 16px; font-weight: 600; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); user-select: none; }
  .mic.listening { background: #b3261e; color: #fff; }
  .controls { display: flex; gap: 6px; margin: 8px 0; }
  .controls button { flex: 1; padding: 6px; border-radius: 4px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  input { box-sizing: border-box; width: 100%; padding: 6px 8px; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #555); }
  .who { font-weight: 700; font-size: 11px; letter-spacing: 0.06em; }
  .entry { margin: 6px 0; }
  .entry.error .text { color: var(--vscode-errorForeground, #f85149); }
  .dot { display: inline-block; width: 9px; }
  .complete { border-color: var(--vscode-testing-iconPassed, #3fb950); }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  let snap = null;
  let draft = "";
  // Push-to-talk: recording lasts exactly as long as the button is held. The release is caught on the document so a
  // re-render during the hold cannot lose it.
  let holding = false;
  const release = () => { if (holding) { holding = false; post({ type: "pttStop" }); } };
  document.addEventListener("pointerup", release);
  document.addEventListener("pointercancel", release);
  window.addEventListener("blur", release);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const post = (message) => vscode.postMessage(message);
  const STATE_TEXT = { JARVIS_ACTIVE: "Ready", JARVIS_LISTENING: "Listening", JARVIS_PROCESSING: "Processing", JARVIS_SPEAKING: "Speaking", JARVIS_PAUSED: "Paused", JARVIS_ERROR: "Error", JARVIS_STARTING: "Starting", JARVIS_OFF: "Off" };
  const mark = { done: "✓", active: "●", failed: "✗", waiting: "○" };

  function transcript(s) {
    if (!s.transcript.length) return '<p class="muted">No conversation yet.</p>';
    return s.transcript.slice().reverse().map((e) =>
      '<div class="entry ' + (e.kind === "error" ? "error" : "") + '"><div class="who">' + (e.who === "you" ? "YOU" : "JARVIS") + '</div><div class="text">' + esc(e.text) + '</div></div>').join("");
  }

  function render() {
    const s = snap;
    if (!s) { root.innerHTML = '<p class="muted">Loading Jarvis…</p>'; return; }
    const off = s.state === "JARVIS_OFF";
    if (off) {
      root.innerHTML =
        '<button class="main" id="activate">⚡ ACTIVATE JARVIS</button>' +
        '<p class="muted">Jarvis is off. Missions run the same with or without it. It never listens until you activate it and hold the talk button.</p>' +
        (s.transcript.length ? '<h3>Previous conversation</h3>' + transcript(s) : "");
      document.getElementById("activate").onclick = () => post({ type: "activate" });
      return;
    }
    if (s.state === "JARVIS_STARTING") {
      root.innerHTML = '<div class="card"><strong>Activating Jarvis…</strong><ul>' +
        s.readiness.map((r) => '<li><span class="' + (r.ok ? "ok" : "warn") + '">' + (r.ok ? "✓" : "⚠") + '</span> ' + esc(r.label) + ' <span class="muted">' + esc(r.detail) + '</span></li>').join("") + '</ul></div>';
      return;
    }
    const m = s.mission;
    const listening = s.state === "JARVIS_LISTENING";
    const voiceOk = s.voice.ok && s.microphone.ok && s.autoListen !== "off";
    const micLabel = listening ? "🎙 ● Listening — release to send" : s.state === "JARVIS_PROCESSING" ? "🎙 Processing…" : "🎙 HOLD TO SPEAK";
    const micReason = !s.microphone.ok ? "⚠ Microphone unavailable: " + s.microphone.reason : !s.voice.ok ? "⚠ Voice service unavailable: " + s.voice.reason : s.autoListen === "off" ? "Listening is off in settings." : "";
    root.innerHTML =
      '<button class="main on" id="exit"><span class="idle">🔴 JARVIS ACTIVE</span><span class="exit">⏹ EXIT JARVIS</span></button>' +
      '<div class="card">' +
        '<div class="row"><strong>⚡ JARVIS MODE</strong><span>' + (s.paused ? "PAUSED" : "ON") + '</span></div>' +
        '<div><span class="' + (listening ? "bad" : "ok") + '">●</span> ' + esc(STATE_TEXT[s.state] || s.state) + ' <span class="muted">(' + esc(s.state) + ')</span></div>' +
        '<div>🎙 ' + (voiceOk ? "Voice enabled" : '<span class="warn">Voice unavailable</span>') + '</div>' +
        '<div>🔊 ' + (s.narration.level === "off" ? "Narration off" : s.narration.ok ? "Narration enabled (" + esc(s.narration.level) + ")" : '<span class="warn">Narration text only</span>') + '</div>' +
        '<div class="muted">Mission: ' + (m ? esc(m.title) + " · " + esc(m.id) + " · " + esc(m.phase) + " · " + esc(m.loop) : "none") + '</div>' +
        (s.readiness.length ? '<ul class="muted">' + s.readiness.map((r) => '<li><span class="' + (r.ok ? "ok" : "warn") + '">' + (r.ok ? "✓" : "⚠") + '</span> ' + esc(r.label) + (r.ok ? "" : ": " + esc(r.detail)) + '</li>').join("") + '</ul>' : "") +
      '</div>' +
      (s.completion ? '<div class="card complete"><strong>✓ JARVIS · MISSION ' + (s.completion.release === "RELEASED" ? "RELEASED" : "COMPLETE") + '</strong><ul>' +
        s.completion.gates.map((g) => '<li>' + esc(g.label) + ' <span class="' + (g.state === "pass" ? "ok" : "bad") + '">' + (g.state === "pass" ? "✓" : esc(g.state)) + '</span></li>').join("") +
        '</ul><div>Release: <strong>' + esc(s.completion.release) + '</strong></div></div>' : "") +
      '<button class="mic ' + (listening ? "listening" : "") + '" id="mic" ' + (voiceOk && !s.paused ? "" : "disabled") + '>' + micLabel + '</button>' +
      (micReason ? '<p class="warn muted">' + esc(micReason) + '</p>' : "") +
      '<div class="controls"><button id="hush">🔇 Stop Speaking</button><button id="pause">' + (s.paused ? "▶ Resume Jarvis" : "⏸ Pause Jarvis") + '</button></div>' +
      '<input id="cmd" placeholder="Type a command to Jarvis…" value="' + esc(draft) + '" ' + (s.paused ? "disabled" : "") + ' />' +
      (s.error ? '<p class="bad muted">' + esc(s.error) + '</p>' : "") +
      '<h3>Active agents</h3><ul>' + (s.agents.length ? s.agents.map((a) => '<li><span class="' + (a.status === "WORKING" ? "ok" : "warn") + '">●</span> <strong>' + esc(a.name) + '</strong> ' + esc(a.status) + '<br><span class="muted">' + esc(a.task) + (a.detail ? " · " + esc(a.detail) : "") + '</span></li>').join("") : '<li class="muted">No agents are running.</li>') + '</ul>' +
      (s.recent.length ? '<h3>Recently finished</h3><ul>' + s.recent.map((a) => '<li><span class="' + (a.status === "COMPLETE" ? "ok" : "bad") + '">' + (a.status === "COMPLETE" ? "✓" : "✗") + '</span> ' + esc(a.name) + ' <span class="muted">' + esc(a.task) + " · " + esc(a.detail) + '</span></li>').join("") + '</ul>' : "") +
      '<h3>Timeline</h3><ul>' + (s.timeline.length ? s.timeline.map((t) => '<li><span class="dot ' + (t.state === "done" ? "ok" : t.state === "failed" ? "bad" : t.state === "active" ? "warn" : "") + '">' + mark[t.state] + '</span> ' + esc(t.label) + '</li>').join("") : '<li class="muted">No mission yet.</li>') + '</ul>' +
      '<h3>Conversation</h3>' + transcript(s);
    document.getElementById("exit").onclick = () => post({ type: "exit" });
    document.getElementById("hush").onclick = () => post({ type: "stopSpeaking" });
    document.getElementById("pause").onclick = () => post({ type: s.paused ? "resume" : "pause" });
    const mic = document.getElementById("mic");
    mic.onpointerdown = () => { if (mic.disabled || holding) return; holding = true; post({ type: "pttStart" }); };
    const cmd = document.getElementById("cmd");
    cmd.oninput = () => { draft = cmd.value; };
    cmd.onkeydown = (event) => {
      if (event.key === "Enter" && cmd.value.trim()) { post({ type: "text", text: cmd.value.trim() }); draft = ""; cmd.value = ""; }
    };
    // Focus the command box when Jarvis comes online, and keep it while typing across live updates.
    if (document.activeElement !== cmd && (window.__focusCmd || window.__justActivated)) cmd.focus();
    window.__justActivated = false;
  }

  window.addEventListener("message", (event) => {
    if (event.data && event.data.type === "snapshot") {
      const focused = document.activeElement && document.activeElement.id === "cmd";
      const was = snap ? snap.state : "JARVIS_OFF";
      snap = event.data.snapshot;
      window.__focusCmd = focused;
      window.__justActivated = (was === "JARVIS_OFF" || was === "JARVIS_STARTING") && snap.state !== "JARVIS_OFF" && snap.state !== "JARVIS_STARTING";
      render();
    }
  });
  render();
  post({ type: "ready" });
</script>
</body>
</html>`;
}
