import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ticketingCheck } from "../doctor";
import { BmadControlPlane, excludesVerification, testPackageDir } from "../plane";
import { BmadRunner } from "../skill-runner";
import { PREVIEW_MARKER, previewDir, startPreview, withPreview } from "../preview";
import { evaluateRelease, fileExists } from "../quality";
import { parsePlan } from "../verification-plan";
import type { CommandRunner } from "../types";

const TODO = "Build a simple todo web app with add, complete, delete, and local persistence.";

function tempProject(): string {
  const base = path.resolve(__dirname, "../../../../.tmp");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "flow-"));
}

function hardened(plane: BmadControlPlane, input = TODO): string {
  const id = plane.createMission(input).id;
  for (const answer of ["A person keeping a personal todo list.", "Todos survive a reload.", "No accounts or sync."]) {
    const mission = plane.mission(id);
    if (mission.forge?.questions.some((question) => !mission.forge?.answered.includes(question.id))) plane.answerForge(id, answer);
  }
  plane.answerForge(id, "harden");
  return id;
}

/** Model runner stand-in that writes what a real headless skill run would write, then prints its JSON. */
function skillWriter(root: string, files: Record<string, string>, stdout: string): CommandRunner {
  return {
    which: (bin) => (bin === "fake-model" ? "/usr/local/bin/fake-model" : null),
    run: () => {
      for (const [file, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), body);
      }
      return { exitCode: 0, stdout, stderr: "", durationMs: 5, timedOut: false };
    },
  };
}

test("BMad 6.12 ticketing is detected from its skills instead of an obsolete tickets.py path", () => {
  const modern = tempProject();
  fs.mkdirSync(path.join(modern, "_bmad", "_config"), { recursive: true });
  fs.writeFileSync(path.join(modern, "_bmad", "_config", "manifest.yaml"), "installation:\n  version: 6.12.0\n");
  fs.writeFileSync(
    path.join(modern, "_bmad", "_config", "skill-manifest.csv"),
    'canonicalId,name,description,module,path\n"bmad-create-epics-and-stories","x","y","bmm","a/SKILL.md"\n"bmad-sprint-planning","x","y","bmm","b/SKILL.md"\n',
  );
  const found = ticketingCheck(modern);
  assert.equal(found.status, "available");
  assert.match(found.detail, /6\.12\.0/);
  assert.match(found.detail, /no tickets\.py/);
  assert.equal(ticketingCheck(tempProject()).status, "not-configured");
  const legacy = tempProject();
  fs.mkdirSync(path.join(legacy, "_bmad", "method", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "_bmad", "method", "scripts", "tickets.py"), "");
  assert.equal(ticketingCheck(legacy).status, "available");
});

test("the configured release human gate applies to medium missions, not only critical ones", () => {
  const root = tempProject();
  const plane = new BmadControlPlane(root);
  const gated = plane.createMission(TODO);
  assert.equal(gated.complexity, "medium");
  assert.deepEqual(gated.humanGates?.includes("release"), true);
  const criterion = evaluateRelease(gated, fileExists).criteria.find((item) => item.id === "human-release");
  assert.equal(criterion?.state, "blocked");
  assert.match(criterion?.detail ?? "", /release human gate/);
  plane.updateConfig({ humanGates: [] });
  const ungated = plane.createMission(TODO);
  assert.equal(evaluateRelease(ungated, fileExists).criteria.some((item) => item.id === "human-release"), false);
});

test("accepting the ticket tree completes the ticketing step so the next recommendation moves on", () => {
  const plane = new BmadControlPlane(tempProject());
  const id = hardened(plane);
  const before = plane.mission(id).workflow.map((step) => step.skillId);
  assert.ok(before.indexOf("bmad-architecture") > before.indexOf("bmad-prd"), "medium work declares architecture after the PRD");
  assert.ok(before.indexOf("bmad-architecture") < before.indexOf("bmad-preview-ticketing"));
  plane.stories(id);
  plane.acceptTicketTree(id, "Ada");
  const ticketing = plane.mission(id).workflow.find((step) => step.skillId === "bmad-preview-ticketing");
  assert.equal(ticketing?.status, "completed");
  assert.match(ticketing?.reason ?? "", /Ada/);
  assert.notEqual(plane.recommend(id).skillId, "bmad-preview-ticketing");
  assert.equal(plane.mission(id).workflow.find((step) => step.skillId === "bmad-build")?.status, "awaiting-model");
});

