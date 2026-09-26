import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CommandModelRunner, parseRunnerArgs, redactSecrets, safeModelName } from "./model-runner";
import type { ReviewFinding } from "./reviewer";
import type { BmadRunnerConfig, CommandRunner, ControlConfig } from "./types";

export const ATTACK_PROMPT_VERSION = "attack-v1";

export type AttackStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_CONFIGURED";
export type AttackCode = "ATTACK_FAILURE" | "ATTACK_CORRECTNESS" | "ATTACK_SECURITY" | "ATTACK_EDGE_CASE" | "ATTACK_RECOVERY";

export interface AttackContext {
  missionId: string;
  missionTitle: string;
  ticketRef: string;
  ticketTitle: string;
  requirements: Array<{ id: string; title: string; acceptanceCriteria: string[] }>;
  architecture: Array<{ id: string; choice: string }>;
  risk: string;
  changedFiles: string[];
  diff: string;
  tests: { result: string; exitCode: number | null; command: string } | null;
  reviewFindings: Array<{ id: string; severity: string; message: string }>;
  worktree: string;
}

export interface AttackFinding extends ReviewFinding {
  code: AttackCode;
}

export interface AttackResult {
  status: AttackStatus;
  findings: AttackFinding[];
  summary: string;
  promptVersion: string;
  promptHash: string;
  attackerId: string;
  model: string | null;
  durationMs: number | null;
  exitCode: number | null;
}

export interface AttackRunner {
  id: string;
  available(): boolean;
  attack(context: AttackContext): Promise<AttackResult>;
  attackSync(context: AttackContext): AttackResult;
}

export function resolveAttackerConfig(config: ControlConfig, env: NodeJS.ProcessEnv = process.env): BmadRunnerConfig | null {
  const model = safeModelName(env.BMAD_ATTACK_MODEL) ?? config.attacker?.model ?? null;
  const timeoutFromEnv = Number(env.BMAD_ATTACK_TIMEOUT);
  const envTimeout = Number.isFinite(timeoutFromEnv) && timeoutFromEnv > 0 ? timeoutFromEnv : null;
  if (config.attacker?.command.trim()) {
    return {
      command: config.attacker.command.trim(),
      args: config.attacker.args ?? [],
      cwd: config.attacker.cwd,
      timeoutMs: config.attacker.timeoutMs && config.attacker.timeoutMs > 0 ? config.attacker.timeoutMs : envTimeout ?? 120000,
      model,
    };
  }
  const command = (env.BMAD_ATTACK_RUNNER ?? "").trim();
  if (!command || /\s/.test(command)) return null;
  return {
    command,
    args: parseRunnerArgs(env.BMAD_ATTACKER_ARGS),
    timeoutMs: envTimeout ?? 120000,
    model,
  };
}

export function attackPrompt(context: AttackContext): string {
  const body = [
    "You are attacking an implementation. Attempt to demonstrate that it does not satisfy its requirements.",
    "",
    "You are read-only. Do not write, commit, push, or deploy.",
    "",
    "Investigate edge cases, invalid input, error handling, boundary conditions, security, concurrency, state transitions, data integrity, failure recovery, requirement gaps, and architecture violations.",
    "",
    "A passing test suite is not an attack pass. An empty note is not an attack pass. Return only JSON.",
    "",
    `Prompt version: ${ATTACK_PROMPT_VERSION}`,
    `Mission: ${context.missionTitle}`,
    `Ticket: ${context.ticketRef} ${context.ticketTitle}`,
    `Worktree: ${context.worktree}`,
    `Risk: ${context.risk}`,
    "",
    "Requirements:",
    context.requirements.map((requirement) => `${requirement.id} ${requirement.title}\n${requirement.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`).join("\n\n") || "(none)",
    "",
    "Architecture:",
    context.architecture.map((item) => `${item.id}: ${item.choice}`).join("\n") || "(none)",
    "",
    "Changed files:",
    context.changedFiles.join("\n") || "(none)",
    "",
    "Tests:",
    context.tests ? `${context.tests.command} ${context.tests.result} exit ${String(context.tests.exitCode)}` : "(none)",
    "",
    "Review findings:",
    context.reviewFindings.map((finding) => `${finding.id} ${finding.severity} ${finding.message}`).join("\n") || "(none)",
    "",
    "Diff:",
    context.diff || "(empty)",
    "",
    'JSON shape: {"status":"PASS|FAIL","summary":"...","findings":[{"id":"ATT-001","severity":"high","category":"correctness|security|edge-case|recovery","message":"...","file":"...","line":1}]}',
  ].join("\n");
  return redactSecrets(body);
}

