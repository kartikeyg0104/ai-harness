import * as vscode from "vscode";
import crypto from "node:crypto";
import fs from "node:fs";
import { BmadControlPlane, criterionLabel, escapeHtml, evaluateRelease, gateLabel, loadProjectEnv, parseIntent, renderMissionControl } from "@bmad-next/control-plane";
import type { Mission } from "@bmad-next/control-plane";
import { autopilotRunning, registerWorkflowCommands } from "./workflow";
import { FfmpegMicrophoneInput, GeminiIntentProvider, SystemSpeechOutput, TextCommandIntentProvider } from "./jarvis/providers";
import { JarvisSession, type JarvisSettings, type TranscriptEntry } from "./jarvis/session";
import { JarvisView, type JarvisAction } from "./jarvis/view";

let plane: BmadControlPlane | null = null;
let missionView: vscode.WebviewView | null = null;
let missionWebview: vscode.Webview | null = null;
const emitters = new Map<string, vscode.EventEmitter<void>>();
const composer = { error: null as string | null, draft: "", focus: false };
/** What a running autopilot or command is doing, shown instead of the stored loop state while it runs. */
let activity: string | null = null;
let jarvis: JarvisSession | null = null;
const IDEA_PLACEHOLDER = "Describe what you want to build...";
const IDEA_EXAMPLE = "Build a simple todo web app with add, complete, delete, and local persistence.";

export function activate(context: vscode.ExtensionContext): void {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return;
  loadProjectEnv(root);
  plane = new BmadControlPlane(root);
  const diagnostics = vscode.languages.createDiagnosticCollection("bmad-next");
  context.subscriptions.push(diagnostics);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("bmad-next.missionControl", new MissionView(diagnostics)),
    registerTree("bmad-next.requirements", () => requirementItems()),
    registerTree("bmad-next.tickets", () => ticketItems()),
    registerTree("bmad-next.evidence", () => evidenceItems()),
    registerTree("bmad-next.findings", () => findingItems()),
    registerTree("bmad-next.agents", () => agentItems()),
    registerTree("bmad-next.release", () => releaseItems()),
    registerTree("bmad-next.brain", () => brainItems()),
    vscode.commands.registerCommand("bmad-next.refresh", () => refresh(diagnostics)),
    vscode.commands.registerCommand("bmad-next.mission", () => newMission(diagnostics)),
    vscode.commands.registerCommand("bmad-next.forgeAnswer", () => forgeAnswer(diagnostics)),
    vscode.commands.registerCommand("bmad-next.harden", () => harden(diagnostics)),
    vscode.commands.registerCommand("bmad-next.acceptTickets", () => acceptTickets(diagnostics)),
    vscode.commands.registerCommand("bmad-next.next", () => showNext()),
    vscode.commands.registerCommand("bmad-next.doctor", () => showDoctor()),
  );

  const participant = vscode.chat.createChatParticipant("bmad.next", async (request, _context, stream) => {
    if (!plane) {
      stream.markdown("Open a workspace folder before talking to BMAD.");
      return;
    }
    const text = `${request.command ? request.command + " " : ""}${request.prompt}`;
    if (parseIntent(text).name === "doctor") {
      stream.markdown(doctorMarkdown());
      return;
    }
    try {
      const outcome = plane.handleIntent(text);
      // Browser and requirement verification resolve asynchronously; present the settled result, not the promise.
      stream.markdown(present({ ...outcome, detail: await Promise.resolve(outcome.detail) }));
    } catch (error) {
      stream.markdown(message(error));
    }
  });
  context.subscriptions.push(participant);

  context.subscriptions.push(
    vscode.lm.registerTool("bmad_get_mission", tool(async () => JSON.stringify(safeMission()))),
    vscode.lm.registerTool("bmad_get_requirement", tool(async (options) => {
      const id = String((options.input as { id?: string }).id ?? "");
      const mission = requirePlane().mission();
      const requirement = mission.requirements.find((item) => item.id === id);
      return JSON.stringify({ requirement, proof: requirement ? requirePlane().proof(mission.id, id) : null });
    })),
    vscode.lm.registerTool("bmad_run_release_gate", tool(async () => JSON.stringify(requirePlane().releaseGate(requirePlane().mission().id)))),
    vscode.lm.registerTool("bmad_check_drift", tool(async () => JSON.stringify({ status: "needs-file-text", detail: "Drift checks compare declared decisions with file text supplied to the control plane. This tool does not invent a scan result." }))),
    vscode.lm.registerTool("bmad_get_story", tool(async (options) => {
      const ref = String((options.input as { ref?: string }).ref ?? "");
      const mission = requirePlane().mission();
      const ticket = mission.tickets.find((item) => item.ref === ref);
      const plan = mission.plans.find((item) => item.ref === ref);
      return JSON.stringify({ ticket, plan });
    })),
    vscode.lm.registerTool("bmad_search_memory", tool(async (options) => {
      const query = String((options.input as { query?: string }).query ?? "");
      return JSON.stringify(requirePlane().searchMemory(requirePlane().mission().id, query));
    })),
    vscode.lm.registerTool("bmad_run_security", tool(async (options) => {
      const ticket = String((options.input as { ticket?: string }).ticket ?? "");
      return JSON.stringify(requirePlane().runSecurity(requirePlane().mission().id, ticket || undefined));
    })),
  );

  const scm = vscode.scm.createSourceControl("bmad-next", "BMAD");
  scm.inputBox.placeholder = "BMAD ticket note";
  context.subscriptions.push(scm);
  const output = vscode.window.createOutputChannel("BMAD Next");
  context.subscriptions.push(output);
  registerWorkflowCommands(context, {
    root,
    plane: requirePlane,
    refresh: () => refresh(diagnostics),
    output,
    state: context.globalState,
    activity: (text) => {
      activity = text;
      if (missionWebview) paintMission(missionWebview);
    },
  });
  output.appendLine(`BMAD Next activated for ${root}. Runtime ${process.env.BMAD_RUNTIME || "unset"}, model ${process.env.BMAD_MODEL || "unset"}.`);
  registerJarvis(context, root, output);
  refresh(diagnostics);
}

