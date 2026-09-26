# BMAD Next

BMAD Next is a Code - OSS control plane for the BMAD method. It turns a software idea into a mission, chooses a workflow from the current BMAD skill catalog, and refuses to call the work verified until real runs leave evidence.

> Think it. Specify it. Design it. Build it. Break it. Prove it. Ship it. Learn from it.

## What this repository runs

- Mission state, forge sessions, requirements, and a ticket tree compatible with current BMAD (`tickets.toml` carries entries; status lives in plan files).
- An adaptive workflow: a typo stays on spec, build, and review. An expense product takes the critical path, including attack, browser, security, NFR, and release gates.
- A fail-closed release gate. Missing evidence is blocked. Passing evidence must point at a file a runner actually wrote.
- Agent contracts, command policy, party rooms, drift checks, and a project brain that only stores memories tied to recorded events.
- A CLI and a VS Code extension (`@bmad`) that read the same state.

Coding runtimes are adapters. `build 1.1` and `@bmad build story 1.1` both call `executeTicket`. That returns `not-configured` and writes no `AgentStarted` event until `BMAD_RUNTIME` or `defaultRuntime` names a runtime that can actually start. `OpenCodeAdapter` shells `opencode run` inside the ticket worktree. `OpenHandsAdapter` shells `openhands --headless --json -t` and stays `NOT CONFIGURED` while that binary is absent. Neither adapter imports a vendor SDK. Upstream `bmad-spec` completes only when the model runner returns the pinned headless JSON and the named files, including `SPEC.md` and `.memlog.md`, exist. A model reply that says complete is not enough. An empty git diff cannot mark a ticket built.

The pinned method is BMAD-METHOD `5e33d3c03ba53187a40ab679d5479cdd4b6ac2fb` on `main`, which is ahead of release `v6.12.0`. See `sources/manifest.json` and `docs/ARCHITECTURE.md`.

## Commands

```bash
npm install
npm test
npm run build
node packages/cli/dist/main.js doctor
node packages/cli/dist/main.js mission create "Build an expense-management SaaS."
node packages/cli/dist/main.js next
node packages/cli/dist/main.js stories
node packages/cli/dist/main.js build 1.1
node packages/cli/dist/main.js release
```

Forge asks only questions that change the implementation. Answer them, then harden:

```bash
node packages/cli/dist/main.js forge answer "employees of one company"
node packages/cli/dist/main.js forge harden
node packages/cli/dist/main.js release
```

The release command prints `blocked` for that mission. Critical work needs test, review, security, browser, attack, and NFR artifacts, an executed architecture comparison, traceability, and a named human approval. A simple change needs test and review artifacts. Missing runs stay blocked. `not-configured` is never stored as pass. A later pass supersedes an earlier failure of the same ticket and requirement. The earlier record stays in history. A different requirement's failure still blocks. `bmad-next release verify <mission-id>` re-evaluates the stored release file without changing it.

Other commands call the same control plane: `mission list|show|resume|pause|cancel`, `spec`, `prd`, `architecture`, `stories`, `build`, `verify`, `review`, `attack`, `security`, `browser`, `evidence list`, `requirements`, `tickets`, `agents`, and `memory`.

## IDE

Open this folder in Code - OSS or Cursor. Run **Run BMAD Next** from the launch configuration. The BMAD activity bar shows Mission Control from the mission file on disk.

Chat:

```text
@bmad what should I do next?
@bmad build story 1.1
@bmad doctor
@bmad release
```

`next` reads the mission loop, completed steps, open forge questions, and blocking findings. `build story 1.1` calls `executeTicket`. `dispatch` is the same isolated path, not a second build that writes the main checkout. With no runtime it returns `not-configured`. A missing ticket is reported. Mission Control shows each ticket's skill, agent, runtime, worktree, status, changed files, protocol, tests, and ticket state from the mission file. The extension registers Mission Control once.

## Configuration

`.bmad-next/config.json` holds autonomy, retry budget, model roles, and the runner. Defaults are assist mode, approval for `git push` and production deploy, and a block on destructive database commands.

Runner configuration is one object:

```json
{ "runner": { "command": "node", "args": ["runner.js"], "timeoutMs": 120000 } }
```

`BMAD_RUNNER` is the executable only. `BMAD_RUNNER_ARGS` is a JSON string array or whitespace-separated arguments, never a shell command. `{prompt}` and `{input}` in that array are replaced by one argument each. `BMAD_MODEL` records the model name and is omitted when it looks like a secret. `BMAD_RUNNER_TIMEOUT` is milliseconds. `BMAD_RUNTIME=opencode` or `openhands` selects the runtime id. A missing command, timeout, non-zero exit, empty reply, invalid JSON, or missing `SPEC.md` leaves the skill incomplete and can emit `SkillFailed`. The process is spawned with an argument array. `sh -c` is refused.

