import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { BmadControlPlane } from "../plane";
import { BmadRunner } from "../skill-runner";
import { DeterministicTestRuntime } from "../runtime";
import { decideCommand } from "../policy";
import { LocalSandbox } from "../collaboration";
import type { CommandRunner } from "../types";

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

function harden(root = tempProject()): { root: string; plane: BmadControlPlane; id: string } {
  const plane = new BmadControlPlane(root);
  const mission = plane.createMission("Build an expense-management SaaS.");
  answerAll(plane, mission.id);
  plane.answerForge(mission.id, "harden");
  plane.acceptTicketTree(mission.id, "ada");
  return { root, plane, id: mission.id };
}

test("illegal mission transitions stay closed", () => {
  const plane = new BmadControlPlane(tempProject());
  const mission = plane.createMission("Build an expense-management SaaS.");
  assert.throws(() => plane.transitionLoop(mission.id, "released"), /Cannot move draft to released/);
  assert.throws(() => plane.transitionLoop(mission.id, "verified"), /Cannot move draft to verified/);
  plane.startMission(mission.id);
  assert.equal(plane.mission(mission.id).loop, "running");
  assert.throws(() => plane.transitionLoop(mission.id, "verified"), /Cannot move running to verified/);
  assert.throws(() => plane.markVerified(mission.id), /passing attack run/);
});

test("a restarted process reloads the same mission", () => {
  const root = tempProject();
  const plane = new BmadControlPlane(root);
  const mission = plane.createMission("Build an expense-management SaaS.");
  plane.answerForge(mission.id, "employees of one company");
  const restarted = new BmadControlPlane(root);
  const loaded = restarted.mission();
  assert.equal(loaded.id, mission.id);
  assert.equal(loaded.loop, "draft");
  assert.equal(loaded.forge?.answered.length, 1);
  assert.equal(loaded.workflow.find((step) => step.skillId === "bmad-forge-idea")?.status, "awaiting-user");
});

test("timeout and invalid skill output do not complete the skill", () => {
  const root = tempProject();
  const runner: CommandRunner = {
    which: (bin) => (bin === "bmad-runner" ? "/usr/bin/bmad-runner" : null),
    run: (_command, args) => {
      if (args[0] === "bmad-prd") return { exitCode: null, stdout: "", stderr: "timed out", durationMs: 10, timedOut: true };
      return { exitCode: 0, stdout: "not-json", stderr: "", durationMs: 4, timedOut: false };
    },
  };
  const plane = new BmadControlPlane(root, { runner });
  const mission = plane.createMission("Build an expense-management SaaS.");
  plane.updateConfig({ runnerCommand: "bmad-runner" });
  const invalid = plane.runSkill(mission.id, "bmad-spec");
  assert.notEqual(invalid.workflow.find((step) => step.skillId === "bmad-spec")?.status, "completed");
  assert.equal(invalid.artifacts.find((artifact) => artifact.skillId === "bmad-spec")?.state, "invalid");
  const timedOut = plane.runSkill(mission.id, "bmad-prd");
  assert.notEqual(timedOut.workflow.find((step) => step.skillId === "bmad-prd")?.status, "completed");
  assert.equal(timedOut.artifacts.find((artifact) => artifact.skillId === "bmad-prd")?.state, "failed");
  const resolved = new BmadRunner(runner, root).loadSkillContract("bmad-spec");
  assert.equal(resolved.id, "bmad-spec");
  assert.equal(plane.mission(mission.id).workflow.find((step) => step.skillId === "bmad-ux")?.status, "awaiting-model");
});

test("retry budget blocks another dispatch", () => {
  const { plane, id } = harden();
  assert.equal(plane.dispatch(id, "1.1").status, "not-configured");
  assert.equal(plane.dispatch(id, "1.1").status, "not-configured");
  const blocked = plane.dispatch(id, "1.1");
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.message, /Retry budget/);
  assert.equal(plane.mission(id).plans.find((plan) => plan.ref === "1.1"), undefined);
});

