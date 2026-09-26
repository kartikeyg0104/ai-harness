import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { BMAD_METHOD_PIN } from "../catalog";
import { testCommandRanTests } from "../quality";
import { CommandModelRunner } from "../model-runner";
import { WorktreeManager } from "../providers";
import { BmadControlPlane } from "../plane";
import { renderMissionControl } from "../render";
import { processRunner } from "../runner";
import { DeterministicTestRuntime, OpenCodeAdapter, classifyOpenCodeRun, type AgentContext, type AgentRun, type AgentRuntime } from "../runtime";
import type { CommandRunner } from "../types";

test("a test command that reports zero tests did not run a test", () => {
  assert.equal(testCommandRanTests("ℹ tests 0\nℹ pass 0\n"), false);
  assert.equal(testCommandRanTests("# tests 0\n# pass 0\n"), false);
  assert.equal(testCommandRanTests("ℹ tests 1\nℹ pass 1\n"), true);
});

function tempProject(): string {
  const base = path.resolve(__dirname, "../../../../.tmp");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "bmad-"));
}

function git(root: string, args: string[]): void {
  const result = spawnSync("git", ["-c", "user.email=bmad@example.com", "-c", "user.name=bmad", "-c", "init.templateDir=", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_TEMPLATE_DIR: "" },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "git failed");
}

function gitRepo(root: string, testScript = "process.exit(0)"): void {
  git(root, ["init"]);
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: "fixture", scripts: { test: `node -e "${testScript}"` } }, null, 2)}\n`);
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

function ready(root: string, runner?: CommandRunner): { plane: BmadControlPlane; id: string } {
  const plane = new BmadControlPlane(root, runner ? { runner } : {});
  const mission = plane.createMission("Build an expense-management SaaS.");
  answerAll(plane, mission.id);
  plane.answerForge(mission.id, "harden");
  plane.acceptTicketTree(mission.id, "ada");
  return { plane, id: mission.id };
}

class InterruptRuntime implements AgentRuntime {
  readonly id = "interrupt-runtime";

  capabilities(): Promise<string[]> {
    return Promise.resolve(["test-fixture"]);
  }

  availability(): "CONFIGURED" {
    return "CONFIGURED";
  }

  start(context: AgentContext): Promise<AgentRun> {
    return Promise.resolve(this.begin(context));
  }

  begin(_context: AgentContext): AgentRun {
    throw new Error("killed");
  }

  resume(runId: string): Promise<AgentRun> {
    return Promise.resolve({ id: runId, runtimeId: this.id, status: "failed", message: "killed", exitCode: null });
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

test("bmad-spec completes only when a real runner satisfies the pinned contract", () => {
  const root = tempProject();
  const fixture = path.join(root, "spec-runner.js");
  fs.writeFileSync(fixture, `
