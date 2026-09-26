import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { impactFromImports, materialQuestions } from "../analysis";
import { LocalSandbox } from "../collaboration";
import { BmadControlPlane } from "../plane";
import { authorizeAgent, decideCommand } from "../policy";
import { assertPassEvidence, EvidenceError } from "../quality";
import { saveMission } from "../store";
import { escapeHtml, renderMissionControl } from "../render";
import { parseIntent } from "../intent";
import { assertTomlHasNoStatus } from "../tickets";
import type { CommandRunner, EvidenceRecord } from "../types";

function tempProject(): string {
  const base = path.resolve(__dirname, "../../../../.tmp");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "bmad-"));
}

function answerAll(plane: BmadControlPlane, id: string): void {
  let mission = plane.mission(id);
  while (mission.forge && mission.forge.outcome === "active") {
    const open = mission.forge.questions.find((question) => !mission.forge?.answered.includes(question.id));
    if (!open) break;
    mission = plane.answerForge(id, `locked answer for ${open.id}`);
  }
}

test("expense mission selects the critical BMAD workflow and does not verify itself", () => {
  const root = tempProject();
  const plane = new BmadControlPlane(root);
  const mission = plane.createMission("Build an expense-management SaaS.");
  assert.equal(mission.complexity, "critical");
  assert.equal(mission.mode, "greenfield");
  const skills = mission.workflow.map((step) => step.skillId);
  for (const skill of ["bmad-forge-idea", "bmad-spec", "bmad-prd", "bmad-ux", "bmad-architecture", "bmad-preview-ticketing", "bmad-build", "bmad-code-review", "bmad-next:attack", "bmad-next:browser", "bmad-next:security", "bmad-next:nfr", "bmad-next:release", "bmad-retrospective"]) {
    assert.ok(skills.includes(skill), skill);
  }
  assert.equal(mission.workflow.find((step) => step.skillId === "bmad-spec")?.status, "awaiting-model");
  const questions = materialQuestions(mission.input, []);
  assert.ok(questions.some((question) => /currenc/i.test(question.prompt)));
  assert.ok(questions.some((question) => /sign in/i.test(question.prompt)));
  assert.throws(() => plane.answerForge(mission.id, "harden"));
  answerAll(plane, mission.id);
  const hardened = plane.answerForge(mission.id, "harden");
  assert.equal(hardened.forge?.outcome, "hardened");
  assert.equal(hardened.requirements[0]?.id, "REQ-001");
  assert.equal(hardened.requirements[0]?.source, "forge-lock");
  assert.equal(fs.readFileSync(path.join(root, hardened.forge?.workspace ?? "", "forged-idea.md"), "utf8").includes("forge-report.html"), false);
  const events = fs.readFileSync(path.join(root, ".bmad-next", "missions", mission.id, "events.jsonl"), "utf8");
  assert.equal(events.includes("SpecCreated"), false);
  const release = plane.releaseGate(mission.id);
  assert.equal(release.state, "blocked");
  assert.equal(release.lastVerifiedBuild, null);
  const html = renderMissionControl(plane.mission(mission.id));
  assert.match(html, /IN PROGRESS \(\d+ checks not run yet\)/);
  assert.match(html, /not run yet/);
  assert.doesNotMatch(html, /RELEASE READY/);
});

test("a typo uses the quick workflow", () => {
  const plane = new BmadControlPlane(tempProject());
  const mission = plane.createMission("Fix typo in the readme");
  assert.equal(mission.complexity, "simple");
  assert.equal(mission.mode, "quick");
  assert.deepEqual(mission.workflow.map((step) => step.skillId), ["bmad-spec", "bmad-build", "bmad-code-review"]);
});

test("loop state cannot skip to verified", () => {
  const plane = new BmadControlPlane(tempProject());
  const mission = plane.createMission("Fix typo in the readme");
  assert.throws(() => plane.transitionLoop(mission.id, "verified"), /Cannot move draft to verified/);
});

test("passing evidence requires a real artifact and runner", () => {
  const root = tempProject();
  const plane = new BmadControlPlane(root);
  const mission = plane.createMission("Fix typo in the readme");
  const missing: EvidenceRecord = {
    evidence_id: "ev_x",
    mission_id: mission.id,
    timestamp: "2026-09-26T00:00:00.000Z",
    result: "pass",
    kind: "unit",
    runner: "process",
    started_at: "2026-09-26T00:00:00.000Z",
    finished_at: "2026-09-26T00:00:01.000Z",
    exit_code: 0,
    command: "npm test",
    artifact: path.join(root, "missing.log"),
    type: "unit",
    source: "process",
  };
  assert.throws(() => assertPassEvidence(missing, false), EvidenceError);
  assert.throws(
    () =>
      plane.recordEvidence(mission.id, {
        result: "pass",
        kind: "unit",
        runner: "process",
        started_at: missing.started_at,
        finished_at: missing.finished_at,
        exit_code: 0,
        command: "npm test",
        artifact: missing.artifact,
      }),
    /does not exist/,
  );
});

