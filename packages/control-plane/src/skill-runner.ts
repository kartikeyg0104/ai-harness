import fs from "node:fs";
import path from "node:path";
import { BMAD_METHOD_PIN, skillById, type SkillDescriptor } from "./catalog";
import { CommandModelRunner, parseRunnerArgs, redactSecrets, safeModelName } from "./model-runner";
import type { BmadRunResult, BmadRunnerConfig, CommandRunner, ControlConfig, SkillRunStatus } from "./types";

export interface SkillContract {
  id: string;
  origin: string;
  summary: string;
  headless: boolean;
  commit: string;
  successShape: string;
}

export interface SkillValidation {
  status: SkillRunStatus;
  reason: string;
  files: string[];
}

const HEADLESS = new Set(["bmad-spec", "bmad-prd", "bmad-product-brief"]);
const SPEC_BLOCKED = new Set(["insufficient_intent", "missing_slug"]);

export function resolveRunnerConfig(config: ControlConfig, env: NodeJS.ProcessEnv = process.env): BmadRunnerConfig | null {
  const model = safeModelName(env.BMAD_MODEL);
  const timeoutFromEnv = Number(env.BMAD_RUNNER_TIMEOUT);
  const envTimeout = Number.isFinite(timeoutFromEnv) && timeoutFromEnv > 0 ? timeoutFromEnv : null;
  if (config.runner?.command.trim()) {
    return {
      command: config.runner.command.trim(),
      args: config.runner.args ?? [],
      cwd: config.runner.cwd,
      timeoutMs: config.runner.timeoutMs && config.runner.timeoutMs > 0 ? config.runner.timeoutMs : envTimeout ?? 120000,
      model,
    };
  }
  const command = (config.runnerCommand ?? env.BMAD_RUNNER ?? "").trim();
  if (!command || /\s/.test(command)) return null;
  return {
    command,
    args: parseRunnerArgs(env.BMAD_RUNNER_ARGS),
    timeoutMs: envTimeout ?? 120000,
    model,
  };
}

export function resolveRuntimeId(config: ControlConfig, env: NodeJS.ProcessEnv = process.env): string | null {
  const selected = (config.defaultRuntime ?? env.BMAD_RUNTIME ?? "").trim();
  return selected || null;
}

/**
 * Headless success and blocked shapes from BMAD-METHOD
 * skills/bmad-spec/assets/headless-schemas.md at the pinned commit.
 * The skill prose is not copied here.
 */
export class BmadRunner {
  constructor(private readonly runner: CommandRunner, private readonly root: string) {}

  resolveSkill(skillId: string): SkillDescriptor | null {
    return skillById(skillId) ?? null;
  }

  loadSkillContract(skillId: string): SkillContract {
    const skill = this.resolveSkill(skillId);
    if (!skill) throw new Error(`Unknown skill ${skillId}.`);
    return {
      id: skill.id,
      origin: skill.origin,
      summary: skill.summary,
      headless: HEADLESS.has(skill.id),
      commit: BMAD_METHOD_PIN.commit,
      successShape: HEADLESS.has(skill.id)
        ? "Pinned headless JSON: status complete and a files array whose paths exist. bmad-spec must name SPEC.md."
        : "Non-empty skill output. Selection alone is not completion.",
    };
  }

  validateSkillInput(skillId: string, input: string): { ok: boolean; reason: string } {
    this.loadSkillContract(skillId);
    if (!input.trim()) return { ok: false, reason: "Skill input is empty." };
    if (skillId === "bmad-spec" && input.trim().length < 12) {
      return { ok: false, reason: "Spec input is too thin to distill." };
    }
    return { ok: true, reason: "Input is present." };
  }

  validateSkillOutput(skillId: string, stdout: string, exitCode: number | null, timedOut = false): SkillValidation {
    this.loadSkillContract(skillId);
    if (timedOut) return { status: "timeout", reason: "Skill runner timed out.", files: [] };
    if (exitCode !== 0) return { status: "failed", reason: "Skill runner exited non-zero.", files: [] };
    if (!stdout.trim()) return { status: "output-missing", reason: "Skill runner wrote no output.", files: [] };
    if (!HEADLESS.has(skillId)) return { status: "completed", reason: "Runner wrote skill output.", files: [] };
    let parsed: { status?: string; files?: unknown; error_code?: string; reason?: string; prd?: string };
    try {
      parsed = JSON.parse(stdout) as { status?: string; files?: unknown; error_code?: string; reason?: string; prd?: string };
    } catch {
      return { status: "output-invalid", reason: "Headless skill output is not the JSON contract.", files: [] };
    }
    if (parsed.status === "blocked" || parsed.status === "partial") {
      if (skillId === "bmad-spec" && parsed.error_code && !SPEC_BLOCKED.has(parsed.error_code)) {
        return { status: "output-invalid", reason: `Unknown spec error_code ${parsed.error_code}.`, files: [] };
      }
      return { status: "failed", reason: parsed.reason ?? `Skill status is ${parsed.status}.`, files: [] };
    }
    if (parsed.status !== "complete") return { status: "output-invalid", reason: "Headless skill status is not complete.", files: [] };
    const named = Array.isArray(parsed.files) ? parsed.files.filter((file): file is string => typeof file === "string") : parsed.prd ? [parsed.prd] : [];
    if (named.length === 0) return { status: "output-invalid", reason: "Complete skill output names no files.", files: [] };
    const files = named.map((file) => (path.isAbsolute(file) ? file : path.join(this.root, file)));
    const missing = files.filter((file) => !fs.existsSync(file));
    if (missing.length > 0) return { status: "missing-artifact", reason: `Skill named missing files: ${missing.join(", ")}`, files };
    if (skillId === "bmad-spec" && !files.some((file) => path.basename(file) === "SPEC.md")) {
      return { status: "output-invalid", reason: "bmad-spec completion must name SPEC.md.", files };
    }
    return { status: "completed", reason: "Headless contract matched and named files exist.", files };
  }