test("critical release cannot skip named approval or missing evidence", () => {
  const { root, plane, id } = harden();
  const early = plane.releaseGate(id);
  assert.equal(early.state, "blocked");
  assert.equal(plane.mission(id).lastVerifiedBuild, null);
  for (const kind of ["unit", "review", "security", "browser", "attack", "nfr"]) {
    const artifact = path.join(root, `${kind}.log`);
    fs.writeFileSync(artifact, `${kind} ok`);
    plane.recordEvidence(id, {
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
  plane.declareArchitecture(id, { id: "ADR-1", kind: "database", choice: "PostgreSQL", alternatives: [] });
  const withoutApproval = plane.releaseGate(id);
  assert.equal(withoutApproval.state, "blocked");
  assert.equal(withoutApproval.criteria.find((item) => item.id === "human-release")?.state, "blocked");
  assert.equal(plane.mission(id).lastVerifiedBuild, null);
});

test("the deterministic provider is not a production runtime and does not mark a ticket built", () => {
  const { root, plane, id } = harden();
  assert.deepEqual(plane.runtimeIds().slice().sort(), ["goose", "mini-swe-agent", "opencode", "openhands", "qwen", "swe-agent", "unconfigured"]);
  plane.registerRuntime(new DeterministicTestRuntime(root));
  plane.updateConfig({ defaultRuntime: "deterministic-test-provider" });
  const git = (args: string[]) => {
    const result = spawnSync("git", ["-c", "user.email=bmad@example.com", "-c", "user.name=bmad", "-c", "init.templateDir=", ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_TEMPLATE_DIR: "" },
    });
    if (result.status !== 0) throw new Error(result.stderr || "git failed");
  };
  git(["init"]);
  git(["add", "-A"]);
  git(["commit", "-m", "init", "--allow-empty"]);
  const dispatch = plane.dispatch(id, "1.1");
  assert.equal(dispatch.status, "completed");
  const worktree = plane.mission(id).executions.find((item) => item.ticketRef === "1.1")?.worktree ?? "";
  const artifact = path.join(worktree, ".bmad-next", "test-runs", `${id}-1.1.txt`);
  assert.equal(fs.existsSync(path.join(root, ".bmad-next", "test-runs", `${id}-1.1.txt`)), false);
  assert.equal(fs.existsSync(artifact), true);
  assert.equal(fs.readFileSync(artifact, "utf8").includes("BMAD-TICKET-STATUS:"), false);
  assert.equal(plane.mission(id).plans.find((plan) => plan.status === "built"), undefined);
  const events = fs.readFileSync(path.join(root, ".bmad-next", "missions", id, "events.jsonl"), "utf8");
  assert.equal(events.includes("AgentStarted"), true);
  assert.equal(events.includes("AgentCompleted"), true);
  const production = new BmadControlPlane(root);
  assert.equal(production.runtimeIds().includes("deterministic-test-provider"), false);
  plane.verifyMission(id);
  plane.reviewMission(id);
  assert.equal(plane.mission(id).loop, "reviewing");
  const log = path.join(root, "unit.log");
  fs.writeFileSync(log, "ok");
  const evidence = plane.recordEvidence(id, {
    requirement_id: "REQ-001",
    result: "pass",
    kind: "unit",
    runner: "process",
    started_at: "2026-09-26T00:00:00.000Z",
    finished_at: "2026-09-26T00:00:01.000Z",
    exit_code: 0,
    command: "npm test",
    artifact: log,
  });
  assert.equal(evidence.type, "unit");
  assert.equal(evidence.source, "process");
  assert.equal(plane.releaseGate(id).state, "blocked");
});

test("next and build inspect mission state", () => {
  const { plane, id } = harden();
  const next = plane.handleIntent("@bmad what should I do next?", id);
  assert.equal(next.name, "next");
  const detail = next.detail as { skillId: string; reason: string };
  assert.notEqual(detail.skillId, "");
  assert.match(detail.reason, /Loop is/);
  const missing = plane.handleIntent("@bmad build story 9.9", id);
  assert.equal((missing.detail as { status: string }).status, "missing-ticket");
  const resolved = plane.handleIntent("@bmad build story 1.1", id);
  assert.equal((resolved.detail as { status: string }).status, "not-configured");
});

test("documentation drift is recorded only when both sides exist", () => {
  const plane = new BmadControlPlane(tempProject());
  const mission = plane.createMission("Fix typo in the readme");
  plane.declareArchitecture(mission.id, { id: "ADR-2", kind: "database", choice: "PostgreSQL", alternatives: [] });
  const codeOnly = plane.crossCheck(mission.id, [{ path: "src/app.ts", text: "mongodb client" }]);
  assert.equal(codeOnly.some((finding) => finding.code === "DOCUMENTATION_DRIFT"), false);
  assert.equal(codeOnly.some((finding) => finding.code === "ARCHITECTURE_DRIFT"), true);
  const docs = plane.crossCheck(mission.id, [{ path: "README.md", text: "The service uses mongodb." }]);
  const finding = docs.find((item) => item.code === "DOCUMENTATION_DRIFT");
  assert.ok(finding);
  assert.equal(finding?.target, "README.md");
  assert.equal(finding?.status, "open");
  assert.ok(finding?.createdAt);
});

test("memory keeps provenance and can be invalidated", () => {
  const root = tempProject();
  const plane = new BmadControlPlane(root);
  const mission = plane.createMission("Fix typo in the readme");
  const event = fs.readFileSync(path.join(root, ".bmad-next", "missions", mission.id, "events.jsonl"), "utf8").split("\n")[0] ?? "";
  const source = JSON.parse(event) as { id: string };
  const entry = plane.remember(mission.id, "constraints", "Keep the readme edit local.", source.id);
  assert.equal(entry.invalidated, false);
  assert.equal(plane.searchMemory(mission.id, "readme").length, 1);
  plane.invalidateMemory(mission.id, entry.id);
  assert.equal(plane.searchMemory(mission.id, "readme").length, 0);
  assert.throws(() => plane.remember(mission.id, "constraints", "untrusted", "evt_missing"), /cite an event/);
});

test("protected workspace paths and destructive commands stay blocked", () => {
  assert.equal(decideCommand("drop database", "assist").decision, "block");
  const runner: CommandRunner = { which: () => "/bin/echo", run: () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false }) };
  const sandbox = new LocalSandbox(path.join(tempProject(), ".bmad-next"), runner);
  sandbox.create("box");
  assert.throws(() => sandbox.writeFile("box", "../outside.txt", "no"));
});

test("retrospective and builder drafts do not publish or complete upstream skills", () => {
  const { root, plane, id } = harden();
  const retro = plane.retrospective(id);
  assert.equal(retro.completed, false);
  assert.equal(fs.existsSync(path.join(root, retro.path)), true);
  assert.equal(plane.mission(id).workflow.find((step) => step.skillId === "bmad-retrospective")?.status, "awaiting-model");
  const tea = plane.tea(id);
  assert.equal(tea.completed, false);
  assert.equal(fs.existsSync(path.join(root, tea.path)), true);
  assert.equal(plane.mission(id).artifacts.find((artifact) => artifact.kind === "tea")?.state, "in-progress");
  const draft = plane.builder(id, "skill", "expense-check");
  assert.equal(draft.published, false);
  const candidate = plane.mission(id).brain.skillCandidates.find((skill) => skill.name === "expense-check");
  assert.equal(candidate?.published, false);
  assert.equal(candidate?.evaluation.status, "not-run");
});
