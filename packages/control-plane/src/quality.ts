import fs from "node:fs";
import type { EvidenceRecord, EvidenceResult, GateRunState, Mission, ReleaseState, Requirement, RiskLevel } from "./types";

export class EvidenceError extends Error {}

export function assertPassEvidence(record: EvidenceRecord, artifactExists: boolean): void {
  if (record.result !== "pass") return;
  if (record.exit_code !== 0) {
    throw new EvidenceError("A passing evidence record needs exit code 0 from the runner.");
  }
  if (!record.artifact) {
    throw new EvidenceError("A passing evidence record needs an artifact path.");
  }
  if (!artifactExists) {
    throw new EvidenceError(`Evidence artifact does not exist: ${record.artifact}`);
  }
  if (!record.runner || record.runner === "mock") {
    throw new EvidenceError("A passing evidence record needs a real runner id.");
  }
  if (!record.started_at || !record.finished_at) {
    throw new EvidenceError("A passing evidence record needs start and finish timestamps.");
  }
  if (!record.type || !record.source) {
    throw new EvidenceError("A passing evidence record needs a type and a source.");
  }
  if (gateRunState(record.result) !== "PASS") {
    throw new EvidenceError("A non-pass result cannot be stored as pass.");
  }
}

export interface ReleaseCriterion {
  id: string;
  label: string;
  state: ReleaseState;
  detail: string;
  evidence?: string;
  timestamp?: string;
  command?: string;
  artifact?: string;
  /** Nothing has run for this criterion yet. It still blocks release, but nothing went wrong. */
  pending?: boolean;
}

export interface ReleaseMatrixRow {
  id: string;
  label: string;
  state: "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN" | "WAITING" | "NOT_REQUIRED" | "SUPERSEDED";
  detail: string;
  evidence?: string;
  timestamp?: string;
  command?: string;
  artifact?: string;
  commit?: string | null;
}

export interface ReleaseReport {
  state: ReleaseState;
  criteria: ReleaseCriterion[];
  lastVerifiedBuild: Mission["lastVerifiedBuild"];
}

/** A test command that reports zero executed tests did not verify the change. */
/**
 * The failing tests in a test log, one line each: name, assertion, and the first source frame. A repair works from
 * this rather than from the tail of the log, which is usually a stack trace of the last failure only.
 */
