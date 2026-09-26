import fs from "node:fs";
import { redactSecrets } from "./model-runner";
import { evaluateRelease, fileExists } from "./quality";
import type { DomainEvent, Mission } from "./types";

/**
 * Jarvis is a presentation and command layer over the control plane. Everything it says is derived from
 * recorded mission state and events; it never mutates a mission except through validated commands that call
 * the same control-plane operations as the rest of the product.
 */

// ---------------------------------------------------------------------------------------------------------------
// Session state machine

export type JarvisState =
  | "JARVIS_OFF"
  | "JARVIS_STARTING"
  | "JARVIS_ACTIVE"
  | "JARVIS_LISTENING"
  | "JARVIS_PROCESSING"
  | "JARVIS_SPEAKING"
  | "JARVIS_PAUSED"
  | "JARVIS_ERROR";

const TRANSITIONS: Record<JarvisState, JarvisState[]> = {
  JARVIS_OFF: ["JARVIS_STARTING"],
  JARVIS_STARTING: ["JARVIS_ACTIVE", "JARVIS_ERROR", "JARVIS_OFF"],
  JARVIS_ACTIVE: ["JARVIS_LISTENING", "JARVIS_PROCESSING", "JARVIS_SPEAKING", "JARVIS_PAUSED", "JARVIS_ERROR", "JARVIS_OFF"],
  JARVIS_LISTENING: ["JARVIS_PROCESSING", "JARVIS_ACTIVE", "JARVIS_PAUSED", "JARVIS_ERROR", "JARVIS_OFF"],
  JARVIS_PROCESSING: ["JARVIS_SPEAKING", "JARVIS_ACTIVE", "JARVIS_PAUSED", "JARVIS_ERROR", "JARVIS_OFF"],
  JARVIS_SPEAKING: ["JARVIS_ACTIVE", "JARVIS_LISTENING", "JARVIS_PROCESSING", "JARVIS_PAUSED", "JARVIS_ERROR", "JARVIS_OFF"],
  JARVIS_PAUSED: ["JARVIS_ACTIVE", "JARVIS_OFF"],
  JARVIS_ERROR: ["JARVIS_ACTIVE", "JARVIS_STARTING", "JARVIS_OFF"],
};

export class JarvisMachine {
  private current: JarvisState = "JARVIS_OFF";
  private readonly listeners: Array<(state: JarvisState, previous: JarvisState) => void> = [];

  get state(): JarvisState {
    return this.current;
  }

  get on(): boolean {
    return this.current !== "JARVIS_OFF";
  }

  onChange(listener: (state: JarvisState, previous: JarvisState) => void): void {
    this.listeners.push(listener);
  }

  can(next: JarvisState): boolean {
    return next === this.current || TRANSITIONS[this.current].includes(next);
  }

