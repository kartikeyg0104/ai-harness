import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { detectArchitectureDrift } from "./analysis";
import { CommandModelRunner, lastJsonObject, redactSecrets, parseRunnerArgs, safeModelName } from "./model-runner";
import type { BmadRunnerConfig, CommandRunner, ControlConfig } from "./types";

export const REVIEW_PROMPT_VERSION = "review-v1";

export type ReviewStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_CONFIGURED";
export type CriterionStatus = "PASS" | "FAIL" | "UNCLEAR";

export interface ReviewContext {
  missionId: string;
  missionTitle: string;
  ticketRef: string;
  ticketTitle: string;
  requirements: Array<{ id: string; title: string; acceptanceCriteria: string[] }>;
  architecture: Array<{ id: string; choice: string }>;
  worktree: string;
  baseCommit: string;
  headCommit: string;
  changedFiles: string[];
  diff: string;
  testEvidence: { result: string; exitCode: number | null; command: string; edgeCases?: "present" | "missing"; failing?: string[]; output?: string; baselineFailed?: boolean } | null;
  followsRepair?: boolean;
  repairAttempt?: number;
}

export interface ReviewFinding {
  id: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  category: "correctness" | "requirements" | "architecture" | "security" | "performance" | "maintainability" | "tests" | "edge-case";
  message: string;
  file?: string;
  line?: number;
  evidence?: string;
  repair?: string;
  declaredRule?: string;
  observedCode?: string;
}

export interface ReviewCriterion {
  requirementId: string;
  criterion: string;
  status: CriterionStatus;
}

export interface ArchitectureDrift {
  file?: string;
  declaredRule: string;
  observedCode: string;
  severity: ReviewFinding["severity"];
}

export interface ReviewQuality {
  findings: number;
  falsePositiveFeedback: number;
  repairSuccess: number;
  reviewDurationMs: number | null;
  modelCost: number | null;
}

export interface ReviewResult {
  status: ReviewStatus;
  findings: ReviewFinding[];
  summary: string;
  evidencePath?: string;
  criteria: ReviewCriterion[];
  architectureDrift: ArchitectureDrift[];
  promptVersion: string;
  promptHash: string;
  reviewerId: string;
  model: string | null;
  durationMs: number | null;
  exitCode: number | null;
  quality: ReviewQuality;
  /** Redacted reviewer output, kept so a BLOCKED review can be diagnosed. */
  rawOutput?: string;
  /** What the reviewer could not confirm: UNCLEAR criteria and test assessments. Each blocks the review. */
  unclear?: string[];
}

export interface Reviewer {
  id: string;
  available(): boolean;
  review(context: ReviewContext): Promise<ReviewResult>;
  reviewSync(context: ReviewContext): ReviewResult;
}

const SEVERITIES = new Set(["info", "low", "medium", "high", "critical"]);
const CATEGORIES = new Set(["correctness", "requirements", "architecture", "security", "performance", "maintainability", "tests", "edge-case"]);
const BLOCKING = new Set(["high", "critical"]);

export function resolveReviewerConfig(config: ControlConfig, env: NodeJS.ProcessEnv = process.env): BmadRunnerConfig | null {
  const model = safeModelName(env.BMAD_REVIEWER_MODEL) ?? config.reviewer?.model ?? null;
  const timeoutFromEnv = Number(env.BMAD_REVIEWER_TIMEOUT);
  const envTimeout = Number.isFinite(timeoutFromEnv) && timeoutFromEnv > 0 ? timeoutFromEnv : null;
  if (config.reviewer?.command.trim()) {
    return {
      command: config.reviewer.command.trim(),
      args: config.reviewer.args ?? [],
      cwd: config.reviewer.cwd,
      timeoutMs: config.reviewer.timeoutMs && config.reviewer.timeoutMs > 0 ? config.reviewer.timeoutMs : envTimeout ?? 120000,
      model,
    };
  }
  const command = (env.BMAD_REVIEWER_RUNNER ?? "").trim();
  if (!command || /\s/.test(command)) return null;
  return {
    command,
    args: parseRunnerArgs(env.BMAD_REVIEWER_ARGS),
    timeoutMs: envTimeout ?? 120000,
    model,
  };
}

