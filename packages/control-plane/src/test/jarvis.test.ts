import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  JarvisMachine,
  NarrationLog,
  answerQuestion,
  deriveAgents,
  deriveTimeline,
  narrateEvent,
  parseCommand,
  sanitizedContext,
  shouldSpeak,
  validateIntent,
} from "../jarvis";
import { BmadControlPlane } from "../plane";
import { saveMission } from "../store";
import type { DomainEvent } from "../types";

const TODO = "Build a simple todo web app with add, complete, delete, and local persistence.";

function tempProject(): string {
  const base = path.resolve(__dirname, "../../../../.tmp");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "jarvis-"));
}

function event(type: string, data: Record<string, unknown> = {}, at = new Date().toISOString(), id = `evt_${Math.random().toString(16).slice(2)}`): DomainEvent {
  return { id, type: type as DomainEvent["type"], missionId: "m", at, data };
}

function hardenedMission(): { plane: BmadControlPlane; id: string; root: string } {
  const root = tempProject();
  const plane = new BmadControlPlane(root);
  const id = plane.createMission(TODO).id;
  for (const answer of ["A person keeping a todo list.", "Todos survive a reload.", "No accounts."]) plane.answerForge(id, answer);
  plane.answerForge(id, "harden");
  return { plane, id, root };
}

test("the Jarvis state machine is deterministic and rejects illegal transitions", () => {
  const machine = new JarvisMachine();
  const seen: string[] = [];
  machine.onChange((state) => seen.push(state));
  assert.equal(machine.state, "JARVIS_OFF");
  assert.throws(() => machine.to("JARVIS_LISTENING"), /cannot move from JARVIS_OFF to JARVIS_LISTENING/);
  machine.to("JARVIS_STARTING");
  machine.to("JARVIS_ACTIVE");
  machine.to("JARVIS_LISTENING");
  machine.to("JARVIS_PROCESSING");
  machine.to("JARVIS_SPEAKING");
  machine.to("JARVIS_ACTIVE");
  machine.to("JARVIS_PAUSED");
  assert.throws(() => machine.to("JARVIS_LISTENING"), /cannot move/);
  machine.to("JARVIS_ACTIVE");
  machine.to("JARVIS_OFF");
  assert.deepEqual(seen, ["JARVIS_STARTING", "JARVIS_ACTIVE", "JARVIS_LISTENING", "JARVIS_PROCESSING", "JARVIS_SPEAKING", "JARVIS_ACTIVE", "JARVIS_PAUSED", "JARVIS_ACTIVE", "JARVIS_OFF"]);
});

test("real events narrate from mission state, silent events stay silent, and the policy decides what is spoken", () => {
  const { plane, id } = hardenedMission();
  const mission = plane.mission(id);
  assert.equal(narrateEvent(event("ForgeClosed", { outcome: "hardened" }), mission).text, "Forge is complete. 1 requirement recorded.");
  assert.equal(narrateEvent(event("TicketStarted", { ticketRef: "1.1", agent: "Developer" }), mission).text, "Developer is building ticket 1.1.");
  assert.equal(narrateEvent(event("RepairStarted", { ticketRef: "1.1" }), mission).category, "IMPORTANT");
  assert.equal(narrateEvent(event("ReviewCompleted", { ticketRef: "1.1", result: "FAIL" }), mission).text, "Review failed.");
  assert.equal(narrateEvent(event("ReviewCompleted", { ticketRef: "1.1", result: "PASS" }), mission).text, "Review passed.");
  const silent = narrateEvent(event("WorktreeReleased", { ticketRef: "1.1" }), mission);
  assert.equal(silent.category, "SILENT");
  assert.equal(shouldSpeak("SILENT", "all"), false);
  assert.equal(shouldSpeak("INFO", "important"), false);
  assert.equal(shouldSpeak("INFO", "all"), true);
  assert.equal(shouldSpeak("WARNING", "important"), true);
  assert.equal(shouldSpeak("COMPLETION", "off"), false);
  const blocked = narrateEvent(event("AutopilotStopped", { status: "blocked", reason: "Ticket 1.1 spent its retry budget (tests fail). More detail follows." }), mission);
  assert.equal(blocked.category, "ERROR");
  assert.equal(blocked.text, "Mission is blocked. Ticket 1.1 spent its retry budget (tests fail).");
  const log = new NarrationLog();
  assert.equal(log.firstTime("evt_1"), true);
  assert.equal(log.firstTime("evt_1"), false);
});

test("completion is narrated only when evidence supports it, and approval is never called a release", () => {
  const { plane, id, root } = hardenedMission();
  const early = narrateEvent(event("ReleaseGateEvaluated", { state: "blocked" }), plane.mission(id));
  assert.equal(early.category, "INFO");
  assert.doesNotMatch(early.text, /complete/i);
  plane.acceptTicketTree(id, "Ada");
  plane.declareArchitecture(id, { id: "L", kind: "layer", choice: "app", alternatives: [] });
  for (const kind of ["unit", "review"]) {
    const artifact = path.join(root, `${kind}.log`);
    fs.writeFileSync(artifact, "ok");
    plane.recordEvidence(id, { requirement_id: "REQ-001", story_id: "1.1", result: "pass", kind, runner: "process", started_at: "2026-09-26T00:00:00.000Z", finished_at: "2026-09-26T00:00:01.000Z", exit_code: 0, command: kind, artifact });
  }
  const built = plane.mission(id);
  built.plans.push({ ref: "1.1", status: "built", baseline_revision: null, blocked_reason: null, body: "", version: 1 });
  for (const record of built.evidence) record.requirement_id = "REQ-001";
  saveMission(root, built);
  fs.mkdirSync(path.join(root, "app"));
  plane.verifyArchitecture(id);
  plane.verifyTraceability(id);
  plane.releaseGate(id);
  const waiting = narrateEvent(event("ReleaseGateEvaluated", { state: "blocked" }), plane.mission(id));
  assert.equal(waiting.category, "COMPLETION");
  assert.equal(waiting.text, "Mission complete. All required verification gates have passed. Release is ready for your approval.");
  assert.doesNotMatch(waiting.text, /release (completed|recorded)/i);
  plane.approve(id, "release", "Ada", "Evidence reviewed.");
  plane.releaseGate(id);
  assert.equal(narrateEvent(event("ReleaseGateEvaluated", { state: "pass" }), plane.mission(id)).category, "SILENT");
  assert.equal(narrateEvent(event("ReleaseCreated", {}), plane.mission(id)).text, "Release recorded.");
});

