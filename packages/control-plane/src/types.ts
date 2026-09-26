export type Complexity = "simple" | "medium" | "complex" | "critical";
export type MissionMode = "quick" | "greenfield" | "brownfield";
export type ScanLevel = "quick" | "deep" | "exhaustive";
export type Autonomy = "observe" | "assist" | "semi-autonomous" | "autonomous" | "full-mission";
export type CapabilityStatus =
  | "available"
  | "not-configured"
  | "blocked"
  | "not-available"
  | "configured"
  | "experimental";
export type LoopState =
  | "draft"
  | "ready"
  | "running"
  | "verifying"
  | "reviewing"
  | "attacking"
  | "repairing"
  | "blocked"
  | "verified"
  | "committed"
  | "released"
  | "failed"
  | "cancelled";
export type ArtifactState = "not-started" | "in-progress" | "complete" | "failed" | "stale" | "invalid";
export type GateRunState = "NOT_RUN" | "RUNNING" | "PASS" | "FAIL" | "BLOCKED" | "WAIVED" | "ERROR";
export type RuntimeAvailability = "AVAILABLE" | "CONFIGURED" | "NOT CONFIGURED" | "FAILED";
export type SkillRunStatus = "resolved" | "started" | "completed" | "failed" | "output-missing" | "output-invalid" | "timeout" | "missing-artifact";
export type PhaseId = "discover" | "specify" | "design" | "plan" | "build" | "verify" | "ship" | "learn";
export type StepStatus =
  | "pending"
  | "awaiting-user"
  | "awaiting-model"
  | "completed"
  | "skipped"
  | "blocked"
  | "not-configured";
export type TicketStatus =
  | "planned"
  | "draft"
  | "ready-for-dev"
  | "in-progress"
  | "blocked"
  | "in-review"
  | "built"
  | "done"
  | "dropped";
export type SprintProjection =
  | "BACKLOG"
  | "READY"
  | "IN PROGRESS"
  | "BLOCKED"
  | "REVIEW"
  | "VERIFYING"
  | "DONE"
  | "DEFERRED";
export type ReleaseState = "pass" | "concerns" | "fail" | "waived" | "blocked";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type ForgeOutcome = "active" | "hardened" | "killed" | "clarified";
export type EvidenceResult = "pass" | "fail" | "blocked" | "not-configured" | "concerns";
export type PolicyDecision = "allow" | "approval" | "block";
export type SkillOrigin = "upstream-bmad-method" | "bmad-next-gate" | "external-module";

export type EventType =
  | "MissionCreated"
  | "ForgeSessionStarted"
  | "ForgeAnswered"
  | "ForgeClosed"
  | "SpecCreated"
  | "BriefCreated"
  | "PRDCreated"
  | "PartyStarted"
  | "PartyTurn"
  | "DecisionRecorded"
  | "ResearchStarted"
  | "ArchitectureCreated"
  | "StoryCreated"
  | "StoryStarted"
  | "AgentStarted"
  | "ToolCalled"
  | "ArtifactCreated"
  | "BaselineTested"
  | "TestStarted"
  | "TestPassed"
  | "TestFailed"
  | "ReviewStarted"
  | "ReviewCompleted"
  | "ReviewFailed"
  | "FindingCreated"
  | "AttackStarted"
  | "AttackCompleted"
  | "AttackFailed"
  | "RepairStarted"
  | "BrowserStarted"
  | "BrowserStepStarted"
  | "BrowserStepCompleted"
  | "BrowserFailed"
  | "SecurityStarted"
  | "SecurityToolStarted"
  | "SecurityToolCompleted"
  | "SecurityFailed"
  | "EvidenceCreated"
  | "GateEvaluated"
  | "CheckpointCreated"
  | "CommitCreated"
  | "PRCreated"
  | "RetrospectiveStarted"
  | "MemoryUpdated"
  | "SkillCreated"
  | "EvalStarted"
  | "EvalCompleted"
  | "CorrectCourse"
  | "Escalated"
  | "HumanCheckpoint"
  | "WorkflowSelected"
  | "ArtifactStarted"
  | "ArtifactCompleted"
  | "TicketCreated"
  | "TicketStarted"
  | "TicketBuilt"
  | "TicketBlocked"
  | "WorktreeCreated"
  | "SkillResolved"
  | "SkillStarted"
  | "SkillCompleted"
  | "SkillFailed"
  | "VerificationStarted"
  | "AgentCompleted"
  | "AgentFailed"
  | "ToolStarted"
  | "ToolCompleted"
  | "BrowserCompleted"
  | "SecurityCompleted"
  | "ReleaseCreated"
  | "RetrospectiveCreated"
  | "SkillPublished"
  | "NfrStarted"
  | "NfrCompleted"
  | "NfrFailed"
  | "ArchitectureDeclared"
  | "PolicyTightened"
  | "RepairCompleted"
  | "AutopilotStarted"
  | "AutopilotStopped"
  | "ArchitectureVerificationStarted"
  | "ArchitectureVerificationCompleted"
  | "TraceabilityChecked"
  | "WorktreeReleased"
  | "ReleaseApproved"
  | "ReleaseRejected"
  | "ReleaseGateEvaluated"
  | "SkillCandidateCreated"
  | "PluginInstalled"
  | "PluginDisabled"
  | "PluginRolledBack";

