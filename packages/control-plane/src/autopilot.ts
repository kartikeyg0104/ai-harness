import type { BmadControlPlane } from "./plane";
import { currentResultFor, missionEvidenceKinds, requirementKinds } from "./quality";
import type { Mission, TicketEntry } from "./types";

export interface AutopilotHooks {
  log(message: string): void;
  stopRequested(): boolean;
}

export type AutopilotStop =
  | "needs-forge-answers"
  | "needs-ticket-acceptance"
  | "needs-release-approval"
  | "released"
  | "blocked"
  | "stopped";

export interface AutopilotResult {
  status: AutopilotStop;
  missionId: string;
  reason: string;
  steps: string[];
}

/** Steps the autopilot drives through dedicated operations instead of a planning skill run. */
const DRIVEN_ELSEWHERE = new Set(["bmad-forge-idea", "bmad-preview-ticketing", "bmad-build", "bmad-code-review", "bmad-review", "bmad-retrospective"]);

/**
 * Drives a mission through every automated step: planning skills, ticketing, build, test, review, repair,
 * attack, browser and NFR planning and runs, security, architecture, traceability, and the release gate.
 * It stops only at decisions that belong to a person (forge answers, ticket-tree acceptance, release
 * approval) or when a gate stays blocked after its bounded retries. It never marks anything passed itself;
 * each result comes from the same control-plane operation a person would run.
 */
export async function runAutopilot(plane: BmadControlPlane, missionId: string, hooks: AutopilotHooks): Promise<AutopilotResult> {
  const steps: string[] = [];
  const say = (message: string) => {
    steps.push(message);
    hooks.log(message);
  };
  const finish = (status: AutopilotStop, reason: string): AutopilotResult => {
    say(`Autopilot stopped: ${status}. ${reason}`);
    return { status, missionId, reason, steps };
  };
  const mission = (): Mission => plane.mission(missionId);
  const stopped = () => hooks.stopRequested();

  // Forge: the answers are the person's intent, so the autopilot only hardens once they are in.
  const forge = mission().forge;
  if (forge && forge.outcome === "active") {
    if (forge.questions.some((question) => !forge.answered.includes(question.id))) {
      say("Answering the forge questions with the model runner.");
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const proposed = plane.proposeForgeAnswers(missionId);
        say(`Forge (attempt ${attempt}): ${proposed.status} — ${proposed.reason}`);
        if (proposed.status !== "blocked") break;
      }
      for (const lock of plane.mission(missionId).forge?.locks ?? []) if (lock.source === "model") say(`  ${lock.key}: ${lock.text}`);
    }
    const refreshed = mission().forge;
    const open = refreshed?.questions.filter((question) => !refreshed.answered.includes(question.id)) ?? [];
    if (open.length > 0) return finish("needs-forge-answers", `Answer: ${open.map((question) => question.prompt).join(" ")}`);
    plane.answerForge(missionId, "harden");
    say(`Forge hardened. Requirements: ${mission().requirements.map((item) => item.id).join(", ")}.`);
  }

  // Planning skills in workflow order, each through the configured model runner.
  for (const step of mission().workflow) {
    if (stopped()) return finish("stopped", "Stop requested.");
    if (DRIVEN_ELSEWHERE.has(step.skillId) || step.skillId.startsWith("bmad-next:") || step.status === "completed" || step.status === "skipped") continue;
    let status: string = step.status;
    for (let attempt = 1; attempt <= 2 && status !== "completed"; attempt += 1) {
      say(`Running ${step.skillId} (attempt ${attempt}).`);
      const current = plane.runSkill(missionId, step.skillId).workflow.find((item) => item.skillId === step.skillId);
      status = current?.status ?? "blocked";
      say(`${step.skillId}: ${status}${current?.reason ? ` — ${current.reason}` : ""}`);
    }
    if (status !== "completed") return finish("blocked", `${step.skillId} did not complete. See its artifact and provenance.`);
  }

  // Ticket tree: proposed automatically, accepted by a named person.
  if (mission().tickets.length === 0) {
    plane.stories(missionId);
    say(`Proposed tickets: ${mission().tickets.map((ticket) => `${ticket.ref} ${ticket.title}`).join("; ") || "none"}.`);
  }
  if (mission().tickets.length === 0) return finish("blocked", "No tickets could be proposed from the requirements.");
  if (!mission().ticketTreeAccepted) return finish("needs-ticket-acceptance", `Accept the ticket tree: ${mission().tickets.map((ticket) => ticket.ref).join(", ")}.`);

  for (const ticket of mission().tickets) {
    const settled = await settleTicket(plane, missionId, ticket, say, stopped);
    if (settled) return finish(settled.status, settled.reason);
  }

  const verified = await verifyMission(plane, missionId, say, stopped);
  if (verified) return finish(verified.status, verified.reason);

  if (stopped()) return finish("stopped", "Stop requested.");
  const report = plane.releaseGate(missionId);
  const open = report.criteria.filter((item) => item.state !== "pass" && item.state !== "waived");
  say(`Release gate: ${report.state}. ${report.criteria.map((item) => `${item.label} ${item.state}`).join(", ")}.`);
  if (report.state === "pass" || report.state === "waived") {
    plane.retrospective(missionId);
    return finish("released", `Release recorded for ${missionId}.`);
  }
  if (open.length > 0 && open.every((item) => item.id === "human-release")) {
    return finish("needs-release-approval", "Every automated gate passed. A named person must approve the release.");
  }
  return finish("blocked", `Release gate ${report.state}: ${open.map((item) => `${item.label} ${item.state} (${item.detail})`).join("; ")}`);
}

