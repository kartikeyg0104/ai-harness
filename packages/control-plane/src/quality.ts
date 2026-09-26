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
}

export interface ReleaseMatrixRow {
  id: string;
  label: string;
  state: "PASS" | "FAIL" | "BLOCKED" | "NOT_REQUIRED" | "SUPERSEDED";
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

export function gateRunState(result: EvidenceResult | undefined): GateRunState {
  if (!result || result === "not-configured") return "NOT_RUN";
  if (result === "pass") return "PASS";
  if (result === "fail") return "FAIL";
  if (result === "blocked") return "BLOCKED";
  return "ERROR";
}

export function missionEvidenceKinds(mission: Mission): string[] {
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
    criteria.push({ id: "requirements", label: "Requirements", state: "blocked", detail: "No requirements recorded." });
  } else {
    const verified = mission.requirements.filter((requirement) => requirement.status === "verified").length;
    criteria.push({
      id: "requirements",
      label: "Requirements",
      state: verified === mission.requirements.length ? "pass" : "blocked",
      detail: `${verified} of ${mission.requirements.length} requirements are verified.`,
    });
  }
  const labels: Record<string, string> = { unit: "Tests", review: "Review", security: "Security", browser: "Browser QA", attack: "Attack", nfr: "NFR" };
  for (const kind of missionEvidenceKinds(mission)) {
    criteria.push(evidenceCriterion(mission, kind, labels[kind] ?? kind, artifactExists));
  }
  criteria.push(architectureCriterion(mission, artifactExists));
  criteria.push(traceabilityCriterion(mission, artifactExists));
  if (mission.complexity === "critical" || mission.requirements.some((requirement) => requirement.risk === "critical")) {
    const decisions = mission.approvals.filter((item) => item.category === "release" && item.identity.trim());
    const approval = decisions.at(-1);
    criteria.push({
      id: "human-release",
      label: "Human release approval",
      state: approval?.decision === "approved" ? "pass" : approval?.decision === "rejected" ? "fail" : "blocked",
      detail: approval?.decision === "approved" ? `Approved by ${approval.identity}.` : approval?.decision === "rejected" ? `Rejected by ${approval.identity}.` : "Critical work needs a named human release approval.",
      timestamp: approval?.at,
      evidence: approval?.id,
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

export function evidenceIsStale(mission: Mission, record: EvidenceRecord): boolean {
  if (!record.requirement_id) return false;
  const requirement = mission.requirements.find((item) => item.id === record.requirement_id);
  if (!requirement) return false;
  return (record.requirement_version ?? 1) < requirement.version;
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
    return { id: kind, label, state: "blocked", detail: "No run recorded." };
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
    return { id: "architecture", label: "Architecture", state: "blocked", detail: "Architecture is not declared." };
  }
  const { current } = partitionEvidence(mission.evidence.filter((record) => record.kind === "architecture"));
  const failing = current.filter((record) => record.result === "fail");
  if (failing.length > 0) {
    const latest = failing.at(-1);
    return { id: "architecture", label: "Architecture", state: "fail", detail: "Architecture verification found blocking drift.", artifact: latest?.artifact, command: latest?.command, timestamp: latest?.timestamp, evidence: latest?.evidence_id };
  }
  const passing = current.filter((record) => record.result === "pass" && record.artifact && artifactExists(record.artifact) && record.exit_code === 0);
  const latest = passing.at(-1);
  if (!latest?.artifact) return { id: "architecture", label: "Architecture", state: "blocked", detail: "Architecture verification has not been executed." };
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
  if (current.length === 0) return { id: "traceability", label: "Traceability", state: "blocked", detail: "Traceability has not been executed." };
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
    const state: ReleaseMatrixRow["state"] = found.state === "pass" || found.state === "waived" ? "PASS" : found.state === "fail" ? "FAIL" : "BLOCKED";
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

export function proofFor(requirement: Requirement, mission: Mission): Array<{ node: string; state: "present" | "missing" | "failed" }> {
  const gate = (kind: string): "present" | "missing" | "failed" => {
    const records = mission.evidence.filter((record) => record.requirement_id === requirement.id && record.kind === kind);
    const { current } = partitionEvidence(records);
    if (current.some((record) => record.result === "fail")) return "failed";
    if (current.some((record) => record.result === "pass")) return "present";
    return "missing";
  };
  const implemented =
    requirement.linked_artifacts.length > 0 ||
    mission.plans.some((plan) => plan.status === "built" && mission.tickets.some((ticket) => ticket.ref === plan.ref && ticket.covers.includes(requirement.id)));
  const nodes: Array<[string, "present" | "missing" | "failed"]> = [
    ["Requirement", "present"],
    ["Acceptance criterion", requirement.acceptance_criteria.length > 0 ? "present" : "missing"],
    ["Story", mission.tickets.some((ticket) => ticket.covers.includes(requirement.id)) ? "present" : "missing"],
    ["Implementation", implemented ? "present" : "missing"],
    ["Artifact", requirement.linked_artifacts.length > 0 ? "present" : "missing"],
    ["Tests", gate("unit") === "failed" ? "failed" : gate("unit") === "present" || gate("integration") === "present" ? "present" : "missing"],
    ["Review", gate("review")],
    ["Attack", gate("attack")],
    ["Browser", gate("browser")],
    ["Security", gate("security")],
    ["NFR", gate("nfr")],
    ["Evidence", mission.evidence.some((record) => record.requirement_id === requirement.id && record.result === "pass") ? "present" : "missing"],
    ["Release", mission.lastVerifiedBuild ? "present" : "missing"],
  ];
  return nodes.map(([node, state]) => ({ node, state }));
}

export function requirementVerified(requirement: Requirement, mission: Mission, artifactExists: (file: string) => boolean): boolean {
  const kinds = requirement.verification_methods.length > 0 ? requirement.verification_methods : requiredEvidenceKinds(requirement.risk);
  return kinds.every((kind) => effectivePass(mission, requirement.id, kind, artifactExists));
}

function effectivePass(mission: Mission, requirementId: string, kind: string, artifactExists: (file: string) => boolean): boolean {
  const records = mission.evidence.filter((record) => record.requirement_id === requirementId && record.kind === kind);
  const { current } = partitionEvidence(records);
  if (current.some((record) => record.result === "fail")) return false;
  return current.some((record) => record.result === "pass" && record.artifact && artifactExists(record.artifact) && record.exit_code === 0);
}

export function requirementCoverage(requirement: Requirement, mission: Mission): string {
  const tickets = mission.tickets.filter((ticket) => ticket.covers.includes(requirement.id));
  if (tickets.length === 0) return "TRACEABILITY GAP";
  const applicable = requirement.verification_methods.length > 0 ? requirement.verification_methods : requiredEvidenceKinds(requirement.risk, mission.attackRiskFloor ?? "high");
  const implemented =
    requirement.linked_artifacts.length > 0 ||
    mission.plans.some((plan) => plan.status === "built" && tickets.some((ticket) => ticket.ref === plan.ref));
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
    implemented: mission.requirements.filter((requirement) => requirement.linked_artifacts.length > 0).length,
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
