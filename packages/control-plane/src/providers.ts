import fs from "node:fs";
import path from "node:path";
import type { CommandRunner, Mission, RuntimeAvailability } from "./types";
import { LocalSandbox, type SandboxHandle } from "./collaboration";

export interface ProviderResult {
  availability: RuntimeAvailability;
  status: "NOT_RUN" | "PASS" | "FAIL" | "BLOCKED" | "ERROR";
  findings: Array<{ code: string; message: string; path?: string }>;
  artifact?: string;
  command: string;
}

export interface SandboxProvider {
  id: "local" | "docker" | "remote";
  availability(): RuntimeAvailability;
  create(id: string): SandboxHandle | { status: "NOT CONFIGURED"; detail: string };
  exec(id: string, command: string, args: string[]): { blocked: boolean; reason: string };
  readFile(id: string, file: string): string;
  writeFile(id: string, file: string, content: string): void;
  snapshot(id: string): string;
  restore(id: string, snapshotPath: string): void;
  destroy(id: string): void;
}

export class LocalSandboxProvider implements SandboxProvider {
  readonly id = "local" as const;
  private readonly sandbox: LocalSandbox;

  constructor(home: string, runner: CommandRunner) {
    this.sandbox = new LocalSandbox(home, runner);
  }

  availability(): RuntimeAvailability {
    return "AVAILABLE";
  }

  create(id: string): SandboxHandle {
    return this.sandbox.create(id);
  }

  exec(id: string, command: string, args: string[]): { blocked: boolean; reason: string } {
    const result = this.sandbox.exec(id, command, args);
    return { blocked: result.blocked, reason: result.reason };
  }

  readFile(id: string, file: string): string {
    return this.sandbox.readFile(id, file);
  }

  writeFile(id: string, file: string, content: string): void {
    this.sandbox.writeFile(id, file, content);
  }

  snapshot(id: string): string {
    return this.sandbox.snapshot(id);
  }

  restore(id: string, snapshotPath: string): void {
    this.sandbox.restore(id, snapshotPath);
  }

  destroy(id: string): void {
    this.sandbox.destroy(id);
  }
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly id = "docker" as const;

  constructor(private readonly runner: CommandRunner) {}

  availability(): RuntimeAvailability {
    return this.runner.which("docker") ? "AVAILABLE" : "NOT CONFIGURED";
  }

  create(_id: string): { status: "NOT CONFIGURED"; detail: string } {
    return { status: "NOT CONFIGURED", detail: "Docker sandbox is not selected. The control plane does not call Docker APIs." };
  }

  exec(_id: string, _command: string, _args: string[]): { blocked: boolean; reason: string } {
    return { blocked: true, reason: "Docker sandbox is not configured." };
  }

  readFile(_id: string, _file: string): string {
    throw new Error("Docker sandbox is not configured.");
  }

  writeFile(_id: string, _file: string, _content: string): void {
    throw new Error("Docker sandbox is not configured.");
  }

  snapshot(_id: string): string {
    throw new Error("Docker sandbox is not configured.");
  }

  restore(_id: string, _snapshotPath: string): void {
    throw new Error("Docker sandbox is not configured.");
  }

  destroy(): void {
    return;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return code === "EPERM";
  }
}

export interface WorktreeRecord {
  ticketRef: string;
  agent: string;
  path: string;
  missionId: string;
  pid: number;
}

interface WorktreeLockFile {
  claims: WorktreeRecord[];
}

export class WorktreeManager {
  constructor(private readonly runner: CommandRunner) {}

  list(root: string): { ok: boolean; output: string } {
    const result = this.runner.run("git", ["worktree", "list"], root, 10000);
    return { ok: result.exitCode === 0, output: result.stdout || result.stderr };
  }

  status(root: string): { ok: boolean; output: string } {
    const result = this.runner.run("git", ["status", "--short"], root, 10000);
    return { ok: result.exitCode === 0, output: result.stdout || result.stderr };
  }

  claim(root: string, missionId: string, ticketRef: string, agent: string): WorktreeRecord {
    const locks = this.readLocks(root);
    this.recoverStale(locks);
    const key = this.key(missionId, ticketRef);
    const existing = locks.claims.find((claim) => this.key(claim.missionId, claim.ticketRef) === key);
    if (existing && existing.agent !== agent && pidAlive(existing.pid)) {
      throw new Error(`Ticket ${ticketRef} is locked by ${existing.agent} at ${existing.path}.`);
    }
    const directory = path.join(root, ".bmad-next", "worktrees", missionId, ticketRef);
    const record: WorktreeRecord = { ticketRef, agent, path: directory, missionId, pid: process.pid };
    locks.claims = locks.claims.filter((claim) => this.key(claim.missionId, claim.ticketRef) !== key);
    locks.claims.push(record);
    this.writeLocks(root, locks);
    return record;
  }

  release(root: string, missionId: string, ticketRef: string): void {
    const locks = this.readLocks(root);
    const key = this.key(missionId, ticketRef);
    locks.claims = locks.claims.filter((claim) => this.key(claim.missionId, claim.ticketRef) !== key);
    this.writeLocks(root, locks);
  }