export function deactivate(): void {
  jarvis?.deactivate();
  jarvis = null;
  plane = null;
}

class MissionView implements vscode.WebviewViewProvider {
  constructor(private readonly diagnostics: vscode.DiagnosticCollection) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
    missionView = webviewView;
    missionWebview = webviewView.webview;
    missionPainted = null;
    webviewView.webview.onDidReceiveMessage((msg: { type?: string; text?: unknown; identity?: unknown; reason?: unknown }) => {
      if (msg.type === "submit") submitMission(String(msg.text ?? ""), this.diagnostics);
      if (msg.type === "forgeAnswer") submitForgeAnswer(String(msg.text ?? ""), this.diagnostics);
      if (msg.type === "acceptTickets") submitTicketAcceptance(String(msg.identity ?? ""), this.diagnostics);
      if (msg.type === "approveRelease") submitReleaseApproval(String(msg.identity ?? ""), String(msg.reason ?? ""), this.diagnostics);
      if (msg.type === "resumeAutopilot") void vscode.commands.executeCommand("bmad-next.autopilot");
      if (msg.type === "cancel") {
        composer.error = null;
        composer.draft = "";
      }
    });
    webviewView.onDidDispose(() => {
      missionView = null;
      missionWebview = null;
      missionPainted = null;
    });
    paintMission(webviewView.webview);
  }
}

function registerTree(id: string, items: () => vscode.TreeItem[]): vscode.Disposable {
  const emitter = new vscode.EventEmitter<void>();
  emitters.set(id, emitter);
  const provider: vscode.TreeDataProvider<vscode.TreeItem> = {
    onDidChangeTreeData: emitter.event,
    getTreeItem: (item) => item,
    getChildren: () => items(),
  };
  return vscode.window.registerTreeDataProvider(id, provider);
}

function refresh(diagnostics: vscode.DiagnosticCollection): void {
  for (const emitter of emitters.values()) emitter.fire();
  if (missionWebview) paintMission(missionWebview);
  publishDiagnostics(diagnostics);
}

/** The last page set on the Mission view, without its nonce, so an unchanged refresh does not reload the webview. */
let missionPainted: string | null = null;

function paintMission(webview: vscode.Webview): void {
  const nonce = crypto.randomBytes(16).toString("base64");
  const html = missionPage(nonce);
  // Reloading the webview resets its scroll position, focus, and any text a person is typing, so only reload on change.
  const content = html.split(nonce).join("");
  if (content === missionPainted) return;
  missionPainted = content;
  webview.html = html;
}

function missionPage(nonce: string): string {
  if (!plane) return composerPage(nonce, "<p>Open a workspace folder.</p>");
  let mission: Mission | null = null;
  try {
    mission = plane.mission();
  } catch {
    mission = null;
  }
  if (missionView) missionView.description = mission ? `${mission.id} · ${activity ?? mission.loop}` : "no mission";
  const form = renderComposer(mission, nonce);
  composer.focus = false;
  const gates = renderHumanGates(mission, nonce);
  if (!mission) return composerPage(nonce, `${form}${gates}`);
  let html: string;
  try {
    html = renderMissionControl(mission);
  } catch (error) {
    return composerPage(nonce, `${form}${gates}<p class="error">Mission Control could not render ${escapeHtml(mission.id)}: ${escapeHtml(message(error))}</p>`);
  }
  // Mission Control ships a script-free CSP; widen it only for this nonce so the composer can post back.
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />`;
  const csped = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, csp);
  return csped.includes("<body>") && csped !== html ? csped.replace("<body>", `<body>${form}${gates}`) : composerPage(nonce, `${form}${gates}<p class="error">Mission Control layout changed; showing the composer only.</p>`);
}

function composerPage(nonce: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<title>BMAD Next</title>
<style>body { margin: 0; padding: 12px 16px; color: var(--vscode-foreground); font: 13px/1.45 var(--vscode-font-family); }</style>
</head>
<body>${body}</body>
</html>`;
}

