import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { BmadControlPlane } from "../plane";
import { ExternalCliAdapter } from "../runtime";
import { appendTrace, openHandsSdkStatus, serviceStatuses } from "../platform";
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

const quiet: CommandRunner = {
  which: () => null,
  run: () => {
    throw new Error("not called");
  },
};

test("qwen, goose, and swe adapters stay not configured until the binary exists", () => {
  const context = { missionId: "m", ticketRef: "1.1", agent: "Developer", cwd: path.join(tempProject(), ".bmad-next", "worktrees", "m", "1.1"), prompt: "fix" };
  for (const id of ["qwen", "goose", "swe-agent", "mini-swe-agent"]) {
    const adapter = new ExternalCliAdapter(id, [id], (prompt) => ["--", prompt], quiet);
    assert.equal(adapter.availability(), "NOT CONFIGURED");
    assert.equal(adapter.begin(context).status, "not-configured");
  }
});

test("an external coding cli timeout is not completion and a cwd outside the worktree is refused", () => {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    which: (bin) => (bin === "qwen" ? "/usr/bin/qwen" : null),
    run: (_command, args) => {
      calls.push(args);
      return { exitCode: null, stdout: "", stderr: "still running", durationMs: 180000, timedOut: true };
    },
  };
  const cwd = path.join(tempProject(), ".bmad-next", "worktrees", "m", "1.1");
  const adapter = new ExternalCliAdapter("qwen", ["qwen"], (prompt) => ["-p", prompt], runner);
  const timed = adapter.begin({ missionId: "m", ticketRef: "1.1", agent: "Developer", cwd, prompt: "ship health" });
  assert.equal(timed.status, "timeout");
  assert.equal(timed.completionSignal, null);
  assert.deepEqual(calls[0]?.slice(0, 1), ["-p"]);
  const refused = adapter.begin({ missionId: "m", ticketRef: "1.1", agent: "Developer", cwd: tempProject(), prompt: "ship health" });
  assert.equal(refused.status, "failed");
  assert.match(refused.message, /worktree/);
});

test("requirement changes make earlier evidence stale", () => {
  const root = tempProject();
  const plane = new BmadControlPlane(root);
  const mission = plane.createMission("Build an expense-management SaaS.");
  answerAll(plane, mission.id);
  plane.answerForge(mission.id, "harden");
  const artifact = path.join(root, "unit.log");
  fs.writeFileSync(artifact, "ok");
  plane.recordEvidence(mission.id, {
    requirement_id: "REQ-001",
    result: "pass",
    kind: "unit",
    runner: "process",
    started_at: "2026-09-26T00:00:00.000Z",
    finished_at: "2026-09-26T00:00:01.000Z",
    exit_code: 0,
    command: "node test.js",
    artifact,
  });
  plane.correctCourse(mission.id, "REQ-001", "Reset links expire after 10 minutes.", "The policy changed.");
  const report = plane.releaseGate(mission.id);
  const unit = report.criteria.find((item) => item.id === "unit");
  assert.equal(unit?.state, "blocked");
  assert.match(unit?.detail ?? "", /stale/);
  assert.equal(plane.mission(mission.id).evidence.length, 1);
});

test("plugins declare permissions and stay disabled until enabled", () => {
  const plane = new BmadControlPlane(tempProject());
  assert.throws(() => plane.addPlugin({ id: "Bad_Id", version: "1.0.0", source: "https://github.com/bmad-code-org/bmad-method-test-architecture-enterprise", license: "MIT", tools: [], permissions: { read: true, write: false, execute: false, network: false, credentials: false, filesystem: [] } }), /lowercase/);
  const installed = plane.addPlugin({
    id: "tea-local",
    version: "1.0.0",
    source: "https://github.com/bmad-code-org/bmad-method-test-architecture-enterprise",
    license: "MIT",
    tools: ["risk"],
    permissions: { read: true, write: false, execute: false, network: false, credentials: false, filesystem: [".bmad-next"] },
  });
  assert.equal(installed.enabled, false);
  assert.equal(plane.enablePlugin("tea-local", true).enabled, true);
  assert.equal(plane.enablePlugin("tea-local", false).enabled, false);
  assert.equal(plane.deletePlugin("tea-local").length, 0);
});

test("the file index is incremental and is not an AST", () => {
  const root = tempProject();
  fs.writeFileSync(path.join(root, "README.md"), "health\n");
  const plane = new BmadControlPlane(root);
  const first = plane.fileIndex();
  assert.equal(first.kind, "file-index");
  assert.equal(first.ast, false);
  assert.equal(first.files >= 1, true);
  const second = plane.fileIndex();
  assert.equal(second.changed, 0);
});

test("mutation restores the file and chaos records a real timeout", () => {
  const root = tempProject();
  const file = path.join(root, "check.js");
  fs.writeFileSync(file, "function check(){ return 1 === 1 }\n");
  const plane = new BmadControlPlane(root);
  const measured = plane.mutate("check.js", process.execPath, ["-e", `if (require('fs').readFileSync(${JSON.stringify(file)},'utf8').includes('!==')) process.exit(1)`]);
  assert.equal(measured.status, "measured");
  assert.equal(measured.caught, 1);
  assert.match(fs.readFileSync(file, "utf8"), /===/);
  const chaos = plane.chaos("timeout", process.execPath, ["-e", "setTimeout(() => {}, 5000)"]);
  assert.equal(chaos.timedOut, true);
  assert.match(chaos.detail, /timeout/);
});

test("external services and the OpenHands SDK stay unconfigured without credentials or a package", () => {
  const services = serviceStatuses({});
  assert.equal(services.every((item) => item.status === "not-configured"), true);
  const sdk = openHandsSdkStatus();
  assert.equal(sdk.status === "NOT_CONFIGURED" || sdk.status === "INSTALLED", true);
  if (sdk.status === "NOT_CONFIGURED") assert.match(sdk.detail, /CLI adapter/);
});

test("import rejects a payload without a mission id and traces redact secrets", () => {
  const root = tempProject();
  const plane = new BmadControlPlane(root);
  assert.throws(() => plane.importMission("{}"), /id/);
  const created = plane.createMission("Add a health check.");
  const timeline = plane.timeline(created.id);
  assert.equal(timeline.some((item) => item.type === "MissionCreated"), true);
  appendTrace(root, { missionId: created.id, type: "ToolCalled", at: "2026-09-26T00:00:00.000Z", data: { token: "sk-live-supersecretvalue" } });
  const trace = fs.readFileSync(path.join(root, ".bmad-next", "traces.jsonl"), "utf8");
  assert.equal(trace.includes("sk-live-supersecretvalue"), false);
});