export interface DomainEvent {
  id: string;
  type: EventType;
  missionId: string;
  at: string;
  data: Record<string, unknown>;
}

export interface WorkflowStep {
  skillId: string;
  origin: SkillOrigin;
  phase: PhaseId;
  status: StepStatus;
  reason?: string;
  artifactId?: string;
}

export interface ForgeQuestion {
  id: string;
  prompt: string;
  why: string;
}

export interface ForgeLock {
  kind: "decision" | "assumption" | "crack" | "kill" | "direction" | "lock" | "note";
  key: string;
  text: string;
  at: string;
  /** Who supplied the text. Model-proposed answers are recorded as assumptions a person can revise. */
  source?: "user" | "model";
}

export interface ForgeSession {
  outcome: ForgeOutcome;
  idea: string;
  goal: string;
  mode: "clarify" | "attack" | "defend";
  questions: ForgeQuestion[];
  answered: string[];
  locks: ForgeLock[];
  workspace: string;
  persistence: "control-plane" | "upstream-memlog";
}

export interface Requirement {
  id: string;
  title: string;
  description: string;
  priority: string;
  risk: RiskLevel;
  source: string;
  acceptance_criteria: string[];
  verification_methods: string[];
  dependencies: string[];
  status: string;
  linked_artifacts: string[];
  version: number;
}

export interface EpicRecord {
  id: number;
  slug: string;
  title: string;
  covers: string[];
  after: Array<{ epic: number; needs: string }>;
}

export interface TicketEntry {
  epicId: number;
  id: number;
  type: "story" | "spike" | "bug";
  title: string;
  description: string;
  verify: string;
  covers: string[];
  after: Array<number | string>;
  hits: boolean;
  risk: RiskLevel;
  paths: string[];
  ref: string;
  priority: string;
  plan_file: string | null;
  verification: string;
}

export interface TicketPlan {
  ref: string;
  status: TicketStatus;
  baseline_revision: string | null;
  blocked_reason: string | null;
  body: string;
  version: number;
}

export interface Artifact {
  id: string;
  kind: string;
  skillId: string;
  version: number;
  parentId?: string;
  creator: string;
  agent?: string;
  missionId: string;
  createdAt: string;
  body: string;
  path: string;
  dependencies: string[];
  verified: boolean;
  producer: string;
  state: ArtifactState;
  provenance?: ArtifactProvenance;
}

export interface ArtifactProvenance {
  skill: string;
  commit: string;
  runner: string;
  missionId: string;
  ticketRef: string | null;
  timestamp: string;
  inputPath: string;
  outputPath: string;
  status: string;
}

export interface EvidenceRecord {
  evidence_id: string;
  mission_id: string;
  requirement_id?: string;
  requirement_version?: number;
  story_id?: string;
  agent?: string;
  runtime?: string;
  model?: string;
  commit?: string;
  test?: string;
  browser_run?: string;
  security_run?: string;
  timestamp: string;
  result: EvidenceResult;
  artifact?: string;
  kind: string;
  runner: string;
  started_at: string;
  finished_at: string;
  exit_code: number | null;
  command: string;
  type: string;
  source: string;
}

export interface Finding {
  id: string;
  code: string;
  severity: RiskLevel;
  message: string;
  requirementId?: string;
  ticketRef?: string;
  paths: string[];
  source?: string;
  target?: string;
  description?: string;
  evidence?: string[];
  createdAt?: string;
  status?: "open" | "resolved";
}