function renderComposer(mission: Mission | null, nonce: string): string {
  const error = composer.error ? `<p class="error" role="alert" id="error">${escapeHtml(composer.error)}</p>` : `<p class="error" role="alert" id="error" hidden></p>`;
  const form = `
  <label for="idea">${mission ? "New mission idea" : "Project idea"}</label>
  <textarea id="idea" rows="6" placeholder="${escapeHtml(IDEA_PLACEHOLDER)}">${escapeHtml(composer.draft)}</textarea>
  <p class="hint">Example: <button type="button" class="link" id="example">${escapeHtml(IDEA_EXAMPLE)}</button></p>
  ${error}
  <div class="actions">
    <button type="button" id="submit">Create mission</button>
    <button type="button" id="cancel" class="secondary">Cancel</button>
  </div>
  <p class="hint">Enter creates the mission · Shift+Enter adds a line · Esc cancels. A new mission starts as a draft; nothing is marked complete until evidence exists.</p>`;
  const body = mission
    ? `<p class="active">Active mission <code>${escapeHtml(mission.id)}</code> · loop <strong>${escapeHtml(mission.loop)}</strong> · phase <strong>${escapeHtml(mission.phase)}</strong></p>
<details id="composer"${composer.focus || composer.error ? " open" : ""}><summary>+ Start a new mission</summary>${form}</details>`
    : `<div id="composer"><h2>Start here: describe your project</h2><p>Type the idea you want BMAD to plan and build in the box below, then press <strong>Create mission</strong>.</p>${form}</div>`;
  return `<style>
  .bmad-composer { margin: 0 0 16px; padding: 12px; border: 1px solid var(--vscode-focusBorder, #d6a25e); background: var(--vscode-sideBar-background, #1c1a15); color: var(--vscode-foreground, #f4f0e6); font: 13px/1.45 var(--vscode-font-family, sans-serif); }
  .bmad-composer h2 { margin: 0 0 6px; font-size: 14px; letter-spacing: 0; text-transform: none; color: inherit; }
  .bmad-composer label { display: block; font-weight: 600; margin: 8px 0 4px; }
  .bmad-composer textarea { box-sizing: border-box; width: 100%; min-height: 110px; resize: vertical; padding: 6px 8px; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #555); }
  .bmad-composer textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  .bmad-composer .actions { display: flex; gap: 8px; margin: 8px 0; }
  .bmad-composer button { padding: 4px 12px; font: inherit; cursor: pointer; border: none; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .bmad-composer button:hover { background: var(--vscode-button-hoverBackground); }
  .bmad-composer button:disabled { opacity: 0.6; cursor: default; }
  .bmad-composer button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  .bmad-composer button.link { padding: 0; background: none; color: var(--vscode-textLink-foreground); text-align: left; }
  .bmad-composer .hint { margin: 4px 0; opacity: 0.8; font-size: 12px; }
  .bmad-composer .active { margin: 0 0 6px; }
  .bmad-composer summary { cursor: pointer; font-weight: 600; }
  .error { color: var(--vscode-errorForeground, #f48771); }
</style>
<section class="bmad-composer">${body}</section>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  window.bmadVscode = vscode;
  // Webview state survives the page being reloaded with new content; merge into it so each form keeps its own part.
  const save = (patch) => vscode.setState(Object.assign({}, vscode.getState() || {}, patch));
  window.bmadSave = save;
  const idea = document.getElementById("idea");
  const submit = document.getElementById("submit");
  const errorBox = document.getElementById("error");
  const wrapper = document.getElementById("composer");
  const saved = vscode.getState();
  if (!idea.value && saved && saved.draft) idea.value = saved.draft;
  idea.addEventListener("input", () => save({ draft: idea.value }));
  function showError(text) { errorBox.textContent = text; errorBox.hidden = !text; }
  function send() {
    const text = idea.value.trim();
    if (!text) { showError("Type a project idea first."); idea.focus(); return; }
    showError("");
    submit.disabled = true;
    submit.textContent = "Creating mission…";
    save({ draft: "" });
    vscode.postMessage({ type: "submit", text });
  }
  function cancel() {
    idea.value = "";
    showError("");
    save({ draft: "" });
    vscode.postMessage({ type: "cancel" });
    if (wrapper.tagName === "DETAILS") wrapper.open = false;
  }
  function focusIdea() { if (wrapper.tagName === "DETAILS") wrapper.open = true; idea.focus(); window.bmadFocused = true; }
  submit.addEventListener("click", send);
  document.getElementById("cancel").addEventListener("click", cancel);
  document.getElementById("example").addEventListener("click", () => { idea.value = ${JSON.stringify(IDEA_EXAMPLE)}; save({ draft: idea.value }); idea.focus(); });
  idea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
    else if (event.key === "Escape") { event.preventDefault(); cancel(); }
  });
  window.addEventListener("message", (event) => { if (event.data && event.data.type === "focus") focusIdea(); });
  if (${mission ? String(composer.focus || Boolean(composer.error)) : "true"}) focusIdea();
  // A refresh reloads the page; return to where the person was reading unless a form just took focus.
  window.addEventListener("scroll", () => save({ scroll: window.scrollY }), { passive: true });
  window.addEventListener("DOMContentLoaded", () => { if (!window.bmadFocused && saved && saved.scroll) window.scrollTo(0, saved.scroll); });
</script>`;
}

