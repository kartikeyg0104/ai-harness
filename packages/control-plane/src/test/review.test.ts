import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { BmadControlPlane } from "../plane";
import { DEFAULT_CONFIG, type CommandRunner } from "../types";
import { processRunner } from "../runner";
import { renderMissionControl } from "../render";
import { DeterministicTestRuntime, type AgentRuntime } from "../runtime";
import { CommandReviewer, DeterministicReviewer, downgradeReview, judgeReview, repairTask, resolveReviewerConfig, reviewPrompt, type ReviewContext } from "../reviewer";

function tempProject(): string {
  const base = path.resolve(__dirname, "../../../../.tmp");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "bmad-review-"));
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

function ready(root: string, reviewer?: DeterministicReviewer, runner?: CommandRunner): { plane: BmadControlPlane; id: string } {
  const plane = new BmadControlPlane(root, { reviewer, runner });
  const mission = plane.createMission("Build an expense-management SaaS.");
  answerAll(plane, mission.id);
  plane.answerForge(mission.id, "harden");
  plane.acceptTicketTree(mission.id, "ada");
  return { plane, id: mission.id };
}

function context(diff = "function health() { return { status: 'ok' }; }\n"): ReviewContext {
  return {
    missionId: "msn",
    missionTitle: "health",
    ticketRef: "1.1",
    ticketTitle: "Add a health endpoint",
    requirements: [{ id: "REQ-001", title: "Health", acceptanceCriteria: ["health() returns ok"] }],
    architecture: [],
    worktree: "/tmp/worktree",
    baseCommit: "abc",
    headCommit: "abc",
    changedFiles: ["src/health.js"],
    diff,
    testEvidence: { result: "pass", exitCode: 0, command: "npm test" },
  };
}

function passBody(criteriaStatus: "PASS" | "FAIL" | "UNCLEAR" = "PASS", finding?: Record<string, unknown>): string {
  return JSON.stringify({
    status: "PASS",
    summary: "Checked the diff.",
    findings: finding ? [finding] : [],
    criteria: [{ requirementId: "REQ-001", criterion: "health() returns ok", status: criteriaStatus }],
    tests: { coversChangedBehavior: "PASS", wouldCatchRegression: "PASS", edgeCases: "PASS" },
  });
}

test("reviewer configuration stays separate from the coding runner", () => {
  assert.equal(resolveReviewerConfig({ ...DEFAULT_CONFIG, reviewer: null }, { BMAD_RUNNER: "opencode", BMAD_RUNNER_ARGS: "[\"run\"]" }), null);
  assert.equal(resolveReviewerConfig(DEFAULT_CONFIG, { BMAD_REVIEWER_RUNNER: "opencode run" }), null);
  const config = resolveReviewerConfig(DEFAULT_CONFIG, {
    BMAD_REVIEWER_RUNNER: "opencode",
    BMAD_REVIEWER_ARGS: "[\"run\",\"{prompt}\"]",
    BMAD_REVIEWER_MODEL: "nvidia/google/gemma-4-31b-it",
    BMAD_REVIEWER_TIMEOUT: "5000",
  });
  assert.equal(config?.command, "opencode");
  assert.deepEqual(config?.args, ["run", "{prompt}"]);
  assert.equal(config?.model, "nvidia/google/gemma-4-31b-it");
  assert.equal(config?.timeoutMs, 5000);
  assert.equal(resolveReviewerConfig(DEFAULT_CONFIG, { BMAD_REVIEWER_MODEL: "api_key=secret" })?.model ?? null, null);
});