export function attackCode(category: string): AttackCode {
  if (category === "correctness") return "ATTACK_CORRECTNESS";
  if (category === "security") return "ATTACK_SECURITY";
  if (category === "edge-case") return "ATTACK_EDGE_CASE";
  if (category === "recovery") return "ATTACK_RECOVERY";
  return "ATTACK_FAILURE";
}

export interface AttackJudgeInput {
  raw: string;
  processStatus: "completed" | "failed" | "timeout" | "not-configured";
  exitCode: number | null;
  attackerId: string;
  model: string | null;
  durationMs: number | null;
  prompt: string;
}

export function judgeAttack(input: AttackJudgeInput): AttackResult {
  const promptHash = crypto.createHash("sha256").update(input.prompt).digest("hex");
  const base: AttackResult = {
    status: "BLOCKED",
    findings: [],
    summary: "status: blocked",
    promptVersion: ATTACK_PROMPT_VERSION,
    promptHash,
    attackerId: input.attackerId,
    model: input.model,
    durationMs: input.durationMs,
    exitCode: input.exitCode,
  };
  if (input.processStatus === "not-configured") {
    return { ...base, status: "NOT_CONFIGURED", summary: "status: blocked\nNo attacker executed. A passing review is not an attack pass." };
  }
  if (input.processStatus === "timeout") {
    return { ...base, summary: "status: blocked\nAttack timed out before a valid result." };
  }
  if (input.processStatus !== "completed" || input.exitCode !== 0) {
    return { ...base, summary: "status: blocked\nAttack process did not complete." };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = extractJson(input.raw);
  } catch {
    return { ...base, summary: "status: blocked\nAttack output is not valid JSON." };
  }
  if (parsed.status !== "PASS" && parsed.status !== "FAIL") {
    return { ...base, summary: "status: blocked\nAttack JSON has no PASS or FAIL status." };
  }
  const findings = parseAttackFindings(parsed.findings);
  if (!findings) return { ...base, summary: "status: blocked\nAttack findings are not valid." };
  const summary = typeof parsed.summary === "string" && parsed.summary.trim() ? redactSecrets(parsed.summary.trim()) : "Attack returned no summary.";
  const blocking = findings.some((finding) => finding.severity === "high" || finding.severity === "critical");
  if (parsed.status === "FAIL" || blocking) {
    return { ...base, status: "FAIL", findings, summary };
  }
  return { ...base, status: "PASS", findings, summary };
}

export function downgradeAttack(result: AttackResult, options: { evidenceExists?: boolean; worktreeMutated?: boolean }): AttackResult {
  if (options.worktreeMutated) {
    return { ...result, status: "BLOCKED", summary: "Attacker modified the worktree. The attacker is read-only, so this attack is blocked." };
  }
  if (result.status === "PASS" && options.evidenceExists === false) {
    return { ...result, status: "BLOCKED", summary: "Attack PASS was rejected because the attack evidence file is missing." };
  }
  return result;
}

export class CommandAttacker implements AttackRunner {
  readonly id: string;
  private readonly runner: CommandModelRunner;

  constructor(
    commandRunner: CommandRunner,
    private readonly config: BmadRunnerConfig | null,
    private readonly root: string,
  ) {
    this.runner = new CommandModelRunner(commandRunner, config, root);
    this.id = config?.command ?? "unconfigured";
  }

  available(): boolean {
    return this.runner.isAvailable();
  }

  attack(context: AttackContext): Promise<AttackResult> {
    return Promise.resolve(this.attackSync(context));
  }