export function requiredCriteria(context: ReviewContext): Array<{ requirementId: string; criterion: string }> {
  const listed = context.requirements.flatMap((requirement) =>
    requirement.acceptanceCriteria.filter((criterion) => criterion.trim()).map((criterion) => ({ requirementId: requirement.id, criterion })),
  );
  if (listed.length > 0) return listed;
  return [{ requirementId: context.ticketRef, criterion: "Ticket verification text was not declared." }];
}

export function reviewPrompt(context: ReviewContext): string {
  const criteria = requiredCriteria(context);
  const body = [
    "You are reviewing a software change.",
    "",
    "Inspect the actual diff.",
    "",
    "Verify every acceptance criterion.",
    "",
    "Check for:",
    "- correctness",
    "- edge cases",
    "- requirement mismatch",
    "- architecture violations",
    "- security issues",
    "- error handling",
    "- tests",
    "- maintainability",
    "",
    "Do not approve based on the developer's explanation.",
    "",
    "You are a read-only reviewer. Read the diff, tests, architecture, and requirements. Your working directory is the ticket worktree; you may open its files. Do not change them.",
    "Do not modify source, commit, push, deploy, or delete files.",
    "",
    "Return structured JSON only.",
    "PASS only when no blocking finding remains.",
    "A passing test command is not a review pass.",
    "Copy each criterion string exactly. Set each criterion status to PASS, FAIL, or UNCLEAR.",
    "Set tests.coversChangedBehavior, tests.wouldCatchRegression, and tests.edgeCases to PASS, FAIL, or UNCLEAR.",
    "If Test evidence records a passing run and edgeCases is present, set tests.edgeCases to PASS unless you found a concrete missing case — then FAIL with a finding. Do not mark UNCLEAR when that evidence is already recorded.",
    "For an architecture violation, add a finding with category architecture, declaredRule, observedCode, file, and severity.",
    "If Test evidence has baselineFailed true, the test command already failed before this change, so the diff must also fix the test setup; a minimal fix there (such as a test config file) is in scope, not an unrelated change.",
    "",
    `promptVersion: ${REVIEW_PROMPT_VERSION}`,
    `Mission: ${context.missionTitle}`,
    `Ticket: ${context.ticketRef} ${context.ticketTitle}`,
    `Worktree: ${context.worktree}`,
    `Base: ${context.baseCommit}`,
    `Head: ${context.headCommit}`,
    "",
    "Requirements:",
    JSON.stringify(context.requirements),
    "",
    "CRITERIA-JSON:",
    JSON.stringify(criteria),
    "",
    "Architecture:",
    JSON.stringify(context.architecture),
    "",
    "Test evidence (failing and output are the real run; name that cause, not a guessed one):",
    JSON.stringify(context.testEvidence),
    "",
    "Changed files:",
    context.changedFiles.join("\n") || "(none)",
    "",
    "Diff:",
    context.diff || "(empty)",
    "",
    "Finding severity is one of info, low, medium, high, critical. Finding category is one of correctness, requirements, architecture, security, performance, maintainability, tests, edge-case. Every finding has a message; omit empty findings.",
    "JSON shape:",
    '{"status":"PASS|FAIL","summary":"...","findings":[{"severity":"high","category":"correctness","message":"...","file":"...","repair":"..."}],"criteria":[{"requirementId":"...","criterion":"...","status":"PASS|FAIL|UNCLEAR"}],"tests":{"coversChangedBehavior":"PASS|FAIL|UNCLEAR","wouldCatchRegression":"PASS|FAIL|UNCLEAR","edgeCases":"PASS|FAIL|UNCLEAR"}}',
    ...(context.followsRepair
      ? ["", `This review follows repair attempt ${String(context.repairAttempt ?? "")}. Inspect the current diff. The previous review result does not decide this review.`]
      : []),
  ].join("\n");
  return redactSecrets(body);
}

export function repairTask(finding: ReviewFinding): string {
  return [finding.id, `File: ${finding.file ?? "(unspecified)"}`, `Severity: ${finding.severity}`, `Finding: ${finding.message}`, `Repair: ${finding.repair ?? finding.message}`].join("\n");
}

