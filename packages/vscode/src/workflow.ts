import * as vscode from "vscode";
import fs from "node:fs";
import path from "node:path";
import { SHARE_ENV, Worker } from "node:worker_threads";
import type { BmadControlPlane, Mission } from "@bmad-next/control-plane";
import type { WorkerMethod } from "./plane-worker";

export interface WorkflowHost {
  root: string;
  plane(): BmadControlPlane;
  refresh(): void;
  output: vscode.OutputChannel;
  state: vscode.Memento;
  activity(text: string | null): void;
}

let busy: string | null = null;

/** Whether the mission autopilot is running in this window. */
export function autopilotRunning(): boolean {
  return busy === "autopilot";
}

function runInWorker(root: string, method: WorkerMethod, args: unknown[], onProgress?: (message: string) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "plane-worker.js"), { workerData: { root, method, args }, env: SHARE_ENV });
    let settled = false;
    worker.on("message", (reply: { ok?: boolean; progress?: string; result?: unknown; error?: string }) => {
      if (typeof reply.progress === "string") {
        onProgress?.(reply.progress);
        return;
      }
      settled = true;
      if (reply.ok) resolve(reply.result);
      else reject(new Error(reply.error ?? `${method} failed.`));
    });
    worker.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    worker.once("exit", (code) => {
      if (!settled) reject(new Error(`${method} stopped with exit code ${code} before it reported a result.`));
    });
  });
}

function stamp(): string {
  return new Date().toISOString();
}

/** First status-like and message-like fields of a control-plane result, for notifications. */
export function summarize(result: unknown): string {
  if (!result || typeof result !== "object") return String(result);
  const record = result as Record<string, unknown>;
  const status = record.status ?? record.state ?? record.decision;
  const detail = record.summary ?? record.message ?? record.reason ?? record.evidence ?? record.evidencePath;
  return [status, detail].filter((part) => part !== undefined && part !== null && String(part).trim()).map(String).join(" — ") || "done";
}

const FAILING = /\b(FAIL|BLOCKED|ERROR|NOT_CONFIGURED|TIMEOUT|failed|blocked|not-configured|timeout|fail)\b/;

async function operate(host: WorkflowHost, title: string, method: WorkerMethod, args: unknown[], describe: (result: unknown) => string = summarize): Promise<unknown> {
  if (busy) {
    void vscode.window.showWarningMessage(`BMAD is still running: ${busy}. Wait for it to finish.`);
    return undefined;
  }
  busy = title;
  host.activity(`running: ${title}`);
  host.output.appendLine(`[${stamp()}] ▶ ${title}`);
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `BMAD: ${title}`, cancellable: false },
      () => runInWorker(host.root, method, args),
    );
    const text = describe(result);
    host.output.appendLine(`[${stamp()}] ■ ${title}: ${text}`);
    host.output.appendLine(JSON.stringify(result, null, 2).slice(0, 20000));
    if (FAILING.test(text)) void vscode.window.showWarningMessage(`${title}: ${text}`, "Show Output").then((pick) => pick && host.output.show(true));
    else void vscode.window.showInformationMessage(`${title}: ${text}`);
    return result;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    host.output.appendLine(`[${stamp()}] ✖ ${title}: ${text}`);
    void vscode.window.showErrorMessage(`BMAD ${title} failed: ${text}`, "Show Output").then((pick) => pick && host.output.show(true));
    return undefined;
  } finally {
    busy = null;
    host.activity(null);
    host.refresh();
  }
}

function activeMission(host: WorkflowHost): Mission | null {
  try {
    return host.plane().mission();
  } catch {
    void vscode.window.showErrorMessage("No active mission. Run BMAD: New Mission first.");
    return null;
  }
}

