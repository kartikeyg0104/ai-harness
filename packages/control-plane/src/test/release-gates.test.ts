import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DeterministicAttacker } from "../attack";
import { CommandNfrProvider, DeterministicNfr, nfrFromText } from "../nfr";
import { parseIntent } from "../intent";
import { BmadControlPlane } from "../plane";
import { evaluateRelease, fileExists, releaseMatrix } from "../quality";
import { renderMissionControl } from "../render";
import { processRunner } from "../runner";
import { DeterministicReviewer } from "../reviewer";
import { DeterministicTestRuntime } from "../runtime";
import { CommandSecurityScanner, DeterministicSecurity, parseSemgrep, parseTrivy, parseTrufflehog, redactSecurityOutput } from "../security";
import type { NfrRequirement } from "../types";

function tempProject(): string {
  const base = path.resolve(__dirname, "../../../../.tmp");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "bmad-gates-"));
}

function answerAll(plane: BmadControlPlane, id: string): void {
  let mission = plane.mission(id);
  while (mission.forge && mission.forge.outcome === "active") {
    const open = mission.forge.questions.find((question) => !mission.forge?.answered.includes(question.id));
    if (!open) break;
    mission = plane.answerForge(id, `locked answer for ${open.id}`);
  }
}

function git(root: string, args: string[]): void {
  const result = spawnSync("git", ["-c", "user.email=bmad@example.com", "-c", "user.name=bmad", "-c", "init.templateDir=", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_TEMPLATE_DIR: "" },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "git failed");
}

let clock = Date.parse("2026-09-26T00:00:00.000Z");

function record(plane: BmadControlPlane, root: string, id: string, kind: string, result: "pass" | "fail", requirement = "REQ-001", story = "1.1"): void {
  clock += 1000;
  const stamp = new Date(clock).toISOString();
  const file = path.join(root, `${kind}-${story}-${requirement}-${clock}.log`);
  fs.writeFileSync(file, `${kind} ${result}`);
  plane.recordEvidence(id, {
    requirement_id: requirement,
    story_id: story,
    result,
    kind,
    runner: "process",
    started_at: stamp,
    finished_at: new Date(clock + 100).toISOString(),
    exit_code: result === "pass" ? 0 : 1,
    command: `run ${kind}`,
    artifact: file,
  });
}

function planeAt(root = tempProject()): { root: string; plane: BmadControlPlane; id: string } {
  const plane = new BmadControlPlane(root);
  const mission = plane.createMission("Build an expense-management SaaS.");
  return { root, plane, id: mission.id };
}

test("security parsers reject malformed output and redact secrets", () => {
  assert.equal(parseSemgrep("{", 1, false).status, "ERROR");
  assert.equal(parseSemgrep('{"results":[]}', 0, false).status, "PASS");
  assert.equal(parseSemgrep('{"results":[]}', 2, false).status, "ERROR");
  assert.equal(parseSemgrep("", null, true).status, "TIMEOUT");
  const high = parseSemgrep('{"results":[{"check_id":"x","path":"a.js","start":{"line":4},"extra":{"severity":"HIGH","message":"unsafe"}}]}', 1, false);
  assert.equal(high.status, "FAIL");
  assert.equal(high.findings[0]?.severity, "high");
  const critical = parseSemgrep('{"results":[{"check_id":"x","path":"a.js","start":{"line":4},"extra":{"severity":"ERROR","message":"unsafe"}}]}', 0, false);
  assert.equal(critical.status, "FAIL");
  assert.equal(critical.findings[0]?.severity, "critical");
  const secret = "AKIAIOSFODNN7EXAMPLE";
  const truffle = parseTrufflehog(JSON.stringify({ DetectorName: "AWS", Raw: secret, SourceMetadata: { Data: { Filesystem: { file: "creds", line: 2 } } } }), 0, false);
  assert.equal(truffle.status, "FAIL");
  assert.equal(truffle.findings[0]?.evidence, "[REDACTED]");
  assert.equal(JSON.stringify(truffle).includes(secret), false);
  const trivy = parseTrivy(JSON.stringify({ Results: [{ Target: "a", Secrets: [{ RuleID: "aws", Title: "key", StartLine: 3, Match: secret }] }] }), 0, false, ["secret"]);
  assert.equal(trivy.status, "FAIL");
  assert.equal(JSON.stringify(trivy).includes(secret), false);
  assert.equal(redactSecurityOutput(`password = "${secret}"`).includes(secret), false);
});

