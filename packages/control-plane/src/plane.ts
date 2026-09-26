import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  assignRisk,
  buildContextBundle,
  classifyComplexity,
  classifyMode,
  compileAcceptanceDraft,
  detectArchitectureDrift,
  detectDocumentationDrift,
  detectRequirementDrift,
  detectTestDrift,
  detectUxDrift,
  detectVerificationGap,
  escalationName,
  impactFromImports,
  materialQuestions,
  parallelBatches,
  projectHasCode,
  routeModelRole,
  scanRepository,
} from "./analysis";
import { BMAD_METHOD_PIN, PARTY_PRESETS, skillById } from "./catalog";
import { selectWorkflow } from "./catalog";
import {
  DEFAULT_AGENTS,
  LocalSandbox,
  closeParty,
  compareArena,
  listWorktrees,
  mutationScore,
  overlappingPaths,
  routeAgent,
} from "./collaboration";
import { runDoctor } from "./doctor";
import { authorizeAgent, decideCommand } from "./policy";
import { coverage, evaluateRelease, fileExists, missionEvidenceKinds, partitionEvidence, proofFor, releaseMatrix, requiredEvidenceKinds, assertPassEvidence, requirementVerified } from "./quality";
import { parseIntent, type Intent } from "./intent";
import { processRunner } from "./runner";
import { activeMissionId, appendEvent, ensureHome, listMissionIds, loadMission, readConfig, readEvents, saveMission, writeConfig } from "./store";
import { assertTomlHasNoStatus, renderTicketTree } from "./tickets";
import type {
  AgentContract,
  Approval,
  ArchitectureDecision,
  Artifact,
  Checkpoint,
  CommandRunner,
  Complexity,
  ControlConfig,
  DecisionRecord,
  DispatchRecord,
  DomainEvent,
  EpicRecord,
  EventType,
  EvidenceRecord,
  AttackRecord,
  EvidenceResult,
  Finding,
  ForgeOutcome,
  JourneyDeclaration,
  LoopState,
  NfrRequirement,
  MemoryEntry,
  Mission,
  PartyRoom,
  PhaseId,
  ProjectBrain,
  RepairRecord,
  Requirement,
  ReviewRecord,
  RiskLevel,
  SprintProjection,
  TicketEntry,
  TicketExecution,
  TicketPlan,
  TicketStatus,
  UsageRecord,
  Waiver,
} from "./types";
import { LOOP_TRANSITIONS, emptyBrain, emptyContext } from "./types";
import { redactSecrets } from "./model-runner";
import { BmadRunner, resolveRunnerConfig, resolveRuntimeId } from "./skill-runner";
import {
  CommandReviewer,
  REVIEW_PROMPT_VERSION,
  downgradeReview,
  repairBrief,
  resolveReviewerConfig,
  type ReviewContext,
  type Reviewer,
  type ReviewResult,
} from "./reviewer";
import {
  ATTACK_PROMPT_VERSION,
  CommandAttacker,
  downgradeAttack,
  resolveAttackerConfig,
  type AttackContext,
  type AttackResult,
  type AttackRunner,
} from "./attack";
import { PlaywrightBrowser, probePlaywright, seal, validateScenario, type BrowserProvider, type BrowserResult, type BrowserScenario } from "./browser";
import { RuntimeRegistry, type AgentRuntime } from "./runtime";
import { appendTrace, missionTimeline, openHandsSdkStatus, runChaos, runMutation, serviceStatuses, updateFileIndex } from "./platform";
import { installPlugin, listPlugins, removePlugin, setPluginEnabled, type PluginManifest, type PluginRecord } from "./plugins";
import { BmadLoopRunner } from "./loop-runner";
import { BmadResearchProvider, DockerSandboxProvider, LocalSandboxProvider, WorktreeManager, builderDraft, repositoryIntelligence, retrospectiveBrief, teaBrief, type BuilderKind, type ResearchClaim } from "./providers";
import { verifyArchitectureTree } from "./architecture-check";
import { CommandNfrProvider, nfrFromText, type NfrResult, type NfrScanner } from "./nfr";
import { CommandSecurityScanner, type SecurityResult, type SecurityScanner } from "./security";
import { traceMission } from "./traceability";

const SKILL_EVENTS: Partial<Record<string, EventType>> = {
  "bmad-spec": "SpecCreated",
  "bmad-product-brief": "BriefCreated",
  "bmad-prd": "PRDCreated",
  "bmad-architecture": "ArchitectureCreated",
  "bmad-preview-ticketing": "StoryCreated",
  "bmad-deep-recon": "ResearchStarted",
  "bmad-retrospective": "RetrospectiveStarted",
  "bmad-code-review": "ReviewStarted",
  "bmad-party-mode": "PartyStarted",
};

export interface PlaneOptions {
  runner?: CommandRunner;
  now?: () => Date;
  id?: () => string;
  reviewer?: Reviewer;
  attacker?: AttackRunner;
  browser?: BrowserProvider;
  security?: SecurityScanner;
  nfr?: NfrScanner;
}

export class BmadControlPlane {
  private readonly runner: CommandRunner;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly runtimes: RuntimeRegistry;
  private readonly worktreeManager: WorktreeManager;
  private readonly injectedReviewer: Reviewer | null;
  private readonly injectedAttacker: AttackRunner | null;
  private readonly injectedBrowser: BrowserProvider | null;
  private readonly injectedSecurity: SecurityScanner | null;
  private readonly injectedNfr: NfrScanner | null;
  private counter = 0;

  constructor(private readonly root: string, options: PlaneOptions = {}) {
    this.runner = options.runner ?? processRunner;
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? (() => `${++this.counter}_${crypto.randomBytes(4).toString("hex")}`);
    this.injectedReviewer = options.reviewer ?? null;
    this.injectedAttacker = options.attacker ?? null;
    this.injectedBrowser = options.browser ?? null;
    this.injectedSecurity = options.security ?? null;
    this.injectedNfr = options.nfr ?? null;
    this.runtimes = new RuntimeRegistry(this.runner);
    this.worktreeManager = new WorktreeManager(this.runner);
    ensureHome(root);
  }

  createMission(input: string): Mission {
    const text = input.trim();
    if (!text) throw new Error("A mission needs an idea.");
    const project = projectHasCode(this.root);
    const complexity = classifyComplexity(text, { fileCount: project.fileCount });
    const mode = classifyMode(text, project);
    const workflow = selectWorkflow(complexity, mode);
    const stamp = this.now().toISOString();
    const mission: Mission = {
      id: `msn_${this.id()}`,
      title: text.slice(0, 120),
      input: text,
      createdAt: stamp,
      updatedAt: stamp,
      complexity,
      mode,
      scanLevel: mode === "quick" ? "quick" : mode === "brownfield" ? "deep" : "quick",
      autonomy: readConfig(this.root).autonomy,
      phase: "discover",
      loop: "draft",
      workflow,
      requirements: [],
      epics: [],
      tickets: [],
      plans: [],
      ticketTreeAccepted: false,
      artifacts: [],
      evidence: [],
      findings: [],
      rooms: [],
      decisions: [],
      architecture: [],
      journeys: [],
      agents: DEFAULT_AGENTS.map((item) => ({
        ...item,
        capabilities: [...item.capabilities],
        skills: [...item.skills],
        permissions: {
          read: [...item.permissions.read],
          write: [...item.permissions.write],
          execute: [...item.permissions.execute],
          blocked: [...item.permissions.blocked],
        },
      })),
      usage: [],
      brain: emptyBrain(),
      approvals: [],
      checkpoints: [],
      lastVerifiedBuild: null,
      escalationLevel: 1,
      attempts: {},
      dispatches: [],
      executions: [],
      reviews: [],
      repairs: [],
      attacks: [],
      nfrRequirements: [],
      securityRuns: [],
      nfrRuns: [],
      attackRiskFloor: readConfig(this.root).attackRiskFloor ?? "high",
      waivers: [],
      projectContext: emptyContext(),
    };
    if (workflow.some((step) => step.skillId === "bmad-forge-idea")) {
      mission.forge = this.openForge(mission, text);
      this.setStep(mission, "bmad-forge-idea", "awaiting-user", "One material question at a time. State persists in the control plane.");
    }
    this.touch(mission);
    this.emit(mission, "MissionCreated", { input: text, complexity, mode, pin: BMAD_METHOD_PIN.commit });
    this.emit(mission, "WorkflowSelected", { skills: workflow.map((step) => step.skillId) });
    saveMission(this.root, mission);
    return mission;
  }

  mission(id?: string): Mission {
    const missionId = id ?? activeMissionId(this.root);
    if (!missionId) throw new Error("No active mission.");
    return loadMission(this.root, missionId);
  }

  listMissions(): string[] {
    return listMissionIds(this.root);
  }

  answerForge(missionId: string, text: string): Mission {
    const mission = this.must(missionId);
    if (!mission.forge || mission.forge.outcome !== "active") throw new Error("No active forge session.");
    const command = text.trim();
    if (/^harden$/i.test(command)) return this.closeForge(mission, "hardened");
    if (/^kill\b/i.test(command)) return this.closeForge(mission, "killed", command.replace(/^kill\b:?\s*/i, ""));
    if (/^clarify$/i.test(command)) return this.closeForge(mission, "clarified");
    if (/^attack$/i.test(command) || /^defend$/i.test(command)) {
      mission.forge.mode = /^attack$/i.test(command) ? "attack" : "defend";
      this.emit(mission, "ForgeAnswered", { mode: mission.forge.mode });
      this.touch(mission);
      saveMission(this.root, mission);
      return mission;
    }
    const question = mission.forge.questions.find((item) => !mission.forge?.answered.includes(item.id));
    if (!question) throw new Error("No forge question is open. Say harden, kill, or clarify.");
    mission.forge.answered.push(question.id);
    mission.forge.locks.push({
      kind: /^unknown\b/i.test(command) ? "assumption" : "lock",
      key: question.id,
      text: command,
      at: this.now().toISOString(),
    });
    this.emit(mission, "ForgeAnswered", { key: question.id });
    this.touch(mission);
    saveMission(this.root, mission);
    return mission;
  }

  proposeTickets(missionId: string): Mission {
    const mission = this.must(missionId);
    if (mission.requirements.length === 0) throw new Error("Forge locks have not produced requirements.");
    const epic: EpicRecord = {
      id: 1,
      slug: slug(mission.title),
      title: mission.title,
      covers: mission.requirements.map((requirement) => requirement.id),
      after: [],
    };
    mission.epics = [epic];
    mission.tickets = mission.requirements.map((requirement, index) => this.ticketFrom(requirement, index + 1));
    mission.ticketTreeAccepted = false;
    this.emit(mission, "TicketCreated", { tickets: mission.tickets.map((ticket) => ticket.ref) });
    this.touch(mission);
    saveMission(this.root, mission);
    return mission;
  }