test("bmad-architecture declarations come only from a valid architecture.json", () => {
  const root = tempProject();
  const good = JSON.stringify({ declarations: [
    { id: "LAYER-1", kind: "layer", choice: "todo-app" },
    { id: "CMP-1", kind: "component", choice: "todo-app/index.html" },
    { id: "TECH-1", kind: "technology", choice: "node" },
  ] });
  const files = {
    [`_bmad-output/architecture/MID/ARCHITECTURE.md`]: "# Architecture",
    [`_bmad-output/architecture/MID/architecture.json`]: good,
  };
  let plane = new BmadControlPlane(root, { runner: skillWriter(root, {}, "") });
  plane.updateConfig({ runner: { command: "fake-model", args: ["{prompt}"] } });
  const id = hardened(plane);
  const real = Object.fromEntries(Object.entries(files).map(([file, body]) => [file.replace("MID", id), body]));
  const stdout = JSON.stringify({ status: "complete", files: Object.keys(real) });
  plane = new BmadControlPlane(root, { runner: skillWriter(root, real, stdout) });
  const mission = plane.runSkill(id, "bmad-architecture");
  assert.equal(mission.workflow.find((step) => step.skillId === "bmad-architecture")?.status, "completed");
  assert.deepEqual(mission.architecture.map((item) => `${item.kind}:${item.choice}`), ["layer:todo-app", "component:todo-app/index.html", "technology:node"]);
  const prompt = fs.readFileSync(path.join(root, ".bmad-next", "missions", id, "context", "bmad-architecture.md"), "utf8");
  assert.match(prompt, /architecture\.json/);
  assert.match(prompt, /Forge decisions:/);

  const badRoot = tempProject();
  let bad = new BmadControlPlane(badRoot, { runner: skillWriter(badRoot, {}, "") });
  bad.updateConfig({ runner: { command: "fake-model", args: ["{prompt}"] } });
  const badId = hardened(bad);
  const badFiles = {
    [`_bmad-output/architecture/${badId}/ARCHITECTURE.md`]: "# Architecture",
    [`_bmad-output/architecture/${badId}/architecture.json`]: JSON.stringify({ declarations: [{ kind: "database", choice: "PostgreSQL" }] }),
  };
  bad = new BmadControlPlane(badRoot, { runner: skillWriter(badRoot, badFiles, JSON.stringify({ status: "complete", files: Object.keys(badFiles) })) });
  const refused = bad.runSkill(badId, "bmad-architecture");
  assert.equal(refused.workflow.find((step) => step.skillId === "bmad-architecture")?.status, "blocked");
  assert.equal(refused.architecture.length, 0);
});

test("tests run in the package that contains the change, not the monorepo root", () => {
  const root = tempProject();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test harness" } }));
  fs.mkdirSync(path.join(root, "todo-app"), { recursive: true });
  fs.writeFileSync(path.join(root, "todo-app", "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  assert.equal(testPackageDir(root, ["todo-app/index.html", "todo-app/app.test.js"]), path.join(root, "todo-app"));
  assert.equal(testPackageDir(root, ["todo-app/"]), path.join(root, "todo-app"));
  assert.equal(testPackageDir(root, ["todo-app/index.html", "README.md"]), root);
  fs.mkdirSync(path.join(root, "loose"), { recursive: true });
  assert.equal(testPackageDir(root, ["loose/app.js"]), root);
});

test("verification plans stay on the preview origin and only measurable NFRs are kept", () => {
  const plan = {
    status: "complete",
    browser: {
      name: "todo round trip",
      steps: [
        { action: "navigate", target: PREVIEW_MARKER, name: "open" },
        { action: "fill", target: "#new", value: "Buy milk" },
        { action: "click", target: "#add" },
        { action: "navigate", target: PREVIEW_MARKER, name: "reload" },
      ],
      assertions: [{ kind: "count", target: "li", expected: 1 }],
    },
    nfr: [
      { metric: "latency", operator: "<", target: 500, unit: "ms", source: "PRD" },
      { metric: "memory", operator: "<", target: 50, unit: "mb" },
    ],
  };
  const parsed = parsePlan(`I will navigate to {preview} and click {add}. Here you go:\n${JSON.stringify(plan)}`, "REQ-001");
  assert.ok(typeof parsed !== "string", String(parsed));
  assert.equal(parsed.scenario.id, "BROWSER-REQ-001");
  assert.equal(parsed.scenario.assertions[0]?.expected, "1");
  assert.equal(parsed.nfr.length, 1);
  assert.match(parsed.nfr[0]?.verificationMethod ?? "", /\{preview\}/);
  const external = structuredClone(plan);
  external.browser.steps[0] = { action: "navigate", target: "https://example.com/", name: "open" };
  assert.match(String(parsePlan(JSON.stringify(external), "REQ-001")), /must stay on/);
  const noAssertions = structuredClone(plan);
  noAssertions.browser.assertions = [];
  assert.match(String(parsePlan(JSON.stringify(noAssertions), "REQ-001")), /no assertions/);
  assert.match(String(parsePlan("I think it works.", "REQ-001")), /not a JSON object/);
  assert.match(String(parsePlan(JSON.stringify({ ...plan, status: "blocked" }), "REQ-001")), /not complete/);
});

test("the preview server serves the app directory and nothing outside it", async () => {
  const root = tempProject();
  const app = path.join(root, "todo-app");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, "index.html"), "<h1>Todos</h1>");
  fs.writeFileSync(path.join(root, "secret.txt"), "outside");
  assert.equal(previewDir(root, ["todo-app"], []), app);
  assert.equal(previewDir(root, [], ["todo-app/index.html"]), app);
  assert.equal(previewDir(root, ["missing"], ["README.md"]), null);
  const server = startPreview(app);
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Todos/);
    const escaped = await fetch(`${server.url}..%2Fsecret.txt`);
    assert.notEqual(escaped.status, 200);
    assert.equal(withPreview(`${PREVIEW_MARKER}/about`, server.url), `${server.url}about`);
  } finally {
    server.stop();
  }
});