async function pickTicket(mission: Mission, purpose: string, prefer?: (ref: string) => boolean): Promise<string | undefined> {
  if (mission.tickets.length === 0) {
    void vscode.window.showErrorMessage("The mission has no tickets yet. Run BMAD: Propose Stories, then BMAD: Accept Ticket Tree.");
    return undefined;
  }
  if (mission.tickets.length === 1) return mission.tickets[0]?.ref;
  const items = mission.tickets.map((ticket) => {
    const plan = mission.plans.find((item) => item.ref === ticket.ref)?.status ?? "planned";
    return { label: ticket.ref, description: `${ticket.title} · ${plan}`, ref: ticket.ref, picked: prefer?.(ticket.ref) ?? false };
  });
  items.sort((left, right) => Number(right.picked) - Number(left.picked));
  const choice = await vscode.window.showQuickPick(items, { placeHolder: `Ticket to ${purpose}` });
  return choice?.ref;
}

const skillSummary = (skillId: string) => (result: unknown) => {
  const mission = result as Mission | null;
  const step = mission?.workflow?.find((item) => item.skillId === skillId);
  return step ? `${skillId} ${step.status}${step.reason ? ` — ${step.reason}` : ""}` : summarize(result);
};

export function registerWorkflowCommands(context: vscode.ExtensionContext, host: WorkflowHost): void {
  const ticketCommand = (command: string, title: string, method: WorkerMethod, purpose: string, prefer?: (mission: Mission, ref: string) => boolean) =>
    vscode.commands.registerCommand(command, async () => {
      const mission = activeMission(host);
      if (!mission) return;
      const ref = await pickTicket(mission, purpose, prefer ? (item) => prefer(mission, item) : undefined);
      if (!ref) return;
      await operate(host, `${title} ${ref}`, method, [mission.id, ref]);
    });
  const missionCommand = (command: string, title: string, method: WorkerMethod, describe?: (result: unknown) => string) =>
    vscode.commands.registerCommand(command, async () => {
      const mission = activeMission(host);
      if (!mission) return;
      await operate(host, title, method, [mission.id], describe);
    });
  const unbuilt = (mission: Mission, ref: string) => mission.plans.find((plan) => plan.ref === ref)?.status !== "built";
  const unreviewed = (mission: Mission, ref: string) => (mission.reviews ?? []).filter((item) => item.ticketRef === ref).at(-1)?.status !== "PASS";

  context.subscriptions.push(
    vscode.commands.registerCommand("bmad-next.runSkill", async () => {
      const mission = activeMission(host);
      if (!mission) return;
      const steps = mission.workflow.filter((step) => step.origin === "upstream-bmad-method" && !["bmad-forge-idea", "bmad-preview-ticketing", "bmad-build", "bmad-code-review"].includes(step.skillId));
      const choice = await vscode.window.showQuickPick(
        steps.map((step) => ({ label: step.skillId, description: `${step.status}${step.reason ? ` · ${step.reason}` : ""}` })),
        { placeHolder: "Workflow skill to run through the configured model runner" },
      );
      if (!choice) return;
      await operate(host, `Run ${choice.label}`, "runSkill", [mission.id, choice.label], skillSummary(choice.label));
    }),
    vscode.commands.registerCommand("bmad-next.runNextStep", async () => {
      const mission = activeMission(host);
      if (!mission) return;
      const open = mission.forge?.questions.filter((question) => !mission.forge?.answered.includes(question.id)) ?? [];
      if (mission.forge?.outcome === "active") {
        await vscode.commands.executeCommand(open.length > 0 ? "bmad-next.forgeAnswer" : "bmad-next.harden");
        return;
      }
      const next = host.plane().recommend(mission.id);
      host.output.appendLine(`[${stamp()}] next: ${next.skillId} — ${next.reason}`);
      if (next.skillId === "bmad-preview-ticketing") {
        if (mission.tickets.length === 0) await operate(host, "Propose stories", "stories", [mission.id], (result) => `${(result as Mission | null)?.tickets?.length ?? 0} ticket(s) proposed`);
        await vscode.commands.executeCommand("bmad-next.acceptTickets");
        return;
      }
      if (next.skillId === "bmad-build") return void (await vscode.commands.executeCommand("bmad-next.build"));
      if (next.skillId === "bmad-code-review") return void (await vscode.commands.executeCommand("bmad-next.review"));
      if (next.skillId === "bmad-retrospective") return void (await operate(host, "Retrospective", "retrospective", [mission.id]));
      await operate(host, `Run ${next.skillId}`, "runSkill", [mission.id, next.skillId], skillSummary(next.skillId));
    }),
    vscode.commands.registerCommand("bmad-next.proposeStories", async () => {
      const mission = activeMission(host);
      if (!mission) return;
      await operate(host, "Propose stories", "stories", [mission.id], (result) => {
        const tickets = (result as Mission | null)?.tickets ?? [];
        return tickets.length > 0 ? `${tickets.map((ticket) => `${ticket.ref} ${ticket.title}`).join("; ")}. Review them, then run BMAD: Accept Ticket Tree.` : skillSummary("bmad-preview-ticketing")(result);
      });
    }),
    ticketCommand("bmad-next.build", "Build ticket", "executeTicket", "build", unbuilt),
    ticketCommand("bmad-next.review", "Review ticket", "reviewTicket", "review", unreviewed),
    ticketCommand("bmad-next.repair", "Repair ticket", "repairTicket", "repair", (mission, ref) => {
      const review = (mission.reviews ?? []).filter((item) => item.ticketRef === ref).at(-1);
      const unit = [...mission.evidence].reverse().find((record) => record.story_id === ref && record.kind === "unit");
      return review?.status === "FAIL" || unit?.result === "fail";
    }),
    ticketCommand("bmad-next.attack", "Attack ticket", "attackTicket", "attack"),
    ticketCommand("bmad-next.planVerification", "Plan browser and NFR verification for", "planVerification", "plan verification for"),
    vscode.commands.registerCommand("bmad-next.browser", async () => {
      const mission = activeMission(host);
      if (!mission) return;
      await operate(host, "Browser verification", "runBrowser", [mission.id, mission.requirements[0]?.id], (result) => {
        const browser = result as { status?: string; summary?: string; screenshots?: unknown[]; assertions?: Array<{ status: string }> } | null;
        const passed = browser?.assertions?.filter((item) => item.status === "PASS").length ?? 0;
        return `${browser?.status ?? "?"} — ${browser?.summary ?? ""} Assertions ${passed}/${browser?.assertions?.length ?? 0}. Screenshots ${browser?.screenshots?.length ?? 0}.`;
      });
    }),
    missionCommand("bmad-next.security", "Security scan", "runSecurity", (result) => {
      const security = result as { status?: string; findings?: unknown[]; tools?: Array<{ id: string; status: string }> } | null;
      return `${security?.status ?? "?"} — ${security?.findings?.length ?? 0} finding(s). ${(security?.tools ?? []).map((tool) => `${tool.id} ${tool.status}`).join(", ")}`;
    }),
    missionCommand("bmad-next.nfr", "NFR measurement", "measureNfr", (result) => {
      const nfr = result as { status?: string; measurements?: Array<{ metric: string; measured: number | null; operator: string; target: number; unit: string; result: string }> } | null;
      return `${nfr?.status ?? "?"} — ${(nfr?.measurements ?? []).map((item) => `${item.metric} ${item.measured ?? "none"}${item.unit} ${item.operator} ${item.target}${item.unit}: ${item.result}`).join("; ") || "no declared NFR"}`;
    }),
    missionCommand("bmad-next.verifyArchitecture", "Architecture verification", "verifyArchitecture"),
    missionCommand("bmad-next.traceability", "Traceability", "verifyTraceability"),
    missionCommand("bmad-next.release", "Release gate", "releaseGate", (result) => {
      const report = result as { state?: string; criteria?: Array<{ label: string; state: string; detail: string }> } | null;
      return `${report?.state ?? "?"} — ${(report?.criteria ?? []).map((item) => `${item.label} ${item.state}`).join(", ")}`;
    }),
    vscode.commands.registerCommand("bmad-next.autopilot", () => autopilot(host)),
    vscode.commands.registerCommand("bmad-next.stopAutopilot", () => {
      const mission = activeMission(host);
      if (!mission) return;
      fs.writeFileSync(path.join(host.root, ".bmad-next", "missions", mission.id, "autopilot.stop"), new Date().toISOString());
      void vscode.window.showInformationMessage("BMAD autopilot will stop after the current step.");
    }),
    vscode.commands.registerCommand("bmad-next.requireAllGates", async () => {
      const mission = activeMission(host);
      if (!mission) return;
      const identity = await vscode.window.showInputBox({ title: "Require every release gate", prompt: "Your name, recorded with this stricter policy", value: host.state.get<string>("bmad-next.acceptor") ?? "", ignoreFocusOut: true });
      if (!identity?.trim()) return;
      const updated = host.plane().requireEvidence(mission.id, ["unit", "review", "attack", "browser", "security", "nfr"], identity.trim());
      host.output.appendLine(`[${stamp()}] ${mission.id} now requires: ${(updated.requiredEvidence ?? []).join(", ")}.`);
      void vscode.window.showInformationMessage(`Release for ${mission.id} now requires tests, review, attack, browser, security, and NFR evidence.`);
      host.refresh();
    }),
    vscode.commands.registerCommand("bmad-next.approveRelease", () => decideRelease(host, "approve")),
    vscode.commands.registerCommand("bmad-next.rejectRelease", () => decideRelease(host, "reject")),
  );
}