  acceptTicketTree(missionId: string, identity: string): Mission {
    const mission = this.must(missionId);
    if (!identity.trim()) throw new Error("Accepting a ticket tree needs a person.");
    if (mission.tickets.length === 0) this.proposeTickets(missionId);
    const current = this.must(missionId);
    const rendered = renderTicketTree(current.epics, current.tickets);
    assertTomlHasNoStatus(rendered.initiative);
    for (const file of Object.values(rendered.epics)) assertTomlHasNoStatus(file);
    const base = path.join(this.root, "_bmad-output", current.id);
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, "tickets.toml"), rendered.initiative);
    for (const [file, body] of Object.entries(rendered.epics)) {
      const target = path.join(base, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    }
    current.ticketTreeAccepted = true;
    this.addArtifact(current, {
      kind: "ticket-tree",
      skillId: "bmad-preview-ticketing",
      creator: identity,
      producer: "user-accepted-proposal",
      body: rendered.initiative,
      relativePath: path.join("_bmad-output", current.id, "tickets.toml"),
    });
    this.emit(current, "StoryCreated", { tickets: current.tickets.map((ticket) => ticket.ref), by: identity });
    this.touch(current);
    saveMission(this.root, current);
    return current;
  }

  runSkill(missionId: string, skillId: string): Mission {
    const mission = this.must(missionId);
    const skills = new BmadRunner(this.runner, this.root);
    const contract = skills.loadSkillContract(skillId);
    const config = readConfig(this.root);
    const runnerConfig = resolveRunnerConfig(config);
    this.emit(mission, "SkillResolved", { skillId, commit: contract.commit });
    if (!runnerConfig) {
      this.setStep(mission, skillId, "not-configured", `Skill ${contract.id} is resolved. No model runner is configured, so it is not complete.`);
      this.touch(mission);
      saveMission(this.root, mission);
      return mission;
    }
    const result = skills.execute(skillId, mission.input, runnerConfig, mission.id);
    if (result.status === "not-configured") {
      this.setStep(mission, skillId, "not-configured", result.stderr || `Skill ${contract.id} did not start.`);
      this.touch(mission);
      saveMission(this.root, mission);
      return mission;
    }
    this.emit(mission, "SkillStarted", { skillId, commit: contract.commit, command: runnerConfig.command });
    this.emit(mission, "ArtifactStarted", { skillId });
    const relative = path.join(".bmad-next", "missions", mission.id, "artifacts", `${skillId}.md`);
    const state = result.status === "completed" ? "complete" : result.status === "invalid-output" || result.status === "output-invalid" ? "invalid" : "failed";
    this.addArtifact(mission, {
      kind: skillId,
      skillId,
      creator: "model-runner",
      producer: runnerConfig.command,
      body: result.stdout,
      relativePath: result.artifactPath ?? relative,
      state,
      provenance: {
        skill: skillId,
        commit: contract.commit,
        runner: runnerConfig.command,
        missionId: mission.id,
        ticketRef: null,
        timestamp: this.now().toISOString(),
        inputPath: path.join(".bmad-next", "missions", mission.id, "context", `${skillId}.md`),
        outputPath: result.artifactPath ?? relative,
        status: result.status,
      },
    });
    if (result.status === "completed") {
      this.setStep(mission, skillId, "completed", "Headless contract matched and named files exist.");
      const event = SKILL_EVENTS[skillId];
      if (event) this.emit(mission, event, { skillId, artifact: result.artifactPath ?? relative });
      this.emit(mission, "ArtifactCompleted", { skillId });
      this.emit(mission, "SkillCompleted", { skillId, commit: contract.commit, exitCode: result.exitCode, artifact: result.artifactPath ?? relative });
    } else {
      this.setStep(mission, skillId, "blocked", result.stderr || result.status);
      this.emit(mission, "SkillFailed", { skillId, commit: contract.commit, status: result.status, exitCode: result.exitCode });
    }
    this.recordUsage(mission, {
      model: config.defaultModel,
      input_tokens: null,
      output_tokens: null,
      tool_calls: 1,
      latency_ms: result.durationMs ?? null,
      retries: 0,
      cost: null,
      at: this.now().toISOString(),
    });
    this.touch(mission);
    saveMission(this.root, mission);
    return mission;
  }

  dispatch(missionId: string, ticketRef: string): DispatchRecord {
    return this.executeTicket(missionId, ticketRef);
  }

  executeTicket(missionId: string, ticketRef: string): DispatchRecord {
    const mission = this.must(missionId);
    const ticket = mission.tickets.find((item) => item.ref === ticketRef);
    if (!ticket) throw new Error(`Ticket ${ticketRef} is not in the mission.`);
    const config = readConfig(this.root);
    const routed = routeAgent(mission.agents, `${ticket.title} ${ticket.description}`, ticket.risk);
    const agent = routed.agent?.name ?? "Developer";
    const runtime = resolveRuntimeId(config);
    const attempts = (mission.attempts[ticketRef] ?? 0) + 1;
    mission.attempts[ticketRef] = attempts;
    if (attempts > config.retryBudget) {
      this.noteExecution(mission, ticketRef, { skillId: "bmad-build", agent, runtime: runtime ?? "none", worktree: null, status: "blocked", attempts, artifact: null, verification: "not-run" });
      const record = this.finishDispatch(mission, ticketRef, agent, runtime ?? "none", "blocked", "Retry budget is spent. Escalating instead of repeating the same run.");
      this.emit(mission, "TicketBlocked", { ticketRef, reason: "retry-budget" });
      this.escalate(missionId, "repeated-failure");
      return record;
    }
    const waiting = this.dependencyBlock(mission, ticket);
    if (waiting) {
      this.noteExecution(mission, ticketRef, { skillId: "bmad-build", agent, runtime: runtime ?? "none", worktree: null, status: "blocked", attempts, artifact: null, verification: "not-run" });
      this.emit(mission, "TicketBlocked", { ticketRef, reason: waiting });
      return this.finishDispatch(mission, ticketRef, agent, runtime ?? "none", "blocked", waiting);
    }
    if (!runtime) {
      this.noteExecution(mission, ticketRef, { skillId: "bmad-build", agent, runtime: "none", worktree: null, status: "not-configured", attempts, artifact: null, verification: "not-run" });
      mission.findings.push(this.finding("RUNTIME_NOT_CONFIGURED", "high", `No coding runtime is configured for ${ticketRef}.`, ticketRef));
      this.transition(mission, "blocked");
      this.emit(mission, "FindingCreated", { code: "RUNTIME_NOT_CONFIGURED", ticketRef });
      return this.finishDispatch(mission, ticketRef, agent, "none", "not-configured", "No coding runtime is configured, so the ticket stays planned.");
    }
    const selected = this.runtimes.resolve(runtime);
    if (selected.availability() === "NOT CONFIGURED") {
      this.noteExecution(mission, ticketRef, { skillId: "bmad-build", agent, runtime, worktree: null, status: "not-configured", attempts, artifact: null, verification: "not-run" });
      mission.findings.push(this.finding("RUNTIME_NOT_CONFIGURED", "high", `${runtime} is not configured for ${ticketRef}.`, ticketRef));
      this.transition(mission, "blocked");
      this.emit(mission, "FindingCreated", { code: "RUNTIME_NOT_CONFIGURED", ticketRef });
      return this.finishDispatch(mission, ticketRef, agent, runtime, "not-configured", `${runtime} is not configured, so no agent was started.`);
    }
    const contract = mission.agents.find((item) => item.name === agent);
    if (contract) {
      for (const file of ticket.paths) {
        const decision = authorizeAgent(contract, { type: "write", path: file });
        if (!decision.allowed) return this.finishDispatch(mission, ticketRef, agent, runtime, "blocked", decision.reason);
      }
    }
    this.emit(mission, "SkillResolved", { skillId: "bmad-build", ticketRef });
    let worktreePath: string;
    try {
      worktreePath = this.worktreeManager.create(this.root, mission.id, ticketRef, agent).path;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.noteExecution(mission, ticketRef, { skillId: "bmad-build", agent, runtime, worktree: null, status: "blocked", attempts, artifact: null, verification: "not-run" });
      this.emit(mission, "TicketBlocked", { ticketRef, reason: message });
      return this.finishDispatch(mission, ticketRef, agent, runtime, "blocked", message);
    }
    this.emit(mission, "WorktreeCreated", { ticketRef, worktree: worktreePath, agent });
    this.emit(mission, "TicketStarted", { ticketRef, agent, runtime, worktree: worktreePath });
    this.noteExecution(mission, ticketRef, { skillId: "bmad-build", agent, runtime, worktree: worktreePath, status: "running", attempts, artifact: null, verification: "not-run" });
    saveMission(this.root, mission);
    const before = this.runner.run("git", ["rev-parse", "HEAD"], worktreePath, 10000);
    let run: ReturnType<typeof selected.begin>;
    try {
      run = selected.begin({
        missionId: mission.id,
        ticketRef,
        agent,
        cwd: worktreePath,
        prompt: [ticket.title, ticket.description, ticket.verify].filter((part) => part.trim().length > 0).join("\n\n"),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.noteExecution(mission, ticketRef, { skillId: "bmad-build", agent, runtime, worktree: worktreePath, status: "failed", attempts, artifact: null, verification: "not-run" });
      this.worktreeManager.release(this.root, mission.id, ticketRef);
      if (mission.loop === "draft") this.transition(mission, "ready");
      if (mission.loop === "ready") this.transition(mission, "blocked");
      if (mission.loop === "running") this.transition(mission, "failed");
      this.emit(mission, "TicketBlocked", { ticketRef, reason: message });
      return this.finishDispatch(mission, ticketRef, agent, runtime, "failed", message);
    }
    if (run.status === "timeout" || run.status === "cancelled") {
      this.noteExecution(mission, ticketRef, {
        skillId: "bmad-build",
        agent,
        runtime,
        worktree: worktreePath,
        status: "timeout",
        attempts,
        artifact: run.artifact ?? null,
        verification: "not-run",
        changedFiles: run.changedFiles ?? this.listChanged(worktreePath),
        phase: run.status === "cancelled" ? "CANCELLED" : "TIMED_OUT",
        phases: run.phases ?? ["STARTING", "RUNNING", "TIMED_OUT"],
      });
      this.worktreeManager.release(this.root, mission.id, ticketRef);
      this.emit(mission, "AgentFailed", { agent, runtime, ticketRef, exitCode: run.exitCode, phase: run.phase ?? "TIMED_OUT" });
      this.emit(mission, "TicketBlocked", { ticketRef, reason: run.message });
      if (mission.loop === "draft") this.transition(mission, "ready");
      if (mission.loop === "ready") this.transition(mission, "blocked");
      if (mission.loop === "running") this.transition(mission, "failed");
      return this.finishDispatch(mission, ticketRef, agent, runtime, "failed", run.message);
    }
    if (run.status === "not-configured" || (run.exitCode === null && run.status !== "completed" && run.status !== "failed")) {
      this.noteExecution(mission, ticketRef, { skillId: "bmad-build", agent, runtime, worktree: worktreePath, status: "not-configured", attempts, artifact: null, verification: "not-run" });
      this.worktreeManager.release(this.root, mission.id, ticketRef);
      this.transition(mission, "blocked");
      return this.finishDispatch(mission, ticketRef, agent, runtime, "not-configured", run.message);
    }
    this.transition(mission, mission.loop === "draft" ? "ready" : mission.loop);
    if (mission.loop === "ready" || mission.loop === "blocked") this.transition(mission, "running");
    this.emit(mission, "AgentStarted", { agent, runtime, ticketRef, runId: run.id, worktree: worktreePath });
    this.emit(mission, "StoryStarted", { ticketRef });
    this.emit(mission, "ToolStarted", { runtime, ticketRef });
    if (run.status === "failed") {
      this.emit(mission, "AgentFailed", { agent, runtime, ticketRef, exitCode: run.exitCode });
      this.emit(mission, "TicketBlocked", { ticketRef, reason: run.message });
      this.transition(mission, "failed");
      this.noteExecution(mission, ticketRef, { skillId: "bmad-build", agent, runtime, worktree: worktreePath, status: "failed", attempts, artifact: run.artifact ?? null, verification: "not-run", changedFiles: this.listChanged(worktreePath) });
      this.worktreeManager.release(this.root, mission.id, ticketRef);
      return this.finishDispatch(mission, ticketRef, agent, runtime, "failed", run.message);
    }
    this.emit(mission, "AgentCompleted", { agent, runtime, ticketRef, exitCode: run.exitCode, durationMs: run.durationMs ?? null });
    this.emit(mission, "ToolCompleted", { runtime, ticketRef });
    const after = this.runner.run("git", ["rev-parse", "HEAD"], worktreePath, 10000);
    const commit = after.exitCode === 0 && after.stdout.trim() !== before.stdout.trim() ? after.stdout.trim() : null;
    const changedFiles = this.listChanged(worktreePath);
    const protocolFile = this.protocolFile(worktreePath, changedFiles, run.artifact);
    const runtimeFinished = run.status === "completed" && (run.exitCode === 0 || run.completionSignal === "terminal-event");
    const built = runtimeFinished && changedFiles.length > 0 && protocolFile !== null;
    let verification: TicketExecution["verification"] = "not-run";
    if (built) {
      this.markPlan(mission, ticket, "built", null);
      this.emit(mission, "TicketBuilt", { ticketRef, artifact: protocolFile, commit });
      if (protocolFile) {
        this.addArtifact(mission, {
          kind: "implementation",
          skillId: "bmad-build",
          creator: agent,
          producer: runtime,
          body: fs.readFileSync(protocolFile, "utf8"),
          relativePath: path.relative(this.root, protocolFile),
          state: "complete",
          provenance: {
            skill: "bmad-build",
            commit: BMAD_METHOD_PIN.commit,
            runner: runtime,
            missionId: mission.id,
            ticketRef,
            timestamp: this.now().toISOString(),
            inputPath: worktreePath,
            outputPath: protocolFile,
            status: "completed",
          },
        });
      }
      verification = this.verifyBuiltTicket(mission, ticket, worktreePath);
    }
    const reviewBlockedTicket = (mission.reviews ?? []).filter((item) => item.ticketRef === ticketRef).at(-1)?.status === "FAIL";
    const latestAttackStatus = (mission.attacks ?? []).filter((item) => item.ticketRef === ticketRef).at(-1)?.status;
    const attackBlockedTicket = latestAttackStatus === "FAIL" || latestAttackStatus === "BLOCKED";
    const qualityBlocked = reviewBlockedTicket || attackBlockedTicket;
    this.noteExecution(mission, ticketRef, {
      skillId: "bmad-build",
      agent,
      runtime,
      runner: runtime,
      runnerCommand: runtime === "openhands" ? "openhands --headless --json -t" : runtime,
      worktree: worktreePath,
      status: qualityBlocked ? "blocked" : "completed",
      attempts,
      artifact: protocolFile,
      verification,
      changedFiles,
      phase: qualityBlocked ? "FAILED" : built ? "COMPLETED" : run.phase,
      phases: run.phases,
      evidence: mission.evidence.filter((record) => record.story_id === ticketRef).map((record) => record.evidence_id),
    });
    this.worktreeManager.release(this.root, mission.id, ticketRef);
    this.emit(mission, "WorktreeReleased", { ticketRef });
    const record = this.finishDispatch(
      mission,
      ticketRef,
      agent,
      runtime,
      qualityBlocked ? "blocked" : "completed",
      reviewBlockedTicket
        ? "Review failed. The ticket stays blocked until a repair and a fresh review pass."
        : attackBlockedTicket
          ? "Attack failed. The ticket stays blocked until a repair, a fresh review, and a fresh attack."
          : built
            ? "Ticket protocol is built."
            : run.message,
      worktreePath,
    );
    return record;
  }

  resumeTicket(missionId: string, ticketRef: string): Mission {
    const mission = this.must(missionId);
    const execution = (mission.executions ?? []).find((item) => item.ticketRef === ticketRef);
    if (!execution) throw new Error(`Ticket ${ticketRef} has no execution to resume.`);
    if (execution.status === "running") {
      execution.status = "blocked";
      execution.verification = "not-run";
      execution.updatedAt = this.now().toISOString();
      if (mission.loop === "running" || mission.loop === "ready") this.transition(mission, "blocked");
      this.emit(mission, "TicketBlocked", { ticketRef, reason: "Execution was still running when the process restarted." });
      this.worktreeManager.release(this.root, mission.id, ticketRef);
      saveMission(this.root, mission);
    }
    return mission;
  }

  stories(missionId: string): Mission {
    const mission = this.must(missionId);
    if (mission.tickets.length > 0) return mission;
    if (mission.requirements.length === 0) return this.runSkill(missionId, "bmad-preview-ticketing");
    return this.proposeTickets(missionId);
  }

  recordEvidence(
    missionId: string,
    input: Omit<EvidenceRecord, "evidence_id" | "mission_id" | "timestamp" | "type" | "source"> & { timestamp?: string; type?: string; source?: string },
  ): EvidenceRecord {
    const mission = this.must(missionId);
    const record: EvidenceRecord = {
      ...input,
      evidence_id: `ev_${this.id()}`,
      mission_id: mission.id,
      requirement_version: input.requirement_version ?? (input.requirement_id ? mission.requirements.find((item) => item.id === input.requirement_id)?.version : undefined),
      timestamp: input.timestamp ?? this.now().toISOString(),
      type: input.type ?? input.kind,
      source: input.source ?? input.runner,
    };
    assertPassEvidence(record, fileExists(record.artifact));
    mission.evidence.push(record);
    this.emit(mission, "EvidenceCreated", { evidence_id: record.evidence_id, kind: record.kind, result: record.result });
    if (record.result === "pass" && record.kind === "unit") this.emit(mission, "TestPassed", { evidence_id: record.evidence_id });
    if (record.result === "fail") this.emit(mission, "TestFailed", { evidence_id: record.evidence_id, kind: record.kind });
    this.touch(mission);
    saveMission(this.root, mission);
    return record;
  }

  runCommandGate(missionId: string, kind: string, command: string, args: string[]): EvidenceRecord {
    const mission = this.must(missionId);
    if (kind === "security") {
      this.runSecurity(missionId);
      const record = [...this.must(missionId).evidence].reverse().find((item) => item.kind === "security");
      if (!record) throw new Error("Security scan did not record evidence.");
      return record;
    }
    const decision = decideCommand([command, ...args].join(" "), mission.autonomy);
    const started = this.now().toISOString();
    if (decision.decision !== "allow") {
      return this.recordEvidence(missionId, {
        result: decision.decision === "block" ? "blocked" : "not-configured",
        kind,
        runner: "command-policy",
        started_at: started,
        finished_at: this.now().toISOString(),
        exit_code: null,
        command: `${command} ${args.join(" ")}`.trim(),
        agent: "policy",
      });
    }
    if (kind === "browser") this.emit(mission, "BrowserStarted", { command });
    if (kind === "attack") this.emit(mission, "AttackStarted", { command });
    if (kind === "unit") this.emit(mission, "TestStarted", { command });
    const result = this.runner.run(command, args, this.root, 120000);
    const finished = this.now().toISOString();
    const logPath = path.join(this.root, ".bmad-next", "missions", mission.id, "artifacts", `${kind}-${this.id()}.log`);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, `${result.stdout}\n${result.stderr}`);
    const evidenceResult: EvidenceResult = result.exitCode === 0 ? "pass" : "fail";
    return this.recordEvidence(missionId, {
      result: evidenceResult,
      kind,
      runner: "process",
      started_at: started,
      finished_at: finished,
      exit_code: result.exitCode,
      command: `${command} ${args.join(" ")}`.trim(),
      artifact: logPath,
    });
  }

  releaseGate(missionId: string): ReturnType<typeof evaluateRelease> {
    const mission = this.must(missionId);
    for (const requirement of mission.requirements) {
      if (requirementVerified(requirement, mission, fileExists)) requirement.status = "verified";
    }
    const report = evaluateRelease(mission, fileExists);
    this.emit(mission, "GateEvaluated", { gate: "release", state: report.state });
    this.emit(mission, "ReleaseGateEvaluated", { state: report.state });
    const releasePath = path.join(this.root, ".bmad-next", "evidence", mission.id, "release.json");
    if ((report.state === "pass" || report.state === "waived") && !fs.existsSync(releasePath)) {
      const rev = this.runner.run("git", ["rev-parse", "HEAD"], this.root, 10000);
      const commit = rev.exitCode === 0 ? rev.stdout.trim() : null;
      const approval = [...mission.approvals].reverse().find((item) => item.category === "release");
      const current = releaseMatrix(mission, fileExists, commit).current;
      const superseded = partitionEvidence(mission.evidence).superseded;
      const body = {
        mission: mission.id,
        commit,
        releaseMatrix: current,
        effectiveEvidence: releaseMatrix(mission, fileExists, commit).current,
        historicalEvidence: mission.evidence.map((record) => ({
          evidence_id: record.evidence_id,
          kind: record.kind,
          result: record.result,
          timestamp: record.timestamp,
          artifact: record.artifact ?? null,
          superseded: superseded.some((item) => item.evidence_id === record.evidence_id),
        })),
        approval: approval
          ? { id: approval.id, missionId: mission.id, approver: approval.identity, decision: approval.decision === "approved" ? "APPROVED" : "REJECTED", reason: approval.reason, timestamp: approval.at }
          : null,
        decision: report.state,
        timestamp: this.now().toISOString(),
      };
      fs.mkdirSync(path.dirname(releasePath), { recursive: true });
      fs.writeFileSync(releasePath, JSON.stringify(body, null, 2));
      const checkpoint = this.writeCheckpoint(mission, "Release Candidate", true);
      mission.lastVerifiedBuild = { checkpointId: checkpoint.id, at: checkpoint.at, commit, missionId: mission.id, releaseEvidence: releasePath };
      this.emit(mission, "ReleaseCreated", { state: report.state, checkpointId: checkpoint.id, releaseEvidence: releasePath });
      if (mission.loop === "committed") this.transition(mission, "released");
    }
    this.touch(mission);
    saveMission(this.root, mission);
    return report;
  }

  verifyRelease(missionId: string): { stored: Record<string, unknown> | null; current: ReturnType<typeof evaluateRelease>; matches: boolean } {
    const mission = this.must(missionId);
    const current = evaluateRelease(mission, fileExists);
    const releasePath = path.join(this.root, ".bmad-next", "evidence", mission.id, "release.json");
    if (!fs.existsSync(releasePath)) return { stored: null, current, matches: false };
    const stored = JSON.parse(fs.readFileSync(releasePath, "utf8")) as Record<string, unknown>;
    return { stored, current, matches: stored.decision === current.state && stored.mission === mission.id };
  }

  approve(missionId: string, category: string, identity: string, reason: string): Approval {
    if (!identity.trim()) throw new Error("Approval needs a person.");
    const mission = this.must(missionId);
    const approval: Approval = { id: `apr_${this.id()}`, category, decision: "approved", identity, reason, at: this.now().toISOString() };
    mission.approvals.push(approval);
    this.emit(mission, "HumanCheckpoint", { category, identity, decision: "approved" });
    if (category === "release") this.emit(mission, "ReleaseApproved", { identity });
    this.touch(mission);
    saveMission(this.root, mission);
    return approval;
  }

  rejectRelease(missionId: string, identity: string, reason: string): Approval {
    if (!identity.trim()) throw new Error("Approval needs a person.");
    const mission = this.must(missionId);
    const approval: Approval = { id: `apr_${this.id()}`, category: "release", decision: "rejected", identity, reason, at: this.now().toISOString() };
    mission.approvals.push(approval);
    this.emit(mission, "HumanCheckpoint", { category: "release", identity, decision: "rejected" });
    this.emit(mission, "ReleaseRejected", { identity });
    this.touch(mission);
    saveMission(this.root, mission);
    return approval;
  }

  waive(missionId: string, criterion: string, identity: string, reason: string): Waiver {
    if (!identity.trim() || !reason.trim()) throw new Error("A waiver needs a person and a reason.");
    const mission = this.must(missionId);
    const waiver: Waiver = { id: `wv_${this.id()}`, criterion, identity, reason, at: this.now().toISOString() };
    mission.waivers.push(waiver);
    this.touch(mission);
    saveMission(this.root, mission);
    return waiver;
  }

  correctCourse(missionId: string, requirementId: string, description: string, reason: string): Mission {
    const mission = this.must(missionId);
    const requirement = mission.requirements.find((item) => item.id === requirementId);
    if (!requirement) throw new Error(`Requirement ${requirementId} was not found.`);
    requirement.description = description;
    requirement.version += 1;
    requirement.status = "changed";
    requirement.acceptance_criteria = [];
    for (const ticket of mission.tickets.filter((item) => item.covers.includes(requirementId))) {
      const plan = mission.plans.find((item) => item.ref === ticket.ref);
      if (plan && plan.status !== "dropped") {
        plan.status = "blocked";
        plan.blocked_reason = reason;
        plan.version += 1;
      }
    }
    mission.findings.push(this.finding("REQUIREMENT_CHANGE", "medium", reason, undefined, requirementId));
    this.emit(mission, "CorrectCourse", { requirementId, version: requirement.version });
    this.touch(mission);
    saveMission(this.root, mission);
    return mission;
  }

  openParty(missionId: string, name: string, preset: string, mode: PartyRoom["mode"]): PartyRoom {
    const mission = this.must(missionId);
    const members = PARTY_PRESETS[preset];
    if (!members) throw new Error(`Unknown party preset ${preset}.`);
    const room: PartyRoom = {
      id: `room_${this.id()}`,
      name,
      preset,
      mode,
      members: [...members],
      turns: [],
      status: "open",
    };
    mission.rooms.push(room);
    this.emit(mission, "PartyStarted", { room: room.id, preset, mode });
    this.touch(mission);
    saveMission(this.root, mission);
    return room;
  }

  addPartyTurn(missionId: string, roomId: string, turn: { speaker: string; stance: PartyRoom["turns"][number]["stance"]; text: string; source: "user" | "model-run" }): Mission {
    const mission = this.must(missionId);
    const room = mission.rooms.find((item) => item.id === roomId);
    if (!room || room.status !== "open") throw new Error("Party room is not open.");
    if (!turn.text.trim()) throw new Error("A party turn needs text.");
    room.turns.push({ id: `turn_${this.id()}`, ...turn, at: this.now().toISOString() });
    this.emit(mission, "PartyTurn", { roomId, speaker: turn.speaker, source: turn.source });
    this.touch(mission);
    saveMission(this.root, mission);
    return mission;
  }

  recordDecision(missionId: string, roomId: string, decision: Omit<DecisionRecord, "id" | "roomId">): DecisionRecord {
    const mission = this.must(missionId);
    const room = mission.rooms.find((item) => item.id === roomId);
    if (!room) throw new Error("Party room was not found.");
    const gate = closeParty(room);
    if (!gate.ok) {
      mission.findings.push(this.finding("CONSENSUS_UNEXAMINED", "medium", gate.reason));
      this.emit(mission, "FindingCreated", { code: "CONSENSUS_UNEXAMINED" });
      saveMission(this.root, mission);
      throw new Error(gate.reason);
    }
    const record: DecisionRecord = { ...decision, id: `dec_${this.id()}`, roomId };
    mission.decisions.push(record);
    room.decisionId = record.id;
    room.status = "closed";
    if (decision.adrId) {
      mission.architecture.push({ id: decision.adrId, kind: "adr", choice: decision.decision, alternatives: decision.alternatives });
    }
    this.emit(mission, "DecisionRecorded", { id: record.id, adr: decision.adrId ?? null });
    this.touch(mission);
    saveMission(this.root, mission);
    return record;
  }

  declareArchitecture(missionId: string, decision: ArchitectureDecision): Mission {
    const mission = this.must(missionId);
    mission.architecture.push(decision);
    mission.projectContext.architecture.push(`${decision.kind}: ${decision.choice}`);
    mission.projectContext.sources.push("declared-by-user");
    this.touch(mission);
    saveMission(this.root, mission);
    return mission;
  }

  declareJourney(missionId: string, journey: JourneyDeclaration): Mission {
    const mission = this.must(missionId);
    mission.journeys.push(journey);
    saveMission(this.root, mission);
    return mission;
  }

  crossCheck(missionId: string, files: Array<{ path: string; text: string }>, uxMeasurements: Array<{ journeyId: string; steps: number }> = []): Finding[] {
    const mission = this.must(missionId);
    const findings: Finding[] = [];
    for (const requirement of mission.requirements) {
      findings.push(...detectRequirementDrift(requirement, files));
      const gap = detectVerificationGap(requirement, files.map((file) => file.text).join("\n"));
      if (gap) findings.push(gap);
    }
    findings.push(...detectArchitectureDrift(mission.architecture, files.map((file) => `${file.path}\n${file.text}`)));
    findings.push(...detectDocumentationDrift(mission.architecture, files));
    const tests = files.filter((file) => /\.(test|spec)\./.test(file.path) || file.path.includes("/test/"));
    for (const requirement of mission.requirements) findings.push(...detectTestDrift(requirement, tests));
    findings.push(...detectUxDrift(mission.journeys, uxMeasurements));
    const stamped = findings.map((finding) => ({
      ...finding,
      createdAt: finding.createdAt ?? this.now().toISOString(),
      status: finding.status ?? ("open" as const),
      description: finding.description ?? finding.message,
      source: finding.source ?? "cross-check",
    }));
    mission.findings.push(...stamped);
    for (const finding of stamped) this.emit(mission, "FindingCreated", { code: finding.code, message: finding.message });
    saveMission(this.root, mission);
    return stamped;
  }

  checkpoint(missionId: string, label: string): Checkpoint {
    const mission = this.must(missionId);
    const point = this.writeCheckpoint(mission, label, false);
    saveMission(this.root, mission);
    return point;
  }

  restoreCheckpoint(missionId: string, checkpointId: string): Mission {
    const file = path.join(this.root, ".bmad-next", "missions", missionId, "checkpoints", `${checkpointId}.json`);
    if (!fs.existsSync(file)) throw new Error("Checkpoint file is missing.");
    const restored = JSON.parse(fs.readFileSync(file, "utf8")) as Mission;
    this.emit(restored, "CheckpointCreated", { restored: checkpointId });
    saveMission(this.root, restored);
    return restored;
  }

  rollbackToVerified(missionId: string): Mission {
    const mission = this.must(missionId);
    if (!mission.lastVerifiedBuild) throw new Error("No last verified build is recorded.");
    return this.restoreCheckpoint(missionId, mission.lastVerifiedBuild.checkpointId);
  }

  remember(missionId: string, topic: keyof Omit<ProjectBrain, "skillCandidates">, text: string, sourceEventId: string): MemoryEntry {
    const mission = this.must(missionId);
    const events = readEvents(this.root, mission.id);
    if (!events.some((event) => event.id === sourceEventId)) throw new Error("Memory must cite an event that was recorded.");
    const entry: MemoryEntry = { id: `mem_${this.id()}`, topic, text, sourceEventId, at: this.now().toISOString(), verified: false, invalidated: false };
    mission.brain[topic].push(entry);
    this.emit(mission, "MemoryUpdated", { id: entry.id, topic });
    saveMission(this.root, mission);
    return entry;
  }

  proposeSkill(missionId: string, name: string, fromFailure: string, body: string): Mission {
    const mission = this.must(missionId);
    mission.brain.skillCandidates.push({
      id: `skill_${this.id()}`,
      name,
      fromFailure,
      body,
      evaluation: { status: "not-run", cases: 0, passed: 0 },
      published: false,
    });
    this.emit(mission, "SkillCreated", { name, published: false });
    this.emit(mission, "SkillCandidateCreated", { name, published: false });
    saveMission(this.root, mission);
    return mission;
  }

  recordEvaluation(missionId: string, skillId: string, cases: number, passed: number): Mission {
    const mission = this.must(missionId);
    const skill = mission.brain.skillCandidates.find((item) => item.id === skillId);
    if (!skill) throw new Error("Skill candidate was not found.");
    this.emit(mission, "EvalStarted", { skillId });
    skill.evaluation = { status: cases > 0 && passed === cases ? "passed" : "failed", cases, passed };
    skill.published = false;
    this.emit(mission, "EvalCompleted", { skillId, status: skill.evaluation.status });
    saveMission(this.root, mission);
    return mission;
  }

  publishSkill(missionId: string, skillId: string): Mission {
    const mission = this.must(missionId);
    const skill = mission.brain.skillCandidates.find((item) => item.id === skillId);
    if (!skill) throw new Error("Skill candidate was not found.");
    if (skill.evaluation.status !== "passed") throw new Error("A skill stays unpublished until its evaluation passes.");
    skill.published = true;
    this.emit(mission, "SkillPublished", { skillId, name: skill.name });
    saveMission(this.root, mission);
    return mission;
  }

  escalate(missionId: string, reason: string): Mission {
    const mission = this.must(missionId);
    mission.escalationLevel = Math.min(mission.escalationLevel + 1, 7);
    this.emit(mission, "Escalated", { level: mission.escalationLevel, name: escalationName(mission.escalationLevel), reason });
    if (mission.escalationLevel === 7) this.emit(mission, "HumanCheckpoint", { category: "escalation", reason });
    saveMission(this.root, mission);
    return mission;
  }

  recommend(missionId?: string): { skillId: string; reason: string; phase: PhaseId } {
    const mission = this.mission(missionId);
    const completed = mission.workflow.filter((step) => step.status === "completed").map((step) => step.skillId);
    const openQuestions = mission.forge?.questions.filter((question) => !mission.forge?.answered.includes(question.id)) ?? [];
    const blocking = mission.findings.filter((finding) => finding.status !== "resolved" && (finding.severity === "high" || finding.severity === "critical"));
    const step = mission.workflow.find((item) => item.status !== "completed" && item.status !== "skipped");
    const context = [
      `Loop is ${mission.loop}.`,
      completed.length > 0 ? `Complete: ${completed.join(", ")}.` : "No workflow step is complete.",
      openQuestions.length > 0 ? `Forge has ${openQuestions.length} open question(s).` : "",
      blocking.length > 0 ? `Blocking findings: ${blocking.map((finding) => finding.code).join(", ")}.` : "",
    ].filter(Boolean);
    if (!step) {
      return {
        skillId: "bmad-retrospective",
        phase: "learn",
        reason: `${context.join(" ")} Workflow steps are complete. Review evidence before calling the mission done.`,
      };
    }
    const skill = skillById(step.skillId);
    return {
      skillId: step.skillId,
      phase: step.phase,
      reason: `${context.join(" ")} ${step.reason ?? skill?.summary ?? "This is the next legal workflow step."}`,
    };
  }

  handleIntent(text: string, missionId?: string): { name: Intent["name"]; skillId?: string; target?: string; detail: unknown } {
    const intent = parseIntent(text);
    if (intent.name === "doctor") return { name: intent.name, detail: this.doctor() };
    const id = missionId ?? this.mission().id;
    if (intent.name === "next" || intent.name === "unknown") {
      return { name: intent.name, skillId: intent.skillId, target: intent.target, detail: this.recommend(id) };
    }
    if (intent.name === "approve-release" || intent.name === "reject-release") {
      const identity = intent.text.match(/\bby\s+(.+)$/i)?.[1]?.trim() ?? "";
      if (!identity) {
        return { name: intent.name, detail: { status: "needs-approver", message: "Say @bmad approve release by Name. Casual text is not approval." } };
      }
      const approval = intent.name === "approve-release" ? this.approve(id, "release", identity, "Chat release approval.") : this.rejectRelease(id, identity, "Chat release rejection.");
      return { name: intent.name, detail: approval };
    }
    if (intent.name === "release") return { name: intent.name, skillId: intent.skillId, target: intent.target, detail: this.releaseGate(id) };
    if (intent.name === "build") {
      const ref = ticketRefOf(intent.target);
      if (!ref) return { name: intent.name, skillId: intent.skillId, target: intent.target, detail: { status: "needs-ticket", message: "Name a ticket such as 2.3." } };
      const ticket = this.must(id).tickets.find((item) => item.ref === ref);
      if (!ticket) return { name: intent.name, skillId: intent.skillId, target: intent.target, detail: { status: "missing-ticket", message: `Ticket ${ref} is not in the mission.` } };
      return { name: intent.name, skillId: intent.skillId, target: ref, detail: this.executeTicket(id, ref) };
    }
    if (intent.name === "verify") {
      if (intent.target?.startsWith("REQ-")) return { name: intent.name, target: intent.target, detail: this.verifyRequirement(id, intent.target) };
      const ref = ticketRefOf(intent.target);
      if (ref) return { name: intent.name, target: ref, detail: this.verifyTicket(id, ref) };
      return { name: intent.name, target: intent.target, detail: this.verifyMission(id) };
    }
    if (intent.name === "repair") {
      const ref = ticketRefOf(intent.target);
      if (!ref) return { name: intent.name, skillId: intent.skillId, target: intent.target, detail: { status: "needs-ticket", message: "Name a ticket such as 1.1." } };
      return { name: intent.name, skillId: intent.skillId, target: ref, detail: this.repairTicket(id, ref) };
    }
    if (intent.name === "review") {
      const ref = ticketRefOf(intent.target);
      if (ref && this.must(id).tickets.some((ticket) => ticket.ref === ref)) {
        return { name: intent.name, skillId: intent.skillId, target: ref, detail: this.reviewTicket(id, ref) };
      }
      return { name: intent.name, skillId: intent.skillId, detail: this.reviewMission(id) };
    }
    if (intent.name === "security") return { name: intent.name, detail: this.runSecurity(id) };
    if (intent.name === "browser") return { name: intent.name, target: intent.target, detail: this.runBrowser(id, intent.target) };
    if (intent.name === "attack") {
      const ref = ticketRefOf(intent.target) ?? undefined;
      return { name: intent.name, target: ref, detail: this.attackTicket(id, ref) };
    }
    if (intent.name === "nfr") return { name: intent.name, detail: this.measureNfr(id) };
    if (intent.name === "retrospective") return { name: intent.name, skillId: intent.skillId, detail: this.retrospective(id) };
    if (intent.name === "tea") return { name: intent.name, detail: this.tea(id) };
    if (intent.name === "forge") {
      const mission = this.must(id);
      const open = mission.forge?.questions.filter((question) => !mission.forge?.answered.includes(question.id)) ?? [];
      return { name: intent.name, skillId: intent.skillId, detail: { outcome: mission.forge?.outcome ?? "absent", open } };
    }
    if (intent.name === "research") return { name: intent.name, skillId: intent.skillId, detail: this.research(id, []) };
    if (intent.skillId && !intent.skillId.startsWith("bmad-next:")) {
      return { name: intent.name, skillId: intent.skillId, target: intent.target, detail: this.runSkill(id, intent.skillId) };
    }
    return { name: intent.name, skillId: intent.skillId, target: intent.target, detail: this.recommend(id) };
  }

  startMission(missionId: string): Mission {
    return this.loops().start(missionId);
  }

  resumeMission(missionId: string): Mission {
    return this.loops().resume(missionId);
  }

  pauseMission(missionId: string): Mission {
    return this.loops().pause(missionId);
  }

  cancelMission(missionId: string): Mission {
    return this.loops().cancel(missionId);
  }

  verifyMission(missionId: string): Mission {
    return this.loops().verify(missionId);
  }

  reviewMission(missionId: string): Mission {
    return this.loops().review(missionId);
  }

  reviewTicket(missionId: string, ticketRef: string): ReviewRecord {
    const mission = this.must(missionId);
    const ticket = mission.tickets.find((item) => item.ref === ticketRef);
    if (!ticket) throw new Error(`Ticket ${ticketRef} is not in the mission.`);
    const execution = (mission.executions ?? []).find((item) => item.ticketRef === ticketRef);
    const worktree = execution?.worktree;
    if (!worktree || !fs.existsSync(worktree)) {
      const blocked = this.blockedReviewRecord(mission, ticket, worktree ?? "", "The ticket worktree is not on disk, so no review ran.");
      this.rememberReview(mission, blocked);
      saveMission(this.root, mission);
      return blocked;
    }
    const verification = this.verifyBuiltTicket(mission, ticket, worktree);
    if (execution) {
      execution.verification = verification;
      execution.evidence = mission.evidence.filter((record) => record.story_id === ticketRef).map((record) => record.evidence_id);
      execution.updatedAt = this.now().toISOString();
    }
    saveMission(this.root, mission);
    const latest = (mission.reviews ?? []).filter((item) => item.ticketRef === ticketRef).at(-1);
    if (!latest) throw new Error(`Ticket ${ticketRef} produced no review record.`);
    return latest;
  }

  repairTicket(missionId: string, ticketRef: string): DispatchRecord {
    const mission = this.must(missionId);
    const ticket = mission.tickets.find((item) => item.ref === ticketRef);
    if (!ticket) throw new Error(`Ticket ${ticketRef} is not in the mission.`);
    const failure = this.repairSource(mission, ticketRef);
    if (!failure) {
      return this.finishDispatch(mission, ticketRef, "Developer", "none", "blocked", "Repair runs only after a failing review, attack, or security scan.");
    }
    const config = readConfig(this.root);
    const runtime = resolveRuntimeId(config);
    const attempts = (mission.attempts[ticketRef] ?? 0) + 1;
    mission.attempts[ticketRef] = attempts;
    if (attempts > config.retryBudget) {
      this.emit(mission, "TicketBlocked", { ticketRef, reason: "retry-budget" });
      this.escalate(missionId, "repeated-failure");
      return this.finishDispatch(mission, ticketRef, "Developer", runtime ?? "none", "blocked", "Retry budget is spent. Escalating instead of repeating the same repair.");
    }
    if (!runtime) {
      return this.finishDispatch(mission, ticketRef, "Developer", "none", "not-configured", "No coding runtime is configured for the repair.");
    }
    const selected = this.runtimes.resolve(runtime);
    if (selected.availability() === "NOT CONFIGURED") {
      return this.finishDispatch(mission, ticketRef, "Developer", runtime, "not-configured", `${runtime} is not configured, so the repair did not start.`);
    }
    this.moveIfLegal(mission, "repairing");
    let worktreePath: string;
    try {
      worktreePath = this.worktreeManager.create(this.root, mission.id, ticketRef, "Developer").path;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.moveIfLegal(mission, "blocked");
      return this.finishDispatch(mission, ticketRef, "Developer", runtime, "blocked", message);
    }
    const changedFiles = this.listChanged(worktreePath);
    const prompt = repairBrief({
      ticketRef: ticket.ref,
      title: ticket.title,
      verify: ticket.verify,
      worktree: worktreePath,
      source: failure.source,
      evidencePath: failure.evidencePath,
      findings: failure.findings,
      requirements: this.reviewRequirements(mission, ticket),
      diff: this.captureDiff(worktreePath, changedFiles),
    });
    this.emit(mission, "RepairStarted", { ticketRef, attempt: attempts, findings: failure.findings.map((finding) => finding.id), worktree: worktreePath, source: failure.source });
    let run: ReturnType<typeof selected.begin>;
    try {
      run = selected.begin({
        missionId: mission.id,
        ticketRef,
        agent: "Developer",
        cwd: worktreePath,
        prompt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.rememberRepair(mission, this.repairRecord(ticketRef, attempts, "FAILED", failure, worktreePath, message, ["STARTING", "FAILED"], config.retryBudget));
      this.worktreeManager.release(this.root, mission.id, ticketRef);
      this.moveIfLegal(mission, "blocked");
      return this.finishDispatch(mission, ticketRef, "Developer", runtime, "failed", message);
    }
    const runtimeFinished = run.status === "completed" && (run.exitCode === 0 || run.completionSignal === "terminal-event");
    const repairStatus = run.status === "timeout" ? "TIMED_OUT" : run.status === "cancelled" ? "CANCELLED" : runtimeFinished ? "COMPLETED" : "FAILED";
    this.rememberRepair(mission, this.repairRecord(ticketRef, attempts, repairStatus, failure, worktreePath, run.message, run.phases ?? [repairStatus], config.retryBudget));
    if (!runtimeFinished) {
      this.noteExecution(mission, ticketRef, {
        skillId: "bmad-build",
        agent: "Developer",
        runtime,
        worktree: worktreePath,
        status: run.status === "timeout" ? "timeout" : "failed",
        attempts,
        artifact: run.artifact ?? null,
        verification: "not-run",
        changedFiles: run.changedFiles ?? this.listChanged(worktreePath),
        phase: repairStatus,
        phases: run.phases,
        retryBudget: config.retryBudget,
      });
      this.worktreeManager.release(this.root, mission.id, ticketRef);
      this.moveIfLegal(mission, "blocked");
      this.emit(mission, "TicketBlocked", { ticketRef, reason: run.message });
      return this.finishDispatch(mission, ticketRef, "Developer", runtime, "failed", run.message);
    }
    const verification = this.verifyBuiltTicket(mission, ticket, worktreePath);
    const fresh = (mission.reviews ?? []).filter((item) => item.ticketRef === ticketRef).at(-1);
    if (fresh && failure.source === "review" && fresh.status === "PASS") {
      fresh.repairSuccess += 1;
      this.writeReviewEvidence(fresh, fresh.evidencePath);
    }
    const freshAttack = (mission.attacks ?? []).filter((item) => item.ticketRef === ticketRef).at(-1);
    const reviewPassed = fresh?.status === "PASS";
    const attackFailed = freshAttack?.status === "FAIL";
    const attackPassed = freshAttack?.status === "PASS";
    let securityPassed = failure.source !== "security";
    if (failure.source === "security") {
      const again = this.runSecurity(mission.id, ticketRef);
      const saved = this.must(mission.id);
      mission.evidence = saved.evidence;
      mission.securityRuns = saved.securityRuns ?? [];
      securityPassed = again.status === "PASS";
    }
    const closed = reviewPassed && !attackFailed && (failure.source !== "attack" || attackPassed) && (failure.source !== "security" || (attackPassed && securityPassed));
    this.noteExecution(mission, ticketRef, {
      skillId: "bmad-build",
      agent: "Developer",
      runtime,
      worktree: worktreePath,
      status: closed ? "completed" : "blocked",
      attempts,
      artifact: run.artifact ?? null,
      verification,
      changedFiles: this.listChanged(worktreePath),
      phase: closed ? "COMPLETED" : "FAILED",
      phases: [...(run.phases ?? []), "VERIFYING", closed ? "COMPLETED" : "FAILED"],
      retryBudget: config.retryBudget,
      evidence: mission.evidence.filter((record) => record.story_id === ticketRef).map((record) => record.evidence_id),
    });
    this.worktreeManager.release(this.root, mission.id, ticketRef);
    const message = !reviewPassed
      ? "Repair did not pass a fresh review."
      : attackFailed || (failure.source === "security" && !attackPassed)
        ? "Repair did not pass a fresh attack."
        : failure.source === "security" && !securityPassed
          ? "Repair did not pass a fresh security scan."
          : failure.source === "security"
            ? "Repair passed a fresh review, attack, and security scan."
            : failure.source === "attack"
              ? "Repair passed a fresh review and a fresh attack."
              : "Repair passed a fresh review.";
    return this.finishDispatch(mission, ticketRef, "Developer", runtime, closed ? "completed" : "blocked", message, worktreePath);
  }

  noteReviewFalsePositive(missionId: string, ticketRef: string, findingId: string): ReviewRecord {
    const mission = this.must(missionId);
    const record = [...(mission.reviews ?? [])].reverse().find((item) => item.ticketRef === ticketRef && item.findings.some((finding) => finding.id === findingId));
    if (!record) throw new Error("That finding is not in a review.");
    record.falsePositiveFeedback += 1;
    saveMission(this.root, mission);
    return record;
  }

  commitMission(missionId: string): Mission {
    return this.loops().commit(missionId);
  }

  registerRuntime(runtime: AgentRuntime): void {
    this.runtimes.register(runtime);
  }

  runtimeIds(): string[] {
    return this.runtimes.ids();
  }

  agentAvailability(): Array<{ id: string; availability: ReturnType<AgentRuntime["availability"]> }> {
    return this.runtimes.ids().map((id) => ({ id, availability: this.runtimes.availability(id) }));
  }

  getRequirement(missionId: string, requirementId: string): Requirement {
    const requirement = this.must(missionId).requirements.find((item) => item.id === requirementId);
    if (!requirement) throw new Error(`Requirement ${requirementId} was not found.`);
    return requirement;
  }

  getRequirementCoverage(missionId: string, requirementId: string): ReturnType<typeof proofFor> {
    return proofFor(this.getRequirement(missionId, requirementId), this.must(missionId));
  }

  getRequirementEvidence(missionId: string, requirementId: string): EvidenceRecord[] {
    this.getRequirement(missionId, requirementId);
    return this.must(missionId).evidence.filter((record) => record.requirement_id === requirementId);
  }

  getRequirementDrift(missionId: string, requirementId: string): Finding[] {
    this.getRequirement(missionId, requirementId);
    return this.must(missionId).findings.filter((finding) => finding.requirementId === requirementId && finding.code.endsWith("DRIFT"));
  }

  searchMemory(missionId: string, query: string): MemoryEntry[] {
    const needle = query.trim().toLowerCase();
    return memoryEntries(this.must(missionId).brain).filter((entry) => !entry.invalidated && entry.text.toLowerCase().includes(needle));
  }

  updateMemory(missionId: string, memoryId: string, text: string): MemoryEntry {
    const mission = this.must(missionId);
    const entry = memoryEntries(mission.brain).find((item) => item.id === memoryId);
    if (!entry) throw new Error("Memory entry was not found.");
    if (!text.trim()) throw new Error("Memory text is empty.");
    entry.text = text;
    this.emit(mission, "MemoryUpdated", { id: entry.id, topic: entry.topic, action: "update" });
    saveMission(this.root, mission);
    return entry;
  }

  invalidateMemory(missionId: string, memoryId: string): MemoryEntry {
    const mission = this.must(missionId);
    const entry = memoryEntries(mission.brain).find((item) => item.id === memoryId);
    if (!entry) throw new Error("Memory entry was not found.");
    entry.invalidated = true;
    this.emit(mission, "MemoryUpdated", { id: entry.id, topic: entry.topic, action: "invalidate" });
    saveMission(this.root, mission);
    return entry;
  }

  declareNfr(missionId: string, requirement: NfrRequirement): NfrRequirement {
    if (!Number.isFinite(requirement.target)) throw new Error("An NFR target must be a finite number from the mission.");
    if (!["<", "<=", ">", ">=", "=="].includes(requirement.operator)) throw new Error("NFR operator is not supported.");
    if (!requirement.metric.trim() || !requirement.unit.trim() || !requirement.verificationMethod.trim()) {
      throw new Error("An NFR needs a metric, unit, and verification method.");
    }
    const mission = this.must(missionId);
    mission.nfrRequirements = [...(mission.nfrRequirements ?? []), requirement];
    this.touch(mission);
    saveMission(this.root, mission);
    return requirement;
  }

  runSecurity(missionId: string, ticketRef?: string): SecurityResult {
    const mission = this.must(missionId);
    const ref = ticketRef && mission.tickets.some((ticket) => ticket.ref === ticketRef) ? ticketRef : mission.tickets.at(-1)?.ref ?? "mission";
    const execution = (mission.executions ?? []).find((item) => item.ticketRef === ref);
    const worktree = execution?.worktree && fs.existsSync(execution.worktree) ? execution.worktree : this.root;
    const ticket = mission.tickets.find((item) => item.ref === ref);
    const provider = this.securityFor();
    const result = provider.scanBlocking({ missionId: mission.id, ticketRef: ref, worktree, root: this.root });
    const ran = result.tools.filter((tool) => tool.status !== "NOT_CONFIGURED");
    if (ran.length > 0) {
      this.emit(mission, "SecurityStarted", { ticketRef: ref, worktree });
      for (const tool of ran) {
        this.emit(mission, "SecurityToolStarted", { tool: tool.id, command: tool.command });
        this.emit(mission, "SecurityToolCompleted", { tool: tool.id, status: tool.status, findings: tool.findings.length });
      }
      this.emit(mission, result.status === "PASS" ? "SecurityCompleted" : "SecurityFailed", { status: result.status, findings: result.findings.length });
    }
    const attempt = (mission.securityRuns ?? []).filter((item) => item.ticketRef === ref).length + 1;
    const dir = path.join(this.root, ".bmad-next", "evidence", mission.id);
    fs.mkdirSync(dir, { recursive: true });
    const body = {
      mission: mission.id,
      ticket: ref,
      tools: result.tools.map((tool) => tool.id),
      versions: Object.fromEntries(result.tools.map((tool) => [tool.id, tool.version])),
      commands: result.tools.map((tool) => tool.command),
      results: result.tools.map((tool) => ({
        id: tool.id,
        status: tool.status,
        exitCode: tool.exitCode,
        durationMs: tool.durationMs,
        scanners: tool.scanners,
        stdout: tool.stdout,
        stderr: tool.stderr,
      })),
      findings: result.findings,
      worktree,
      timestamp: result.timestamp,
      status: result.status,
    };
    const attemptPath = path.join(dir, `${ref}-security-${attempt}.json`);
    fs.writeFileSync(attemptPath, JSON.stringify(body, null, 2));
    fs.writeFileSync(path.join(dir, `${ref}-security.json`), JSON.stringify(body, null, 2));
    const evidenceResult: EvidenceResult = result.status === "PASS" ? "pass" : result.status === "FAIL" ? "fail" : result.status === "NOT_CONFIGURED" ? "not-configured" : "blocked";
    this.recordEvidence(mission.id, {
      requirement_id: ticket?.covers[0],
      story_id: ref === "mission" ? undefined : ref,
      result: evidenceResult,
      kind: "security",
      runner: provider.id,
      started_at: result.timestamp,
      finished_at: result.timestamp,
      exit_code: result.status === "PASS" ? 0 : result.status === "FAIL" ? 1 : null,
      command: result.tools.map((tool) => tool.command).join(" && "),
      artifact: attemptPath,
    });
    const saved = this.must(mission.id);
    const run = {
      id: `sec_${this.id()}`,
      ticketRef: ref,
      status: result.status === "RUNNING" ? "ERROR" : result.status,
      findings: result.findings,
      tools: result.tools.map((tool) => ({ id: tool.id, status: tool.status, version: tool.version, command: tool.command, scanners: tool.scanners })),
      evidencePath: attemptPath,
      endedAt: result.timestamp,
    };
    saved.securityRuns = [...(saved.securityRuns ?? []), run];
    saveMission(this.root, saved);
    return result;
  }

  measureNfr(missionId: string, ticketRef?: string): NfrResult {
    const mission = this.must(missionId);
    const ref = ticketRef && mission.tickets.some((ticket) => ticket.ref === ticketRef) ? ticketRef : mission.tickets.at(-1)?.ref ?? "mission";
    const execution = (mission.executions ?? []).find((item) => item.ticketRef === ref);
    const worktree = execution?.worktree && fs.existsSync(execution.worktree) ? execution.worktree : this.root;
    const ticket = mission.tickets.find((item) => item.ref === ref);
    const declared = mission.nfrRequirements ?? [];
    const parsed = declared.length > 0 ? declared : nfrFromText([mission.input, ...mission.artifacts.map((artifact) => artifact.body)].join("\n"));
    const provider = this.nfrFor();
    const timestamp = this.now().toISOString();
    if (parsed.length === 0) {
      const dir = path.join(this.root, ".bmad-next", "evidence", mission.id);
      fs.mkdirSync(dir, { recursive: true });
      const artifact = path.join(dir, `${ref}-nfr.json`);
      const body = { command: "", runtime: provider.id, environment: `${process.platform} ${process.arch} ${process.version}`, metric: "", measurement: null, target: "", timestamp, artifact, status: "NOT_RUN" };
      fs.writeFileSync(artifact, JSON.stringify(body, null, 2));
      this.recordEvidence(mission.id, {
        requirement_id: ticket?.covers[0],
        story_id: ref === "mission" ? undefined : ref,
        result: "not-configured",
        kind: "nfr",
        runner: provider.id,
        started_at: timestamp,
        finished_at: timestamp,
        exit_code: null,
        command: "",
        artifact,
      });
      return { status: "NOT_RUN", measurements: [], runtime: provider.id, environment: body.environment, timestamp };
    }
    this.emit(mission, "NfrStarted", { ticketRef: ref });
    const measurements = parsed.map((requirement) => provider.measureBlocking({ missionId: mission.id, ticketRef: ref, worktree, requirement }));
    const status = measurements.some((item) => item.result === "NOT_CONFIGURED")
      ? "NOT_CONFIGURED"
      : measurements.some((item) => item.result === "ERROR")
        ? "ERROR"
        : measurements.some((item) => item.result === "FAIL")
          ? "FAIL"
          : measurements.every((item) => item.result === "PASS")
            ? "PASS"
            : "NOT_RUN";
    const dir = path.join(this.root, ".bmad-next", "evidence", mission.id);
    fs.mkdirSync(dir, { recursive: true });
    const attempt = (mission.nfrRuns ?? []).filter((item) => item.ticketRef === ref).length + 1;
    const artifact = path.join(dir, `${ref}-nfr-${attempt}.json`);
    const environment = `${process.platform} ${process.arch} ${process.version}`;
    const body = {
      command: measurements.map((item) => item.command).join(" && "),
      runtime: provider.id,
      environment,
      metric: measurements.map((item) => item.metric),
      measurement: measurements.map((item) => ({ metric: item.metric, measured: item.measured, target: `${item.operator}${item.target}${item.unit}`, result: item.result })),
      target: measurements.map((item) => `${item.metric} ${item.operator} ${item.target}${item.unit}`),
      timestamp,
      artifact,
      status,
    };
    fs.writeFileSync(artifact, JSON.stringify(body, null, 2));
    fs.writeFileSync(path.join(dir, `${ref}-nfr.json`), JSON.stringify(body, null, 2));
    const evidenceResult: EvidenceResult = status === "PASS" ? "pass" : status === "FAIL" ? "fail" : status === "NOT_RUN" || status === "NOT_CONFIGURED" ? "not-configured" : "blocked";
    this.recordEvidence(mission.id, {
      requirement_id: ticket?.covers[0],
      story_id: ref === "mission" ? undefined : ref,
      result: evidenceResult,
      kind: "nfr",
      runner: provider.id,
      started_at: timestamp,
      finished_at: this.now().toISOString(),
      exit_code: status === "PASS" ? 0 : status === "FAIL" ? 1 : null,
      command: body.command,
      artifact,
    });
    const saved = this.must(mission.id);
    saved.nfrRuns = [
      ...(saved.nfrRuns ?? []),
      ...measurements.map((item) => ({
        id: item.id,
        ticketRef: ref,
        metric: item.metric,
        measured: item.measured,
        target: `${item.operator} ${item.target}${item.unit}`,
        unit: item.unit,
        result: item.result,
        command: item.command,
        evidencePath: artifact,
        timestamp,
      })),
    ];
    saveMission(this.root, saved);
    this.emit(saved, status === "FAIL" || status === "ERROR" ? "NfrFailed" : "NfrCompleted", { ticketRef: ref, status });
    return { status, measurements, runtime: provider.id, environment, timestamp };
  }

  verifyArchitecture(missionId: string): { status: "PASS" | "FAIL" | "BLOCKED"; evidence: string } {
    const mission = this.must(missionId);
    const execution = [...(mission.executions ?? [])].reverse().find((item) => item.worktree && fs.existsSync(item.worktree));
    const root = execution?.worktree && fs.existsSync(execution.worktree) ? execution.worktree : this.root;
    this.emit(mission, "ArchitectureVerificationStarted", {});
    const report = verifyArchitectureTree({ root, declared: mission.architecture, timestamp: this.now().toISOString() });
    const dir = path.join(this.root, ".bmad-next", "evidence", mission.id);
    fs.mkdirSync(dir, { recursive: true });
    const historical = path.join(dir, `architecture-verification-${this.id()}.json`);
    fs.writeFileSync(historical, JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(dir, "architecture-verification.json"), JSON.stringify(report, null, 2));
    this.recordEvidence(mission.id, {
      requirement_id: mission.requirements[0]?.id,
      result: report.status === "PASS" ? "pass" : report.status === "FAIL" ? "fail" : "blocked",
      kind: "architecture",
      runner: "architecture-check",
      started_at: report.timestamp,
      finished_at: report.timestamp,
      exit_code: report.status === "PASS" ? 0 : report.status === "FAIL" ? 1 : null,
      command: "verifyArchitecture",
      artifact: historical,
    });
    this.emit(this.must(mission.id), "ArchitectureVerificationCompleted", { status: report.status });
    return { status: report.status, evidence: historical };
  }

  verifyTraceability(missionId: string): { status: "PASS" | "FAIL" | "BLOCKED"; evidence: string } {
    const mission = this.must(missionId);
    const report = traceMission(mission, this.now().toISOString());
    const dir = path.join(this.root, ".bmad-next", "evidence", mission.id);
    fs.mkdirSync(dir, { recursive: true });
    const historical = path.join(dir, `traceability-${this.id()}.json`);
    fs.writeFileSync(historical, JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(dir, "traceability.json"), JSON.stringify(report, null, 2));
    this.recordEvidence(mission.id, {
      requirement_id: mission.requirements[0]?.id,
      result: report.status === "PASS" ? "pass" : report.status === "FAIL" ? "fail" : "blocked",
      kind: "traceability",
      runner: "traceability",
      started_at: report.timestamp,
      finished_at: report.timestamp,
      exit_code: report.status === "PASS" ? 0 : report.status === "FAIL" ? 1 : null,
      command: "verifyTraceability",
      artifact: historical,
    });
    this.emit(this.must(mission.id), "TraceabilityChecked", { status: report.status });
    return { status: report.status, evidence: historical };
  }

  registerBrowserScenario(missionId: string, scenario: BrowserScenario): BrowserScenario {
    const mission = this.must(missionId);
    if (!mission.requirements.some((requirement) => requirement.id === scenario.requirementId)) {
      throw new Error(`Browser scenario ${scenario.id} is not linked to a requirement in the mission.`);
    }
    const scenarios = this.readScenarios(missionId).filter((item) => item.id !== scenario.id);
    scenarios.push(scenario);
    this.writeScenarios(missionId, scenarios);
    return scenario;
  }

  attackTicket(missionId: string, ticketRef?: string): AttackRecord | { status: "BLOCKED" | "NOT_CONFIGURED"; summary: string } {
    const mission = this.must(missionId);
    const ref = ticketRef && mission.tickets.some((ticket) => ticket.ref === ticketRef) ? ticketRef : mission.tickets.at(-1)?.ref;
    if (!ref) return { status: "NOT_CONFIGURED", summary: "No ticket is available to attack." };
    const ticket = mission.tickets.find((item) => item.ref === ref);
    if (!ticket) return { status: "NOT_CONFIGURED", summary: `Ticket ${ref} is not in the mission.` };
    const review = [...(mission.reviews ?? [])].reverse().find((item) => item.ticketRef === ref);
    if (!review || review.status !== "PASS") return { status: "BLOCKED", summary: "Attack runs after a passing review." };
    const latestAttack = [...(mission.attacks ?? [])].reverse().find((item) => item.ticketRef === ref);
    const repairedAfter = [...(mission.repairs ?? [])].reverse().find((item) => item.ticketRef === ref && item.status === "COMPLETED" && latestAttack && item.endedAt >= latestAttack.endedAt);
    if (latestAttack?.status === "FAIL" && !repairedAfter) return { status: "BLOCKED", summary: "Repair the attack finding first." };
    const worktree = (mission.executions ?? []).find((item) => item.ticketRef === ref)?.worktree;
    if (!worktree || !fs.existsSync(worktree)) return { status: "BLOCKED", summary: "The ticket worktree is not on disk, so no attack ran." };
    this.conductAttack(mission, ticket, worktree);
    return [...(this.must(missionId).attacks ?? [])].reverse().find((item) => item.ticketRef === ref) ?? { status: "BLOCKED", summary: "Attack produced no record." };
  }

  verifyTicket(missionId: string, ticketRef: string): { ticketRef: string; verification: string; evidence: EvidenceRecord[] } {
    const mission = this.must(missionId);
    if (!mission.tickets.some((ticket) => ticket.ref === ticketRef)) throw new Error(`Ticket ${ticketRef} is not in the mission.`);
    const execution = (mission.executions ?? []).find((item) => item.ticketRef === ticketRef);
    return {
      ticketRef,
      verification: execution?.verification ?? "not-run",
      evidence: mission.evidence.filter((record) => record.story_id === ticketRef),
    };
  }

  async verifyRequirement(missionId: string, requirementId: string): Promise<{ requirementId: string; proof: ReturnType<typeof proofFor>; browser: BrowserResult | { status: "NOT_CONFIGURED"; summary: string } }> {
    const mission = this.must(missionId);
    const requirement = mission.requirements.find((item) => item.id === requirementId);
    if (!requirement) throw new Error(`Requirement ${requirementId} is not in the mission.`);
    const scenario = this.readScenarios(missionId).find((item) => item.requirementId === requirementId);
    const browser = scenario ? await this.runBrowser(missionId, scenario.id) : { status: "NOT_CONFIGURED" as const, summary: "No browser scenario is linked to this requirement." };
    return { requirementId, proof: proofFor(requirement, this.must(missionId)), browser };
  }

  async runBrowser(missionId: string, scenarioId?: string): Promise<BrowserResult> {
    const mission = this.must(missionId);
    const scenarios = this.readScenarios(missionId);
    const scenario = scenarioId
      ? scenarios.find((item) => item.id === scenarioId || item.requirementId === scenarioId)
      : scenarios.length === 1
        ? scenarios[0]
        : undefined;
    const startedAt = this.now().toISOString();
    if (!scenario) {
      return this.browserRefusal(mission, scenarioId ?? "browser", "NOT_CONFIGURED", "No browser scenario is linked to a requirement.", startedAt);
    }
    const blocked = this.attackBlocksBrowser(mission, scenario.requirementId);
    if (blocked) return this.browserRefusal(mission, scenario.id, "ERROR", blocked, startedAt, scenario);
    const config = readConfig(this.root);
    const origins = config.browserOrigins ?? [];
    if (origins.length === 0) return this.browserRefusal(mission, scenario.id, "NOT_CONFIGURED", "No browser origins are configured.", startedAt, scenario);
    const invalid = validateScenario(scenario, origins, mission.autonomy);
    if (invalid) return this.browserRefusal(mission, scenario.id, "ERROR", invalid, startedAt, scenario);
    const provider = this.browserFor();
    if (!provider.availableSync()) {
      const probed = provider.id === "playwright" ? probePlaywright().detail : "Browser provider is not available.";
      return this.browserRefusal(mission, scenario.id, "NOT_CONFIGURED", probed, startedAt, scenario);
    }
    this.emit(mission, "BrowserStarted", { scenarioId: scenario.id, requirementId: scenario.requirementId, browser: provider.id });
    const evidenceDir = path.join(this.root, ".bmad-next", "evidence", mission.id, scenario.id);
    fs.mkdirSync(evidenceDir, { recursive: true });
    const result = seal(await provider.run(scenario, { origins, autonomy: mission.autonomy, timeoutMs: 30000, evidenceDir }));
    for (const step of result.steps) {
      this.emit(mission, "BrowserStepStarted", { scenarioId: scenario.id, action: step.action, name: step.name });
      this.emit(mission, "BrowserStepCompleted", { scenarioId: scenario.id, action: step.action, name: step.name, status: step.status });
    }
    const artifact = path.join(this.root, ".bmad-next", "evidence", mission.id, `${scenario.id}.json`);
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, JSON.stringify({ ...result, scenario, timestamp: result.endedAt }, null, 2));
    const evidenceResult: EvidenceResult = result.status === "PASS" ? "pass" : result.status === "NOT_CONFIGURED" ? "not-configured" : result.status === "ERROR" ? "blocked" : "fail";
    this.recordEvidence(mission.id, {
      requirement_id: scenario.requirementId,
      story_id: mission.tickets.find((ticket) => ticket.covers.includes(scenario.requirementId))?.ref,
      result: evidenceResult,
      kind: "browser",
      type: "browser",
      source: "playwright",
      runner: provider.id,
      started_at: result.startedAt,
      finished_at: result.endedAt,
      exit_code: result.status === "PASS" ? 0 : result.status === "NOT_CONFIGURED" ? null : 1,
      command: `playwright ${scenario.id}`,
      artifact,
    });
    if (result.status === "PASS") this.emit(mission, "BrowserCompleted", { scenarioId: scenario.id, requirementId: scenario.requirementId, status: result.status });
    else this.emit(mission, "BrowserFailed", { scenarioId: scenario.id, requirementId: scenario.requirementId, status: result.status, summary: result.summary });
    saveMission(this.root, this.must(mission.id));
    return result;
  }

  research(missionId: string, claims: ResearchClaim[]): { availability: string; claims: ResearchClaim[] } {
    const mission = this.must(missionId);
    const result = new BmadResearchProvider().investigate(mission.input, claims);
    if (result.claims.length === 0) return result;
    const body = result.claims.map((claim) => `- ${claim.claim} (${claim.confidence}) source ${claim.source} at ${claim.timestamp}`).join("\n");
    const relative = path.join(".bmad-next", "missions", mission.id, "artifacts", "research.md");
    fs.mkdirSync(path.dirname(path.join(this.root, relative)), { recursive: true });
    fs.writeFileSync(path.join(this.root, relative), body);
    this.addArtifact(mission, {
      kind: "research",
      skillId: "bmad-deep-recon",
      creator: "bmad-research",
      producer: "supplied-sources",
      body,
      relativePath: relative,
      state: "in-progress",
    });
    saveMission(this.root, mission);
    return result;
  }

  retrospective(missionId: string): { path: string; completed: false } {
    const mission = this.must(missionId);
    const body = retrospectiveBrief(mission, readEvents(this.root, mission.id));
    const relative = path.join(".bmad-next", "missions", mission.id, "artifacts", "retrospective.md");
    fs.mkdirSync(path.dirname(path.join(this.root, relative)), { recursive: true });
    fs.writeFileSync(path.join(this.root, relative), body);
    this.addArtifact(mission, {
      kind: "retrospective",
      skillId: "bmad-retrospective",
      creator: "control-plane",
      producer: "event-log",
      body,
      relativePath: relative,
      state: "in-progress",
    });
    this.emit(mission, "RetrospectiveCreated", { path: relative, upstreamComplete: false });
    saveMission(this.root, mission);
    return { path: relative, completed: false };
  }

  tea(missionId: string): { path: string; completed: false } {
    const mission = this.must(missionId);
    const body = teaBrief(mission);
    const relative = path.join(".bmad-next", "missions", mission.id, "artifacts", "tea.md");
    fs.mkdirSync(path.dirname(path.join(this.root, relative)), { recursive: true });
    fs.writeFileSync(path.join(this.root, relative), body);
    this.addArtifact(mission, {
      kind: "tea",
      skillId: "tea",
      creator: "control-plane",
      producer: "tea-boundary",
      body,
      relativePath: relative,
      state: "in-progress",
    });
    saveMission(this.root, mission);
    return { path: relative, completed: false };
  }

  builder(missionId: string, kind: BuilderKind, name: string): { published: false; path: string } {
    const mission = this.must(missionId);
    const body = builderDraft(kind, name);
    const relative = path.join(".bmad-next", "missions", mission.id, "artifacts", `builder-${kind}-${name}.md`);
    fs.mkdirSync(path.dirname(path.join(this.root, relative)), { recursive: true });
    fs.writeFileSync(path.join(this.root, relative), body);
    if (kind === "skill") this.proposeSkill(missionId, name, "builder draft", body);
    else {
      this.addArtifact(this.must(missionId), {
        kind: `builder-${kind}`,
        skillId: "bmad-builder",
        creator: "control-plane",
        producer: "builder-boundary",
        body,
        relativePath: relative,
        state: "in-progress",
      });
      saveMission(this.root, this.must(missionId));
    }
    return { published: false, path: relative };
  }

  repository(): ReturnType<typeof repositoryIntelligence> {
    return repositoryIntelligence(this.runner, this.root);
  }

  managedWorktree(missionId: string, ticketRef: string, agent: string): ReturnType<WorktreeManager["create"]> {
    this.must(missionId);
    return this.worktreeManager.create(this.root, missionId, ticketRef, agent);
  }

  contextFor(missionId: string, ticketRef: string, budget = 4000): { text: string; omitted: string[] } {
    const mission = this.must(missionId);
    const ticket = mission.tickets.find((item) => item.ref === ticketRef);
    return buildContextBundle({
      rules: "Follow the BMAD ticket tree. Builds stop at built. Missing evidence is blocked.",
      project: mission.projectContext.architecture.concat(mission.projectContext.constraints).join("\n"),
      mission: `${mission.title}\n${mission.input}`,
      story: ticket ? `${ticket.ref} ${ticket.title}\n${ticket.description}\n${ticket.verify}` : "",
      artifacts: mission.artifacts.map((artifact) => `${artifact.kind} ${artifact.path}`).join("\n"),
      memory: mission.brain.failurePatterns.map((item) => item.text).join("\n"),
      repository: "Repository map is loaded by reference. The full tree is not injected.",
      budget,
    });
  }

  proof(missionId: string, requirementId: string): ReturnType<typeof proofFor> {
    const mission = this.must(missionId);
    const requirement = mission.requirements.find((item) => item.id === requirementId);
    if (!requirement) throw new Error(`Requirement ${requirementId} was not found.`);
    return proofFor(requirement, mission);
  }

  graph(missionId: string, requirementId: string): { nodes: Array<{ id: string; kind: string }>; edges: Array<{ from: string; to: string }> } {
    const mission = this.must(missionId);
    const requirement = mission.requirements.find((item) => item.id === requirementId);
    if (!requirement) throw new Error(`Requirement ${requirementId} was not found.`);
    const nodes = [
      { id: requirement.id, kind: "requirement" },
      ...mission.artifacts.filter((artifact) => artifact.dependencies.includes(requirement.id) || requirement.linked_artifacts.includes(artifact.id)).map((artifact) => ({ id: artifact.id, kind: artifact.kind })),
      ...mission.tickets.filter((ticket) => ticket.covers.includes(requirement.id)).map((ticket) => ({ id: ticket.ref, kind: "ticket" })),
      ...mission.evidence.filter((record) => record.requirement_id === requirement.id).map((record) => ({ id: record.evidence_id, kind: record.kind })),
    ];
    const edges = nodes.filter((node) => node.id !== requirement.id).map((node) => ({ from: requirement.id, to: node.id }));
    return { nodes, edges };
  }

  coverage(missionId: string): ReturnType<typeof coverage> {
    return coverage(this.must(missionId));
  }

  scan(level: "quick" | "deep" | "exhaustive"): ReturnType<typeof scanRepository> {
    return scanRepository(this.root, level);
  }

  doctor(): ReturnType<typeof runDoctor> {
    return runDoctor(this.root, this.runner);
  }

  worktrees(): ReturnType<typeof listWorktrees> {
    return listWorktrees(this.root, this.runner);
  }

  sandbox(): LocalSandbox {
    return new LocalSandbox(path.join(this.root, ".bmad-next"), this.runner);
  }

  impact(files: Map<string, string>, start: string): string[] {
    return impactFromImports(files, start);
  }

  batches(missionId: string): TicketEntry[][] {
    return parallelBatches(this.must(missionId).tickets);
  }

  conflicts(missionId: string): string[] {
    const mission = this.must(missionId);
    const found: string[] = [];
    for (let i = 0; i < mission.tickets.length; i += 1) {
      for (let j = i + 1; j < mission.tickets.length; j += 1) {
        const left = mission.tickets[i];
        const right = mission.tickets[j];
        if (!left || !right) continue;
        const overlap = overlappingPaths(left.paths, right.paths);
        if (overlap.length > 0) found.push(`${left.ref} conflicts with ${right.ref}: ${overlap.join(", ")}`);
      }
    }
    return found;
  }

  route(missionId: string, ticketRef: string): ReturnType<typeof routeAgent> {
    const mission = this.must(missionId);
    const ticket = mission.tickets.find((item) => item.ref === ticketRef);
    if (!ticket) throw new Error(`Ticket ${ticketRef} was not found.`);
    return routeAgent(mission.agents, `${ticket.title} ${ticket.description}`, ticket.risk);
  }

  modelRole(kind: "plan" | "code" | "research" | "review" | "triage"): { role: ReturnType<typeof routeModelRole>; model: string | null; status: "available" | "not-configured" } {
    const role = routeModelRole(kind);
    const config = readConfig(this.root);
    const model = config.models[role] ?? null;
    return { role, model, status: model ? "available" : "not-configured" };
  }

  arena(candidates: Parameters<typeof compareArena>[0]): ReturnType<typeof compareArena> {
    return compareArena(candidates);
  }

  mutation(measurements: { injected: number; caught: number } | null): ReturnType<typeof mutationScore> {
    return mutationScore(measurements);
  }

  acceptanceDraft(missionId: string, requirementId: string): string {
    const requirement = this.must(missionId).requirements.find((item) => item.id === requirementId);
    if (!requirement) throw new Error(`Requirement ${requirementId} was not found.`);
    return compileAcceptanceDraft(requirement);
  }

  exportMission(missionId: string): string {
    return JSON.stringify({ mission: this.must(missionId), events: readEvents(this.root, missionId) }, null, 2);
  }

  importMission(payload: string): Mission {
    const parsed = JSON.parse(payload) as { mission?: Mission };
    if (!parsed.mission?.id || !Array.isArray(parsed.mission.requirements) || !Array.isArray(parsed.mission.evidence)) {
      throw new Error("Mission import needs an id, requirements, and evidence.");
    }
    saveMission(this.root, parsed.mission);
    return parsed.mission;
  }

  timeline(missionId: string): Array<{ at: string; type: string }> {
    return missionTimeline(readEvents(this.root, missionId));
  }

  plugins(): PluginRecord[] {
    return listPlugins(this.root);
  }

  addPlugin(manifest: PluginManifest): PluginRecord {
    const record = installPlugin(this.root, manifest, this.now().toISOString());
    const active = activeMissionId(this.root);
    if (active) this.emit(this.must(active), "PluginInstalled", { id: record.id, enabled: false });
    return record;
  }

  enablePlugin(id: string, enabled: boolean): PluginRecord {
    const record = setPluginEnabled(this.root, id, enabled);
    const active = activeMissionId(this.root);
    if (!enabled && active) this.emit(this.must(active), "PluginDisabled", { id });
    return record;
  }

  deletePlugin(id: string): PluginRecord[] {
    return removePlugin(this.root, id);
  }

  fileIndex(): ReturnType<typeof updateFileIndex> {
    return updateFileIndex(this.root);
  }

  services(): ReturnType<typeof serviceStatuses> {
    return serviceStatuses();
  }

  sdkBoundary(): ReturnType<typeof openHandsSdkStatus> {
    return openHandsSdkStatus();
  }

  mutate(file: string, command: string, args: string[]): ReturnType<typeof runMutation> {
    const resolved = path.resolve(this.root, file);
    if (!resolved.startsWith(path.resolve(this.root) + path.sep)) throw new Error("Mutation target is outside the project.");
    return runMutation(this.runner, resolved, command, args, this.root);
  }

  chaos(scenario: "timeout" | "dependency-failure", command: string, args: string[]): ReturnType<typeof runChaos> {
    return runChaos(this.runner, scenario, command, args, this.root);
  }

  config(): ControlConfig {
    return readConfig(this.root);
  }

  updateConfig(patch: Partial<ControlConfig>): ControlConfig {
    const next = { ...readConfig(this.root), ...patch };
    writeConfig(this.root, next);
    return next;
  }

  transitionLoop(missionId: string, next: LoopState): Mission {
    const mission = this.must(missionId);
    this.transition(mission, next);
    saveMission(this.root, mission);
    return mission;
  }

  markVerified(missionId: string): Mission {
    const mission = this.must(missionId);
    if (mission.complexity === "critical" || mission.complexity === "complex") {
      const attack = mission.evidence.some((record) => record.kind === "attack" && record.result === "pass");
      if (!attack) throw new Error("This complexity cannot enter verified without a passing attack run.");
    }
    for (const requirement of mission.requirements) {
      if (!requirementVerified(requirement, mission, fileExists)) {
        throw new Error(`${requirement.id} is not verified.`);
      }
    }
    this.transition(mission, "verified");
    saveMission(this.root, mission);
    return mission;
  }

  diagnose(missionId: string): string[] {
    const events = readEvents(this.root, missionId);
    const notes: string[] = [];
    const failures = events.filter((event) => event.type === "TestFailed" || event.type === "Escalated");
    if (failures.length >= 3) notes.push("repeated-failure");
    const tools = events.filter((event) => event.type === "ToolCalled").map((event) => String(event.data.tool ?? ""));
    const counts = new Map<string, number>();
    for (const tool of tools) counts.set(tool, (counts.get(tool) ?? 0) + 1);
    if ([...counts.values()].some((count) => count >= 3)) notes.push("tool-failure");
    return notes;
  }

  recordTool(missionId: string, tool: string): void {
    const mission = this.must(missionId);
    this.emit(mission, "ToolCalled", { tool });
    saveMission(this.root, mission);
  }

  riskFor(input: { impact: number; security: boolean; data: boolean; deployment: boolean }): RiskLevel {
    return assignRisk(input);
  }

  requiredKinds(risk: RiskLevel): string[] {
    return requiredEvidenceKinds(risk);
  }

  private openForge(mission: Mission, idea: string): Mission["forge"] {
    const questions = materialQuestions(idea, []);
    const session = {
      outcome: "active" as const,
      idea,
      goal: "Decide whether the idea is strong enough to plan.",
      mode: "clarify" as const,
      questions,
      answered: [],
      locks: [],
      workspace: path.join("_bmad-output", "forge", mission.id),
      persistence: "control-plane" as const,
    };
    this.emit(mission, "ForgeSessionStarted", { questions: questions.map((question) => question.id), persistence: session.persistence });
    return session;
  }

  private closeForge(mission: Mission, outcome: ForgeOutcome, reason = ""): Mission {
    if (!mission.forge) throw new Error("No forge session.");
    const open = mission.forge.questions.filter((question) => !mission.forge?.answered.includes(question.id));
    if (outcome === "hardened" && open.length > 0) {
      throw new Error(`Still open: ${open.map((question) => question.prompt).join(" ")}`);
    }
    mission.forge.outcome = outcome;
    if (reason) {
      mission.forge.locks.push({ kind: outcome === "killed" ? "kill" : "note", key: "outcome", text: reason, at: this.now().toISOString() });
    }
    const body = renderForge(mission);
    const relative = path.join(mission.forge.workspace, outcome === "hardened" ? "forged-idea.md" : "memlog.md");
    const absolute = path.join(this.root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, body);
    this.setStep(mission, "bmad-forge-idea", "completed", `User closed the session as ${outcome}. forge-report.html was not rendered.`);
    if (outcome === "hardened") this.requirementsFromForge(mission);
    this.addArtifact(mission, {
      kind: outcome === "hardened" ? "forged-idea" : "forge-memlog",
      skillId: "bmad-forge-idea",
      creator: "user",
      producer: "bmad-next.forge-session",
      body,
      relativePath: relative,
    });
    this.emit(mission, "ForgeClosed", { outcome });
    this.phaseFromWorkflow(mission);
    this.touch(mission);
    saveMission(this.root, mission);
    return mission;
  }

  private requirementsFromForge(mission: Mission): void {
    const locks = mission.forge?.locks ?? [];
    const success = locks.find((lock) => lock.key === "success");
    const problem = locks.find((lock) => lock.key === "problem") ?? locks.find((lock) => lock.key === "users");
    const requirement: Requirement = {
      id: "REQ-001",
      title: mission.title,
      description: problem?.text ?? mission.input,
      priority: "p0",
      risk: mission.complexity === "critical" ? "critical" : mission.complexity === "complex" ? "high" : "medium",
      source: "forge-lock",
      acceptance_criteria: success ? [success.text] : [],
      verification_methods: [],
      dependencies: [],
      status: "draft",
      linked_artifacts: [],
      version: 1,
    };
    mission.requirements = [requirement];
    for (const lock of locks) {
      if (lock.kind === "assumption") mission.projectContext.constraints.push(`${lock.key}: ${lock.text}`);
    }
    mission.projectContext.sources.push("forge-locks");
  }

  private ticketFrom(requirement: Requirement, id: number): TicketEntry {
    return {
      epicId: 1,
      id,
      type: "story",
      title: requirement.title,
      description: requirement.description,
      verify: requirement.acceptance_criteria.join(" ") || "Verification is not declared yet.",
      covers: [requirement.id],
      after: [],
      hits: false,
      risk: requirement.risk,
      paths: [],
      ref: `1.${id}`,
      priority: requirement.priority,
      plan_file: null,
      verification: requirement.verification_methods.join(", ") || "not-run",
    };
  }

  private addArtifact(mission: Mission, input: { kind: string; skillId: string; creator: string; producer: string; body: string; relativePath: string; state?: Artifact["state"]; provenance?: Artifact["provenance"] }): Artifact {
    const artifact: Artifact = {
      id: `art_${this.id()}`,
      kind: input.kind,
      skillId: input.skillId,
      version: 1,
      creator: input.creator,
      missionId: mission.id,
      createdAt: this.now().toISOString(),
      body: input.body,
      path: input.relativePath,
      dependencies: mission.requirements.map((requirement) => requirement.id),
      verified: false,
      producer: input.producer,
      state: input.state ?? "complete",
      provenance: input.provenance,
    };
    mission.artifacts.push(artifact);
    for (const requirement of mission.requirements) {
      if (!requirement.linked_artifacts.includes(artifact.id)) requirement.linked_artifacts.push(artifact.id);
    }
    this.emit(mission, "ArtifactCreated", { id: artifact.id, kind: artifact.kind });
    return artifact;
  }

  private writeContext(mission: Mission, skillId: string): string {
    const file = path.join(this.root, ".bmad-next", "missions", mission.id, "context", `${skillId}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bundle = buildContextBundle({
      rules: `Run upstream skill ${skillId} from BMAD-METHOD ${BMAD_METHOD_PIN.commit}.`,
      project: mission.projectContext.constraints.join("\n"),
      mission: mission.input,
      story: mission.tickets.map((ticket) => ticket.ref).join("\n"),
      artifacts: mission.forge?.locks.map((lock) => `${lock.kind} ${lock.key}: ${lock.text}`).join("\n") ?? "",
      memory: "",
      repository: this.root,
      budget: 8000,
    });
    fs.writeFileSync(file, bundle.text);
    return file;
  }

  private writeCheckpoint(mission: Mission, label: string, verified: boolean): Checkpoint {
    const point: Checkpoint = { id: `cp_${this.id()}`, label, at: this.now().toISOString(), loop: mission.loop, verified };
    mission.checkpoints.push(point);
    const file = path.join(this.root, ".bmad-next", "missions", mission.id, "checkpoints", `${point.id}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(mission, null, 2));
    this.emit(mission, "CheckpointCreated", { id: point.id, label, verified });
    return point;
  }

  private finishDispatch(mission: Mission, ticketRef: string, agent: string, runtime: string, status: DispatchRecord["status"], message: string, worktree?: string): DispatchRecord {
    const record: DispatchRecord = { id: `dsp_${this.id()}`, ticketRef, agent, runtime, status, at: this.now().toISOString(), message, worktree };
    mission.dispatches.push(record);
    this.touch(mission);
    saveMission(this.root, mission);
    return record;
  }

  private dependencyBlock(mission: Mission, ticket: TicketEntry): string | null {
    for (const dependency of ticket.after) {
      const ref = String(dependency);
      const plan = mission.plans.find((item) => item.ref === ref);
      if (!plan || (plan.status !== "built" && plan.status !== "done")) return `Ticket ${ticket.ref} is waiting on ${ref}.`;
    }
    return null;
  }

  private noteExecution(
    mission: Mission,
    ticketRef: string,
    input: Omit<TicketExecution, "ticketRef" | "updatedAt" | "runnerCommand" | "runner" | "startedAt" | "endedAt" | "attempt" | "changedFiles" | "evidence"> &
      Partial<Pick<TicketExecution, "runnerCommand" | "runner" | "startedAt" | "endedAt" | "attempt" | "changedFiles" | "evidence">>,
  ): void {
    if (!mission.executions) mission.executions = [];
    const previous = mission.executions.find((item) => item.ticketRef === ticketRef);
    const now = this.now().toISOString();
    const next: TicketExecution = {
      runnerCommand: input.runtime === "openhands" ? "openhands --headless --json -t" : input.runtime === "none" ? null : input.runtime,
      runner: input.runtime === "none" ? null : input.runtime,
      startedAt: input.status === "running" ? now : previous?.startedAt ?? null,
      endedAt: input.status === "running" ? null : now,
      attempt: input.attempts,
      changedFiles: previous?.changedFiles ?? [],
      evidence: previous?.evidence ?? [],
      ...input,
      ticketRef,
      updatedAt: now,
    };
    const index = mission.executions.findIndex((item) => item.ticketRef === ticketRef);
    if (index >= 0) mission.executions[index] = next;
    else mission.executions.push(next);
  }

  private listChanged(cwd: string): string[] {
    const listed = this.runner.run("git", ["status", "--short", "--untracked-files=all"], cwd, 10000);
    if (listed.exitCode !== 0) return [];
    return listed.stdout.split("\n").map((line) => line.slice(3).trim()).filter((line) => line.length > 0);
  }

  private protocolFile(worktree: string, changedFiles: string[], reported?: string): string | null {
    const candidates = [
      ...(reported ? [reported] : []),
      ...changedFiles.map((file) => (path.isAbsolute(file) ? file : path.join(worktree, file.replace(/\/$/, "")))),
    ];
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      if (/BMAD-TICKET-STATUS:\s*built/.test(fs.readFileSync(file, "utf8"))) return file;
    }
    return null;
  }

  private verifyBuiltTicket(mission: Mission, ticket: TicketEntry, cwd: string): TicketExecution["verification"] {
    this.emit(mission, "VerificationStarted", { ticketRef: ticket.ref });
    const packagePath = path.join(cwd, "package.json");
    let verification: TicketExecution["verification"] = "not-run";
    if (fs.existsSync(packagePath)) {
      const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { scripts?: { test?: string } };
      const script = parsed.scripts?.test;
      if (typeof script === "string" && script.trim()) {
        this.emit(mission, "TestStarted", { ticketRef: ticket.ref, command: "npm test" });
        const started = this.now().toISOString();
        const result = this.runner.run("npm", ["test"], cwd, 120000);
        const finished = this.now().toISOString();
        const relative = path.join(".bmad-next", "evidence", mission.id, `${ticket.ref}-unit.log`);
        const absolute = path.join(this.root, relative);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, `${result.stdout}\n${result.stderr}`);
        const passed = result.exitCode === 0 && !result.timedOut;
        this.recordEvidence(mission.id, {
          requirement_id: ticket.covers[0],
          story_id: ticket.ref,
          result: passed ? "pass" : "fail",
          kind: "unit",
          type: "unit",
          source: "process",
          runner: "process",
          started_at: started,
          finished_at: finished,
          exit_code: result.exitCode,
          command: "npm test",
          artifact: absolute,
        });
        verification = passed ? "pass" : "fail";
      } else {
        mission.findings.push(this.finding("TEST_NOT_RUN", "high", `Ticket ${ticket.ref} has no test script.`, ticket.ref));
      }
    } else {
      mission.findings.push(this.finding("TEST_NOT_RUN", "high", `Ticket ${ticket.ref} has no package.json in its worktree.`, ticket.ref));
    }
    const review = this.conductReview(mission, ticket, cwd);
    if (review.status === "FAIL") return "fail";
    if (review.status !== "PASS") return verification === "pass" ? "blocked" : verification;
    const attack = this.conductAttack(mission, ticket, cwd);
    if (attack.status === "FAIL") return "fail";
    if (attack.status === "NOT_CONFIGURED") return verification === "pass" ? "pass" : verification;
    if (attack.status === "PASS" && verification === "pass") return "pass";
    if (verification === "pass") return "blocked";
    return verification;
  }

  private browserFor(): BrowserProvider {
    if (this.injectedBrowser) return this.injectedBrowser;
    return new PlaywrightBrowser();
  }

  private readScenarios(missionId: string): BrowserScenario[] {
    const file = path.join(this.root, ".bmad-next", "missions", missionId, "browser-scenarios.json");
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as BrowserScenario[];
    return Array.isArray(parsed) ? parsed : [];
  }

  private writeScenarios(missionId: string, scenarios: BrowserScenario[]): void {
    const file = path.join(this.root, ".bmad-next", "missions", missionId, "browser-scenarios.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(scenarios, null, 2));
  }

  private attackBlocksBrowser(mission: Mission, requirementId: string): string | null {
    const tickets = mission.tickets.filter((ticket) => ticket.covers.includes(requirementId));
    const requirement = mission.requirements.find((item) => item.id === requirementId);
    const attackRequired = requirement ? requiredEvidenceKinds(requirement.risk, mission.attackRiskFloor ?? "high").includes("attack") : missionEvidenceKinds(mission).includes("attack");
    const relevant = tickets.length > 0 ? tickets : mission.tickets;
    for (const ticket of relevant) {
      const attack = [...(mission.attacks ?? [])].reverse().find((item) => item.ticketRef === ticket.ref);
      if (attack && (attack.status === "FAIL" || attack.status === "BLOCKED")) {
        return `Browser did not run. Attack ${attack.status} is unresolved for ${ticket.ref}.`;
      }
      if (attackRequired && attack?.status !== "PASS") {
        return "Browser did not run. A passing attack is required before browser verification.";
      }
    }
    if (attackRequired && relevant.length === 0) return "Browser did not run. A passing attack is required before browser verification.";
    return null;
  }

  private browserRefusal(mission: Mission, scenarioId: string, status: "NOT_CONFIGURED" | "ERROR", summary: string, startedAt: string, scenario?: BrowserScenario): BrowserResult {
    const result: BrowserResult = {
      status,
      summary,
      readiness: { packageInstalled: false, binaryInstalled: false, launched: false, executed: false, passed: false },
      scenarioId,
      requirementId: scenario?.requirementId ?? "",
      browser: "chromium",
      browserVersion: null,
      url: scenario?.startUrl ?? "",
      viewport: { width: 1280, height: 720 },
      steps: [],
      assertions: [],
      screenshots: [],
      consoleLogs: [],
      networkErrors: [],
      startedAt,
      endedAt: this.now().toISOString(),
    };
    if (scenario) {
      const artifact = path.join(this.root, ".bmad-next", "evidence", mission.id, `${scenario.id}.json`);
      fs.mkdirSync(path.dirname(artifact), { recursive: true });
      fs.writeFileSync(artifact, JSON.stringify({ ...result, scenario, timestamp: result.endedAt }, null, 2));
      this.recordEvidence(mission.id, {
        requirement_id: scenario.requirementId,
        story_id: mission.tickets.find((ticket) => ticket.covers.includes(scenario.requirementId))?.ref,
        result: status === "NOT_CONFIGURED" ? "not-configured" : "blocked",
        kind: "browser",
        type: "browser",
        source: "playwright",
        runner: this.browserFor().id,
        started_at: startedAt,
        finished_at: result.endedAt,
        exit_code: null,
        command: `playwright ${scenario.id}`,
        artifact,
      });
    }
    return result;
  }

  private reviewerFor(): Reviewer {
    if (this.injectedReviewer) return this.injectedReviewer;
    return new CommandReviewer(this.runner, resolveReviewerConfig(readConfig(this.root)), this.root);
  }

  private attackerFor(): AttackRunner {
    if (this.injectedAttacker) return this.injectedAttacker;
    return new CommandAttacker(this.runner, resolveAttackerConfig(readConfig(this.root)), this.root);
  }

  private securityFor(): SecurityScanner {
    if (this.injectedSecurity) return this.injectedSecurity;
    return new CommandSecurityScanner(this.runner);
  }

  private nfrFor(): NfrScanner {
    if (this.injectedNfr) return this.injectedNfr;
    return new CommandNfrProvider(this.runner);
  }

  private repairSource(mission: Mission, ticketRef: string): { source: "review" | "attack" | "security"; findings: ReviewResult["findings"]; evidencePath: string } | null {
    const review = (mission.reviews ?? []).filter((item) => item.ticketRef === ticketRef).at(-1);
    const attack = (mission.attacks ?? []).filter((item) => item.ticketRef === ticketRef).at(-1);
    const security = (mission.securityRuns ?? []).filter((item) => item.ticketRef === ticketRef).at(-1);
    const candidates: Array<{ source: "review" | "attack" | "security"; at: string; findings: ReviewResult["findings"]; evidencePath: string }> = [];
    if (review?.status === "FAIL") candidates.push({ source: "review", at: review.endedAt, findings: review.findings, evidencePath: review.evidencePath });
    if (attack?.status === "FAIL") candidates.push({ source: "attack", at: attack.endedAt, findings: attack.findings, evidencePath: attack.evidencePath });
    if (security?.status === "FAIL") {
      candidates.push({
        source: "security",
        at: security.endedAt,
        findings: security.findings.filter((finding) => finding.severity === "high" || finding.severity === "critical" || finding.category === "secret").map((finding) => ({
          id: finding.id,
          severity: finding.severity === "critical" ? "critical" : "high",
          category: "security" as const,
          message: finding.message,
          file: finding.path,
          line: finding.line,
          evidence: finding.evidence,
          repair: finding.message,
        })),
        evidencePath: security.evidencePath,
      });
    }
    candidates.sort((left, right) => left.at.localeCompare(right.at));
    const latest = candidates.at(-1);
    return latest ? { source: latest.source, findings: latest.findings, evidencePath: latest.evidencePath } : null;
  }

  private repairRecord(
    ticketRef: string,
    attempt: number,
    status: RepairRecord["status"],
    failure: { source: "review" | "attack" | "security"; findings: ReviewResult["findings"] },
    worktree: string,
    message: string,
    phases: RepairRecord["phases"],
    retryBudget: number,
  ): RepairRecord {
    const now = this.now().toISOString();
    return {
      attempt,
      ticketRef,
      status,
      findingIds: failure.findings.map((finding) => finding.id),
      source: failure.source,
      worktree,
      startedAt: now,
      endedAt: now,
      message,
      phases,
      retryBudget,
      attempts: attempt,
    };
  }

  private rememberRepair(mission: Mission, record: RepairRecord): void {
    if (!mission.repairs) mission.repairs = [];
    mission.repairs.push(record);
  }

  private conductReview(mission: Mission, ticket: TicketEntry, cwd: string): ReviewResult {
    const reviewer = this.reviewerFor();
    const before = this.fingerprint(cwd);
    const startedAt = this.now().toISOString();
    const base = this.runner.run("git", ["rev-parse", "HEAD"], cwd, 10000);
    const head = base.stdout.trim() || "unknown";
    const changedFiles = this.listChanged(cwd);
    const unit = [...mission.evidence].reverse().find((record) => record.story_id === ticket.ref && record.kind === "unit");
    const context: ReviewContext = {
      missionId: mission.id,
      missionTitle: mission.title,
      ticketRef: ticket.ref,
      ticketTitle: ticket.title,
      requirements: this.reviewRequirements(mission, ticket),
      architecture: mission.architecture.map((item) => ({ id: item.id, choice: item.choice })),
      worktree: cwd,
      baseCommit: head,
      headCommit: head,
      changedFiles,
      diff: this.captureDiff(cwd, changedFiles),
      testEvidence: unit ? { result: unit.result, exitCode: unit.exit_code, command: unit.command } : null,
      followsRepair: (mission.repairs ?? []).some((item) => item.ticketRef === ticket.ref && item.status === "COMPLETED"),
      repairAttempt: [...(mission.repairs ?? [])].reverse().find((item) => item.ticketRef === ticket.ref && item.status === "COMPLETED")?.attempt,
    };
    const prior = (mission.reviews ?? []).filter((item) => item.ticketRef === ticket.ref).at(-1);
    const diffFingerprint = crypto.createHash("sha256").update(context.diff).digest("hex");
    const duplicateDiff = Boolean(prior && prior.diffFingerprint && prior.diffFingerprint === diffFingerprint);
    if (reviewer.available()) {
      this.emit(mission, "ReviewStarted", { ticketRef: ticket.ref, reviewer: reviewer.id, promptVersion: REVIEW_PROMPT_VERSION, worktree: cwd });
    }
    const judged = reviewer.reviewSync(context);
    const mutated = this.fingerprint(cwd) !== before;
    const relative = path.join(".bmad-next", "evidence", mission.id, `${ticket.ref}-review.json`);
    const absolute = path.join(this.root, relative);
    const attempt = (mission.reviews ?? []).filter((item) => item.ticketRef === ticket.ref).length + 1;
    let sealed = downgradeReview(judged, { worktreeMutated: mutated });
    const endedAt = this.now().toISOString();
    const record = this.toReviewRecord(sealed, ticket.ref, attempt, cwd, head, changedFiles, absolute, startedAt, endedAt, reviewer.id, diffFingerprint, duplicateDiff);
    record.priorDiffFingerprint = prior?.diffFingerprint ?? null;
    this.writeReviewEvidence(record, absolute);
    sealed = downgradeReview(sealed, { evidenceExists: fs.existsSync(absolute) });
    if (sealed.status !== record.status) {
      record.status = sealed.status;
      record.summary = sealed.summary;
      this.writeReviewEvidence(record, absolute);
    }
    this.rememberReview(mission, record);
    const evidenceResult: EvidenceResult = sealed.status === "PASS" ? "pass" : sealed.status === "FAIL" ? "fail" : "blocked";
    this.recordEvidence(mission.id, {
      requirement_id: ticket.covers[0],
      story_id: ticket.ref,
      result: evidenceResult,
      kind: "review",
      type: "review",
      source: "reviewer",
      runner: reviewer.id,
      model: sealed.model ?? undefined,
      started_at: startedAt,
      finished_at: endedAt,
      exit_code: sealed.status === "PASS" ? 0 : sealed.exitCode,
      command: reviewer.id,
      artifact: absolute,
    });
    mission.evidence = this.must(mission.id).evidence;
    if (reviewer.available()) {
      this.recordUsage(mission, {
        model: sealed.model,
        input_tokens: null,
        output_tokens: null,
        tool_calls: null,
        latency_ms: sealed.durationMs,
        retries: Math.max(attempt - 1, 0),
        cost: sealed.quality.modelCost,
        agent: "Reviewer",
        story_id: ticket.ref,
        at: endedAt,
      });
    }
    const body = fs.readFileSync(absolute, "utf8");
    this.addArtifact(mission, {
      kind: "review",
      skillId: "bmad-code-review",
      creator: "Reviewer",
      producer: reviewer.id,
      body,
      relativePath: relative,
      state: sealed.status === "PASS" ? "complete" : "failed",
    });
    if (sealed.status === "FAIL") {
      this.markPlan(mission, ticket, "blocked", sealed.summary);
      for (const finding of sealed.findings.filter((item) => item.severity === "high" || item.severity === "critical" || item.category === "architecture")) {
        mission.findings.push(this.finding(finding.category === "architecture" ? "ARCHITECTURE_DRIFT" : "REVIEW_FINDING", finding.severity === "critical" ? "critical" : "high", finding.message, ticket.ref, ticket.covers[0]));
      }
      this.moveIfLegal(mission, "blocked");
      this.emit(mission, "TicketBlocked", { ticketRef: ticket.ref, reason: sealed.summary });
      this.emit(mission, "ReviewCompleted", this.reviewEventData(record));
    } else if (sealed.status === "PASS") {
      if (this.protocolFile(cwd, changedFiles)) this.markPlan(mission, ticket, "built", null);
      this.moveIfLegal(mission, "verifying");
      this.moveIfLegal(mission, "reviewing");
      this.emit(mission, "ReviewCompleted", this.reviewEventData(record));
    } else if (reviewer.available()) {
      this.emit(mission, "ReviewFailed", this.reviewEventData(record));
    }
    saveMission(this.root, mission);
    return sealed;
  }

  private reviewRequirements(mission: Mission, ticket: TicketEntry): ReviewContext["requirements"] {
    const covered = mission.requirements.filter((requirement) => ticket.covers.includes(requirement.id));
    const source = covered.length > 0 ? covered : [];
    if (source.length === 0) {
      return [{ id: ticket.ref, title: ticket.title, acceptanceCriteria: [ticket.verify].filter((item) => item.trim().length > 0) }];
    }
    return source.map((requirement) => ({
      id: requirement.id,
      title: requirement.title,
      acceptanceCriteria: requirement.acceptance_criteria.length > 0 ? requirement.acceptance_criteria : [ticket.verify].filter((item) => item.trim().length > 0),
    }));
  }

  private toReviewRecord(
    result: ReviewResult,
    ticketRef: string,
    attempt: number,
    worktree: string,
    commit: string,
    changedFiles: string[],
    evidencePath: string,
    startedAt: string,
    endedAt: string,
    runtime: string,
    diffFingerprint: string,
    duplicateDiff: boolean,
  ): ReviewRecord {
    return {
      attempt,
      ticketRef,
      reviewer: result.reviewerId,
      model: result.model,
      runtime,
      status: result.status,
      findings: result.findings,
      criteria: result.criteria,
      architectureDrift: result.architectureDrift,
      summary: result.summary,
      durationMs: result.durationMs,
      modelCost: result.quality.modelCost,
      falsePositiveFeedback: result.quality.falsePositiveFeedback,
      repairSuccess: result.quality.repairSuccess,
      promptVersion: result.promptVersion,
      promptHash: result.promptHash,
      baseCommit: commit,
      headCommit: commit,
      worktree,
      changedFiles,
      evidencePath,
      startedAt,
      endedAt,
      exitCode: result.exitCode,
      diffFingerprint,
      duplicateDiff,
    };
  }

  private writeReviewEvidence(record: ReviewRecord, absolute: string): void {
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const body = JSON.stringify(
      {
        ticket: record.ticketRef,
        baseCommit: record.baseCommit,
        headCommit: record.headCommit,
        changedFiles: record.changedFiles,
        reviewer: record.reviewer,
        runtime: record.runtime,
        model: record.model,
        timestamp: record.endedAt,
        status: record.status,
        summary: record.summary,
        findings: record.findings,
        criteria: record.criteria,
        architectureDrift: record.architectureDrift,
        promptVersion: record.promptVersion,
        promptHash: record.promptHash,
        worktree: record.worktree,
        attempt: record.attempt,
        diffFingerprint: record.diffFingerprint,
        priorDiffFingerprint: record.priorDiffFingerprint ?? null,
        duplicateDiff: record.duplicateDiff,
        durationMs: record.durationMs,
        exitCode: record.exitCode,
        quality: {
          findings: record.findings.length,
          falsePositiveFeedback: record.falsePositiveFeedback,
          repairSuccess: record.repairSuccess,
          reviewDurationMs: record.durationMs,
          modelCost: record.modelCost,
        },
      },
      null,
      2,
    );
    fs.writeFileSync(absolute, body);
    fs.writeFileSync(absolute.replace(/\.json$/, `-${record.attempt}.json`), body);
  }

  private rememberReview(mission: Mission, record: ReviewRecord): void {
    if (!mission.reviews) mission.reviews = [];
    mission.reviews.push(record);
  }

  private blockedReviewRecord(mission: Mission, ticket: TicketEntry, worktree: string, summary: string): ReviewRecord {
    const attempt = (mission.reviews ?? []).filter((item) => item.ticketRef === ticket.ref).length + 1;
    const evidencePath = path.join(this.root, ".bmad-next", "evidence", mission.id, `${ticket.ref}-review.json`);
    const now = this.now().toISOString();
    return {
      attempt,
      ticketRef: ticket.ref,
      reviewer: "unconfigured",
      model: null,
      runtime: "unconfigured",
      status: "NOT_CONFIGURED",
      findings: [],
      criteria: [],
      architectureDrift: [],
      summary: `status: blocked\n${summary}`,
      durationMs: null,
      modelCost: null,
      falsePositiveFeedback: 0,
      repairSuccess: 0,
      promptVersion: REVIEW_PROMPT_VERSION,
      promptHash: "",
      baseCommit: "unknown",
      headCommit: "unknown",
      worktree,
      changedFiles: [],
      evidencePath,
      startedAt: now,
      endedAt: now,
      exitCode: null,
      diffFingerprint: "",
      duplicateDiff: false,
    };
  }

  private reviewEventData(record: ReviewRecord): Record<string, unknown> {
    return {
      ticketRef: record.ticketRef,
      reviewer: record.reviewer,
      runtime: record.runtime,
      model: record.model,
      baseCommit: record.baseCommit,
      headCommit: record.headCommit,
      worktree: record.worktree,
      promptHash: record.promptHash,
      promptVersion: record.promptVersion,
      result: record.status,
      timestamp: record.endedAt,
    };
  }

  private moveIfLegal(mission: Mission, next: LoopState): void {
    if (mission.loop === next) return;
    if (!LOOP_TRANSITIONS[mission.loop].includes(next)) return;
    this.transition(mission, next);
  }

  private fingerprint(cwd: string): string {
    const listed = this.runner.run("git", ["status", "--short", "--untracked-files=all"], cwd, 10000);
    const files = listed.exitCode === 0 ? listed.stdout.split("\n").map((line) => line.slice(3).trim()).filter((line) => line.length > 0) : [];
    return files
      .map((file) => {
        const absolute = path.isAbsolute(file) ? file : path.join(cwd, file.replace(/\/$/, ""));
        if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return file;
        return `${file}:${crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")}`;
      })
      .join("\n");
  }

  private captureDiff(cwd: string, changedFiles: string[]): string {
    const tracked = this.runner.run("git", ["diff", "HEAD", "--"], cwd, 10000);
    const parts = [tracked.stdout];
    for (const file of changedFiles) {
      const relative = file.replace(/\/$/, "");
      const absolute = path.isAbsolute(relative) ? relative : path.join(cwd, relative);
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
      if (tracked.stdout.includes(relative)) continue;
      parts.push(`diff --git a/${relative} b/${relative}\n--- /dev/null\n+++ b/${relative}\n${fs.readFileSync(absolute, "utf8")}`);
    }
    return redactSecrets(parts.filter((part) => part.trim().length > 0).join("\n"));
  }

  private recordUsage(mission: Mission, usage: Omit<UsageRecord, "id">): void {
    mission.usage.push({ ...usage, id: `use_${this.id()}` });
  }

  private finding(code: string, severity: RiskLevel, message: string, ticketRef?: string, requirementId?: string): Finding {
    return {
      id: `fnd_${this.id()}`,
      code,
      severity,
      message,
      paths: [],
      ticketRef,
      requirementId,
      description: message,
      source: "control-plane",
      createdAt: this.now().toISOString(),
      status: "open",
    };
  }

  private markPlan(mission: Mission, ticket: TicketEntry, status: TicketStatus, blocked: string | null): void {
    const relative = path.join("_bmad-output", mission.id, "plans", `${ticket.ref}.md`);
    const body = [`# ${ticket.ref}`, "", `status: ${status}`, `blocked_reason: ${blocked ?? ""}`, ""].join("\n");
    fs.mkdirSync(path.dirname(path.join(this.root, relative)), { recursive: true });
    fs.writeFileSync(path.join(this.root, relative), body);
    ticket.plan_file = relative;
    ticket.verification = status;
    const existing = mission.plans.find((item) => item.ref === ticket.ref);
    if (existing) {
      existing.status = status;
      existing.blocked_reason = blocked;
      existing.body = body;
      existing.version += 1;
    } else {
      mission.plans.push({ ref: ticket.ref, status, baseline_revision: null, blocked_reason: blocked, body, version: 1 });
    }
  }

  private loops(): BmadLoopRunner {
    return new BmadLoopRunner({
      mission: (id) => this.must(id),
      transitionLoop: (id, next) => this.transitionLoop(id, next),
      checkpoint: (id, label) => this.checkpoint(id, label),
      dispatch: (id, ticketRef) => this.dispatch(id, ticketRef),
    });
  }

  private setStep(mission: Mission, skillId: string, status: Mission["workflow"][number]["status"], reason: string): void {
    const step = mission.workflow.find((item) => item.skillId === skillId);
    if (!step) return;
    step.status = status;
    step.reason = reason;
  }

  private transition(mission: Mission, next: LoopState): void {
    if (mission.loop === next) return;
    const allowed = LOOP_TRANSITIONS[mission.loop];
    if (!allowed.includes(next)) throw new Error(`Cannot move ${mission.loop} to ${next}.`);
    mission.loop = next;
  }

  private phaseFromWorkflow(mission: Mission): void {
    const open = mission.workflow.find((step) => step.status !== "completed" && step.status !== "skipped");
    if (open) mission.phase = open.phase;
  }

  private emit(mission: Mission, type: EventType, data: Record<string, unknown>): void {
    const at = this.now().toISOString();
    appendEvent(this.root, mission.id, { id: `evt_${this.id()}`, type, missionId: mission.id, at, data });
    appendTrace(this.root, { missionId: mission.id, type, at, data });
  }

  private touch(mission: Mission): void {
    mission.updatedAt = this.now().toISOString();
  }

  private must(id: string): Mission {
    const mission = loadMission(this.root, id);
    if (!mission.reviews) mission.reviews = [];
    if (!mission.repairs) mission.repairs = [];
    if (!mission.attacks) mission.attacks = [];
    if (!mission.nfrRequirements) mission.nfrRequirements = [];
    if (!mission.securityRuns) mission.securityRuns = [];
    if (!mission.nfrRuns) mission.nfrRuns = [];
    return mission;
  }

  private conductAttack(mission: Mission, ticket: TicketEntry, cwd: string): AttackResult {
    const attacker = this.attackerFor();
    const before = this.fingerprint(cwd);
    const startedAt = this.now().toISOString();
    const changedFiles = this.listChanged(cwd);
    const diff = this.captureDiff(cwd, changedFiles);
    const diffFingerprint = crypto.createHash("sha256").update(diff).digest("hex");
    const unit = [...mission.evidence].reverse().find((record) => record.story_id === ticket.ref && record.kind === "unit");
    const review = [...(mission.reviews ?? [])].reverse().find((item) => item.ticketRef === ticket.ref);
    const requirements = this.reviewRequirements(mission, ticket);
    const risk = mission.requirements.find((requirement) => ticket.covers.includes(requirement.id))?.risk ?? "medium";
    const context: AttackContext = {
      missionId: mission.id,
      missionTitle: mission.title,
      ticketRef: ticket.ref,
      ticketTitle: ticket.title,
      requirements,
      architecture: mission.architecture.map((item) => ({ id: item.id, choice: item.choice })),
      risk,
      changedFiles,
      diff,
      tests: unit ? { result: unit.result, exitCode: unit.exit_code, command: unit.command } : null,
      reviewFindings: (review?.findings ?? []).map((finding) => ({ id: finding.id, severity: finding.severity, message: finding.message })),
      worktree: cwd,
    };
    if (attacker.available()) {
      this.emit(mission, "AttackStarted", { ticketRef: ticket.ref, attacker: attacker.id, promptVersion: ATTACK_PROMPT_VERSION, worktree: cwd });
    }
    const judged = attacker.attackSync(context);
    const relative = path.join(".bmad-next", "evidence", mission.id, `${ticket.ref}-attack.json`);
    const absolute = path.join(this.root, relative);
    const attempt = (mission.attacks ?? []).filter((item) => item.ticketRef === ticket.ref).length + 1;
    let sealed = downgradeAttack(judged, { worktreeMutated: this.fingerprint(cwd) !== before });
    const endedAt = this.now().toISOString();
    const record: AttackRecord = {
      attempt,
      ticketRef: ticket.ref,
      attacker: attacker.id,
      model: sealed.model,
      status: sealed.status,
      findings: sealed.findings,
      summary: sealed.summary,
      evidencePath: absolute,
      worktree: cwd,
      diffFingerprint,
      promptVersion: sealed.promptVersion,
      durationMs: sealed.durationMs,
      exitCode: sealed.exitCode,
      startedAt,
      endedAt,
    };
    this.writeAttackEvidence(record, absolute, requirements);
    sealed = downgradeAttack(sealed, { evidenceExists: fs.existsSync(absolute) });
    if (sealed.status !== record.status) {
      record.status = sealed.status;
      record.summary = sealed.summary;
      this.writeAttackEvidence(record, absolute, requirements);
    }
    if (!mission.attacks) mission.attacks = [];
    mission.attacks.push(record);
    const evidenceResult: EvidenceResult = sealed.status === "PASS" ? "pass" : sealed.status === "FAIL" ? "fail" : sealed.status === "NOT_CONFIGURED" ? "not-configured" : "blocked";
    this.recordEvidence(mission.id, {
      requirement_id: ticket.covers[0],
      story_id: ticket.ref,
      result: evidenceResult,
      kind: "attack",
      type: "attack",
      source: "attacker",
      runner: attacker.id,
      model: sealed.model ?? undefined,
      started_at: startedAt,
      finished_at: endedAt,
      exit_code: sealed.status === "PASS" ? 0 : sealed.exitCode,
      command: attacker.id,
      artifact: absolute,
    });
    mission.evidence = this.must(mission.id).evidence;
    if (sealed.status === "FAIL") {
      this.markPlan(mission, ticket, "blocked", sealed.summary);
      for (const finding of sealed.findings.filter((item) => item.severity === "high" || item.severity === "critical")) {
        mission.findings.push(this.finding(finding.code, finding.severity === "critical" ? "critical" : "high", finding.message, ticket.ref, ticket.covers[0]));
      }
      this.moveIfLegal(mission, "blocked");
      this.emit(mission, "TicketBlocked", { ticketRef: ticket.ref, reason: sealed.summary });
      this.emit(mission, "AttackCompleted", { ticketRef: ticket.ref, attacker: attacker.id, result: sealed.status, promptVersion: ATTACK_PROMPT_VERSION });
    } else if (sealed.status === "PASS") {
      this.moveIfLegal(mission, "attacking");
      this.emit(mission, "AttackCompleted", { ticketRef: ticket.ref, attacker: attacker.id, result: sealed.status, promptVersion: ATTACK_PROMPT_VERSION });
    } else if (attacker.available()) {
      this.emit(mission, "AttackFailed", { ticketRef: ticket.ref, attacker: attacker.id, result: sealed.status, promptVersion: ATTACK_PROMPT_VERSION });
    }
    saveMission(this.root, mission);
    return sealed;
  }

  private writeAttackEvidence(record: AttackRecord, absolute: string, requirements: AttackContext["requirements"]): void {
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(
      absolute,
      JSON.stringify(
        {
          ticket: record.ticketRef,
          requirements,
          attackRunner: record.attacker,
          model: record.model,
          runtime: record.attacker,
          timestamp: record.endedAt,
          status: record.status,
          summary: record.summary,
          findings: record.findings,
          worktree: record.worktree,
          diffFingerprint: record.diffFingerprint,
          promptVersion: record.promptVersion,
          attempt: record.attempt,
          durationMs: record.durationMs,
          exitCode: record.exitCode,
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(absolute.replace(/\.json$/, `-${record.attempt}.json`), fs.readFileSync(absolute));
  }
}

function ticketRefOf(target?: string): string | null {
  return target?.match(/(\d+\.\d+)/)?.[1] ?? null;
}

function memoryEntries(brain: ProjectBrain): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  for (const value of Object.values(brain)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (item && typeof item === "object" && "text" in item && "invalidated" in item) entries.push(item as MemoryEntry);
    }
  }
  return entries;
}

export function projectSprint(status: TicketStatus): SprintProjection {
  switch (status) {
    case "planned":
    case "draft":
      return "BACKLOG";
    case "ready-for-dev":
      return "READY";
    case "in-progress":
      return "IN PROGRESS";
    case "blocked":
      return "BLOCKED";
    case "in-review":
    case "built":
      return "REVIEW";
    case "done":
      return "DONE";
    case "dropped":
      return "DEFERRED";
  }
}

export function complexityWorkflow(complexity: Complexity): string {
  return complexity;
}

function renderForge(mission: Mission): string {
  const locks = mission.forge?.locks ?? [];
  return [
    "---",
    `outcome: ${mission.forge?.outcome}`,
    "producer: user-locks",
    "---",
    "",
    ...locks.map((lock) => `- ${lock.kind} (${lock.key}): ${lock.text}`),
    "",
  ].join("\n");
}

function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `epic-${cleaned || "mission"}`.slice(0, 48);
}
