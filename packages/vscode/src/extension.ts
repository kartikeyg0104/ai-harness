import * as vscode from "vscode";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BmadControlPlane, applyHarnessEnv, evaluateRelease, jarvisEndpoint, loadHarnessConfig, loadProjectEnv, parseIntent } from "@bmad-next/control-plane";
import type { Mission } from "@bmad-next/control-plane";
import { autopilotRunning, registerWorkflowCommands } from "./workflow";
import { FfmpegMicrophoneInput, GeminiIntentProvider, SystemSpeechOutput, TextCommandIntentProvider } from "./jarvis/providers";
import { JarvisSession, type JarvisSettings, type TranscriptEntry } from "./jarvis/session";
import { ContinuousMicrophone, LocalIntentProvider, WhisperService, localVoiceConfig } from "./jarvis/local";
import { HomeView, type HistoryItem, type HomeAction, type HomeGate, type HomeState } from "./home/view";

let plane: BmadControlPlane | null = null;
let home: HomeView | null = null;
const composer = { error: null as string | null };
/** What a running autopilot or command is doing, shown instead of the stored loop state while it runs. */
let activity: string | null = null;
let jarvis: JarvisSession | null = null;
let globalState: vscode.Memento | null = null;
const IDEA_PLACEHOLDER = "Describe what you want to build...";

export function activate(context: vscode.ExtensionContext): void {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return;
  loadProjectEnv(root);
  const oneKey = useApiKeySetup(root);
  plane = new BmadControlPlane(root);
  globalState = context.globalState;
  const diagnostics = vscode.languages.createDiagnosticCollection("bmad-next");
  context.subscriptions.push(diagnostics);
  home = new HomeView(context.extensionUri, (action) => void onHomeAction(action, root, diagnostics));

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("bmad-next.home", home, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("bmad-next.refresh", () => refresh(diagnostics)),
    vscode.commands.registerCommand("bmad-next.mission", () => newMission(diagnostics)),
    vscode.commands.registerCommand("bmad-next.history", async () => {
      await vscode.commands.executeCommand("bmad-next.home.focus");
      home?.show("history");
    }),
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
      pushHome();
    },
  });
  output.appendLine(`BMAD Next activated for ${root}. Runtime ${process.env.BMAD_RUNTIME || "unset"}, model ${process.env.BMAD_MODEL || "unset"}.`);
  if (oneKey) output.appendLine(oneKey);
  registerJarvis(context, root, output);
  refresh(diagnostics);
}

/**
 * One key is enough: with AI_API_KEY in .env and no runner configured by hand, the builder, reviewer, attacker, and
 * Jarvis all use the harness model (harness.config.json, or AI_PROVIDER / AI_MODEL / AI_BASE_URL). Returns a line for
 * the log, or null when the project configures its runners itself.
 */
function useApiKeySetup(root: string): string | null {
  if (!(process.env.AI_API_KEY ?? "").trim() || (process.env.BMAD_RUNNER ?? "").trim()) return null;
  try {
    const config = loadHarnessConfig(root);
    applyHarnessEnv(root, config);
    const jarvisModel = jarvisEndpoint(config);
    if (jarvisModel && !(process.env.BMAD_JARVIS_URL ?? "").trim()) {
      process.env.BMAD_JARVIS_URL = jarvisModel.url;
      process.env.BMAD_JARVIS_MODEL = jarvisModel.model;
    }
    return `Using AI_API_KEY with ${config.provider}/${config.model} for every agent and Jarvis.`;
  } catch (error) {
    return `AI_API_KEY is set, but the model setup failed: ${message(error)}`;
  }
}

export function deactivate(): void {
  jarvis?.deactivate();
  jarvis = null;
  plane = null;
  home = null;
}