test("review prompt redacts secrets and does not approve from a developer explanation", () => {
  const prompt = reviewPrompt({ ...context("api_key=supersecretvalue\n"), testEvidence: { result: "pass", exitCode: 0, command: "npm test" } });
  assert.equal(prompt.includes("supersecretvalue"), false);
  assert.match(prompt, /\[redacted\]/);
  assert.match(prompt, /review-v1/);
  assert.match(prompt, /Do not approve based on the developer's explanation/);
  assert.match(prompt, /health\(\) returns ok/);
  assert.match(prompt, /Inspect the actual diff/);
});

test("structured review rules block invalid, unclear, blocking, and evidenceless passes", () => {
  const base = { processStatus: "completed" as const, exitCode: 0, context: context(), reviewerId: "reviewer", model: "test", durationMs: 4, prompt: reviewPrompt(context()) };
  assert.equal(judgeReview({ ...base, raw: "" }).status, "BLOCKED");
  assert.equal(judgeReview({ ...base, raw: "not json" }).status, "BLOCKED");
  assert.equal(judgeReview({ ...base, processStatus: "timeout", exitCode: null, raw: passBody() }).status, "BLOCKED");
  assert.equal(judgeReview({ ...base, processStatus: "not-configured", exitCode: null, raw: "" }).status, "NOT_CONFIGURED");
  assert.equal(judgeReview({ ...base, exitCode: 1, raw: passBody() }).status, "BLOCKED");
  assert.equal(judgeReview({ ...base, raw: passBody("UNCLEAR") }).status, "BLOCKED");
  assert.equal(judgeReview({ ...base, raw: passBody("FAIL") }).status, "FAIL");
  const high = judgeReview({
    ...base,
    raw: passBody("PASS", { severity: "high", category: "correctness", message: "returns the wrong shape", file: "src/health.js", repair: "Return status ok." }),
  });
  assert.equal(high.status, "FAIL");
  assert.equal(high.findings[0]?.severity, "high");
  const critical = judgeReview({
    ...base,
    raw: passBody("PASS", { severity: "critical", category: "security", message: "leaks a token", file: "src/health.js" }),
  });
  assert.equal(critical.status, "FAIL");
  assert.match(repairTask(critical.findings[0]!), /REV-001/);
  assert.match(repairTask(critical.findings[0]!), /Severity: critical/);
  const drifted = judgeReview({
    ...base,
    context: { ...context("const client = require('mongodb')\n"), architecture: [{ id: "adr", choice: "PostgreSQL" }] },
    raw: passBody(),
  });
  assert.equal(drifted.status, "FAIL");
  assert.equal(drifted.architectureDrift.length > 0, true);
  assert.match(drifted.findings.map((finding) => finding.message).join("\n"), /ARCHITECTURE_DRIFT/);
  const passed = judgeReview({ ...base, raw: passBody() });
  assert.equal(passed.status, "PASS");
  assert.equal(downgradeReview(passed, { evidenceExists: false }).status, "BLOCKED");
  assert.match(downgradeReview(passed, { worktreeMutated: true }).summary, /read-only/);
});

test("a missing reviewer stays blocked and does not start", () => {
  const root = tempProject();
  gitRepo(root);
  const { plane, id } = ready(root);
  plane.registerRuntime(new DeterministicTestRuntime(root, { protocol: true }));
  plane.updateConfig({ defaultRuntime: "deterministic-test-provider" });
  const built = plane.executeTicket(id, "1.1");
  assert.equal(built.status, "completed");
  const mission = plane.mission(id);
  const review = mission.evidence.find((record) => record.kind === "review");
  assert.equal(review?.result, "blocked");
  const body = fs.readFileSync(review?.artifact ?? "", "utf8");
  assert.match(body, /status: blocked/);
  assert.match(body, /NOT_CONFIGURED|No reviewer executed/);
  const events = fs.readFileSync(path.join(root, ".bmad-next", "missions", id, "events.jsonl"), "utf8");
  assert.equal(events.includes("ReviewStarted"), false);
  assert.equal(events.includes("ReviewCompleted"), false);
  assert.equal(plane.runtimeIds().includes("deterministic-test-reviewer"), false);
  assert.equal(plane.releaseGate(id).lastVerifiedBuild, null);
});

test("reviewer timeout, invalid JSON, failure, and pass keep the release gate closed", () => {
  const timeoutRoot = tempProject();
  gitRepo(timeoutRoot);
  const timeoutRunner: CommandRunner = {
    which: (bin) => (bin === "reviewer" ? "/usr/bin/reviewer" : processRunner.which(bin)),
    run: (command, args, cwd, timeoutMs) => {
      if (command === "reviewer") return { exitCode: null, stdout: "", stderr: "timed out", durationMs: timeoutMs, timedOut: true };
      return processRunner.run(command, args, cwd, timeoutMs);
    },
  };
  const timed = ready(timeoutRoot, undefined, timeoutRunner);
  timed.plane.registerRuntime(new DeterministicTestRuntime(timeoutRoot, { protocol: true }));
  timed.plane.updateConfig({ defaultRuntime: "deterministic-test-provider", reviewer: { command: "reviewer", args: ["{prompt}"], timeoutMs: 1000 } });
  timed.plane.executeTicket(timed.id, "1.1");
  const timedMission = timed.plane.mission(timed.id);
  assert.equal(timedMission.evidence.find((record) => record.kind === "review")?.result, "blocked");
  assert.equal(timedMission.reviews.at(-1)?.status, "BLOCKED");
  const timedEvents = fs.readFileSync(path.join(timeoutRoot, ".bmad-next", "missions", timed.id, "events.jsonl"), "utf8");
  assert.equal(timedEvents.indexOf("ReviewStarted") < timedEvents.indexOf("ReviewFailed"), true);

  const invalidRoot = tempProject();
  gitRepo(invalidRoot);
  const invalidRunner: CommandRunner = {
    which: (bin) => (bin === "reviewer" ? "/usr/bin/reviewer" : processRunner.which(bin)),
    run: (command, args, cwd, timeoutMs) => {
      if (command === "reviewer") return { exitCode: 0, stdout: "complete", stderr: "", durationMs: 2, timedOut: false };
      return processRunner.run(command, args, cwd, timeoutMs);
    },
  };
  const invalid = ready(invalidRoot, undefined, invalidRunner);
  invalid.plane.registerRuntime(new DeterministicTestRuntime(invalidRoot, { protocol: true }));
  invalid.plane.updateConfig({ defaultRuntime: "deterministic-test-provider", reviewer: { command: "reviewer", args: ["{prompt}"], timeoutMs: 1000 } });
  invalid.plane.executeTicket(invalid.id, "1.1");
  assert.equal(invalid.plane.mission(invalid.id).reviews.at(-1)?.status, "BLOCKED");
  assert.match(invalid.plane.mission(invalid.id).reviews.at(-1)?.summary ?? "", /not valid JSON/);

  const failRoot = tempProject();
  gitRepo(failRoot);
  const failing = ready(failRoot, new DeterministicReviewer(["fail"]));
  failing.plane.registerRuntime(new DeterministicTestRuntime(failRoot, { protocol: true }));
  failing.plane.updateConfig({ defaultRuntime: "deterministic-test-provider" });
  const failed = failing.plane.executeTicket(failing.id, "1.1");
  assert.equal(failed.status, "blocked");
  const failedMission = failing.plane.mission(failing.id);
  assert.equal(failedMission.plans.find((plan) => plan.ref === "1.1")?.status, "blocked");
  assert.equal(failedMission.executions.find((item) => item.ticketRef === "1.1")?.verification, "fail");
  assert.equal(failedMission.evidence.find((record) => record.kind === "review")?.result, "fail");
  assert.equal(failedMission.findings.some((finding) => finding.code === "REVIEW_FINDING"), true);
  const html = renderMissionControl(failedMission);
  assert.match(html, /Status: <strong>FAIL<\/strong>/);
  assert.match(html, /Fix with BMAD/);
  assert.match(html, /REQ-001/);
  assert.match(html, /❌/);
  assert.match(html, /Review FAIL/);
  const noted = failing.plane.noteReviewFalsePositive(failing.id, "1.1", failedMission.reviews.at(-1)?.findings[0]?.id ?? "");
  assert.equal(noted.falsePositiveFeedback, 1);
  assert.equal(failing.plane.mission(failing.id).reviews.at(-1)?.findings.length, noted.findings.length);

  const passRoot = tempProject();
  gitRepo(passRoot);
  const prompts: string[] = [];
  const passRunner: CommandRunner = {
    which: (bin) => (bin === "reviewer" ? "/usr/bin/reviewer" : processRunner.which(bin)),
    run: (command, args, cwd, timeoutMs) => {
      if (command === "reviewer") {
        const prompt = args[0] ?? "";
        prompts.push(prompt);
        const criteria = JSON.parse(prompt.split("CRITERIA-JSON:\n")[1]?.split("\n\n")[0] ?? "[]") as Array<{ requirementId: string; criterion: string }>;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            status: "PASS",
            summary: "The diff matches the criteria.",
            findings: [],
            criteria: criteria.map((item) => ({ ...item, status: "PASS" })),
            tests: { coversChangedBehavior: "PASS", wouldCatchRegression: "PASS", edgeCases: "PASS" },
          }),
          stderr: "",
          durationMs: 5,
          timedOut: false,
        };
      }
      return processRunner.run(command, args, cwd, timeoutMs);
    },
  };
  const passing = ready(passRoot, undefined, passRunner);
  passing.plane.registerRuntime(new DeterministicTestRuntime(passRoot, { protocol: true }));
  passing.plane.updateConfig({ defaultRuntime: "deterministic-test-provider", reviewer: { command: "reviewer", args: ["{prompt}"], timeoutMs: 5000, model: "review-model" } });
  const passed = passing.plane.executeTicket(passing.id, "1.1");
  assert.equal(passed.status, "completed");
  const passedMission = passing.plane.mission(passing.id);
  const review = passedMission.evidence.filter((record) => record.kind === "review").at(-1);
  assert.equal(review?.result, "pass");
  assert.equal(review?.exit_code, 0);
  assert.equal(fs.existsSync(review?.artifact ?? ""), true);
  const saved = JSON.parse(fs.readFileSync(review?.artifact ?? "", "utf8")) as { status: string; promptVersion: string; model: string; criteria: Array<{ status: string }> };
  assert.equal(saved.status, "PASS");
  assert.equal(saved.promptVersion, "review-v1");
  assert.equal(saved.model, "review-model");
  assert.equal(saved.criteria.every((item) => item.status === "PASS"), true);
  assert.equal(passedMission.executions.find((item) => item.ticketRef === "1.1")?.verification, "pass");
  assert.equal(passing.plane.releaseGate(passing.id).state, "blocked");
  assert.equal(passing.plane.mission(passing.id).lastVerifiedBuild, null);
  assert.equal(prompts[0]?.includes("This is not a coding agent"), false);
  assert.match(prompts[0] ?? "", /BMAD-TICKET-STATUS:\s*built/);
  const passEvents = fs.readFileSync(path.join(passRoot, ".bmad-next", "missions", passing.id, "events.jsonl"), "utf8");
  assert.equal(passEvents.indexOf("ReviewStarted") < passEvents.indexOf("ReviewCompleted"), true);
  assert.equal(passEvents.includes("ReviewFailed"), false);
});

