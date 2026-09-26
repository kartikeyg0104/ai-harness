# Architecture

BMAD Next is a control plane that sits on Code - OSS and follows the current BMAD Method. Coding agents, browsers, and scanners are capability providers. They do not decide when a mission is verified.

## Pin

BMAD-METHOD `main` at `5e33d3c03ba53187a40ab679d5479cdd4b6ac2fb` (2026-09-25). The newest GitHub release tag on that date, `v6.12.0`, is behind this commit. This pin is the ticket-tree method:

- Work is an initiative, epics, and entries in `tickets.toml`.
- `status` is not stored on the entry. A plan file carries `planned`, `draft`, `ready-for-dev`, `in-progress`, `blocked`, `in-review`, `built`, `done`, or `dropped`.
- `bmad-build` stops at `built`. It does not mark `done`.
- `bmad-code-review` does not change ticket status.

The sprint words BACKLOG, READY, IN PROGRESS, BLOCKED, REVIEW, DONE, and DEFERRED are a projection of those statuses. VERIFYING is the mission loop, not a ticket status.

## Control plane

`@bmad-next/control-plane` owns missions, forge sessions, requirements, the ticket proposal, evidence, findings, party rooms, and the release gate. State is stored in `.bmad-next/` and survives a process restart. An accepted ticket tree is also written under `_bmad-output/<mission>/` so it matches the upstream file shape.

Upstream skills stay `awaiting-model` until `BMAD_RUNNER` executes them and writes an artifact. The forge session is the exception: it is a user conversation. Hardening records the user's locks and does not render `forge-report.html`.

## Loop

Legal moves are declared in `LOOP_TRANSITIONS`:

```text
draft -> ready -> running -> verifying -> reviewing -> verified -> committed -> released
```

`running` can move to `blocked`, `failed`, `repairing`, or `verifying`. It cannot move to `verified` or `released`. `draft` cannot move to `released`. `failed` can return to `ready` or `cancelled`. `cancelled` and `released` are terminal.

Critical and complex missions also need a passing attack evidence record before `markVerified`. External agents do not set those states.

## Artifacts

Tracked artifacts are forge, spec, brief, prd, ux, architecture, tea, tickets, and stories. Each stored artifact has `not-started`, `in-progress`, `complete`, `failed`, `stale`, or `invalid`. A workflow step that is only selected stays `awaiting-model` or `awaiting-user`.

## Skills

`BmadRunner` resolves a catalog skill, checks input, and asks a `ModelRunner` to run. `CommandModelRunner` spawns one executable with an argument array. It does not pick a vendor. `{prompt}` and `{input}` in `BMAD_RUNNER_ARGS` are replaced as single arguments. The prompt includes the mission input, the pinned contract, the workspace, and the required JSON shape. Headless `bmad-spec` follows `skills/bmad-spec/assets/headless-schemas.md` at the pinned commit: JSON `status: complete`, a `files` array, and an existing `SPEC.md`. Blocked results use `insufficient_intent` or `missing_slug`. The skill states stay distinct: resolved, started, completed, failed, output-missing, output-invalid, timeout, and missing-artifact. A process exit of 0 does not complete the artifact. A failed start emits `SkillFailed` and does not emit `SkillCompleted`. Each run stores provenance: skill, BMAD commit, runner command, redacted arguments, model name when it is not a secret, start, end, exit code, duration, mission, ticket, input path, output paths, and status. The runner does not copy upstream skill prose into this repo.

## Release

The release gate returns `pass`, `concerns`, `fail`, `waived`, or `blocked`. Evidence runs use `NOT_RUN`, `RUNNING`, `PASS`, `FAIL`, `BLOCKED`, `WAIVED`, and `ERROR`. `not-configured` maps to `NOT_RUN`.

A `pass` record needs exit code 0, a runner id other than `mock`, start and finish timestamps, a type, a source, and an artifact path that exists. The plane assigns `evidence_id`, `mission_id`, and `timestamp`.

Critical work requires unit, review, security, browser, attack, and NFR evidence, plus architecture verification, traceability, and a named human release approval. High risk adds security and browser to unit and review. Simple work requires unit and review. `lastVerifiedBuild` advances only when the gate is `pass` or `waived`, and only the first time. That write records the commit, mission, timestamp, and `release.json` path.