test("a headless skill completes from the final contract object after runner narration, and prose alone does not", () => {
  const root = tempProject();
  let plane = new BmadControlPlane(root, { runner: skillWriter(root, {}, "") });
  plane.updateConfig({ runner: { command: "fake-model", args: ["{prompt}"] } });
  const id = hardened(plane);
  const files = { [`_bmad-output/specs/${id}/SPEC.md`]: "# Spec", [`_bmad-output/specs/${id}/.memlog.md`]: "- decided" };
  const narration = `We need to read the skill. {"note":"thinking"}\n\u001b[0mWrote file.\nReturn JSON.${JSON.stringify({ status: "complete", files: Object.keys(files) })}\n`;
  plane = new BmadControlPlane(root, { runner: skillWriter(root, files, narration) });
  assert.equal(plane.runSkill(id, "bmad-spec").workflow.find((step) => step.skillId === "bmad-spec")?.status, "completed");

  const proseRoot = tempProject();
  let prose = new BmadControlPlane(proseRoot, { runner: skillWriter(proseRoot, {}, "") });
  prose.updateConfig({ runner: { command: "fake-model", args: ["{prompt}"] } });
  const proseId = hardened(prose);
  prose = new BmadControlPlane(proseRoot, { runner: skillWriter(proseRoot, {}, "The spec is complete and written.") });
  const step = prose.runSkill(proseId, "bmad-spec").workflow.find((item) => item.skillId === "bmad-spec");
  assert.equal(step?.status, "blocked");
  assert.match(step?.reason ?? "", /^output-invalid: Headless skill output is not the JSON contract/);
});

test("reviewer label synonyms and empty low placeholders do not turn a real FAIL into BLOCKED", async () => {
  const { judgeReview } = await import("../reviewer");
  const { judgeAttack } = await import("../attack");
  const criterion = "The user can add a todo and it survives a reload.";
  const context = {
    missionId: "m", missionTitle: "todo", ticketRef: "1.1", ticketTitle: "todo",
    requirements: [{ id: "REQ-001", title: "todo", acceptanceCriteria: [criterion] }],
    architecture: [], worktree: "/tmp/w", baseCommit: "a", headCommit: "b", changedFiles: ["todo/lib/todo.js"], diff: "+x", testEvidence: null,
  };
  const reply = (findings: unknown[]) => "```json\n" + JSON.stringify({
    status: "FAIL",
    summary: "Persistence breaks on reload.",
    findings,
    criteria: [{ requirementId: "REQ-001", criterion, status: "FAIL" }],
    tests: { coversChangedBehavior: "FAIL", wouldCatchRegression: "FAIL", edgeCases: "PASS" },
  }) + "\n```";
  const observed = [
    { severity: "high", category: "correctness", message: "Saved shape differs from the loaded shape.", file: "todo/lib/todo.js" },
    { severity: "medium", category: "error handling", message: "Storage errors are swallowed." },
    { severity: "medium", category: "testing", message: "Tests do not exercise the browser path." },
    { severity: "low", category: "architecture", message: null, file: null },
  ];
  const judged = judgeReview({ raw: reply(observed), processStatus: "completed", exitCode: 0, context, reviewerId: "opencode", model: "m", durationMs: 1, prompt: "p" });
  assert.equal(judged.status, "FAIL");
  assert.deepEqual(judged.findings.map((item) => item.category), ["correctness", "correctness", "tests"]);
  assert.match(judged.rawOutput ?? "", /error handling/);
  const hiddenHigh = judgeReview({ raw: reply([{ severity: "high", category: "security", message: "" }]), processStatus: "completed", exitCode: 0, context, reviewerId: "opencode", model: "m", durationMs: 1, prompt: "p" });
  assert.equal(hiddenHigh.status, "BLOCKED");
  const oddSeverity = judgeReview({ raw: reply([{ severity: "urgent-ish", category: "tests", message: "x" }]), processStatus: "completed", exitCode: 0, context, reviewerId: "opencode", model: "m", durationMs: 1, prompt: "p" });
  assert.equal(oddSeverity.status, "BLOCKED");
  const attack = judgeAttack({ raw: JSON.stringify({ status: "FAIL", summary: "x", findings: [{ severity: "Major", category: "Error Handling", message: "Crash on empty input." }, { severity: "info", category: "x", message: null }] }), processStatus: "completed", exitCode: 0, attackerId: "opencode", model: "m", durationMs: 1, prompt: "p" });
  assert.equal(attack.status, "FAIL");
  assert.equal(attack.findings.length, 1);
  assert.equal(attack.findings[0]?.severity, "high");
});

