import type { Complexity, MissionMode, PhaseId, SkillOrigin, WorkflowStep } from "./types";

export interface SkillDescriptor {
  id: string;
  origin: SkillOrigin;
  phase: PhaseId;
  module: string;
  summary: string;
}

/** Upstream skills present on BMAD-METHOD main at the pinned commit. */
export const UPSTREAM_SKILLS: SkillDescriptor[] = [
  { id: "bmad", origin: "upstream-bmad-method", phase: "discover", module: "core", summary: "BMad Master setup, roster, and help." },
  { id: "bmad-forge-idea", origin: "upstream-bmad-method", phase: "discover", module: "bmm", summary: "Pressure-test a half-formed idea until it is hardened, killed, or clarified." },
  { id: "bmad-brainstorming", origin: "upstream-bmad-method", phase: "discover", module: "bmm", summary: "Structured brainstorming." },
  { id: "bmad-advanced-elicitation", origin: "upstream-bmad-method", phase: "discover", module: "bmm", summary: "Challenge requirements that would change the implementation." },
  { id: "bmad-deep-recon", origin: "upstream-bmad-method", phase: "discover", module: "bmm", summary: "Technical, domain, market, and user research that produces reusable artifacts." },
  { id: "bmad-product-brief", origin: "upstream-bmad-method", phase: "discover", module: "bmm", summary: "Product brief." },
  { id: "bmad-prfaq", origin: "upstream-bmad-method", phase: "discover", module: "bmm", summary: "Press-release and FAQ framing." },
  { id: "bmad-spec", origin: "upstream-bmad-method", phase: "specify", module: "bmm", summary: "Distill intent into a SPEC.md contract." },
  { id: "bmad-prd", origin: "upstream-bmad-method", phase: "specify", module: "bmm", summary: "Product requirements document." },
  { id: "bmad-ux", origin: "upstream-bmad-method", phase: "design", module: "bmm", summary: "UX design workflow." },
  { id: "bmad-architecture", origin: "upstream-bmad-method", phase: "design", module: "bmm", summary: "Architecture workflow." },
  { id: "bmad-party-mode", origin: "upstream-bmad-method", phase: "design", module: "bmm", summary: "Multi-persona working session with saved parties." },
  { id: "bmad-project-context", origin: "upstream-bmad-method", phase: "design", module: "bmm", summary: "Verified project context block for AGENTS.md." },
  { id: "bmad-preview-ticketing", origin: "upstream-bmad-method", phase: "plan", module: "bmm", summary: "Ticket tree: initiatives, epics, and entries. Status lives in plan files." },
  { id: "bmad-build", origin: "upstream-bmad-method", phase: "build", module: "bmm", summary: "Implement one ticket. Stops at built. Does not mark done." },
  { id: "bmad-build-auto", origin: "upstream-bmad-method", phase: "build", module: "bmm", summary: "Unattended build of a named ticket. Halts unclear intent when no ticket is named." },
  { id: "bmad-code-review", origin: "upstream-bmad-method", phase: "verify", module: "bmm", summary: "Review a built ticket from its plan and baseline revision. Does not change ticket status." },
  { id: "bmad-review", origin: "upstream-bmad-method", phase: "verify", module: "core", summary: "Review lenses: adversarial, edge-case, verification-gap, structure, prose." },
  { id: "bmad-qa-generate-e2e-tests", origin: "upstream-bmad-method", phase: "verify", module: "bmm", summary: "Generate end-to-end tests." },
  { id: "bmad-walkthrough", origin: "upstream-bmad-method", phase: "verify", module: "bmm", summary: "Walk through a change." },
  { id: "bmad-correct-course", origin: "upstream-bmad-method", phase: "build", module: "bmm", summary: "Mid-stream change handling on the ticket tree." },
  { id: "bmad-retrospective", origin: "upstream-bmad-method", phase: "learn", module: "bmm", summary: "Evidence-based epic retrospective written beside the epic." },
  { id: "bmad-agent-analyst", origin: "upstream-bmad-method", phase: "discover", module: "bmm", summary: "Analyst agent." },
  { id: "bmad-agent-pm", origin: "upstream-bmad-method", phase: "specify", module: "bmm", summary: "Product manager agent." },
  { id: "bmad-agent-ux-designer", origin: "upstream-bmad-method", phase: "design", module: "bmm", summary: "UX designer agent." },
  { id: "bmad-agent-architect", origin: "upstream-bmad-method", phase: "design", module: "bmm", summary: "Architect agent." },
  { id: "bmad-agent-dev", origin: "upstream-bmad-method", phase: "build", module: "bmm", summary: "Developer agent." },
  { id: "bmad-customize", origin: "upstream-bmad-method", phase: "learn", module: "core", summary: "Customize skill defaults." },
  { id: "bmod-core-tools", origin: "upstream-bmad-method", phase: "learn", module: "core", summary: "Core module tools." },
  { id: "bmod-method", origin: "upstream-bmad-method", phase: "learn", module: "bmm", summary: "Method module help and routing." },
];