async function onHomeAction(action: HomeAction, root: string, diagnostics: vscode.DiagnosticCollection): Promise<void> {
  if (action.type === "submit") submitMission(action.text, diagnostics);
  else if (action.type === "ask") await askJarvis(action.text);
  else if (action.type === "forgeAnswer") submitForgeAnswer(action.text, diagnostics);
  else if (action.type === "acceptTickets") submitTicketAcceptance(action.identity, diagnostics);
  else if (action.type === "approveRelease") submitReleaseApproval(action.identity, action.reason, diagnostics);
  else if (action.type === "resumeAutopilot") void vscode.commands.executeCommand("bmad-next.autopilot");
  else if (action.type === "stopAutopilot") void vscode.commands.executeCommand("bmad-next.stopAutopilot");
  else if (action.type === "openFile") openInsideWorkspace(root, action.path);
  else if (action.type === "loadHistory") home?.history(missionHistory());
  else if (action.type === "openMission") openMissionFromHistory(action.id, diagnostics);
  else if (action.type === "cancel") composer.error = null;
  else if (action.type === "jarvis") await vscode.commands.executeCommand(JARVIS_COMMANDS[action.action]);
}

const JARVIS_COMMANDS: Record<Extract<HomeAction, { type: "jarvis" }>["action"], string> = {
  activate: "bmad-next.jarvis.activate",
  exit: "bmad-next.jarvis.exit",
  pause: "bmad-next.jarvis.pause",
  resume: "bmad-next.jarvis.resume",
  stopSpeaking: "bmad-next.jarvis.stopSpeaking",
  pttStart: "bmad-next.jarvis.pttStart",
  pttStop: "bmad-next.jarvis.pttStop",
  handsFree: "bmad-next.jarvis.handsFree",
  wakeWord: "bmad-next.jarvis.wakeWord",
};

/** Typing to Jarvis is an explicit request to talk to it, so a switched-off Jarvis is switched on first. */
async function askJarvis(text: string): Promise<void> {
  if (!jarvis || !text.trim()) return;
  if (jarvis.machine.state === "JARVIS_OFF") await vscode.commands.executeCommand("bmad-next.jarvis.activate");
  await jarvis.submitText(text);
}

/** Every mission in this project, newest activity first. A mission that cannot be read is left out, not guessed at. */
function missionHistory(): HistoryItem[] {
  if (!plane) return [];
  const current = safeActiveId();
  const items: HistoryItem[] = [];
  for (const id of plane.listMissions()) {
    try {
      const mission = plane.mission(id);
      items.push({ id: mission.id, title: mission.title, loop: mission.loop, createdAt: mission.createdAt, updatedAt: mission.updatedAt, active: mission.id === current });
    } catch {
      // Skip unreadable mission folders.
    }
  }
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function safeActiveId(): string | null {
  try {
    return plane?.mission().id ?? null;
  } catch {
    return null;
  }
}

function openMissionFromHistory(id: string, diagnostics: vscode.DiagnosticCollection): void {
  // The autopilot drives one mission; switching under it would hand its next step to another mission.
  if (autopilotRunning()) {
    void vscode.window.showWarningMessage("BMAD: stop the autopilot before opening another mission.");
    home?.show("mission");
    return;
  }
  try {
    requirePlane().openMission(id);
  } catch (error) {
    void vscode.window.showErrorMessage(`BMAD: ${message(error)}`);
    return;
  }
  refresh(diagnostics);
  home?.show("mission");
}

/** Evidence records are files under the project; anything else is refused rather than opened. */
function openInsideWorkspace(root: string, file: string): void {
  const absolute = path.resolve(root, file);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return;
  if (!fs.existsSync(absolute)) {
    void vscode.window.showWarningMessage(`BMAD: ${path.relative(root, absolute)} no longer exists.`);
    return;
  }
  void vscode.window.showTextDocument(vscode.Uri.file(absolute), { preview: true });
}

function refresh(diagnostics: vscode.DiagnosticCollection): void {
  pushHome();
  publishDiagnostics(diagnostics);
}

function pushHome(): void {
  home?.post(homeState());
}

function homeState(): HomeState {
  let mission: Mission | null = null;
  try {
    mission = plane?.mission() ?? null;
  } catch {
    mission = null;
  }
  let report: ReturnType<typeof evaluateRelease> | null = null;
  try {
    report = mission ? evaluateRelease(mission, (file) => fs.existsSync(file)) : null;
  } catch {
    report = null;
  }
  const running = autopilotRunning();
  return {
    mission: mission
      ? { id: mission.id, title: mission.title, loop: mission.loop, phase: mission.phase, complexity: mission.complexity, mode: mission.mode, activity: running ? activity : null, running, createdAt: mission.createdAt }
      : null,
    gate: mission ? humanGate(mission, report, running) : null,
    release: report ? { state: report.state, criteria: report.criteria.map((item) => ({ id: item.id, label: item.label, state: item.state, detail: item.detail })) } : null,
    requirements: mission ? mission.requirements.map((item) => ({ id: item.id, title: item.title, status: item.status })) : [],
    tickets: mission ? mission.tickets.map((item) => ({ ref: item.ref, title: item.title, risk: item.risk })) : [],
    evidence: mission ? latestEvidence(mission) : [],
    findings: mission ? mission.findings.filter((item) => item.status !== "resolved").map((item) => ({ code: item.code, message: item.message, severity: item.severity })) : [],
    jarvis: jarvis?.snapshot() ?? null,
    composer: { error: composer.error },
    acceptor: globalState?.get<string>("bmad-next.acceptor") ?? "",
    model: process.env.BMAD_MODEL ?? "",
  };
}

/** The latest run of each check for each ticket: an attack that failed and then passed shows as passed. */
function latestEvidence(mission: Mission): HomeState["evidence"] {
  const latest = new Map<string, Mission["evidence"][number]>();
  for (const item of mission.evidence) latest.set(`${item.kind}:${item.story_id ?? ""}`, item);
  return [...latest.values()]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 12)
    .map((item) => ({ kind: item.kind, result: item.result, story: item.story_id ?? "", at: item.timestamp, artifact: item.artifact ?? "" }));
}