function renderHumanGates(mission: Mission | null, nonce: string): string {
  if (!mission) return "";
  const forge = mission.forge;
  const open = forge?.outcome === "active" ? forge.questions.find((question) => !forge.answered.includes(question.id)) : undefined;
  if (open && forge) {
    return humanGatePage(
      nonce,
      `<h2>Forge question ${(forge.answered.length + 1).toString()} of ${forge.questions.length.toString()}</h2>
      <p>${escapeHtml(open.prompt)}</p>
      <p class="hint">${escapeHtml(open.why)}</p>
      <label for="gate-text">Your answer</label>
      <textarea id="gate-text" rows="5" placeholder="${escapeHtml(open.why)}"></textarea>
      <div class="actions"><button type="button" id="gate-submit">Record answer</button></div>`,
      `{ type: "forgeAnswer", text: text }`,
      `forge:${open.id}`,
    );
  }
  if (mission.tickets.length > 0 && !mission.ticketTreeAccepted) {
    const tree = mission.tickets.map((ticket) => `<li><code>${escapeHtml(ticket.ref)}</code> ${escapeHtml(ticket.title)}</li>`).join("");
    return humanGatePage(
      nonce,
      `<h2>Accept ticket tree</h2>
      <p>A named person accepts this tree before BMAD builds it.</p>
      <ul>${tree}</ul>
      <label for="gate-text">Your name</label>
      <textarea id="gate-text" rows="2" placeholder="Name recorded with the acceptance"></textarea>
      <div class="actions"><button type="button" id="gate-submit">Accept and continue</button></div>`,
      `{ type: "acceptTickets", identity: text }`,
      "accept-tickets",
    );
  }
  let report: ReturnType<typeof evaluateRelease> | null = null;
  try {
    report = evaluateRelease(mission, (file) => fs.existsSync(file));
  } catch {
    report = null;
  }
  const human = report?.criteria.find((item) => item.id === "human-release");
  const automatedOpen = report?.criteria.filter((item) => item.id !== "human-release" && item.state !== "pass" && item.state !== "waived") ?? [];
  // While the autopilot runs, offering to continue it would only start a second run.
  if ((mission.loop === "blocked" || mission.loop === "draft") && !autopilotRunning()) {
    const resume = humanGatePage(
      nonce,
      `<h2>Continue this mission</h2>
      <p>Active mission <code>${escapeHtml(mission.id)}</code> · loop <strong>${escapeHtml(mission.loop)}</strong>.</p>
      <div class="actions"><button type="button" id="gate-submit">Continue autopilot</button></div>`,
      `{ type: "resumeAutopilot" }`,
      "resume",
    );
    if (!open && (mission.tickets.length === 0 || mission.ticketTreeAccepted)) {
      // Fall through to resume when no forge/accept form is showing.
      if (!(human && human.state !== "pass" && human.state !== "waived" && automatedOpen.length === 0)) return resume;
    }
  }
  if (human && human.state !== "pass" && human.state !== "waived" && automatedOpen.length === 0) {
    return humanGatePage(
      nonce,
      `<h2>Release needs your approval</h2>
      <p>Every automated gate passed for <code>${escapeHtml(mission.id)}</code>.</p>
      <label for="gate-text">Your name</label>
      <textarea id="gate-text" rows="2" placeholder="Name recorded with the approval"></textarea>
      <label for="gate-reason">Why do you approve this release?</label>
      <textarea id="gate-reason" rows="3" placeholder="Reason recorded with the approval"></textarea>
      <div class="actions"><button type="button" id="gate-submit">Approve release</button></div>`,
      `{ type: "approveRelease", identity: text, reason: (document.getElementById("gate-reason") && document.getElementById("gate-reason").value || "").trim() }`,
      "approve-release",
    );
  }
  return "";
}

