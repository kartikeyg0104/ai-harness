import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DeterministicAttacker, attackPrompt, judgeAttack, resolveAttackerConfig } from "../attack";
import { BmadControlPlane } from "../plane";
import { DeterministicTestRuntime } from "../runtime";
import { DeterministicReviewer } from "../reviewer";
import { requiredEvidenceKinds } from "../quality";
import { DEFAULT_CONFIG } from "../types";
import type { AttackContext } from "../attack";

function tempProject(): string {
  const base = path.resolve(__dirname, "../../../../.tmp");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "bmad-attack-"));
}

function git(root: string, args: string[]): void {
  const result = spawnSync("git", ["-c", "user.email=bmad@example.com", "-c", "user.name=bmad", "-c", "init.templateDir=", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_TEMPLATE_DIR: "" },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "git failed");
}

function gitRepo(root: string): void {
  git(root, ["init"]);
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: "fixture", scripts: { test: "node -e \"process.exit(0)\"" } }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
}

function answerAll(plane: BmadControlPlane, id: string): void {
  let mission = plane.mission(id);
  while (mission.forge && mission.forge.outcome === "active") {
    const open = mission.forge.questions.find((question) => !mission.forge?.answered.includes(question.id));
    if (!open) break;
    mission = plane.answerForge(id, `locked answer for ${open.id}`);
  }
}

function ready(root: string, reviewer: DeterministicReviewer, attacker?: DeterministicAttacker): { plane: BmadControlPlane; id: string } {
  const plane = new BmadControlPlane(root, { reviewer, attacker });
  const mission = plane.createMission("Build an expense-management SaaS.");
  answerAll(plane, mission.id);
  plane.answerForge(mission.id, "harden");
  plane.acceptTicketTree(mission.id, "ada");
  plane.registerRuntime(new DeterministicTestRuntime(root, { protocol: true }));
  plane.updateConfig({ defaultRuntime: "deterministic-test-provider" });
  return { plane, id: mission.id };
}

function context(): AttackContext {
  return {
    missionId: "msn",
    missionTitle: "health",
    ticketRef: "1.1",
    ticketTitle: "Add a health endpoint",
    requirements: [{ id: "REQ-001", title: "Health", acceptanceCriteria: ["health() returns ok"] }],
    architecture: [],
    risk: "high",
    changedFiles: ["src/health.js"],
    diff: "function health() { return { status: 'ok' }; }\n",
    tests: { result: "pass", exitCode: 0, command: "npm test" },
    reviewFindings: [],
    worktree: "/tmp/worktree",
  };
}

const judged = { attackerId: "attacker", model: "test", durationMs: 3, prompt: attackPrompt(context()) };

test("attack configuration is separate and risk policy keeps critical attack required", () => {
  assert.equal(resolveAttackerConfig({ ...DEFAULT_CONFIG, attacker: null }, { BMAD_RUNNER: "opencode", BMAD_REVIEWER_RUNNER: "opencode" }), null);
  const config = resolveAttackerConfig(DEFAULT_CONFIG, {
    BMAD_ATTACK_RUNNER: "opencode",
    BMAD_ATTACKER_ARGS: '["run","--pure","{prompt}"]',
    BMAD_ATTACK_MODEL: "nvidia/google/gemma-4-31b-it",
    BMAD_ATTACK_TIMEOUT: "5000",
  });
  assert.equal(config?.command, "opencode");
  assert.deepEqual(config?.args, ["run", "--pure", "{prompt}"]);
  assert.equal(config?.model, "nvidia/google/gemma-4-31b-it");
  assert.equal(config?.timeoutMs, 5000);
  assert.equal(resolveAttackerConfig(DEFAULT_CONFIG, { BMAD_ATTACK_MODEL: "api_key=secret" })?.model ?? null, null);
  assert.deepEqual(requiredEvidenceKinds("low"), ["unit"]);
  assert.deepEqual(requiredEvidenceKinds("medium"), ["unit", "review"]);
  assert.deepEqual(requiredEvidenceKinds("medium", "medium"), ["unit", "review", "attack"]);
  assert.ok(requiredEvidenceKinds("high").includes("attack"));
  assert.ok(requiredEvidenceKinds("critical").includes("attack"));
});