  recoverStale(locks: WorktreeLockFile): WorktreeRecord[] {
    const stale = locks.claims.filter((claim) => !pidAlive(claim.pid));
    locks.claims = locks.claims.filter((claim) => pidAlive(claim.pid));
    return stale;
  }

  create(root: string, missionId: string, ticketRef: string, agent: string): WorktreeRecord {
    const record = this.claim(root, missionId, ticketRef, agent);
    if (fs.existsSync(path.join(record.path, ".git"))) return record;
    const branch = `bmad-${missionId}-${ticketRef}`.replaceAll(/[^A-Za-z0-9._/-]+/g, "-");
    fs.mkdirSync(path.dirname(record.path), { recursive: true });
    const created = this.runner.run("git", ["worktree", "add", "-b", branch, record.path], root, 15000);
    if (created.exitCode !== 0) {
      this.release(root, missionId, ticketRef);
      throw new Error(created.stderr.trim() || "git worktree add failed.");
    }
    return record;
  }

  remove(root: string, ticketRef: string, missionId?: string): { removed: boolean; reason: string } {
    const locks = this.readLocks(root);
    const record = locks.claims.find((claim) => claim.ticketRef === ticketRef && (!missionId || claim.missionId === missionId));
    if (!record) return { removed: false, reason: "No worktree claim exists." };
    const removed = this.runner.run("git", ["worktree", "remove", "--force", record.path], root, 15000);
    if (removed.exitCode !== 0) {
      return { removed: false, reason: removed.stderr.trim() || "git worktree remove failed. The lock stays." };
    }
    if (missionId) this.release(root, missionId, ticketRef);
    else {
      locks.claims = locks.claims.filter((claim) => claim.ticketRef !== ticketRef);
      this.writeLocks(root, locks);
    }
    return { removed: true, reason: "Worktree removed." };
  }

  private key(missionId: string, ticketRef: string): string {
    return `${missionId}:${ticketRef}`;
  }

  private lockPath(root: string): string {
    return path.join(root, ".bmad-next", "worktree-locks.json");
  }

  private readLocks(root: string): WorktreeLockFile {
    const file = this.lockPath(root);
    if (!fs.existsSync(file)) return { claims: [] };
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as WorktreeLockFile;
    return { claims: Array.isArray(parsed.claims) ? parsed.claims : [] };
  }

  private writeLocks(root: string, locks: WorktreeLockFile): void {
    const file = this.lockPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(locks, null, 2));
  }

  checkpoint(root: string): { ok: boolean; revision: string | null } {
    const result = this.runner.run("git", ["rev-parse", "HEAD"], root, 10000);
    return { ok: result.exitCode === 0, revision: result.exitCode === 0 ? result.stdout.trim() : null };
  }

  merge(root: string, branch: string): { conflict: boolean; output: string } {
    const result = this.runner.run("git", ["merge", "--no-commit", "--no-ff", branch], root, 15000);
    const output = `${result.stdout}\n${result.stderr}`;
    return { conflict: result.exitCode !== 0 || /CONFLICT/.test(output), output };
  }
}

/** Version probe only. A scan is CommandSecurityScanner in security.ts. This result is never a pass. */
export function runSecurityTool(runner: CommandRunner, tool: "semgrep" | "trivy" | "trufflehog", cwd: string): ProviderResult {
  const binary = runner.which(tool);
  if (!binary) {
    return { availability: "NOT CONFIGURED", status: "NOT_RUN", findings: [], command: tool };
  }
  const args = tool === "semgrep" ? ["--version"] : ["--version"];
  const result = runner.run(tool, args, cwd, 20000);
  if (result.exitCode !== 0 || result.timedOut) {
    return {
      availability: "FAILED",
      status: "ERROR",
      findings: [{ code: "TOOL_FAILED", message: result.stderr.trim() || `${tool} failed before a scan.` }],
      command: `${tool} ${args.join(" ")}`,
    };
  }
  return {
    availability: "AVAILABLE",
    status: "NOT_RUN",
    findings: [],
    command: `${tool} ${args.join(" ")}`,
  };
}

export interface BrowserStep {
  action: "launch" | "navigate" | "click" | "fill" | "assert" | "screenshot" | "logs" | "close";
  detail: string;
}

export interface BrowserProvider {
  availability(): RuntimeAvailability;
  run(steps: BrowserStep[], cwd: string): ProviderResult & { steps: BrowserStep[] };
}

/** Path check only. Production browser verification is PlaywrightBrowser in browser.ts. */
export class PlaywrightBrowserProvider implements BrowserProvider {
  constructor(private readonly runner: CommandRunner) {}

  availability(): RuntimeAvailability {
    return this.runner.which("playwright") ? "AVAILABLE" : "NOT CONFIGURED";
  }

  run(steps: BrowserStep[], _cwd: string): ProviderResult & { steps: BrowserStep[] } {
    if (this.availability() !== "AVAILABLE") {
      return { availability: "NOT CONFIGURED", status: "NOT_RUN", findings: [], command: "playwright", steps };
    }
    return {
      availability: "AVAILABLE",
      status: "NOT_RUN",
      findings: [{ code: "BROWSER_SCRIPT_REQUIRED", message: "Playwright is installed. A scenario file is required before a run counts as evidence." }],
      command: "playwright",
      steps,
    };
  }
}

