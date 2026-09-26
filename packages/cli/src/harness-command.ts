import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  BmadControlPlane,
  applyHarnessEnv,
  formatMissionStatus,
  harnessModelId,
  loadHarnessConfig,
  loadProjectEnv,
} from "@bmad-next/control-plane";
import type { AutopilotResult, HarnessConfig } from "@bmad-next/control-plane";

/** Repository root of the harness itself: packages/cli/dist -> repo. */
const HARNESS_ROOT = path.resolve(__dirname, "..", "..", "..");
const ISSUE_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)\/?(?:[?#].*)?$/;
const ISSUE_REF = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;
const REPO_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;
const MAX_TEXT = 20000;
const MAX_ROUNDS = 6;
const ISSUE_ACCEPTANCE = "The behaviour the issue describes is fixed or implemented, and automated tests that cover it pass.";
/** Completion marker the build prompt asks for; it is removed from the delivered patch. */
const MARKER_LINE = /^[ \t]*(?:\/\/|#|--|;|<!--|\/\*)[ \t]*BMAD-TICKET-STATUS:[ \t]*built[ \t]*(?:-->|\*\/)?[ \t]*\r?\n?/gm;
const MARKER_TAIL = /[ \t]*(?:\/\/|#|<!--|\/\*)[ \t]*BMAD-TICKET-STATUS:[ \t]*built[ \t]*(?:-->|\*\/)?/g;

interface Task {
  title: string;
  input: string;
  workspace: string;
}

interface Session {
  config: HarnessConfig;
  auto: boolean;
  operator: string;
  repo: string;
  lines: Lines | null;
  stop: boolean;
  /** PATH at launch; each task starts from it so one task's virtual environment does not leak into the next. */
  basePath: string;
}

/** Line queue over readline so pasted multi-line text is never dropped between prompts. */
class Lines {
  private readonly queue: string[] = [];
  private readonly waiters: Array<(line: string | null) => void> = [];
  private closed = false;

  constructor(private readonly rl: readline.Interface) {
    rl.on("line", (line) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.queue.push(line);
    });
    rl.on("close", () => {
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) waiter(null);
    });
  }

  next(prompt: string): Promise<string | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift() ?? "");
    if (this.closed) return Promise.resolve(null);
    this.rl.setPrompt(prompt);
    this.rl.prompt();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.rl.close();
  }
}

function say(text = ""): void {
  process.stdout.write(`${text}\n`);
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): { ok: boolean; out: string } {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return { ok: result.status === 0, out: `${result.stdout ?? ""}${result.status === 0 ? "" : result.stderr ?? ""}` };
}

function clip(text: string, limit = MAX_TEXT): string {
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
}

/** Commits made by the harness itself need an identity even on a machine with no git config. */
function ensureGitIdentity(): void {
  // Compiled caches would otherwise show up as changes in every Python ticket worktree.
  process.env.PYTHONDONTWRITEBYTECODE ||= "1";
  process.env.GIT_AUTHOR_NAME ||= "AI Harness";
  process.env.GIT_AUTHOR_EMAIL ||= "ai-harness@example.invalid";
  process.env.GIT_COMMITTER_NAME ||= process.env.GIT_AUTHOR_NAME;
  process.env.GIT_COMMITTER_EMAIL ||= process.env.GIT_AUTHOR_EMAIL;
}