test("security unavailable stays not configured and does not pass the gate", () => {
  const { root, id } = planeAt();
  const plane = new BmadControlPlane(root, { security: new DeterministicSecurity(["unavailable"]) });
  const scan = plane.runSecurity(id);
  assert.equal(scan.status, "NOT_CONFIGURED");
  const events = fs.readFileSync(path.join(root, ".bmad-next", "missions", id, "events.jsonl"), "utf8");
  assert.equal(events.includes("SecurityStarted"), false);
  const evidence = plane.mission(id).evidence.find((record) => record.kind === "security");
  assert.equal(evidence?.result, "not-configured");
  const report = plane.releaseGate(id);
  assert.notEqual(report.state, "pass");
  assert.equal(report.criteria.find((item) => item.id === "security")?.state, "blocked");
  assert.equal(plane.mission(id).lastVerifiedBuild, null);
  const html = renderMissionControl(plane.mission(id));
  assert.match(html, /NOT CONFIGURED/);
  assert.doesNotMatch(html, /Semgrep[\s\S]{0,80}PASS/);
});

test("security timeout, nonzero exit, and malformed output do not pass", () => {
  for (const mode of ["timeout", "nonzero", "malformed"] as const) {
    const { root, id } = planeAt();
    const plane = new BmadControlPlane(root, { security: new DeterministicSecurity([mode]) });
    const scan = plane.runSecurity(id);
    assert.notEqual(scan.status, "PASS");
    const events = fs.readFileSync(path.join(root, ".bmad-next", "missions", id, "events.jsonl"), "utf8");
    assert.equal(events.includes("SecurityStarted"), true);
    assert.equal(events.includes("SecurityToolStarted"), true);
    assert.equal(events.includes("SecurityFailed"), true);
    assert.equal(events.includes("SecurityCompleted"), false);
    assert.notEqual(plane.mission(id).evidence.find((record) => record.kind === "security")?.result, "pass");
  }
});

test("high, critical, and secret findings fail security and stay redacted", () => {
  const secret = "sk-live-supersecretvalue";
  for (const mode of ["high", "critical", "secret"] as const) {
    const { root, id } = planeAt();
    const plane = new BmadControlPlane(root, { security: new DeterministicSecurity([mode], secret) });
    const scan = plane.runSecurity(id);
    assert.equal(scan.status, "FAIL");
    const file = plane.mission(id).securityRuns?.at(-1)?.evidencePath ?? "";
    const body = fs.readFileSync(file, "utf8");
    assert.equal(body.includes(secret), false);
    assert.equal(plane.releaseGate(id).criteria.find((item) => item.id === "security")?.state, "fail");
  }
});

test("a clean deterministic scan can pass only after every required tool runs", () => {
  const { root, id } = planeAt();
  const plane = new BmadControlPlane(root, { security: new DeterministicSecurity(["clean"]) });
  const scan = plane.runSecurity(id);
  assert.equal(scan.status, "PASS");
  assert.deepEqual(scan.tools.map((tool) => tool.status), ["PASS", "PASS", "PASS"]);
  const events = fs.readFileSync(path.join(root, ".bmad-next", "missions", id, "events.jsonl"), "utf8");
  assert.equal(events.includes("SecurityCompleted"), true);
  assert.equal(plane.mission(id).evidence.find((record) => record.kind === "security")?.result, "pass");
});