test("command policy blocks destructive commands", () => {
  assert.equal(decideCommand("drop database payments", "autonomous").decision, "block");
  assert.equal(decideCommand("npm test", "assist").decision, "allow");
  assert.equal(decideCommand("git push origin main", "autonomous").decision, "approval");
  assert.equal(decideCommand("npm test", "observe").decision, "block");
});

test("agent contracts reject writes outside the granted tree", () => {
  const plane = new BmadControlPlane(tempProject());
  const mission = plane.createMission("Build an expense-management SaaS.");
  const payment = mission.agents.find((agent) => agent.name === "payment-engineer");
  assert.ok(payment);
  assert.equal(authorizeAgent(payment, { type: "write", path: "src/payments/charge.ts" }).allowed, true);
  assert.equal(authorizeAgent(payment, { type: "write", path: "src/auth/login.ts" }).allowed, false);
  assert.equal(authorizeAgent(payment, { type: "exec", command: "drop database payments" }).allowed, false);
});

test("accepted ticket tree omits status and keeps upstream entry shape", () => {
  const root = tempProject();
  const plane = new BmadControlPlane(root);
  const mission = plane.createMission("Build an expense-management SaaS.");
  answerAll(plane, mission.id);
  plane.answerForge(mission.id, "harden");
  const accepted = plane.acceptTicketTree(mission.id, "ada");
  assert.equal(accepted.ticketTreeAccepted, true);
  assert.equal(accepted.plans.length, 0);
  const toml = fs.readFileSync(path.join(root, "_bmad-output", mission.id, "tickets.toml"), "utf8");
  assertTomlHasNoStatus(toml);
  assert.match(toml, /\[\[epic\]\]/);
  const entry = fs.readFileSync(path.join(root, "_bmad-output", mission.id, accepted.epics[0]?.slug ?? "", "tickets.toml"), "utf8");
  assert.match(entry, /\[\[entry\]\]/);
  assert.match(entry, /covers = \["REQ-001"\]/);
  assert.doesNotMatch(entry, /^\s*status\s*=/m);
  const reloaded = new BmadControlPlane(root).mission(mission.id);
  assert.equal(reloaded.requirements[0]?.id, "REQ-001");
});

test("drift, gaps, and course correction use recorded facts", () => {
  const root = tempProject();
  const plane = new BmadControlPlane(root);
  const mission = plane.createMission("Build an expense-management SaaS.");
  answerAll(plane, mission.id);
  plane.answerForge(mission.id, "harden");
  plane.correctCourse(mission.id, "REQ-001", "Reset links expire after 15-minute.", "The policy was stated.");
  plane.declareArchitecture(mission.id, { id: "ADR-1", kind: "database", choice: "PostgreSQL", alternatives: ["MongoDB"] });
  plane.declareJourney(mission.id, { id: "onboarding", name: "Onboarding", steps: 3 });
  const findings = plane.crossCheck(mission.id, [
    { path: "src/auth/reset.ts", text: "const expiry = '30-minute'" },
    { path: "package.json", text: '{"dependencies":{"mongodb":"6.0.0"}}' },
  ]);
  assert.ok(findings.some((finding) => finding.code === "REQUIREMENT_DRIFT"));
  assert.ok(findings.some((finding) => finding.code === "ARCHITECTURE_DRIFT"));
  assert.equal(findings.some((finding) => finding.code === "UX_DRIFT"), false);
  const ux = plane.crossCheck(mission.id, [], [{ journeyId: "onboarding", steps: 7 }]);
  assert.ok(ux.some((finding) => finding.code === "UX_DRIFT"));
  const changed = plane.correctCourse(mission.id, "REQ-001", "Reset links expire after 10-minute.", "Support changed the policy.");
  assert.equal(changed.id, mission.id);
  assert.equal(changed.requirements[0]?.version, 3);
  assert.equal(changed.requirements[0]?.description, "Reset links expire after 10-minute.");
});