export interface ResearchClaim {
  source: string;
  timestamp: string;
  claim: string;
  evidence: string;
  confidence: "low" | "medium" | "high";
}

export interface ResearchProvider {
  id: string;
  investigate(query: string, sources: ResearchClaim[]): { availability: RuntimeAvailability; claims: ResearchClaim[] };
}

export class BmadResearchProvider implements ResearchProvider {
  readonly id = "bmad-deep-recon";

  investigate(_query: string, sources: ResearchClaim[]): { availability: RuntimeAvailability; claims: ResearchClaim[] } {
    if (sources.length === 0) return { availability: "NOT CONFIGURED", claims: [] };
    return { availability: "CONFIGURED", claims: sources };
  }
}

export interface RepoQuery {
  availability: RuntimeAvailability;
  detail: string;
}

export function repositoryIntelligence(runner: CommandRunner, root: string): { map: RepoQuery; search: RepoQuery; ast: RepoQuery } {
  const files = fs.existsSync(root) ? fs.readdirSync(root).slice(0, 20).join(", ") : "";
  return {
    map: { availability: "AVAILABLE", detail: files || "Workspace is empty." },
    search: { availability: runner.which("zoekt") ? "AVAILABLE" : "NOT CONFIGURED", detail: runner.which("zoekt") ? "zoekt is on PATH." : "zoekt is not on PATH." },
    ast: { availability: runner.which("ast-grep") ? "AVAILABLE" : "NOT CONFIGURED", detail: runner.which("ast-grep") ? "ast-grep is on PATH." : "ast-grep is not on PATH." },
  };
}

export function teaBrief(mission: Mission): string {
  const lines = [
    "# TEA brief",
    "",
    "producer: bmad-next.tea-boundary",
    "upstream: bmad-method-test-architecture-enterprise",
    "status: draft",
    "",
    "This brief is derived from mission state. It does not mark the TEA skill complete.",
    "",
    `Risk: ${mission.complexity}`,
    "",
    "## Requirements",
  ];
  if (mission.requirements.length === 0) lines.push("No requirements recorded.");
  for (const requirement of mission.requirements) {
    lines.push(`- ${requirement.id} risk ${requirement.risk}`);
    for (const criterion of requirement.acceptance_criteria) lines.push(`  - ${criterion}`);
  }
  lines.push("", "## Evidence");
  if (mission.evidence.length === 0) lines.push("No evidence runs recorded.");
  for (const record of mission.evidence) lines.push(`- ${record.kind} ${record.result} ${record.artifact ?? "no artifact"}`);
  return lines.join("\n");
}

export function retrospectiveBrief(mission: Mission, events: Array<{ type: string; data: Record<string, unknown> }>): string {
  const count = (type: string) => events.filter((event) => event.type === type).length;
  const section = (title: string, body: string) => [`## ${title}`, body || "No events recorded.", ""];
  return [
    "# Retrospective brief",
    "",
    "producer: bmad-next.retrospective-boundary",
    "status: draft",
    "",
    ...section("What went well", count("TestPassed") + count("EvidenceCreated") > 0 ? `${count("TestPassed")} passing tests. ${count("EvidenceCreated")} evidence records.` : "No passing verification events."),
    ...section("What failed", count("AgentFailed") + count("TestFailed") > 0 ? `${count("AgentFailed")} agent failures. ${count("TestFailed")} test failures.` : "No failure events."),
    ...section("What the event log shows", `${events.length} events.`),
    ...section("Architecture drift", String(mission.findings.filter((finding) => finding.code === "ARCHITECTURE_DRIFT").length)),
    ...section("Retries", String(Object.values(mission.attempts).reduce((sum, value) => sum + value, 0))),
    ...section("Agent failures", String(count("AgentFailed"))),
    ...section("Verification failures", String(count("TestFailed") + count("GateEvaluated"))),
    ...section("Findings", mission.findings.map((finding) => `${finding.code}: ${finding.message}`).join("\n")),
    ...section("Requirement changes", String(count("CorrectCourse"))),
    ...section("Cost", mission.usage.some((item) => item.cost !== null) ? mission.usage.map((item) => String(item.cost)).join(", ") : "No cost was reported by a run."),
    ...section("Latency", mission.usage.some((item) => item.latency_ms !== null) ? mission.usage.map((item) => String(item.latency_ms)).join(", ") : "No latency was reported by a run."),
    ...section("Human interventions", String(mission.approvals.length)),
    ...section("Lessons", "Candidate improvements stay unpublished until evaluation passes."),
  ].join("\n");
}

export type BuilderKind = "agent" | "workflow" | "skill" | "module" | "evaluation";

export function builderDraft(kind: BuilderKind, name: string): string {
  return [`# ${kind} draft`, "", `name: ${name}`, "state: in-progress", "published: false", "", "Upstream builder: https://github.com/bmad-code-org/bmad-builder", "This draft is not published."].join("\n");
}