function humanGatePage(nonce: string, body: string, payload: string, key: string): string {
  return `<section class="bmad-composer" id="human-gate">${body}</section>
<script nonce="${nonce}">
  const vscodeGate = window.bmadVscode || acquireVsCodeApi();
  const gateState = () => vscodeGate.getState() || {};
  const saveGate = (patch) => vscodeGate.setState(Object.assign({}, gateState(), patch));
  const gateKey = ${JSON.stringify(key)};
  const gateText = document.getElementById("gate-text");
  const gateReason = document.getElementById("gate-reason");
  const gateSubmit = document.getElementById("gate-submit");
  const gateFields = [gateText, gateReason].filter(Boolean);
  // The page reloads whenever the mission changes; keep what the person typed into this gate and where they typed it.
  const previous = gateState();
  const draft = previous.gateDraft && previous.gateDraft.key === gateKey ? previous.gateDraft : null;
  if (draft && gateText && draft.text) gateText.value = draft.text;
  if (draft && gateReason && draft.reason) gateReason.value = draft.reason;
  const keep = () => saveGate({ gateDraft: { key: gateKey, text: gateText ? gateText.value : "", reason: gateReason ? gateReason.value : "" } });
  const focusField = (field) => { field.focus(); field.selectionStart = field.selectionEnd = field.value.length; window.bmadFocused = true; };
  for (const field of gateFields) {
    field.addEventListener("input", keep);
    field.addEventListener("focus", () => saveGate({ gateFocus: field.id }));
    field.addEventListener("blur", () => saveGate({ gateFocus: null }));
  }
  if (previous.gateSeen !== gateKey) {
    saveGate({ gateSeen: gateKey, gateFocus: null });
    if (gateText) focusField(gateText);
  } else {
    const focused = gateFields.find((field) => field.id === previous.gateFocus);
    if (focused) focusField(focused);
  }
  if (gateSubmit) {
    gateSubmit.addEventListener("click", () => {
      const text = gateText ? gateText.value.trim() : "continue";
      if (gateText && !text) { gateText.focus(); return; }
      if (gateReason && !gateReason.value.trim()) { gateReason.focus(); return; }
      gateSubmit.disabled = true;
      saveGate({ gateDraft: null, gateFocus: null });
      vscodeGate.postMessage(${payload});
    });
    if (gateText) {
      gateText.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); gateSubmit.click(); }
      });
    }
  }
</script>`;
}

function requirePlane(): BmadControlPlane {
  if (!plane) throw new Error("Open a workspace folder.");
  return plane;
}

async function newMission(diagnostics: vscode.DiagnosticCollection): Promise<void> {
  // The composer lives in the Mission view; reveal it and focus the idea box.
  composer.focus = true;
  try {
    await vscode.commands.executeCommand("bmad-next.missionControl.focus");
  } catch {
    // Fall through to the input box below.
  }
  if (missionWebview) {
    if (composer.focus) paintMission(missionWebview);
    void missionWebview.postMessage({ type: "focus" });
    return;
  }
  composer.focus = false;
  const idea = await vscode.window.showInputBox({ prompt: "Mission idea", placeHolder: IDEA_PLACEHOLDER, value: composer.draft, ignoreFocusOut: true });
  if (idea === undefined) return;
  submitMission(idea, diagnostics);
}

function submitMission(text: string, diagnostics: vscode.DiagnosticCollection): void {
  let mission: Mission;
  try {
    mission = requirePlane().createMission(text);
  } catch (error) {
    composer.error = message(error);
    composer.draft = text;
    refresh(diagnostics);
    void vscode.window.showErrorMessage(`BMAD: mission not created. ${composer.error}`);
    return;
  }
  composer.error = null;
  composer.draft = "";
  refresh(diagnostics);
  let next = "";
  try {
    next = ` Next: ${requirePlane().recommend(mission.id).skillId}`;
  } catch (error) {
    next = ` Next step unavailable: ${message(error)}`;
  }
  void vscode.window.showInformationMessage(`Mission ${mission.id} created (${mission.complexity}, loop ${mission.loop}).${next}`);
  // From here the mission drives itself: forge questions, then every automated step, pausing only for people.
  void vscode.commands.executeCommand("bmad-next.autopilot");
}

function submitForgeAnswer(text: string, diagnostics: vscode.DiagnosticCollection): void {
  try {
    const mission = requirePlane().mission();
    const updated = requirePlane().answerForge(mission.id, text);
    refresh(diagnostics);
    const open = (updated.forge?.questions ?? []).filter((question) => !updated.forge?.answered.includes(question.id));
    resumeAutopilot(open.length === 0);
  } catch (error) {
    void vscode.window.showErrorMessage(message(error));
  }
}

/** A running autopilot picks up a person's decision itself; after a reload nothing is waiting, so start one. */
function resumeAutopilot(ready: boolean): void {
  if (ready && !autopilotRunning()) void vscode.commands.executeCommand("bmad-next.autopilot");
}