test("party mode does not invent agreement", () => {
  const plane = new BmadControlPlane(tempProject());
  const mission = plane.createMission("Build an expense-management SaaS.");
  const room = plane.openParty(mission.id, "Database", "architecture", "anti-consensus");
  plane.addPartyTurn(mission.id, room.id, { speaker: "Architect", stance: "defend", text: "PostgreSQL", source: "user" });
  plane.addPartyTurn(mission.id, room.id, { speaker: "Security", stance: "defend", text: "PostgreSQL", source: "user" });
  assert.throws(() => plane.recordDecision(mission.id, room.id, {
    title: "Database",
    decision: "PostgreSQL",
    alternatives: ["MongoDB"],
    reasoning: "same stance",
    evidenceIds: [],
    consequences: "one datastore",
    adrId: "ADR-004",
  }), /Anti-consensus/);
  plane.addPartyTurn(mission.id, room.id, { speaker: "TEA", stance: "dissent", text: "The test story is weaker on PostgreSQL.", source: "user" });
  const decision = plane.recordDecision(mission.id, room.id, {
    title: "Database",
    decision: "PostgreSQL",
    alternatives: ["MongoDB"],
    reasoning: "Dissent was recorded before the decision.",
    evidenceIds: [],
    consequences: "one datastore",
    adrId: "ADR-004",
  });
  assert.equal(decision.adrId, "ADR-004");
  assert.equal(plane.mission(mission.id).architecture[0]?.choice, "PostgreSQL");
});

test("unpublished skills and unconfigured runtimes stay blocked", () => {
  const root = tempProject();
  const plane = new BmadControlPlane(root);
  const mission = plane.createMission("Build an expense-management SaaS.");
  answerAll(plane, mission.id);
  plane.answerForge(mission.id, "harden");
  plane.acceptTicketTree(mission.id, "ada");
  const dispatch = plane.dispatch(mission.id, "1.1");
  assert.equal(dispatch.status, "not-configured");
  const events = fs.readFileSync(path.join(root, ".bmad-next", "missions", mission.id, "events.jsonl"), "utf8");
  assert.equal(events.includes("AgentStarted"), false);
  plane.proposeSkill(mission.id, "expense-reset", "repeated failure", "Check the expiry unit.");
  const skillId = plane.mission(mission.id).brain.skillCandidates[0]?.id ?? "";
  assert.throws(() => plane.publishSkill(mission.id, skillId), /unpublished/);
  plane.recordEvaluation(mission.id, skillId, 2, 1);
  assert.throws(() => plane.publishSkill(mission.id, skillId), /unpublished/);
  plane.recordEvaluation(mission.id, skillId, 2, 2);
  assert.equal(plane.publishSkill(mission.id, skillId).brain.skillCandidates[0]?.published, true);
});

test("context, arena, mutation, and impact stay measured", () => {
  const root = tempProject();
  const plane = new BmadControlPlane(root);
  const mission = plane.createMission("Fix typo in the readme");
  const bundle = plane.contextFor(mission.id, "missing", 30);
  assert.ok(bundle.omitted.length > 0);
  assert.ok(bundle.text.length <= 30 + 200);
  assert.equal(plane.arena([{ agent: "A", testsPassed: 1, testsTotal: 1, securityFindings: null, nfrMet: true, cost: 1, latencyMs: 1, reviewFindings: 0, requirementsSatisfied: 1 }]).winner, null);
  assert.equal(plane.mutation(null).score, null);
  const measured = plane.mutation({ injected: 100, caught: 92 });
  assert.equal(measured.score, 0.92);
  const files = new Map<string, string>([
    ["src/auth.ts", "export const auth = 1"],
    ["src/app.ts", "import { auth } from './auth'"],
    ["src/other.ts", "export const other = 1"],
  ]);
  assert.deepEqual(plane.impact(files, "src/auth.ts").sort(), ["src/app.ts", "src/auth.ts"]);
  void impactFromImports;
});

test("doctor reports the real node version and missing BMAD install", () => {
  const checks = new BmadControlPlane(tempProject()).doctor();
  const node = checks.find((check) => check.name === "Node");
  assert.equal(node?.status, "available");
  assert.match(node?.detail ?? "", /v\d+/);
  const memlog = checks.find((check) => check.name === "BMAD memlog");
  assert.equal(memlog?.status, "not-configured");
});

test("sandbox keeps files in its directory and denies network commands", () => {
  const root = tempProject();
  let ran = false;
  const runner: CommandRunner = {
    which: () => "/bin/echo",
    run: () => {
      ran = true;
      return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, timedOut: false };
    },
  };
  const sandbox = new LocalSandbox(path.join(root, ".bmad-next"), runner);
  const handle = sandbox.create("box-1");
  assert.equal(handle.securityBoundary, false);
  sandbox.writeFile("box-1", "note.txt", "evidence");
  assert.equal(sandbox.readFile("box-1", "note.txt"), "evidence");
  assert.throws(() => sandbox.writeFile("box-1", "../escape.txt", "no"));
  const denied = sandbox.exec("box-1", "curl", ["https://example.com"]);
  assert.equal(denied.blocked, true);
  assert.equal(ran, false);
});