const fs = require("fs");
const path = require("path");
const skill = process.argv[2];
if (skill !== "bmad-spec") process.exit(2);
const dir = path.join(process.cwd(), "_bmad-output", "specs", "expense");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "SPEC.md"), "# Expense spec\\n");
fs.writeFileSync(path.join(dir, ".memlog.md"), "# memlog\\n");
process.stdout.write(JSON.stringify({ status: "complete", files: ["_bmad-output/specs/expense/SPEC.md", "_bmad-output/specs/expense/.memlog.md"] }));
`);
  const plane = new BmadControlPlane(root);
  const mission = plane.createMission("Build an expense-management SaaS.");
  const unresolved = plane.runSkill(mission.id, "bmad-spec");
  assert.notEqual(unresolved.workflow.find((step) => step.skillId === "bmad-spec")?.status, "completed");
  const unresolvedEvents = fs.readFileSync(path.join(root, ".bmad-next", "missions", mission.id, "events.jsonl"), "utf8");
  assert.equal(unresolvedEvents.includes("SkillResolved"), true);
  assert.equal(unresolvedEvents.includes("SkillStarted"), false);
  plane.updateConfig({ runner: { command: process.execPath, args: [fixture], timeoutMs: 20000 } });
  const completed = plane.runSkill(mission.id, "bmad-spec");
  const step = completed.workflow.find((item) => item.skillId === "bmad-spec");
  const artifact = completed.artifacts.find((item) => item.skillId === "bmad-spec" && item.state === "complete");
  assert.equal(step?.status, "completed");
  assert.equal(artifact?.state, "complete");
  assert.equal(artifact?.provenance?.commit, BMAD_METHOD_PIN.commit);
  assert.equal(fs.existsSync(path.join(root, "_bmad-output", "specs", "expense", "SPEC.md")), true);
  assert.equal(fs.existsSync(path.join(root, "_bmad-output", "specs", "expense", ".memlog.md")), true);
  const provenance = JSON.parse(fs.readFileSync(path.join(root, ".bmad-next", "missions", mission.id, "artifacts", "bmad-spec.provenance.json"), "utf8")) as {
    skill: string;
    commit: string;
    runner: string;
    exitCode: number;
    durationMs: number;
    status: string;
    artifactPaths: string[];
  };
  assert.equal(provenance.skill, "bmad-spec");
  assert.equal(provenance.commit, BMAD_METHOD_PIN.commit);
  assert.equal(provenance.runner, process.execPath);
  assert.equal(provenance.exitCode, 0);
  assert.equal(typeof provenance.durationMs, "number");
  assert.equal(provenance.status, "completed");
  assert.equal(provenance.artifactPaths.some((file) => file.endsWith("SPEC.md")), true);
  const events = fs.readFileSync(path.join(root, ".bmad-next", "missions", mission.id, "events.jsonl"), "utf8");
  const resolvedAt = events.indexOf("SkillResolved");
  const startedAt = events.lastIndexOf("SkillStarted");
  const completedAt = events.indexOf("SkillCompleted");
  assert.ok(resolvedAt >= 0 && startedAt > resolvedAt && completedAt > startedAt);
});

test("runner timeout and malformed output stay incomplete", () => {
  const root = tempProject();
  const plane = new BmadControlPlane(root);
  const mission = plane.createMission("Build an expense-management SaaS.");
  plane.updateConfig({ runner: { command: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"], timeoutMs: 300 } });
  const timedOut = plane.runSkill(mission.id, "bmad-spec");
  assert.notEqual(timedOut.workflow.find((step) => step.skillId === "bmad-spec")?.status, "completed");
  assert.equal(timedOut.artifacts.find((artifact) => artifact.skillId === "bmad-spec")?.state, "failed");
  assert.equal(timedOut.artifacts.find((artifact) => artifact.skillId === "bmad-spec")?.provenance?.status, "timeout");
  plane.updateConfig({ runner: { command: process.execPath, args: ["-e", "process.stdout.write('nope')"], timeoutMs: 20000 } });
  const invalid = plane.runSkill(mission.id, "bmad-spec");
  assert.equal(invalid.workflow.find((step) => step.skillId === "bmad-spec")?.status, "blocked");
  assert.equal(invalid.artifacts.filter((artifact) => artifact.skillId === "bmad-spec").at(-1)?.state, "invalid");
});

test("worktree claims lock, block, release, and recover", () => {
  const root = tempProject();
  gitRepo(root);
  const manager = new WorktreeManager(processRunner);
  const first = manager.claim(root, "m001", "1.1", "Developer");
  assert.equal(first.path.endsWith(path.join("m001", "1.1")), true);
  assert.throws(() => manager.claim(root, "m001", "1.1", "Reviewer"), /locked/);
  manager.release(root, "m001", "1.1");
  const second = manager.claim(root, "m001", "1.1", "Reviewer");
  assert.equal(second.agent, "Reviewer");
  manager.release(root, "m001", "1.1");
  fs.writeFileSync(path.join(root, ".bmad-next", "worktree-locks.json"), JSON.stringify({
    claims: [{ missionId: "m001", ticketRef: "1.1", agent: "Developer", path: first.path, pid: 2147483646 }],
  }));
  const recovered = manager.claim(root, "m001", "1.1", "Developer");
  assert.equal(recovered.pid, process.pid);
  const created = manager.create(root, "m001", "1.1", "Developer");
  assert.equal(fs.existsSync(path.join(created.path, ".git")), true);
  assert.throws(() => manager.create(root, "m001", "1.1", "Reviewer"), /locked/);
});

test("ticket execution isolates the worktree and honors the built protocol", () => {
  const root = tempProject();
  gitRepo(root);
  const { plane, id } = ready(root);
  plane.registerRuntime(new DeterministicTestRuntime(root));
  plane.updateConfig({ defaultRuntime: "deterministic-test-provider" });
  const plain = plane.executeTicket(id, "1.1");
  assert.equal(plain.status, "completed");
  assert.equal(plane.mission(id).plans.find((plan) => plan.status === "built"), undefined);
  const worktree = plane.mission(id).executions.find((item) => item.ticketRef === "1.1")?.worktree ?? "";
  const artifact = path.join(worktree, ".bmad-next", "test-runs", `${id}-1.1.txt`);
  assert.equal(fs.existsSync(artifact), true);
  assert.equal(fs.existsSync(path.join(root, ".bmad-next", "test-runs", `${id}-1.1.txt`)), false);
  assert.equal(fs.readFileSync(artifact, "utf8").includes("BMAD-TICKET-STATUS: built"), false);
  const events = fs.readFileSync(path.join(root, ".bmad-next", "missions", id, "events.jsonl"), "utf8");
  assert.equal(events.includes("WorktreeCreated"), true);
  assert.equal(events.includes("AgentStarted"), true);
  assert.equal(events.includes("TicketBuilt"), false);

  const protocolPlane = new BmadControlPlane(root);
  protocolPlane.registerRuntime(new DeterministicTestRuntime(root, { protocol: true }));
  const built = protocolPlane.executeTicket(id, "1.1");
  assert.equal(built.status, "completed");
  assert.equal(protocolPlane.mission(id).plans.find((plan) => plan.ref === "1.1")?.status, "built");
  const evidence = protocolPlane.mission(id).evidence;
  assert.equal(evidence.some((record) => record.kind === "unit" && record.result === "pass" && record.type === "unit"), true);
  assert.equal(evidence.some((record) => record.kind === "review" && record.result === "blocked"), true);
  assert.equal(protocolPlane.releaseGate(id).state, "blocked");
  assert.equal(protocolPlane.mission(id).lastVerifiedBuild, null);
});

test("a failing test does not become release evidence and a missing runtime stays not configured", () => {
  const root = tempProject();
  gitRepo(root, "process.exit(1)");
  const { plane, id } = ready(root);
  assert.equal(plane.executeTicket(id, "1.1").status, "not-configured");
  assert.equal(fs.readFileSync(path.join(root, ".bmad-next", "missions", id, "events.jsonl"), "utf8").includes("AgentStarted"), false);
  plane.registerRuntime(new DeterministicTestRuntime(root, { protocol: true }));
  plane.updateConfig({ defaultRuntime: "deterministic-test-provider" });
  plane.executeTicket(id, "1.1");
  const unit = plane.mission(id).evidence.find((record) => record.kind === "unit");
  assert.equal(unit?.result, "fail");
  assert.equal(plane.mission(id).plans.find((plan) => plan.ref === "1.1")?.status, "built");
  const release = plane.releaseGate(id);
  assert.equal(release.state, "fail");
  assert.equal(release.criteria.find((item) => item.id === "unit")?.state, "fail");
  assert.equal(plane.mission(id).lastVerifiedBuild, null);
});

test("openhands missing does not start, and configured openhands does not build without the protocol", () => {
  const root = tempProject();
  gitRepo(root);
  const missingRunner: CommandRunner = {
    which: (bin) => (bin === "openhands" ? null : processRunner.which(bin)),
    run: (command, args, cwd, timeoutMs) => processRunner.run(command, args, cwd, timeoutMs),
  };
  const missing = ready(root, missingRunner);
  missing.plane.updateConfig({ defaultRuntime: "openhands" });
  const skipped = missing.plane.executeTicket(missing.id, "1.1");
  assert.equal(skipped.status, "not-configured");
  assert.equal(fs.readFileSync(path.join(root, ".bmad-next", "missions", missing.id, "events.jsonl"), "utf8").includes("AgentStarted"), false);

  const openhandsArgs: string[][] = [];
  const configuredRunner: CommandRunner = {
    which: (bin) => (bin === "openhands" ? "/usr/bin/openhands" : processRunner.which(bin)),
    run: (command, args, cwd, timeoutMs) => {
      if (command === "openhands") {
        openhandsArgs.push(args);
        return { exitCode: 0, stdout: "edited files", stderr: "", durationMs: 4, timedOut: false };
      }
      return processRunner.run(command, args, cwd, timeoutMs);
    },
  };
  const configured = ready(root, configuredRunner);
  configured.plane.updateConfig({ defaultRuntime: "openhands" });
  const ran = configured.plane.executeTicket(configured.id, "1.1");
  assert.equal(ran.status, "completed");
  assert.equal(configured.plane.mission(configured.id).plans.find((plan) => plan.status === "built"), undefined);
  const log = fs.readFileSync(path.join(root, ".bmad-next", "missions", configured.id, "events.jsonl"), "utf8");
  assert.equal(log.includes("AgentStarted"), true);
  assert.equal(log.includes("AgentCompleted"), true);
  assert.equal(log.includes("TicketBuilt"), false);
  assert.deepEqual(openhandsArgs[0]?.slice(0, 3), ["--headless", "--json", "-t"]);
});

test("a second agent cannot take a locked ticket, and a restart can resume an interrupted execution", () => {
  const root = tempProject();
  gitRepo(root);
  const { plane, id } = ready(root);
  plane.registerRuntime(new DeterministicTestRuntime(root, { protocol: true }));
  plane.updateConfig({ defaultRuntime: "deterministic-test-provider" });
  new WorktreeManager(processRunner).claim(root, id, "1.1", "lock-holder");
  const blocked = plane.executeTicket(id, "1.1");
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.message, /locked/);
  assert.equal(plane.mission(id).plans.find((plan) => plan.status === "built"), undefined);

  const interrupted = new BmadControlPlane(root);
  interrupted.registerRuntime(new InterruptRuntime());
  interrupted.updateConfig({ defaultRuntime: "interrupt-runtime" });
  new WorktreeManager(processRunner).release(root, id, "1.1");
  const failed = interrupted.executeTicket(id, "1.1");
  assert.equal(failed.status, "failed");
  assert.equal(interrupted.mission(id).plans.find((plan) => plan.status === "built"), undefined);
  const restarted = new BmadControlPlane(root);
  assert.equal(restarted.mission(id).id, id);
  assert.equal(restarted.mission(id).executions.find((item) => item.ticketRef === "1.1")?.status, "failed");
  const snapshot = restarted.mission(id);
  const execution = snapshot.executions.find((item) => item.ticketRef === "1.1");
  if (!execution) throw new Error("missing execution");
  execution.status = "running";
  snapshot.loop = "running";
  restarted.importMission(JSON.stringify({ mission: snapshot }));
  const resumed = new BmadControlPlane(root).resumeTicket(id, "1.1");
  assert.equal(resumed.executions.find((item) => item.ticketRef === "1.1")?.status, "blocked");
  assert.equal(resumed.plans.find((plan) => plan.status === "built"), undefined);
});

test("invalid headless JSON, a missing SPEC.md, and an empty model reply stay incomplete", () => {
  const root = tempProject();
  const plane = new BmadControlPlane(root);
  const mission = plane.createMission("Build an expense-management SaaS.");
  plane.updateConfig({ runner: { command: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify({status:'complete',reason:'done'}))"], timeoutMs: 20000 } });
  const declared = plane.runSkill(mission.id, "bmad-spec");
  assert.notEqual(declared.workflow.find((step) => step.skillId === "bmad-spec")?.status, "completed");
  assert.equal(declared.artifacts.filter((artifact) => artifact.skillId === "bmad-spec").at(-1)?.provenance?.status, "output-invalid");
  const notes = path.join(root, "notes-runner.js");
  fs.writeFileSync(notes, `