function submitTicketAcceptance(identity: string, diagnostics: vscode.DiagnosticCollection): void {
  if (!identity.trim()) return;
  try {
    const mission = requirePlane().mission();
    requirePlane().acceptTicketTree(mission.id, identity.trim());
    refresh(diagnostics);
    resumeAutopilot(true);
  } catch (error) {
    void vscode.window.showErrorMessage(message(error));
  }
}

function submitReleaseApproval(identity: string, reason: string, diagnostics: vscode.DiagnosticCollection): void {
  if (!identity.trim() || !reason.trim()) return;
  try {
    const mission = requirePlane().mission();
    requirePlane().approve(mission.id, "release", identity.trim(), reason.trim());
    refresh(diagnostics);
    // A waiting autopilot runs the release gate itself once it sees the approval.
    if (!autopilotRunning()) void vscode.commands.executeCommand("bmad-next.release");
  } catch (error) {
    void vscode.window.showErrorMessage(message(error));
  }
}

async function forgeAnswer(diagnostics: vscode.DiagnosticCollection): Promise<void> {
  let mission: Mission;
  try {
    mission = requirePlane().mission();
  } catch (error) {
    void vscode.window.showErrorMessage(message(error));
    return;
  }
  const questions = mission.forge?.questions ?? [];
  const open = questions.find((question) => !mission.forge?.answered.includes(question.id));
  if (!mission.forge || mission.forge.outcome !== "active") {
    void vscode.window.showInformationMessage(`Forge is ${mission.forge?.outcome ?? "not part of this mission"}. Nothing to answer.`);
    return;
  }
  if (!open) {
    void vscode.window.showInformationMessage("Every forge question is answered. Run BMAD: Harden Forge.");
    return;
  }
  const answer = await vscode.window.showInputBox({
    title: `Forge question ${(mission.forge.answered.length + 1).toString()} of ${questions.length.toString()}`,
    prompt: open.prompt,
    placeHolder: open.why,
    ignoreFocusOut: true,
  });
  if (!answer?.trim()) return;
  try {
    const updated = requirePlane().answerForge(mission.id, answer);
    const left = (updated.forge?.questions ?? []).filter((question) => !updated.forge?.answered.includes(question.id)).length;
    void vscode.window.showInformationMessage(left > 0 ? `Answer recorded. ${left.toString()} forge question(s) left.` : "Answer recorded. Every question is answered; run BMAD: Harden Forge.");
  } catch (error) {
    void vscode.window.showErrorMessage(message(error));
  }
  refresh(diagnostics);
}

async function harden(diagnostics: vscode.DiagnosticCollection): Promise<void> {
  try {
    const mission = requirePlane().answerForge(requirePlane().mission().id, "harden");
    void vscode.window.showInformationMessage(`Forge hardened. ${mission.requirements.map((requirement) => requirement.id).join(", ") || "No requirement"} recorded.`);
  } catch (error) {
    void vscode.window.showErrorMessage(message(error));
  }
  refresh(diagnostics);
}

async function acceptTickets(diagnostics: vscode.DiagnosticCollection): Promise<void> {
  let mission: Mission;
  try {
    mission = requirePlane().mission();
  } catch (error) {
    void vscode.window.showErrorMessage(message(error));
    return;
  }
  const tree = mission.tickets.map((ticket) => `${ticket.ref} ${ticket.title}`).join("; ") || "tickets proposed from the requirements";
  const identity = await vscode.window.showInputBox({ title: "Accept ticket tree", prompt: `Your name, recorded as accepting: ${tree}`, ignoreFocusOut: true });
  if (!identity?.trim()) return;
  try {
    const accepted = requirePlane().acceptTicketTree(mission.id, identity.trim());
    void vscode.window.showInformationMessage(`Ticket tree accepted by ${identity.trim()}: ${accepted.tickets.map((ticket) => ticket.ref).join(", ")}.`);
  } catch (error) {
    void vscode.window.showErrorMessage(message(error));
  }
  refresh(diagnostics);
}

function showNext(): void {
  try {
    const next = requirePlane().recommend();
    void vscode.window.showInformationMessage(`${next.skillId}: ${next.reason}`);
  } catch (error) {
    void vscode.window.showErrorMessage(message(error));
  }
}

function showDoctor(): void {
  void vscode.window.showInformationMessage(doctorMarkdown().replace(/\*/g, ""));
}

function doctorMarkdown(): string {
  return requirePlane()
    .doctor()
    .map((check) => `- ${check.name}: ${check.status} — ${check.detail}`)
    .join("\n");
}

function requirementItems(): vscode.TreeItem[] {
  return list((mission) => mission.requirements.map((requirement) => item(`${requirement.id} ${requirement.status}`, requirement.title)));
}

function ticketItems(): vscode.TreeItem[] {
  return list((mission) => mission.tickets.map((ticket) => item(ticket.ref, `${ticket.title} · ${ticket.risk}`)));
}

function evidenceItems(): vscode.TreeItem[] {
  return list((mission) =>
    mission.evidence.length
      ? mission.evidence.map((record) => item(`${record.kind} ${record.result}`, record.artifact ?? "no artifact"))
      : [item("No runs", "Evidence appears after a runner finishes.")],
  );
}