export function repairBrief(input: {
  ticketRef: string;
  title: string;
  verify: string;
  worktree: string;
  source: "review" | "attack" | "security" | "tests";
  evidencePath: string;
  findings: ReviewFinding[];
  requirements: Array<{ id: string; title: string; acceptanceCriteria: string[] }>;
  diff: string;
}): string {
  const blocks = input.findings.map((finding) => {
    const requirement = input.requirements[0];
    return [
      `Finding ID: ${finding.id}`,
      `Severity: ${finding.severity}`,
      `Category: ${finding.category}`,
      `Message: ${finding.message}`,
      `Affected file: ${finding.file ?? "(unspecified)"}`,
      `Line: ${finding.line ?? "(unspecified)"}`,
      `Requirement: ${requirement ? `${requirement.id} ${requirement.title}` : "(unspecified)"}`,
      `Acceptance criterion: ${requirement?.acceptanceCriteria.filter((item) => item.trim()).join(" ") || input.verify || "(unspecified)"}`,
      `${input.source === "attack" ? "Attack evidence" : input.source === "security" ? "Security evidence" : input.source === "tests" ? "Test evidence" : "Review evidence"}: ${input.evidencePath}`,
      `Repair: ${finding.repair ?? finding.message}`,
    ].join("\n");
  });
  return redactSecrets(
    [
      `Repair ticket ${input.ticketRef} in ${input.worktree}.`,
      `Source: ${input.source}`,
      input.title,
      ...blocks,
      "Actual diff:",
      input.diff || "(empty)",
      "Change the code in this worktree. Keep the comment // BMAD-TICKET-STATUS: built in the implementation file.",
      "Do not only describe the fix.",
    ]
      .filter((part) => part.trim().length > 0)
      .join("\n\n"),
  );
}

export function promptHash(prompt: string): string {
  return crypto.createHash("sha256").update(prompt).digest("hex");
}

export function downgradeReview(result: ReviewResult, options: { evidenceExists?: boolean; worktreeMutated?: boolean }): ReviewResult {
  if (options.worktreeMutated) {
    return blocked(result, "Reviewer modified the worktree. The reviewer is read-only, so this review is blocked.");
  }
  if (result.status === "PASS" && options.evidenceExists === false) {
    return blocked(result, "Review PASS was rejected because the review evidence file is missing.");
  }
  return result;
}

export interface JudgeInput {
  raw: string;
  processStatus: "completed" | "failed" | "timeout" | "not-configured";
  exitCode: number | null;
  context: ReviewContext;
  reviewerId: string;
  model: string | null;
  durationMs: number | null;
  prompt: string;
}

export function judgeReview(input: JudgeInput): ReviewResult {
  const promptDigest = promptHash(input.prompt);
  const base = emptyResult(input, promptDigest);
  if (input.processStatus === "not-configured") {
    return { ...base, status: "NOT_CONFIGURED", summary: "status: blocked\nNo reviewer executed. A captured diff is not a pass." };
  }
  if (input.processStatus === "timeout") {
    return blocked(base, "Reviewer timed out. The review is blocked.");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = extractJson(input.raw);
  } catch {
    return blocked(base, "Reviewer output was not valid JSON. The review is blocked.");
  }
  const findings = parseFindings(parsed.findings);
  if (findings === null) return blocked(base, "Reviewer findings were not a valid list. The review is blocked.");
  const criteria = alignCriteria(input.context, parsed.criteria);
  if (criteria === null) return blocked(base, "Reviewer criteria were not valid. The review is blocked.");
  const tests = parseTests(parsed.tests);
  if (tests === null) return blocked({ ...base, criteria, findings }, "Reviewer did not return a test assessment. A passing test suite is not a review pass.");
  const drift = architectureDrift(input.context, findings, parsed.architectureDrift);
  const merged = [...findings, ...drift.findings];
  const modelStatus = parsed.status;
  if (modelStatus !== "PASS" && modelStatus !== "FAIL") {
    return blocked({ ...base, findings: merged, criteria, architectureDrift: drift.drift }, "Reviewer status was not PASS or FAIL. The review is blocked.");
  }
  const summary = typeof parsed.summary === "string" && parsed.summary.trim() ? redactSecrets(parsed.summary.trim()) : "Reviewer returned no summary.";
  const testKeys = ["coversChangedBehavior", "wouldCatchRegression", "edgeCases"] as const;
  const unitPassed = input.context.testEvidence?.result === "pass";
  const edgePresent = input.context.testEvidence?.edgeCases === "present";
  const confirmedUnclear = testKeys.filter((key, index) => {
    if (tests[index] !== "UNCLEAR") return false;
    if (key === "edgeCases") return edgePresent && unitPassed;
    return unitPassed;
  });
  const blockingUnclear = [
    ...criteria.filter((item) => item.status === "UNCLEAR").map((item) => `criterion "${item.criterion}"`),
    ...testKeys.filter((key, index) => tests[index] === "UNCLEAR" && !confirmedUnclear.includes(key)).map((key) => `tests.${key}`),
  ];
  let status: ReviewStatus = modelStatus;
  if (criteria.some((item) => item.status === "FAIL") || tests.some((item) => item === "FAIL") || merged.some((item) => BLOCKING.has(item.severity))) {
    status = "FAIL";
  } else if (blockingUnclear.length > 0 || criteria.length === 0) {
    status = "BLOCKED";
  } else if (status === "PASS" && !unitPassed) {
    status = "BLOCKED";
  } else if (status === "PASS" && (input.processStatus !== "completed" || input.exitCode !== 0)) {
    status = "BLOCKED";
  }
  if (status === "PASS" && merged.some((item) => BLOCKING.has(item.severity))) status = "FAIL";
  const result: ReviewResult = {
    ...base,
    status,
    findings: merged,
    criteria,
    architectureDrift: drift.drift,
    summary: status === "BLOCKED" && modelStatus === "PASS" ? `${summary}\nstatus: blocked` : summary,
    unclear: blockingUnclear,
  };
  result.quality = qualityOf(result, input.durationMs);
  return result;
}