test("repair after a failing review runs a fresh review in the same worktree", () => {
  const root = tempProject();
  gitRepo(root);
  const reviewer = new DeterministicReviewer(["fail", "pass"]);
  const { plane, id } = ready(root, reviewer);
  plane.registerRuntime(new DeterministicTestRuntime(root, { protocol: true }));
  plane.updateConfig({ defaultRuntime: "deterministic-test-provider" });
  assert.equal(plane.executeTicket(id, "1.1").status, "blocked");
  const first = plane.mission(id).reviews[0];
  assert.equal(first?.status, "FAIL");
  const repaired = plane.repairTicket(id, "1.1");
  assert.equal(repaired.status, "completed");
  const mission = plane.mission(id);
  assert.equal(mission.reviews.length, 2);
  assert.equal(mission.reviews[0]?.status, "FAIL");
  assert.equal(mission.reviews[1]?.status, "PASS");
  assert.equal(mission.reviews[1]?.attempt, 2);
  assert.notEqual(mission.reviews[0]?.promptHash, mission.reviews[1]?.promptHash);
  assert.equal(mission.reviews[1]?.repairSuccess, 1);
  assert.equal(fs.existsSync(path.join(root, ".bmad-next", "evidence", id, "1.1-review-1.json")), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".bmad-next", "evidence", id, "1.1-review-1.json"), "utf8")).status, "FAIL");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".bmad-next", "evidence", id, "1.1-review.json"), "utf8")).status, "PASS");
  assert.equal(mission.plans.find((plan) => plan.ref === "1.1")?.status, "built");
  assert.equal(mission.executions.find((item) => item.ticketRef === "1.1")?.verification, "pass");
  const worktree = mission.executions.find((item) => item.ticketRef === "1.1")?.worktree ?? "";
  assert.match(worktree, /\.bmad-next\/worktrees\//);
  assert.equal(fs.existsSync(path.join(worktree, ".bmad-next", "test-runs", `${id}-1.1.txt`)), true);
  assert.equal(fs.existsSync(path.join(root, ".bmad-next", "test-runs", `${id}-1.1.txt`)), false);
  const events = fs.readFileSync(path.join(root, ".bmad-next", "missions", id, "events.jsonl"), "utf8");
  assert.equal(events.includes("RepairStarted"), true);
  assert.equal(events.split("ReviewStarted").length - 1, 2);
  assert.equal(plane.releaseGate(id).lastVerifiedBuild, null);
});

