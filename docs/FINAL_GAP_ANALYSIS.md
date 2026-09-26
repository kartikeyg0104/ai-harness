# Final gap analysis

Audited against the source tree on 2026-09-26 after a clean `npm test` (107 pass, 0 fail) and `npm run build` (control plane, CLI, and VS Code extension). An earlier run in the same shell failed three tests because `BMAD_RUNTIME=opencode` was still exported; those tests expect a missing runtime. They pass when that variable is unset. Labels in older notes are not treated as proof. A feature is IMPLEMENTED only when the control plane executes it, persists the result, and a test covers the failure path. A missing binary or endpoint is NOT CONFIGURED. Availability is not PASS.

BMAD-METHOD pin: `5e33d3c03ba53187a40ab679d5479cdd4b6ac2fb`. It was not changed.

`bmad-next doctor` on this checkout, with no BMAD runner variables set, reports Node v25.8.1, Python 3.14.7, Git 2.50.1, Docker, uv, OpenCode (`~/.opencode/bin/opencode`), Semgrep, Trivy, and TruffleHog as AVAILABLE. The model runner and default runtime are NOT_CONFIGURED because this checkout does not set them. Playwright is AVAILABLE via the npm package and Chromium; the `playwright` CLI is not required. Doctor prints AVAILABLE, CONFIGURED, NOT_CONFIGURED, or FAILED. It does not print PASS.

## IMPLEMENTED

These paths execute in the control plane and are covered by tests.

| Area | What actually runs | Persistence | Failure behavior |
| --- | --- | --- | --- |
| BMAD core | Missions, requirements, workflow selection, ticket tree, loop transitions | `.bmad-next/missions/<id>/` | Illegal transitions throw |
| Forge / spec / PRD / UX / architecture / stories | Skill steps through `BmadRunner` | Skill output and provenance | Timeout, empty output, and invalid JSON stay incomplete |
| Build | `executeTicket` in an isolated worktree | Execution record and worktree | Missing protocol line, empty diff, and timeout do not mark `built` |
| OpenCode | `opencode run --pure --auto --format json`; completion is `step_finish` reason `stop` | Execution plus evidence | Timeout and exit 0 without `stop` are not completion |
| Review / repair / re-review | Independent reviewer command | `.bmad-next/evidence/` review files | Invalid JSON, timeout, worktree edits, and a missing reviewer stay blocked |
| Attack | Read-only attacker command | Attack evidence files | Timeout, invalid JSON, and worktree edits stay blocked |
| Browser | Playwright Chromium scenarios linked to a requirement | Screenshots and scenario record | Missing binary, assertion failure, closed port, and missing screenshots do not pass |
| Browser self-heal | One retry via `getByRole` when the name matches exactly one control | Step status `healed` | Multiple matches rethrow; assertions are not edited |
| Visual QA | Desktop, tablet, and mobile screenshots plus overflow measurement | `.bmad-next/evidence/visual/` | Launch failure is NOT CONFIGURED |
| Security | Semgrep, Trivy (`vuln`, `misconfig`, `secret`), TruffleHog | Security evidence; secret values redacted | Missing tool, timeout, nonzero exit, and malformed JSON do not pass |
| NFR | Declared targets; values only from `BMAD-NFR-VALUE:` | NFR evidence | Missing measurement is ERROR, not a number |
| Architecture verification | Declared components, layers, technologies, directories, forbidden dependencies versus the tree | Architecture evidence | A markdown file alone is not a pass |
| Traceability | Requirement through evidence links | `traceability.json` | Missing ticket or required link is a gap |
| Proof graph | Mission Control states PASS, FAIL, STALE, NOT_RUN | Rendered from the mission | Stale evidence is excluded from the current gate |
| Approval | `release approve` and `release reject` with approver, time, decision, and reason | Approval list | Casual text and environment variables are not approval |
| Release | Gate reads persisted evidence | `release.json` only on the first real pass; `lastVerifiedBuild` only then | `release verify` does not rewrite history |
| Effective evidence | Later valid pass supersedes the same scope; history remains | Evidence array | A later failure still blocks; a different requirement is independent |
| Requirement invalidation | Evidence older than `requirement.version` is STALE | `requirement_version` on the record | Stale records do not count as verified |
| Plugins | Discover, install, validate, enable, disable, update, rollback, remove | Plugin list with `previous` | Install starts disabled; missing permissions are rejected |
| Schema | `MISSION_SCHEMA_VERSION` 1 and `migrateMission` on load | `schemaVersion` | Old files without the field still load |
| Import / export | JSON mission bundle; secrets redacted on export | Caller-supplied file | Import requires id, requirements, and evidence |
| Checkpoints | `lastVerifiedBuild` after a real release | Checkpoint id, commit, mission | Commit is `git rev-parse HEAD` or null |
| CI workflow | `.github/workflows/ci.yml` installs tools, then test and build | Workflow file | This session did not run it on GitHub |
| CI diagnosis | `diagnoseLog` extracts error lines | Returned to the caller | `push` is NOT_CONFIGURED |
| Mutation / chaos | One `===` to `!==` site, restored after; timeout, dependency, database, network, duplicate, and partial scenarios | Result object | A missing test command is not a caught mutation |
| Doctor | Tool, env, and package probes | None | Missing tools are not-available or not-configured |
| CLI and `@bmad` | Commands call `BmadControlPlane` | Same store as the extension | Unknown commands throw |
| Code index | Path and content hash; textual function and class names | File index | Kind is `textual`, not tree-sitter |
| Project brain | Memories with provenance; invalidated entries are skipped | Mission memory | A memory without an event is rejected |
| Permissions | Command policy and agent write limits | None | Shell review commands and workspace escape are refused |