const fs = require("fs");
const path = require("path");
const dir = path.join(process.cwd(), "_bmad-output", "specs", "expense");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "NOTES.md"), "notes");
process.stdout.write(JSON.stringify({ status: "complete", files: ["_bmad-output/specs/expense/NOTES.md"] }));
`);
  plane.updateConfig({ runner: { command: process.execPath, args: [notes], timeoutMs: 20000 } });
  const missingSpec = plane.runSkill(mission.id, "bmad-spec");
  assert.equal(missingSpec.artifacts.filter((artifact) => artifact.skillId === "bmad-spec").at(-1)?.provenance?.status, "output-invalid");
  plane.updateConfig({ runner: { command: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 20000 } });
  const empty = plane.runSkill(mission.id, "bmad-spec");
  assert.equal(empty.artifacts.filter((artifact) => artifact.skillId === "bmad-spec").at(-1)?.provenance?.status, "output-missing");
  const events = fs.readFileSync(path.join(root, ".bmad-next", "missions", mission.id, "events.jsonl"), "utf8");
  assert.equal(events.includes("SkillCompleted"), false);
  assert.equal(events.includes("SkillFailed"), true);
});

test("a model runner refuses shell execution and a cwd outside the workspace", () => {
  const root = tempProject();
  const calls: string[] = [];
  const runner: CommandRunner = {
    which: () => "/bin/sh",
    run: (command) => {
      calls.push(command);
      return { exitCode: 0, stdout: "done", stderr: "", durationMs: 1, timedOut: false };
    },
  };
  const shell = new CommandModelRunner(runner, { command: "sh", args: ["-c", "echo injected"], timeoutMs: 1000 }, root);
  const refused = shell.runSync({ skillId: "bmad-spec", prompt: "expense", input: "input.md", cwd: root, timeoutMs: 1000 });
  assert.equal(refused.status, "failed");
  assert.equal(calls.length, 0);
  const outside = new CommandModelRunner(runner, { command: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 1000 }, root);
  const escaped = outside.runSync({ skillId: "bmad-spec", prompt: "expense", input: "input.md", cwd: path.parse(root).root, timeoutMs: 1000 });
  assert.equal(escaped.status, "failed");
  assert.match(escaped.stderr, /outside/);
});

test("exit 0 without a diff, exit 1 with the protocol, and exit 0 with the protocol stay distinct", () => {
  const root = tempProject();
  gitRepo(root);
  const { plane, id } = ready(root);
  plane.registerRuntime(new DeterministicTestRuntime(root, { writeArtifact: false }));
  plane.updateConfig({ defaultRuntime: "deterministic-test-provider" });
  const empty = plane.executeTicket(id, "1.1");
  assert.equal(empty.status, "completed");
  assert.equal(plane.mission(id).plans.find((plan) => plan.status === "built"), undefined);
  assert.deepEqual(plane.mission(id).executions.find((item) => item.ticketRef === "1.1")?.changedFiles ?? [], []);

  const failedRoot = tempProject();
  gitRepo(failedRoot);
  const failed = ready(failedRoot);
  failed.plane.registerRuntime(new DeterministicTestRuntime(failedRoot, { protocol: true, exitCode: 1 }));
  failed.plane.updateConfig({ defaultRuntime: "deterministic-test-provider" });
  const crashed = failed.plane.executeTicket(failed.id, "1.1");
  assert.equal(crashed.status, "failed");
  assert.equal(failed.plane.mission(failed.id).plans.find((plan) => plan.status === "built"), undefined);
  const failedEvents = fs.readFileSync(path.join(failedRoot, ".bmad-next", "missions", failed.id, "events.jsonl"), "utf8");
  assert.equal(failedEvents.includes("AgentFailed"), true);
  assert.equal(failedEvents.includes("TicketBlocked"), true);
  assert.equal(failedEvents.includes("TicketBuilt"), false);

  const builtRoot = tempProject();
  gitRepo(builtRoot);
  const built = ready(builtRoot);
  built.plane.registerRuntime(new DeterministicTestRuntime(builtRoot, { protocol: true }));
  built.plane.updateConfig({ defaultRuntime: "deterministic-test-provider" });
  assert.equal(built.plane.executeTicket(built.id, "1.1").status, "completed");
  const mission = built.plane.mission(built.id);
  assert.equal(mission.plans.find((plan) => plan.ref === "1.1")?.status, "built");
  const execution = mission.executions.find((item) => item.ticketRef === "1.1");
  assert.ok((execution?.changedFiles.length ?? 0) > 0);
  assert.equal(execution?.evidence.length, 2);
  const html = renderMissionControl(mission);
  assert.match(html, /Protocol: VALID/);
  assert.match(html, /Tests: PASS/);
  assert.match(html, /Ticket: BUILT/);
  assert.match(html, /deterministic-test-provider/);
});

test("openhands failure does not build a ticket", () => {
  const root = tempProject();
  gitRepo(root);
  const runner: CommandRunner = {
    which: (bin) => (bin === "openhands" ? "/usr/bin/openhands" : processRunner.which(bin)),
    run: (command, args, cwd, timeoutMs) => {
      if (command === "openhands") return { exitCode: 1, stdout: "", stderr: "agent failed", durationMs: 3, timedOut: false };
      return processRunner.run(command, args, cwd, timeoutMs);
    },
  };
  const { plane, id } = ready(root, runner);
  plane.updateConfig({ defaultRuntime: "openhands" });
  const failed = plane.executeTicket(id, "1.1");
  assert.equal(failed.status, "failed");
  assert.equal(plane.mission(id).plans.find((plan) => plan.status === "built"), undefined);
  const events = fs.readFileSync(path.join(root, ".bmad-next", "missions", id, "events.jsonl"), "utf8");
  assert.equal(events.includes("AgentFailed"), true);
  assert.equal(events.includes("TicketBuilt"), false);
});

test("worktree cleanup failure keeps the lock", () => {
  const root = tempProject();
  gitRepo(root);
  const failing: CommandRunner = {
    which: (bin) => processRunner.which(bin),
    run: (command, args, cwd, timeoutMs) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "remove") {
        return { exitCode: 1, stdout: "", stderr: "remove failed", durationMs: 1, timedOut: false };
      }
      return processRunner.run(command, args, cwd, timeoutMs);
    },
  };
  const manager = new WorktreeManager(failing);
  manager.claim(root, "m001", "1.1", "Developer");
  const result = manager.remove(root, "1.1", "m001");
  assert.equal(result.removed, false);
  assert.match(result.reason, /remove failed/);
  const locks = JSON.parse(fs.readFileSync(path.join(root, ".bmad-next", "worktree-locks.json"), "utf8")) as { claims: { ticketRef: string }[] };
  assert.equal(locks.claims.some((claim) => claim.ticketRef === "1.1"), true);
});

test("spec, ticket, worktree, protocol, and test evidence form one slice", () => {
  const root = tempProject();
  gitRepo(root);
  const fixture = path.join(root, "spec-runner.js");
  fs.writeFileSync(fixture, `