export const GATE_SKILLS: SkillDescriptor[] = [
  { id: "bmad-next:attack", origin: "bmad-next-gate", phase: "verify", module: "gate", summary: "Adversarial gate. Passes only from a recorded attack run." },
  { id: "bmad-next:browser", origin: "bmad-next-gate", phase: "verify", module: "gate", summary: "Browser verification gate." },
  { id: "bmad-next:security", origin: "bmad-next-gate", phase: "verify", module: "gate", summary: "Security scan gate." },
  { id: "bmad-next:nfr", origin: "bmad-next-gate", phase: "verify", module: "gate", summary: "NFR measurement gate." },
  { id: "bmad-next:release", origin: "bmad-next-gate", phase: "ship", module: "gate", summary: "Fail-closed release gate." },
];

export const EXTERNAL_MODULES: SkillDescriptor[] = [
  { id: "tea", origin: "external-module", phase: "plan", module: "tea", summary: "Test Architect module. Not vendored; selected when the module is installed." },
  { id: "cis", origin: "external-module", phase: "discover", module: "cis", summary: "Creative Intelligence Suite." },
  { id: "gds", origin: "external-module", phase: "discover", module: "gds", summary: "Game Dev Studio." },
  { id: "builder", origin: "external-module", phase: "learn", module: "builder", summary: "BMad Builder for agents, workflows, skills, and modules." },
  { id: "loop", origin: "external-module", phase: "build", module: "loop", summary: "BMad Loop deterministic execution." },
];

export const SKILL_CATALOG: SkillDescriptor[] = [...UPSTREAM_SKILLS, ...GATE_SKILLS, ...EXTERNAL_MODULES];

export function skillById(id: string): SkillDescriptor | undefined {
  return SKILL_CATALOG.find((skill) => skill.id === id);
}

const WORKFLOWS: Record<Complexity, string[]> = {
  simple: ["bmad-spec", "bmad-build", "bmad-code-review"],
  medium: [
    "bmad-forge-idea",
    "bmad-spec",
    "bmad-prd",
    // The release gate verifies declared architecture for every mission, so medium work must declare it.
    "bmad-architecture",
    "bmad-preview-ticketing",
    "bmad-build",
    "bmad-code-review",
    "bmad-retrospective",
  ],
  complex: [
    "bmad-forge-idea",
    "bmad-brainstorming",
    "bmad-advanced-elicitation",
    "bmad-deep-recon",
    "bmad-spec",
    "bmad-prd",
    "bmad-ux",
    "bmad-architecture",
    "bmad-party-mode",
    "tea",
    "bmad-preview-ticketing",
    "bmad-build",
    "bmad-code-review",
    "bmad-review",
    "bmad-next:browser",
    "bmad-next:security",
    "bmad-next:release",
    "bmad-retrospective",
  ],
  critical: [
    "bmad-forge-idea",
    "bmad-brainstorming",
    "bmad-advanced-elicitation",
    "bmad-deep-recon",
    "bmad-product-brief",
    "bmad-spec",
    "bmad-prd",
    "bmad-ux",
    "bmad-architecture",
    "bmad-party-mode",
    "bmad-project-context",
    "tea",
    "bmad-preview-ticketing",
    "bmad-build",
    "bmad-code-review",
    "bmad-review",
    "bmad-next:attack",
    "bmad-next:browser",
    "bmad-next:security",
    "bmad-next:nfr",
    "bmad-next:release",
    "bmad-retrospective",
  ],
};