test("attack results stay blocked unless a real run returns valid structured output", () => {
  assert.equal(judgeAttack({ ...judged, raw: "", processStatus: "not-configured", exitCode: null }).status, "NOT_CONFIGURED");
  assert.equal(judgeAttack({ ...judged, raw: '{"status":"PASS","summary":"ok","findings":[]}', processStatus: "timeout", exitCode: null }).status, "BLOCKED");
  assert.equal(judgeAttack({ ...judged, raw: "not json", processStatus: "completed", exitCode: 0 }).status, "BLOCKED");
  assert.equal(judgeAttack({ ...judged, raw: '{"findings":[]}', processStatus: "completed", exitCode: 0 }).status, "BLOCKED");
  assert.equal(judgeAttack({ ...judged, raw: '{"status":"PASS","summary":"No break shown.","findings":[]}', processStatus: "completed", exitCode: 0 }).status, "PASS");
  const failed = judgeAttack({
    ...judged,
    raw: '{"status":"FAIL","summary":"breaks","findings":[{"severity":"high","category":"edge-case","message":"health() does not handle invalid input.","file":"src/health.js","line":42}]}',
    processStatus: "completed",
    exitCode: 0,
  });
  assert.equal(failed.status, "FAIL");
  assert.equal(failed.findings[0]?.id, "ATT-001");
  assert.equal(failed.findings[0]?.code, "ATTACK_EDGE_CASE");
  const high = judgeAttack({
    ...judged,
    raw: '{"status":"PASS","summary":"claimed pass","findings":[{"severity":"high","category":"correctness","message":"wrong result","file":"src/health.js"}]}',
    processStatus: "completed",
    exitCode: 0,
  });
  assert.equal(high.status, "FAIL");
  assert.equal(high.findings[0]?.code, "ATTACK_CORRECTNESS");
  const critical = judgeAttack({
    ...judged,
    raw: '{"status":"FAIL","summary":"breaks","findings":[{"severity":"critical","category":"security","message":"accepts a forged caller","file":"src/health.js"}]}',
    processStatus: "completed",
    exitCode: 0,
  });
  assert.equal(critical.status, "FAIL");
  assert.equal(critical.findings[0]?.severity, "critical");
  assert.equal(critical.findings[0]?.code, "ATTACK_SECURITY");
  const recovery = judgeAttack({
    ...judged,
    raw: '{"status":"FAIL","summary":"breaks","findings":[{"severity":"high","category":"recovery","message":"does not recover","file":"src/health.js"}]}',
    processStatus: "completed",
    exitCode: 0,
  });
  assert.equal(recovery.findings[0]?.code, "ATTACK_RECOVERY");
  assert.match(attackPrompt(context()), /read-only/);
  assert.match(attackPrompt(context()), /api_key|redacted|Do not write/);
});

test("an unavailable attacker does not start and does not pass", () => {
  const root = tempProject();
  gitRepo(root);
  const { plane, id } = ready(root, new DeterministicReviewer(["pass"]));
  plane.executeTicket(id, "1.1");
  const mission = plane.mission(id);
  assert.equal(mission.attacks.at(-1)?.status, "NOT_CONFIGURED");
  assert.notEqual(mission.evidence.find((record) => record.kind === "attack")?.result, "pass");
  const events = fs.readFileSync(path.join(root, ".bmad-next", "missions", id, "events.jsonl"), "utf8");
  assert.equal(events.includes("AttackStarted"), false);
  assert.equal(plane.runtimeIds().includes("deterministic-test-attacker"), false);
  assert.equal(plane.releaseGate(id).state === "pass", false);
});

test("attack timeout and invalid JSON stay blocked", () => {
  const timeoutRoot = tempProject();
  gitRepo(timeoutRoot);
  const timed = ready(timeoutRoot, new DeterministicReviewer(["pass"]), new DeterministicAttacker(["timeout"]));
  timed.plane.executeTicket(timed.id, "1.1");
  const timedMission = timed.plane.mission(timed.id);
  assert.equal(timedMission.attacks.at(-1)?.status, "BLOCKED");
  assert.match(timedMission.attacks.at(-1)?.summary ?? "", /timed out/);
  const timedEvents = fs.readFileSync(path.join(timeoutRoot, ".bmad-next", "missions", timed.id, "events.jsonl"), "utf8");
  assert.equal(timedEvents.indexOf("AttackStarted") < timedEvents.indexOf("AttackFailed"), true);
  assert.equal(timedEvents.includes("AttackCompleted"), false);

  const invalidRoot = tempProject();
  gitRepo(invalidRoot);
  const invalid = ready(invalidRoot, new DeterministicReviewer(["pass"]), new DeterministicAttacker(["invalid"]));
  invalid.plane.executeTicket(invalid.id, "1.1");
  assert.equal(invalid.plane.mission(invalid.id).attacks.at(-1)?.status, "BLOCKED");
  assert.match(invalid.plane.mission(invalid.id).attacks.at(-1)?.summary ?? "", /not valid JSON/);
});