  execute(skillId: string, input: string, config: BmadRunnerConfig | null, missionId: string, ticketRef: string | null = null): BmadRunResult {
    const contract = this.loadSkillContract(skillId);
    const inputCheck = this.validateSkillInput(skillId, input);
    if (!inputCheck.ok) {
      return { status: "failed", exitCode: null, stdout: "", stderr: inputCheck.reason };
    }
    if (!config?.command) {
      return { status: "not-configured", exitCode: null, stdout: "", stderr: `Skill ${contract.id} is resolved. No BMAD runner is configured.` };
    }
    const inputPath = path.join(".bmad-next", "missions", missionId, "context", `${skillId}.md`);
    const prompt = skillPrompt(contract, input, this.root, missionId);
    this.writeArtifact(inputPath, prompt);
    const cwd = config.cwd ?? this.root;
    const model = new CommandModelRunner(this.runner, config, this.root);
    const startedAt = new Date().toISOString();
    const result = model.runSync({
      skillId,
      system: contract.summary,
      prompt,
      input: path.join(this.root, inputPath),
      cwd,
      timeoutMs: config.timeoutMs ?? 120000,
    });
    const endedAt = new Date().toISOString();
    if (result.status === "not-configured") {
      return { status: "not-configured", exitCode: null, stdout: "", stderr: result.stderr, durationMs: result.durationMs };
    }
    const validation = this.validateSkillOutput(skillId, result.stdout, result.exitCode, result.status === "timeout");
    const outputPath = path.join(".bmad-next", "missions", missionId, "artifacts", `${skillId}.md`);
    this.writeArtifact(outputPath, result.stdout);
    const status = toRunStatus(validation.status);
    const provenancePath = path.join(".bmad-next", "missions", missionId, "artifacts", `${skillId}.provenance.json`);
    const named = status === "completed" ? (validation.files[0] ?? outputPath) : outputPath;
    this.writeArtifact(provenancePath, JSON.stringify({
      skill: skillId,
      commit: contract.commit,
      skillId,
      runner: redactSecrets(config.command),
      args: (config.args ?? []).map((arg) => redactSecrets(arg === "{prompt}" ? "[prompt]" : arg)),
      model: config.model ?? null,
      startedAt,
      endedAt,
      exitCode: result.exitCode,
      durationMs: result.durationMs ?? null,
      missionId,
      ticketRef,
      timestamp: endedAt,
      inputPath,
      outputPath: named,
      artifactPaths: status === "completed" ? validation.files : [],
      status,
    }, null, 2));
    return {
      status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      artifactPath: status === "completed" ? (validation.files[0] ?? path.join(this.root, outputPath)) : undefined,
      durationMs: result.durationMs,
    };
  }

  writeArtifact(relativePath: string, body: string): string {
    const target = path.isAbsolute(relativePath) ? relativePath : path.join(this.root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    return target;
  }
}

function skillPrompt(contract: SkillContract, missionInput: string, workspace: string, missionId: string): string {
  const specPaths = contract.id === "bmad-spec"
    ? [
        `Write these files in the workspace:`,
        `_bmad-output/specs/${missionId}/SPEC.md`,
        `_bmad-output/specs/${missionId}/.memlog.md`,
        "SPEC.md is the specification. .memlog.md is the decision log.",
      ]
    : ["Write every file you name in the JSON files array."];
  return [
    `Skill: ${contract.id}`,
    `BMAD commit: ${contract.commit}`,
    `Origin: ${contract.origin}`,
    `Summary: ${contract.summary}`,
    `Workspace: ${workspace}`,
    `Required result: ${contract.successShape}`,
    ...specPaths,
    "Your stdout must be one JSON object and no other text.",
    'Success JSON: {"status":"complete","files":["relative/path"]}',
    "Every path in files must exist on disk before you reply.",
    contract.id === "bmad-spec" ? "One of those paths must be named SPEC.md. Also write .memlog.md and name it." : "",
    'If the intent is too thin: {"status":"blocked","error_code":"insufficient_intent","reason":"..."}',
    "A sentence that says complete is not completion. The control plane checks the JSON and the files.",
    "",
    "Mission input:",
    missionInput,
  ].filter((line) => line !== "").join("\n");
}

function toRunStatus(status: SkillRunStatus): BmadRunResult["status"] {
  if (status === "completed") return "completed";
  if (status === "timeout") return "timeout";
  if (status === "output-invalid") return "output-invalid";
  if (status === "output-missing") return "output-missing";
  if (status === "missing-artifact") return "missing-artifact";
  if (status === "resolved" || status === "started") return "running";
  return "failed";
}