test("a security finding repairs through test, review, attack, and a fresh scan", () => {
  const root = tempProject();
  git(root, ["init"]);
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: "fixture", scripts: { test: "node -e \"process.exit(0)\"" } })}\n`);
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  const reviewer = new DeterministicReviewer(["pass", "pass"]);
  const attacker = new DeterministicAttacker(["pass", "pass"]);
  const security = new DeterministicSecurity(["high", "clean"]);
  const plane = new BmadControlPlane(root, { reviewer, attacker, security });
  const mission = plane.createMission("Build an expense-management SaaS.");
  answerAll(plane, mission.id);
  plane.answerForge(mission.id, "harden");
  plane.acceptTicketTree(mission.id, "ada");
  const runtime = new DeterministicTestRuntime(root, { protocol: true });
  plane.registerRuntime(runtime);
  plane.updateConfig({ defaultRuntime: "deterministic-test-provider", retryBudget: 4 });
  const built = plane.executeTicket(mission.id, "1.1");
  assert.equal(built.status, "completed");
  const failed = plane.runSecurity(mission.id, "1.1");
  assert.equal(failed.status, "FAIL");
  const repair = plane.repairTicket(mission.id, "1.1");
  assert.equal(repair.status, "completed");
  assert.match(repair.message, /security scan/);
  assert.match(runtime.prompts.at(-1) ?? "", /Security evidence/);
  const current = plane.mission(mission.id);
  assert.ok((current.reviews ?? []).filter((item) => item.ticketRef === "1.1").length >= 2);
  assert.ok((current.attacks ?? []).filter((item) => item.ticketRef === "1.1").length >= 2);
  assert.equal(current.securityRuns?.at(0)?.status, "FAIL");
  assert.equal(current.securityRuns?.at(-1)?.status, "PASS");
  const first = JSON.parse(fs.readFileSync(path.join(root, ".bmad-next", "evidence", mission.id, "1.1-security-1.json"), "utf8")) as { status: string };
  const second = JSON.parse(fs.readFileSync(path.join(root, ".bmad-next", "evidence", mission.id, "1.1-security-2.json"), "utf8")) as { status: string };
  assert.equal(first.status, "FAIL");
  assert.equal(second.status, "PASS");
  const events = fs.readFileSync(path.join(root, ".bmad-next", "missions", mission.id, "events.jsonl"), "utf8");
  assert.ok(events.indexOf("SecurityFailed") < events.lastIndexOf("SecurityCompleted"));
  assert.ok(events.indexOf("SecurityFailed") < events.lastIndexOf("ReviewStarted"));
});

test("production security scan uses the real tools and redacts secrets", { timeout: 180000 }, () => {
  const scanner = new CommandSecurityScanner(processRunner, 60000);
  const clean = tempProject();
  fs.writeFileSync(path.join(clean, "health.js"), "function health(){return {status:'ok'};}\nmodule.exports={health};\n");
  const passed = scanner.scanBlocking({ missionId: "msn", ticketRef: "1.1", worktree: clean, root: clean });
  assert.equal(passed.status, "PASS");
  for (const tool of passed.tools) {
    assert.equal(tool.status, "PASS");
    assert.doesNotMatch(tool.command, /--version/);
  }
  assert.match(passed.tools.find((tool) => tool.id === "semgrep")?.command ?? "", /scan/);
  assert.match(passed.tools.find((tool) => tool.id === "trivy")?.command ?? "", /\bfs\b/);
  assert.match(passed.tools.find((tool) => tool.id === "trufflehog")?.command ?? "", /filesystem/);
  assert.deepEqual(passed.tools.find((tool) => tool.id === "trivy")?.scanners, ["vuln", "misconfig", "secret"]);
  const dirty = tempProject();
  const secret = "supersecretvalue99";
  fs.writeFileSync(path.join(dirty, "leak.js"), `const password = "${secret}";\n`);
  const failed = scanner.scanBlocking({ missionId: "msn", ticketRef: "1.1", worktree: dirty, root: dirty });
  assert.equal(failed.status, "FAIL");
  assert.equal(JSON.stringify(failed).includes(secret), false);
  assert.ok(failed.findings.some((finding) => finding.tool === "semgrep"));
});

test("nfr measurements come from the process and missing evidence does not pass", () => {
  const parsed = nfrFromText("P95 latency < 200ms");
  assert.equal(parsed[0]?.target, 200);
  assert.equal(parsed[0]?.operator, "<");
  assert.equal(parsed[0]?.verificationMethod, "");
  const { root, plane, id } = planeAt();
  const unmeasured = plane.measureNfr(id);
  assert.equal(unmeasured.status, "NOT_RUN");
  assert.notEqual(plane.releaseGate(id).criteria.find((item) => item.id === "nfr")?.state, "pass");
  const method = JSON.stringify(["node", "-e", "const s=process.hrtime.bigint(); let n=0; for (let i=0;i<20000;i++) n+=i; console.log('BMAD-NFR-VALUE: '+(Number(process.hrtime.bigint()-s)/1e6));"]);
  const requirement: NfrRequirement = { id: "NFR-001", category: "performance", metric: "startup", operator: "<", target: 3000, unit: "ms", verificationMethod: method };
  plane.declareNfr(id, requirement);
  const measured = new CommandNfrProvider(processRunner).measureBlocking({ missionId: id, ticketRef: "1.1", worktree: root, requirement });
  assert.equal(measured.result, "PASS");
  assert.ok((measured.measured ?? 0) > 0);
  assert.ok((measured.measured ?? 99999) < 3000);
  const tooTight = { ...requirement, id: "NFR-002", target: 0 };
  const failed = new CommandNfrProvider(processRunner).measureBlocking({ missionId: id, ticketRef: "1.1", worktree: root, requirement: tooTight });
  assert.equal(failed.result, "FAIL");
  const unavailable = new BmadControlPlane(root, { nfr: new DeterministicNfr(["unavailable"]) });
  unavailable.declareNfr(id, requirement);
  assert.equal(unavailable.measureNfr(id).status, "NOT_CONFIGURED");
  assert.equal(unavailable.mission(id).lastVerifiedBuild, null);
});

test("architecture verification compares the repository and ignores a markdown file", () => {
  const { plane, id, root } = planeAt();
  fs.writeFileSync(path.join(root, "architecture.md"), "# declared\n");
  assert.equal(plane.verifyArchitecture(id).status, "BLOCKED");
  assert.equal(plane.releaseGate(id).criteria.find((item) => item.id === "architecture")?.state, "blocked");
  plane.declareArchitecture(id, { id: "CMP-1", kind: "component", choice: "src/missing.js", alternatives: [] });
  assert.equal(plane.verifyArchitecture(id).status, "FAIL");
  assert.equal(plane.releaseGate(id).criteria.find((item) => item.id === "architecture")?.state, "fail");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "health.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", dependencies: { "left-pad": "1.0.0" } }));
  const current = plane.mission(id);
  current.architecture = [
    { id: "CMP-1", kind: "component", choice: "src/health.js", alternatives: [] },
    { id: "TECH-1", kind: "technology", choice: "node", alternatives: [] },
  ];
  fs.writeFileSync(path.join(root, ".bmad-next", "missions", id, "mission.json"), JSON.stringify(current, null, 2));
  assert.equal(plane.verifyArchitecture(id).status, "PASS");
  plane.declareArchitecture(id, { id: "FORB-1", kind: "forbidden", choice: "left-pad", alternatives: [] });
  assert.equal(plane.verifyArchitecture(id).status, "FAIL");
  const html = renderMissionControl(plane.mission(id));
  assert.match(html, /Drift/);
});

test("traceability treats a requirement without a ticket as a gap", () => {
  const { plane, id } = planeAt();
  answerAll(plane, id);
  plane.answerForge(id, "harden");
  const gap = plane.verifyTraceability(id);
  assert.equal(gap.status, "FAIL");
  const body = JSON.parse(fs.readFileSync(gap.evidence, "utf8")) as { gaps: string[]; status: string };
  assert.deepEqual(body.gaps, ["REQ-001"]);
  assert.match(plane.releaseGate(id).criteria.find((item) => item.id === "traceability")?.detail ?? "", /TRACEABILITY GAP/);
});

test("historical failures are superseded only by a later pass of the same scope", () => {
  const { root, plane, id } = planeAt();
  record(plane, root, id, "unit", "fail");
  record(plane, root, id, "unit", "pass");
  const passed = evaluateRelease(plane.mission(id), fileExists);
  assert.equal(passed.criteria.find((item) => item.id === "unit")?.state, "pass");
  assert.equal(plane.mission(id).evidence.filter((item) => item.kind === "unit").length, 2);
  const matrix = releaseMatrix(plane.mission(id), fileExists);
  assert.equal(matrix.current.find((item) => item.id === "unit")?.state, "PASS");
  assert.equal(matrix.historical.some((item) => item.state === "SUPERSEDED"), true);
  record(plane, root, id, "unit", "fail", "REQ-002", "1.2");
  assert.equal(evaluateRelease(plane.mission(id), fileExists).criteria.find((item) => item.id === "unit")?.state, "fail");
  const laterRoot = tempProject();
  const later = new BmadControlPlane(laterRoot);
  const laterId = later.createMission("Build an expense-management SaaS.").id;
  record(later, laterRoot, laterId, "unit", "pass");
  record(later, laterRoot, laterId, "unit", "fail");
  assert.equal(evaluateRelease(later.mission(laterId), fileExists).criteria.find((item) => item.id === "unit")?.state, "fail");
});

test("approval is an explicit action, rejection stays, and casual text is ignored", () => {
  const { root, id } = planeAt();
  const plane = new BmadControlPlane(root);
  process.env.BMAD_RELEASE_APPROVED = "true";
  assert.equal(parseIntent("@bmad looks good").name, "unknown");
  plane.handleIntent("@bmad looks good", id);
  plane.handleIntent("@bmad approve release", id);
  assert.equal(plane.mission(id).approvals.length, 0);
  assert.equal(plane.releaseGate(id).criteria.find((item) => item.id === "human-release")?.state, "blocked");
  delete process.env.BMAD_RELEASE_APPROVED;
  plane.handleIntent("@bmad approve release by Ada", id);
  plane.rejectRelease(id, "Ada", "Not yet.");
  assert.equal(plane.mission(id).approvals.map((item) => item.decision).join(","), "approved,rejected");
  assert.equal(plane.releaseGate(id).criteria.find((item) => item.id === "human-release")?.state, "fail");
  plane.approve(id, "release", "Ada", "Evidence is complete.");
  assert.equal(plane.mission(id).approvals.length, 3);
  assert.equal(plane.releaseGate(id).criteria.find((item) => item.id === "human-release")?.state, "pass");
  const html = renderMissionControl(plane.mission(id));
  assert.match(html, /APPROVED/);
  assert.match(html, /rejected/);
  assert.match(html, /release approve/);
});

test("production code does not construct the deterministic security or nfr providers", () => {
  const sourceRoot = path.resolve(__dirname, "../..");
  const index = fs.readFileSync(path.join(sourceRoot, "src", "index.ts"), "utf8");
  const plane = fs.readFileSync(path.join(sourceRoot, "src", "plane.ts"), "utf8");
  assert.equal(index.includes("DeterministicSecurity"), false);
  assert.equal(index.includes("DeterministicNfr"), false);
  assert.equal(plane.includes("new DeterministicSecurity"), false);
  assert.equal(plane.includes("new DeterministicNfr"), false);
});
