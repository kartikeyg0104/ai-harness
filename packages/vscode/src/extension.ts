import * as vscode from "vscode";
import fs from "node:fs";
import { BmadControlPlane, evaluateRelease, parseIntent, renderMissionControl } from "@bmad-next/control-plane";
import type { Mission } from "@bmad-next/control-plane";

let plane: BmadControlPlane | null = null;
let missionWebview: vscode.Webview | null = null;
const emitters = new Map<string, vscode.EventEmitter<void>>();

export function activate(context: vscode.ExtensionContext): void {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return;
  plane = new BmadControlPlane(root);
  const diagnostics = vscode.languages.createDiagnosticCollection("bmad-next");
  context.subscriptions.push(diagnostics);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("bmad-next.missionControl", new MissionView()),
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
    vscode.commands.registerCommand("bmad-next.release", () => showRelease()),
    vscode.commands.registerCommand("bmad-next.doctor", () => showDoctor()),
    vscode.commands.registerCommand("bmad-next.repair", () => repairFinding(diagnostics)),
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
      stream.markdown(present(outcome));
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
  refresh(diagnostics);
}

export function deactivate(): void {
  plane = null;
}

class MissionView implements vscode.WebviewViewProvider {

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = { enableScripts: false };
    missionWebview = webviewView.webview;
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

function paintMission(webview: vscode.Webview): void {
  if (!plane) {
    webview.html = "<html><body>Open a workspace folder.</body></html>";
    return;
  }
  try {
    webview.html = renderMissionControl(plane.mission());
  } catch {
    webview.html = "<html><body><p>No active mission.</p><p>Run BMAD: New Mission.</p></body></html>";
  }
}

function requirePlane(): BmadControlPlane {
  if (!plane) throw new Error("Open a workspace folder.");
  return plane;
}

async function newMission(diagnostics: vscode.DiagnosticCollection): Promise<void> {
  const idea = await vscode.window.showInputBox({ prompt: "Mission idea", placeHolder: "Build an expense-management SaaS." });
  if (!idea?.trim()) return;
  const mission = requirePlane().createMission(idea);
  refresh(diagnostics);
  void vscode.window.showInformationMessage(`Mission ${mission.id} is ${mission.complexity}. Next: ${requirePlane().recommend(mission.id).skillId}`);
}

async function forgeAnswer(diagnostics: vscode.DiagnosticCollection): Promise<void> {
  const mission = requirePlane().mission();
  const open = mission.forge?.questions.find((question) => !mission.forge?.answered.includes(question.id));
  const answer = await vscode.window.showInputBox({ prompt: open?.prompt ?? "Forge answer" });
  if (!answer) return;
  requirePlane().answerForge(mission.id, answer);
  refresh(diagnostics);
}

async function harden(diagnostics: vscode.DiagnosticCollection): Promise<void> {
  try {
    requirePlane().answerForge(requirePlane().mission().id, "harden");
    refresh(diagnostics);
  } catch (error) {
    void vscode.window.showErrorMessage(message(error));
  }
}

async function acceptTickets(diagnostics: vscode.DiagnosticCollection): Promise<void> {
  const identity = await vscode.window.showInputBox({ prompt: "Your name" });
  if (!identity?.trim()) return;
  try {
    requirePlane().acceptTicketTree(requirePlane().mission().id, identity);
    refresh(diagnostics);
  } catch (error) {
    void vscode.window.showErrorMessage(message(error));
  }
}

function showNext(): void {
  try {
    const next = requirePlane().recommend();
    void vscode.window.showInformationMessage(`${next.skillId}: ${next.reason}`);
  } catch (error) {
    void vscode.window.showErrorMessage(message(error));
  }
}

function showRelease(): void {
  try {
    const report = requirePlane().releaseGate(requirePlane().mission().id);
    void vscode.window.showInformationMessage(`Release gate: ${report.state}`);
  } catch (error) {
    void vscode.window.showErrorMessage(message(error));
  }
}

async function repairFinding(diagnostics: vscode.DiagnosticCollection): Promise<void> {
  try {
    const mission = requirePlane().mission();
    const failed = (mission.reviews ?? []).filter((review) => review.status === "FAIL");
    const ticket = await vscode.window.showInputBox({ prompt: "Ticket to repair", value: failed.at(-1)?.ticketRef ?? "1.1" });
    if (!ticket?.trim()) return;
    const result = requirePlane().repairTicket(mission.id, ticket.trim());
    refresh(diagnostics);
    void vscode.window.showInformationMessage(result.message);
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
  return list((mission) => mission.agents.map((agent) => item(agent.name, `${agent.role} · runtime ${agent.runtime ?? "not configured"}`)));
}

function releaseItems(): vscode.TreeItem[] {
  return list((mission) => {
    const report = evaluateRelease(mission, (file) => fs.existsSync(file));
    return [item(report.state, "Missing evidence stays blocked."), ...report.criteria.map((criterion) => item(criterion.label, `${criterion.state}: ${criterion.detail}`))];
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
    return [item("No mission", "Run BMAD: New Mission.")];
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