test("agents come only from start and end events; a finished agent is not shown as working", () => {
  const { plane, id } = hardenedMission();
  const mission = plane.mission(id);
  assert.deepEqual(deriveAgents([], mission).active, []);
  const now = Date.now();
  const at = new Date(now - 1000).toISOString();
  const events = [
    event("SkillStarted", { skillId: "bmad-spec" }, at),
    event("SkillCompleted", { skillId: "bmad-spec" }, at),
    event("TicketStarted", { ticketRef: "1.1", agent: "Developer", runtime: "opencode" }, at),
    event("ReviewStarted", { ticketRef: "1.0", reviewer: "opencode" }, at),
  ];
  const agents = deriveAgents(events, mission, now);
  assert.deepEqual(agents.active.map((agent) => `${agent.name}|${agent.status}`), ["Developer (opencode)|WORKING", "Reviewer (opencode)|WORKING"]);
  assert.deepEqual(agents.recent.map((agent) => `${agent.task}|${agent.status}`), ["Specification|COMPLETE"]);
  const later = deriveAgents([...events, event("ReviewFailed", { ticketRef: "1.0", result: "FAIL" }, at)], mission, now);
  assert.equal(later.active.length, 1);
  const stale = deriveAgents(events, mission, now + 60 * 60 * 1000);
  assert.ok(stale.active.every((agent) => agent.status === "UNKNOWN"));
  assert.ok(deriveTimeline(events, mission).some((item) => item.label === "Specification"));
});

test("commands are interpreted then validated; nothing unknown or malformed reaches the control plane", () => {
  assert.deepEqual(parseCommand("Build a simple todo web app with add, complete, delete, and local persistence."), { name: "create_mission", idea: "Build a simple todo web app with add, complete, delete, and local persistence." });
  assert.equal(parseCommand("What are you doing?").name, "status");
  assert.equal(parseCommand("Which agents are running?").name, "agents");
  assert.equal(parseCommand("What's the current phase?").name, "phase");
  assert.equal(parseCommand("What is blocked?").name, "blocked");
  assert.equal(parseCommand("What did the reviewer find?").name, "review");
  assert.equal(parseCommand("Continue.").name, "continue");
  assert.equal(parseCommand("Pause.").name, "pause");
  assert.equal(parseCommand("Resume.").name, "resume");
  assert.equal(parseCommand("Stop.").name, "stop");
  assert.equal(parseCommand("Show me the evidence.").name, "evidence");
  assert.equal(parseCommand("Summarize the mission.").name, "summarize");
  assert.equal(parseCommand("Exit Jarvis mode.").name, "exit_jarvis");
  assert.equal(parseCommand("Sing me a song").name, "unknown");
  assert.equal(validateIntent({ name: "delete_everything" }).ok, false);
  assert.equal(validateIntent({ name: "create_mission", idea: "todo" }).ok, false);
  assert.equal(validateIntent(null).ok, false);
  assert.equal(validateIntent("status").ok, false);
  assert.deepEqual(validateIntent({ name: "STATUS" }), { ok: true, intent: { name: "status" } });
});

test("answers report actual state: no agents means none, and blockers are the real failing gates", () => {
  const { plane, id } = hardenedMission();
  const mission = plane.mission(id);
  assert.equal(answerQuestion("agents", mission, [], null), "No agents are running.");
  assert.match(answerQuestion("status", mission, [], plane.recommend(id)), /No agent is running\. The mission is draft in the specify phase\. Next step: Specification\./);
  assert.match(answerQuestion("blocked", mission, [], null), /^Nothing is blocked\. Not run yet: /);
  assert.equal(answerQuestion("review", mission, [], null), "No review has run yet.");
  assert.equal(answerQuestion("status", null, [], null), "There is no active mission. Tell me what to build to start one.");
  const stopped = [event("AutopilotStopped", { status: "blocked", reason: "Review of 1.1 stayed BLOCKED after 3 fresh reviews." })];
  assert.match(answerQuestion("blocked", mission, stopped, null), /The autopilot stopped: Review of 1\.1 stayed BLOCKED after 3 fresh reviews\./);
});

test("the interpreter context is minimal and redacted", () => {
  const { plane, id } = hardenedMission();
  const mission = plane.mission(id);
  mission.title = "Use token=sk-abcdefghijklmnop to deploy";
  const context = JSON.stringify(sanitizedContext(mission));
  assert.doesNotMatch(context, /sk-abcdefghijklmnop/);
  assert.doesNotMatch(context, /\.bmad-next|\/Users\//);
  assert.deepEqual(Object.keys(sanitizedContext(mission)).sort(), ["mission", "requirements", "tickets"]);
});