/** Test-only reviewer. The production plane does not construct it. */
export class DeterministicReviewer implements Reviewer {
  readonly id = "deterministic-test-reviewer";
  readonly prompts: string[] = [];
  private index = 0;

  constructor(private readonly script: Array<"pass" | "fail" | "invalid" | "timeout" | "high" | "critical" | "unclear">) {}

  available(): boolean {
    return true;
  }

  review(context: ReviewContext): Promise<ReviewResult> {
    return Promise.resolve(this.reviewSync(context));
  }

  reviewSync(context: ReviewContext): ReviewResult {
    const mode = this.script[Math.min(this.index, Math.max(this.script.length - 1, 0))] ?? "invalid";
    this.index += 1;
    const prompt = reviewPrompt(context);
    this.prompts.push(prompt);
    if (mode === "invalid") {
      return judgeReview({ raw: "not json", processStatus: "completed", exitCode: 0, context, reviewerId: this.id, model: null, durationMs: 1, prompt });
    }
    if (mode === "timeout") {
      return judgeReview({ raw: "", processStatus: "timeout", exitCode: null, context, reviewerId: this.id, model: null, durationMs: 1, prompt });
    }
    const criteria = requiredCriteria(context).map((item) => ({
      ...item,
      status: mode === "unclear" ? "UNCLEAR" : mode === "pass" ? "PASS" : "FAIL",
    }));
    const findings =
      mode === "high" || mode === "critical" || mode === "fail"
        ? [{ severity: mode === "fail" ? "high" : mode, category: "correctness", message: "The change does not meet the acceptance criterion.", file: context.changedFiles[0], repair: "Change the code so the criterion holds." }]
        : [];
    const body = {
      status: mode === "pass" ? "PASS" : "FAIL",
      summary: mode === "pass" ? "Criteria hold against the diff." : "A blocking finding remains.",
      findings,
      criteria,
      tests: {
        coversChangedBehavior: mode === "pass" ? "PASS" : mode === "unclear" ? "UNCLEAR" : "FAIL",
        wouldCatchRegression: mode === "pass" ? "PASS" : mode === "unclear" ? "UNCLEAR" : "FAIL",
        edgeCases: mode === "pass" ? "PASS" : "UNCLEAR",
      },
    };
    return judgeReview({ raw: JSON.stringify(body), processStatus: "completed", exitCode: 0, context, reviewerId: this.id, model: "deterministic-test-reviewer", durationMs: 2, prompt });
  }
}

export class CommandReviewer implements Reviewer {
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

  review(context: ReviewContext): Promise<ReviewResult> {
    return Promise.resolve(this.reviewSync(context));
  }