export function selectWorkflow(complexity: Complexity, mode: MissionMode): WorkflowStep[] {
  const ids = [...WORKFLOWS[complexity]];
  if (mode === "brownfield" && !ids.includes("bmad-project-context")) {
    const designAt = ids.indexOf("bmad-architecture");
    const insertAt = designAt === -1 ? ids.length : designAt;
    ids.splice(insertAt, 0, "bmad-project-context");
  }
  if (mode === "quick") {
    return ["bmad-spec", "bmad-build", "bmad-code-review"].map(toStep);
  }
  return ids.map(toStep);
}

function toStep(id: string): WorkflowStep {
  const skill = skillById(id);
  if (!skill) {
    throw new Error(`Unknown skill ${id}`);
  }
  const awaitingModel = skill.origin === "upstream-bmad-method" || skill.origin === "external-module";
  return {
    skillId: skill.id,
    origin: skill.origin,
    phase: skill.phase,
    status: awaitingModel ? "awaiting-model" : "pending",
    reason: awaitingModel ? "Skill runs when a model runner is configured." : undefined,
  };
}

export const PARTY_PRESETS: Record<string, string[]> = {
  architecture: ["Architect", "Security", "Performance", "TEA", "DevOps"],
  product: ["Analyst", "Product Manager", "UX", "Architect"],
  risk: ["TEA", "Security", "Adversary", "Developer"],
  full: [
    "Analyst",
    "Product Manager",
    "UX",
    "Architect",
    "Developer",
    "TEA",
    "Security",
    "Performance",
    "Research",
    "Adversary",
    "DevOps",
  ],
};

export const MARKETPLACE = [
  { id: "bmad-method", kind: "module", source: "https://github.com/bmad-code-org/BMAD-METHOD", installed: false },
  { id: "tea", kind: "module", source: "https://github.com/bmad-code-org/bmad-method-test-architecture-enterprise", installed: false },
  { id: "cis", kind: "module", source: "https://github.com/bmad-code-org/bmad-module-creative-intelligence-suite", installed: false },
  { id: "gds", kind: "module", source: "https://github.com/bmad-code-org/bmad-module-game-dev-studio", installed: false },
  { id: "builder", kind: "module", source: "https://github.com/bmad-code-org/bmad-builder", installed: false },
  { id: "loop", kind: "module", source: "https://github.com/bmad-code-org/bmad-loop", installed: false },
  { id: "openhands", kind: "runtime", source: "https://github.com/OpenHands/software-agent-sdk", installed: false },
  { id: "acp", kind: "protocol", source: "https://github.com/agentclientprotocol/agent-client-protocol", installed: false },
] as const;

export const BMAD_METHOD_PIN = {
  repository: "https://github.com/bmad-code-org/BMAD-METHOD",
  commit: "5e33d3c03ba53187a40ab679d5479cdd4b6ac2fb",
  latestReleaseTag: "v6.12.0",
  defaultBranch: "main",
  inspectedAt: "2026-09-26",
  note: "main is ahead of the v6.12.0 tag. The pin is the main commit inspected for this build, which uses the ticket tree.",
};
