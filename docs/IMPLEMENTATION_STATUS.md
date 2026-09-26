# Implementation status

Inspected against the workspace on 2026-09-26. Status comes from the control-plane code and the test run, not from type names or UI labels alone.

BMAD-METHOD pin: `5e33d3c03ba53187a40ab679d5479cdd4b6ac2fb`.

Reviewer: implemented. Configured only when `BMAD_REVIEWER_RUNNER` or `config.reviewer` is set. This repository's own config does not set it, so a fresh checkout is not configured.

Attacker: implemented. Configured only when `BMAD_ATTACK_RUNNER` or `config.attacker` is set. A missing attacker is `NOT_CONFIGURED`, not a pass. High and critical missions require attack. The default medium policy does not.

OpenCode completion: `opencode run` 1.18.25 exits on session idle. `--auto` was leaving the build agent in tool steps after the writes. The adapter now requires `step_finish` reason `stop`. A timeout without that event stays `TIMEOUT`.

Live attack and browser: fresh mission `msn_1_fa242f19` in `.tmp/live-attack-browser-DK2u0x`, model `nvidia/google/gemma-4-31b-it`. Review attempt 1 `FAIL` (`REV-001`, missing `test.js`). Repair attempt 1 `COMPLETED`. Tests then passed. Review attempt 2 `PASS` with a new diff fingerprint and `priorDiffFingerprint` set to the first hash. Attack attempt 1 `BLOCKED` on a 180s timeout and was kept in `1.1-attack-1.json`. Attack attempt 2 `PASS`. Browser scenario `BROWSER-REQ-001` then `PASS` against a page that called the worktree `health()`; screenshots `start`, `action`, and `final` are on disk. Release stayed `fail` and `lastVerifiedBuild` stayed null. The earlier missions `msn_1_89cd3412` and `msn_1_aeda47ef` were not reused.

Security, NFR, architecture verification, traceability, and human approval are executed gates. A missing scanner stays `NOT_CONFIGURED`. A later pass of the same ticket and requirement supersedes an earlier failure for the current gate and keeps the old record. Mission `msn_1_fa242f19` was not forced to release. OpenHands is not configured.

Fresh release attempt: mission `msn_1_90da5c4d` in `.tmp/live-release-bj1jTd`, model `nvidia/google/gemma-4-31b-it`. `executeTicket` timed out after 300s with 0 output tokens and no `step_finish`. The execution is `TIMED_OUT`, changed files 0, verification `not-run`. The loop moved `draft` → `ready` → `blocked`. Review, attack, and browser did not run. Semgrep 1.176.0, Trivy 0.74.0 (`vuln`, `misconfig`, `secret`), and TruffleHog 3.97.9 scanned that worktree and recorded `PASS` with 0 findings in `1.1-security-1.json`. NFR `p95 latency` measured null (`ERROR`) because `src/health.js` was absent. Architecture `FAIL` with blocking `COMPONENT_MISSING` for `src/health.js`. Traceability `FAIL` with missing links `REQ-001 unit`, `review`, `browser`, `attack`, and `nfr`. CLI `release approve --by "Ada Lovelace"` appended an approved decision. `release` stayed `fail`. `release.json` was not written. `lastVerifiedBuild` stayed null. An earlier attempt `msn_1_229dfffa` timed out the same way and was not reused. A coding timeout from `draft` is recorded instead of throwing `Cannot move draft to failed`.

Qwen, Goose, SWE-agent, and mini-swe-agent are registered CLI adapters. They stay `NOT CONFIGURED` when the binary is missing. Evidence older than the current requirement version is stale and does not pass the gate. Plugins require a permission manifest and start disabled. Context7, Git MCP, LiteLLM, Langfuse, Phoenix, ACP, and A2A stay `not-configured` without their environment variables. The file index is a content index, not an AST.

## Control plane