test("attack pass, fail, and repair run a fresh review before the next attack", () => {
  const passRoot = tempProject();
  gitRepo(passRoot);
  const passing = ready(passRoot, new DeterministicReviewer(["pass"]), new DeterministicAttacker(["pass"]));
  const passed = passing.plane.executeTicket(passing.id, "1.1");
  assert.equal(passed.status, "completed");
  const passedMission = passing.plane.mission(passing.id);
  assert.equal(passedMission.attacks.at(-1)?.status, "PASS");
  assert.equal(passedMission.evidence.find((record) => record.kind === "attack")?.result, "pass");
  assert.equal(fs.existsSync(passedMission.attacks.at(-1)?.evidencePath ?? ""), true);
  const saved = JSON.parse(fs.readFileSync(passedMission.attacks.at(-1)?.evidencePath ?? "", "utf8")) as { status: string; diffFingerprint: string; attackRunner: string };
  assert.equal(saved.status, "PASS");
  assert.equal(saved.attackRunner, "deterministic-test-attacker");
  assert.equal(saved.diffFingerprint.length > 0, true);
  assert.equal(passing.plane.releaseGate(passing.id).lastVerifiedBuild, null);
  const passEvents = fs.readFileSync(path.join(passRoot, ".bmad-next", "missions", passing.id, "events.jsonl"), "utf8");
  assert.equal(passEvents.indexOf("ReviewCompleted") < passEvents.indexOf("AttackStarted"), true);
  assert.equal(passEvents.includes("AttackCompleted"), true);

  const failRoot = tempProject();
  gitRepo(failRoot);
  const runtime = new DeterministicTestRuntime(failRoot, { protocol: true });
  const attacker = new DeterministicAttacker(["fail", "pass"]);
  const failing = ready(failRoot, new DeterministicReviewer(["pass", "pass"]), attacker);
  failing.plane.registerRuntime(runtime);
  const failed = failing.plane.executeTicket(failing.id, "1.1");
  assert.equal(failed.status, "blocked");
  const failedMission = failing.plane.mission(failing.id);
  assert.equal(failedMission.attacks[0]?.status, "FAIL");
  assert.equal(failedMission.attacks[0]?.findings[0]?.severity, "high");
  assert.equal(failedMission.findings.some((finding) => finding.code === "ATTACK_EDGE_CASE"), true);
  const html = fs.readFileSync(path.join(failRoot, ".bmad-next", "missions", failing.id, "events.jsonl"), "utf8");
  assert.equal(html.includes("AttackCompleted"), true);
  const repaired = failing.plane.repairTicket(failing.id, "1.1");
  assert.equal(repaired.status, "completed");
  assert.match(runtime.prompts.at(-1) ?? "", /Finding ID: ATT-001/);
  assert.match(runtime.prompts.at(-1) ?? "", /Severity: high/);
  assert.match(runtime.prompts.at(-1) ?? "", /Line: 42/);
  assert.match(runtime.prompts.at(-1) ?? "", /Attack evidence:/);
  assert.match(runtime.prompts.at(-1) ?? "", /health\(\) does not handle invalid input/);
  const after = failing.plane.mission(failing.id);
  assert.equal(after.reviews.length, 2);
  assert.equal(after.reviews[0]?.status, "PASS");
  assert.equal(after.reviews[1]?.status, "PASS");
  assert.equal(after.attacks.length, 2);
  assert.equal(after.attacks[0]?.status, "FAIL");
  assert.equal(after.attacks[1]?.status, "PASS");
  assert.notEqual(after.reviews[0]?.diffFingerprint, after.reviews[1]?.diffFingerprint);
  assert.equal(after.reviews[1]?.priorDiffFingerprint, after.reviews[0]?.diffFingerprint);
  const evidenceDir = path.join(failRoot, ".bmad-next", "evidence", failing.id);
  const firstAttackFile = JSON.parse(fs.readFileSync(path.join(evidenceDir, "1.1-attack-1.json"), "utf8")) as { status: string };
  const secondAttackFile = JSON.parse(fs.readFileSync(path.join(evidenceDir, "1.1-attack-2.json"), "utf8")) as { status: string };
  assert.equal(firstAttackFile.status, "FAIL");
  assert.equal(secondAttackFile.status, "PASS");
  assert.equal(after.repairs[0]?.source, "attack");
  assert.equal(after.repairs[0]?.worktree, after.reviews[0]?.worktree);
  const repairEvents = fs.readFileSync(path.join(failRoot, ".bmad-next", "missions", failing.id, "events.jsonl"), "utf8");
  const secondReview = repairEvents.lastIndexOf("ReviewStarted");
  const secondAttack = repairEvents.lastIndexOf("AttackStarted");
  assert.equal(secondReview < secondAttack, true);
  assert.equal(failing.plane.releaseGate(failing.id).lastVerifiedBuild, null);
});

test("an attacker that edits the worktree cannot pass", () => {
  const root = tempProject();
  gitRepo(root);
  const script = path.join(root, "mutate-attack.js");
  fs.writeFileSync(
    script,
    `const fs = require("fs");
const prompt = process.argv[2];
const worktree = prompt.match(/Worktree: (.+)/)[1];
fs.writeFileSync(worktree + "/attacker-touched.txt", "nope\\n");
process.stdout.write(JSON.stringify({ status: "PASS", summary: "No break shown.", findings: [] }));
`,
  );
  const { plane, id } = ready(root, new DeterministicReviewer(["pass"]));
  plane.updateConfig({ attacker: { command: process.execPath, args: [script, "{prompt}"], timeoutMs: 20000 } });
  plane.executeTicket(id, "1.1");
  const attack = plane.mission(id).attacks.at(-1);
  assert.equal(attack?.status, "BLOCKED");
  assert.match(attack?.summary ?? "", /read-only/);
  assert.notEqual(plane.mission(id).evidence.find((record) => record.kind === "attack")?.result, "pass");
});