export interface PartyTurn {
  id: string;
  speaker: string;
  stance: "discuss" | "attack" | "defend" | "dissent";
  text: string;
  at: string;
  source: "user" | "model-run";
}

export interface PartyRoom {
  id: string;
  name: string;
  preset: string;
  mode: "discussion" | "adversarial" | "anti-consensus";
  members: string[];
  turns: PartyTurn[];
  decisionId?: string;
  status: "open" | "closed";
}

export interface DecisionRecord {
  id: string;
  roomId?: string;
  title: string;
  decision: string;
  alternatives: string[];
  reasoning: string;
  evidenceIds: string[];
  consequences: string;
  adrId?: string;
}

export interface AgentContract {
  name: string;
  role: string;
  capabilities: string[];
  skills: string[];
  tools: string[];
  inputs: string[];
  outputs: string[];
  permissions: {
    read: string[];
    write: string[];
    execute: string[];
    blocked: string[];
  };
  risk: RiskLevel;
  runtime: string | null;
  models: string[];
  memory: string;
  evaluation_suite: string | null;
  published: boolean;
}

export interface UsageRecord {
  id: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  tool_calls: number | null;
  latency_ms: number | null;
  retries: number;
  cost: number | null;
  agent?: string;
  story_id?: string;
  at: string;
}

export interface MemoryEntry {
  id: string;
  topic: string;
  text: string;
  sourceEventId: string;
  at: string;
  verified: boolean;
  invalidated: boolean;
}

export interface SkillCandidate {
  id: string;
  name: string;
  fromFailure: string;
  body: string;
  evaluation: { status: "not-run" | "passed" | "failed"; cases: number; passed: number };
  published: boolean;
}

export interface ProjectBrain {
  architecture: MemoryEntry[];
  decisions: MemoryEntry[];
  constraints: MemoryEntry[];
  successfulPatterns: MemoryEntry[];
  failurePatterns: MemoryEntry[];
  knownBugs: MemoryEntry[];
  dependencies: MemoryEntry[];
  teamConventions: MemoryEntry[];
  securityRules: MemoryEntry[];
  reviewStyle: MemoryEntry[];
  deploymentRules: MemoryEntry[];
  skillCandidates: SkillCandidate[];
}

export interface Approval {
  id: string;
  category: string;
  decision: "approved" | "rejected";
  identity: string;
  reason: string;
  at: string;
}

export interface ReleaseApproval {
  id: string;
  missionId: string;
  approver: string;
  decision: "APPROVED" | "REJECTED";
  reason?: string;
  timestamp: string;
}

export interface NfrRequirement {
  id: string;
  category: "performance" | "reliability" | "availability" | "resource" | "scalability";
  metric: string;
  operator: "<" | "<=" | ">" | ">=" | "==";
  target: number;
  unit: string;
  verificationMethod: string;
}

export interface SecurityFinding {
  id: string;
  tool: string;
  severity: string;
  category: string;
  message: string;
  path?: string;
  line?: number;
  evidence?: string;
}

export interface SecurityRun {
  id: string;
  ticketRef: string;
  status: "NOT_CONFIGURED" | "PASS" | "FAIL" | "TIMEOUT" | "ERROR";
  findings: SecurityFinding[];
  tools: Array<{ id: string; status: string; version: string; command: string; scanners: string[] }>;
  evidencePath: string;
  endedAt: string;
}

export interface NfrRun {
  id: string;
  ticketRef: string;
  metric: string;
  measured: number | null;
  target: string;
  unit: string;
  result: string;
  command: string;
  evidencePath: string;
  timestamp: string;
}

export interface Checkpoint {
  id: string;
  label: string;
  at: string;
  loop: LoopState;
  verified: boolean;
}

export interface ArchitectureDecision {
  id: string;
  kind: string;
  choice: string;
  alternatives: string[];
}

export interface JourneyDeclaration {
  id: string;
  name: string;
  steps: number;
}