function latest<T extends { ticketRef: string }>(items: T[] | undefined, ref: string): T | undefined {
  return (items ?? []).filter((item) => item.ticketRef === ref).at(-1);
}

/** Build, then loop repair and fresh verification until tests, review, and attack pass or the budget runs out. */
async function settleTicket(
  plane: BmadControlPlane,
  missionId: string,
  ticket: TicketEntry,
  say: (message: string) => void,
  stopped: () => boolean,
): Promise<{ status: AutopilotStop; reason: string } | null> {
  const ref = ticket.ref;
  const state = () => {
    const mission = plane.mission(missionId);
    const execution = (mission.executions ?? []).find((item) => item.ticketRef === ref);
    const unitResult = currentResultFor(mission, "unit", ref);
    return {
      mission,
      built: Boolean(execution?.artifact) && mission.plans.some((plan) => plan.ref === ref && plan.status !== "planned"),
      unit: unitResult,
      review: latest(mission.reviews, ref)?.status,
      unclear: latest(mission.reviews, ref)?.unclear ?? [],
      attack: latest(mission.attacks, ref)?.status,
      budgetLeft: plane.config().retryBudget - (mission.attempts[ref] ?? 0),
    };
  };
  let rereviews = 0;
  let reattacks = 0;
  for (let round = 1; round <= 20; round += 1) {
    if (stopped()) return { status: "stopped", reason: "Stop requested." };
    const now = state();
    const requirement = now.mission.requirements.find((item) => ticket.covers.includes(item.id));
    const attackRequired = requirement ? requirementKinds(requirement, now.mission).includes("attack") : missionEvidenceKinds(now.mission).includes("attack");
    if (now.built && now.unit === "pass" && now.review === "PASS" && now.attack === "PASS") {
      say(`Ticket ${ref}: tests pass, review PASS, attack PASS.`);
      return null;
    }
    if (now.built && now.unit === "pass" && now.review === "PASS" && !attackRequired && (now.attack === "NOT_CONFIGURED" || now.attack == null)) {
      say(`Ticket ${ref}: tests pass, review PASS, attack not required.`);
      return null;
    }
    if (attackRequired && now.attack === "NOT_CONFIGURED") {
      return { status: "blocked", reason: `Attacker is not configured for ${ref}. Attack evidence is required.` };
    }
    if (now.budgetLeft <= 0) return { status: "blocked", reason: `Ticket ${ref} spent its retry budget (tests ${now.unit ?? "not run"}, review ${now.review ?? "not run"}, attack ${now.attack ?? "not run"}).` };
    if (!now.built) {
      say(`Building ticket ${ref} with the coding runtime.`);
      const built = plane.executeTicket(missionId, ref);
      say(`Build ${ref}: ${built.status} — ${built.message}`);
      if (built.status === "not-configured") return { status: "blocked", reason: built.message };
      continue;
    }
    const unclearReview = now.review === "BLOCKED" && now.unclear.length > 0;
    const repairable = now.unit === "fail" || now.review === "FAIL" || now.attack === "FAIL" || unclearReview;
    if (repairable) {
      const lastReview = latest(now.mission.reviews, ref);
      if (unclearReview && lastReview?.duplicateDiff) {
        return {
          status: "blocked",
          reason: `Review of ${ref} stayed BLOCKED on the same diff after repair. The reviewer still could not confirm ${now.unclear.join(", ")}.`,
        };
      }
      const attacks = (now.mission.attacks ?? []).filter((item) => item.ticketRef === ref);
      const lastAttack = attacks.at(-1);
      const priorAttack = attacks.at(-2);
      if (now.attack === "FAIL" && lastAttack?.diffFingerprint && lastAttack.diffFingerprint === priorAttack?.diffFingerprint) {
        return {
          status: "blocked",
          reason: `Attack of ${ref} stayed FAIL on the same diff after repair.`,
        };
      }
      say(`Repairing ticket ${ref} (tests ${now.unit ?? "not run"}, review ${now.review ?? "not run"}${unclearReview ? ` — reviewer could not confirm ${now.unclear.join(", ")}` : ""}, attack ${now.attack ?? "not run"}).`);
      const repaired = plane.repairTicket(missionId, ref);
      say(`Repair ${ref}: ${repaired.status} — ${repaired.message}`);
      continue;
    }
    if (now.review !== "PASS") {
      if (rereviews >= 3) return { status: "blocked", reason: `Review of ${ref} stayed ${now.review ?? "not run"} after ${rereviews} fresh reviews.` };
      rereviews += 1;
      say(`Running a fresh review of ${ref} (review was ${now.review ?? "not run"}).`);
      const review = plane.reviewTicket(missionId, ref);
      say(`Review ${ref}: ${review.status} — ${review.summary.slice(0, 300)}`);
      continue;
    }
    if (reattacks >= 3) return { status: "blocked", reason: `Attack on ${ref} stayed ${now.attack ?? "not run"} after ${reattacks} runs.` };
    reattacks += 1;
    say(`Running the attacker against ${ref} (attack was ${now.attack ?? "not run"}).`);
    const attack = plane.attackTicket(missionId, ref);
    say(`Attack ${ref}: ${attack.status} — ${attack.summary.slice(0, 300)}`);
  }
  return { status: "blocked", reason: `Ticket ${ref} did not settle within the autopilot round limit.` };
}