interface AutopilotOutcome {
  status: "needs-forge-answers" | "needs-ticket-acceptance" | "needs-release-approval" | "released" | "blocked" | "stopped";
  reason: string;
}

/**
 * One command drives the mission. The control plane runs every automated step in a worker; the editor only asks
 * for what a person must decide (forge answers, ticket-tree acceptance, release approval) and then continues.
 */
async function autopilot(host: WorkflowHost): Promise<void> {
  if (busy) {
    void vscode.window.showWarningMessage(`BMAD is still running: ${busy}.`);
    return;
  }
  busy = "autopilot";
  try {
  for (let pass = 0; pass < 6; pass += 1) {
    const mission = activeMission(host);
    if (!mission) return;
    host.output.appendLine(`[${stamp()}] ▶ Autopilot for ${mission.id}`);
    host.output.show(true);
    let outcome: AutopilotOutcome | undefined;
    try {
      outcome = (await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "BMAD autopilot", cancellable: true },
        (progress, token) => {
          token.onCancellationRequested(() => void vscode.commands.executeCommand("bmad-next.stopAutopilot"));
          host.activity("autopilot running");
          return runInWorker(host.root, "autopilot", [mission.id], (message) => {
            host.output.appendLine(`[${stamp()}]   ${message}`);
            progress.report({ message: message.slice(0, 120) });
            host.activity(`autopilot: ${message.slice(0, 60)}`);
            host.refresh();
          });
        },
      )) as AutopilotOutcome;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      host.output.appendLine(`[${stamp()}] ✖ Autopilot: ${text}`);
      void vscode.window.showErrorMessage(`BMAD autopilot failed: ${text}`, "Show Output").then((pick) => pick && host.output.show(true));
      return;
    }
    host.refresh();
    host.output.appendLine(`[${stamp()}] ■ Autopilot: ${outcome.status} — ${outcome.reason}`);
    // The model answers the forge questions; a person is asked only when no model runner could.
    if (outcome.status === "needs-forge-answers") {
      if (await forgeInterview(host, mission)) continue;
      return;
    }
    if (outcome.status === "needs-ticket-acceptance") {
      if (await acceptTree(host)) continue;
      return;
    }
    if (outcome.status === "needs-release-approval") {
      host.refresh();
      void vscode.window.showInformationMessage(`Every automated gate passed for ${mission.id}. Approve the release in Mission Control.`);
      const approved = await waitFor(host, () => host.plane().mission(mission.id).approvals.some((item) => item.category === "release" && item.decision === "approved"));
      if (approved) await operate(host, "Release gate", "releaseGate", [mission.id], (result) => summarize(result));
      return;
    }
    if (outcome.status === "released") void vscode.window.showInformationMessage(`BMAD released ${mission.id}.`);
    else if (outcome.status === "blocked") void vscode.window.showWarningMessage(`BMAD autopilot stopped: ${outcome.reason}`, "Show Output").then((pick) => pick && host.output.show(true));
    else void vscode.window.showInformationMessage(`BMAD autopilot: ${outcome.status}.`);
    return;
  }
  } finally {
    busy = null;
    host.activity(null);
    host.refresh();
  }
}

