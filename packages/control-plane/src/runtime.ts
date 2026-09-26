import fs from "node:fs";
import path from "node:path";
import type { CommandRunner, RuntimeAvailability } from "./types";

export interface AgentContext {
  missionId: string;
  ticketRef: string;
  agent: string;
  cwd: string;
  prompt: string;
}

export type RuntimePhase = "STARTING" | "RUNNING" | "EDITING" | "VERIFYING" | "COMPLETED" | "FAILED" | "TIMED_OUT" | "CANCELLED";

export interface AgentRun {
  id: string;
  runtimeId: string;
  status: "started" | "completed" | "failed" | "not-configured" | "timeout" | "cancelled";
  message: string;
  exitCode: number | null;
  artifact?: string;
  stderr?: string;
  durationMs?: number;
  changedFiles?: string[];
  phase?: RuntimePhase;
  phases?: RuntimePhase[];
  completionSignal?: "process-exit" | "terminal-event" | null;
  /** Raw runtime output (for OpenCode, the JSON event stream) kept as evidence of what the agent did. */
  transcript?: string;
}

export interface AgentRuntime {
  id: string;
  capabilities(): Promise<string[]>;
  availability(): RuntimeAvailability;
  start(context: AgentContext): Promise<AgentRun>;
  resume(runId: string): Promise<AgentRun>;
  cancel(runId: string): Promise<void>;
  begin(context: AgentContext): AgentRun;
}

export class UnconfiguredRuntime implements AgentRuntime {
  readonly id = "unconfigured";

  capabilities(): Promise<string[]> {
    return Promise.resolve([]);
  }

  availability(): RuntimeAvailability {
    return "NOT CONFIGURED";
  }

  start(context: AgentContext): Promise<AgentRun> {
    return Promise.resolve(this.begin(context));
  }

  begin(context: AgentContext): AgentRun {
    return {
      id: "",
      runtimeId: this.id,
      status: "not-configured",
      message: `No coding runtime is configured for ${context.ticketRef}.`,
      exitCode: null,
    };
  }