  reviewSync(context: ReviewContext): ReviewResult {
    const prompt = reviewPrompt(context);
    if (!this.config?.command || !this.available()) {
      return judgeReview({
        raw: "",
        processStatus: "not-configured",
        exitCode: null,
        context,
        reviewerId: this.id,
        model: this.config?.model ?? null,
        durationMs: null,
        prompt,
      });
    }
    // Read-only reviewers run inside the ticket worktree so they can open the implementation; the plane
    // fingerprints the worktree before and after and blocks the review if anything changed.
    const scratch = path.join(this.root, ".bmad-next", "missions", context.missionId, "review-cwd");
    fs.mkdirSync(scratch, { recursive: true });
    const cwd = context.worktree && fs.existsSync(context.worktree) ? context.worktree : scratch;
    const result = this.runner.runSync({
      skillId: "bmad-code-review",
      prompt,
      input: "",
      cwd,
      timeoutMs: this.config.timeoutMs ?? 120000,
    });
    return judgeReview({
      raw: result.stdout,
      processStatus: result.status,
      exitCode: result.exitCode,
      context,
      reviewerId: this.id,
      model: this.config.model ?? null,
      durationMs: result.durationMs ?? null,
      prompt,
    });
  }
}

function emptyResult(input: JudgeInput, promptDigest: string): ReviewResult {
  return {
    status: "BLOCKED",
    findings: [],
    summary: "status: blocked",
    criteria: [],
    architectureDrift: [],
    promptVersion: REVIEW_PROMPT_VERSION,
    promptHash: promptDigest,
    reviewerId: input.reviewerId,
    model: input.model,
    durationMs: input.durationMs,
    exitCode: input.exitCode,
    quality: { findings: 0, falsePositiveFeedback: 0, repairSuccess: 0, reviewDurationMs: input.durationMs, modelCost: null },
    rawOutput: input.raw ? redactSecrets(input.raw).slice(-20000) : undefined,
  };
}

function blocked(result: ReviewResult, summary: string): ReviewResult {
  const next = { ...result, status: "BLOCKED" as const, summary: redactSecrets(summary) };
  next.quality = qualityOf(next, result.durationMs);
  return next;
}

function qualityOf(result: ReviewResult, durationMs: number | null): ReviewQuality {
  return {
    findings: result.findings.length,
    falsePositiveFeedback: result.quality?.falsePositiveFeedback ?? 0,
    repairSuccess: result.quality?.repairSuccess ?? 0,
    reviewDurationMs: durationMs,
    modelCost: null,
  };
}

/** The reply object: a fenced JSON block when there is one, else the last complete object after any narration. */
export function extractJson(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("empty");
  const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((match) => lastJsonObject(match[1] ?? "")).filter((item) => item !== null);
  const parsed = fenced.at(-1) ?? lastJsonObject(trimmed);
  if (!parsed) throw new Error("no object");
  return parsed;
}

const SEVERITY_ALIASES: Record<string, string> = { minor: "low", moderate: "medium", major: "high", blocker: "critical", severe: "critical" };
const CATEGORY_ALIASES: Record<string, string> = {
  "error-handling": "correctness",
  errors: "correctness",
  error: "correctness",
  bug: "correctness",
  logic: "correctness",
  reliability: "correctness",
  robustness: "correctness",
  testing: "tests",
  test: "tests",
  "test-coverage": "tests",
  coverage: "tests",
  "edge-cases": "edge-case",
  boundary: "edge-case",
  "boundary-conditions": "edge-case",
  requirement: "requirements",
  "requirement-mismatch": "requirements",
  perf: "performance",
  efficiency: "performance",
  design: "architecture",
  structure: "architecture",
  "security-issue": "security",
  "security-issues": "security",
  privacy: "security",
  style: "maintainability",
  readability: "maintainability",
  "code-quality": "maintainability",
  documentation: "maintainability",
  accessibility: "maintainability",
  usability: "maintainability",
};

/** Severity decides blocking, so an unrecognised severity stays invalid instead of being guessed. */
export function normalizeSeverity(value: unknown): ReviewFinding["severity"] | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  const mapped = SEVERITY_ALIASES[key] ?? key;
  return SEVERITIES.has(mapped) ? (mapped as ReviewFinding["severity"]) : null;
}

/** Category is a label. A known synonym maps to the contract value; an unknown label is kept as maintainability. */
export function normalizeCategory(value: unknown, allowed: Set<string>, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const key = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (allowed.has(key)) return key;
  const mapped = CATEGORY_ALIASES[key];
  return mapped && allowed.has(mapped) ? mapped : fallback;
}

/**
 * An entry with no message is a placeholder. Info or low placeholders are dropped; a placeholder at medium or
 * above cannot be ignored, so the caller treats it as an invalid list.
 */
export function isPlaceholder(record: Record<string, unknown>): "skip" | "invalid" | false {
  if (typeof record.message === "string" && record.message.trim()) return false;
  const severity = normalizeSeverity(record.severity);
  return severity === null || severity === "info" || severity === "low" ? "skip" : "invalid";
}

