import fs from "node:fs";
import path from "node:path";
import type { AgentContract, CommandRunner, PartyRoom, RiskLevel } from "./types";

export const DEFAULT_AGENTS: AgentContract[] = [
  agent("Analyst", "Discovery and problem framing", ["research", "requirements"], ["bmad-agent-analyst", "bmad-deep-recon"], "low"),
  agent("Product Manager", "Product requirements and scope", ["prd", "requirements", "priorities"], ["bmad-agent-pm", "bmad-prd"], "medium"),
  agent("UX", "Journeys, screens, and accessibility", ["ux", "journey", "accessibility"], ["bmad-agent-ux-designer", "bmad-ux"], "medium"),
  agent("Architect", "Architecture and ADRs", ["architecture", "api", "data"], ["bmad-agent-architect", "bmad-architecture"], "high"),
  agent("Developer", "Implementation inside the repository", ["code", "tests"], ["bmad-agent-dev", "bmad-build"], "medium", {
    read: ["**"],
    write: ["src/**", "tests/**", "test/**"],
    execute: ["npm test", "git diff", "git status", "git branch"],
    blocked: ["production deploy", "drop database"],
  }),
  agent("Frontend Developer", "UI implementation", ["frontend", "css", "component"], ["bmad-build"], "medium"),
  agent("Backend Developer", "API and service implementation", ["backend", "api", "service"], ["bmad-build"], "medium"),
  agent("Database Engineer", "Schema and data access", ["database", "sql", "migration"], ["bmad-build"], "high"),
  agent("payment-engineer", "Payment implementation inside the payments tree", ["payment", "billing", "ledger"], ["bmad-build"], "critical", {
    read: ["**"],
    write: ["src/payments/**"],
    execute: ["npm test"],
    blocked: ["production deploy", "drop database"],
  }),
  agent("Researcher", "Evidence-backed investigation", ["research", "documentation"], ["bmad-deep-recon"], "low"),
  agent("TEA", "Risk, test strategy, and release advice", ["test", "risk", "nfr", "traceability"], ["tea"], "high"),
  agent("Security", "Security review and scan interpretation", ["security", "auth", "secret"], ["bmad-review"], "critical"),
  agent("Browser QA", "Browser evidence", ["browser", "ux"], ["bmad-qa-generate-e2e-tests"], "medium"),
  agent("Performance", "NFR measurement", ["performance", "latency", "nfr"], ["bmad-next:nfr"], "medium"),
  agent("DevOps", "CI, deploy, and environment", ["ci", "deploy", "docker"], ["bmad-build"], "high"),
  agent("Reviewer", "Independent review", ["review", "correctness"], ["bmad-code-review", "bmad-review"], "medium"),
  agent("Adversary", "Attempts to break the implementation", ["attack", "edge"], ["bmad-next:attack"], "high"),
  agent("Documentation", "Docs tied to verified state", ["docs"], ["bmad-project-context"], "low"),
  agent("Integration Agent", "Resolves overlapping agent work", ["merge", "conflict"], ["bmad-build"], "high"),
];

function agent(
  name: string,
  role: string,
  capabilities: string[],
  skills: string[],
  risk: RiskLevel,
  permissions: AgentContract["permissions"] = {
    read: ["**"],
    write: ["src/**"],
    execute: ["npm test"],
    blocked: ["production deploy", "drop database"],
  },
): AgentContract {
  return {
    name,
    role,
    capabilities,
    skills,
    tools: [],
    inputs: ["mission context", "story context"],
    outputs: ["artifacts", "evidence"],
    permissions,
    risk,
    runtime: null,
    models: [],
    memory: "project-brain",
    evaluation_suite: null,
    published: false,
  };
}

export function routeAgent(agents: AgentContract[], text: string, risk: RiskLevel): { agent: AgentContract | null; reasons: string[] } {
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const ranked = agents
    .map((candidate) => {
      const hits = candidate.capabilities.filter((capability) => words.some((word) => capability.includes(word) || word.includes(capability)));
      const riskFit = rank(candidate.risk) >= rank(risk) ? 1 : 0;
      return { candidate, score: hits.length * 10 + riskFit, hits };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.name.localeCompare(b.candidate.name));
  const winner = ranked[0];
  if (!winner) return { agent: null, reasons: ["No agent capability matched the story."] };
  return {
    agent: winner.candidate,
    reasons: [`Matched capabilities: ${winner.hits.join(", ") || "risk fit"}.`, `Score ${winner.score}.`],
  };
}

function rank(risk: RiskLevel): number {
  return { low: 1, medium: 2, high: 3, critical: 4 }[risk];
}

export function overlappingPaths(left: string[], right: string[]): string[] {
  const conflicts: string[] = [];
  for (const a of left) {
    for (const b of right) {
      if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) conflicts.push(`${a} ↔ ${b}`);
    }
  }
  return conflicts;
}

export function closeParty(room: PartyRoom): { ok: boolean; reason: string } {
  if (room.mode === "adversarial" && !room.turns.some((turn) => turn.stance === "attack")) {
    return { ok: false, reason: "Adversarial mode needs an attack turn before a decision can close the room." };
  }
  if (room.mode === "anti-consensus") {
    const stances = new Set(room.turns.filter((turn) => turn.stance !== "discuss").map((turn) => turn.stance));
    if (room.turns.length > 1 && stances.size < 2) {
      return { ok: false, reason: "Anti-consensus mode is still unexamined: the recorded turns do not dissent." };
    }
  }
  return { ok: true, reason: "Room can close." };
}