test("a reviewer that edits the worktree cannot pass", () => {
  const root = tempProject();
  gitRepo(root);
  const script = path.join(root, "mutate-review.js");
  fs.writeFileSync(
    script,
    `const fs = require("fs");
const prompt = process.argv[2];
const worktree = prompt.match(/Worktree: (.+)/)[1];
fs.writeFileSync(worktree + "/reviewer-touched.txt", "nope\\n");
const criteria = JSON.parse(prompt.split("CRITERIA-JSON:\\n")[1].split("\\n\\n")[0]);
process.stdout.write(JSON.stringify({
  status: "PASS",
  summary: "approve",
  findings: [],
  criteria: criteria.map((item) => ({ ...item, status: "PASS" })),
  tests: { coversChangedBehavior: "PASS", wouldCatchRegression: "PASS", edgeCases: "PASS" }
}));
`,
  );
  const { plane, id } = ready(root);
  plane.registerRuntime(new DeterministicTestRuntime(root, { protocol: true }));
  plane.updateConfig({ defaultRuntime: "deterministic-test-provider", reviewer: { command: process.execPath, args: [script, "{prompt}"], timeoutMs: 20000 } });
  plane.executeTicket(id, "1.1");
  const review = plane.mission(id).reviews.at(-1);
  assert.equal(review?.status, "BLOCKED");
  assert.match(review?.summary ?? "", /read-only/);
  assert.notEqual(plane.mission(id).evidence.find((record) => record.kind === "review")?.result, "pass");
});

