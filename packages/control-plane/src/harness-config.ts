import fs from "node:fs";
import path from "node:path";

/**
 * Evaluation-mode model configuration. The model is defined in `harness.config.json` at the repository root.
 * `AI_PROVIDER`, `AI_MODEL`, and `AI_BASE_URL` override it without editing the file. The credential is read only
 * from `AI_API_KEY` and is never written to disk: the generated OpenCode config references it as `{env:AI_API_KEY}`.
 */
export interface HarnessConfig {
  runtime: "opencode";
  provider: string;
  model: string;
  baseURL: string;
  temperature: number | null;
  timeoutMs: number;
  workspaceDir: string;
  /** "issue": lean fix workflow (spec, build, test, review, attack). "full": the adaptive BMAD workflow. */
  workflow: "issue" | "full";
}

export const HARNESS_CONFIG_FILE = "harness.config.json";
export const HARNESS_STATE_DIR = ".harness";
/** Provider id for any OpenAI-compatible endpoint named by `baseURL`. */
export const OPENAI_COMPATIBLE = "openai-compatible";

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  runtime: "opencode",
  provider: "nvidia",
  model: "openai/gpt-oss-20b",
  baseURL: "",
  temperature: 0,
  timeoutMs: 600000,
  workspaceDir: "workspace",
  workflow: "issue",
};

export function loadHarnessConfig(root: string, env: NodeJS.ProcessEnv = process.env): HarnessConfig {
  const file = path.join(root, HARNESS_CONFIG_FILE);
  const stored: Partial<HarnessConfig> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const config: HarnessConfig = { ...DEFAULT_HARNESS_CONFIG, ...stored };
  const pick = (value: string | undefined) => (value ?? "").trim();
  if (pick(env.AI_PROVIDER)) config.provider = pick(env.AI_PROVIDER);
  if (pick(env.AI_MODEL)) config.model = pick(env.AI_MODEL);
  if (pick(env.AI_BASE_URL)) config.baseURL = pick(env.AI_BASE_URL);
  if (pick(env.HARNESS_WORKFLOW)) config.workflow = pick(env.HARNESS_WORKFLOW) as HarnessConfig["workflow"];
  if (config.workflow !== "issue" && config.workflow !== "full") throw new Error(`${HARNESS_CONFIG_FILE}: workflow must be "issue" or "full".`);
  if (config.runtime !== "opencode") throw new Error(`${HARNESS_CONFIG_FILE}: runtime must be "opencode".`);
  if (!config.provider || !config.model) throw new Error(`${HARNESS_CONFIG_FILE}: provider and model are required.`);
  if (config.provider === OPENAI_COMPATIBLE && !config.baseURL) {
    throw new Error(`Provider ${OPENAI_COMPATIBLE} needs baseURL in ${HARNESS_CONFIG_FILE} or AI_BASE_URL.`);
  }
  return config;
}

/** `provider/model` as OpenCode's --model flag expects it. */
export function harnessModelId(config: HarnessConfig): string {
  return `${config.provider}/${config.model}`;
}

/** OpenCode config for the harness. It holds a reference to AI_API_KEY, never the value. */
export function harnessOpenCodeConfig(config: HarnessConfig, hasKey: boolean): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  // Without a key, leave OpenCode's own login (`opencode auth login`) in charge instead of sending an empty key.
  if (hasKey) options.apiKey = "{env:AI_API_KEY}";
  if (config.baseURL) options.baseURL = config.baseURL;
  const provider: Record<string, unknown> = { options };
  if (config.provider === OPENAI_COMPATIBLE) {
    provider.npm = "@ai-sdk/openai-compatible";
    provider.name = "OpenAI-compatible endpoint";
    provider.models = { [config.model]: { name: config.model } };
  }
  const agent: Record<string, unknown> = {};
  if (config.temperature !== null) {
    agent.build = { temperature: config.temperature };
    agent.plan = { temperature: config.temperature };
  }
  return {
    $schema: "https://opencode.ai/config.json",
    model: harnessModelId(config),
    autoupdate: false,
    share: "disabled",
    provider: { [config.provider]: provider },
    agent,
  };
}

/**
 * Writes `.harness/opencode.json` and points the process environment at the configured model, so every runner the
 * control plane starts (skills, build, review, attack) uses the same model and the AI_API_KEY credential.
 * Returns the names of the variables it set. Values are never logged.
 */
export function applyHarnessEnv(root: string, config: HarnessConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  const hasKey = (env.AI_API_KEY ?? "").trim().length > 0;
  const dir = path.join(root, HARNESS_STATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "opencode.json");
  fs.writeFileSync(file, `${JSON.stringify(harnessOpenCodeConfig(config, hasKey), null, 2)}\n`);
  const model = harnessModelId(config);
  const writer = JSON.stringify(["run", "--pure", "--auto", "--format", "default", "--model", model, "{prompt}"]);
  const readOnly = JSON.stringify(["run", "--pure", "--agent", "plan", "--format", "default", "--model", model, "{prompt}"]);
  const timeout = String(config.timeoutMs);
  const values: Record<string, string> = {
    OPENCODE_CONFIG: file,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    BMAD_RUNTIME: "opencode",
    BMAD_MODEL: model,
    BMAD_RUNNER: "opencode",
    BMAD_RUNNER_ARGS: writer,
    BMAD_RUNNER_TIMEOUT: timeout,
    BMAD_REVIEWER_RUNNER: "opencode",
    BMAD_REVIEWER_ARGS: readOnly,
    BMAD_REVIEWER_MODEL: model,
    BMAD_REVIEWER_TIMEOUT: timeout,
    BMAD_ATTACK_RUNNER: "opencode",
    BMAD_ATTACKER_ARGS: readOnly,
    BMAD_ATTACK_MODEL: model,
    BMAD_ATTACK_TIMEOUT: timeout,
  };
  for (const [key, value] of Object.entries(values)) env[key] = value;
  return Object.keys(values);
}
