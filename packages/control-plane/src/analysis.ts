import fs from "node:fs";
import path from "node:path";
import type {
  Complexity,
  Finding,
  ForgeQuestion,
  JourneyDeclaration,
  MissionMode,
  Requirement,
  RiskLevel,
  ScanLevel,
} from "./types";

const CRITICAL_TERMS = /\b(payment|billing|checkout|auth|oauth|password|credential|secret|hipaa|phi|pci|ssn|production deploy|expense|payroll|ledger)\b/i;
const SIMPLE_TERMS = /\b(typo|spelling|rename comment|comment only|whitespace|changelog typo)\b/i;

export function classifyComplexity(input: string, signals: { fileCount?: number } = {}): Complexity {
  const text = input.trim();
  if (SIMPLE_TERMS.test(text) && text.length < 280 && !CRITICAL_TERMS.test(text)) return "simple";
  let score = 0;
  if (text.length > 400) score += 1;
  if (/\b(integrate|migration|multi-tenant|workflow|saas)\b/i.test(text)) score += 1;
  if ((signals.fileCount ?? 0) > 800) score += 1;
  if (CRITICAL_TERMS.test(text)) return "critical";
  if (score >= 2) return "complex";
  if (score === 1) return "medium";
  return text.length < 80 ? "medium" : "medium";
}

export function classifyMode(input: string, project: { fileCount: number; hasCode: boolean }): MissionMode {
  if (classifyComplexity(input) === "simple") return "quick";
  if (project.hasCode && project.fileCount > 3) return "brownfield";
  return "greenfield";
}

export function materialQuestions(idea: string, answered: Iterable<string>): ForgeQuestion[] {
  const done = new Set(answered);
  const text = idea.toLowerCase();
  const questions: ForgeQuestion[] = [];
  const ask = (id: string, prompt: string, why: string, when = true) => {
    if (when && !done.has(id)) questions.push({ id, prompt, why });
  };
  ask(
    "users",
    "Who is the user that must succeed for this to matter?",
    "The user changes the product boundary.",
    !/\bfor (employees|teams|customers|patients|students|players)\b/i.test(idea),
  );
  ask(
    "success",
    "What observable outcome proves the idea worked?",
    "Verification needs a success signal.",
  );
  if (/\bpayment|billing|checkout|subscription\b/i.test(text)) {
    ask("provider", "Which payment provider?", "Provider choice changes the integration.", !/stripe|adyen|braintree|square/.test(text));
    ask("billing-cadence", "Is billing one-time, recurring, or both?", "Cadence changes the data model and tests.");
    ask("currencies", "Which currencies must be supported?", "Currency support changes storage and rounding.");
    ask("refunds", "What is the refund policy?", "Refunds change ledger and API behavior.");
    ask("fraud", "What fraud checks are in scope?", "Fraud scope changes controls and evidence.");
    ask("authentication", "How is the payer authenticated?", "Authentication changes the security boundary.");
    ask("environment", "Which environment is this deployed to first?", "The environment changes secrets, network policy, and release gates.");
  }
  if (/\bexpense\b/i.test(text)) {
    ask("tenancy", "Is this one company or many tenants?", "Tenancy changes isolation, auth, and data design.");
    ask("approval", "Who approves an expense before it is paid?", "Approval changes the workflow and tests.");
    ask("currencies", "Which currencies must an expense support?", "Currency support changes storage and display.");
    ask("authentication", "How do users sign in?", "Authentication changes the security boundary.");
  }
  ask(
    "non-goals",
    "What is explicitly out of scope for the first mission?",
    "Non-goals stop the workflow from expanding on its own.",
    questions.length < 6,
  );
  return questions.slice(0, 8);
}

export interface ScanReport {
  level: ScanLevel;
  fileCount: number;
  languages: Record<string, number>;
  manifests: string[];
  testFiles: string[];
  observations: string[];
  recommendation: string;
  gameModule: boolean;
  reconstructedArchitecture: false;
}