export function failingTestSummary(log: string, limit = 12): string[] {
  const lines = log.replace(/\u001b\[[0-9;]*m/g, "").split("\n");
  const start = lines.findIndex((line) => /failing tests:/i.test(line));
  const scope = start >= 0 ? lines.slice(start + 1) : lines;
  const failures: Array<{ name: string; details: string[]; frame: string }> = [];
  for (const raw of scope) {
    const line = raw.trim();
    const named = line.match(/^(?:✖|not ok \d+ -)\s+(.+?)(?:\s+\(\d[\d.]*m?s\))?$/);
    if (named && !/^failing tests:?$/i.test(named[1] ?? "")) {
      failures.push({ name: named[1] ?? "", details: [], frame: "" });
      continue;
    }
    const current = failures.at(-1);
    if (!current) continue;
    const frame = line.match(/\(?((?:[^()\s]*\/)?[^()\s/]+\.(?:[cm]?js|ts|tsx|jsx)):(\d+):\d+\)?$/);
    if (!current.frame && frame && !/node:internal|node_modules/.test(line)) current.frame = `${frame[1]?.split("/").slice(-2).join("/")}:${frame[2]}`;
    if (current.details.length < 3 && /(Error|expected|actual|!==|===|Expected|Received|not equal|toBe|assert)/.test(line) && !/^at /.test(line)) current.details.push(line.slice(0, 200));
  }
  const unique = failures.filter((item, index) => failures.findIndex((other) => other.name === item.name) === index);
  return unique.slice(0, limit).map((item) => `✖ ${item.name}${item.details.length > 0 ? ` — ${item.details.join(" ")}` : ""}${item.frame ? ` (${item.frame})` : ""}`);
}

export function testCommandRanTests(stdout: string): boolean {
  if (/(?:ℹ|#)\s+tests\s+0\b/.test(stdout)) return false;
  // An npm script that is only `node <file>.js` starts no test runner of its own. Printing "verified" and exiting 0
  // is not a test: without a runner's summary of at least one test, nothing was checked.
  if (!/^> node (?:\.\/)?[\w./-]+\.[cm]?js\s*$/m.test(stdout)) return true;
  return /(?:ℹ|#)\s+tests\s+[1-9]|\b[1-9]\d* passing\b|Tests:\s+[1-9]\d* passed/.test(stdout);
}

export function gateRunState(result: EvidenceResult | undefined): GateRunState {
  if (!result || result === "not-configured") return "NOT_RUN";
  if (result === "pass") return "PASS";
  if (result === "fail") return "FAIL";
  if (result === "blocked") return "BLOCKED";
  return "ERROR";
}

export function missionEvidenceKinds(mission: Mission): string[] {
  const base = riskEvidenceKinds(mission);
  return [...base, ...(mission.requiredEvidence ?? []).filter((kind) => !base.includes(kind))];
}

/** Evidence a requirement must pass: its declared methods or its risk set, plus the project's required kinds. */
export function requirementKinds(requirement: Requirement, mission: Mission): string[] {
  const base = requirement.verification_methods.length > 0 ? requirement.verification_methods : requiredEvidenceKinds(requirement.risk, mission.attackRiskFloor ?? "high");
  return [...base, ...(mission.requiredEvidence ?? []).filter((kind) => !base.includes(kind))];
}

function riskEvidenceKinds(mission: Mission): string[] {
  const floor = mission.attackRiskFloor ?? "high";
  if (mission.complexity === "critical" || mission.requirements.some((requirement) => requirement.risk === "critical")) {
    return requiredEvidenceKinds("critical", floor);
  }
  if (mission.complexity === "complex" || mission.requirements.some((requirement) => requirement.risk === "high")) {
    return requiredEvidenceKinds("high", floor);
  }
  if (mission.complexity === "simple") return ["unit", "review"];
  return requiredEvidenceKinds("medium", floor);
}

export function requiredEvidenceKinds(risk: RiskLevel, floor: "medium" | "high" = "high"): string[] {
  if (risk === "low") return ["unit"];
  if (risk === "medium") return floor === "medium" ? ["unit", "review", "attack"] : ["unit", "review"];
  if (risk === "high") return ["unit", "review", "attack", "security", "browser"];
  return ["unit", "review", "security", "browser", "attack", "nfr"];
}

export function evaluateRelease(mission: Mission, artifactExists: (file: string) => boolean): ReleaseReport {
  const criteria: ReleaseCriterion[] = [];
  if (mission.requirements.length === 0) {
    criteria.push({ id: "requirements", label: "Requirements", state: "blocked", detail: "No requirements recorded yet.", pending: true });
  } else {
    const verified = mission.requirements.filter((requirement) => requirement.status === "verified").length;
    criteria.push({
      id: "requirements",
      label: "Requirements",
      state: verified === mission.requirements.length ? "pass" : "blocked",
      detail: `${verified} of ${mission.requirements.length} requirements are verified.`,
      pending: verified < mission.requirements.length,
    });
  }
  const labels: Record<string, string> = { unit: "Tests", review: "Review", security: "Security", browser: "Browser QA", attack: "Attack", nfr: "NFR" };
  for (const kind of missionEvidenceKinds(mission)) {
    criteria.push(evidenceCriterion(mission, kind, labels[kind] ?? kind, artifactExists));
  }
  criteria.push(architectureCriterion(mission, artifactExists));
  criteria.push(traceabilityCriterion(mission, artifactExists));
  if (releaseApprovalRequired(mission)) {
    const decisions = mission.approvals.filter((item) => item.category === "release" && item.identity.trim());
    const approval = decisions.at(-1);
    criteria.push({
      id: "human-release",
      label: "Human release approval",
      state: approval?.decision === "approved" ? "pass" : approval?.decision === "rejected" ? "fail" : "blocked",
      detail:
        approval?.decision === "approved"
          ? `Approved by ${approval.identity}.`
          : approval?.decision === "rejected"
            ? `Rejected by ${approval.identity}.`
            : mission.humanGates?.includes("release")
              ? "The release human gate is in force. A named person must approve the release."
              : "Critical work needs a named human release approval.",
      timestamp: approval?.at,
      evidence: approval?.id,
      pending: !approval,
    });
  }
  for (const waiver of mission.waivers) {
    const criterion = criteria.find((item) => item.id === waiver.criterion);
    if (criterion && criterion.state !== "pass" && waiver.identity.trim() && waiver.reason.trim()) {
      criterion.state = "waived";
      criterion.detail = `Waived by ${waiver.identity}: ${waiver.reason}`;
    }
  }
  return { state: combine(criteria), criteria, lastVerifiedBuild: mission.lastVerifiedBuild };
}

/** Critical work always needs a named approval; so does any mission created while the "release" human gate was configured. */
export function releaseApprovalRequired(mission: Mission): boolean {
  if (mission.complexity === "critical" || mission.requirements.some((requirement) => requirement.risk === "critical")) return true;
  return mission.humanGates?.includes("release") ?? false;
}

export function evidenceIsStale(mission: Mission, record: EvidenceRecord): boolean {
  if (!record.requirement_id) return false;
  const requirement = mission.requirements.find((item) => item.id === record.requirement_id);
  if (!requirement) return false;
  return (record.requirement_version ?? 1) < requirement.version;
}

function edgeCaseTerms(): RegExp {
  return /\b(persist|persistence|reload|storage|localstorage|empty|whitespace|invalid|malformed|missing|concurrent|boundary|error)\b/gi;
}
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$|\/(?:tests?|__tests__)\/|\/test\.js$/i;
const TEST_CASE = /\b(?:it|test|describe)\s*\(/g;

function walkTestFiles(dir: string, files: string[], depth = 0): void {
  if (depth > 6 || files.length >= 40 || !fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name === ".bmad-next") continue;
    const absolute = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walkTestFiles(absolute, files, depth + 1);
    else if (entry.isFile() && TEST_FILE.test(absolute.replace(/\\/g, "/"))) files.push(absolute);
  }
}

/** Passing unit tests that exercise persistence, reload, or other edge terms count as edge-case evidence. */
export function detectEdgeCaseTests(
  worktree: string,
  criteria: string[],
  unit: { result?: string; log?: string } | null,
): { status: "present" | "missing"; files: string[]; matched: string[] } {
  if (unit?.result !== "pass") return { status: "missing", files: [], matched: [] };
  const files: string[] = [];
  if (worktree && fs.existsSync(worktree)) walkTestFiles(worktree, files);
  const bodies = files.map((file) => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return "";
    }
  });
  const text = `${bodies.join("\n")}\n${unit.log ?? ""}`;
  const criterionTerms = [...criteria.join(" ").matchAll(edgeCaseTerms())].map((item) => item[0].toLowerCase());
  const matched = [...text.matchAll(edgeCaseTerms())].map((item) => item[0].toLowerCase());
  const unique = [...new Set(matched)];
  const cases = (bodies.join("\n").match(TEST_CASE) ?? []).length;
  const coversDeclared = criterionTerms.length === 0 || unique.some((term) => criterionTerms.includes(term));
  const present = (unique.length > 0 && coversDeclared) || cases >= 3;
  return { status: present ? "present" : "missing", files, matched: unique };
}

/** Latest current (non-superseded) result for a kind, optionally scoped to a ticket. */
export function currentResultFor(mission: Mission, kind: string, ticketRef?: string): EvidenceResult | undefined {
  const records = mission.evidence.filter((record) => record.kind === kind && (!ticketRef || record.story_id === ticketRef));
  const { current } = partitionEvidence(records);
  const latest = [...current].sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.evidence_id.localeCompare(right.evidence_id)).at(-1);
  return latest?.result;
}

export function partitionEvidence(records: EvidenceRecord[]): { current: EvidenceRecord[]; superseded: EvidenceRecord[] } {
  const groups = new Map<string, Array<{ record: EvidenceRecord; index: number }>>();
  records.forEach((record, index) => {
    const key = `${record.kind}|${record.story_id ?? ""}|${record.requirement_id ?? ""}`;
    const list = groups.get(key) ?? [];
    list.push({ record, index });
    groups.set(key, list);
  });
  const current: EvidenceRecord[] = [];
  const superseded: EvidenceRecord[] = [];
  for (const group of groups.values()) {
    const ordered = group.sort((left, right) => left.record.timestamp.localeCompare(right.record.timestamp) || left.index - right.index);
    let lastPass = -1;
    ordered.forEach((item, index) => {
      if (item.record.result === "pass" && item.record.exit_code === 0) lastPass = index;
    });
    ordered.forEach((item, index) => {
      if (lastPass >= 0 && index < lastPass) superseded.push(item.record);
      else current.push(item.record);
    });
  }
  return { current, superseded };
}

function evidenceCriterion(mission: Mission, kind: string, label: string, artifactExists: (file: string) => boolean): ReleaseCriterion {
  const records = mission.evidence.filter((record) => record.kind === kind);
  if (records.length === 0) {
    return { id: kind, label, state: "blocked", detail: "No run recorded yet.", pending: true };
  }
  const fresh = records.filter((record) => !evidenceIsStale(mission, record));
  if (fresh.length === 0) {
    return { id: kind, label, state: "blocked", detail: "Evidence is stale after a requirement change." };
  }
  const { current, superseded } = partitionEvidence(fresh);
  if (current.every((record) => record.result === "not-configured")) {
    return { id: kind, label, state: "blocked", detail: "Runner is not configured." };
  }
  const failing = current.filter((record) => record.result === "fail");
  if (failing.length > 0) {
    const latest = failing.at(-1);
    return { id: kind, label, state: "fail", detail: `${failing.length} unresolved failing run(s).`, artifact: latest?.artifact, command: latest?.command, timestamp: latest?.timestamp, evidence: latest?.evidence_id };
  }
  const concerns = current.filter((record) => record.result === "concerns");
  if (concerns.length > 0 && current.every((record) => record.result !== "pass")) {
    return { id: kind, label, state: "concerns", detail: "Runs reported concerns." };
  }
  const passing = current.filter((record) => record.result === "pass" && record.artifact && artifactExists(record.artifact) && record.exit_code === 0);
  if (passing.length === 0) {
    return { id: kind, label, state: "blocked", detail: "No passing run with an artifact on disk." };
  }
  const latest = passing.at(-1);
  const history = superseded.length > 0 ? ` ${superseded.length} earlier run(s) superseded.` : "";
  return { id: kind, label, state: "pass", detail: `${passing.length} current passing run(s) with artifacts.${history}`, artifact: latest?.artifact, command: latest?.command, timestamp: latest?.timestamp, evidence: latest?.evidence_id };
}

function readRecordedJson(file: string | undefined): Record<string, unknown> | null {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function architectureCriterion(mission: Mission, artifactExists: (file: string) => boolean): ReleaseCriterion {
  if (mission.architecture.length === 0) {
    return { id: "architecture", label: "Architecture", state: "blocked", detail: "Architecture is not declared yet.", pending: true };
  }
  const { current } = partitionEvidence(mission.evidence.filter((record) => record.kind === "architecture"));
  const failing = current.filter((record) => record.result === "fail");
  if (failing.length > 0) {
    const latest = failing.at(-1);
    return { id: "architecture", label: "Architecture", state: "fail", detail: "Architecture verification found blocking drift.", artifact: latest?.artifact, command: latest?.command, timestamp: latest?.timestamp, evidence: latest?.evidence_id };
  }
  const passing = current.filter((record) => record.result === "pass" && record.artifact && artifactExists(record.artifact) && record.exit_code === 0);
  const latest = passing.at(-1);
  if (!latest?.artifact) return { id: "architecture", label: "Architecture", state: "blocked", detail: "Architecture verification has not been executed yet.", pending: true };
  const body = readRecordedJson(latest.artifact);
  const violations = Array.isArray(body?.violations) ? body.violations : [];
  const blocking = violations.some((item) => Boolean(item && typeof item === "object" && (item as { blocking?: boolean }).blocking));
  if (body?.executed !== true || body.status !== "PASS" || blocking) {
    return { id: "architecture", label: "Architecture", state: "fail", detail: "Architecture verification did not pass.", artifact: latest.artifact, command: latest.command, timestamp: latest.timestamp, evidence: latest.evidence_id };
  }
  return { id: "architecture", label: "Architecture", state: "pass", detail: "Declared architecture was compared with the repository.", artifact: latest.artifact, command: latest.command, timestamp: latest.timestamp, evidence: latest.evidence_id };
}

function traceabilityCriterion(mission: Mission, artifactExists: (file: string) => boolean): ReleaseCriterion {
  const { current } = partitionEvidence(mission.evidence.filter((record) => record.kind === "traceability"));
  if (current.length === 0) return { id: "traceability", label: "Traceability", state: "blocked", detail: "Traceability has not been executed yet.", pending: true };
  const failing = current.filter((record) => record.result === "fail");
  if (failing.length > 0) {
    const latest = failing.at(-1);
    const body = readRecordedJson(latest?.artifact);
    const gaps = Array.isArray(body?.gaps) ? body.gaps.map(String) : [];
    const missing = Array.isArray(body?.missingLinks) ? body.missingLinks.map(String) : [];
    const detail = gaps.length > 0 ? `TRACEABILITY GAP: ${gaps.join(", ")} has no ticket.` : missing.length > 0 ? `TRACEABILITY GAP: ${missing.slice(0, 4).join("; ")}` : "TRACEABILITY GAP";
    return { id: "traceability", label: "Traceability", state: "fail", detail, artifact: latest?.artifact, command: latest?.command, timestamp: latest?.timestamp, evidence: latest?.evidence_id };
  }
  const passing = current.filter((record) => record.result === "pass" && record.artifact && artifactExists(record.artifact) && record.exit_code === 0);
  const latest = passing.at(-1);
  if (!latest?.artifact) return { id: "traceability", label: "Traceability", state: "blocked", detail: "Traceability has not been executed." };
  const body = readRecordedJson(latest.artifact);
  const missing = Array.isArray(body?.missingLinks) ? body.missingLinks : [];
  if (body?.status !== "PASS" || missing.length > 0) {
    return { id: "traceability", label: "Traceability", state: "fail", detail: "TRACEABILITY GAP", artifact: latest.artifact, command: latest.command, timestamp: latest.timestamp, evidence: latest.evidence_id };
  }
  return { id: "traceability", label: "Traceability", state: "pass", detail: "Requirements link to tickets, implementation, and evidence.", artifact: latest.artifact, command: latest.command, timestamp: latest.timestamp, evidence: latest.evidence_id };
}

const MATRIX_ROWS: Array<[string, string]> = [
  ["requirements", "Requirement"],
  ["unit", "Test"],
  ["review", "Review"],
  ["attack", "Attack"],
  ["browser", "Browser"],
  ["security", "Security"],
  ["nfr", "NFR"],
  ["architecture", "Architecture"],
  ["traceability", "Traceability"],
  ["human-release", "Approval"],
];

export function releaseMatrix(mission: Mission, artifactExists: (file: string) => boolean, commit: string | null = null): { current: ReleaseMatrixRow[]; historical: ReleaseMatrixRow[] } {
  const report = evaluateRelease(mission, artifactExists);
  const current: ReleaseMatrixRow[] = MATRIX_ROWS.map(([id, label]) => {
    const found = report.criteria.find((item) => item.id === id);
    if (!found) return { id, label, state: "NOT_REQUIRED", detail: "Not required for this mission.", commit };
    const state: ReleaseMatrixRow["state"] =
      found.state === "pass" || found.state === "waived" ? "PASS" : found.state === "fail" ? "FAIL" : found.pending ? (id === "human-release" ? "WAITING" : "NOT_RUN") : "BLOCKED";
    return { id, label, state, detail: found.detail, evidence: found.evidence, timestamp: found.timestamp, command: found.command, artifact: found.artifact, commit };
  });
  const historical = partitionEvidence(mission.evidence).superseded.map((record) => ({
    id: record.evidence_id,
    label: record.kind,
    state: "SUPERSEDED" as const,
    detail: `${record.kind} ${record.result} superseded by a later run of the same requirement.`,
    evidence: record.evidence_id,
    timestamp: record.timestamp,
    command: record.command,
    artifact: record.artifact,
    commit: record.commit ?? null,
  }));
  return { current, historical };
}

function combine(criteria: ReleaseCriterion[]): ReleaseState {
  if (criteria.some((item) => item.state === "fail")) return "fail";
  if (criteria.some((item) => item.state === "blocked")) return "blocked";
  if (criteria.some((item) => item.state === "concerns")) return "concerns";
  if (criteria.some((item) => item.state === "waived")) return "waived";
  return "pass";
}

/**
 * Implementation links for a requirement: implementation artifacts linked to it and built tickets that cover it.
 * A spec, PRD, or forge note linked to the requirement is not an implementation.
 */
export function implementationLinks(requirement: Requirement, mission: Mission): string[] {
  const artifacts = mission.artifacts
    .filter((artifact) => artifact.kind === "implementation" && requirement.linked_artifacts.includes(artifact.id))
    .map((artifact) => artifact.id);
  const built = mission.tickets
    .filter((ticket) => ticket.covers.includes(requirement.id) && mission.plans.some((plan) => plan.ref === ticket.ref && (plan.status === "built" || plan.status === "done")))
    .map((ticket) => `ticket ${ticket.ref} built`);
  return [...artifacts, ...built];
}

export function proofFor(requirement: Requirement, mission: Mission): Array<{ node: string; state: "present" | "missing" | "failed" | "stale" }> {
  const gate = (kind: string): "present" | "missing" | "failed" | "stale" => {
    const records = mission.evidence.filter((record) => record.requirement_id === requirement.id && record.kind === kind);
    const fresh = records.filter((record) => !evidenceIsStale(mission, record));
    if (records.length > 0 && fresh.length === 0) return "stale";
    const { current } = partitionEvidence(fresh);
    if (current.some((record) => record.result === "fail")) return "failed";
    if (current.some((record) => record.result === "pass")) return "present";
    return "missing";
  };
  const implemented = implementationLinks(requirement, mission).length > 0;
  const nodes: Array<[string, "present" | "missing" | "failed" | "stale"]> = [
    ["Requirement", "present"],
    ["Acceptance criterion", requirement.acceptance_criteria.length > 0 ? "present" : "missing"],
    ["Story", mission.tickets.some((ticket) => ticket.covers.includes(requirement.id)) ? "present" : "missing"],
    ["Implementation", implemented ? "present" : "missing"],
    ["Artifact", requirement.linked_artifacts.length > 0 ? "present" : "missing"],
    ["Tests", gate("unit") === "failed" || gate("integration") === "failed" ? "failed" : gate("unit") === "present" || gate("integration") === "present" ? "present" : gate("unit") === "stale" || gate("integration") === "stale" ? "stale" : "missing"],
    ["Review", gate("review")],
    ["Attack", gate("attack")],
    ["Browser", gate("browser")],
    ["Security", gate("security")],
    ["NFR", gate("nfr")],
    ["Evidence", mission.evidence.some((record) => record.requirement_id === requirement.id && record.result === "pass" && !evidenceIsStale(mission, record)) ? "present" : mission.evidence.some((record) => record.requirement_id === requirement.id && evidenceIsStale(mission, record)) ? "stale" : "missing"],
    ["Release", mission.lastVerifiedBuild ? "present" : "missing"],
  ];
  return nodes.map(([node, state]) => ({ node, state }));
}

export function requirementVerified(requirement: Requirement, mission: Mission, artifactExists: (file: string) => boolean): boolean {
  const kinds = requirementKinds(requirement, mission);
  return kinds.every((kind) => effectivePass(mission, requirement.id, kind, artifactExists));
}

function effectivePass(mission: Mission, requirementId: string, kind: string, artifactExists: (file: string) => boolean): boolean {
  const records = mission.evidence.filter((record) => record.requirement_id === requirementId && record.kind === kind && !evidenceIsStale(mission, record));
  const { current } = partitionEvidence(records);
  if (current.some((record) => record.result === "fail")) return false;
  return current.some((record) => record.result === "pass" && record.artifact && artifactExists(record.artifact) && record.exit_code === 0);
}

export function requirementCoverage(requirement: Requirement, mission: Mission): string {
  const tickets = mission.tickets.filter((ticket) => ticket.covers.includes(requirement.id));
  if (tickets.length === 0) return "TRACEABILITY GAP";
  const applicable = requirementKinds(requirement, mission);
  const implemented = implementationLinks(requirement, mission).length > 0;
  if (!implemented) return "SPECIFIED";
  const labels: Record<string, string> = {
    unit: "TESTED",
    review: "REVIEWED",
    attack: "ATTACKED",
    browser: "BROWSER VERIFIED",
    security: "SECURITY VERIFIED",
    nfr: "NFR VERIFIED",
  };
  let state = "IMPLEMENTED";
  for (const kind of ["unit", "review", "attack", "browser", "security", "nfr"]) {
    if (!applicable.includes(kind)) continue;
    if (!effectivePass(mission, requirement.id, kind, fileExists)) return state;
    state = labels[kind] ?? state;
  }
  return "FULLY PROVEN";
}

export function coverage(mission: Mission): {
  requirements: number;
  implemented: number;
  tested: number;
  browserVerified: number;
  securityVerified: number;
} {
  const has = (requirement: Requirement, kind: string) => effectivePass(mission, requirement.id, kind, fileExists);
  return {
    requirements: mission.requirements.length,
    implemented: mission.requirements.filter((requirement) => implementationLinks(requirement, mission).length > 0).length,
    tested: mission.requirements.filter((requirement) => has(requirement, "unit") || has(requirement, "integration")).length,
    browserVerified: mission.requirements.filter((requirement) => has(requirement, "browser")).length,
    securityVerified: mission.requirements.filter((requirement) => has(requirement, "security")).length,
  };
}

export function fileExists(file: string | undefined): boolean {
  return Boolean(file && fs.existsSync(file));
}

export function ticketRisk(ticket: { risk: RiskLevel }): RiskLevel {
  return ticket.risk;
}

export type { EvidenceResult };