function opencodeVersion(): string | null {
  const result = spawnSync("opencode", ["--version"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function githubJson(url: string): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "ai-harness" };
  const token = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GitHub API returned ${response.status} for ${url}.`);
  return response.json();
}

interface IssueText {
  title: string;
  body: string;
  labels: string[];
  comments: Array<{ author: string; body: string }>;
}

async function fetchIssue(owner: string, repo: string, number: string): Promise<IssueText> {
  try {
    const issue = (await githubJson(`https://api.github.com/repos/${owner}/${repo}/issues/${number}`)) as {
      title: string;
      body: string | null;
      labels: Array<{ name: string } | string>;
      comments: number;
    };
    const comments = issue.comments > 0
      ? ((await githubJson(`https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments?per_page=30`)) as Array<{ user: { login: string } | null; body: string | null }>)
      : [];
    return {
      title: issue.title,
      body: issue.body ?? "",
      labels: issue.labels.map((label) => (typeof label === "string" ? label : label.name)),
      comments: comments.map((item) => ({ author: item.user?.login ?? "unknown", body: item.body ?? "" })),
    };
  } catch (error) {
    // The unauthenticated API is rate limited; the GitHub CLI can use its own login instead.
    const viewed = spawnSync("gh", ["issue", "view", number, "-R", `${owner}/${repo}`, "--json", "title,body,labels,comments"], { encoding: "utf8" });
    if (viewed.status !== 0) throw error;
    const issue = JSON.parse(viewed.stdout) as { title: string; body: string; labels: Array<{ name: string }>; comments: Array<{ author: { login: string }; body: string }> };
    return {
      title: issue.title,
      body: issue.body,
      labels: issue.labels.map((label) => label.name),
      comments: issue.comments.map((item) => ({ author: item.author.login, body: item.body })),
    };
  }
}

function workspaceRoot(session: Session): string {
  return path.resolve(HARNESS_ROOT, session.config.workspaceDir);
}

/** Clones a GitHub repository into the workspace once, then reuses it. */
function cloneRepo(session: Session, owner: string, repo: string): string {
  const dir = path.join(workspaceRoot(session), `${owner}__${repo}`);
  if (fs.existsSync(path.join(dir, ".git"))) {
    say(`Using existing clone ${dir}`);
    return dir;
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  say(`Cloning https://github.com/${owner}/${repo} ...`);
  const cloned = git(workspaceRoot(session), ["clone", "--filter=blob:none", `https://github.com/${owner}/${repo}.git`, dir]);
  if (!cloned.ok) throw new Error(`git clone failed:\n${cloned.out}`);
  return dir;
}

/** The repository a plain-text issue applies to: HARNESS_REPO / `repo` command, or a fresh empty repository. */
function targetForText(session: Session): string {
  const repo = session.repo.trim();
  const url = REPO_URL.exec(repo);
  if (url) return cloneRepo(session, url[1], url[2]);
  if (repo) {
    const dir = path.resolve(repo);
    if (!fs.existsSync(path.join(dir, ".git"))) throw new Error(`${dir} is not a git repository.`);
    return dir;
  }
  const dir = path.join(workspaceRoot(session), `task-${stamp()}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# AI Harness task workspace\n");
  git(dir, ["add", "README.md"]);
  const committed = git(dir, ["commit", "-q", "-m", "Start the AI Harness task workspace."]);
  if (!committed.ok) throw new Error(`git commit failed:\n${committed.out}`);
  return dir;
}

async function resolveTask(session: Session, raw: string): Promise<Task> {
  let text = raw.trim();
  if (text.startsWith("@")) {
    const file = path.resolve(text.slice(1).trim());
    text = fs.readFileSync(file, "utf8").trim();
  }
  const match = ISSUE_URL.exec(text) ?? ISSUE_REF.exec(text);
  if (match) {
    const [, owner, repo, number] = match;
    say(`Fetching issue ${owner}/${repo}#${number} ...`);
    const issue = await fetchIssue(owner, repo, number);
    const workspace = cloneRepo(session, owner, repo);
    const input = [
      `Resolve GitHub issue ${owner}/${repo}#${number}: ${issue.title}`,
      `URL: https://github.com/${owner}/${repo}/issues/${number}`,
      issue.labels.length > 0 ? `Labels: ${issue.labels.join(", ")}` : "",
      "",
      clip(issue.body || "(no description)"),
      issue.comments.length > 0 ? "\nComments:" : "",
      ...issue.comments.map((item) => clip(`- @${item.author}: ${item.body}`, 4000)),
      "",
      "Change the existing code in this repository to resolve the issue, and add or update tests that prove the fix.",
    ].filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n");
    return { title: `${owner}/${repo}#${number} ${issue.title}`, input: clip(input, MAX_TEXT * 2), workspace };
  }
  return { title: text.split("\n")[0].slice(0, 100), input: clip(text), workspace: targetForText(session) };
}

const PYTHON_MARKERS = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "pytest.ini", "tox.ini"];