The current gate uses effective evidence. A later pass of the same kind, ticket, and requirement supersedes earlier attempts for that scope. The old records stay on the mission and in attempt files. A later failure, or a failure of a different requirement, stays unresolved and still blocks. Historical rows are `SUPERSEDED`. They are not deleted. `bmad-next release verify <mission-id>` re-reads the stored `release.json` and the current gate without rewriting the file.

Approval is an appended `Approval` with category `release`. The latest decision is the current one. `approved` and `rejected` both remain. `bmad-next release approve <mission-id> --by "Name"` and `bmad-next release reject <mission-id> --by "Name"` are the CLI actions. `@bmad approve release by Name` is the chat action. Text such as `looks good` is not approval. An environment variable is not approval. Mission Control shows the status and the command. The webview does not run scripts, so a click is not an approval.

## Runtimes

`executeTicket` is the only ticket build. `dispatch` calls it. The sequence is ticket validation, dependency validation, worktree claim, agent resolution, runtime resolution, `runtime.begin` in that worktree, `git status --short`, the built protocol, verification, and evidence. With no runtime, or with OpenHands absent from `PATH`, the result is `not-configured` and `AgentStarted` is not emitted.

When a runtime can start, the ticket gets a worktree at `.bmad-next/worktrees/<mission>/<ticket>`. A second live agent cannot claim the same ticket. A lock whose process is gone can be recovered. `git worktree remove` failure leaves the lock in place. The runtime's working directory is that worktree, not the main checkout. The persisted execution records ticket, skill, runner command, runner, agent, runtime, worktree, start, end, status, attempt, changed files, artifact, and evidence ids. The ticket becomes `built` only when the runtime has a completion signal, `git status --short` shows a change, and a changed file contains `BMAD-TICKET-STATUS: built`. The completion signal is process exit 0 after `step_finish` reason `stop`, or that same terminal event if the process is reaped after it. Exit 0 without the terminal event is not completion. A timeout without it is not completion. Exit 0 with no artifact is not built. Exit 0 with an artifact and no protocol is not built. Exit 1 with the protocol is not built. An empty diff is not built. After a real built artifact, `npm test` runs only if the worktree has a test script. A passing unit test does not make the review pass. Neither step marks the release gate passed.

## Review

`Reviewer` is separate from the coding runtime. `CommandReviewer` reuses `CommandModelRunner`. `BMAD_REVIEWER_RUNNER` is the executable only. `BMAD_REVIEWER_ARGS` is an argument array and may contain one `{prompt}` element. `BMAD_REVIEWER_MODEL` and `BMAD_REVIEWER_TIMEOUT` do not change `BMAD_RUNNER`. A shell `-c` argument is refused. The reviewer process cwd is `.bmad-next/missions/<mission>/review-cwd`, not the ticket worktree. The prompt is `review-v1` and contains the ticket, acceptance criteria, architecture, redacted diff, and the recorded test result. It does not contain the coding agent's private reasoning.

A review pass requires a completed process with exit code 0, valid JSON, every required criterion `PASS`, a test assessment of `PASS`, no high or critical finding, an unchanged worktree fingerprint, and `.bmad-next/evidence/<mission>/<ticket>-review.json` on disk. `FAIL` or `UNCLEAR` on a required criterion cannot be an overall pass. Invalid JSON, a timeout, a missing reviewer, a missing evidence file, or a reviewer that edits the worktree stays `BLOCKED`. A high or critical finding fails the review, blocks the ticket, and can become a repair task. `repairTicket` uses the same retry budget, the same worktree, a new test run, and a new review. The previous pass is not reused. Review history stores attempt, model, duration, findings, and status. Model cost stays null until a run reports one. False-positive notes increment a counter and leave the finding in place.

`ReviewStarted` is emitted only when a reviewer is available. A parsed pass or fail emits `ReviewCompleted`. A timeout or invalid result emits `ReviewFailed`. Each review stores a diff fingerprint. A later review of the same diff records `duplicateDiff` and still runs. A failed review or attack is `failed` on the proof chain, which interrupts the path to release. Mission Control reads persisted review, repair, attack, retry budget, and release state.

## Attack