function findingItems(): vscode.TreeItem[] {
  return list((mission) =>
    mission.findings.length
      ? mission.findings.map((finding) => item(finding.code, finding.message))
      : [item("No findings", "Drift and gaps appear after a cross-check.")],
  );
}

function agentItems(): vscode.TreeItem[] {
  const fallback = (plane?.config().defaultRuntime ?? process.env.BMAD_RUNTIME ?? "").trim();
  return list((mission) =>
    mission.agents.map((agent) => item(agent.name, `${agent.role} · runtime ${agent.runtime ?? (fallback ? `${fallback} (default)` : "not configured")}`)),
  );
}

function releaseItems(): vscode.TreeItem[] {
  return list((mission) => {
    const report = evaluateRelease(mission, (file) => fs.existsSync(file));
    return [
      item(gateLabel(report), "Release passes only from recorded evidence."),
      ...report.criteria.map((criterion) => item(criterion.label, `${criterionLabel(criterion)}: ${criterion.detail}`)),
    ];
  });
}

function brainItems(): vscode.TreeItem[] {
  return list((mission) => {
    const counts = Object.entries(mission.brain).map(([topic, entries]) => item(topic, `${Array.isArray(entries) ? entries.length : 0} entries`));
    return counts.length ? counts : [item("Empty", "Memory is written from recorded events.")];
  });
}

function list(map: (mission: Mission) => vscode.TreeItem[]): vscode.TreeItem[] {
  if (!plane) return [item("No workspace", "Open a folder.")];
  try {
    return map(plane.mission());
  } catch {
    const start = item("No mission", "Click to describe your project idea.");
    start.command = { command: "bmad-next.mission", title: "BMAD: New Mission" };
    return [start];
  }
}

function item(label: string, detail: string): vscode.TreeItem {
  const tree = new vscode.TreeItem(label);
  tree.description = detail;
  tree.tooltip = detail;
  return tree;
}

function publishDiagnostics(diagnostics: vscode.DiagnosticCollection): void {
  diagnostics.clear();
  if (!plane) return;
  let mission: Mission;
  try {
    mission = plane.mission();
  } catch {
    return;
  }
  const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file("/"), ".bmad-next", "missions", mission.id, "mission.json");
  const items = mission.findings.map((finding) => {
    const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), `${finding.code}: ${finding.message}`, vscode.DiagnosticSeverity.Warning);
    diagnostic.source = "BMAD";
    diagnostic.code = finding.code;
    return diagnostic;
  });
  diagnostics.set(uri, items);
}

function safeMission(): unknown {
  try {
    const mission = requirePlane().mission();
    return { id: mission.id, phase: mission.phase, loop: mission.loop, complexity: mission.complexity };
  } catch (error) {
    return { status: "not-configured", detail: message(error) };
  }
}

function tool(invoke: (options: vscode.LanguageModelToolInvocationOptions<object>) => Promise<string>): vscode.LanguageModelTool<object> {
  return {
    async invoke(options) {
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(await invoke(options))]);
    },
  };
}

function present(outcome: { name: string; skillId?: string; detail: unknown }): string {
  const detail = outcome.detail;
  if (detail && typeof detail === "object" && "criteria" in detail && "state" in detail) {
    const report = detail as { state: string; criteria: Array<{ label: string; state: string; detail: string }> };
    return `Release gate: **${report.state}**\n\n${report.criteria.map((item) => `- ${item.label}: ${item.state} — ${item.detail}`).join("\n")}`;
  }
  if (detail && typeof detail === "object" && "skillId" in detail && "reason" in detail) {
    const next = detail as { skillId: string; reason: string };
    return `Recommended: \`${next.skillId}\`\n\n${next.reason}`;
  }
  if (detail && typeof detail === "object" && "workflow" in detail && "loop" in detail) {
    const mission = detail as Mission;
    return `Mission \`${mission.id}\` is ${mission.loop}.\n\n${mission.workflow.map((step) => `- ${step.skillId}: ${step.status}`).join("\n")}`;
  }
  return `**${outcome.name}**${outcome.skillId ? ` · \`${outcome.skillId}\`` : ""}\n\n\`\`\`json\n${JSON.stringify(detail, null, 2)}\n\`\`\``;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jarvisSettings(): JarvisSettings {
  const config = vscode.workspace.getConfiguration("bmadNext.jarvis");
  return {
    narration: config.get<JarvisSettings["narration"]>("narration", "important"),
    voiceOutput: config.get<JarvisSettings["voiceOutput"]>("voiceOutput", "system"),
    autoListen: config.get<JarvisSettings["autoListen"]>("autoListen", "pushToTalk"),
  };
}

/**
 * Jarvis Mode: an explicit, persistent voice session over the control plane. It is never activated on startup.
 * Exiting or pausing it leaves the mission exactly as it is.
 */