## PARTIAL

The code path exists and is tested at the boundary. It does not complete the upstream product.

| Area | What exists | What is still missing |
| --- | --- | --- |
| Adaptive workflow | Workflow choice from the mission text | Upstream BMAD skill markdown is not installed in this repo |
| BMAD loop | Local `BmadLoopRunner` state machine | Does not invoke the `bmad-loop` binary. That binary is not on PATH |
| TEA | Local draft: strategy, risk, ATDD, automation, NFR, traceability, gates | `bmad-tea` is not installed. A draft is not an upstream TEA run |
| BMAD builder | Local drafts for agent, workflow, skill, and module; publish requires a passing evaluation | `bmad-builder` is not installed. A draft is not publication |
| OpenHands | CLI adapter `openhands --headless --json -t` and an SDK package probe | Binary and `@openhands/sdk` are absent |
| Qwen, Goose, SWE-agent, mini-swe-agent | `ExternalCliAdapter` with fixed argument arrays | Binaries are not on PATH. No run was executed |
| ACP | JSON-RPC `initialize` against `BMAD_ACP_COMMAND` | The variable is unset. A completed initialize is not mission evidence |
| A2A | GET `{url}/.well-known/agent.json` | `BMAD_A2A_URL` is unset. A card is not a completed task |
| MCP | Config-file detection and a tool-call audit shape | No `.cursor/mcp.json` or `.vscode/mcp.json` in this workspace |
| Agent registry / router / arena | Registry fields, route by capability and risk, arena compares measured results | Arena does not rank from model prose. Extra agents are not installed, so a three-runtime arena cannot run here |
| Code intelligence | File index plus textual symbols; `toolProbe` for ast-grep, zoekt, tree-sitter, aider | Those binaries are not on PATH, so no AST query runs |
| Impact | Import-graph walk from a start file | It is not a tree-sitter impact analysis |
| Context7 / Git MCP | Provenance fields required before a research claim is stored | Neither service is configured. No source means no evidence |
| Observability | Local redacted `.bmad-next/traces.jsonl` | Langfuse and Phoenix are unset. No remote export was accepted |
| LiteLLM | URL check only | `BMAD_LITELLM_URL` is unset. Local runs do not require it |
| Evaluation | Skill publish requires every local eval case to pass; `promptfoo` probe | `promptfoo`, SWE-bench, and BrowserGym are not installed. Caller-supplied counts are not production evidence |
| Self-evolution | Failure can become a candidate memory; publish still requires evaluation | A model-written lesson is not auto-trusted |
| VS Code | Mission Control, trees, chat participant, and language-model tools typecheck | The Extension Development Host was not launched in this pass |
| Docker | Binary is on PATH | The sandbox provider does not start a container |
| Mission replay | Timeline, events, artifacts, and config snapshot | Playback is not a new execution |
| Maintenance | Local diagnosis of dependency, security, debt, docs, and architecture drift | Renovate is not installed. Remote CI repair cannot push |
| Multi-project | The plane takes a project root | This checkout is one example. Paths are not hardcoded to a demo app |
| Cost | Stored when a provider reports it | Unreported cost stays null |

## NOT IMPLEMENTED

- Automatic ticket status `done`.
- Treating agent text, a file write, or exit code 0 as a successful build.
- Publishing a skill, plugin, or lesson without an evaluation where every case passed.
- A release that skips a required gate because the UI, an environment variable, or a model said so.
- Rewriting a historical `release.json`.
- Vendoring BMAD-METHOD, bmad-loop, TEA, builder, OpenHands, or the other upstream repositories into this tree.

## NOT CONFIGURED

Checked on this machine. Configuration would be an environment variable or an installed binary. None of these were marked PASS.