| Module | Responsibility | Public API | Persistence | Events | Tests | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `plane.ts` | Mission lifecycle | `BmadControlPlane` | `.bmad-next/missions/<id>/mission.json`, `events.jsonl`, active pointer | append-only JSONL | invariants, lifecycle | IMPLEMENTED |
| `store.ts` | Home, config, load and save | store functions | `.bmad-next/config.json` | write path for events | through plane tests | IMPLEMENTED |
| `catalog.ts` | Skill ids and workflow choice | `selectWorkflow`, `BMAD_METHOD_PIN` | none | `WorkflowSelected` from the plane | workflow tests | IMPLEMENTED |
| `skill-runner.ts` | Skill process and pinned headless contract | `BmadRunner` through `CommandModelRunner` | skill output plus provenance JSON | `SkillResolved`, `SkillStarted`, `SkillCompleted`, `SkillFailed` | live `opencode run` bmad-spec, timeout, empty output, invalid JSON, missing SPEC.md, missing command | IMPLEMENTED |
| `reviewer.ts` | Independent diff review | `Reviewer`, `CommandReviewer`, `reviewTicket`, `repairTicket` | `.bmad-next/evidence/<mission>/<ticket>-review.json` and review history | `ReviewStarted`, `ReviewCompleted`, `ReviewFailed` | missing reviewer, timeout, invalid JSON, fail, pass, high and critical findings, unclear criterion, missing evidence, repair, fresh review, read-only refusal | IMPLEMENTED |
| `attack.ts` | Read-only requirement attack | `AttackRunner`, `CommandAttacker` | `.bmad-next/evidence/<mission>/<ticket>-attack.json` | `AttackStarted`, `AttackCompleted`, `AttackFailed` | unavailable, timeout, invalid JSON, pass, fail, high, critical, repair, fresh attack, read-only refusal | IMPLEMENTED |
| `types.ts` | State machine | `LOOP_TRANSITIONS` | none | event names | illegal transition tests | IMPLEMENTED |
| `quality.ts` | Evidence and release | `recordEvidence`, `evaluateRelease`, `gateRunState` | evidence inside the mission | `EvidenceCreated`, `GateEvaluated`, `ReleaseCreated` | evidence and release tests | IMPLEMENTED |
| `tickets.ts` | Ticket tree text | `renderTicketTree` | `_bmad-output/<mission>/tickets.toml` after human accept | `TicketCreated`, `StoryCreated` | toml has no status | IMPLEMENTED |
| `runtime.ts` | Coding runtimes | `RuntimeRegistry`, `OpenCodeAdapter`, `OpenHandsAdapter` | execution files in the ticket worktree | `AgentStarted` only after a real run | live OpenCode ticket, missing OpenHands, empty diff, wrong cwd | PARTIAL |
| `loop-runner.ts` | Start, resume, pause, cancel, verify, review, commit | `BmadLoopRunner` | mission loop field | uses existing mission events | transition tests | PARTIAL |
| `providers.ts` | Sandbox, worktree, scanners, browser, research, TEA, retrospective, builder | provider functions | draft artifacts on disk | retrospective emits `RetrospectiveCreated` | draft and sandbox tests | PARTIAL |
| `analysis.ts` | Complexity, drift, scan | detectors | findings on the mission | `FindingCreated` | drift tests | IMPLEMENTED |
| `policy.ts` | Commands and agent writes | `decideCommand`, `authorizeAgent` | none | none | policy tests | IMPLEMENTED |
| `collaboration.ts` | Agents, party, local sandbox | `LocalSandbox`, `closeParty` | sandbox directories | party events | party and sandbox tests | IMPLEMENTED |
| `intent.ts` | `@bmad` routing | `parseIntent`, `handleIntent` | none | whatever the chosen API emits | intent tests | IMPLEMENTED |
| `render.ts` | Mission Control HTML | `renderMissionControl` | none | none | escape and status text | IMPLEMENTED |
| `doctor.ts` | Local tool presence | `doctor` | none | none | node version test | IMPLEMENTED |
| `cli` | Thin commands | `packages/cli/src/main.ts` | calls the plane | calls the plane | golden path command | IMPLEMENTED |
| `vscode` | Extension host UI | `packages/vscode/src/extension.ts` | calls the plane | calls the plane | typecheck only | PARTIAL |