test("shell review commands are refused before spawn", () => {
  const root = tempProject();
  let ran = false;
  const reviewer = new CommandReviewer(
    {
      which: () => "/bin/sh",
      run: () => {
        ran = true;
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
      },
    },
    { command: "sh", args: ["-c", "{prompt}"], timeoutMs: 1000 },
    root,
  );
  const result = reviewer.reviewSync(context());
  assert.equal(ran, false);
  assert.equal(result.status, "BLOCKED");
});

test("a repair that writes code and times out stays blocked without a fresh review", () => {
  const root = tempProject();
  gitRepo(root);
  const reviewer = new DeterministicReviewer(["fail", "pass"]);
  const runtime = new DeterministicTestRuntime(root, { protocol: true, script: ["completed", "timeout"] });
  const { plane, id } = ready(root, reviewer);
  plane.registerRuntime(runtime);
  plane.updateConfig({ defaultRuntime: "deterministic-test-provider" });
  assert.equal(plane.executeTicket(id, "1.1").status, "blocked");
  const repaired = plane.repairTicket(id, "1.1");
  assert.equal(repaired.status, "failed");
  assert.match(repaired.message, /still running/);
  const mission = plane.mission(id);
  assert.equal(mission.reviews.length, 1);
  assert.equal(mission.reviews[0]?.status, "FAIL");
  assert.equal(mission.repairs[0]?.status, "TIMED_OUT");
  assert.equal(mission.repairs[0]?.phases.includes("EDITING"), true);
  assert.equal(mission.repairs[0]?.worktree.includes(`${path.sep}.bmad-next${path.sep}worktrees${path.sep}${id}${path.sep}1.1`), true);
  assert.match(runtime.prompts[1] ?? "", /Finding ID: REV-001/);
  assert.match(runtime.prompts[1] ?? "", /Severity: high/);
  assert.match(runtime.prompts[1] ?? "", /Category: correctness/);
  assert.match(runtime.prompts[1] ?? "", /Affected file:/);
  assert.match(runtime.prompts[1] ?? "", /Requirement: REQ-001/);
  assert.match(runtime.prompts[1] ?? "", /Acceptance criterion:/);
  assert.match(runtime.prompts[1] ?? "", /Actual diff:/);
  assert.equal((runtime.prompts[1] ?? "").includes("fix the review"), false);
  assert.equal(fs.existsSync(path.join(root, ".bmad-next", "evidence", id, "1.1-review-2.json")), false);
  const events = fs.readFileSync(path.join(root, ".bmad-next", "missions", id, "events.jsonl"), "utf8");
  assert.equal(events.split("ReviewStarted").length - 1, 1);
  const html = renderMissionControl(mission);
  assert.match(html, /Review: <strong>FAIL<\/strong>/);
  assert.match(html, /Finding: REV-001/);
  assert.match(html, /Repair: <strong>TIMEOUT<\/strong>/);
  assert.match(html, /Retry Budget: <strong>EXHAUSTED<\/strong>/);
  assert.match(html, /Attack: <strong>NOT RUN<\/strong>/);
  assert.match(html, /Release: <strong>FAIL<\/strong>/);
  assert.match(plane.repairTicket(id, "1.1").message, /Retry budget/);
  assert.equal(plane.mission(id).reviews.length, 1);
});

