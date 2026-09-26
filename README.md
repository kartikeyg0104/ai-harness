# BMAD Next

BMAD Next is a Code - OSS control plane for the BMAD method. It turns a software idea into a mission, chooses a workflow from the current BMAD skill catalog, and refuses to call the work verified until real runs leave evidence.

> Think it. Specify it. Design it. Build it. Break it. Prove it. Ship it. Learn from it.

## Evaluation (AI Harness Hackathon 2026)

Requirements: Node.js 22+, npm, git, make, and network access.

```bash
git clone https://github.com/kartikeyg0104/ai-harness.git
cd ai-harness
export AI_API_KEY="<PROVIDED_API_KEY>"
make setup   # npm ci (includes the pinned OpenCode runtime), build, optional Chromium
make run     # launch the harness session
make test    # full unit and integration suite, no model calls
make clean   # remove build output and harness workspaces
```

`make run` opens an interactive terminal session. At the `issue>` prompt, give it one of:

| Input | What the harness does |
| --- | --- |
| `https://github.com/<owner>/<repo>/issues/<n>` or `<owner>/<repo>#<n>` | Fetches the issue and its comments, clones the repository into `workspace/`, and resolves the issue in an isolated git worktree |
| `@path/to/issue.md` | Reads the issue text from a file |
| Plain text, ended by a line containing only `.` | Treats the text as the issue, in a new repository or the one set with `repo <url or path>` |

For each issue the harness creates a BMAD mission. It plans (spec, PRD, architecture), proposes tickets, builds each ticket with the coding agent, runs the tests, has a separate read-only reviewer and attacker inspect the change, repairs it when those gates fail, and evaluates the release gate. It stops when a person must decide something. In an interactive session it asks the question. With `make run AUTO=1` or piped input it takes the defaults. Results go to `workspace/results/<mission-id>/`: one `ticket-<ref>.patch` per ticket plus `summary.json`. The patched worktree stays under `workspace/<repo>/.bmad-next/worktrees/`.

Non-interactive options: `make run ISSUE=https://github.com/o/r/issues/1` starts with that issue. `echo "issue text" | make run` runs once and exits. `make run REPO=<url|path>` applies plain-text issues to that repository.

**Model and credential.** The model is defined in [`harness.config.json`](harness.config.json): provider `nvidia`, model `openai/gpt-oss-20b`, temperature `0`, and text-only. `AI_PROVIDER`, `AI_MODEL`, and `AI_BASE_URL` override those fields without editing any file. Set `AI_PROVIDER=openai-compatible` with `AI_BASE_URL` to use any OpenAI-compatible endpoint. The credential is read only from `AI_API_KEY`. The harness writes `.harness/opencode.json` (gitignored), which refers to the key as `{env:AI_API_KEY}`, so the value never reaches disk, a log, or a command line. The coding agent, reviewer, and attacker all use that one model. `GITHUB_TOKEN` is optional; it raises GitHub's anonymous API rate limit.

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
docs/FINAL_GAP_ANALYSIS.md      audit of what actually executes
docs/USER_GUIDE.md        how to run a mission
docs/DEVELOPER_GUIDE.md   where to change the control plane
docs/PROVIDER_GUIDE.md    runtime and tool availability
docs/SECURITY.md          permissions, redaction, and scan gates
docs/RELEASES.md          effective evidence, approval, and immutability
docs/EXTENDING_BMAD.md    plugins, builder drafts, and modules
```

## Demo

`bmad-next demo fresh` creates `.bmad-demo`, a separate git workspace. It does not touch missions in this repository. `bmad-next demo run` answers the forge, builds ticket 1.1 with the configured runtime, and stops when a gate fails. It does not invent a pass and it does not approve the release for you. `bmad-next demo reset` deletes only `.bmad-demo`.

```bash
export BMAD_RUNTIME=opencode
export BMAD_MODEL=nvidia/openai/gpt-oss-20b
node packages/cli/dist/main.js demo fresh
node packages/cli/dist/main.js demo run
```

`scripts/demo.sh` runs the build, doctor, fresh, and run. A failed gate exits non-zero and leaves the demo mission on disk.

## Quickstart

See `docs/QUICKSTART.md`. The manual checklist is `docs/USER_TEST_PLAN.md`. Command-level notes are in `docs/TESTING_BMAD_NEXT.md`.

## Troubleshooting

A model timeout, a missing runtime, a missing browser, or a missing security tool stays `NOT_CONFIGURED`, `TIMEOUT`, or `FAILED`. Doctor prints the missing command. Availability is not a verification pass. Docker, OpenHands, Qwen, Goose, SWE-agent, ACP, A2A, MCP, and the observability hosts are optional. The local path is BMAD plus OpenCode, Playwright, Semgrep, Trivy, and TruffleHog.

## Known limitations

Upstream BMAD Loop, BMAD Builder, and TEA execution are not vendored. Remote marketplace, tree-sitter, Zoekt, Aider, Context7, Git MCP, LiteLLM, Langfuse, Phoenix, Promptfoo, SWE-bench, BrowserGym, and Renovate stay unconfigured when their binaries or endpoints are absent. The VS Code Extension Development Host was not launched in this environment, so the activity bar is not GUI-verified. `release.json` is written only when every applicable gate passes, including a named human approval.

## License

MIT. See `LICENSE` if present, and `THIRD_PARTY_NOTICES.md`.

BMAD, BMad Method, and BMad Core are trademarks of BMad Code, LLC. This project does not vendor upstream BMAD source.