  to(next: JarvisState): JarvisState {
    if (next === this.current) return next;
    if (!TRANSITIONS[this.current].includes(next)) throw new Error(`Jarvis cannot move from ${this.current} to ${next}.`);
    const previous = this.current;
    this.current = next;
    for (const listener of this.listeners) listener(next, previous);
    return next;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Narration

export type NarrationCategory = "SILENT" | "INFO" | "IMPORTANT" | "WARNING" | "ERROR" | "COMPLETION";
export type NarrationLevel = "important" | "all" | "off";

export interface Narration {
  eventId: string;
  category: NarrationCategory;
  text: string;
}

export function shouldSpeak(category: NarrationCategory, level: NarrationLevel): boolean {
  if (level === "off" || category === "SILENT") return false;
  if (level === "all") return true;
  return category !== "INFO";
}

const SKILL_LABELS: Record<string, string> = {
  "bmad-forge-idea": "Forge",
  "bmad-spec": "Specification",
  "bmad-prd": "PRD",
  "bmad-ux": "UX design",
  "bmad-architecture": "Architecture",
  "bmad-project-context": "Project context",
  "bmad-product-brief": "Product brief",
  "bmad-qa-generate-e2e-tests": "Verification planning",
  "bmad-preview-ticketing": "Ticketing",
};

export function skillLabel(skillId: string): string {
  return SKILL_LABELS[skillId] ?? skillId.replace(/^bmad-/, "").replace(/-/g, " ");
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const str = (value: unknown) => (typeof value === "string" ? value : "");

function blockingFindings(mission: Mission, ticketRef: string, kind: "reviews" | "attacks"): number {
  const record = (mission[kind] ?? []).filter((item) => item.ticketRef === ticketRef).at(-1);
  return (record?.findings ?? []).filter((finding) => finding.severity === "high" || finding.severity === "critical").length;
}

/** Test count from the recorded unit log, when the runner printed one. */
function testsExecuted(mission: Mission, evidenceId: unknown): number | null {
  const record = mission.evidence.find((item) => item.evidence_id === evidenceId);
  if (!record?.artifact || !fs.existsSync(record.artifact)) return null;
  const log = fs.readFileSync(record.artifact, "utf8").replace(/\u001b\[[0-9;]*m/g, "");
  const match = log.match(/(?:ℹ|#)\s*tests\s+(\d+)/);
  return match ? Number(match[1]) : null;
}

/** One calm sentence for a real event, or SILENT. The mission is read at narration time for counts. */
export function narrateEvent(event: DomainEvent, mission: Mission): Narration {
  const say = (category: NarrationCategory, text: string): Narration => ({ eventId: event.id, category, text });
  const data = event.data ?? {};
  const ref = str(data.ticketRef);
  switch (event.type) {
    case "MissionCreated":
      return say("IMPORTANT", "Mission created.");
    case "ForgeClosed":
      return data.outcome === "hardened"
        ? say("IMPORTANT", `Forge is complete. ${plural(mission.requirements.length, "requirement")} recorded.`)
        : say("WARNING", `Forge closed as ${str(data.outcome)}.`);
    case "SkillStarted":
      return say("INFO", `${skillLabel(str(data.skillId))} started.`);
    case "SkillCompleted":
      // ForgeClosed announces the forge with its requirement count.
      if (str(data.skillId) === "bmad-forge-idea") return say("SILENT", "");
      return say("IMPORTANT", `${skillLabel(str(data.skillId))} is complete.`);
    case "SkillFailed":
      return say("WARNING", `${skillLabel(str(data.skillId))} did not complete.`);
    case "StoryCreated":
      return say("IMPORTANT", `Ticket tree accepted. ${plural(Array.isArray(data.tickets) ? data.tickets.length : mission.tickets.length, "ticket")}.`);
    case "TicketStarted":
      return say("IMPORTANT", `${str(data.agent) || "The developer"} is building ticket ${ref}.`);
    case "TicketBuilt":
      return say("IMPORTANT", `Ticket ${ref} is built.`);
    case "AgentFailed":
      return say("WARNING", `The build of ticket ${ref} did not finish.`);
    case "TestStarted":
      return ref ? say("IMPORTANT", "Tests are running.") : say("SILENT", "");
    case "TestPassed": {
      const count = testsExecuted(mission, data.evidence_id);
      return say("IMPORTANT", count === null ? "Tests passed." : `Tests passed. ${plural(count, "test")} executed.`);
    }
    case "TestFailed":
      return data.kind === "unit" ? say("WARNING", "Tests failed.") : say("SILENT", "");
    case "ReviewStarted":
      return say("INFO", `Review of ticket ${ref} started.`);
    case "ReviewCompleted":
    case "ReviewFailed": {
      if (data.result === "PASS") return say("IMPORTANT", "Review passed.");
      const count = blockingFindings(mission, ref, "reviews");
      const record = (mission.reviews ?? []).filter((item) => item.ticketRef === ref).at(-1);
      if (data.result === "FAIL") return say("WARNING", count > 0 ? `Review found ${plural(count, "blocking issue")}.` : "Review failed.");
      if ((record?.unclear ?? []).length > 0) return say("WARNING", `Review is blocked. The reviewer could not confirm ${plural(record?.unclear?.length ?? 0, "item")}.`);
      return say("WARNING", `Review is ${str(data.result).toLowerCase() || "blocked"}.`);
    }
    case "RepairStarted":
      return say("IMPORTANT", `Repair is starting for ticket ${ref}.`);
    case "RepairCompleted":
      return data.status === "COMPLETED" ? say("IMPORTANT", "Repair complete. A fresh review follows.") : say("WARNING", `Repair ${str(data.status).toLowerCase().replace(/_/g, " ")}.`);
    case "AttackStarted":
      return data.attacker ? say("INFO", `Attacker started on ticket ${ref}.`) : say("SILENT", "");
    case "AttackCompleted":
    case "AttackFailed": {
      if (data.result === "PASS") return say("IMPORTANT", "Attack found no breaks.");
      const count = blockingFindings(mission, ref, "attacks");
      return say("WARNING", data.result === "FAIL" ? `Attack found ${plural(count, "blocking issue")}.` : `Attack is ${str(data.result).toLowerCase()}.`);
    }
    case "BrowserStarted":
      return say("INFO", "Browser verification started.");
    case "BrowserCompleted":
      return say("IMPORTANT", "Browser verification passed.");
    case "BrowserFailed":
      return say("WARNING", `Browser verification ${str(data.status).toLowerCase() || "failed"}.`);
    case "SecurityStarted":
      return say("INFO", "Security scan started.");
    case "SecurityCompleted":
      return say("IMPORTANT", "Security verification passed.");
    case "SecurityFailed":
      return say("WARNING", `Security verification is ${str(data.status).toLowerCase()}. ${plural(Number(data.findings ?? 0), "finding")}.`);
    case "NfrCompleted":
      return data.status === "PASS" ? say("IMPORTANT", "NFR measurement passed.") : say("INFO", `NFR measurement is ${str(data.status).toLowerCase().replace(/_/g, " ")}.`);
    case "NfrFailed":
      return say("WARNING", `NFR measurement ${str(data.status).toLowerCase()}.`);
    case "ArchitectureVerificationCompleted":
      return data.status === "PASS" ? say("IMPORTANT", "Architecture verification passed.") : say("WARNING", `Architecture verification is ${str(data.status).toLowerCase()}.`);
    case "TraceabilityChecked":
      return data.status === "PASS" ? say("IMPORTANT", "Traceability passed.") : say("WARNING", `Traceability is ${str(data.status).toLowerCase()}.`);
    case "ReleaseGateEvaluated": {
      const report = evaluateRelease(mission, fileExists);
      if (report.state === "pass") return say("SILENT", "");
      const open = report.criteria.filter((item) => item.state !== "pass" && item.state !== "waived");
      if (open.length > 0 && open.every((item) => item.id === "human-release")) {
        return say("COMPLETION", "Mission complete. All required verification gates have passed. Release is ready for your approval.");
      }
      return say("INFO", `Release gate is ${report.state}.`);
    }
    case "ReleaseApproved":
      return say("IMPORTANT", `Release approved by ${str(data.identity)}.`);
    case "ReleaseCreated":
      return say("COMPLETION", "Release recorded.");
    case "Escalated":
      return say("ERROR", `Escalated: ${str(data.reason).replace(/-/g, " ")}.`);
    case "AutopilotStopped": {
      const status = str(data.status);
      if (status === "blocked") return say("ERROR", `Mission is blocked. ${firstSentence(str(data.reason))}`);
      if (status === "needs-ticket-acceptance") return say("IMPORTANT", "The ticket tree is waiting for your acceptance.");
      if (status === "needs-forge-answers") return say("IMPORTANT", "Forge questions need your answers.");
      if (status === "stopped") return say("INFO", "Autopilot stopped.");
      return say("SILENT", "");
    }
    case "FindingCreated":
      return data.code === "SKILL_WROTE_OUTSIDE_ARTIFACTS" ? say("WARNING", "A planning step wrote outside its artifact area. The files were quarantined.") : say("SILENT", "");
    default:
      return say("SILENT", "");
  }
}

function firstSentence(text: string): string {
  const clean = redactSecrets(text).replace(/\s+/g, " ").trim();
  const cut = clean.search(/[.!?](\s|$)/);
  return (cut >= 0 ? clean.slice(0, cut + 1) : clean).slice(0, 220);
}

/** Tracks narrated event ids so a re-read log never repeats a sentence. */
export class NarrationLog {
  private readonly seen = new Set<string>();

  firstTime(eventId: string): boolean {
    if (this.seen.has(eventId)) return false;
    this.seen.add(eventId);
    return true;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Agents and timeline

export interface AgentActivity {
  key: string;
  name: string;
  task: string;
  status: "WORKING" | "COMPLETE" | "FAILED" | "UNKNOWN";
  detail: string;
  since: string;
}

const STARTS: Record<string, { name: (data: Record<string, unknown>) => string; task: (data: Record<string, unknown>) => string; key: (data: Record<string, unknown>) => string }> = {
  SkillStarted: { name: () => "Model runner", task: (d) => `${skillLabel(str(d.skillId))}${d.ticketRef ? ` for ticket ${str(d.ticketRef)}` : ""}`, key: (d) => `skill:${str(d.skillId)}` },
  TicketStarted: { name: (d) => `${str(d.agent) || "Developer"} (${str(d.runtime) || "runtime"})`, task: (d) => `Building ticket ${str(d.ticketRef)}`, key: (d) => `build:${str(d.ticketRef)}` },
  RepairStarted: { name: () => "Developer", task: (d) => `Repairing ticket ${str(d.ticketRef)} (${str(d.source)})`, key: (d) => `repair:${str(d.ticketRef)}` },
  TestStarted: { name: () => "Test runner", task: (d) => `${str(d.command) || "Tests"}`, key: (d) => `test:${str(d.ticketRef)}` },
  ReviewStarted: { name: (d) => `Reviewer (${str(d.reviewer) || "configured"})`, task: (d) => `Reviewing ticket ${str(d.ticketRef)}`, key: (d) => `review:${str(d.ticketRef)}` },
  AttackStarted: { name: (d) => `Attacker (${str(d.attacker) || "configured"})`, task: (d) => `Attacking ticket ${str(d.ticketRef)}`, key: (d) => `attack:${str(d.ticketRef)}` },
  BrowserStarted: { name: (d) => `Browser (${str(d.browser) || "playwright"})`, task: (d) => `Verifying ${str(d.requirementId) || "the app"}`, key: () => "browser" },
  SecurityStarted: { name: () => "Security scanners", task: (d) => `Scanning ticket ${str(d.ticketRef)}`, key: () => "security" },
  NfrStarted: { name: () => "NFR probe", task: (d) => `Measuring ticket ${str(d.ticketRef)}`, key: () => "nfr" },
  ArchitectureVerificationStarted: { name: () => "Architecture check", task: () => "Comparing the tree with the declared architecture", key: () => "architecture" },
};

type End = { key: (data: Record<string, unknown>) => string; status: (data: Record<string, unknown>) => AgentActivity["status"]; detail: (data: Record<string, unknown>, mission: Mission) => string };

const ENDS: Record<string, End> = {
  SkillCompleted: { key: (d) => `skill:${str(d.skillId)}`, status: () => "COMPLETE", detail: () => "Contract met" },
  SkillFailed: { key: (d) => `skill:${str(d.skillId)}`, status: () => "FAILED", detail: (d) => str(d.status) || "Did not complete" },
  TicketBuilt: { key: (d) => `build:${str(d.ticketRef)}`, status: () => "COMPLETE", detail: () => "Built" },
  AgentCompleted: { key: (d) => `build:${str(d.ticketRef)}`, status: () => "COMPLETE", detail: () => "Runtime finished" },
  AgentFailed: { key: (d) => `build:${str(d.ticketRef)}`, status: () => "FAILED", detail: (d) => str(d.phase) || "Runtime failed" },
  RepairCompleted: { key: (d) => `repair:${str(d.ticketRef)}`, status: (d) => (d.status === "COMPLETED" ? "COMPLETE" : "FAILED"), detail: (d) => str(d.status) },
  TestPassed: { key: () => "test:", status: () => "COMPLETE", detail: (d, mission) => { const count = testsExecuted(mission, d.evidence_id); return count === null ? "Passed" : `${plural(count, "test")} executed, passed`; } },
  ReviewCompleted: { key: (d) => `review:${str(d.ticketRef)}`, status: (d) => (d.result === "PASS" ? "COMPLETE" : "FAILED"), detail: (d) => str(d.result) },
  ReviewFailed: { key: (d) => `review:${str(d.ticketRef)}`, status: () => "FAILED", detail: (d) => str(d.result) },
  AttackCompleted: { key: (d) => `attack:${str(d.ticketRef)}`, status: (d) => (d.result === "PASS" ? "COMPLETE" : "FAILED"), detail: (d) => str(d.result) },
  AttackFailed: { key: (d) => `attack:${str(d.ticketRef)}`, status: () => "FAILED", detail: (d) => str(d.result) },
  BrowserCompleted: { key: () => "browser", status: () => "COMPLETE", detail: () => "PASS" },
  BrowserFailed: { key: () => "browser", status: () => "FAILED", detail: (d) => str(d.status) },
  SecurityCompleted: { key: () => "security", status: () => "COMPLETE", detail: (d) => `${str(d.status)} · ${plural(Number(d.findings ?? 0), "finding")}` },
  SecurityFailed: { key: () => "security", status: () => "FAILED", detail: (d) => `${str(d.status)} · ${plural(Number(d.findings ?? 0), "finding")}` },
  NfrCompleted: { key: () => "nfr", status: () => "COMPLETE", detail: (d) => str(d.status) },
  NfrFailed: { key: () => "nfr", status: () => "FAILED", detail: (d) => str(d.status) },
  ArchitectureVerificationCompleted: { key: () => "architecture", status: (d) => (d.status === "PASS" ? "COMPLETE" : "FAILED"), detail: (d) => str(d.status) },
};

/** A start with no end older than this is shown as UNKNOWN: the process may have been interrupted. */
const STALE_MS = 20 * 60 * 1000;

/**
 * Agents derived from start/end event pairs. Nothing is invented: an agent is WORKING only when its start event
 * has no matching end event, and becomes UNKNOWN when that start is too old to still be running.
 */
export function deriveAgents(events: DomainEvent[], mission: Mission, now = Date.now()): { active: AgentActivity[]; recent: AgentActivity[] } {
  const open = new Map<string, AgentActivity>();
  const recent: AgentActivity[] = [];
  for (const event of events) {
    const data = event.data ?? {};
    const start = STARTS[event.type];
    if (start && !(event.type === "AttackStarted" && !data.attacker) && !(event.type === "TestStarted" && !data.ticketRef)) {
      const key = event.type === "TestStarted" ? "test:" : start.key(data);
      open.set(key, { key, name: start.name(data), task: start.task(data), status: "WORKING", detail: "", since: event.at });
      continue;
    }
    if (event.type === "TestFailed" && data.kind === "unit" && open.has("test:")) {
      const agent = open.get("test:") as AgentActivity;
      open.delete("test:");
      recent.push({ ...agent, status: "FAILED", detail: "Tests failed" });
      continue;
    }
    const end = ENDS[event.type];
    if (!end) continue;
    const key = end.key(data);
    const agent = open.get(key);
    if (!agent) continue;
    open.delete(key);
    recent.push({ ...agent, status: end.status(data), detail: end.detail(data, mission) });
  }
  const active = [...open.values()].map((agent) => (now - Date.parse(agent.since) > STALE_MS ? { ...agent, status: "UNKNOWN" as const, detail: "No completion event was recorded" } : agent));
  return { active: active.filter((agent) => agent.status === "WORKING").concat(active.filter((agent) => agent.status === "UNKNOWN")), recent: recent.slice(-6).reverse() };
}

export interface TimelineItem {
  label: string;
  state: "done" | "active" | "failed" | "waiting";
}

export function deriveTimeline(events: DomainEvent[], mission: Mission): TimelineItem[] {
  const has = (type: string) => events.some((event) => event.type === type);
  const agents = deriveAgents(events, mission).active.filter((agent) => agent.status === "WORKING").map((agent) => agent.key);
  const items: TimelineItem[] = [{ label: "Mission created", state: has("MissionCreated") ? "done" : "waiting" }];
  items.push({ label: "Forge", state: mission.forge?.outcome === "hardened" ? "done" : mission.forge ? (agents.includes("skill:bmad-forge-idea") ? "active" : "waiting") : "done" });
  if (mission.requirements.length > 0) items.push({ label: `${plural(mission.requirements.length, "requirement")} recorded`, state: "done" });
  for (const step of mission.workflow) {
    if (["bmad-forge-idea", "bmad-build", "bmad-code-review", "bmad-retrospective", "bmad-preview-ticketing"].includes(step.skillId) || step.skillId.startsWith("bmad-next:")) continue;
    const state = step.status === "completed" ? "done" : agents.includes(`skill:${step.skillId}`) ? "active" : step.status === "blocked" ? "failed" : "waiting";
    items.push({ label: skillLabel(step.skillId), state });
  }
  items.push({ label: mission.ticketTreeAccepted ? `Ticket tree accepted (${mission.tickets.map((ticket) => ticket.ref).join(", ")})` : "Ticket tree", state: mission.ticketTreeAccepted ? "done" : "waiting" });
  for (const ticket of mission.tickets) {
    const plan = mission.plans.find((item) => item.ref === ticket.ref)?.status;
    const built = plan === "built" || plan === "done" || Boolean((mission.executions ?? []).find((item) => item.ticketRef === ticket.ref)?.artifact);
    items.push({ label: `Ticket ${ticket.ref} build`, state: agents.includes(`build:${ticket.ref}`) || agents.includes(`repair:${ticket.ref}`) ? "active" : built ? "done" : "waiting" });
  }
  const report = evaluateRelease(mission, fileExists);
  const gate = (id: string, label: string, agentKey: string) => {
    const criterion = report.criteria.find((item) => item.id === id);
    if (!criterion) return;
    const state: TimelineItem["state"] = agents.some((key) => key.startsWith(agentKey)) ? "active" : criterion.state === "pass" || criterion.state === "waived" ? "done" : criterion.state === "fail" ? "failed" : "waiting";
    items.push({ label, state });
  };
  gate("unit", "Tests", "test:");
  gate("review", "Review", "review:");
  gate("attack", "Attack", "attack:");
  gate("browser", "Browser", "browser");
  gate("security", "Security", "security");
  gate("nfr", "NFR", "nfr");
  gate("architecture", "Architecture check", "architecture");
  gate("traceability", "Traceability", "traceability");
  const approval = report.criteria.find((item) => item.id === "human-release");
  if (approval) items.push({ label: "Release approval", state: approval.state === "pass" ? "done" : approval.state === "fail" ? "failed" : "waiting" });
  items.push({ label: "Release", state: mission.lastVerifiedBuild ? "done" : "waiting" });
  return items;
}

// ---------------------------------------------------------------------------------------------------------------
// Commands

export type JarvisIntentName =
  | "create_mission"
  | "status"
  | "agents"
  | "phase"
  | "blocked"
  | "review"
  | "continue"
  | "pause"
  | "resume"
  | "stop"
  | "evidence"
  | "summarize"
  | "exit_jarvis"
  | "unknown";

export const JARVIS_INTENTS: JarvisIntentName[] = ["create_mission", "status", "agents", "phase", "blocked", "review", "continue", "pause", "resume", "stop", "evidence", "summarize", "exit_jarvis", "unknown"];

export interface JarvisIntent {
  name: JarvisIntentName;
  idea?: string;
}

/**
 * The only gate between an interpreter (Gemini or the text parser) and the control plane. Anything that is not a
 * known intent with valid arguments becomes "unknown", which answers but never mutates.
 */
export function validateIntent(raw: unknown): { ok: true; intent: JarvisIntent } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "The interpreter returned no intent." };
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim().toLowerCase() : "";
  if (!JARVIS_INTENTS.includes(name as JarvisIntentName)) return { ok: false, reason: `"${name || "(empty)"}" is not a supported command.` };
  if (name === "create_mission") {
    const idea = typeof record.idea === "string" ? record.idea.replace(/\s+/g, " ").trim() : "";
    if (idea.length < 12) return { ok: false, reason: "A new mission needs a clear description of what to build." };
    if (idea.length > 1000) return { ok: false, reason: "That mission description is too long." };
    return { ok: true, intent: { name: "create_mission", idea } };
  }
  return { ok: true, intent: { name: name as JarvisIntentName } };
}

/** Deterministic interpreter for typed commands, used when no voice-intent provider is available. */
export function parseCommand(text: string): JarvisIntent {
  const clean = text.replace(/^\s*(hey\s+)?jarvis[,:]?\s*/i, "").trim();
  const lower = clean.toLowerCase().replace(/[?.!]+$/g, "");
  const build = clean.match(/^(?:please\s+)?(?:build|create|make|start a mission to build|new mission:?)\s+(.+)$/i);
  if (build && !/^(the|this|it|ticket)\b/i.test(build[1] ?? "")) return { name: "create_mission", idea: `Build ${build[1]?.trim()}` };
  if (/\b(exit|leave|close|turn off)\b.*\bjarvis\b|^exit$/.test(lower)) return { name: "exit_jarvis" };
  if (/\b(what('?s| is)\s+blocked|blocker|blocking|what'?s wrong|stuck)\b/.test(lower)) return { name: "blocked" };
  if (/\b(reviewer|review)\b/.test(lower)) return { name: "review" };
  if (/\b(which|what|how many)\b.*\bagents?\b|\bagents?\b.*\brunning\b/.test(lower)) return { name: "agents" };
  if (/\bphase\b/.test(lower)) return { name: "phase" };
  if (/\bevidence\b/.test(lower)) return { name: "evidence" };
  if (/\bsummar(y|ize|ise)\b/.test(lower)) return { name: "summarize" };
  if (/^(continue|go on|carry on|proceed|keep going|run( the)? mission)$/.test(lower)) return { name: "continue" };
  if (/^(pause|pause( the)? mission|hold)$/.test(lower)) return { name: "pause" };
  if (/^(resume|resume( the)? mission|unpause)$/.test(lower)) return { name: "resume" };
  if (/^(stop|stop( the)? mission|halt)$/.test(lower)) return { name: "stop" };
  if (/\b(what are you doing|what'?s happening|status|what'?s going on|progress)\b/.test(lower)) return { name: "status" };
  return { name: "unknown" };
}

// ---------------------------------------------------------------------------------------------------------------
// Answers from state

export function answerQuestion(name: JarvisIntentName, mission: Mission | null, events: DomainEvent[], next: { skillId: string } | null): string {
  if (!mission) return "There is no active mission. Tell me what to build to start one.";
  const { active, recent } = deriveAgents(events, mission);
  const working = active.filter((agent) => agent.status === "WORKING");
  const report = evaluateRelease(mission, fileExists);
  const lastStop = [...events].reverse().find((event) => event.type === "AutopilotStopped" || event.type === "AutopilotStarted");
  switch (name) {
    case "status":
    case "agents": {
      if (working.length === 0) {
        const nextStep = next ? ` Next step: ${skillLabel(next.skillId)}.` : "";
        return name === "agents" ? "No agents are running." : `No agent is running. The mission is ${mission.loop} in the ${mission.phase} phase.${nextStep}`;
      }
      const list = working.map((agent) => `${agent.name}: ${agent.task}`).join(". ");
      return `${plural(working.length, "agent")} ${working.length === 1 ? "is" : "are"} active. ${list}.`;
    }
    case "phase":
      return `The mission is in the ${mission.phase} phase. Loop state is ${mission.loop}.`;
    case "blocked": {
      const failing = report.criteria.filter((item) => item.state === "fail" || (item.state === "blocked" && !item.pending));
      const stopped = lastStop?.type === "AutopilotStopped" && lastStop.data.status === "blocked" ? ` The autopilot stopped: ${firstSentence(str(lastStop.data.reason))}` : "";
      if (failing.length === 0 && !stopped) {
        const pending = report.criteria.filter((item) => item.pending && item.state !== "pass").map((item) => item.label.toLowerCase());
        return pending.length > 0 ? `Nothing is blocked. Not run yet: ${pending.join(", ")}.` : "Nothing is blocked.";
      }
      return `${failing.map((item) => `${item.label} is ${item.state}: ${firstSentence(item.detail)}`).join(" ")}${stopped}`.trim();
    }
    case "review": {
      const latest = (mission.reviews ?? []).at(-1);
      if (!latest) return "No review has run yet.";
      const blocking = latest.findings.filter((finding) => finding.severity === "high" || finding.severity === "critical");
      const findings = blocking.slice(0, 2).map((finding) => firstSentence(finding.message)).join(" ");
      const unclear = (latest.unclear ?? []).length > 0 ? ` It could not confirm ${latest.unclear?.join(", ")}.` : "";
      return `The latest review of ticket ${latest.ticketRef} is ${latest.status} with ${plural(blocking.length, "blocking finding")}.${findings ? ` ${findings}` : ""}${unclear}`;
    }
    case "evidence": {
      const kinds = ["unit", "review", "attack", "browser", "security", "nfr", "architecture", "traceability"];
      const latest = kinds.map((kind) => [kind, [...mission.evidence].reverse().find((record) => record.kind === kind)?.result ?? "not run"] as const);
      return `Evidence: ${latest.map(([kind, result]) => `${kind} ${result}`).join(", ")}. ${recent.length > 0 ? `Last activity: ${recent[0]?.name} ${recent[0]?.status.toLowerCase()}.` : ""}`.trim();
    }
    case "summarize": {
      const passed = report.criteria.filter((item) => item.state === "pass").length;
      return `${mission.title} Phase ${mission.phase}, loop ${mission.loop}. ${plural(mission.requirements.length, "requirement")}, ${plural(mission.tickets.length, "ticket")}. Release gate ${report.state}: ${passed} of ${report.criteria.length} criteria pass.`;
    }
    default:
      return "I can create a mission, report status, agents, phase, blockers, review results, and evidence, and continue, pause, resume, or stop the mission.";
  }
}

/** Minimal, redacted mission context for an external interpreter. No paths, logs, or file contents. */
export function sanitizedContext(mission: Mission | null): Record<string, unknown> {
  if (!mission) return { mission: null };
  return {
    mission: { title: redactSecrets(mission.title).slice(0, 200), phase: mission.phase, loop: mission.loop },
    tickets: mission.tickets.map((ticket) => ticket.ref),
    requirements: mission.requirements.map((requirement) => requirement.id),
  };
}