test("a failing unit run is a repair source even when the review itself was blocked", () => {
  const root = tempProject();
  const plane = new BmadControlPlane(root);
  const id = hardened(plane);
  plane.acceptTicketTree(id, "Ada");
  const log = path.join(root, "unit.log");
  fs.writeFileSync(log, "✖ persistence survives reload\n  AssertionError: 0 !== 1\n");
  plane.recordEvidence(id, { requirement_id: "REQ-001", story_id: "1.1", result: "fail", kind: "unit", runner: "process", started_at: "2026-09-26T00:00:00.000Z", finished_at: "2026-09-26T00:00:01.000Z", exit_code: 1, command: "npm test (in todo)", artifact: log });
  const source = (plane as unknown as { repairSource(mission: unknown, ref: string): { source: string; findings: Array<{ message: string }> } | null }).repairSource(plane.mission(id), "1.1");
  assert.equal(source?.source, "tests");
  assert.match(source?.findings[0]?.message ?? "", /AssertionError: 0 !== 1/);
});

test("reviewer and attacker replies are read from the final object after narration that contains braces", async () => {
  const { judgeAttack } = await import("../attack");
  const narration = "Let's read todo.js. It does `const state = { todos: [] }` and calls save({ ok: true }).\nNow the report:\n";
  const report = { status: "FAIL", summary: "Input is not validated.", findings: [{ id: "ATT-001", severity: "high", category: "correctness", message: "Empty todos are accepted.", file: "todo/todo.js", line: 8 }] };
  const judged = judgeAttack({ raw: narration + JSON.stringify(report), processStatus: "completed", exitCode: 0, attackerId: "opencode", model: "m", durationMs: 1, prompt: "p" });
  assert.equal(judged.status, "FAIL");
  assert.equal(judged.findings[0]?.id, "ATT-001");
  const truncated = judgeAttack({ raw: narration + JSON.stringify(report).slice(0, -1), processStatus: "completed", exitCode: 0, attackerId: "opencode", model: "m", durationMs: 1, prompt: "p" });
  assert.equal(truncated.status, "BLOCKED");
});

test("a failed attempt does not strand the loop, and a passing release walks it to released", () => {
  const root = tempProject();
  const plane = new BmadControlPlane(root);
  plane.updateConfig({ humanGates: [] });
  const id = hardened(plane);
  plane.acceptTicketTree(id, "Ada");
  const stuck = plane.mission(id);
  stuck.loop = "failed";
  saveMissionAt(root, stuck);
  const walker = plane as unknown as { reenterLoop(mission: unknown): void; walkLoop(mission: unknown, target: string): void };
  const mission = plane.mission(id);
  walker.reenterLoop(mission);
  assert.equal(mission.loop, "running");
  walker.walkLoop(mission, "released");
  assert.equal(mission.loop, "released");
  const failed = plane.mission(id);
  failed.loop = "failed";
  walker.walkLoop(failed, "released");
  assert.equal(failed.loop, "released");
});

function saveMissionAt(root: string, mission: ReturnType<BmadControlPlane["mission"]>): void {
  fs.writeFileSync(path.join(root, ".bmad-next", "missions", mission.id, "mission.json"), JSON.stringify(mission));
}

test("a spec still completes when JSON names a typo path but the required SPEC.md exists", () => {
  const root = tempProject();
  const id = "msn_1_deadbeef";
  const spec = path.join(root, "_bmad-output", "specs", id, "SPEC.md");
  const memlog = path.join(root, "_bmad-output", "specs", id, ".memlog.md");
  fs.mkdirSync(path.dirname(spec), { recursive: true });
  fs.writeFileSync(spec, "# Spec\n");
  fs.writeFileSync(memlog, "# log\n");
  const skills = new BmadRunner({ which: () => null, run: () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false }) }, root);
  const typedWrong = JSON.stringify({ status: "complete", files: [`_bmad-output/specs/msn_deadbeef/SPEC.md`, `_bmad-output/specs/msn_deadbeef/.memlog.md`] });
  const accepted = skills.validateSkillOutput("bmad-spec", typedWrong, 0, false, id);
  assert.equal(accepted.status, "completed");
  assert.ok(accepted.files.some((file) => file.endsWith("SPEC.md") && fs.existsSync(file)));
  const missing = skills.validateSkillOutput("bmad-spec", typedWrong, 0, false, "msn_1_other");
  assert.equal(missing.status, "missing-artifact");
});