| Dependency | Needed to leave this state |
| --- | --- |
| Checkout model runner | Set the BMAD runner. This checkout's config leaves skill steps awaiting a model |
| OpenHands CLI and SDK | `openhands` on PATH, or install `@openhands/sdk` |
| Qwen | `qwen` on PATH |
| Goose | `goose` on PATH |
| SWE-agent | `sweagent` on PATH |
| mini-swe-agent | `mini` or `mini-swe-agent` on PATH |
| bmad-loop | `bmad-loop` on PATH |
| bmad-tea | `bmad-tea` on PATH |
| bmad-builder | `bmad-builder` on PATH |
| ACP | `BMAD_ACP_COMMAND` pointing at a peer that answers JSON-RPC initialize |
| A2A | `BMAD_A2A_URL` serving `/.well-known/agent.json` |
| MCP | A workspace MCP config, then a permitted tool call |
| tree-sitter, zoekt, ast-grep, aider | Those binaries on PATH |
| Context7 | A configured Context7 source. A query without a source is not evidence |
| Git MCP | A configured Git MCP endpoint |
| Langfuse / Phoenix | Host and key. Local traces stay on disk until a backend accepts them |
| LiteLLM | `BMAD_LITELLM_URL` |
| promptfoo / SWE-bench / BrowserGym | Those runners installed and invoked |
| Upstream BMAD install | `npx bmad-method install`. BMad 6.12 ships `_bmad/scripts/memlog.py` and provides ticketing through the `bmad-create-epics-and-stories` and `bmad-sprint-planning` skills; it ships no `tickets.py`, and doctor no longer expects one |
| CI push | Credentials and a remote. Diagnosis stays local |
| Playwright CLI | Optional. The npm package and Chromium already satisfy browser verification |

## EXTERNAL DEPENDENCIES

| Source | How this repo uses it | License record |
| --- | --- | --- |
| BMAD-METHOD `5e33d3c03ba53187a40ab679d5479cdd4b6ac2fb` | Pin only. Skill markdown is not vendored | `docs/THIRD_PARTY_NOTICES.md` |
| OpenCode 1.18.25 | Local coding runtime when configured | Not vendored |
| Playwright Chromium 153.0.8010.12 | Browser verification | npm dependency |
| Semgrep 1.176.0, Trivy 0.74.0, TruffleHog 3.97.9 | Security scans | Installed tools, not vendored |
| bmad-loop, TEA, builder, OpenHands SDK, ACP, A2A, Context7, Git MCP, Langfuse, LiteLLM, promptfoo | Adapter or probe only | Not distributed from this repo |

## Demo

`bmad-next demo fresh` creates `.bmad-demo` and a new mission id. `bmad-next demo run` uses the control plane. `bmad-next demo reset` deletes only that directory. A unit test covers the path refusal and a symlink refusal. The CLI reset was run after the live demo and removed `.bmad-demo`.

Live demo `msn_1_7201855d` used `BMAD_RUNTIME=opencode` and `BMAD_MODEL=nvidia/openai/gpt-oss-20b`. The build completed. The unit test passed. The first review failed. Repair ran. The fresh review was BLOCKED because the reviewer findings were not a valid list. The demo stopped. Attack, browser, security, NFR, architecture, traceability, and release did not run. `release.json` was not written. `lastVerifiedBuild` stayed null. The workspace was then reset, so those artifacts are not still on disk.

An earlier demo, `msn_1_40995964`, stopped because `npm test` reported zero tests and the review was BLOCKED before the zero-test rule could see the new evidence. `conductReview` now reads the persisted unit evidence before judging, so a zero-test log forces review FAIL. That is covered by a test.

## Live missions

These were not reused as a release.

| Mission | Result |
| --- | --- |
| `msn_1_fa242f19` | Review, repair, re-review, attack, and browser ran. Release stayed fail. `lastVerifiedBuild` stayed null |
| `msn_1_90da5c4d` | OpenCode timed out at 300s with 0 tokens and no `step_finish`. Security scan of the empty worktree passed with 0 findings. NFR measured null. Architecture and traceability failed. Approval was recorded. `release.json` was not written |
| `msn_1_7201855d` | Demo. Unit pass, review FAIL, repair, fresh review BLOCKED. Stopped. No `release.json` |
| Brownfield scan | `bmad-next scan quick` on this repo returned `reconstructedArchitecture: false` |

## Completion estimate

The implemented table has 30 rows. The partial table has 23 rows. 30 of those 53 classified areas execute here. That is the basis. It is not a percentage of the original BMAD specification. The not-configured table is the reason the partial rows stop, and those probes are not counted a second time.

## Can the remaining gaps be implemented now?

No. Each remaining gap needs a binary, package, endpoint, or credential this environment does not have. The adapters, health checks, failure results, and tests for those gaps are already in the control plane. Installing the missing tool is the next step for that one gap. It does not change the others, and it does not turn a missing tool into a pass. The local demo can run without those optional services. On this machine it stopped at a blocked review, which is a model-output failure, not a missing optional service.