/** The one decision a person owes the mission right now, if any. */
function humanGate(mission: Mission, report: ReturnType<typeof evaluateRelease> | null, running: boolean): HomeGate | null {
  const forge = mission.forge;
  const open = forge?.outcome === "active" ? forge.questions.find((question) => !forge.answered.includes(question.id)) : undefined;
  if (open && forge) {
    return { kind: "forge", key: `forge:${open.id}`, index: forge.answered.length + 1, total: forge.questions.length, prompt: open.prompt, why: open.why };
  }
  if (mission.tickets.length > 0 && !mission.ticketTreeAccepted) {
    return { kind: "accept", key: `accept:${mission.id}`, tickets: mission.tickets.map((ticket) => ({ ref: ticket.ref, title: ticket.title })) };
  }
  const human = report?.criteria.find((item) => item.id === "human-release");
  const automatedOpen = report?.criteria.filter((item) => item.id !== "human-release" && item.state !== "pass" && item.state !== "waived") ?? [];
  if (human && human.state !== "pass" && human.state !== "waived" && automatedOpen.length === 0) return { kind: "approve", key: `approve:${mission.id}` };
  // While the autopilot runs, offering to continue it would only start a second run.
  if ((mission.loop === "blocked" || mission.loop === "draft" || stoppedByPerson(mission)) && !running && mission.loop !== "released") {
    return { kind: "resume", key: `resume:${mission.id}:${mission.loop}`, reason: lastStopReason(mission) };
  }
  return null;
}

/** True when the autopilot's last run ended because a person pressed Stop. */
function stoppedByPerson(mission: Mission): boolean {
  try {
    const last = requirePlane().events(mission.id).filter((event) => event.type === "AutopilotStopped" || event.type === "AutopilotStarted").at(-1);
    return last?.type === "AutopilotStopped" && last.data?.byPerson === true;
  } catch {
    return false;
  }
}

