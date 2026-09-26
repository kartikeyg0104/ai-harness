import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatMissionStatus } from "../demo";
import { loadProjectEnv } from "../env";
import { currentResultFor, detectEdgeCaseTests } from "../quality";
import { BmadControlPlane } from "../plane";
import { judgeReview, reviewPrompt, type ReviewContext } from "../reviewer";
import { applyAttackSurface, attackPrompt, judgeAttack } from "../attack";
import { acquireAutopilotLock, mergeMissionRecords, releaseAutopilotLock, saveMission } from "../store";
import type { Mission } from "../types";

const criterion = "The user can add a todo, mark it complete, delete it, reload the application, and still see unfinished and completed todos preserved through local storage.";

function context(testEvidence: ReviewContext["testEvidence"]): ReviewContext {
  return {
    missionId: "msn",
    missionTitle: "todo",
    ticketRef: "1.1",
    ticketTitle: "Todo",
    requirements: [{ id: "REQ-001", title: "Todo", acceptanceCriteria: [criterion] }],
    architecture: [],
    worktree: "/tmp/worktree",
    baseCommit: "a",
    headCommit: "a",
    changedFiles: ["todo.js"],
    diff: "+add()",
    testEvidence,
  };
}

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: "PASS",
    summary: "All acceptance criteria met. No blocking issues found.",
    findings: [],
    criteria: [{ requirementId: "REQ-001", criterion, status: "PASS" }],
    tests: { coversChangedBehavior: "PASS", wouldCatchRegression: "PASS", edgeCases: "UNCLEAR" },
    ...overrides,
  });
}

function judge(raw: string, testEvidence: ReviewContext["testEvidence"]) {
  return judgeReview({
    raw,
    processStatus: "completed",
    exitCode: 0,
    context: context(testEvidence),
    reviewerId: "opencode",
    model: "test",
    durationMs: 1,
    prompt: reviewPrompt(context(testEvidence)),
  });
}

test("reviewer prose PASS with incomplete structured tests stays BLOCKED", () => {
  const judged = judge(JSON.stringify({ status: "PASS", summary: "All acceptance criteria met. No blocking issues found.", findings: [], criteria: [{ requirementId: "REQ-001", criterion, status: "PASS" }] }), { result: "pass", exitCode: 0, command: "npm test", edgeCases: "present" });
  assert.equal(judged.status, "BLOCKED");
  assert.match(judged.summary, /test assessment/);
});

test("structured PASS with unit pass and all test fields PASS is PASS", () => {
  const judged = judge(body({ tests: { coversChangedBehavior: "PASS", wouldCatchRegression: "PASS", edgeCases: "PASS" } }), { result: "pass", exitCode: 0, command: "npm test", edgeCases: "present" });
  assert.equal(judged.status, "PASS");
  assert.equal(judged.unclear?.length ?? 0, 0);
});

test("missing edge-case test evidence keeps UNCLEAR edgeCases BLOCKED", () => {
  const judged = judge(body(), { result: "pass", exitCode: 0, command: "npm test", edgeCases: "missing" });
  assert.equal(judged.status, "BLOCKED");
  assert.deepEqual(judged.unclear, ["tests.edgeCases"]);
});

test("valid edge-case test evidence lets a structured PASS through UNCLEAR edgeCases", () => {
  const judged = judge(body(), { result: "pass", exitCode: 0, command: "npm test", edgeCases: "present" });
  assert.equal(judged.status, "PASS");
  assert.equal((judged.unclear ?? []).includes("tests.edgeCases"), false);
});

test("reviewer PASS without a passing unit run stays BLOCKED", () => {
  const judged = judge(body({ tests: { coversChangedBehavior: "PASS", wouldCatchRegression: "PASS", edgeCases: "PASS" } }), null);
  assert.equal(judged.status, "BLOCKED");
});