/** Waits for forge answers in Mission Control (or the Answer Forge command), then continues. */
async function forgeInterview(host: WorkflowHost, mission: Mission): Promise<boolean> {
  host.refresh();
  void vscode.window.showInformationMessage("Answer the forge questions in BMAD Next Mission Control.");
  const answered = await waitFor(host, () => {
    const current = host.plane().mission(mission.id);
    const questions = current.forge?.questions ?? [];
    return questions.length > 0 && questions.every((question) => current.forge?.answered.includes(question.id));
  });
  if (!answered) void vscode.window.showWarningMessage("Forge questions are still open in Mission Control.");
  return answered;
}

/** Waits for a named person to accept the ticket tree in Mission Control. */
async function acceptTree(host: WorkflowHost): Promise<boolean> {
  const mission = activeMission(host);
  if (!mission) return false;
  host.refresh();
  void vscode.window.showInformationMessage("Accept the ticket tree in BMAD Next Mission Control.");
  const accepted = await waitFor(host, () => Boolean(host.plane().mission(mission.id).ticketTreeAccepted));
  if (accepted) host.output.appendLine(`[${stamp()}] Ticket tree accepted.`);
  return accepted;
}

async function waitFor(host: WorkflowHost, ready: () => boolean, timeoutMs = 30 * 60 * 1000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (ready()) return true;
    } catch {
      return false;
    }
    host.refresh();
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return false;
}