test("a planning skill that writes application code outside _bmad-output is blocked and its new files are quarantined", () => {
  const root = tempProject();
  const git = (args: string[]) => require("node:child_process").spawnSync("git", args, { cwd: root, encoding: "utf8" });
  git(["init", "-q"]);
  fs.writeFileSync(path.join(root, "keep.txt"), "user work in progress");
  let plane = new BmadControlPlane(root);
  plane.updateConfig({ runner: { command: "fake-model", args: ["{prompt}"] } });
  const id = hardened(plane);
  const files = {
    [`_bmad-output/project-context/${id}/project-context.md`]: "# Context",
    "todo-app/index.html": "<h1>app</h1>",
  };
  const stdout = JSON.stringify({ status: "complete", files: [`_bmad-output/project-context/${id}/project-context.md`] });
  const writer = skillWriter(root, files, stdout);
  const runner: CommandRunner = { which: writer.which, run: (command, args, cwd, timeout, env) => (command === "git" ? require("../runner").processRunner.run(command, args, cwd, timeout, env) : writer.run(command, args, cwd, timeout, env)) };
  plane = new BmadControlPlane(root, { runner });
  const mission = plane.runSkill(id, "bmad-project-context");
  const artifact = mission.artifacts.filter((item) => item.skillId === "bmad-project-context").at(-1);
  assert.equal(artifact?.state, "invalid");
  const provenance = JSON.parse(fs.readFileSync(path.join(root, ".bmad-next", "missions", id, "artifacts", "bmad-project-context.provenance.json"), "utf8")) as { status: string; reason: string };
  assert.equal(provenance.status, "output-invalid");
  assert.match(provenance.reason, /outside _bmad-output: todo-app\/index\.html/);
  assert.equal(fs.existsSync(path.join(root, "todo-app")), false);
  assert.equal(fs.existsSync(path.join(root, ".bmad-next", "missions", id, "quarantine", "bmad-project-context", "todo-app", "index.html")), true);
  assert.equal(fs.readFileSync(path.join(root, "keep.txt"), "utf8"), "user work in progress");
});

test("the autopilot waits for forge answers, blocks honestly without a runner, and honours a stop request", async () => {
  const root = tempProject();
  const plane = new BmadControlPlane(root);
  const id = plane.createMission(TODO).id;
  const lines: string[] = [];
  const waiting = await plane.autopilot(id, { log: (line) => lines.push(line) });
  assert.equal(waiting.status, "needs-forge-answers");
  for (const answer of ["A person keeping a todo list.", "Todos survive a reload.", "No accounts."]) plane.answerForge(id, answer);
  const blocked = await plane.autopilot(id);
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.reason, /bmad-spec did not complete/);
  assert.equal(plane.mission(id).forge?.outcome, "hardened");
  assert.equal(plane.mission(id).workflow.find((step) => step.skillId === "bmad-spec")?.status, "not-configured");
  const stopped = await plane.autopilot(id, { stopRequested: () => true });
  assert.equal(stopped.status, "stopped");
  assert.ok(lines.some((line) => /needs-forge-answers/.test(line)));
});

test("the autopilot's forge step records model answers as assumptions and hardens only when every question has one", () => {
  const root = tempProject();
  const reply = JSON.stringify({ answers: [
    { id: "users", answer: "A person keeping a personal todo list." },
    { id: "success", answer: "Todos added, completed, and deleted survive a reload." },
    { id: "non-goals", answer: "No accounts, backend, or sync." },
  ] });
  let plane = new BmadControlPlane(root, { runner: skillWriter(root, {}, "") });
  plane.updateConfig({ runner: { command: "fake-model", args: ["{prompt}"] } });
  const id = plane.createMission(TODO).id;
  plane = new BmadControlPlane(root, { runner: skillWriter(root, {}, `Thinking about {users}...\n${reply}`) });
  const proposed = plane.proposeForgeAnswers(id);
  assert.equal(proposed.status, "answered");
  const forgeEvents = plane.events(id).filter((event) => event.data.skillId === "bmad-forge-idea").map((event) => event.type);
  assert.deepEqual(forgeEvents, ["SkillStarted", "SkillCompleted"]);
  const locks = plane.mission(id).forge?.locks ?? [];
  assert.deepEqual(locks.map((lock) => `${lock.key}:${lock.kind}:${lock.source}`), ["users:assumption:model", "success:assumption:model", "non-goals:assumption:model"]);
  plane.answerForge(id, "harden");
  assert.deepEqual(plane.mission(id).requirements[0]?.acceptance_criteria, ["Todos added, completed, and deleted survive a reload."]);
  const partialRoot = tempProject();
  let partial = new BmadControlPlane(partialRoot, { runner: skillWriter(partialRoot, {}, "") });
  partial.updateConfig({ runner: { command: "fake-model", args: ["{prompt}"] } });
  const partialId = partial.createMission(TODO).id;
  partial = new BmadControlPlane(partialRoot, { runner: skillWriter(partialRoot, {}, JSON.stringify({ answers: [{ id: "users", answer: "Someone." }] })) });
  assert.equal(partial.proposeForgeAnswers(partialId).status, "blocked");
  assert.equal(partial.mission(partialId).forge?.outcome, "active");
});