export interface Mission {
  schemaVersion?: number;
  id: string;
  title: string;
  input: string;
  createdAt: string;
  updatedAt: string;
  complexity: Complexity;
  mode: MissionMode;
  scanLevel: ScanLevel;
  autonomy: Autonomy;
  phase: PhaseId;
  loop: LoopState;
  workflow: WorkflowStep[];
  forge?: ForgeSession;
  requirements: Requirement[];
  epics: EpicRecord[];
  tickets: TicketEntry[];
  plans: TicketPlan[];
  ticketTreeAccepted: boolean;
  artifacts: Artifact[];
  evidence: EvidenceRecord[];
  findings: Finding[];
  rooms: PartyRoom[];
  decisions: DecisionRecord[];
  architecture: ArchitectureDecision[];
  journeys: JourneyDeclaration[];
  agents: AgentContract[];
  usage: UsageRecord[];
  brain: ProjectBrain;
  approvals: Approval[];
  checkpoints: Checkpoint[];
  lastVerifiedBuild: { checkpointId: string; at: string; commit: string | null; missionId?: string; releaseEvidence?: string } | null;
  nfrRequirements?: NfrRequirement[];
  securityRuns?: SecurityRun[];
  nfrRuns?: NfrRun[];
  escalationLevel: number;
  attempts: Record<string, number>;
  dispatches: DispatchRecord[];
  executions: TicketExecution[];
  reviews: ReviewRecord[];
  repairs: RepairRecord[];
  attacks: AttackRecord[];
  attackRiskFloor?: "medium" | "high";
  /** Human gates in force when the mission was created (ControlConfig.humanGates). */
  humanGates?: string[];
  /** Evidence kinds the project requires on top of the risk-based set (ControlConfig.requiredEvidence). */
  requiredEvidence?: string[];
  waivers: Waiver[];
  projectContext: ProjectContext;
}

export interface Waiver {
  id: string;
  criterion: string;
  identity: string;
  reason: string;
  at: string;
}

export interface TicketExecution {
  ticketRef: string;
  skillId: string;
  runnerCommand: string | null;
  runner: string | null;
  agent: string;
  runtime: string;
  worktree: string | null;
  startedAt: string | null;
  endedAt: string | null;
  status: "not-configured" | "running" | "completed" | "failed" | "timeout" | "blocked";
  attempts: number;
  attempt: number;
  changedFiles: string[];
  artifact: string | null;
  evidence: string[];
  verification: "not-run" | "pass" | "fail" | "blocked";
  updatedAt: string;
  phase?: "STARTING" | "RUNNING" | "EDITING" | "VERIFYING" | "COMPLETED" | "FAILED" | "TIMED_OUT" | "CANCELLED";
  phases?: Array<"STARTING" | "RUNNING" | "EDITING" | "VERIFYING" | "COMPLETED" | "FAILED" | "TIMED_OUT" | "CANCELLED">;
  retryBudget?: number;
  /** Raw runtime transcript of the latest build or repair run. */
  runtimeLog?: string;
}

export interface DispatchRecord {
  id: string;
  ticketRef: string;
  agent: string;
  runtime: string;
  status: CapabilityStatus | "completed" | "failed";
  worktree?: string;
  at: string;
  message: string;
}

export interface ProjectContext {
  architecture: string[];
  technology: string[];
  conventions: string[];
  constraints: string[];
  frozenAreas: string[];
  securityRules: string[];
  deploymentRules: string[];
  sources: string[];
}

export interface ControlConfig {
  autonomy: Autonomy;
  defaultRuntime: string | null;
  defaultModel: string | null;
  models: Partial<Record<"reasoning" | "coding" | "fast" | "research" | "local", string>>;
  sandbox: "local-directory";
  maxCostUsd: number | null;
  retryBudget: number;
  approvalPolicy: "safe";
  browserMode: CapabilityStatus;
  securityPolicy: "fail-closed";
  researchMode: CapabilityStatus;
  humanGates: string[];
  runnerCommand: string | null;
  runner: BmadRunnerConfig | null;
  reviewer: BmadRunnerConfig | null;
  attacker: BmadRunnerConfig | null;
  attackRiskFloor: "medium" | "high";
  browserOrigins: string[];
  /** Evidence kinds every mission must pass regardless of risk, e.g. ["unit","review","attack","browser","security","nfr"]. */
  requiredEvidence?: string[];
}

export interface BmadRunnerConfig {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  model?: string | null;
}

export type BmadRunStatus = "not-configured" | "starting" | "running" | "completed" | "failed" | "timeout" | "invalid-output" | "output-invalid" | "output-missing" | "missing-artifact";