export interface ArenaCandidate {
  agent: string;
  testsPassed: number | null;
  testsTotal: number | null;
  securityFindings: number | null;
  nfrMet: boolean | null;
  cost: number | null;
  latencyMs: number | null;
  reviewFindings: number | null;
  requirementsSatisfied: number | null;
}

export function compareArena(candidates: ArenaCandidate[]): { winner: string | null; status: "measured" | "incomplete"; rows: ArenaCandidate[] } {
  const complete = candidates.every((candidate) =>
    [candidate.testsPassed, candidate.testsTotal, candidate.securityFindings, candidate.cost, candidate.latencyMs, candidate.reviewFindings, candidate.requirementsSatisfied].every(
      (value) => value !== null,
    ) && candidate.nfrMet !== null,
  );
  if (!complete || candidates.length === 0) return { winner: null, status: "incomplete", rows: candidates };
  const ranked = [...candidates].sort((a, b) => {
    const score = (item: ArenaCandidate) =>
      (item.requirementsSatisfied ?? 0) * 100 +
      (item.testsPassed ?? 0) * 10 -
      (item.securityFindings ?? 0) * 20 -
      (item.reviewFindings ?? 0) * 5 -
      (item.nfrMet ? 0 : 50);
    return score(b) - score(a);
  });
  return { winner: ranked[0]?.agent ?? null, status: "measured", rows: candidates };
}

export function mutationScore(measurements: { injected: number; caught: number } | null): { status: "not-configured" | "measured"; score: number | null; detail: string } {
  if (!measurements || measurements.injected <= 0) {
    return { status: "not-configured", score: null, detail: "Mutation testing has not been measured." };
  }
  const score = measurements.caught / measurements.injected;
  return { status: "measured", score, detail: `Tests caught ${measurements.caught} of ${measurements.injected} injected faults.` };
}

export interface SandboxHandle {
  id: string;
  directory: string;
  isolation: "workspace-directory";
  securityBoundary: false;
  network: "allow" | "deny" | "approval";
  limits: { cpu: number | null; ramMb: number | null; diskMb: number | null; processes: number | null; timeoutMs: number };
  enforced: { cpu: false; ram: false; timeout: true };
}

export class LocalSandbox {
  constructor(private readonly home: string, private readonly runner: CommandRunner) {}

  create(id: string): SandboxHandle {
    const directory = path.join(this.home, "sandboxes", id);
    fs.mkdirSync(directory, { recursive: true });
    const handle: SandboxHandle = {
      id,
      directory,
      isolation: "workspace-directory",
      securityBoundary: false,
      network: "deny",
      limits: { cpu: null, ramMb: null, diskMb: null, processes: null, timeoutMs: 30000 },
      enforced: { cpu: false, ram: false, timeout: true },
    };
    this.writeHandle(handle);
    return handle;
  }

  destroy(id: string): void {
    fs.rmSync(path.join(this.home, "sandboxes", id), { recursive: true, force: true });
  }

  readFile(id: string, file: string): string {
    return fs.readFileSync(this.safe(id, file), "utf8");
  }

  writeFile(id: string, file: string, content: string): void {
    const target = this.safe(id, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  snapshot(id: string): string {
    const snap = path.join(this.home, "sandboxes", id, ".snapshots", String(Date.now()));
    copyDir(this.handle(id).directory, snap, new Set([".snapshots", "handle.json"]));
    return snap;
  }

  restore(id: string, snapshotPath: string): void {
    const directory = this.handle(id).directory;
    for (const entry of fs.readdirSync(directory)) {
      if (entry === ".snapshots" || entry === "handle.json") continue;
      fs.rmSync(path.join(directory, entry), { recursive: true, force: true });
    }
    copyDir(snapshotPath, directory, new Set());
  }

  networkPolicy(id: string, network: SandboxHandle["network"]): SandboxHandle {
    const handle = this.handle(id);
    handle.network = network;
    this.writeHandle(handle);
    return handle;
  }

  resourceLimits(id: string, limits: Partial<SandboxHandle["limits"]>): SandboxHandle {
    const handle = this.handle(id);
    handle.limits = { ...handle.limits, ...limits };
    this.writeHandle(handle);
    return handle;
  }

  exec(id: string, command: string, args: string[]): { blocked: boolean; reason: string; result?: ReturnType<CommandRunner["run"]> } {
    const handle = this.handle(id);
    if (handle.network === "deny" && args.concat(command).join(" ").match(/\b(curl|wget|nc|ssh)\b/)) {
      return { blocked: true, reason: "Network policy is deny." };
    }
    const result = this.runner.run(command, args, handle.directory, handle.limits.timeoutMs);
    return { blocked: false, reason: "Command runner finished.", result };
  }

  private handle(id: string): SandboxHandle {
    return JSON.parse(fs.readFileSync(path.join(this.home, "sandboxes", id, "handle.json"), "utf8")) as SandboxHandle;
  }

  private writeHandle(handle: SandboxHandle): void {
    fs.writeFileSync(path.join(handle.directory, "handle.json"), JSON.stringify(handle, null, 2));
  }

  private safe(id: string, file: string): string {
    const directory = path.resolve(this.handle(id).directory);
    const target = path.resolve(directory, file);
    if (target !== directory && !target.startsWith(`${directory}${path.sep}`)) {
      throw new Error("Sandbox path escapes the workspace directory.");
    }
    return target;
  }
}

function copyDir(from: string, to: string, skip: Set<string>): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target, skip);
    else if (entry.isFile()) fs.copyFileSync(source, target);
  }
}

export function listWorktrees(root: string, runner: CommandRunner): { ok: boolean; output: string } {
  const result = runner.run("git", ["worktree", "list"], root, 10000);
  return { ok: result.exitCode === 0, output: result.stdout || result.stderr };
}