test("gates that have not run read as pending, and the project can require every gate", async () => {
  const { gateLabel, criterionLabel } = await import("../render");
  const root = tempProject();
  const plane = new BmadControlPlane(root);
  const id = hardened(plane);
  const report = evaluateRelease(plane.mission(id), fileExists);
  assert.equal(report.state, "blocked");
  assert.match(gateLabel(report), /^IN PROGRESS/);
  assert.equal(criterionLabel(report.criteria.find((item) => item.id === "unit") ?? { id: "unit", state: "blocked" }), "not run yet");
  assert.equal(criterionLabel(report.criteria.find((item) => item.id === "human-release") ?? { id: "", state: "" }), "waiting for approval");
  assert.equal(report.criteria.some((item) => item.id === "browser"), false);
  assert.throws(() => plane.requireEvidence(id, ["browser"], ""), /needs a person/);
  assert.throws(() => plane.requireEvidence(id, ["vibes"], "Ada"), /Unknown evidence/);
  const strict = plane.requireEvidence(id, ["unit", "review", "attack", "browser", "security", "nfr"], "Ada");
  const kinds = evaluateRelease(strict, fileExists).criteria.map((item) => item.id);
  for (const kind of ["attack", "browser", "security", "nfr"]) assert.ok(kinds.includes(kind), kind);
  plane.updateConfig({ requiredEvidence: ["security"] });
  assert.deepEqual(plane.createMission(TODO).requiredEvidence, ["security"]);
  const failed = plane.mission(id);
  const log = path.join(root, "unit.log");
  fs.writeFileSync(log, "fail");
  plane.recordEvidence(id, { requirement_id: "REQ-001", story_id: "1.1", result: "fail", kind: "unit", runner: "process", started_at: "2026-09-26T00:00:00.000Z", finished_at: "2026-09-26T00:00:01.000Z", exit_code: 1, command: "npm test", artifact: log });
  assert.equal(gateLabel(evaluateRelease(plane.mission(failed.id), fileExists)), "FAIL");
});

test("an UNCLEAR review stays blocked but becomes a concrete repair task instead of a dead end", async () => {
  const { judgeReview } = await import("../reviewer");
  const criterion = "Todos survive a reload.";
  const context = {
    missionId: "m", missionTitle: "todo", ticketRef: "1.1", ticketTitle: "todo",
    requirements: [{ id: "REQ-001", title: "todo", acceptanceCriteria: [criterion] }],
    architecture: [], worktree: "/tmp/w", baseCommit: "a", headCommit: "b", changedFiles: ["a.js"], diff: "+x", testEvidence: null,
  };
  const raw = JSON.stringify({ status: "PASS", summary: "Criteria met; edge cases untested.", findings: [], criteria: [{ requirementId: "REQ-001", criterion, status: "PASS" }], tests: { coversChangedBehavior: "PASS", wouldCatchRegression: "PASS", edgeCases: "UNCLEAR" } });
  const judged = judgeReview({ raw, processStatus: "completed", exitCode: 0, context, reviewerId: "opencode", model: "m", durationMs: 1, prompt: "p" });
  assert.equal(judged.status, "BLOCKED");
  assert.deepEqual(judged.unclear, ["tests.edgeCases"]);
  const confirmed = judgeReview({
    raw,
    processStatus: "completed",
    exitCode: 0,
    context: { ...context, testEvidence: { result: "pass", exitCode: 0, command: "npm test", edgeCases: "present" } },
    reviewerId: "opencode",
    model: "m",
    durationMs: 1,
    prompt: "p",
  });
  assert.equal(confirmed.status, "PASS");
  const root = tempProject();
  const plane = new BmadControlPlane(root);
  const id = hardened(plane);
  plane.acceptTicketTree(id, "Ada");
  const mission = plane.mission(id);
  mission.reviews = [{ attempt: 1, ticketRef: "1.1", reviewer: "opencode", model: "m", runtime: "opencode", status: "BLOCKED", findings: [], criteria: [], architectureDrift: [], summary: "Edge cases untested.\nstatus: blocked", unclear: ["tests.edgeCases"], durationMs: 1, modelCost: null, falsePositiveFeedback: 0, repairSuccess: 0, promptVersion: "v", promptHash: "h", baseCommit: "a", headCommit: "a", worktree: "/tmp/w", changedFiles: [], evidencePath: "/tmp/review.json", startedAt: "2026-09-26T00:00:00.000Z", endedAt: "2026-09-26T00:00:01.000Z", exitCode: 0, diffFingerprint: "f", duplicateDiff: false } as never];
  fs.writeFileSync(path.join(root, ".bmad-next", "missions", id, "mission.json"), JSON.stringify(mission));
  const source = (plane as unknown as { repairSource(mission: unknown, ref: string): { source: string; findings: Array<{ id: string; message: string }> } | null }).repairSource(plane.mission(id), "1.1");
  assert.equal(source?.source, "review");
  assert.equal(source?.findings.at(-1)?.id, "REV-UNCLEAR");
  assert.match(source?.findings.at(-1)?.message ?? "", /could not confirm tests\.edgeCases/);
});

test("architecture verification reads a nested layer's package.json for declared technologies", async () => {
  const { verifyArchitectureTree } = await import("../architecture-check");
  const root = tempProject();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { typescript: "5" } }));
  fs.mkdirSync(path.join(root, "src", "todo"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "todo", "index.html"), "<ul></ul>");
  fs.writeFileSync(path.join(root, "src", "todo", "package.json"), JSON.stringify({ devDependencies: { "left-pad": "1" } }));
  const declared = [
    { id: "L", kind: "layer", choice: "src/todo", alternatives: [] },
    { id: "C", kind: "component", choice: "src/todo/index.html", alternatives: [] },
    { id: "T", kind: "technology", choice: "left-pad", alternatives: [] },
  ];
  assert.equal(verifyArchitectureTree({ root, declared, timestamp: "t" }).status, "PASS");
  const forbidden = verifyArchitectureTree({ root, declared: [...declared, { id: "F", kind: "forbidden", choice: "left-pad", alternatives: [] }], timestamp: "t" });
  assert.equal(forbidden.status, "FAIL");
  assert.ok(forbidden.violations.some((item) => item.code === "FORBIDDEN_DEPENDENCY"));
});