`AttackRunner.attack` runs only after a review pass. `CommandAttacker` reuses `CommandModelRunner`. The process cwd is `.bmad-next/missions/<mission>/attack-cwd`. The prompt is `attack-v1` and contains the requirement, architecture, risk, changed files, diff, recorded tests, and review findings. It tells the attacker not to write, commit, push, or deploy. A worktree change blocks the result.

Attack pass requires a real completed process, exit code 0, JSON `status` of `PASS`, a findings array, no high or critical finding, and the evidence file. Invalid JSON, a timeout, a missing status, or a missing attacker is `BLOCKED` or `NOT_CONFIGURED`, never `PASS`. A blocking finding uses `ATTACK_CORRECTNESS`, `ATTACK_SECURITY`, `ATTACK_EDGE_CASE`, `ATTACK_RECOVERY`, or `ATTACK_FAILURE`, and becomes a repair task. The next loop is test, then a new review, then a new attack. `AttackStarted` is emitted only when an attacker is available. A parsed pass or fail emits `AttackCompleted`. A timeout or invalid result emits `AttackFailed`.

High and critical work require attack evidence. Critical work still also requires security, browser, NFR, architecture, traceability, and named human approval. Medium work requires attack only when the mission `attackRiskFloor` is `medium`. The default floor is `high`.

An attack `FAIL` becomes a repair in the same worktree. The repair prompt includes the finding id, severity, category, message, file, line, requirement, acceptance criterion, current diff, and the attack evidence path. After a completed repair the plane runs tests, writes new test evidence, then a fresh review, then a fresh attack. The new review stores `priorDiffFingerprint` from the previous review. Attempt files such as `<ticket>-attack-1.json` are not overwritten. A timeout is not a pass and does not start the browser. Browser verification runs only when the latest attack is not `FAIL` or `BLOCKED`, and only when a required attack has already passed.

## Browser

`PlaywrightBrowser` is the production browser provider. It calls the Playwright package and launches Chromium. Package installation, a browser binary, a launched browser, an executed scenario, and a passing scenario are separate states. `bmad-next browser` and `@bmad run browser` call `runBrowser`. A scenario must name a requirement in the mission. `scenarioFromCriterion` builds steps from an acceptance criterion only when that text yields a real assertion.

Steps are `navigate`, `click`, `fill`, `select`, `wait`, and `screenshot`. Assertions are `visible`, `text`, `url`, `attribute`, and `count`. Navigation is allowed only for configured origins, by default `http://127.0.0.1` and `http://localhost`. An empty origin list fails closed. `file:` URLs and other hosts are refused, and `observe` autonomy blocks the command. Evidence is `.bmad-next/evidence/<mission>/<scenario>.json` plus screenshots. A pass needs the browser to have launched, the scenario to have executed, every assertion to pass, and at least one screenshot file on disk. A timeout stays `TIMEOUT` and does not become a pass. Events are `BrowserStarted`, `BrowserStepStarted`, `BrowserStepCompleted`, `BrowserCompleted`, and `BrowserFailed`. `BrowserStarted` is not emitted when the scenario is invalid, the origin is refused, or Playwright is not available.

`deterministic-test-browser` is constructed only by tests. A pass from that provider without screenshot files is rejected. Selector self-healing and visual diff are not implemented. The stored visual record is the screenshot, viewport, URL, scenario, and timestamp.

## Security

`CommandSecurityScanner` is the production security provider. It runs Semgrep, Trivy, and TruffleHog against the ticket worktree. `semgrep --version`, `trivy --version`, and `trufflehog --version` are not scans and cannot pass. Semgrep uses `packages/control-plane/rules/bmad-semgrep.yml` and `--no-git-ignore` so a worktree under an ignored directory is still scanned. Trivy runs filesystem `vuln`, `misconfig`, and `secret` together, and the evidence lists only the scanner modes that returned JSON. TruffleHog runs `filesystem` with `--json`. Secret values are redacted before they are written. A high, critical, or secret finding fails the scan.

A pass needs every required tool to execute, a valid result, no blocking finding, and `.bmad-next/evidence/<mission>/<ticket>-security-<attempt>.json`. A missing binary is `NOT_CONFIGURED` for that tool and the overall status stays `NOT_CONFIGURED`. Timeout, malformed output, and a nonzero exit without a parsed finding are not passes. Events `SecurityStarted`, `SecurityToolStarted`, `SecurityToolCompleted`, and `SecurityCompleted` or `SecurityFailed` are emitted only when a tool actually runs.