export interface BmadRunResult {
  status: BmadRunStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Why the output did or did not meet the skill contract. */
  reason?: string;
  artifactPath?: string;
  durationMs?: number;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface CommandRunner {
  which(bin: string): string | null;
  run(command: string, args: string[], cwd: string, timeoutMs: number, env?: Record<string, string>): CommandResult;
}

export const DEFAULT_CONFIG: ControlConfig = {
  autonomy: "assist",
  defaultRuntime: null,
  defaultModel: null,
  models: {},
  sandbox: "local-directory",
  maxCostUsd: null,
  retryBudget: 2,
  approvalPolicy: "safe",
  browserMode: "not-configured",
  securityPolicy: "fail-closed",
  researchMode: "not-configured",
  humanGates: [
    "critical-architecture",
    "credentials",
    "destructive-actions",
    "production-deployment",
    "critical-migrations",
    "release",
  ],
  runnerCommand: null,
  runner: null,
  reviewer: null,
  attacker: null,
  attackRiskFloor: "high",
  browserOrigins: ["http://127.0.0.1", "http://localhost"],
};

export interface ReviewRecord {
  attempt: number;
  ticketRef: string;
  reviewer: string;
  model: string | null;
  runtime: string;
  status: "PASS" | "FAIL" | "BLOCKED" | "NOT_CONFIGURED";
  findings: Array<{
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
  }>;
  criteria: Array<{ requirementId: string; criterion: string; status: "PASS" | "FAIL" | "UNCLEAR" }>;
  architectureDrift: Array<{
    file?: string;
    declaredRule: string;
    observedCode: string;
    severity: "info" | "low" | "medium" | "high" | "critical";
  }>;
  summary: string;
  rawOutput?: string;
  unclear?: string[];
  durationMs: number | null;
  modelCost: number | null;
  falsePositiveFeedback: number;
  repairSuccess: number;
  promptVersion: string;
  promptHash: string;
  baseCommit: string;
  headCommit: string;
  worktree: string;
  changedFiles: string[];
  evidencePath: string;
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  diffFingerprint: string;
  duplicateDiff: boolean;
  priorDiffFingerprint?: string | null;
}

export interface RepairRecord {
  attempt: number;
  ticketRef: string;
  status: "STARTING" | "RUNNING" | "EDITING" | "COMPLETED" | "FAILED" | "TIMED_OUT" | "CANCELLED";
  findingIds: string[];
  source: "review" | "attack" | "security" | "tests";
  worktree: string;
  startedAt: string;
  endedAt: string;
  message: string;
  phases: Array<"STARTING" | "RUNNING" | "EDITING" | "VERIFYING" | "COMPLETED" | "FAILED" | "TIMED_OUT" | "CANCELLED">;
  retryBudget: number;
  attempts: number;
}

export interface AttackRecord {
  attempt: number;
  ticketRef: string;
  attacker: string;
  model: string | null;
  status: "PASS" | "FAIL" | "BLOCKED" | "NOT_CONFIGURED";
  findings: ReviewRecord["findings"];
  summary: string;
  evidencePath: string;
  worktree: string;
  diffFingerprint: string;
  promptVersion: string;
  durationMs: number | null;
  exitCode: number | null;
  startedAt: string;
  endedAt: string;
  rawOutput?: string;
}

export const LOOP_TRANSITIONS: Record<LoopState, LoopState[]> = {
  draft: ["ready", "blocked", "cancelled"],
  ready: ["running", "blocked", "cancelled"],
  running: ["verifying", "repairing", "blocked", "failed", "cancelled"],
  verifying: ["reviewing", "repairing", "blocked", "failed", "cancelled"],
  reviewing: ["attacking", "verified", "repairing", "blocked", "failed", "cancelled"],
  attacking: ["repairing", "verifying", "blocked", "failed", "cancelled"],
  repairing: ["verifying", "blocked", "failed", "cancelled"],
  blocked: ["ready", "running", "repairing", "failed", "cancelled"],
  verified: ["committed", "blocked", "cancelled"],
  committed: ["released", "blocked", "cancelled"],
  released: [],
  failed: ["ready", "cancelled"],
  cancelled: [],
};

export function emptyBrain(): ProjectBrain {
  return {
    architecture: [],
    decisions: [],
    constraints: [],
    successfulPatterns: [],
    failurePatterns: [],
    knownBugs: [],
    dependencies: [],
    teamConventions: [],
    securityRules: [],
    reviewStyle: [],
    deploymentRules: [],
    skillCandidates: [],
  };
}

export function emptyContext(): ProjectContext {
  return {
    architecture: [],
    technology: [],
    conventions: [],
    constraints: [],
    frozenAreas: [],
    securityRules: [],
    deploymentRules: [],
    sources: [],
  };
}