function registerJarvis(context: vscode.ExtensionContext, root: string, output: vscode.OutputChannel): void {
  const config = vscode.workspace.getConfiguration("bmadNext.jarvis");
  const voiceInput = config.get<string>("voiceInput", "gemini");
  const history = context.workspaceState.get<TranscriptEntry[]>("bmad-next.jarvis.transcript", []);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "bmad-next.jarvis.toggle";
  context.subscriptions.push(status);
  let saveTimer: NodeJS.Timeout | null = null;
  let logged = history.length;
  const view = new JarvisView((action) => void onAction(action));
  const session = new JarvisSession(
    {
      root,
      plane: requirePlane,
      autopilotRunning,
      startAutopilot: () => void vscode.commands.executeCommand("bmad-next.autopilot"),
      stopAutopilot: () => void vscode.commands.executeCommand("bmad-next.stopAutopilot"),
      showEvidence: () => void vscode.commands.executeCommand("bmad-next.evidence.focus"),
    },
    {
      input: voiceInput === "off" ? null : new FfmpegMicrophoneInput(config.get<string>("microphoneDevice", ":0")),
      intent: voiceInput === "gemini" ? new GeminiIntentProvider() : new TextCommandIntentProvider(),
      fallback: new TextCommandIntentProvider(),
      output: new SystemSpeechOutput(),
    },
    jarvisSettings(),
    (snapshot) => {
      view.post(snapshot);
      status.text = snapshot.state === "JARVIS_OFF" ? "$(zap) Jarvis" : snapshot.paused ? "$(debug-pause) Jarvis paused" : snapshot.state === "JARVIS_LISTENING" ? "$(record) Jarvis listening" : "$(circle-filled) Jarvis active";
      status.tooltip = snapshot.state === "JARVIS_OFF" ? "Activate Jarvis Mode (Cmd+Shift+J)" : `Jarvis ${snapshot.state}. Click to exit.`;
      status.show();
      // Mirror the conversation into the BMAD Next output channel, so commands and replies stay auditable.
      const entries = session.history;
      if (entries.length < logged) logged = 0;
      for (const entry of entries.slice(logged)) output.appendLine(`[${entry.at}] Jarvis ${entry.who === "you" ? "YOU" : "JARVIS"}${entry.category ? ` (${entry.category})` : ""}: ${entry.text}`);
      logged = entries.length;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => void context.workspaceState.update("bmad-next.jarvis.transcript", session.history), 500);
    },
    history,
  );
  jarvis = session;

  const confirmExit = async () => {
    const pick = await vscode.window.showWarningMessage("Exit Jarvis Mode?", { modal: true, detail: "Listening, narration, and speech stop. The mission keeps running and the transcript is kept." }, "Exit");
    if (pick === "Exit") {
      session.deactivate();
      output.appendLine(`[${new Date().toISOString()}] Jarvis Mode off.`);
    }
  };
  const activate = async () => {
    output.appendLine(`[${new Date().toISOString()}] Jarvis Mode activating.`);
    await vscode.commands.executeCommand("bmad-next.jarvis.focus");
    await session.activate();
    const snapshot = session.snapshot();
    output.appendLine(`[${new Date().toISOString()}] Jarvis ${snapshot.state}: ${snapshot.readiness.map((check) => `${check.ok ? "✓" : "⚠"} ${check.label} (${check.detail})`).join("; ")}`);
  };
  async function onAction(action: JarvisAction): Promise<void> {
    if (action.type === "activate") await activate();
    else if (action.type === "exit") await confirmExit();
    else if (action.type === "pause") session.pause();
    else if (action.type === "resume") session.resume();
    else if (action.type === "stopSpeaking") session.stopSpeaking();
    else if (action.type === "pttStart") session.startListening();
    else if (action.type === "pttStop") await session.stopListening();
    else if (action.type === "text") await session.submitText(action.text);
  }

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("bmad-next.jarvis", view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("bmad-next.jarvis.activate", activate),
    vscode.commands.registerCommand("bmad-next.jarvis.exit", confirmExit),
    vscode.commands.registerCommand("bmad-next.jarvis.toggle", () => (session.machine.state === "JARVIS_OFF" ? activate() : confirmExit())),
    vscode.commands.registerCommand("bmad-next.jarvis.pause", () => session.pause()),
    vscode.commands.registerCommand("bmad-next.jarvis.resume", () => session.resume()),
    vscode.commands.registerCommand("bmad-next.jarvis.stopSpeaking", () => session.stopSpeaking()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("bmadNext.jarvis")) session.configure(jarvisSettings());
    }),
    { dispose: () => session.deactivate() },
  );
  view.post(session.snapshot());
  status.text = "$(zap) Jarvis";
  status.tooltip = "Activate Jarvis Mode (Cmd+Shift+J)";
  status.show();
}