test("release can pass only after recorded runs, architecture, traceability, and approval", () => {
  const root = tempProject();
  const plane = new BmadControlPlane(root);
  const created = plane.createMission("Build an expense-management SaaS.");
  answerAll(plane, created.id);
  plane.answerForge(created.id, "harden");
  plane.acceptTicketTree(created.id, "ada");
  plane.declareArchitecture(created.id, { id: "ADR-1", kind: "database", choice: "PostgreSQL", alternatives: [] });
  const kinds = ["unit", "review", "security", "browser", "attack", "nfr"];
  for (const kind of kinds) {
    const artifact = path.join(root, `${kind}.log`);
    fs.writeFileSync(artifact, `${kind} ok`);
    plane.recordEvidence(created.id, {
      requirement_id: "REQ-001",
      result: "pass",
      kind,
      runner: "process",
      started_at: "2026-09-26T00:00:00.000Z",
      finished_at: "2026-09-26T00:00:01.000Z",
      exit_code: 0,
      command: `run ${kind}`,
      artifact,
    });
  }
  const traced = plane.mission(created.id);
  if (traced.requirements[0]) traced.requirements[0].acceptance_criteria = ["An expense can be recorded and verified."];
  saveMission(root, traced);
  plane.verifyTraceability(created.id);
  assert.match(fs.readFileSync(path.join(root, ".bmad-next", "evidence", created.id, "traceability.json"), "utf8"), /REQ-001 implementation/);
  const built = plane.mission(created.id);
  built.plans.push({ ref: "1.1", status: "built", baseline_revision: null, blocked_reason: null, body: "", version: 1 });
  saveMission(root, built);
  plane.verifyArchitecture(created.id);
  plane.verifyTraceability(created.id);
  plane.approve(created.id, "release", "ada", "Reviewed the evidence files.");
  const report = plane.releaseGate(created.id);
  assert.equal(report.state, "pass");
  assert.ok(plane.mission(created.id).lastVerifiedBuild);
  const releaseFile = path.join(root, ".bmad-next", "evidence", created.id, "release.json");
  const sealed = fs.readFileSync(releaseFile, "utf8");
  assert.match(sealed, /"decision": "pass"/);
  fs.rmSync(path.join(root, "unit.log"));
  const again = plane.releaseGate(created.id);
  assert.equal(again.state, "blocked");
  assert.equal(fs.readFileSync(releaseFile, "utf8"), sealed);
  assert.equal(plane.verifyRelease(created.id).matches, false);
  assert.ok(plane.mission(created.id).lastVerifiedBuild);
});

test("intent routing and recommendation follow mission state", () => {
  assert.equal(parseIntent("@bmad what should I do next?").name, "next");
  assert.equal(parseIntent("@bmad verify REQ-021").target, "REQ-021");
  assert.equal(parseIntent("@bmad build story 3.2").skillId, "bmad-build");
  const plane = new BmadControlPlane(tempProject());
  const mission = plane.createMission("Build an expense-management SaaS.");
  assert.equal(plane.recommend(mission.id).skillId, "bmad-forge-idea");
  const html = renderMissionControl(mission);
  assert.equal(escapeHtml("<script>"), "&lt;script&gt;");
  assert.match(html, /awaiting-user/);
});

test("overlapping tickets are reported instead of merged", () => {
  const plane = new BmadControlPlane(tempProject());
  const mission = plane.createMission("Build an expense-management SaaS.");
  answerAll(plane, mission.id);
  plane.answerForge(mission.id, "harden");
  plane.proposeTickets(mission.id);
  const current = plane.mission(mission.id);
  const first = current.tickets[0];
  assert.ok(first);
  first.paths = ["src/payments/charge.ts"];
  current.tickets.push({
    ...first,
    id: 2,
    ref: "1.2",
    paths: ["src/payments/charge.ts"],
    title: "second",
  });
  plane.importMission(JSON.stringify({ mission: current }));
  assert.match(plane.conflicts(mission.id)[0] ?? "", /1\.1 conflicts with 1\.2/);
});

test("repository scan does not claim a reconstructed architecture", () => {
  const root = tempProject();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { mongodb: "6.0.0" } }));
  fs.mkdirSync(path.join(root, "Assets"));
  const report = new BmadControlPlane(root).scan("deep");
  assert.equal(report.reconstructedArchitecture, false);
  assert.equal(report.gameModule, true);
  assert.ok(report.observations.some((line) => line.includes("mongodb")));
});