function parseFindings(value: unknown): ReviewFinding[] | null {
  if (!Array.isArray(value)) return null;
  const findings: ReviewFinding[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    const placeholder = isPlaceholder(record);
    if (placeholder === "skip") continue;
    if (placeholder === "invalid" || typeof record.message !== "string") return null;
    const severity = normalizeSeverity(record.severity);
    if (!severity) return null;
    findings.push({
      id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : `REV-${String(index + 1).padStart(3, "0")}`,
      severity,
      category: normalizeCategory(record.category, CATEGORIES, "maintainability") as ReviewFinding["category"],
      message: redactSecrets(record.message.trim()),
      file: typeof record.file === "string" ? record.file : undefined,
      line: typeof record.line === "number" ? record.line : undefined,
      evidence: typeof record.evidence === "string" ? redactSecrets(record.evidence) : undefined,
      repair: typeof record.repair === "string" ? redactSecrets(record.repair) : undefined,
      declaredRule: typeof record.declaredRule === "string" ? record.declaredRule : undefined,
      observedCode: typeof record.observedCode === "string" ? redactSecrets(record.observedCode) : undefined,
    });
  }
  return findings;
}

function alignCriteria(context: ReviewContext, value: unknown): ReviewCriterion[] | null {
  if (!Array.isArray(value)) return null;
  const reported: ReviewCriterion[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    if (typeof record.requirementId !== "string" || typeof record.criterion !== "string") return null;
    if (record.status !== "PASS" && record.status !== "FAIL" && record.status !== "UNCLEAR") return null;
    reported.push({ requirementId: record.requirementId, criterion: record.criterion, status: record.status });
  }
  return requiredCriteria(context).map((required) => {
    const found = reported.find((item) => item.requirementId === required.requirementId && item.criterion === required.criterion);
    return found ?? { requirementId: required.requirementId, criterion: required.criterion, status: "UNCLEAR" };
  });
}

function parseTests(value: unknown): CriterionStatus[] | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const keys = ["coversChangedBehavior", "wouldCatchRegression", "edgeCases"] as const;
  const statuses: CriterionStatus[] = [];
  for (const key of keys) {
    const status = record[key];
    if (status !== "PASS" && status !== "FAIL" && status !== "UNCLEAR") return null;
    statuses.push(status);
  }
  return statuses;
}

function architectureDrift(
  context: ReviewContext,
  findings: ReviewFinding[],
  raw: unknown,
): { findings: ReviewFinding[]; drift: ArchitectureDrift[] } {
  const drift: ArchitectureDrift[] = [];
  const extra: ReviewFinding[] = [];
  for (const finding of findings) {
    if (finding.category !== "architecture" && finding.declaredRule === undefined) continue;
    drift.push({
      file: finding.file,
      declaredRule: finding.declaredRule ?? finding.message,
      observedCode: finding.observedCode ?? finding.evidence ?? "",
      severity: finding.severity,
    });
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (typeof record.declaredRule !== "string" || typeof record.observedCode !== "string") continue;
      const severity = typeof record.severity === "string" && SEVERITIES.has(record.severity) ? (record.severity as ReviewFinding["severity"]) : "high";
      const file = typeof record.file === "string" ? record.file : undefined;
      drift.push({ file, declaredRule: record.declaredRule, observedCode: redactSecrets(record.observedCode), severity });
      extra.push({
        id: `REV-ARCH-${extra.length + 1}`,
        severity,
        category: "architecture",
        message: `ARCHITECTURE_DRIFT: declared ${record.declaredRule}. Observed ${record.observedCode}.`,
        file,
        declaredRule: record.declaredRule,
        observedCode: redactSecrets(record.observedCode),
        repair: `Align ${file ?? "the change"} with ${record.declaredRule}.`,
      });
    }
  }
  const local = detectArchitectureDrift(
    context.architecture.map((item) => ({ choice: item.choice })),
    [context.diff],
  );
  for (const finding of local) {
      extra.push({
        id: finding.id,
        severity: "high",
        category: "architecture",
        message: `ARCHITECTURE_DRIFT: ${finding.message}`,
        declaredRule: finding.message,
        observedCode: finding.message,
        repair: finding.message,
      });
      drift.push({ declaredRule: finding.message, observedCode: finding.message, severity: "high" });
  }
  return { findings: extra, drift };
}