  attackSync(context: AttackContext): AttackResult {
    const prompt = attackPrompt(context);
    if (!this.config?.command || !this.available()) {
      return judgeAttack({ raw: "", processStatus: "not-configured", exitCode: null, attackerId: this.id, model: this.config?.model ?? null, durationMs: null, prompt });
    }
    const scratch = path.join(this.root, ".bmad-next", "missions", context.missionId, "attack-cwd");
    fs.mkdirSync(scratch, { recursive: true });
    const result = this.runner.runSync({
      skillId: "bmad-attack",
      prompt,
      input: "",
      cwd: scratch,
      timeoutMs: this.config.timeoutMs ?? 120000,
    });
    return judgeAttack({
      raw: result.stdout,
      processStatus: result.status,
      exitCode: result.exitCode,
      attackerId: this.id,
      model: this.config.model ?? null,
      durationMs: result.durationMs ?? null,
      prompt,
    });
  }
}

/** Test-only attacker. The production plane does not construct it. */
export class DeterministicAttacker implements AttackRunner {
  readonly id = "deterministic-test-attacker";
  readonly prompts: string[] = [];
  private index = 0;

  constructor(private readonly script: Array<"pass" | "fail" | "invalid" | "timeout" | "high" | "critical" | "unavailable">) {}

  available(): boolean {
    return this.script[Math.min(this.index, Math.max(this.script.length - 1, 0))] !== "unavailable";
  }

  attack(context: AttackContext): Promise<AttackResult> {
    return Promise.resolve(this.attackSync(context));
  }

  attackSync(context: AttackContext): AttackResult {
    const mode = this.script[Math.min(this.index, Math.max(this.script.length - 1, 0))] ?? "invalid";
    this.index += 1;
    const prompt = attackPrompt(context);
    this.prompts.push(prompt);
    if (mode === "unavailable") {
      return judgeAttack({ raw: "", processStatus: "not-configured", exitCode: null, attackerId: this.id, model: null, durationMs: 1, prompt });
    }
    if (mode === "timeout") {
      return judgeAttack({ raw: "", processStatus: "timeout", exitCode: null, attackerId: this.id, model: null, durationMs: 1, prompt });
    }
    if (mode === "invalid") {
      return judgeAttack({ raw: "not json", processStatus: "completed", exitCode: 0, attackerId: this.id, model: null, durationMs: 1, prompt });
    }
    const finding =
      mode === "pass"
        ? null
        : {
            id: "ATT-001",
            severity: mode === "fail" ? "high" : mode,
            category: mode === "critical" ? "security" : "edge-case",
            message: mode === "critical" ? "health() accepts invalid input." : "health() does not handle invalid input.",
            file: context.changedFiles[0] ?? "src/health.js",
            line: 42,
          };
    return judgeAttack({
      raw: JSON.stringify({
        status: mode === "pass" ? "PASS" : "FAIL",
        summary: mode === "pass" ? "No blocking break of the requirements was shown." : "A blocking break of the requirements was shown.",
        findings: finding ? [finding] : [],
      }),
      processStatus: "completed",
      exitCode: 0,
      attackerId: this.id,
      model: "deterministic-test-attacker",
      durationMs: 2,
      prompt,
    });
  }
}

function extractJson(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("empty");
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced?.[1] ?? trimmed).trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no object");
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
  return parsed as Record<string, unknown>;
}

function parseAttackFindings(value: unknown): AttackFinding[] | null {
  if (!Array.isArray(value)) return null;
  const findings: AttackFinding[] = [];
  const severities = new Set(["info", "low", "medium", "high", "critical"]);
  const categories = new Set(["correctness", "security", "edge-case", "recovery", "requirements", "architecture"]);
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    if (typeof record.message !== "string" || !record.message.trim()) return null;
    if (typeof record.severity !== "string" || !severities.has(record.severity)) return null;
    if (typeof record.category !== "string" || !categories.has(record.category)) return null;
    const category = record.category === "recovery" ? "edge-case" : record.category;
    findings.push({
      id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : `ATT-${String(index + 1).padStart(3, "0")}`,
      severity: record.severity as AttackFinding["severity"],
      category: category as AttackFinding["category"],
      code: attackCode(record.category),
      message: redactSecrets(record.message.trim()),
      file: typeof record.file === "string" ? record.file : undefined,
      line: typeof record.line === "number" ? record.line : undefined,
      repair: typeof record.repair === "string" ? redactSecrets(record.repair) : `Repair the ${record.category} break in ${typeof record.file === "string" ? record.file : "the change"}.`,
    });
  }
  return findings;
}