const SKIP = new Set(["node_modules", ".git", "dist", ".bmad-next", "_bmad-output", ".tmp", "coverage"]);

export function scanRepository(root: string, level: ScanLevel): ScanReport {
  const languages: Record<string, number> = {};
  const manifests: string[] = [];
  const testFiles: string[] = [];
  const observations: string[] = [];
  let fileCount = 0;
  const maxFiles = level === "quick" ? 200 : level === "deep" ? 5000 : 20000;
  const maxDepth = level === "quick" ? 2 : 12;
  const contentReads: string[] = [];

  walk(root, 0);
  if (manifests.includes("package.json") && level !== "quick") {
    observations.push(...readPackageObservations(path.join(root, "package.json")));
  }
  if (level === "exhaustive") {
    for (const file of contentReads.slice(0, 200)) {
      const text = fs.readFileSync(file, "utf8").slice(0, 65536);
      if (/mongodb|mongoose/i.test(text)) observations.push(`Observed MongoDB reference in ${path.relative(root, file)}`);
      if (/postgres|pg\b/i.test(text)) observations.push(`Observed PostgreSQL reference in ${path.relative(root, file)}`);
    }
  }
  const gameModule = fs.existsSync(path.join(root, "Assets")) || fs.existsSync(path.join(root, "project.godot"));
  return {
    level,
    fileCount,
    languages,
    manifests,
    testFiles: testFiles.slice(0, 50),
    observations,
    recommendation: fileCount > 800 ? "exhaustive" : fileCount > 40 ? "deep" : "quick",
    gameModule,
    reconstructedArchitecture: false,
  };

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth || fileCount >= maxFiles) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile()) {
        fileCount += 1;
        const ext = path.extname(entry.name).toLowerCase() || "[none]";
        languages[ext] = (languages[ext] ?? 0) + 1;
        if (["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "Dockerfile"].includes(entry.name)) {
          manifests.push(path.relative(root, full) || entry.name);
        }
        if (/\.(test|spec)\./.test(entry.name) || entry.name.includes("_test.")) testFiles.push(path.relative(root, full));
        if (level === "exhaustive" && /\.(ts|js|py|go|rs)$/.test(entry.name)) contentReads.push(full);
      }
    }
  }
}

function readPackageObservations(file: string): string[] {
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = { ...json.dependencies, ...json.devDependencies };
    return Object.keys(deps).slice(0, 40).map((name) => `Dependency ${name}@${deps[name]}`);
  } catch {
    return ["package.json could not be parsed."];
  }
}

export function projectHasCode(root: string): { fileCount: number; hasCode: boolean } {
  const report = scanRepository(root, "quick");
  const codeExt = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".cs"];
  const hasCode = codeExt.some((ext) => (report.languages[ext] ?? 0) > 0) || report.manifests.length > 0;
  return { fileCount: report.fileCount, hasCode };
}

const DURATION = /(\d+)\s*-?\s*(minutes|minute|mins|min|hours|hour|days|day|mb|gb)/gi;

export function detectRequirementDrift(requirement: Requirement, files: Array<{ path: string; text: string }>): Finding[] {
  const expected = durations(requirement.description + " " + requirement.acceptance_criteria.join(" "));
  const findings: Finding[] = [];
  for (const file of files) {
    const actual = durations(file.text);
    for (const item of expected) {
      const conflict = actual.find((candidate) => candidate.unit === item.unit && candidate.value !== item.value);
      if (conflict) {
        findings.push({
          id: `drift-${requirement.id}-${file.path}`,
          code: "REQUIREMENT_DRIFT",
          severity: "high",
          message: `${requirement.id} says ${item.value}-${item.unit}. ${file.path} says ${conflict.value}-${conflict.unit}.`,
          requirementId: requirement.id,
          paths: [file.path],
        });
      }
    }
  }
  return findings;
}