/** Browser and NFR planning and runs, security, architecture, and traceability. */
async function verifyMission(
  plane: BmadControlPlane,
  missionId: string,
  say: (message: string) => void,
  stopped: () => boolean,
): Promise<{ status: AutopilotStop; reason: string } | null> {
  let mission = plane.mission(missionId);
  // A quick fix declares no architecture up front; its declared components are the files the change touched.
  if (mission.mode === "quick" && mission.architecture.length === 0) {
    const touched = [...new Set((mission.executions ?? []).flatMap((item) => item.changedFiles ?? []))]
      .map((file) => file.replace(/\/$/, ""))
      .filter((file) => file && !file.startsWith(".bmad-next") && !file.startsWith("_bmad-output"))
      .slice(0, 20);
    touched.forEach((file, index) => plane.declareArchitecture(missionId, { id: `CMP-${index + 1}`, kind: "component", choice: file, alternatives: [] }));
    if (touched.length > 0) say(`Declared the changed files as the architecture: ${touched.join(", ")}.`);
    mission = plane.mission(missionId);
  }
  const kinds = new Set(missionEvidenceKinds(mission));
  for (const ticket of mission.tickets) {
    const requirement = mission.requirements.find((item) => ticket.covers.includes(item.id));
    if (!requirement) continue;
    // Only the gates this mission's release requires run; a library fix needs no browser, scan, or NFR run.
    const needsBrowser = kinds.has("browser") || requirementKinds(requirement, mission).includes("browser");
    const needsSecurity = kinds.has("security") || requirementKinds(requirement, mission).includes("security");
    const needsNfr = kinds.has("nfr") || requirementKinds(requirement, mission).includes("nfr");
    if (!needsBrowser && !needsSecurity && !needsNfr) continue;
    let browser = null as Awaited<ReturnType<BmadControlPlane["runBrowser"]>> | null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (stopped()) return { status: "stopped", reason: "Stop requested." };
      let plan = plane.planVerification(missionId, ticket.ref);
      if (plan.status !== "PLANNED") {
        say(`Verification plan for ${ticket.ref} (attempt ${attempt}): ${plan.status} — ${plan.summary}`);
        plan = plane.planVerification(missionId, ticket.ref);
      }
      say(`Verification plan for ${ticket.ref}: ${plan.status} — ${plan.summary}`);
      if (plan.status !== "PLANNED") return { status: "blocked", reason: `No usable browser and NFR plan for ${ticket.ref}: ${plan.summary}` };
      browser = await plane.runBrowser(missionId, requirement.id);
      const passed = browser.assertions.filter((item) => item.status === "PASS").length;
      say(`Browser ${requirement.id}: ${browser.status} — ${browser.summary} Assertions ${passed}/${browser.assertions.length}, screenshots ${browser.screenshots.length}.`);
      if (browser.status === "PASS") break;
    }
    if (browser?.status !== "PASS") return { status: "blocked", reason: `Browser verification of ${requirement.id} did not pass: ${browser?.summary ?? "not run"}` };
    if (stopped()) return { status: "stopped", reason: "Stop requested." };
    let security = plane.runSecurity(missionId, ticket.ref);
    say(`Security ${ticket.ref}: ${security.status} — ${security.findings.length} finding(s); ${security.tools.map((tool) => `${tool.id} ${tool.status}`).join(", ")}.`);
    if (security.status === "FAIL") {
      const repaired = plane.repairTicket(missionId, ticket.ref);
      say(`Security repair ${ticket.ref}: ${repaired.status} — ${repaired.message}`);
      security = plane.runSecurity(missionId, ticket.ref);
      say(`Security ${ticket.ref} after repair: ${security.status}.`);
    }
    if (security.status !== "PASS") return { status: "blocked", reason: `Security for ${ticket.ref} is ${security.status}.` };
    const nfr = plane.measureNfr(missionId, ticket.ref);
    say(`NFR ${ticket.ref}: ${nfr.status} — ${nfr.measurements.map((item) => `${item.metric} ${item.measured ?? "none"}${item.unit} ${item.operator} ${item.target}${item.unit} ${item.result}`).join("; ") || "no NFR declared"}.`);
    if (nfr.status !== "PASS" && nfr.status !== "NOT_RUN") return { status: "blocked", reason: `NFR for ${ticket.ref} is ${nfr.status}.` };
  }
  const architecture = plane.verifyArchitecture(missionId);
  say(`Architecture: ${architecture.status} (${architecture.evidence}).`);
  if (architecture.status !== "PASS") return { status: "blocked", reason: `Architecture verification is ${architecture.status}. See ${architecture.evidence}.` };
  const trace = plane.verifyTraceability(missionId);
  say(`Traceability: ${trace.status} (${trace.evidence}).`);
  if (trace.status !== "PASS") return { status: "blocked", reason: `Traceability is ${trace.status}. See ${trace.evidence}.` };
  return null;
}