/** Why the autopilot last stopped, in its own words, so the person knows what "continue" will retry. */
function lastStopReason(mission: Mission): string {
  try {
    const stopped = requirePlane().events(mission.id).filter((event) => event.type === "AutopilotStopped").at(-1);
    const reason = stopped?.data?.reason;
    return typeof reason === "string" ? reason : "";
  } catch {
    return "";
  }
}

function requirePlane(): BmadControlPlane {
  if (!plane) throw new Error("Open a workspace folder.");
  return plane;
}

async function newMission(diagnostics: vscode.DiagnosticCollection): Promise<void> {
  // The composer lives in the BMAD page; reveal it and put the cursor in it, ready for an idea.
  try {
    await vscode.commands.executeCommand("bmad-next.home.focus");
    home?.show("new");
    return;
  } catch {
    // Fall through to the input box below.
  }
  const idea = await vscode.window.showInputBox({ prompt: "Mission idea", placeHolder: IDEA_PLACEHOLDER, ignoreFocusOut: true });
  if (idea === undefined) return;
  submitMission(idea, diagnostics);
}

function submitMission(text: string, diagnostics: vscode.DiagnosticCollection): void {
  try {
    requirePlane().createMission(text);
  } catch (error) {
    composer.error = `The mission was not created. ${message(error)}`;
    refresh(diagnostics);
    return;
  }
  composer.error = null;
  refresh(diagnostics);
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
    void globalState?.update("bmad-next.acceptor", identity.trim());
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
    void globalState?.update("bmad-next.acceptor", identity.trim());
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
  const voiceInput = config.get<string>("voiceInput", "local");
  const device = config.get<string>("microphoneDevice", ":0");
  const local = localVoiceConfig();
  const whisper = new WhisperService(local);
  context.subscriptions.push({ dispose: () => whisper.dispose() });
  const intent = voiceInput === "gemini" ? new GeminiIntentProvider() : voiceInput === "local" ? new LocalIntentProvider(local, whisper) : new TextCommandIntentProvider();
  // Voice decisions are recorded under the person's own name, marked as spoken to Jarvis.
  const speaker = () => {
    const known = globalState?.get<string>("bmad-next.acceptor")?.trim();
    if (known) return known;
    const git = spawnSync("git", ["config", "user.name"], { cwd: root, encoding: "utf8" });
    return String(git.stdout ?? "").trim() || "the workspace owner";
  };
  const history = context.workspaceState.get<TranscriptEntry[]>("bmad-next.jarvis.transcript", []);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "bmad-next.jarvis.toggle";
  context.subscriptions.push(status);
  let saveTimer: NodeJS.Timeout | null = null;
  let logged = history.length;
  const session = new JarvisSession(
    {
      root,
      plane: requirePlane,
      autopilotRunning,
      startAutopilot: () => void vscode.commands.executeCommand("bmad-next.autopilot"),
      stopAutopilot: () => void vscode.commands.executeCommand("bmad-next.stopAutopilot"),
      showEvidence: () => void vscode.commands.executeCommand("bmad-next.home.focus").then(() => home?.reveal("evidence")),
      acceptTickets: () => {
        const mission = requirePlane().mission();
        if (mission.tickets.length === 0) return "There is no ticket tree to accept yet.";
        if (mission.ticketTreeAccepted) return "The ticket tree is already accepted.";
        const name = speaker();
        requirePlane().acceptTicketTree(mission.id, `${name} (by voice through Jarvis)`);
        pushHome();
        if (!autopilotRunning()) void vscode.commands.executeCommand("bmad-next.autopilot");
        return `Ticket tree accepted for ${name}. Building starts now.`;
      },
      approveRelease: (reason) => {
        const mission = requirePlane().mission();
        const report = evaluateRelease(mission, (file) => fs.existsSync(file));
        const open = report.criteria.filter((item) => item.id !== "human-release" && item.state !== "pass" && item.state !== "waived");
        if (open.length > 0) return `The release cannot be approved yet: ${open.map((item) => item.label).join(", ")} still open.`;
        const name = speaker();
        requirePlane().approve(mission.id, "release", `${name} (by voice through Jarvis)`, reason);
        pushHome();
        if (!autopilotRunning()) void vscode.commands.executeCommand("bmad-next.release");
        return `Release approved for ${name}. Running the release gate.`;
      },
    },
    {
      input: voiceInput === "off" ? null : new FfmpegMicrophoneInput(device),
      intent,
      fallback: new TextCommandIntentProvider(),
      output: new SystemSpeechOutput(),
      continuous: voiceInput === "local" ? new ContinuousMicrophone(device) : null,
      transcriber: voiceInput === "local" ? whisper : null,
    },
    jarvisSettings(),
    (snapshot) => {
      pushHome();
      const micOpen = snapshot.listen.wakeWord || (snapshot.listen.handsFree && snapshot.state !== "JARVIS_OFF");
      status.text = snapshot.state === "JARVIS_OFF"
        ? snapshot.listen.wakeWord ? "$(record) Hey Jarvis" : "$(zap) Jarvis"
        : snapshot.paused ? "$(debug-pause) Jarvis paused" : snapshot.state === "JARVIS_LISTENING" || snapshot.listen.hearing ? "$(record) Jarvis hearing" : micOpen ? "$(record) Jarvis listening" : "$(circle-filled) Jarvis active";
      status.tooltip = micOpen ? "The microphone is open for Jarvis. Turn hands-free or Hey Jarvis off in the BMAD panel to close it." : snapshot.state === "JARVIS_OFF" ? "Activate Jarvis Mode (Cmd+Shift+J)" : `Jarvis ${snapshot.state}. Click to exit.`;
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
    await vscode.commands.executeCommand("bmad-next.home.focus");
    await session.activate();
    const snapshot = session.snapshot();
    output.appendLine(`[${new Date().toISOString()}] Jarvis ${snapshot.state}: ${snapshot.readiness.map((check) => `${check.ok ? "✓" : "⚠"} ${check.label} (${check.detail})`).join("; ")}`);
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("bmad-next.jarvis.activate", activate),
    vscode.commands.registerCommand("bmad-next.jarvis.exit", confirmExit),
    vscode.commands.registerCommand("bmad-next.jarvis.toggle", () => (session.machine.state === "JARVIS_OFF" ? activate() : confirmExit())),
    vscode.commands.registerCommand("bmad-next.jarvis.pause", () => session.pause()),
    vscode.commands.registerCommand("bmad-next.jarvis.resume", () => session.resume()),
    vscode.commands.registerCommand("bmad-next.jarvis.stopSpeaking", () => session.stopSpeaking()),
    // Push-to-talk from the page: recording lasts exactly as long as the button is held.
    vscode.commands.registerCommand("bmad-next.jarvis.pttStart", () => session.startListening()),
    vscode.commands.registerCommand("bmad-next.jarvis.pttStop", () => session.stopListening()),
    vscode.commands.registerCommand("bmad-next.jarvis.handsFree", async () => {
      const on = !session.snapshot().listen.handsFree;
      if (on && session.machine.state === "JARVIS_OFF") await activate();
      session.setListening({ handsFree: on });
      void context.workspaceState.update("bmad-next.jarvis.handsFree", session.snapshot().listen.handsFree);
    }),
    vscode.commands.registerCommand("bmad-next.jarvis.wakeWord", () => {
      session.setListening({ wakeWord: !session.snapshot().listen.wakeWord });
      void context.workspaceState.update("bmad-next.jarvis.wakeWord", session.snapshot().listen.wakeWord);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("bmadNext.jarvis")) session.configure(jarvisSettings());
    }),
    { dispose: () => session.dispose() },
  );
  // Wake-word listening survives a window reload when the person left it on; hands-free needs Jarvis on first.
  if (context.workspaceState.get<boolean>("bmad-next.jarvis.wakeWord", false)) session.setListening({ wakeWord: true });
  pushHome();
  status.text = "$(zap) Jarvis";
  status.tooltip = "Activate Jarvis Mode (Cmd+Shift+J)";
  status.show();
}
