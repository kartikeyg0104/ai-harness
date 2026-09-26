import { fileExists, partitionEvidence, requiredEvidenceKinds, requirementCoverage } from "./quality";
import type { Mission, Requirement } from "./types";

export interface TraceLinks {
  acceptance: string[];
  tickets: string[];
  implementation: string[];
  tests: string[];
  review: string[];
  attack: string[];
  browser: string[];
  security: string[];
  nfr: string[];
  evidence: string[];
}

export interface TracedRequirement {
  id: string;
  links: TraceLinks;
  missing: string[];
  coverage: string;
}

export interface TraceabilityDocument {
  requirements: TracedRequirement[];
  linkedArtifacts: string[];
  missingLinks: string[];
  gaps: string[];
  coverage: { requirements: number; fullyProven: number; gaps: number };
  timestamp: string;
  status: "PASS" | "FAIL" | "BLOCKED";
}

function passed(mission: Mission, requirement: Requirement, kind: string): string[] {
  const records = mission.evidence.filter((record) => record.requirement_id === requirement.id && record.kind === kind);
  const { current } = partitionEvidence(records);
  if (current.some((record) => record.result === "fail")) return [];
  return current
    .filter((record) => record.result === "pass" && record.exit_code === 0 && record.artifact && fileExists(record.artifact))
    .map((record) => record.evidence_id);
}

export function traceMission(mission: Mission, timestamp: string): TraceabilityDocument {
  if (mission.requirements.length === 0) {
    return {
      requirements: [],
      linkedArtifacts: [],
      missingLinks: ["requirements"],
      gaps: [],
      coverage: { requirements: 0, fullyProven: 0, gaps: 0 },
      timestamp,
      status: "BLOCKED",
    };
  }
  const requirements = mission.requirements.map((requirement) => {
    const tickets = mission.tickets.filter((ticket) => ticket.covers.includes(requirement.id));
    const applicable = requirement.verification_methods.length > 0 ? requirement.verification_methods : requiredEvidenceKinds(requirement.risk, mission.attackRiskFloor ?? "high");
    const links: TraceLinks = {
      acceptance: requirement.acceptance_criteria.filter((item) => item.trim()),
      tickets: tickets.map((ticket) => ticket.ref),
      implementation: requirement.linked_artifacts.slice(),
      tests: passed(mission, requirement, "unit"),
      review: passed(mission, requirement, "review"),
      attack: passed(mission, requirement, "attack"),
      browser: passed(mission, requirement, "browser"),
      security: passed(mission, requirement, "security"),
      nfr: passed(mission, requirement, "nfr"),
      evidence: mission.evidence.filter((record) => record.requirement_id === requirement.id && record.result === "pass").map((record) => record.evidence_id),
    };
    const missing: string[] = [];
    if (links.acceptance.length === 0) missing.push("acceptance criterion");
    if (links.tickets.length === 0) missing.push("ticket");
    const built = mission.plans.some((plan) => plan.status === "built" && tickets.some((ticket) => ticket.ref === plan.ref));
    if (links.implementation.length === 0 && !built) missing.push("implementation");
    const kindLink: Record<string, string[]> = {
      unit: links.tests,
      review: links.review,
      attack: links.attack,
      browser: links.browser,
      security: links.security,
      nfr: links.nfr,
    };
    for (const kind of applicable) {
      if ((kindLink[kind] ?? []).length === 0) missing.push(kind);
    }
    return { id: requirement.id, links, missing, coverage: requirementCoverage(requirement, mission) };
  });
  const missingLinks = requirements.flatMap((requirement) => requirement.missing.map((item) => `${requirement.id} ${item}`));
  const gaps = requirements.filter((requirement) => requirement.links.tickets.length === 0).map((requirement) => requirement.id);
  const fullyProven = requirements.filter((requirement) => requirement.coverage === "FULLY PROVEN").length;
  return {
    requirements,
    linkedArtifacts: mission.requirements.flatMap((requirement) => requirement.linked_artifacts),
    missingLinks,
    gaps,
    coverage: { requirements: requirements.length, fullyProven, gaps: gaps.length },
    timestamp,
    status: missingLinks.length === 0 ? "PASS" : "FAIL",
  };
}