/**
 * A Python repository gets its own virtual environment (outside the repository) with pytest and, best effort, the
 * project and its requirements installed. It goes first on PATH so the test gate and the coding agent use it.
 */
function preparePython(session: Session, workspace: string): void {
  process.env.PATH = session.basePath;
  delete process.env.VIRTUAL_ENV;
  if (!PYTHON_MARKERS.some((name) => fs.existsSync(path.join(workspace, name)))) return;
  const venv = path.join(workspaceRoot(session), ".venvs", path.basename(workspace));
  const python = path.join(venv, "bin", "python");
  const run = (command: string, args: string[], timeout: number) =>
    spawnSync(command, args, { cwd: workspace, encoding: "utf8", timeout, env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: "1" } });
  if (!fs.existsSync(python)) {
    say(`Python project: creating ${venv}`);
    const created = run("python3", ["-m", "venv", venv], 120000);
    if (created.status !== 0) {
      say(`  Could not create a virtual environment; tests use the system python3.\n  ${(created.stderr ?? "").trim().split("\n").at(-1) ?? ""}`);
      return;
    }
    const steps: Array<[string, string[]]> = [["pytest", ["install", "-q", "pytest"]]];
    for (const file of ["requirements.txt", "requirements-dev.txt", "requirements-test.txt", "test-requirements.txt"]) {
      if (fs.existsSync(path.join(workspace, file))) steps.push([file, ["install", "-q", "-r", file]]);
    }
    if (fs.existsSync(path.join(workspace, "pyproject.toml")) || fs.existsSync(path.join(workspace, "setup.py"))) {
      steps.push(["the project", ["install", "-q", "-e", "."]]);
    }
    for (const [label, args] of steps) {
      const installed = run(python, ["-m", "pip", ...args], 600000);
      say(`  install ${label}: ${installed.status === 0 ? "ok" : "failed (continuing)"}`);
    }
  }
  process.env.VIRTUAL_ENV = venv;
  process.env.PATH = `${path.join(venv, "bin")}${path.delimiter}${process.env.PATH ?? ""}`;
}

async function ask(session: Session, prompt: string, fallback: string): Promise<string> {
  if (session.auto || !session.lines) {
    say(`${prompt} -> ${fallback || "(skipped)"} [auto]`);
    return fallback;
  }
  const answer = await session.lines.next(`${prompt} `);
  return answer === null ? fallback : answer.trim() || fallback;
}

/** Runs autopilot and answers the decisions it hands back, within a bounded number of rounds. */
async function drive(session: Session, plane: BmadControlPlane, missionId: string): Promise<AutopilotResult> {
  let result: AutopilotResult | null = null;
  let resumed = false;
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    result = await plane.autopilot(missionId, { log: (line) => say(`  ${line}`), stopRequested: () => session.stop });
    const mission = plane.mission(missionId);
    if (result.status === "needs-forge-answers") {
      const forge = mission.forge;
      for (const question of forge?.questions.filter((item) => !forge.answered.includes(item.id)) ?? []) {
        say(`\nQuestion: ${question.prompt}\n  (${question.why})`);
        const answer = await ask(session, "answer (blank = let the harness assume)>", "unknown: infer it from the issue text and the repository");
        plane.answerForge(missionId, answer);
      }
      continue;
    }
    if (result.status === "needs-ticket-acceptance") {
      say("\nProposed tickets:");
      for (const ticket of mission.tickets) say(`  ${ticket.ref}  ${ticket.title}`);
      const answer = await ask(session, "Accept this ticket tree? [Y/n]>", "y");
      if (/^n/i.test(answer)) return result;
      plane.acceptTicketTree(missionId, session.operator);
      continue;
    }
    // A planning skill that missed its output contract gets one more autopilot pass; the model is not deterministic.
    if (result.status === "blocked" && !resumed && /did not complete/.test(result.reason) && !session.stop) {
      resumed = true;
      say("  Resuming autopilot once for the planning step that did not complete.");
      continue;
    }
    if (result.status === "needs-release-approval") {
      const name = await ask(session, "Every automated gate passed. Type your name to approve the release (blank = leave pending)>", "");
      if (!name) return result;
      plane.approve(missionId, "release", name, "AI Harness session approval.");
      continue;
    }
    return result;
  }
  return result as AutopilotResult;
}

