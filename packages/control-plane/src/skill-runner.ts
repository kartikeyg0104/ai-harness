import fs from "node:fs";
import path from "node:path";
import { BMAD_METHOD_PIN, skillById, type SkillDescriptor } from "./catalog";
import { CommandModelRunner, lastJsonObject, parseRunnerArgs, redactSecrets, safeModelName } from "./model-runner";
import type { ArchitectureDecision, BmadRunResult, BmadRunnerConfig, CommandRunner, ControlConfig, SkillRunStatus } from "./types";

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

const HEADLESS = new Set(["bmad-spec", "bmad-prd", "bmad-product-brief", "bmad-architecture", "bmad-project-context", "bmad-ux"]);
/** Kinds verifyArchitectureTree can check against the tree. Anything else cannot be verified, so it is refused. */
export const ARCHITECTURE_KINDS = new Set(["component", "layer", "technology", "forbidden"]);
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
/** Reads declarations written by bmad-architecture. Returns a reason string when the file cannot be trusted. */
export function readArchitectureDeclarations(file: string): ArchitectureDecision[] | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return "architecture.json is not valid JSON.";
  }
  const list = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { declarations?: unknown }).declarations : parsed;
  if (!Array.isArray(list) || list.length === 0) return "architecture.json declares nothing.";
  const declarations: ArchitectureDecision[] = [];
  for (const [index, item] of list.entries()) {
    if (!item || typeof item !== "object") return "architecture.json has a declaration that is not an object.";
    const record = item as Record<string, unknown>;
    const kind = typeof record.kind === "string" ? record.kind.trim().toLowerCase() : "";
    const choice = typeof record.choice === "string" ? record.choice.trim() : "";
    if (!ARCHITECTURE_KINDS.has(kind)) return `architecture.json kind ${String(record.kind)} cannot be verified. Use component, layer, technology, or forbidden.`;
    if (!choice || path.isAbsolute(choice) || choice.split(/[\\/]/).includes("..")) return `architecture.json declaration ${index + 1} has no usable choice.`;
    declarations.push({
      id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : `ARCH-${String(index + 1).padStart(3, "0")}`,
      kind,
      choice,
      alternatives: Array.isArray(record.alternatives) ? record.alternatives.filter((value): value is string => typeof value === "string") : [],
    });
  }
  if (!declarations.some((item) => item.kind === "component" || item.kind === "layer")) return "architecture.json declares no component or layer to verify.";
  return declarations;
}

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

  validateSkillOutput(skillId: string, stdout: string, exitCode: number | null, timedOut = false, missionId?: string): SkillValidation {
    this.loadSkillContract(skillId);
    if (timedOut) return { status: "timeout", reason: "Skill runner timed out.", files: [] };
    if (exitCode !== 0) return { status: "failed", reason: "Skill runner exited non-zero.", files: [] };
    if (!stdout.trim()) return { status: "output-missing", reason: "Skill runner wrote no output.", files: [] };
    if (!HEADLESS.has(skillId)) return { status: "completed", reason: "Runner wrote skill output.", files: [] };
    const parsed = lastJsonObject(stdout) as { status?: string; files?: unknown; error_code?: string; reason?: string; prd?: string } | null;
    if (!parsed || typeof parsed.status !== "string") {
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
    const outputRoot = path.join(this.root, "_bmad-output") + path.sep;
    const outside = files.filter((file) => !path.resolve(file).startsWith(outputRoot));
    if (outside.length > 0) return { status: "output-invalid", reason: `Skill artifacts must live under _bmad-output; named ${outside.map((file) => path.relative(this.root, file)).join(", ")}.`, files };
    const missing = files.filter((file) => !fs.existsSync(file));
    if (missing.length > 0) {
      const required = missionId ? requiredSkillFiles(skillId, missionId).map((file) => path.join(this.root, file)) : [];
      if (required.length > 0 && required.every((file) => fs.existsSync(file))) {
        if (skillId === "bmad-architecture") {
          const declarations = required.find((file) => path.basename(file) === "architecture.json");
          const parsedDeclarations = declarations ? readArchitectureDeclarations(declarations) : "architecture.json is missing.";
          if (typeof parsedDeclarations === "string") return { status: "output-invalid", reason: parsedDeclarations, files: required };
        }
        return { status: "completed", reason: "Required skill artifacts exist on disk. The JSON files list named a path that was missing.", files: required };
      }
      return { status: "missing-artifact", reason: `Skill named missing files: ${missing.join(", ")}`, files };
    }
    if (skillId === "bmad-spec" && !files.some((file) => path.basename(file) === "SPEC.md")) {
      return { status: "output-invalid", reason: "bmad-spec completion must name SPEC.md.", files };
    }
    if (skillId === "bmad-architecture") {
      const declarations = files.find((file) => path.basename(file) === "architecture.json");
      if (!declarations) return { status: "output-invalid", reason: "bmad-architecture completion must name architecture.json.", files };
      const parsed = readArchitectureDeclarations(declarations);
      if (typeof parsed === "string") return { status: "output-invalid", reason: parsed, files };
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
    const validation = this.validateSkillOutput(skillId, result.stdout, result.exitCode, result.status === "timeout", missionId);
    const outputPath = path.join(".bmad-next", "missions", missionId, "artifacts", `${skillId}.md`);
    this.writeArtifact(outputPath, result.stdout);
    const status = toRunStatus(validation.status);
    // The runner's own error is the only record of why it exited non-zero; keep it with the run.
    const stderr = redactSecrets(result.stderr.replace(/\u001b\[[0-9;]*m/g, "")).trim().slice(-4000);
    const cause = status === "completed" ? "" : (stderr.split("\n").reverse().find((line) => /error/i.test(line)) ?? stderr.split("\n").at(-1) ?? "").trim().slice(0, 300);
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
      ...(status === "completed" || !stderr ? {} : { stderr }),
    }, null, 2));
    return {
      status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      reason: cause && validation.reason ? `${validation.reason} ${cause}` : validation.reason,
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

/** Installed upstream SKILL.md for this skill, relative to the workspace, when the BMad installer placed one. */
export function installedSkillPath(workspace: string, skillId: string): string | null {
  const candidates = [path.join(".claude", "skills", skillId, "SKILL.md"), path.join(".agents", "skills", skillId, "SKILL.md")];
  const manifest = path.join(workspace, "_bmad", "_config", "skill-manifest.csv");
  if (fs.existsSync(manifest)) {
    const row = fs.readFileSync(manifest, "utf8").split("\n").find((line) => line.startsWith(`"${skillId}",`));
    const listed = row?.match(/"([^"]+SKILL\.md)"\s*$/)?.[1];
    if (listed) candidates.push(listed);
  }
  return candidates.find((candidate) => fs.existsSync(path.join(workspace, candidate))) ?? null;
}

/** Canonical files a completed headless skill must leave on disk. */
export function requiredSkillFiles(skillId: string, missionId: string): string[] {
  if (skillId === "bmad-spec") return [`_bmad-output/specs/${missionId}/SPEC.md`, `_bmad-output/specs/${missionId}/.memlog.md`];
  if (skillId === "bmad-prd") return [`_bmad-output/planning/${missionId}/PRD.md`];
  if (skillId === "bmad-architecture") {
    return [`_bmad-output/architecture/${missionId}/ARCHITECTURE.md`, `_bmad-output/architecture/${missionId}/architecture.json`];
  }
  if (skillId === "bmad-project-context") return [`_bmad-output/project-context/${missionId}/project-context.md`];
  if (skillId === "bmad-ux") return [`_bmad-output/ux/${missionId}/UX.md`];
  return [];
}

function outputPaths(skillId: string, missionId: string): string[] {
  if (skillId === "bmad-spec") {
    return [
      `Write these files in the workspace:`,
      `_bmad-output/specs/${missionId}/SPEC.md`,
      `_bmad-output/specs/${missionId}/.memlog.md`,
      "SPEC.md is the specification. .memlog.md is the decision log.",
    ];
  }
  if (skillId === "bmad-architecture") {
    return [
      "Write these files in the workspace:",
      `_bmad-output/architecture/${missionId}/ARCHITECTURE.md`,
      `_bmad-output/architecture/${missionId}/architecture.json`,
      "ARCHITECTURE.md is the architecture document. architecture.json is what the control plane verifies against the implementation tree:",
      '{"declarations":[{"id":"LAYER-1","kind":"layer","choice":"<directory the implementation lives in>"},{"id":"CMP-1","kind":"component","choice":"<directory>/<file>"},{"id":"TECH-1","kind":"technology","choice":"node"},{"id":"FORB-1","kind":"forbidden","choice":"<npm package that must not be added>"}]}',
      "kind is exactly one of component, layer, technology, forbidden. layer is a directory relative to the repository root. component is a file path the implementation will contain.",
      "technology is node, typescript, python, or an npm dependency name the implementation declares. Declare only what the implementation will really contain; the check fails on anything missing.",
      "Browser verification serves the layer directory as static files; nothing is installed or built first. A web page must therefore run from plain HTML, CSS, and browser JavaScript, unless this repository already builds that app.",
      "Name both files in the JSON files array.",
    ];
  }
  if (skillId === "bmad-prd") {
    return [`Write the PRD to _bmad-output/planning/${missionId}/PRD.md and name it in the JSON files array.`];
  }
  if (skillId === "bmad-project-context") {
    return [
      `Write the project context block to _bmad-output/project-context/${missionId}/project-context.md and name it in the JSON files array.`,
      "It records how agents should work in this repository: stack, layout, conventions, test commands, and pitfalls, read from the existing code.",
      "This is documentation only. Do not create or change application code, and do not edit AGENTS.md or any file outside _bmad-output.",
    ];
  }
  if (skillId === "bmad-ux") {
    return [`Write the UX design to _bmad-output/ux/${missionId}/UX.md and name it in the JSON files array. Documentation only; do not write application code.`];
  }
  return ["Write every file you name in the JSON files array. Write only under _bmad-output."];
}

function skillPrompt(contract: SkillContract, missionInput: string, workspace: string, missionId: string): string {
  const installed = installedSkillPath(workspace, contract.id);
  return [
    `Skill: ${contract.id}`,
    `BMAD commit: ${contract.commit}`,
    `Origin: ${contract.origin}`,
    `Summary: ${contract.summary}`,
    installed
      ? `Installed upstream skill: ${path.join(workspace, installed)}. Read it and apply its method in headless mode: make reasonable assumptions, record them, and do not ask questions.`
      : "",
    `Workspace: ${workspace}`,
    "This is a planning step. Write only under _bmad-output. Application code is written later by the build step in its own worktree.",
    `Required result: ${contract.successShape}`,
    ...outputPaths(contract.id, missionId),
    "Your stdout must be one JSON object and no other text.",
    'Success JSON: {"status":"complete","files":["relative/path"]}',
    "Every path in files must exist on disk before you reply.",
    contract.id === "bmad-spec" ? "One of those paths must be named SPEC.md. Also write .memlog.md and name it." : "",
    contract.id === "bmad-architecture" ? "One of those paths must be named architecture.json." : "",
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
