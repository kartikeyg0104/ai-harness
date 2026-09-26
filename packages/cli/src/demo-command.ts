import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BmadControlPlane, demoDirectory, formatDemoReport, resetDemo, scenarioFromCriterion } from "@bmad-next/control-plane";

const IDEA = [
  "Build a local payroll health check for employees.",
  "Write CommonJS only. Do not set \"type\": \"module\".",
  "package.json must name the package payroll-health and its test script must be node --test.",
  "src/health.js must export health() returning { ok: true }.",
  "When src/health.js is the main module, listen on 127.0.0.1 port 18765 and respond to / and /health with the text healthy.",
  "src/health.test.js must load src/health.js with require, use node:test and node:assert/strict, and assert health().ok is true.",
  "Do not import expect, beforeAll, afterAll, before, or after.",
  "End src/health.js with the comment // BMAD-TICKET-STATUS: built",
].join(" ");

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "BMAD Next Demo",
      GIT_AUTHOR_EMAIL: "bmad-next-demo@example.com",
      GIT_COMMITTER_NAME: "BMAD Next Demo",
      GIT_COMMITTER_EMAIL: "bmad-next-demo@example.com",
    },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed.\n${result.stderr || result.stdout}`);
  }
}

function ensureWorkspace(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, ".git"))) git(dir, ["init"]);
  const readme = path.join(dir, "README.md");
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, "# BMAD Next demo\n\nThe coding runtime writes the payroll health check into a ticket worktree.\n");
    git(dir, ["add", "README.md"]);
    git(dir, ["commit", "-m", "Start the BMAD Next demo workspace."]);
  }
}

function requireRuntime(): { runtime: string; model: string } {
  const runtime = (process.env.BMAD_RUNTIME ?? "").trim();
  const model = (process.env.BMAD_MODEL ?? "").trim();
  if (!runtime || !model) {
    throw new Error("Demo run needs BMAD_RUNTIME and BMAD_MODEL. Example: BMAD_RUNTIME=opencode BMAD_MODEL=nvidia/openai/gpt-oss-20b");
  }
  return { runtime, model };
}

function configureLocalReview(plane: BmadControlPlane, model: string): void {
  if ((process.env.BMAD_RUNTIME ?? "").trim() !== "opencode") return;
  const reviewArgs = ["run", "--pure", "--auto", "--format", "default", "--model", model, "{prompt}"];
  const patch: { reviewer?: { command: string; args: string[]; timeoutMs: number; model: string }; attacker?: { command: string; args: string[]; timeoutMs: number; model: string }; retryBudget: number } = {
    retryBudget: 2,
  };
  if (!(process.env.BMAD_REVIEWER_RUNNER ?? "").trim()) {
    patch.reviewer = { command: "opencode", args: reviewArgs, timeoutMs: 180000, model };
  }
  if (!(process.env.BMAD_ATTACK_RUNNER ?? "").trim()) {
    patch.attacker = { command: "opencode", args: reviewArgs, timeoutMs: 180000, model };
  }
  plane.updateConfig(patch);
}

function stop(missionId: string, cause: string, evidence: string): never {
  process.stderr.write(`STOP\nMission: ${missionId}\nFailure: ${cause}\nEvidence: ${evidence}\nSuggested fix: read the artifact, then run bmad-next repair from the demo workspace or start bmad-next demo fresh.\n`);
  throw new Error(cause);
}

function latestEvidence(plane: BmadControlPlane, id: string, kind: string): { result: string; artifact: string } | undefined {
  const record = [...plane.mission(id).evidence].reverse().find((item) => item.kind === kind);
  return record ? { result: record.result, artifact: record.artifact ?? "none" } : undefined;
}

async function runPipeline(plane: BmadControlPlane, id: string): Promise<void> {
  const { model } = requireRuntime();
  configureLocalReview(plane, model);
  let mission = plane.mission(id);
  const open = mission.forge?.questions.filter((question) => !mission.forge?.answered.includes(question.id)) ?? [];
  for (const question of open) {
    if (question.id === "success") plane.answerForge(id, 'The page shows "healthy".');
    else if (question.id === "non-goals") plane.answerForge(id, "No login, no database, and no payment provider.");
    else plane.answerForge(id, "employees of one company");
  }
  mission = plane.mission(id);
  if (mission.forge && mission.forge.outcome !== "hardened") plane.answerForge(id, "harden");
  plane.stories(id);
  if (plane.mission(id).tickets.length === 0) throw new Error("Demo forge did not produce a ticket.");
  plane.acceptTicketTree(id, "demo operator");
  const scenario = scenarioFromCriterion("REQ-001", 'The page shows "healthy".', "http://127.0.0.1:18765/");
  if (!scenario) throw new Error("Demo acceptance criterion did not produce a browser scenario.");
  plane.registerBrowserScenario(id, scenario);
  plane.declareArchitecture(id, { id: "CMP-1", kind: "component", choice: "src/health.js", alternatives: [] });
  plane.declareArchitecture(id, { id: "LAYER-1", kind: "layer", choice: "src", alternatives: [] });
  plane.declareArchitecture(id, { id: "TECH-1", kind: "technology", choice: "node", alternatives: [] });
  plane.declareArchitecture(id, { id: "FORB-1", kind: "forbidden", choice: "left-pad", alternatives: [] });
  plane.declareNfr(id, {
    id: "NFR-001",
    category: "performance",
    metric: "health-latency",
    operator: "<",
    target: 1000,
    unit: "ms",
    verificationMethod: JSON.stringify([
      process.execPath,
      "-e",
      "const http=require('node:http'); const started=Date.now(); const req=http.get('http://127.0.0.1:18765/health', (res)=>{ res.resume(); res.on('end', ()=>{ console.log('BMAD-NFR-VALUE: '+(Date.now()-started)); }); }); req.on('error', ()=>{ process.exit(1); });",
    ]),
  });
  const built = plane.executeTicket(id, "1.1");
  process.stdout.write(`Build: ${built.status}\n${built.message}\n`);
  if (built.status === "failed" || built.status === "not-configured" || built.status === "not-available") {
    stop(id, `Build ${built.status}.`, built.message);
  }
  let unit = latestEvidence(plane, id, "unit");
  let review = plane.mission(id).reviews?.at(-1);
  if (unit?.result !== "pass" || review?.status !== "PASS") {
    const repaired = plane.repairTicket(id, "1.1");
    process.stdout.write(`Repair: ${repaired.status}\n${repaired.message ?? ""}\n`);
    unit = latestEvidence(plane, id, "unit");
    review = plane.mission(id).reviews?.at(-1);
  }
  if (unit?.result !== "pass") stop(id, "Tests did not pass.", unit?.artifact ?? "no unit artifact");
  if (review?.status !== "PASS") stop(id, `Review ${review?.status ?? "NOT_RUN"}.`, review?.evidencePath ?? "no review artifact");
  const attack = plane.attackTicket(id, "1.1");
  process.stdout.write(`Attack: ${attack.status}\n`);
  if (attack.status !== "PASS") {
    stop(id, `Attack ${attack.status}.`, "evidencePath" in attack ? attack.evidencePath : latestEvidence(plane, id, "attack")?.artifact ?? "no attack artifact");
  }
  const worktree = plane.mission(id).executions?.find((item) => item.ticketRef === "1.1")?.worktree ?? undefined;
  const entry = worktree ? path.join(worktree, "src", "health.js") : "";
  let server: ReturnType<typeof spawn> | null = null;
  if (entry && worktree && fs.existsSync(entry)) {
    server = spawn(process.execPath, [entry], { cwd: worktree, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  try {
    const browser = await plane.runBrowser(id, "REQ-001");
    process.stdout.write(`Browser: ${browser.status}\n${browser.summary}\n`);
    if (browser.status !== "PASS") stop(id, `Browser ${browser.status}.`, browser.summary);
    const security = plane.runSecurity(id, "1.1");
    process.stdout.write(`Security: ${security.status}\n`);
    if (security.status !== "PASS") stop(id, `Security ${security.status}.`, latestEvidence(plane, id, "security")?.artifact ?? "no security artifact");
    const nfr = plane.measureNfr(id, "1.1");
    process.stdout.write(`NFR: ${nfr.status}\n`);
    if (nfr.status !== "PASS") stop(id, `NFR ${nfr.status}.`, "nfr evidence");
    const architecture = plane.verifyArchitecture(id);
    process.stdout.write(`Architecture: ${architecture.status}\n`);
    if (architecture.status !== "PASS") stop(id, `Architecture ${architecture.status}.`, architecture.evidence);
    const trace = plane.verifyTraceability(id);
    process.stdout.write(`Traceability: ${trace.status}\n`);
    if (trace.status !== "PASS") stop(id, `Traceability ${trace.status}.`, trace.evidence);
  } finally {
    server?.kill();
  }
  const report = plane.inspectEvidence(id);
  process.stdout.write(`Release evaluation: ${report.state}\n`);
  process.stdout.write(`Approval is still required:\nbmad-next release approve ${id} --by "Your Name"\nThen run bmad-next release ${id} from the demo workspace.\n`);
}

export async function demoCommand(projectRoot: string, action: string | undefined): Promise<void> {
  const verb = action ?? "run";
  if (verb === "reset") {
    const removed = resetDemo(projectRoot);
    process.stdout.write(`Removed demo workspace ${removed.removed}\nUser missions were left in place.\n`);
    return;
  }
  const dir = demoDirectory(projectRoot);
  if (verb === "fresh" || verb === "create") {
    ensureWorkspace(dir);
    const plane = new BmadControlPlane(dir);
    const mission = plane.createMission(IDEA);
    process.stdout.write(`${formatDemoReport(mission)}\nWorkspace:\n${dir}\n`);
    return;
  }
  if (verb !== "run") throw new Error("Use bmad-next demo fresh, bmad-next demo run, or bmad-next demo reset.");
  if (!fs.existsSync(dir)) throw new Error("No demo workspace. Run bmad-next demo fresh first.");
  const plane = new BmadControlPlane(dir);
  const mission = plane.mission();
  try {
    await runPipeline(plane, mission.id);
  } finally {
    process.stdout.write(`${formatDemoReport(plane.mission(mission.id))}\n`);
  }
}