A blocking security finding can be repaired. The repair runs tests, a fresh review, and a fresh attack, then scans again. The repair does not close unless that new scan passes. `deterministic-test-security` is constructed only by tests.

## NFR

An `NfrRequirement` carries the metric, operator, target, unit, and verification method. The target comes from `declareNfr` or from text in the mission, PRD, or architecture. The runner does not invent a threshold. `CommandNfrProvider` runs the verification command and reads `BMAD-NFR-VALUE:` from its stdout. A missing marker, a missing command, or a missing binary is not a measurement and is not a pass. Evidence is `.bmad-next/evidence/<mission>/<ticket>-nfr-<attempt>.json`. `deterministic-test-nfr` is constructed only by tests.

## Architecture verification

A declared architecture decision is not verification. `verifyArchitecture` walks the repository and compares declared components, layers, technologies, forbidden dependencies, and directory ownership with what is on disk. The artifact is `.bmad-next/evidence/<mission>/architecture-verification.json`. A pass needs a declaration, an executed comparison, no blocking drift, and that file. `architecture.md` by itself stays blocked.

## Traceability

`verifyTraceability` links each requirement to its acceptance criteria, tickets, implementation, and the current evidence for tests, review, attack, browser, security, and NFR when that kind applies. A requirement with no ticket is a `TRACEABILITY GAP` and fails the gate. Coverage labels are `IMPLEMENTED`, `TESTED`, `REVIEWED`, `ATTACKED`, `BROWSER VERIFIED`, `SECURITY VERIFIED`, `NFR VERIFIED`, and `FULLY PROVEN`. `FULLY PROVEN` requires every applicable kind to have current passing evidence. The artifact is `.bmad-next/evidence/<mission>/traceability.json`. Counts are lengths of those links, not estimated percentages.

## Coding runtime completion

`AgentRuntime` exposes capabilities, start, resume, and cancel. The production registry contains `unconfigured`, `openhands`, and `opencode`. Installed OpenCode 1.18.25 `run` exits when the session is idle. Its help text has no step cap. `--auto` approves permissions that are not explicitly denied, including the build agent's `doom_loop` ask, so a repair can keep writing and never go idle. The adapter therefore passes `--format json` and `OPENCODE_CONFIG_CONTENT` with `agent.build.steps` set to 6. That bound is the documented agent config, not a guessed flag. Completion is a JSON `step_finish` whose `reason` is `stop`. `tool-calls` is not completion. A timeout without `stop` is `TIMEOUT` even if `git status` shows edits. Exit code 0 without `stop` is `FAILED`. If `stop` is present and the process is still up, the adapter records completion from that terminal event and says the process was reaped. The ticket is still not built without a non-empty diff and `BMAD-TICKET-STATUS: built`. Observable phases are `STARTING`, `RUNNING`, `EDITING` when a write tool event is seen, `VERIFYING` when tests start, then `COMPLETED`, `FAILED`, or `TIMED_OUT`.

`OpenHandsAdapter` runs `openhands --headless --json -t <task>` and maps stdout, stderr, exit code, duration, and changed files back into BMAD types. The software-agent-sdk `Conversation` API is not imported. On this machine `openhands` is not on `PATH`, so that adapter is `NOT CONFIGURED` and no OpenHands run is invented.

`deterministic-test-provider` exists for tests. The production constructor does not register it. A completed test run writes a file in the execution directory and does not set ticket status to `built` unless that file contains `BMAD-TICKET-STATUS: built`.

## Sandbox and worktrees

`SandboxProvider` has local and docker implementations. Local execution is a workspace directory with timeout enforcement and a network deny check for `curl`, `wget`, `nc`, and `ssh`. It reports `securityBoundary: false` and is not a container. The docker provider reports `NOT CONFIGURED` and does not call Docker APIs. `WorktreeManager` uses git worktree commands and refuses a second agent on a ticket it already owns.

## IDE

The VS Code extension contributes the BMAD activity bar, Mission Control webview, tree views, `@bmad` chat, language-model tools, diagnostics, and a BMAD source-control input. The extension reads the same control plane as the CLI.