export function detectTestDrift(requirement: Requirement, files: Array<{ path: string; text: string }>): Finding[] {
  return detectRequirementDrift(requirement, files).map((finding) => ({
    ...finding,
    id: finding.id.replace("drift", "test-drift"),
    code: "TEST_DRIFT",
    message: finding.message.replace("REQUIREMENT", "TEST"),
  }));
}

export function detectArchitectureDrift(
  declared: Array<{ choice: string }>,
  observations: string[],
): Finding[] {
  const findings: Finding[] = [];
  const observed = observations.join("\n").toLowerCase();
  for (const decision of declared) {
    const choice = decision.choice.toLowerCase();
    if (choice.includes("postgres") && /mongodb|mongoose/.test(observed) && !/postgres|pg\b/.test(observed)) {
      findings.push({
        id: `arch-${decision.choice}`,
        code: "ARCHITECTURE_DRIFT",
        severity: "high",
        message: `Declared ${decision.choice}. Scan observed MongoDB and did not observe PostgreSQL.`,
        paths: [],
      });
    }
  }
  return findings;
}

export function detectDocumentationDrift(declared: Array<{ choice: string }>, files: Array<{ path: string; text: string }>): Finding[] {
  const docs = files.filter((file) => file.path.endsWith(".md"));
  if (docs.length === 0 || declared.length === 0) return [];
  const findings: Finding[] = [];
  for (const decision of declared) {
    const choice = decision.choice.toLowerCase();
    for (const file of docs) {
      const text = file.text.toLowerCase();
      if (choice.includes("postgres") && /mongodb|mongoose/.test(text) && !/postgres|pg\b/.test(text)) {
        findings.push({
          id: `doc-${decision.choice}-${file.path}`,
          code: "DOCUMENTATION_DRIFT",
          severity: "medium",
          message: `Documentation ${file.path} names MongoDB. The recorded decision is ${decision.choice}.`,
          paths: [file.path],
          source: decision.choice,
          target: file.path,
          description: `Documentation ${file.path} names MongoDB. The recorded decision is ${decision.choice}.`,
          evidence: [file.path],
          status: "open",
        });
      }
    }
  }
  return findings;
}

export function detectUxDrift(journeys: JourneyDeclaration[], measurements: Array<{ journeyId: string; steps: number }>): Finding[] {
  const findings: Finding[] = [];
  for (const journey of journeys) {
    const measured = measurements.find((item) => item.journeyId === journey.id);
    if (!measured) continue;
    if (measured.steps !== journey.steps) {
      findings.push({
        id: `ux-${journey.id}`,
        code: "UX_DRIFT",
        severity: "medium",
        message: `${journey.name} declares ${journey.steps} steps. Browser evidence measured ${measured.steps}.`,
        paths: [],
      });
    }
  }
  return findings;
}

export function detectVerificationGap(requirement: Requirement, testText: string): Finding | null {
  if (requirement.acceptance_criteria.length === 0) return null;
  if (testText.includes(requirement.id)) return null;
  return {
    id: `gap-${requirement.id}`,
    code: "VERIFICATION_GAP",
    severity: "medium",
    message: `${requirement.id} has acceptance criteria and no test mentions its id.`,
    requirementId: requirement.id,
    paths: [],
  };
}

export function compileAcceptanceDraft(requirement: Requirement): string {
  const lines = [
    `# Draft acceptance tests for ${requirement.id}`,
    "",
    "producer: bmad-next.acceptance-compiler",
    "status: draft",
    "expanded: false",
    "",
    "These scenarios restate declared acceptance criteria. They are not executed and they are not evidence.",
    "",
  ];
  if (requirement.acceptance_criteria.length === 0) {
    lines.push("No acceptance criteria are declared. Elicitation is required before a test can be compiled.");
    return lines.join("\n");
  }
  requirement.acceptance_criteria.forEach((criterion, index) => {
    const given = criterion.match(/given\s+(.+?)\s+when\s+(.+?)\s+then\s+(.+)/i);
    lines.push(`## Scenario ${index + 1}`);
    if (given) {
      lines.push(`Given ${given[1]}`, `When ${given[2]}`, `Then ${given[3]}`, "");
    } else {
      lines.push("Given the declared requirement context", "When the behavior under test occurs", `Then ${criterion}`, "");
    }
  });
  return lines.join("\n");
}