test("contradictory prose cannot become PASS when a criterion is UNCLEAR", () => {
  const judged = judge(body({ criteria: [{ requirementId: "REQ-001", criterion, status: "UNCLEAR" }], tests: { coversChangedBehavior: "PASS", wouldCatchRegression: "PASS", edgeCases: "PASS" } }), { result: "pass", exitCode: 0, command: "npm test", edgeCases: "present" });
  assert.equal(judged.status, "BLOCKED");
});

test("detectEdgeCaseTests is missing without a passing unit run and present when tests cover persist/reload", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bmad-edge-"));
  fs.writeFileSync(path.join(root, "app.test.js"), "it('adds', () => {});");
  assert.equal(detectEdgeCaseTests(root, [criterion], { result: "fail", log: "fail" }).status, "missing");
  assert.equal(detectEdgeCaseTests(root, [criterion], { result: "pass", log: "1 test" }).status, "missing");
  fs.writeFileSync(path.join(root, "app.test.js"), "it('persists across reload', () => {});\nit('loads from localStorage', () => {});\nit('deletes', () => {});");
  const found = detectEdgeCaseTests(root, [criterion], { result: "pass", log: "ok" });
  assert.equal(found.status, "present");
  assert.ok(found.matched.includes("persist") || found.matched.includes("reload") || found.matched.includes("storage"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("latest unit PASS supersedes an earlier FAIL of the same ticket", () => {
  const fail = { evidence_id: "ev1", mission_id: "m", story_id: "1.1", requirement_id: "REQ-001", timestamp: "2026-09-26T00:00:00.000Z", result: "fail" as const, kind: "unit", runner: "process", started_at: "2026-09-26T00:00:00.000Z", finished_at: "2026-09-26T00:00:01.000Z", exit_code: 1, command: "npm test", type: "unit", source: "process", artifact: "/tmp/a.log" };
  const pass = { ...fail, evidence_id: "ev2", timestamp: "2026-09-26T00:01:00.000Z", result: "pass" as const, exit_code: 0, artifact: "/tmp/b.log" };
  const mission = { evidence: [fail, pass] } as Mission;
  assert.equal(currentResultFor(mission, "unit", "1.1"), "pass");
});

test("a later unit FAIL is current and does not hide behind a historical PASS", () => {
  const pass = { evidence_id: "ev1", mission_id: "m", story_id: "1.1", requirement_id: "REQ-001", timestamp: "2026-09-26T00:00:00.000Z", result: "pass" as const, kind: "unit", runner: "process", started_at: "2026-09-26T00:00:00.000Z", finished_at: "2026-09-26T00:00:01.000Z", exit_code: 0, command: "npm test", type: "unit", source: "process", artifact: "/tmp/a.log" };
  const fail = { ...pass, evidence_id: "ev2", timestamp: "2026-09-26T00:02:00.000Z", result: "fail" as const, exit_code: 1, artifact: "/tmp/b.log" };
  const mission = { evidence: [pass, fail] } as Mission;
  assert.equal(currentResultFor(mission, "unit", "1.1"), "fail");
});

test("an unavailable or malformed attack does not pass, and FAIL stays FAIL", () => {
  const prompt = "attack";
  assert.equal(judgeAttack({ raw: "", processStatus: "not-configured", exitCode: null, attackerId: "none", model: null, durationMs: null, prompt }).status, "NOT_CONFIGURED");
  assert.equal(judgeAttack({ raw: "no json", processStatus: "completed", exitCode: 0, attackerId: "opencode", model: "m", durationMs: 1, prompt }).status, "BLOCKED");
  assert.equal(judgeAttack({ raw: "", processStatus: "timeout", exitCode: null, attackerId: "opencode", model: "m", durationMs: 1, prompt }).status, "BLOCKED");
  const failed = judgeAttack({ raw: JSON.stringify({ status: "FAIL", summary: "broken", findings: [{ severity: "high", category: "correctness", message: "x", file: "a.js" }] }), processStatus: "completed", exitCode: 0, attackerId: "opencode", model: "m", durationMs: 1, prompt });
  assert.equal(failed.status, "FAIL");
  const passed = judgeAttack({ raw: JSON.stringify({ status: "PASS", summary: "ok", findings: [] }), processStatus: "completed", exitCode: 0, attackerId: "opencode", model: "m", durationMs: 1, prompt });
  assert.equal(passed.status, "PASS");
  const advisory = judgeAttack({ raw: JSON.stringify({ status: "FAIL", summary: "speculative", findings: [{ severity: "low", category: "correctness", message: "silent delete" }] }), processStatus: "completed", exitCode: 0, attackerId: "opencode", model: "m", durationMs: 1, prompt });
  assert.equal(advisory.status, "PASS");
  const missingPage = applyAttackSurface(passed, { webAppWithoutPage: true });
  assert.equal(missingPage.status, "FAIL");
  assert.match(missingPage.summary, /index\.html/);
  assert.match(attackPrompt({ missionId: "m", missionTitle: "todo web app", ticketRef: "1.1", ticketTitle: "Todo", requirements: [], architecture: [], risk: "medium", changedFiles: [], diff: "", tests: null, reviewFindings: [], worktree: "/tmp", nonGoals: "No accounts.", servedApp: null }), /index\.html/);
});

test("ticket summary uses current unit evidence, not a superseded failure", () => {
  const fail = { evidence_id: "ev1", mission_id: "m", story_id: "1.1", requirement_id: "REQ-001", timestamp: "2026-09-26T00:00:00.000Z", result: "fail" as const, kind: "unit", runner: "process", started_at: "2026-09-26T00:00:00.000Z", finished_at: "2026-09-26T00:00:01.000Z", exit_code: 1, command: "npm test", type: "unit", source: "process", artifact: "/tmp/a.log" };
  const pass = { ...fail, evidence_id: "ev2", timestamp: "2026-09-26T00:01:00.000Z", result: "pass" as const, exit_code: 0, artifact: "/tmp/b.log" };
  const mission = { id: "m", phase: "build", tickets: [{ ref: "1.1" }], requirements: [], evidence: [fail, pass], reviews: [], attacks: [], lastVerifiedBuild: null } as unknown as Mission;
  assert.match(formatMissionStatus(mission), /test\npass/);
  assert.equal(/test\nfail/.test(formatMissionStatus(mission)), false);
});

test("a stale mission save cannot drop a later review PASS or attack record", () => {
  const disk = {
    id: "msn",
    updatedAt: "2026-09-26T23:32:15.000Z",
    reviews: [{ ticketRef: "1.1", attempt: 1, startedAt: "2026-09-26T23:31:54.000Z", status: "PASS", evidencePath: "/r1.json" }],
    attacks: [{ ticketRef: "1.1", attempt: 1, startedAt: "2026-09-26T23:32:15.000Z", status: "FAIL", evidencePath: "/a1.json" }],
    evidence: [
      { evidence_id: "ev-unit-pass", kind: "unit", result: "pass", story_id: "1.1", timestamp: "2026-09-26T23:31:54.000Z" },
      { evidence_id: "ev-attack-fail", kind: "attack", result: "fail", story_id: "1.1", timestamp: "2026-09-26T23:33:33.000Z" },
    ],
    attempts: { "1.1": 3 },
    workflow: [{ skillId: "bmad-build", status: "completed" }],
    plans: [{ ref: "1.1", status: "built" }],
  } as unknown as Mission;
  const stale = {
    id: "msn",
    updatedAt: "2026-09-26T23:33:05.000Z",
    reviews: [{ ticketRef: "1.1", attempt: 1, startedAt: "2026-09-26T23:33:00.000Z", status: "BLOCKED", evidencePath: "/r2.json" }],
    attacks: [],
    evidence: [{ evidence_id: "ev-unit-fail", kind: "unit", result: "fail", story_id: "1.1", timestamp: "2026-09-26T23:31:30.000Z" }],
    attempts: { "1.1": 2 },
    workflow: [{ skillId: "bmad-build", status: "blocked" }],
    plans: [{ ref: "1.1", status: "planned" }],
  } as unknown as Mission;
  const merged = mergeMissionRecords(disk, stale);
  assert.equal(merged.reviews.some((item) => item.status === "PASS"), true);
  assert.equal(merged.reviews.some((item) => item.status === "BLOCKED"), true);
  assert.equal(merged.attacks.length, 1);
  assert.equal(merged.attacks[0]?.status, "FAIL");
  assert.equal(merged.evidence.some((item) => item.evidence_id === "ev-unit-pass"), true);
  assert.equal(merged.evidence.some((item) => item.evidence_id === "ev-attack-fail"), true);
  assert.equal(merged.attempts["1.1"], 3);
  assert.equal(merged.plans[0]?.status, "built");
  assert.equal(merged.workflow.find((step) => step.skillId === "bmad-build")?.status, "completed");
});

test("saveMission unions concurrent writes so the latest unit PASS remains current", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bmad-save-"));
  const fail = { evidence_id: "ev1", mission_id: "msn", story_id: "1.1", requirement_id: "REQ-001", timestamp: "2026-09-26T00:00:00.000Z", result: "fail" as const, kind: "unit", runner: "process", started_at: "2026-09-26T00:00:00.000Z", finished_at: "2026-09-26T00:00:01.000Z", exit_code: 1, command: "npm test", type: "unit", source: "process" };
  const pass = { ...fail, evidence_id: "ev2", timestamp: "2026-09-26T00:01:00.000Z", result: "pass" as const, exit_code: 0 };
  const first = { id: "msn", updatedAt: "2026-09-26T00:00:02.000Z", evidence: [fail], reviews: [], attacks: [], attempts: { "1.1": 1 }, workflow: [], plans: [] } as unknown as Mission;
  saveMission(root, first);
  const stale = { ...first, updatedAt: "2026-09-26T00:01:10.000Z", evidence: [fail] } as unknown as Mission;
  const fresh = { ...first, updatedAt: "2026-09-26T00:01:05.000Z", evidence: [fail, pass], attempts: { "1.1": 2 } } as unknown as Mission;
  saveMission(root, fresh);
  saveMission(root, stale);
  const plane = new BmadControlPlane(root);
  const loaded = plane.mission("msn");
  assert.equal(currentResultFor(loaded, "unit", "1.1"), "pass");
  assert.equal(loaded.evidence.length, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a second autopilot is refused while the first lock is held", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bmad-lock-"));
  const plane = new BmadControlPlane(root);
  const id = plane.createMission("Build a simple todo web app with add, complete, delete, and local persistence.").id;
  assert.equal(acquireAutopilotLock(root, id), true);
  const refused = await plane.autopilot(id);
  assert.equal(refused.status, "blocked");
  assert.match(refused.reason, /already running/);
  releaseAutopilotLock(root, id);
  const waiting = await plane.autopilot(id);
  assert.equal(waiting.status, "needs-forge-answers");
  fs.rmSync(root, { recursive: true, force: true });
});

test("project .env fills unset runner keys and does not override existing process env", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bmad-env-"));
  fs.writeFileSync(path.join(root, ".env"), "BMAD_RUNTIME=opencode\nBMAD_MODEL=from-file\n# comment\nexport BMAD_RUNNER=opencode\n");
  const previous = {
    BMAD_RUNTIME: process.env.BMAD_RUNTIME,
    BMAD_MODEL: process.env.BMAD_MODEL,
    BMAD_RUNNER: process.env.BMAD_RUNNER,
  };
  delete process.env.BMAD_RUNTIME;
  delete process.env.BMAD_RUNNER;
  process.env.BMAD_MODEL = "keep-me";
  try {
    const applied = loadProjectEnv(root);
    assert.deepEqual(applied.sort(), ["BMAD_RUNNER", "BMAD_RUNTIME"]);
    assert.equal(process.env.BMAD_RUNTIME, "opencode");
    assert.equal(process.env.BMAD_RUNNER, "opencode");
    assert.equal(process.env.BMAD_MODEL, "keep-me");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