/** Removes the build completion marker from every changed file, so the patch carries only the real change. */
function stripMarkers(worktree: string): void {
  const status = git(worktree, ["status", "--porcelain", "--untracked-files=all"]);
  for (const line of status.out.split("\n")) {
    const file = path.join(worktree, line.slice(3).trim());
    if (!line.trim() || !fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes("BMAD-TICKET-STATUS")) continue;
    fs.writeFileSync(file, text.replace(MARKER_LINE, "").replace(MARKER_TAIL, ""));
  }
}

/** Writes each ticket worktree's change as a patch, through a throwaway index so the worktree is untouched. */
function exportResults(plane: BmadControlPlane, missionId: string, outDir: string): string[] {
  fs.mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const execution of plane.mission(missionId).executions ?? []) {
    const worktree = execution.worktree;
    if (!worktree || !fs.existsSync(worktree)) continue;
    stripMarkers(worktree);
    const index = path.join(os.tmpdir(), `ai-harness-index-${process.pid}-${Date.now()}`);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    git(worktree, ["read-tree", "HEAD"], env);
    git(worktree, ["add", "-A", "--", ".", ":(exclude).bmad-next", ":(exclude)_bmad-output", ":(exclude)node_modules"], env);
    const diff = git(worktree, ["diff", "--cached", "--binary", "HEAD"], env);
    const stat = git(worktree, ["diff", "--cached", "--stat", "HEAD"], env);
    fs.rmSync(index, { force: true });
    const file = path.join(outDir, `ticket-${execution.ticketRef}.patch`);
    fs.writeFileSync(file, diff.out);
    written.push(file);
    say(`\nTicket ${execution.ticketRef}: ${execution.status}, worktree ${worktree}`);
    say(stat.out.trim() || "  (no changes)");
  }
  return written;
}

async function runTask(session: Session, raw: string): Promise<AutopilotResult | null> {
  const task = await resolveTask(session, raw);
  say(`\n=== ${task.title}\nWorkspace: ${task.workspace}`);
  preparePython(session, task.workspace);
  const plane = new BmadControlPlane(task.workspace);
  const mission =
    session.config.workflow === "issue"
      ? plane.createMission(task.input, { issue: { title: task.title, acceptance: ISSUE_ACCEPTANCE } })
      : plane.createMission(task.input);
  say(`Mission ${mission.id} (complexity ${mission.complexity}, mode ${mission.mode})`);
  session.stop = false;
  let result: AutopilotResult;
  try {
    result = await drive(session, plane, mission.id);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    say(`Autopilot error: ${reason}`);
    result = { status: "blocked", missionId: mission.id, reason: `Autopilot error: ${reason}`, steps: [] };
  }
  const outDir = path.join(workspaceRoot(session), "results", mission.id);
  const patches = exportResults(plane, mission.id, outDir);
  fs.writeFileSync(
    path.join(outDir, "summary.json"),
    `${JSON.stringify({ task: task.title, workspace: task.workspace, model: harnessModelId(session.config), result, patches }, null, 2)}\n`,
  );
  say(`\n${formatMissionStatus(plane.mission(mission.id))}`);
  say(`\nResult: ${result.status}. ${result.reason}`);
  say(`Artifacts: ${outDir}`);
  return result;
}