test("a completed repair reaches an independent fresh review", () => {
  const root = tempProject();
  gitRepo(root);
  const reviewer = new DeterministicReviewer(["fail", "pass"]);
  const runtime = new DeterministicTestRuntime(root, { protocol: true, script: ["completed", "completed"] });
  const { plane, id } = ready(root, reviewer);
  plane.registerRuntime(runtime);
  plane.updateConfig({ defaultRuntime: "deterministic-test-provider" });
  assert.equal(plane.executeTicket(id, "1.1").status, "blocked");
  const repaired = plane.repairTicket(id, "1.1");
  assert.equal(repaired.status, "completed");
  const mission = plane.mission(id);
  assert.equal(mission.reviews.length, 2);
  assert.equal(mission.reviews[0]?.status, "FAIL");
  assert.equal(mission.reviews[1]?.status, "PASS");
  assert.equal(mission.reviews[1]?.duplicateDiff, false);
  assert.equal(mission.repairs[0]?.status, "COMPLETED");
  assert.equal(mission.repairs[0]?.worktree, mission.reviews[0]?.worktree);
  assert.match(reviewer.prompts[1] ?? "", /follows repair attempt/);
  assert.notEqual(mission.reviews[0]?.diffFingerprint, mission.reviews[1]?.diffFingerprint);
  const events = fs.readFileSync(path.join(root, ".bmad-next", "missions", id, "events.jsonl"), "utf8");
  assert.equal(events.split("ReviewStarted").length - 1, 2);
  assert.equal(plane.releaseGate(id).lastVerifiedBuild, null);
});

