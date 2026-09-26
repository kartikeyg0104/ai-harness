import fs from "node:fs";
import type { EvidenceRecord, Mission } from "./types";
import { currentResultFor, evaluateRelease, evidenceIsStale, fileExists, implementationLinks, partitionEvidence, proofFor, releaseApprovalRequired, releaseMatrix, requirementCoverage } from "./quality";
import { projectSprint } from "./plane";

export function renderMissionControl(mission: Mission): string {
  const release = evaluateRelease(mission, fileExists);
  const phases = ["discover", "specify", "design", "plan", "build", "verify", "ship", "learn"] as const;
  const phaseCells = phases
    .map((phase) => {
      const steps = mission.workflow.filter((step) => step.phase === phase);
      const label = steps.length === 0 ? "not in workflow" : steps.every((step) => step.status === "completed") ? "complete" : "open";
      return `<div class="phase"><span>${escapeHtml(phase)}</span><strong>${escapeHtml(label)}</strong></div>`;
    })
    .join("");
  const steps = mission.workflow
    .map((step) => `<li><code>${escapeHtml(step.skillId)}</code> <em>${escapeHtml(step.status)}</em> ${escapeHtml(step.reason ?? "")}</li>`)
    .join("");
  const questions = mission.forge?.questions
    .filter((question) => !mission.forge?.answered.includes(question.id))
    .map((question) => `<li>${escapeHtml(question.prompt)} <small>${escapeHtml(question.why)}</small></li>`)
    .join("");
  const criteria = release.criteria
    .map((item) => `<li><span>${escapeHtml(item.label)}</span> <strong>${escapeHtml(criterionLabel(item))}</strong> ${escapeHtml(item.detail)}</li>`)
    .join("");
  const tracked = [
    ["forge", "bmad-forge-idea"],
    ["spec", "bmad-spec"],
    ["brief", "bmad-product-brief"],
    ["prd", "bmad-prd"],
    ["ux", "bmad-ux"],
    ["architecture", "bmad-architecture"],
    ["tea", "tea"],
    ["tickets", "bmad-preview-ticketing"],
    ["stories", "bmad-preview-ticketing"],
  ] as const;
  const artifacts = tracked
    .map(([label, skillId]) => {
      const found = [...mission.artifacts].reverse().find((artifact) => artifact.skillId === skillId || artifact.kind === label);
      return `<li>${escapeHtml(label)} <em>${escapeHtml(found?.state ?? "not-started")}</em></li>`;
    })
    .join("");
  const tickets = mission.tickets
    .map((ticket) => {
      const plan = mission.plans.find((item) => item.ref === ticket.ref);
      const execution = (mission.executions ?? []).find((item) => item.ticketRef === ticket.ref);
      const status = plan?.status ?? "planned";
      const runtime = execution?.runtime ?? "not-configured";
      const worktree = execution?.worktree ?? "absent";
      const unit = currentResultFor(mission, "unit", ticket.ref);
      const tests = unit === "pass" ? "PASS" : unit === "fail" ? "FAIL" : "NOT_RUN";
      const evidence = execution?.evidence?.length ?? mission.evidence.filter((record) => record.story_id === ticket.ref).length;
      const protocol = status === "built" || (execution?.artifact && fileExists(execution.artifact)) ? "VALID" : "MISSING";
      const changed = execution?.changedFiles?.length ?? 0;
      return `<li><strong>Ticket ${escapeHtml(ticket.ref)}</strong> ${escapeHtml(ticket.title)} <em>${escapeHtml(status)}</em> <span>${escapeHtml(projectSprint(status))}</span> Skill: ${escapeHtml(execution?.skillId ?? "bmad-build")} Agent: ${escapeHtml(execution?.agent ?? "unassigned")} Runtime: ${escapeHtml(runtime)} Worktree: ${escapeHtml(worktree)} Status: ${escapeHtml((execution?.status ?? "not-configured").toUpperCase())} Changed files: ${escapeHtml(String(changed))} Protocol: ${escapeHtml(protocol)} Tests: ${escapeHtml(tests)} Evidence: ${escapeHtml(String(evidence))} Ticket: ${escapeHtml(status.toUpperCase())}</li>`;
    })
    .join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
<title>BMAD Next</title>
<style>
  /* Colors follow the editor theme inside Code - OSS; the fallbacks keep the page readable outside it. */
  body { margin: 0; padding: 12px; background: var(--vscode-sideBar-background, #14140f); color: var(--vscode-foreground, #f4f0e6); font: 13px/1.45 var(--vscode-font-family, "IBM Plex Sans", "Segoe UI", sans-serif); overflow-wrap: anywhere; }
  h1 { font-family: "IBM Plex Serif", Georgia, serif; font-weight: 500; font-size: 22px; margin: 0 0 4px; }
  .meta { color: var(--vscode-descriptionForeground, #c8b89a); margin-bottom: 16px; }
  .phases { display: grid; grid-template-columns: repeat(auto-fill, minmax(76px, 1fr)); gap: 6px; margin-bottom: 16px; }
  .phase { background: var(--vscode-editorWidget-background, #221f18); padding: 8px; border-top: 2px solid var(--vscode-focusBorder, #d6a25e); }
  .phase strong { display: block; font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
  section { min-width: 0; background: var(--vscode-editorWidget-background, #1c1a15); padding: 12px; }
  h2 { margin: 0 0 8px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--vscode-textLink-foreground, #d6a25e); }
  ul, ol { padding-left: 18px; }
  li { margin: 0 0 6px; }
  code { color: var(--vscode-textPreformat-foreground, #f2d7a2); background: var(--vscode-textPreformat-background, transparent); padding: 0 2px; border-radius: 2px; }
  strong { color: inherit; }
  summary { cursor: pointer; }
</style>
</head>
<body>
  <h1>BMAD Next</h1>
  <p class="meta">${escapeHtml(mission.title)} · ${escapeHtml(mission.complexity)} · ${escapeHtml(mission.mode)} · loop ${escapeHtml(mission.loop)}</p>
  <div class="phases">${phaseCells}</div>
  <div class="grid">
    <section>
      <h2>Workflow</h2>
      <ol>${steps}</ol>
      ${questions ? `<h2>Open forge questions</h2><ul>${questions}</ul>` : ""}
      <h2>Artifacts</h2>
      <ul>${artifacts}</ul>
      <h2>Tickets</h2>
      <ul>${tickets || "<li>No ticket tree accepted.</li>"}</ul>
      ${renderReview(mission)}
      ${renderVerification(mission, release.state)}
      ${renderReleasePanel(mission)}
      ${renderSecurityPanel(mission)}
      ${renderNfrPanel(mission)}
      ${renderArchitecturePanel(mission)}
      ${renderTraceabilityPanel(mission)}
      ${renderApprovalPanel(mission)}
      ${renderLifecycle(mission, release.state)}
      <h2>Requirements</h2>
      <ul>${renderRequirements(mission)}</ul>
      <h2>Evidence</h2>
      <ul>${renderEvidence(mission)}</ul>
    </section>
    <section>
      <h2>Release gate</h2>
      <p><strong>${escapeHtml(gateLabel(release))}</strong></p>
      <ul>${criteria}</ul>
      <p>Last verified build: ${mission.lastVerifiedBuild ? escapeHtml(mission.lastVerifiedBuild.checkpointId) : "none"}</p>
    </section>
  </div>
</body>
</html>`;
}

/** Not-yet-run criteria still block release, but they read as pending, not as a failure. */
export function criterionLabel(item: { id: string; state: string; pending?: boolean }): string {
  if (item.state === "blocked" && item.pending) return item.id === "human-release" ? "waiting for approval" : "not run yet";
  return item.state;
}

export function gateLabel(report: { state: string; criteria: Array<{ id: string; state: string; pending?: boolean }> }): string {
  if (report.state !== "blocked") return report.state.toUpperCase();
  const open = report.criteria.filter((item) => item.state !== "pass" && item.state !== "waived");
  if (open.length > 0 && open.every((item) => item.pending)) {
    return open.every((item) => item.id === "human-release") ? "WAITING FOR APPROVAL" : `IN PROGRESS (${open.length} check${open.length === 1 ? "" : "s"} not run yet)`;
  }
  return "BLOCKED";
}

function renderReview(mission: Mission): string {
  const reviews = mission.reviews ?? [];
  const latest = reviews.at(-1);
  if (!latest) {
    return `<h2>Review</h2><p>Status: NOT_RUN</p><p>Reviewer: not-configured</p><p>Model: unconfigured</p><p>Findings: 0</p><p>Evidence: none</p>`;
  }
  const findings = latest.findings
    .map((finding) => `<li>${escapeHtml(finding.id)} ${escapeHtml(finding.severity)} ${escapeHtml(finding.file ?? "")} ${escapeHtml(finding.message)}</li>`)
    .join("");
  const fix =
    latest.status === "FAIL" && latest.findings.length > 0
      ? `<p><strong>Fix with BMAD</strong> <code>bmad-next repair ${escapeHtml(latest.ticketRef)}</code></p><p>The finding stays open until a later review passes.</p>`
      : "";
  const history = reviews
    .map((item) => `<li>attempt ${String(item.attempt)} ${escapeHtml(item.model ?? item.reviewer)} ${String(item.durationMs ?? 0)}ms ${escapeHtml(item.status)} findings ${String(item.findings.length)}</li>`)
    .join("");
  return `<h2>Review</h2><p>Status: <strong>${escapeHtml(latest.status)}</strong></p><p>Reviewer: ${escapeHtml(latest.reviewer)}</p><p>Model: ${escapeHtml(latest.model ?? "unconfigured")}</p><p>Findings: ${String(latest.findings.length)}</p><ul>${findings}</ul><p>Evidence: ${escapeHtml(latest.evidencePath)}</p>${fix}<h2>Review history</h2><ul>${history}</ul>`;
}

function mark(records: EvidenceRecord[]): string {
  const { current } = partitionEvidence(records);
  if (current.some((record) => record.result === "fail")) return "❌";
  if (current.some((record) => record.result === "pass" && record.exit_code === 0)) return "✅";
  return "⏳";
}

function renderVerification(mission: Mission, releaseState: string): string {
  const latest = (kind: string) => mission.evidence.filter((record) => record.kind === kind);
  const release = releaseState === "pass" || releaseState === "waived" ? "✅" : "🔒";
  const rows = [
    ["TEST", mark(latest("unit"))],
    ["REVIEW", mark(latest("review"))],
    ["ATTACK", mark(latest("attack"))],
    ["BROWSER", mark(latest("browser"))],
    ["SECURITY", mark(latest("security"))],
    ["NFR", mark(latest("nfr"))],
    ["RELEASE", release],
  ];
  return `<h2>Verification</h2><ul>${rows.map(([label, state]) => `<li>${escapeHtml(label)} ${state}</li>`).join("")}</ul>`;
}

function renderLifecycle(mission: Mission, releaseState: string): string {
  const review = (mission.reviews ?? []).at(-1);
  const repair = (mission.repairs ?? []).at(-1);
  const attack = (mission.attacks ?? []).at(-1);
  const ticket = repair?.ticketRef ?? review?.ticketRef ?? "";
  const attempts = repair?.attempts ?? (ticket ? mission.attempts[ticket] ?? 0 : 0);
  const budget = repair?.retryBudget;
  const exhausted = typeof budget === "number" && budget > 0 && attempts >= budget;
  const repairLabel = !repair ? "NOT RUN" : repair.status === "TIMED_OUT" ? "TIMEOUT" : repair.status;
  const attackLabel = attack?.status ?? "NOT RUN";
  const releaseLabel = gateLabel(evaluateRelease(mission, fileExists));
  const attacks = (mission.attacks ?? []).map((item) => `<li>Attack attempt ${String(item.attempt)} ${escapeHtml(item.status)} ${escapeHtml(item.findings[0]?.id ?? "")}</li>`).join("");
  return `<h2>Lifecycle</h2><p>Review: <strong>${escapeHtml(review?.status ?? "NOT RUN")}</strong></p><p>Finding: ${escapeHtml(review?.findings[0]?.id ?? "none")}</p><p>Repair: <strong>${escapeHtml(repairLabel)}</strong></p><p>Retry Budget: <strong>${exhausted ? "EXHAUSTED" : escapeHtml(String(attempts))}</strong></p><p>Attack: <strong>${escapeHtml(attackLabel)}</strong></p><ul>${attacks}</ul><p>Release: <strong>${escapeHtml(releaseLabel)}</strong></p>`;
}

function renderEvidence(mission: Mission): string {
  const records = mission.evidence.slice(-40);
  if (records.length === 0) return "<li>No evidence yet.</li>";
  return records
    .map((record) => {
      return `<li><details><summary>${escapeHtml(record.kind)} ${escapeHtml(record.result)}</summary><p>Type: ${escapeHtml(record.type)}</p><p>Source: ${escapeHtml(record.source)}</p><p>Command: ${escapeHtml(record.command)}</p><p>Timestamp: ${escapeHtml(record.timestamp)}</p><p>Status: ${escapeHtml(record.result)}</p><p>Artifact: ${escapeHtml(record.artifact ?? "none")}</p><p>Commit: ${escapeHtml(record.commit ?? "none")}</p><p>Runtime: ${escapeHtml(record.runtime ?? "none")}</p><p>Model: ${escapeHtml(record.model ?? "none")}</p></details></li>`;
    })
    .join("");
}

function renderRequirements(mission: Mission): string {
  if (mission.requirements.length === 0) return "<li>No requirements yet.</li>";
  return mission.requirements
    .map((requirement) => {
      const review = [...(mission.reviews ?? [])].reverse().find((item) => item.criteria.some((criterion) => criterion.requirementId === requirement.id));
      const criteria = (review?.criteria ?? []).filter((criterion) => criterion.requirementId === requirement.id);
      const lines = criteria
        .map((criterion) => {
          const mark = criterion.status === "PASS" ? "✅" : criterion.status === "FAIL" ? "❌" : "UNCLEAR";
          return `<li>${escapeHtml(criterion.criterion)} ${mark}</li>`;
        })
        .join("");
      const proof = proofFor(requirement, mission)
        .map((node) => `${escapeHtml(node.node)} ${node.state === "present" ? "PASS" : node.state === "failed" ? "FAIL" : node.state === "stale" ? "STALE" : "NOT_RUN"}`)
        .join(" → ");
      const forRequirement = (kind: string) => mission.evidence.filter((record) => record.requirement_id === requirement.id && record.kind === kind && !evidenceIsStale(mission, record));
      const row = [
        requirementCoverage(requirement, mission),
        `Implementation ${implementationLinks(requirement, mission).length > 0 ? "✅" : "⏳"}`,
        `Unit Test ${mark(forRequirement("unit"))}`,
        `Review ${mark(forRequirement("review"))}`,
        `Attack ${mark(forRequirement("attack"))}`,
        `Browser ${mark(forRequirement("browser"))}`,
        `Security ${mark(forRequirement("security"))}`,
        `NFR ${mark(forRequirement("nfr"))}`,
      ].join(" ");
      const evidence = mission.evidence
        .filter((record) => record.requirement_id === requirement.id)
        .slice(-12)
        .map((record) => `<li>${escapeHtml(record.kind)} ${escapeHtml(record.result)} ${escapeHtml(record.command)} ${escapeHtml(record.timestamp)} ${escapeHtml(record.artifact ?? "none")}</li>`)
        .join("");
      const acceptance = requirement.acceptance_criteria.map((criterion) => `<li>${escapeHtml(criterion)}</li>`).join("");
      return `<li><details><summary><strong>${escapeHtml(requirement.id)}</strong> ${escapeHtml(requirement.title)}</summary><p>${escapeHtml(requirement.description)}</p><ul>${acceptance || "<li>No acceptance criteria yet.</li>"}</ul><ul>${lines || "<li>No reviewed criteria yet.</li>"}</ul><p>${row}</p><p>Review: ${escapeHtml(review?.status ?? "NOT_RUN")}</p><p>${proof}</p><ul>${evidence || "<li>No evidence yet.</li>"}</ul></details></li>`;
    })
    .join("");
}

function renderReleasePanel(mission: Mission): string {
  const matrix = releaseMatrix(mission, fileExists, mission.lastVerifiedBuild?.commit ?? null);
  const ready = matrix.current.every((row) => row.state === "PASS" || row.state === "NOT_REQUIRED");
  const label = (state: string) => (state === "NOT_RUN" ? "NOT RUN YET" : state === "WAITING" ? "WAITING FOR APPROVAL" : state);
  const rows = matrix.current
    .map((row) => {
      const mark = row.state === "PASS" ? "✅" : row.state === "NOT_REQUIRED" ? "—" : row.state === "FAIL" ? "❌" : row.state === "NOT_RUN" ? "⏳" : row.state === "WAITING" ? "✋" : "🔒";
      return `<details><summary>${escapeHtml(row.label)} ${mark} ${escapeHtml(label(row.state))}</summary><p>Evidence: ${escapeHtml(row.evidence ?? "none")}</p><p>Timestamp: ${escapeHtml(row.timestamp ?? "none")}</p><p>Command: ${escapeHtml(row.command ?? "none")}</p><p>Artifact: ${escapeHtml(row.artifact ?? "none")}</p><p>Commit: ${escapeHtml(row.commit ?? "none")}</p><p>${escapeHtml(row.detail)}</p></details>`;
    })
    .join("");
  const history = matrix.historical.map((row) => `<li>${escapeHtml(row.label)} ${escapeHtml(row.state)} ${escapeHtml(row.timestamp ?? "")}</li>`).join("");
  const verified = mission.lastVerifiedBuild;
  return `<h2>Release</h2>${rows}<p><strong>${ready ? "RELEASE READY" : "RELEASE BLOCKED"}</strong></p><p>Verified commit: ${escapeHtml(verified?.commit ?? "none")}</p><p>release.json: ${escapeHtml(verified ? "recorded with the release gate" : "not written")}</p><p>Approval history is listed under Release approval.</p>${history ? `<h2>Superseded evidence</h2><ul>${history}</ul>` : ""}`;
}

function renderSecurityPanel(mission: Mission): string {
  const latest = (mission.securityRuns ?? []).at(-1);
  const tools = ["semgrep", "trivy", "trufflehog"].map((id) => {
    const tool = latest?.tools.find((item) => item.id === id);
    const status = tool?.status ?? "NOT CONFIGURED";
    return `<li>${escapeHtml(id)} <strong>${escapeHtml(status === "NOT_CONFIGURED" ? "NOT CONFIGURED" : status)}</strong> ${escapeHtml(tool?.command ?? "")}</li>`;
  });
  return `<h2>Security</h2><ul>${tools.join("")}</ul><p>Evidence: ${escapeHtml(latest?.evidencePath ?? "none")}</p>`;
}

function renderNfrPanel(mission: Mission): string {
  const runs = mission.nfrRuns ?? [];
  if (runs.length === 0) return `<h2>NFR</h2><p>NOT_RUN</p>`;
  const rows = runs
    .map((run) => `<li>${escapeHtml(run.metric)} target ${escapeHtml(run.target)} measured ${escapeHtml(run.measured === null ? "none" : String(run.measured))} ${escapeHtml(run.unit)} <strong>${escapeHtml(run.result)}</strong> ${escapeHtml(run.evidencePath)}</li>`)
    .join("");
  return `<h2>NFR</h2><ul>${rows}</ul>`;
}

function readJson(file: string | undefined): Record<string, unknown> | null {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function renderArchitecturePanel(mission: Mission): string {
  const record = [...mission.evidence].reverse().find((item) => item.kind === "architecture");
  const body = readJson(record?.artifact);
  if (!body) return `<h2>Architecture</h2><p>Declared: ${mission.architecture.length}</p><p>Result: NOT RUN</p>`;
  const violations = Array.isArray(body.violations) ? body.violations.length : 0;
  return `<h2>Architecture</h2><p>Declared: ${escapeHtml(JSON.stringify(body.declaredComponents ?? []))}</p><p>Detected: ${escapeHtml(JSON.stringify(body.detectedComponents ?? []))}</p><p>Drift: ${escapeHtml(String(violations))}</p><p>Result: ${escapeHtml(String(body.status ?? "NOT RUN"))}</p><p>Evidence: ${escapeHtml(record?.artifact ?? "none")}</p>`;
}

function renderTraceabilityPanel(mission: Mission): string {
  const record = [...mission.evidence].reverse().find((item) => item.kind === "traceability");
  const body = readJson(record?.artifact);
  if (!body) return `<h2>Traceability</h2><p>NOT RUN</p>`;
  const requirements = Array.isArray(body.requirements) ? body.requirements : [];
  const count = (key: string) => requirements.reduce((sum, item) => sum + (item && typeof item === "object" && Array.isArray((item as { links?: Record<string, unknown> }).links?.[key]) ? ((item as { links: Record<string, unknown[]> }).links[key]?.length ?? 0) : 0), 0);
  return `<h2>Traceability</h2><p>Requirements: ${escapeHtml(String(requirements.length))}</p><p>Mapped Tickets: ${escapeHtml(String(count("tickets")))}</p><p>Mapped Code: ${escapeHtml(String(count("implementation")))}</p><p>Mapped Tests: ${escapeHtml(String(count("tests")))}</p><p>Mapped Security: ${escapeHtml(String(count("security")))}</p><p>Mapped NFR: ${escapeHtml(String(count("nfr")))}</p><p>Mapped Evidence: ${escapeHtml(String(count("evidence")))}</p><p>Result: ${escapeHtml(String(body.status ?? "NOT RUN"))}</p><p>Evidence: ${escapeHtml(record?.artifact ?? "none")}</p>`;
}

function renderApprovalPanel(mission: Mission): string {
  const decisions = mission.approvals.filter((item) => item.category === "release");
  const latest = decisions.at(-1);
  const status = latest?.decision === "approved" ? "APPROVED" : latest?.decision === "rejected" ? "REJECTED" : releaseApprovalRequired(mission) ? "WAITING FOR APPROVAL" : "NOT REQUIRED";
  const history = decisions.map((item) => `<li>${escapeHtml(item.decision)} by ${escapeHtml(item.identity)} at ${escapeHtml(item.at)}</li>`).join("");
  return `<h2>Release approval</h2><p>Status: <strong>${escapeHtml(status)}</strong></p><p>Approver: record it with <code>bmad-next release approve ${escapeHtml(mission.id)} --by "Name"</code></p><p>Decision: <code>bmad-next release approve</code> or <code>bmad-next release reject</code>. A click in this panel is not an approval.</p>${history ? `<ul>${history}</ul>` : ""}`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}