## IMPLEMENTED

- Persistent missions, forge question and answer, requirements from a hardened forge, and reload after a new process.
- Adaptive workflow. A typo uses spec, build, and review. An expense product is critical and greenfield.
- Ticket tree with epic and entry. `tickets.toml` has no status. Plan status changes to `built` only when an artifact contains `BMAD-TICKET-STATUS: built`.
- Fail-closed evidence. Callers do not supply `evidence_id`. Pass requires a real file, exit code 0, type, and source.
- Release gate. Critical expense work stays blocked without evidence and without a named approval. `lastVerifiedBuild` stays null.
- Explicit loop transitions. `draft -> released` and `running -> verified` throw.
- Skill publish only after an evaluation where every case passed.
- Retry budget. A later dispatch is blocked instead of repeating forever.
- Command policy and agent write limits. Sandbox writes cannot escape the sandbox directory.
- Requirement queries: `getRequirement`, `getRequirementCoverage`, `getRequirementEvidence`, `getRequirementDrift`.
- Drift findings for requirements, architecture, tests, UX measurements, and documentation, only when both sides are present.
- Project brain memories cite an event. Search skips invalidated entries.
- CLI and `@bmad` both call `BmadControlPlane`.
- Mission Control renders workflow, artifact, ticket, and release state from the mission. It does not hardcode role checkmarks.

## PARTIAL

- BMAD skill execution. `bmad-spec` runs through a real child process and completes only for the pinned headless contract. Other skills use the same runner and stay incomplete until that command returns a valid result. This repo does not ship the upstream skill markdown.
- OpenHands. The adapter boundary is implemented: `BMAD_RUNTIME=openhands` resolves `OpenHandsAdapter`, which shells `openhands --headless --json -t` in the ticket worktree. The software-agent-sdk is not imported. On this machine `which openhands` is empty, so availability is `NOT CONFIGURED` and no run is fabricated. A stub that exits 0 does not mark the ticket `built` without the protocol line. A stub that exits 1 does not mark it built even when the protocol line is present.
- OpenCode. `OpenCodeAdapter` shells `opencode run --pure --auto --format json` in the ticket worktree only and passes `OPENCODE_CONFIG_CONTENT` with `agent.build.steps` of 6. A probe on 2026-09-26 exited 0 in about 21s and emitted `step_finish` reason `stop` after a write. A timeout without that event stays `TIMEOUT`. Exit 0 without it is a failed run. File changes are recorded and are not completion.
- Review and repair. On 2026-09-26, mission `msn_1_89cd3412` used `opencode` and `nvidia/google/gemma-4-31b-it`. Review attempt 1 failed with `REV-001`. The repair completed in `.bmad-next/worktrees/msn_1_89cd3412/1.1`, tests ran, and review attempt 2 passed against a different diff fingerprint. Attempt 1 remains in `1.1-review-1.json`. The older ticket `msn_1_aeda47ef` still records the earlier timeout and was not given a new budget. `DeterministicReviewer` and the timeout script on `DeterministicTestRuntime` are constructed only by tests.
- Attack. Mission `msn_1_fa242f19` kept attack attempt 1 as `BLOCKED` after a timeout, then recorded attempt 2 as `PASS`. The repair prompt for an attack finding includes the line and the attack evidence path. `DeterministicAttacker` is constructed only by tests. The earlier `ATT-001` on `msn_1_89cd3412` remains a failed attack and was not rewritten.
- Loop runner. Pause, resume, cancel, verify, review, and commit enforce the local state machine. The upstream `bmad-loop` repository is not called.
- Security. `CommandSecurityScanner` runs Semgrep, Trivy (`vuln`, `misconfig`, `secret`), and TruffleHog against the worktree. Version checks stay in `runSecurityTool` and are not the gate. A missing tool is `NOT_CONFIGURED`. Secrets are redacted. `DeterministicSecurity` is test-only. A blocking finding repairs through test, review, attack, and a new scan.
- NFR. Targets come from `declareNfr` or mission text. `CommandNfrProvider` reads `BMAD-NFR-VALUE:` from a real process. `DeterministicNfr` is test-only. `NOT_RUN` is not a pass.
- Architecture verification. `verifyArchitecture` compares declared components, layers, technologies, forbidden dependencies, and directories with the tree. `architecture.md` alone is blocked.
- Traceability. `verifyTraceability` writes `traceability.json`. A requirement with no ticket is a `TRACEABILITY GAP`. `FULLY PROVEN` requires the applicable evidence.
- Release approval. `release approve` and `release reject` append decisions. The latest decision is current. `release verify` does not rewrite `release.json`. `lastVerifiedBuild` is written only when the gate first passes.
- Browser. `PlaywrightBrowser` launches Chromium through the `playwright` package. A pass requires a launched browser, executed steps, passing assertions, and screenshot files. The live scenario `BROWSER-REQ-001` passed for `REQ-001` and stored browser version `153.0.8010.12`. Origins default to localhost. `DeterministicBrowser` is test-only and cannot pass without screenshot files. Selector self-healing and visual diff are not implemented. The older `PlaywrightBrowserProvider` only checks a `playwright` binary on `PATH` and is not the verification path.
- Docker sandbox. The provider exists and does not call Docker.
- Worktrees. `executeTicket` creates `.bmad-next/worktrees/<mission>/<ticket>` and locks it. `dispatch` calls `executeTicket`, so a ticket build cannot write the main checkout. A failed `git worktree remove` keeps the lock. Docker remains `NOT CONFIGURED`.
- Repository intelligence. The workspace directory is listed. `zoekt` and `ast-grep` are reported from `PATH`. Tree-sitter and Aider are not integrated.
- Research. Claims are stored only when the caller supplies source, timestamp, claim, evidence, and confidence. Context7 and Git MCP are not called.
- TEA, retrospective, and builder. They write draft artifacts. They do not complete the upstream skill and they do not publish a candidate.
- VS Code. One Mission Control provider, trees, commands, chat participant, and language-model tools are registered in `activate`. The extension typechecks. The Extension Development Host was not launched in this pass.