test("an unchanged diff is recorded when a fresh review sees the same fingerprint", () => {
  const root = tempProject();
  gitRepo(root);
  const reviewer = new DeterministicReviewer(["pass"]);
  const { plane, id } = ready(root, reviewer);
  plane.registerRuntime(new DeterministicTestRuntime(root, { protocol: true }));
  plane.updateConfig({ defaultRuntime: "deterministic-test-provider" });
  plane.executeTicket(id, "1.1");
  plane.reviewTicket(id, "1.1");
  const mission = plane.mission(id);
  assert.equal(mission.reviews.length, 2);
  assert.equal(mission.reviews[1]?.duplicateDiff, true);
  assert.equal(mission.reviews[0]?.diffFingerprint, mission.reviews[1]?.diffFingerprint);
  const events = fs.readFileSync(path.join(root, ".bmad-next", "missions", id, "events.jsonl"), "utf8");
  assert.equal(events.split("ReviewStarted").length - 1, 2);
});

test("a zero-test log forces review FAIL even when the reviewer says pass", () => {
  const root = tempProject();
  gitRepo(root);
  const runner: CommandRunner = {
    which: (bin) => (bin === "reviewer" ? "/usr/bin/reviewer" : processRunner.which(bin)),
    run: (command, args, cwd, timeoutMs) => {
      if (command === "npm" && args[0] === "test") {
        return { exitCode: 0, stdout: "ℹ tests 0\nℹ pass 0\n", stderr: "", durationMs: 5, timedOut: false };
      }
      if (command === "reviewer") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            status: "PASS",
            summary: "Looks fine.",
            findings: [],
            criteria: [{ requirementId: "REQ-001", criterion: "health", status: "PASS" }],
            tests: { coversChangedBehavior: "PASS", wouldCatchRegression: "PASS", edgeCases: "PASS" },
          }),
          stderr: "",
          durationMs: 5,
          timedOut: false,
        };
      }
      return processRunner.run(command, args, cwd, timeoutMs);
    },
  };
  const runtime: AgentRuntime = {
    id: "deterministic-test-provider",
    capabilities: () => Promise.resolve(["test-fixture"]),
    availability: () => "CONFIGURED",
    start: (context) => Promise.resolve(runtime.begin(context)),
    resume: () => Promise.resolve({ id: "zero-tests", runtimeId: "deterministic-test-provider", status: "failed", message: "not resumed", exitCode: null }),
    cancel: () => Promise.resolve(),
    begin: (context) => {
      fs.writeFileSync(path.join(context.cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
      fs.writeFileSync(path.join(context.cwd, "health.js"), "module.exports = { ok: true };\n// BMAD-TICKET-STATUS: built\n");
      return {
        id: "zero-tests",
        runtimeId: "deterministic-test-provider",
        status: "completed",
        message: "wrote a package with no tests",
        exitCode: 0,
        changedFiles: ["package.json", "health.js"],
        phase: "COMPLETED",
        completionSignal: "process-exit",
      };
    },
  };
  const { plane, id } = ready(root, undefined, runner);
  plane.registerRuntime(runtime);
  plane.updateConfig({ defaultRuntime: "deterministic-test-provider", reviewer: { command: "reviewer", args: ["{prompt}"], timeoutMs: 5000 } });
  const built = plane.executeTicket(id, "1.1");
  assert.equal(built.status, "blocked");
  const mission = plane.mission(id);
  assert.equal(mission.evidence.find((record) => record.kind === "unit")?.result, "fail");
  assert.equal(mission.reviews.at(-1)?.status, "FAIL");
  assert.equal(mission.reviews.at(-1)?.findings.some((finding) => finding.id === "REV-TESTS"), true);
});