The reviewer is a second runner, not the coding agent. `BMAD_REVIEWER_RUNNER`, `BMAD_REVIEWER_ARGS`, `BMAD_REVIEWER_MODEL`, and `BMAD_REVIEWER_TIMEOUT` follow the same executable-plus-argument-array rule. With no reviewer, review evidence stays blocked and `ReviewStarted` is not emitted. A reviewer pass needs valid JSON, passing criteria, no high or critical finding, and `.bmad-next/evidence/<mission>/<ticket>-review.json`. Exit code 0 is not enough. `bmad-next repair 1.1` and `@bmad repair 1.1` call `repairTicket` after a failing review or attack. The repair prompt carries the finding id, severity, category, file, requirement, acceptance criterion, and the current diff. It reruns tests and a new review in the same worktree. A timeout does not start that review.

The attacker is a third runner. `BMAD_ATTACK_RUNNER`, `BMAD_ATTACKER_ARGS`, `BMAD_ATTACK_MODEL`, and `BMAD_ATTACK_TIMEOUT` do not fall back to the coding runner or the reviewer. An attack pass needs a completed process, valid JSON with status `PASS`, no high or critical finding, an unchanged worktree, and `.bmad-next/evidence/<mission>/<ticket>-attack.json`. An empty findings list without that status is blocked. Missing, timeout, and invalid output stay blocked. High and critical missions require attack. Medium missions require it only when `attackRiskFloor` is `medium`. Low missions do not. A review pass or a test pass is not an attack pass, and an attack pass does not open the release gate.

`bmad-next attack [ticket]`, `bmad-next browser [requirement]`, and `bmad-next verify` call the control plane. `verify` with no argument moves the mission loop. `verify REQ-001` checks that requirement and runs its linked browser scenario when one exists. `verify 1.1` reports the ticket's recorded verification. `@bmad attack`, `@bmad run browser`, and `@bmad verify REQ-001` use the same methods. A repair after an attack includes the finding line and the attack evidence path. The following review records the previous diff fingerprint.

Browser verification uses the `playwright` package and Chromium. Installing the package is not a pass. A scenario belongs to a requirement, and navigation stays on `browserOrigins` (`http://127.0.0.1` and `http://localhost` by default). Evidence, including screenshots, is stored under `.bmad-next/evidence/<mission>/`. A missing browser run blocks a high or critical release. Browser does not run while the latest attack is `FAIL` or `BLOCKED`.

Security runs Semgrep, Trivy, and TruffleHog on the ticket worktree. A version check is not a scan. If one of those tools is missing, security stays `NOT CONFIGURED` and cannot pass. High, critical, and secret findings fail the gate. Secret text is redacted in the evidence file. A security repair reruns tests, review, and attack before the next scan.

NFR targets come from the mission. The measurement is the number printed by the verification command as `BMAD-NFR-VALUE:`. No printed value means the NFR did not run. Architecture verification compares declared components with the repository. A markdown architecture file is not that check. Traceability fails when a requirement has no ticket. Human release approval is `bmad-next release approve <mission-id> --by "Name"` or `@bmad approve release by Name`. `bmad-next release reject` keeps the rejection. `looks good` is not approval.

OpenCode `run` 1.18.25 has no step-limit flag. The coding adapter uses `opencode run --pure --auto --format json` and sets `OPENCODE_CONFIG_CONTENT` so the build agent has a finite `steps` bound. The run is complete only after a `step_finish` event whose reason is `stop`. A timeout with no such event stays `TIMEOUT` even when files changed.

On this machine the live runner is `opencode run` with `{prompt}`. `claude` is installed but its OAuth session is expired. `codex` is installed and not logged in. `openhands` is not on `PATH`.

## Layout

```text
packages/control-plane   mission, evidence, gates
packages/cli             bmad-next
packages/vscode          Code - OSS extension
sources/manifest.json    repository classification
docs/ARCHITECTURE.md     ticket tree, state machine, and release rules
docs/IMPLEMENTATION_STATUS.md   what is running, partial, or absent
docs/USER_GUIDE.md        how to run a mission
docs/DEVELOPER_GUIDE.md   where to change the control plane
docs/PROVIDER_GUIDE.md    runtime and tool availability
docs/SECURITY.md          permissions, redaction, and scan gates
docs/RELEASES.md          effective evidence, approval, and immutability
docs/EXTENDING_BMAD.md    plugins, builder drafts, and modules
```

BMAD, BMad Method, and BMad Core are trademarks of BMad Code, LLC. This project does not vendor upstream BMAD source. See `THIRD_PARTY_NOTICES.md`.
# ai-harness