  resume(): Promise<AgentRun> {
    return Promise.resolve(this.begin({ missionId: "", ticketRef: "", agent: "", cwd: "", prompt: "" }));
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

/** CLI adapter. The OpenHands SDK is not imported. Headless CLI: openhands --headless --json -t <task>. */
export class OpenHandsAdapter implements AgentRuntime {
  readonly id = "openhands";

  constructor(private readonly runner: CommandRunner) {}

  capabilities(): Promise<string[]> {
    return Promise.resolve(["code", "shell", "workspace"]);
  }

  availability(): RuntimeAvailability {
    return this.runner.which("openhands") ? "AVAILABLE" : "NOT CONFIGURED";
  }

  start(context: AgentContext): Promise<AgentRun> {
    return Promise.resolve(this.begin(context));
  }

  begin(context: AgentContext): AgentRun {
    if (this.availability() === "NOT CONFIGURED") {
      return {
        id: "",
        runtimeId: this.id,
        status: "not-configured",
        message: "OpenHands is not on PATH. The adapter did not start a run.",
        exitCode: null,
      };
    }
    const result = this.runner.run("openhands", ["--headless", "--json", "-t", context.prompt], context.cwd, 120000);
    const listed = this.runner.run("git", ["status", "--short"], context.cwd, 10000);
    const changedFiles = listed.exitCode === 0 ? listed.stdout.split("\n").map((line) => line.slice(3).trim()).filter((line) => line.length > 0) : [];
    const failed = result.exitCode !== 0 || result.timedOut;
    return {
      id: `openhands-${context.ticketRef}`,
      runtimeId: this.id,
      status: failed ? "failed" : "completed",
      message: (result.stdout || result.stderr).trim() || "OpenHands returned no output.",
      exitCode: result.exitCode,
      stderr: result.stderr,
      durationMs: result.durationMs,
      changedFiles,
    };
  }

  resume(runId: string): Promise<AgentRun> {
    return Promise.resolve({
      id: runId,
      runtimeId: this.id,
      status: "not-configured",
      message: "OpenHands resume is not available from this adapter.",
      exitCode: null,
    });
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

/** CLI adapter for `opencode run`. OpenCode types are not imported. */
export class OpenCodeAdapter implements AgentRuntime {
  readonly id = "opencode";

  constructor(private readonly runner: CommandRunner) {}

  capabilities(): Promise<string[]> {
    return Promise.resolve(["code", "shell", "workspace"]);
  }

  availability(): RuntimeAvailability {
    return this.runner.which("opencode") ? "AVAILABLE" : "NOT CONFIGURED";
  }

  start(context: AgentContext): Promise<AgentRun> {
    return Promise.resolve(this.begin(context));
  }

  begin(context: AgentContext): AgentRun {
    if (this.availability() === "NOT CONFIGURED") {
      return {
        id: "",
        runtimeId: this.id,
        status: "not-configured",
        message: "opencode is not on PATH. The adapter did not start a run.",
        exitCode: null,
      };
    }
    if (!isTicketWorktree(context.cwd)) {
      return {
        id: "",
        runtimeId: this.id,
        status: "failed",
        message: "Coding runtime cwd is not the ticket worktree. The run was refused.",
        exitCode: null,
        changedFiles: [],
      };
    }
    const model = safeRuntimeModel(process.env.BMAD_MODEL);
    const timeout = positiveTimeout(process.env.BMAD_RUNNER_TIMEOUT, 180000);
    const args = ["run", "--pure", "--auto", "--format", "json", "--dir", context.cwd];
    if (model) args.push("--model", model);
    args.push(
      `${context.prompt}\n\nWork only in ${context.cwd}. Write the implementation files and, when the ticket asks for tests, the tests and the package.json that runs them; then stop. If this ticket is a web application, ship a page the browser can open: index.html plus the JavaScript it needs for add, complete, delete, and localStorage persistence. A Node-only module without index.html is not a web app. Put this exact marker in one implementation source file where the program still parses (a // comment in JavaScript, or <!-- BMAD-TICKET-STATUS: built --> in HTML):\n// BMAD-TICKET-STATUS: built\nIf you add a test, use node:test and node:assert/strict and cover add, complete, delete, plus persistence or reload. Do not import expect, beforeAll, or afterAll. Do not keep exploring after the files exist. A chat reply is not completion.`,
    );
    let result = this.runner.run("opencode", args, context.cwd, timeout, { OPENCODE_CONFIG_CONTENT: openCodeStepBound() });
    if (result.exitCode !== 0 && /database is locked/i.test(result.stderr)) {
      result = this.runner.run("opencode", args, context.cwd, timeout, { OPENCODE_CONFIG_CONTENT: openCodeStepBound() });
    }
    const classified = classifyOpenCodeRun({ exitCode: result.exitCode, stdout: result.stdout, timedOut: result.timedOut });
    const listed = this.runner.run("git", ["status", "--short", "--untracked-files=all"], context.cwd, 10000);
    const changedFiles = listed.exitCode === 0 ? listed.stdout.split("\n").map((line) => line.slice(3).trim()).filter((line) => line.length > 0) : [];
    const artifact = changedFiles.map((file) => path.join(context.cwd, file.replace(/\/$/, ""))).find((file) => fs.existsSync(file) && fs.statSync(file).isFile() && /BMAD-TICKET-STATUS:\s*built/.test(fs.readFileSync(file, "utf8")));
    return {
      id: `opencode-${context.ticketRef}`,
      runtimeId: this.id,
      status: classified.status,
      message: [classified.message, result.stderr.trim()].filter((part) => part.length > 0).join("\n"),
      exitCode: result.exitCode,
      artifact,
      stderr: result.stderr,
      durationMs: result.durationMs,
      changedFiles,
      phase: classified.phase,
      phases: classified.phases,
      completionSignal: classified.completionSignal,
      transcript: result.stdout.slice(-2_000_000),
    };
  }

  resume(runId: string): Promise<AgentRun> {
    return Promise.resolve({
      id: runId,
      runtimeId: this.id,
      status: "not-configured",
      message: "OpenCode resume is not available from this adapter.",
      exitCode: null,
    });
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Documented OpenCode bound. `run` exits on session idle; `--auto` approves doom_loop, so the build agent otherwise
 * keeps taking tool steps. There is no CLI step cap. A ticket reads its BMad artifacts and writes the implementation,
 * a package.json, and tests; twenty steps covers that plus one failed call and a correction, and still stops a loop.
 */
export function openCodeStepBound(steps = 20): string {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    agent: { build: { steps } },
  });
}

export function classifyOpenCodeRun(input: { exitCode: number | null; stdout: string; timedOut: boolean }): {
  status: "completed" | "failed" | "timeout";
  phase: RuntimePhase;
  phases: RuntimePhase[];
  terminalReason: string | null;
  completionSignal: "process-exit" | "terminal-event" | null;
  message: string;
} {
  const events = openCodeEvents(input.stdout);
  const terminal = [...events].reverse().find((event) => event.kind === "step_finish");
  const terminalReason = terminal?.reason ?? null;
  const stopped = terminalReason === "stop";
  const phases: RuntimePhase[] = ["STARTING", "RUNNING"];
  if (events.some((event) => event.kind === "edit")) phases.push("EDITING");
  if (stopped && (input.exitCode === 0 || input.timedOut)) {
    phases.push("COMPLETED");
    const reaped = input.timedOut || input.exitCode !== 0;
    return {
      status: "completed",
      phase: "COMPLETED",
      phases,
      terminalReason,
      completionSignal: reaped ? "terminal-event" : "process-exit",
      message: reaped
        ? "OpenCode emitted step_finish reason stop. The process stayed up after that terminal event and was reaped. File changes were not the completion signal."
        : "OpenCode exited after step_finish reason stop.",
    };
  }
  if (input.timedOut) {
    phases.push("TIMED_OUT");
    return {
      status: "timeout",
      phase: "TIMED_OUT",
      phases,
      terminalReason,
      completionSignal: null,
      message: "OpenCode was still running at the timeout. No step_finish reason stop was observed. File changes are not completion.",
    };
  }
  phases.push("FAILED");
  return {
    status: "failed",
    phase: "FAILED",
    phases,
    terminalReason,
    completionSignal: null,
    message:
      input.exitCode === 0
        ? "OpenCode exited 0 without step_finish reason stop. Exit code alone is not completion."
        : `OpenCode exited ${String(input.exitCode)} without step_finish reason stop.`,
  };
}

function openCodeEvents(stdout: string): Array<{ kind: "step_finish" | "edit"; reason: string | null }> {
  const events: Array<{ kind: "step_finish" | "edit"; reason: string | null }> = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    const start = trimmed.indexOf("{");
    if (start < 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed.slice(start));
    } catch {
      continue;
    }
    collectOpenCodeEvent(parsed, events);
  }
  return events;
}

function collectOpenCodeEvent(value: unknown, events: Array<{ kind: "step_finish" | "edit"; reason: string | null }>): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const part = record.part && typeof record.part === "object" ? (record.part as Record<string, unknown>) : null;
  const type = String(record.type ?? part?.type ?? "");
  const reason = typeof part?.reason === "string" ? part.reason : typeof record.reason === "string" ? record.reason : null;
  if (type === "step_finish" || type === "step-finish") events.push({ kind: "step_finish", reason });
  const tool = String(part?.tool ?? record.tool ?? "");
  if (type === "tool" || type === "tool_use" || /write|edit|apply_patch|bash|shell/i.test(tool)) events.push({ kind: "edit", reason: null });
  if (part) collectOpenCodeEvent(part, events);
}

function isTicketWorktree(cwd: string): boolean {
  const resolved = path.resolve(cwd);
  const parts = resolved.split(path.sep);
  const marker = parts.indexOf(".bmad-next");
  return marker >= 0 && parts[marker + 1] === "worktrees" && parts.length > marker + 3;
}

function safeRuntimeModel(value: string | undefined): string | null {
  const model = (value ?? "").trim();
  if (!model || /(api[_-]?key|token|secret|password)/i.test(model)) return null;
  return model;
}

function positiveTimeout(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Process adapter for a coding CLI that is not vendored.
 * Exit 0 is process completion only. The control plane still requires the built protocol in a changed file.
 * A timeout stays timeout. A missing binary stays not-configured.
 */
export class ExternalCliAdapter implements AgentRuntime {
  constructor(
    readonly id: string,
    private readonly binaries: string[],
    private readonly argsFor: (prompt: string) => string[],
    private readonly runner: CommandRunner,
  ) {}

  capabilities(): Promise<string[]> {
    return Promise.resolve(["code", "shell", "workspace"]);
  }

  availability(): RuntimeAvailability {
    return this.binaries.some((binary) => this.runner.which(binary)) ? "AVAILABLE" : "NOT CONFIGURED";
  }

  start(context: AgentContext): Promise<AgentRun> {
    return Promise.resolve(this.begin(context));
  }

  begin(context: AgentContext): AgentRun {
    const binary = this.binaries.find((item) => this.runner.which(item));
    if (!binary) {
      return {
        id: "",
        runtimeId: this.id,
        status: "not-configured",
        message: `${this.binaries.join(" or ")} is not on PATH. The adapter did not start a run.`,
        exitCode: null,
      };
    }
    if (!isTicketWorktree(context.cwd)) {
      return {
        id: "",
        runtimeId: this.id,
        status: "failed",
        message: "Coding runtime cwd is not the ticket worktree. The run was refused.",
        exitCode: null,
        changedFiles: [],
      };
    }
    const timeout = positiveTimeout(process.env.BMAD_RUNNER_TIMEOUT, 180000);
    const result = this.runner.run(binary, this.argsFor(context.prompt), context.cwd, timeout);
    const listed = this.runner.run("git", ["status", "--short", "--untracked-files=all"], context.cwd, 10000);
    const changedFiles = listed.exitCode === 0 ? listed.stdout.split("\n").map((line) => line.slice(3).trim()).filter((line) => line.length > 0) : [];
    if (result.timedOut) {
      return {
        id: `${this.id}-${context.ticketRef}`,
        runtimeId: this.id,
        status: "timeout",
        message: `${binary} was still running at the timeout. File changes are not completion.`,
        exitCode: result.exitCode,
        stderr: result.stderr,
        durationMs: result.durationMs,
        changedFiles,
        phase: "TIMED_OUT",
        completionSignal: null,
      };
    }
    const artifact = changedFiles
      .map((file) => path.join(context.cwd, file.replace(/\/$/, "")))
      .find((file) => fs.existsSync(file) && fs.statSync(file).isFile() && /BMAD-TICKET-STATUS:\s*built/.test(fs.readFileSync(file, "utf8")));
    return {
      id: `${this.id}-${context.ticketRef}`,
      runtimeId: this.id,
      status: result.exitCode === 0 ? "completed" : "failed",
      message: (result.stdout || result.stderr).trim() || `${binary} returned no output.`,
      exitCode: result.exitCode,
      artifact,
      stderr: result.stderr,
      durationMs: result.durationMs,
      changedFiles,
      phase: result.exitCode === 0 ? "COMPLETED" : "FAILED",
      completionSignal: result.exitCode === 0 ? "process-exit" : null,
    };
  }

  resume(runId: string): Promise<AgentRun> {
    return Promise.resolve({
      id: runId,
      runtimeId: this.id,
      status: "not-configured",
      message: `${this.id} resume is not available from this adapter.`,
      exitCode: null,
    });
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

/** Test-only runtime. The production registry does not register it. */
export class DeterministicTestRuntime implements AgentRuntime {
  readonly id = "deterministic-test-provider";
  readonly prompts: string[] = [];
  private cursor = 0;

  constructor(
    private readonly root: string,
    private readonly options: { protocol?: boolean; exitCode?: number; writeArtifact?: boolean; script?: Array<"completed" | "failed" | "timeout"> } = {},
  ) {}

  capabilities(): Promise<string[]> {
    return Promise.resolve(["test-fixture"]);
  }

  availability(): RuntimeAvailability {
    return "CONFIGURED";
  }

  start(context: AgentContext): Promise<AgentRun> {
    return Promise.resolve(this.begin(context));
  }

  begin(context: AgentContext): AgentRun {
    this.prompts.push(context.prompt);
    const scripted = this.options.script?.[Math.min(this.cursor, Math.max((this.options.script?.length ?? 1) - 1, 0))];
    if (this.options.script) this.cursor += 1;
    const exitCode = scripted === "failed" ? 1 : scripted === "timeout" ? null : this.options.exitCode ?? 0;
    const relative = path.join(".bmad-next", "test-runs", `${context.missionId}-${context.ticketRef}.txt`);
    const target = path.join(context.cwd || this.root, relative);
    if (this.options.writeArtifact === false && scripted !== "timeout") {
      return {
        id: `test-${context.ticketRef}`,
        runtimeId: this.id,
        status: exitCode === 0 ? "completed" : "failed",
        message: "Deterministic test provider made no file change. This is not a coding agent.",
        exitCode,
        changedFiles: [],
        phase: exitCode === 0 ? "COMPLETED" : "FAILED",
        completionSignal: exitCode === 0 ? "process-exit" : null,
      };
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const protocol = this.options.protocol ? "\nBMAD-TICKET-STATUS: built\n" : "\n";
    fs.writeFileSync(target, `deterministic-test-provider\n${context.prompt}${protocol}`);
    if (scripted === "timeout") {
      return {
        id: `test-${context.ticketRef}`,
        runtimeId: this.id,
        status: "timeout",
        message: "process still running after the edit",
        exitCode: null,
        artifact: target,
        changedFiles: [relative],
        phase: "TIMED_OUT",
        phases: ["STARTING", "RUNNING", "EDITING", "TIMED_OUT"],
        completionSignal: null,
      };
    }
    return {
      id: `test-${context.ticketRef}`,
      runtimeId: this.id,
      status: exitCode === 0 ? "completed" : "failed",
      message: "Deterministic test provider wrote a local artifact. This is not a coding agent.",
      exitCode,
      artifact: target,
      changedFiles: [relative],
      phase: exitCode === 0 ? "COMPLETED" : "FAILED",
      phases: ["STARTING", "RUNNING", "EDITING", exitCode === 0 ? "COMPLETED" : "FAILED"],
      completionSignal: exitCode === 0 ? "process-exit" : null,
    };
  }

  resume(runId: string): Promise<AgentRun> {
    return Promise.resolve({ id: runId, runtimeId: this.id, status: "completed", message: "already finished", exitCode: 0 });
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

export class RuntimeRegistry {
  private readonly runtimes = new Map<string, AgentRuntime>();

  constructor(runner: CommandRunner) {
    this.runtimes.set("unconfigured", new UnconfiguredRuntime());
    this.runtimes.set("openhands", new OpenHandsAdapter(runner));
    this.runtimes.set("opencode", new OpenCodeAdapter(runner));
    this.runtimes.set("qwen", new ExternalCliAdapter("qwen", ["qwen"], (prompt) => ["-p", prompt], runner));
    this.runtimes.set("goose", new ExternalCliAdapter("goose", ["goose"], (prompt) => ["run", "--text", prompt], runner));
    this.runtimes.set("swe-agent", new ExternalCliAdapter("swe-agent", ["sweagent"], (prompt) => ["run", "--problem_statement.text", prompt], runner));
    this.runtimes.set("mini-swe-agent", new ExternalCliAdapter("mini-swe-agent", ["mini", "mini-swe-agent"], (prompt) => ["-t", prompt, "-y"], runner));
  }

  register(runtime: AgentRuntime): void {
    if (runtime.id === "deterministic-test-provider") {
      this.runtimes.set(runtime.id, runtime);
      return;
    }
    this.runtimes.set(runtime.id, runtime);
  }

  resolve(id: string | null): AgentRuntime {
    if (!id) return this.required("unconfigured");
    return this.runtimes.get(id) ?? this.required("unconfigured");
  }

  availability(id: string): RuntimeAvailability {
    const runtime = this.runtimes.get(id);
    return runtime ? runtime.availability() : "NOT CONFIGURED";
  }

  ids(): string[] {
    return [...this.runtimes.keys()];
  }

  private required(id: string): AgentRuntime {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error(`Runtime ${id} is not registered.`);
    return runtime;
  }
}