test("tickets route to building agents by real words, and human decisions need a name", async () => {
  const { routeAgent, DEFAULT_AGENTS } = await import("../collaboration");
  const builders = DEFAULT_AGENTS.filter((agent) => agent.skills.includes("bmad-build"));
  const text = "Build a simple todo web app with add, complete, delete, and local persistence. A person who needs to manage tasks.";
  assert.notEqual(routeAgent(DEFAULT_AGENTS, text, "medium").agent?.name, "Architect");
  assert.ok(routeAgent(builders, text, "medium").agent === null || routeAgent(builders, text, "medium").agent?.skills.includes("bmad-build"));
  assert.equal(routeAgent(builders, "Add a frontend component with css", "medium").agent?.name, "Frontend Developer");
  const plane = new BmadControlPlane(tempProject());
  const id = hardened(plane);
  assert.throws(() => plane.acceptTicketTree(id, ".."), /needs a person's name/);
  assert.throws(() => plane.approve(id, "release", "  - ", "ok"), /needs a person's name/);
  assert.equal(plane.acceptTicketTree(id, "Ada").ticketTreeAccepted, true);
});

test("forge answers numbered 1..n map to the open questions in order; partial numbering does not", () => {
  const root = tempProject();
  let plane = new BmadControlPlane(root, { runner: skillWriter(root, {}, "") });
  plane.updateConfig({ runner: { command: "fake-model", args: ["{prompt}"] } });
  const id = plane.createMission(TODO).id;
  const numbered = JSON.stringify({ answers: [{ id: "1", answer: "A person with a todo list." }, { id: "2", answer: "Todos survive a reload." }, { id: "3", answer: "No accounts." }] });
  plane = new BmadControlPlane(root, { runner: skillWriter(root, {}, `Need ids? Use 1,2,3.${numbered}`) });
  assert.equal(plane.proposeForgeAnswers(id).status, "answered");
  assert.deepEqual(plane.mission(id).forge?.locks.map((lock) => `${lock.key}=${lock.text}`), ["users=A person with a todo list.", "success=Todos survive a reload.", "non-goals=No accounts."]);
  const otherRoot = tempProject();
  let other = new BmadControlPlane(otherRoot, { runner: skillWriter(otherRoot, {}, "") });
  other.updateConfig({ runner: { command: "fake-model", args: ["{prompt}"] } });
  const otherId = other.createMission(TODO).id;
  other = new BmadControlPlane(otherRoot, { runner: skillWriter(otherRoot, {}, JSON.stringify({ answers: [{ id: "1", answer: "x" }, { id: "3", answer: "y" }] })) });
  assert.equal(other.proposeForgeAnswers(otherId).status, "blocked");
  const prompt = fs.readdirSync(path.join(otherRoot, ".bmad-next", "missions", otherId)).length > 0;
  assert.ok(prompt);
});

test("stray-write attribution uses the runner's tool log, so a person's edits during a skill run do not block it", async () => {
  const { runnerWrites } = await import("../plane");
  const root = "/repo";
  const log = "\u001b[0m> build · model\n\u001b[0m✱ \u001b[0mGlob \"x\"\n\u001b[0m← \u001b[0mWrite _bmad-output/specs/m/SPEC.md\nWrote file successfully.\n\u001b[0m← \u001b[0mEdit /repo/todo-app/index.html\n";
  assert.deepEqual([...(runnerWrites(log, root) ?? [])], ["_bmad-output/specs/m/SPEC.md", "todo-app/index.html"]);
  assert.equal(runnerWrites("plain stdout without a tool log", root), null);
  const repo = tempProject();
  require("node:child_process").spawnSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "notes.md"), "mine");
  let plane = new BmadControlPlane(repo);
  plane.updateConfig({ runner: { command: "fake-model", args: ["{prompt}"] } });
  const id = hardened(plane);
  const spec = { [`_bmad-output/specs/${id}/SPEC.md`]: "# Spec", [`_bmad-output/specs/${id}/.memlog.md`]: "- d" };
  const writer: CommandRunner = {
    which: (bin) => (bin === "fake-model" ? "/bin/fake-model" : require("../runner").processRunner.which(bin)),
    run: (command, args, cwd, timeout, env) => {
      if (command === "git") return require("../runner").processRunner.run(command, args, cwd, timeout, env);
      for (const [file, body] of Object.entries(spec)) {
        fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
        fs.writeFileSync(path.join(repo, file), body);
      }
      fs.writeFileSync(path.join(repo, "notes.md"), "edited by a person meanwhile");
      return { exitCode: 0, stdout: JSON.stringify({ status: "complete", files: Object.keys(spec) }), stderr: `← Write _bmad-output/specs/${id}/SPEC.md\n`, durationMs: 1, timedOut: false };
    },
  };
  plane = new BmadControlPlane(repo, { runner: writer });
  const mission = plane.runSkill(id, "bmad-spec");
  assert.equal(mission.workflow.find((step) => step.skillId === "bmad-spec")?.status, "completed");
  assert.equal(fs.readFileSync(path.join(repo, "notes.md"), "utf8"), "edited by a person meanwhile");
  assert.ok(plane.events(id).some((event) => event.type === "FindingCreated" && event.data.code === "WORKTREE_CHANGED_DURING_SKILL"));
});