/** Approval stays a named human decision: a modal confirmation, a typed name, and a typed reason. */
async function decideRelease(host: WorkflowHost, decision: "approve" | "reject"): Promise<boolean> {
  const mission = activeMission(host);
  if (!mission) return false;
  const report = host.plane().inspectEvidence(mission.id);
  const lines = report.criteria.map((item) => `${item.label}: ${item.state}`).join("\n");
  const verb = decision === "approve" ? "Approve" : "Reject";
  const confirmed = await vscode.window.showWarningMessage(
    `${verb} the release of ${mission.id}?`,
    { modal: true, detail: `Current gate: ${report.state}\n${lines}\n\nThis records your name as the ${decision === "approve" ? "approver" : "rejecter"}.` },
    verb,
  );
  if (confirmed !== verb) return false;
  const identity = await vscode.window.showInputBox({ prompt: "Your name, recorded with the decision", ignoreFocusOut: true });
  if (!identity?.trim()) return false;
  const reason = await vscode.window.showInputBox({ prompt: `Why do you ${decision} this release?`, ignoreFocusOut: true });
  if (!reason?.trim()) return false;
  try {
    const recorded = decision === "approve" ? host.plane().approve(mission.id, "release", identity.trim(), reason.trim()) : host.plane().rejectRelease(mission.id, identity.trim(), reason.trim());
    host.output.appendLine(`[${stamp()}] release ${recorded.decision} by ${recorded.identity}: ${recorded.reason}`);
    void vscode.window.showInformationMessage(`Release ${recorded.decision} by ${recorded.identity}.`);
    return decision === "approve";
  } catch (error) {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    host.refresh();
  }
}