function banner(session: Session): void {
  const key = (process.env.AI_API_KEY ?? "").trim() ? "set (value hidden)" : "NOT SET - export AI_API_KEY before make run";
  const opencode = opencodeVersion();
  say("AI Harness (BMAD Next) - evaluation mode");
  say(`Model:      ${harnessModelId(session.config)}${session.config.baseURL ? ` via ${session.config.baseURL}` : ""}`);
  say(`AI_API_KEY: ${key}`);
  say(`Runtime:    opencode ${opencode ?? "NOT FOUND - run make setup"}`);
  say(`Workspace:  ${workspaceRoot(session)}`);
  say(`Mode:       ${session.auto ? "automatic (decisions take defaults)" : "interactive"}`);
}

function help(): void {
  say(`
Give the harness an issue:
  https://github.com/<owner>/<repo>/issues/<n>   fetch the issue, clone the repo, resolve it
  <owner>/<repo>#<n>                             same, short form
  @path/to/issue.md                              read the issue text from a file
  any other text                                 the issue itself; finish multi-line text with a line containing only "."
Commands:
  repo <github-url | local-path | none>          repository that plain-text issues apply to
  auto on|off                                    take default answers for every decision
  help, quit`);
}

export async function harnessCommand(args: string[]): Promise<void> {
  loadProjectEnv(HARNESS_ROOT);
  const config = loadHarnessConfig(HARNESS_ROOT);
  applyHarnessEnv(HARNESS_ROOT, config);
  ensureGitIdentity();
  const flags = new Set(args.filter((arg) => arg.startsWith("--")));
  const positional = args.filter((arg) => !arg.startsWith("--")).join(" ").trim();
  const interactive = Boolean(process.stdin.isTTY) && !flags.has("--once");
  const session: Session = {
    config,
    auto: flags.has("--yes") || /^(1|true|yes)$/i.test(process.env.HARNESS_AUTO ?? "") || !process.stdin.isTTY,
    operator: (process.env.HARNESS_OPERATOR ?? "").trim() || os.userInfo().username || "evaluator",
    repo: (process.env.HARNESS_REPO ?? "").trim(),
    lines: null,
    stop: false,
    basePath: process.env.PATH ?? "",
  };
  banner(session);

  const initial = positional || (process.env.ISSUE ?? "").trim();
  if (!process.stdin.isTTY) {
    // Piped input: the whole of stdin is one issue.
    const piped = initial || fs.readFileSync(0, "utf8").trim();
    if (!piped) throw new Error("No issue given. Pipe the issue text, or set ISSUE.");
    const result = await runTask(session, piped);
    if (result && result.status === "blocked") process.exitCode = 1;
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  session.lines = new Lines(rl);
  let interrupts = 0;
  rl.on("SIGINT", () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
    session.stop = true;
    say("\nStopping after the current step. Press Ctrl-C again to quit.");
  });

  try {
    if (initial) await runTask(session, initial);
    if (!interactive) return;
    help();
    for (;;) {
      interrupts = 0;
      const first = await session.lines.next("\nissue> ");
      if (first === null) break;
      const line = first.trim();
      if (!line) continue;
      if (/^(quit|exit|q)$/i.test(line)) break;
      if (/^help$/i.test(line)) {
        help();
        continue;
      }
      if (/^auto\s+(on|off)$/i.test(line)) {
        session.auto = /on$/i.test(line);
        say(`Automatic decisions ${session.auto ? "on" : "off"}.`);
        continue;
      }
      if (/^repo\b/i.test(line)) {
        const value = line.replace(/^repo\s*/i, "").trim();
        session.repo = /^none$/i.test(value) ? "" : value;
        say(`Plain-text issues apply to: ${session.repo || "a new empty repository"}`);
        continue;
      }
      let raw = line;
      if (!ISSUE_URL.test(line) && !ISSUE_REF.test(line) && !line.startsWith("@")) {
        const body = [line];
        say('(finish the issue with a line containing only ".")');
        for (;;) {
          const next = await session.lines.next("... ");
          if (next === null || next.trim() === ".") break;
          body.push(next);
        }
        raw = body.join("\n");
      }
      try {
        await runTask(session, raw);
      } catch (error) {
        say(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    session.lines.close();
  }
}