export function buildContextBundle(input: {
  rules: string;
  project: string;
  mission: string;
  story: string;
  artifacts: string;
  memory: string;
  repository: string;
  budget: number;
}): { text: string; omitted: string[] } {
  const sections = [
    ["global rules", input.rules],
    ["project context", input.project],
    ["mission context", input.mission],
    ["story context", input.story],
    ["artifacts", input.artifacts],
    ["memory", input.memory],
    ["repository", input.repository],
  ] as const;
  const omitted: string[] = [];
  let used = 0;
  const parts: string[] = [];
  for (const [name, body] of sections) {
    if (!body.trim()) {
      omitted.push(`${name}: empty`);
      continue;
    }
    if (used >= input.budget) {
      omitted.push(name);
      continue;
    }
    const room = input.budget - used;
    const slice = body.slice(0, room);
    if (slice.length < body.length) omitted.push(`${name}: truncated`);
    parts.push(`## ${name}\n${slice}`);
    used += slice.length;
  }
  return { text: parts.join("\n\n"), omitted };
}

export function impactFromImports(files: Map<string, string>, start: string): string[] {
  const reverse = new Map<string, string[]>();
  for (const [file, text] of files) {
    for (const match of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const spec = match[1];
      if (!spec) continue;
      const resolved = resolveImport(file, spec, files);
      if (!resolved) continue;
      const list = reverse.get(resolved) ?? [];
      list.push(file);
      reverse.set(resolved, list);
    }
  }
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    for (const dependent of reverse.get(current) ?? []) queue.push(dependent);
  }
  return [...seen];
}

function resolveImport(from: string, spec: string, files: Map<string, string>): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`];
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

export function assignRisk(input: {
  impact: number;
  security: boolean;
  data: boolean;
  deployment: boolean;
}): RiskLevel {
  if (input.security && input.deployment) return "critical";
  if (input.security || input.data) return "high";
  if (input.impact > 8 || input.deployment) return "medium";
  return "low";
}

export function parallelBatches<T extends { ref: string; after: Array<number | string>; epicId: number; id: number }>(
  tickets: T[],
): T[][] {
  const remaining = [...tickets];
  const done = new Set<string>();
  const batches: T[][] = [];
  while (remaining.length > 0) {
    const ready = remaining.filter((ticket) =>
      ticket.after.every((dep) => done.has(typeof dep === "number" ? `${ticket.epicId}.${dep}` : String(dep))),
    );
    if (ready.length === 0) {
      batches.push(remaining.splice(0, remaining.length));
      break;
    }
    batches.push(ready);
    for (const ticket of ready) {
      done.add(ticket.ref);
      const index = remaining.indexOf(ticket);
      if (index >= 0) remaining.splice(index, 1);
    }
  }
  return batches;
}

function durations(text: string): Array<{ value: number; unit: string }> {
  const found: Array<{ value: number; unit: string }> = [];
  for (const match of text.matchAll(DURATION)) {
    const value = Number(match[1]);
    const unit = (match[2] ?? "").toLowerCase().replace(/s$/, "");
    if (Number.isFinite(value)) found.push({ value, unit });
  }
  return found;
}

export function routeModelRole(kind: "plan" | "code" | "research" | "review" | "triage"): "reasoning" | "coding" | "fast" | "research" | "local" {
  if (kind === "code") return "coding";
  if (kind === "research") return "research";
  if (kind === "triage") return "fast";
  return "reasoning";
}

export function escalationName(level: number): string {
  return [
    "Developer",
    "Debugger",
    "Research",
    "Adversary",
    "Alternative Model",
    "Alternative Implementation",
    "Human",
  ][Math.min(Math.max(level, 1), 7) - 1] ?? "Human";
}