const fs = require("fs");
const path = require("path");
const dir = path.join(process.cwd(), "_bmad-output", "specs", "expense");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "SPEC.md"), "# Expense spec\\n");
fs.writeFileSync(path.join(dir, ".memlog.md"), "# memlog\\n");
process.stdout.write(JSON.stringify({ status: "complete", files: ["_bmad-output/specs/expense/SPEC.md", "_bmad-output/specs/expense/.memlog.md"] }));
`);
  const { plane, id } = ready(root);
  plane.updateConfig({ runner: { command: process.execPath, args: [fixture], timeoutMs: 20000 }, defaultRuntime: "deterministic-test-provider" });
  const specified = plane.runSkill(id, "bmad-spec");
  assert.equal(specified.workflow.find((step) => step.skillId === "bmad-spec")?.status, "completed");
  assert.equal(specified.artifacts.some((artifact) => artifact.skillId === "bmad-spec" && artifact.state === "complete"), true);
  plane.registerRuntime(new DeterministicTestRuntime(root, { protocol: true }));
  const built = plane.executeTicket(id, "1.1");
  assert.equal(built.status, "completed");
  const mission = plane.mission(id);
  const execution = mission.executions.find((item) => item.ticketRef === "1.1");
  if (!execution?.worktree) throw new Error("missing worktree");
  const worktree = execution.worktree;
  assert.equal(mission.plans.find((plan) => plan.ref === "1.1")?.status, "built");
  const protocolFile = path.join(worktree, ".bmad-next", "test-runs", `${id}-1.1.txt`);
  assert.equal(fs.existsSync(protocolFile), true);
  assert.match(fs.readFileSync(protocolFile, "utf8"), /BMAD-TICKET-STATUS:\s*built/);
  assert.equal(mission.evidence.some((record) => record.kind === "unit" && record.result === "pass" && record.exit_code === 0 && typeof record.artifact === "string" && fs.existsSync(record.artifact)), true);
  const events = fs.readFileSync(path.join(root, ".bmad-next", "missions", id, "events.jsonl"), "utf8");
  for (const name of ["SkillResolved", "SkillStarted", "SkillCompleted", "TicketStarted", "WorktreeCreated", "AgentStarted", "AgentCompleted", "TestStarted", "TestPassed", "EvidenceCreated", "TicketBuilt"]) {
    assert.equal(events.includes(name), true, name);
  }
  const review = mission.evidence.find((record) => record.kind === "review");
  assert.equal(review?.result, "blocked");
  assert.match(fs.readFileSync(review?.artifact ?? "", "utf8"), /status: blocked/);
  assert.equal(plane.releaseGate(id).lastVerifiedBuild ?? plane.mission(id).lastVerifiedBuild, null);
});

test("executeTicket stops after the retry budget", () => {
  const { plane, id } = ready(tempProject());
  assert.equal(plane.executeTicket(id, "1.1").status, "not-configured");
  assert.equal(plane.executeTicket(id, "1.1").status, "not-configured");
  const blocked = plane.executeTicket(id, "1.1");
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.message, /Retry budget/);
  assert.equal(plane.mission(id).escalationLevel > 1, true);
});

test("a missing model command does not start, and the prompt is one argument", () => {
  const root = tempProject();
  const plane = new BmadControlPlane(root);
  const mission = plane.createMission("Build an expense-management SaaS.");
  plane.updateConfig({ runner: { command: "definitely-missing-bmad-bin", args: [], timeoutMs: 1000 } });
  const missing = plane.runSkill(mission.id, "bmad-spec");
  assert.notEqual(missing.workflow.find((step) => step.skillId === "bmad-spec")?.status, "completed");
  const events = fs.readFileSync(path.join(root, ".bmad-next", "missions", mission.id, "events.jsonl"), "utf8");
  assert.equal(events.includes("SkillResolved"), true);
  assert.equal(events.includes("SkillStarted"), false);
  assert.equal(events.includes("SkillCompleted"), false);
  const seen: string[][] = [];
  const runner = new CommandModelRunner({
    which: () => "/usr/bin/opencode",
    run: (_command, args) => {
      seen.push(args);
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    },
  }, { command: "opencode", args: ["run", "--format", "default", "{prompt}"], timeoutMs: 1000 }, root);
  runner.runSync({ skillId: "bmad-spec", prompt: "full contract", input: path.join(root, "in.md"), cwd: root, timeoutMs: 1000 });
  assert.deepEqual(seen[0], ["run", "--format", "default", "full contract"]);
});

test("opencode refuses a cwd outside the ticket worktree", () => {
  const root = tempProject();
  const calls: string[] = [];
  const adapter = new OpenCodeAdapter({
    which: () => "/usr/bin/opencode",
    run: (command) => {
      calls.push(command);
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    },
  });
  const refused = adapter.begin({ missionId: "m", ticketRef: "1.1", agent: "Developer", cwd: root, prompt: "change code" });
  assert.equal(refused.status, "failed");
  assert.equal(calls.length, 0);
  assert.equal(adapter.availability(), "AVAILABLE");
});

test("a protocol file with an empty diff is not built", () => {
  const root = tempProject();
  gitRepo(root);
  const protocol = path.join(root, "already.txt");
  fs.writeFileSync(protocol, "BMAD-TICKET-STATUS: built\n");
  git(root, ["add", "already.txt"]);
  git(root, ["commit", "-m", "protocol"]);
  const { plane, id } = ready(root);
  const quiet: AgentRuntime = {
    id: "quiet-runtime",
    capabilities: () => Promise.resolve(["test-fixture"]),
    availability: () => "CONFIGURED",
    start: (context) => Promise.resolve(quiet.begin(context)),
    begin: () => ({ id: "quiet", runtimeId: "quiet-runtime", status: "completed", message: "no edit", exitCode: 0, artifact: protocol }),
    resume: (runId) => Promise.resolve({ id: runId, runtimeId: "quiet-runtime", status: "failed", message: "no", exitCode: null }),
    cancel: () => Promise.resolve(),
  };
  plane.registerRuntime(quiet);
  plane.updateConfig({ defaultRuntime: "quiet-runtime" });
  const result = plane.executeTicket(id, "1.1");
  assert.equal(result.status, "completed");
  assert.equal(plane.mission(id).plans.find((plan) => plan.status === "built"), undefined);
  assert.deepEqual(plane.mission(id).executions.find((item) => item.ticketRef === "1.1")?.changedFiles ?? ["missing"], []);
});

test("opencode completion is step_finish stop, not a file change or a bare exit code", () => {
  const cwd = path.join(tempProject(), ".bmad-next", "worktrees", "m", "1.1");
  const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
  const adapter = new OpenCodeAdapter({
    which: () => "/usr/bin/opencode",
    run: (command, args, _cwd, _timeout, env) => {
      if (command === "opencode") {
        calls.push({ args, env });
        return { exitCode: null, stdout: '{"type":"tool","part":{"type":"tool","tool":"write"}}\n', stderr: "", durationMs: 180000, timedOut: true };
      }
      return { exitCode: 0, stdout: "?? src/health.js\n", stderr: "", durationMs: 1, timedOut: false };
    },
  });
  const timed = adapter.begin({ missionId: "m", ticketRef: "1.1", agent: "Developer", cwd, prompt: "fix" });
  assert.match(calls[0]?.args.at(-1) ?? "", /index\.html/);
  assert.equal(timed.status, "timeout");
  assert.equal(timed.phase, "TIMED_OUT");
  assert.equal(timed.changedFiles?.includes("src/health.js"), true);
  assert.match(calls[0]?.args.join(" ") ?? "", /--format json/);
  assert.match(calls[0]?.env?.OPENCODE_CONFIG_CONTENT ?? "", /"steps":20/);
  const stop = '{"type":"step_finish","part":{"type":"step-finish","reason":"stop"}}';
  assert.equal(classifyOpenCodeRun({ exitCode: 0, timedOut: false, stdout: stop }).status, "completed");
  assert.equal(classifyOpenCodeRun({ exitCode: 0, timedOut: false, stdout: stop }).completionSignal, "process-exit");
  assert.equal(classifyOpenCodeRun({ exitCode: null, timedOut: true, stdout: stop }).completionSignal, "terminal-event");
  assert.equal(classifyOpenCodeRun({ exitCode: 0, timedOut: false, stdout: "done" }).status, "failed");
  assert.equal(classifyOpenCodeRun({ exitCode: null, timedOut: true, stdout: '{"type":"step_finish","part":{"reason":"tool-calls"}}' }).status, "timeout");
});

test("OpenCode retries once when its database is locked", () => {
  const cwd = path.join(tempProject(), ".bmad-next", "worktrees", "m", "1.1");
  fs.mkdirSync(cwd, { recursive: true });
  let runs = 0;
  const adapter = new OpenCodeAdapter({
    which: () => "/usr/bin/opencode",
    run: (command) => {
      if (command !== "opencode") return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
      runs += 1;
      if (runs === 1) return { exitCode: 1, stdout: "", stderr: "Error: Unexpected error\n\ndatabase is locked", durationMs: 2, timedOut: false };
      return { exitCode: 0, stdout: '{"type":"step_finish","part":{"type":"step-finish","reason":"stop"}}', stderr: "", durationMs: 3, timedOut: false };
    },
  });
  const result = adapter.begin({ missionId: "m", ticketRef: "1.1", agent: "Developer", cwd, prompt: "fix" });
  assert.equal(runs, 2);
  assert.equal(result.status, "completed");
});