test("a repair gets the failing tests by name, assertion, and location, not only the tail of the log", async () => {
  const { failingTestSummary } = await import("../quality");
  const log = [
    "\u001b[32m✔ add (0.8ms)\u001b[39m",
    "✖ toggle (0.6ms)",
    "✖ delete (0.1ms)",
    "ℹ tests 4",
    "✖ failing tests:",
    "",
    "test at todo.test.js:23:1",
    "✖ toggle (0.61875ms)",
    "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
    "  false !== true",
    "      at TestContext.<anonymous> (/repo/webapp/todo.test.js:27:10)",
    "      at Test.runInAsyncScope (node:async_hooks:226:14)",
    "test at todo.test.js:34:1",
    "✖ delete (0.13ms)",
    "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
    "  'keep' !== 'remove'",
    "      at TestContext.<anonymous> (/repo/webapp/todo.test.js:40:10)",
  ].join("\n");
  const summary = failingTestSummary(log);
  assert.deepEqual(summary, [
    "✖ toggle — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: false !== true (webapp/todo.test.js:27)",
    "✖ delete — AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 'keep' !== 'remove' (webapp/todo.test.js:40)",
  ]);
  assert.deepEqual(failingTestSummary("ℹ tests 3\nℹ pass 3"), []);
});

test("a proposed non-goal may limit features but never scope out tests or verification", () => {
  assert.equal(excludesVerification("No server or backend, no authentication, no multi-user sync, no test coverage, no deployment pipeline."), true);
  assert.equal(excludesVerification("Skip code review and security scans."), true);
  assert.equal(excludesVerification("Without unit tests."), true);
  assert.equal(excludesVerification("No authentication, backend database, multi-user collaboration, cloud sync, notifications, or advanced task management."), false);
  assert.equal(excludesVerification("A person who wants a simple personal todo list and needs to quickly add, complete, delete, and preserve tasks."), false);
  assert.equal(excludesVerification("The user can add a todo, and the tests check that it persists."), false);
});

test("accepting an accepted ticket tree is a no-op that records nothing and saves nothing", () => {
  const root = fs.mkdtempSync(path.join(path.resolve(__dirname, "../../../../.tmp"), "accept-twice-"));
  const plane = new BmadControlPlane(root);
  const id = plane.createMission("Build a simple todo web app with add, complete, delete, and local persistence.").id;
  for (const answer of ["A person keeping a todo list.", "Todos survive a reload.", "No accounts."]) plane.answerForge(id, answer);
  plane.answerForge(id, "harden");
  plane.acceptTicketTree(id, "Ada Lovelace");
  const file = path.join(root, ".bmad-next", "missions", id, "mission.json");
  const before = fs.readFileSync(file, "utf8");
  const events = plane.events(id).length;
  plane.acceptTicketTree(id, "Grace Hopper");
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(plane.events(id).length, events);
});

test("the build prompt lists the files that must exist and forbids dependencies nothing installs", () => {
  const root = fs.mkdtempSync(path.join(path.resolve(__dirname, "../../../../.tmp"), "deliverables-"));
  const plane = new BmadControlPlane(root);
  const id = plane.createMission("Build a simple todo web app with add, complete, delete, and local persistence.").id;
  plane.declareArchitecture(id, { id: "LAYER-1", kind: "layer", choice: "webapp", alternatives: [] });
  plane.declareArchitecture(id, { id: "CMP-1", kind: "component", choice: "webapp/index.html", alternatives: [] });
  const context = (plane as unknown as { buildContext(mission: unknown): string }).buildContext(plane.mission(id));
  assert.match(context, /Do not stop until every one of these exists and npm test passes:/);
  assert.match(context, /- webapp\/index\.html \(the page the browser opens\)/);
  assert.match(context, /- webapp\/package\.json whose test script names test files that exist/);
  assert.match(context, /use only Node built-ins and plain browser JavaScript, with no dependencies/);
});

test("an autopilot lock left by a process that has exited does not block the next run", async () => {
  const { acquireAutopilotLock } = await import("../store");
  const root = fs.mkdtempSync(path.join(path.resolve(__dirname, "../../../../.tmp"), "lock-"));
  const lock = path.join(root, ".bmad-next", "missions", "m1", "autopilot.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, `${process.pid}\n${Date.now()}\n`);
  assert.equal(acquireAutopilotLock(root, "m1"), false, "a live owner keeps its lock");
  fs.writeFileSync(lock, `999999\n${Date.now()}\n`);
  assert.equal(acquireAutopilotLock(root, "m1"), true, "a dead owner's lock is taken over");
  assert.equal(fs.readFileSync(lock, "utf8").split("\n")[0], String(process.pid));
});