## PLANNED

- Persist `BMAD_RUNNER`, `BMAD_REVIEWER_RUNNER`, and `BMAD_ATTACK_RUNNER` in this repository's own config. Live runs set them on a temporary project. `claude` login is expired and `codex` is not logged in.
- Import the OpenHands software-agent-sdk `Conversation` API without leaking its types into the control plane. The current adapter is the CLI only, and that CLI is not installed.
- Call upstream bmad-loop, bmad-builder, and the TEA module rather than local drafts.
- Remote sandbox and a Docker-backed `SandboxProvider` that still hides Docker types.
- Tree-sitter, Zoekt index search, and an Aider-style repository map.
- Context7 and Git MCP research providers.

## NOT IMPLEMENTED

- Qwen, Goose, and SWE-agent runtimes. They are manifest references only.
- Automatic ticket status `done`.
- Treating agent text as a successful build.
- Publishing a skill candidate without evaluation.
- Hardcoded Architect, TEA, or Security checkmarks.

## EXTERNAL ADAPTER

- `OpenCodeAdapter` — local `opencode run`, otherwise `NOT CONFIGURED`.
- `OpenHandsAdapter` — local `openhands` binary, otherwise `NOT CONFIGURED`.
- `PlaywrightBrowser` — Chromium through the `playwright` package. Missing package or binary is `NOT_CONFIGURED`. A scenario pass is separate from installation.
- `CommandSecurityScanner` — Semgrep, Trivy, and TruffleHog scans. A missing binary is `NOT_CONFIGURED`. `runSecurityTool` remains a version probe and is not evidence.
- `CommandNfrProvider` — runs the declared verification command and reads `BMAD-NFR-VALUE:`.
- `DockerSandboxProvider` — availability from `docker` on `PATH`, create returns `NOT CONFIGURED`.
- `LocalSandbox` / `LocalSandboxProvider` — directory isolation, not a security boundary.
- `BmadResearchProvider` — BMAD-native claims only. No external research service is called.
