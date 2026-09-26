# User test plan

Run from the repository root. Replace `<mission-id>` with the id printed by `demo fresh` or `mission create`.

## 1. Start BMAD Next

ACTION: `npm install && npm test && npm run build`

EXPECTED RESULT: The test process prints a pass count and a fail count of 0. The build finishes for the control plane, CLI, and VS Code extension.

WHERE TO VERIFY: The terminal exit code is 0.

## 2. Run doctor

ACTION: `node packages/cli/dist/main.js doctor`

EXPECTED RESULT: Grouped lines for BMAD, model, coding runtime, browser, security, NFR, architecture, and observability. Each line is AVAILABLE, CONFIGURED, NOT_CONFIGURED, or FAILED. None of them say PASS.

WHERE TO VERIFY: Terminal output. A missing tool includes a setup sentence.

## 3. Create a mission

ACTION: `export BMAD_RUNTIME=opencode` and `export BMAD_MODEL=<a model your OpenCode login can call>`, then `node packages/cli/dist/main.js demo fresh`

EXPECTED RESULT: A new mission id under `.bmad-demo`. The report lists that id and phase. A second `demo fresh` creates a different id.

WHERE TO VERIFY: `.bmad-demo/.bmad-next/missions/<mission-id>/mission.json`

## 4. Try @bmad forge

ACTION: Open the folder in VS Code and launch **Run BMAD Next**. In chat, send `@bmad what should I do next?`

EXPECTED RESULT: The extension host starts. Chat answers from the control plane. GUI activation is NOT VERIFIED in the environment that produced this plan, so confirm it on your machine.

WHERE TO VERIFY: Extension Development Host, BMAD activity bar.

## 5. Generate spec

ACTION: From `.bmad-demo`, after forge is hardened by `demo run` or by `forge answer` and `forge harden`, run `node ../packages/cli/dist/main.js spec`

EXPECTED RESULT: The spec step stays incomplete until a model runner returns the pinned headless JSON and `SPEC.md` exists. A prose reply is not completion.

WHERE TO VERIFY: Mission artifacts and `_bmad-output`.

## 6. Generate stories

ACTION: `node packages/cli/dist/main.js stories` from the demo workspace, or let `demo run` call it.

EXPECTED RESULT: Ticket `1.1` exists. `tickets.toml` has entries and no status field.

WHERE TO VERIFY: `node packages/cli/dist/main.js tickets`

## 7. Build a tiny ticket

ACTION: `node packages/cli/dist/main.js demo run` or `node packages/cli/dist/main.js run <mission-id>` from `.bmad-demo`

EXPECTED RESULT: OpenCode runs in the ticket worktree. Completion requires `step_finish` reason `stop`, a changed file, and `// BMAD-TICKET-STATUS: built`. Timeout is a failure.

WHERE TO VERIFY: The build line in the terminal and the worktree under `.bmad-demo/.bmad-next/worktrees/`.

## 8. Inspect worktree

ACTION: Open the worktree path printed by `status`.

EXPECTED RESULT: Source files the runtime wrote. The harness repository is unchanged.

WHERE TO VERIFY: `node packages/cli/dist/main.js status <mission-id>` from `.bmad-demo`.

## 9. Inspect evidence

ACTION: `node packages/cli/dist/main.js evidence list` from `.bmad-demo`

EXPECTED RESULT: Records include kind, command, timestamp, result, and artifact. Secret text is redacted.

WHERE TO VERIFY: `.bmad-demo/.bmad-next/evidence/<mission-id>/` and Mission Control evidence details.

## 10. Trigger a review

ACTION: Let `demo run` review, or `node packages/cli/dist/main.js review 1.1`

EXPECTED RESULT: A review JSON file. PASS requires valid JSON, passing criteria, and no high or critical finding. Exit code 0 alone is not a pass.

WHERE TO VERIFY: `status` review line and the review artifact.

## 11. Trigger an attack

ACTION: After review PASS, `node packages/cli/dist/main.js attack 1.1`

EXPECTED RESULT: Attack JSON with status PASS or a real failure. Attack does not start from a failing review.

WHERE TO VERIFY: `status` attack line.

## 12. Run browser verification

ACTION: After attack PASS, `node packages/cli/dist/main.js browser REQ-001` while the health server is listening on 127.0.0.1:18765.

EXPECTED RESULT: PASS only when Playwright completes the scenario and the page shows `healthy`. A missing browser is NOT_CONFIGURED.

WHERE TO VERIFY: Browser evidence artifact.

## 13. Run security

ACTION: `node packages/cli/dist/main.js security 1.1`

EXPECTED RESULT: Semgrep, Trivy, and TruffleHog each scan the worktree. A missing tool keeps the gate from passing.

WHERE TO VERIFY: Security evidence file. Findings do not contain raw secrets.

## 14. Run NFR

ACTION: `node packages/cli/dist/main.js nfr 1.1` while the server is up.

EXPECTED RESULT: The measurement is the number after `BMAD-NFR-VALUE:`. No printed value is not a pass.

WHERE TO VERIFY: NFR evidence file.

## 15. Inspect architecture

ACTION: `node packages/cli/dist/main.js` is not required; `demo run` calls architecture verification. Or inspect the architecture evidence file.

EXPECTED RESULT: PASS only when `src/health.js`, the `src` directory, and Node are present in the worktree, and `left-pad` is absent.

WHERE TO VERIFY: `architecture-verification.json`

## 16. Inspect traceability

ACTION: Read the traceability evidence after `demo run`.

EXPECTED RESULT: FAIL while a required link is missing. PASS only when requirement, ticket, code, tests, and evidence line up.

WHERE TO VERIFY: `traceability.json` and `node packages/cli/dist/main.js verify <mission-id>`

## 17. Approve release

ACTION: `node packages/cli/dist/main.js release approve <mission-id> --by "Your Name"` from `.bmad-demo`

EXPECTED RESULT: An approval record. The gate stays blocked until the other criteria pass. Casual text is not approval.

WHERE TO VERIFY: Mission approvals and Mission Control.

## 18. Run release verify

ACTION: `node packages/cli/dist/main.js release` then `node packages/cli/dist/main.js release verify <mission-id>`

EXPECTED RESULT: `release.json` appears only when the gate state is pass or waived. `release verify` repeats that decision and does not rewrite the file. If a gate failed, the state stays blocked and `lastVerifiedBuild` stays null.

WHERE TO VERIFY: `.bmad-demo/.bmad-next/evidence/<mission-id>/release.json` and `status`.

## 19. Inspect Project Brain

ACTION: `node packages/cli/dist/main.js memory` from `.bmad-demo`

EXPECTED RESULT: Only memories tied to recorded events. A model paragraph is not stored as a lesson by itself.

WHERE TO VERIFY: The memory command output.

## 20. Export mission

ACTION: `node packages/cli/dist/main.js export <mission-id>`

EXPECTED RESULT: A package with mission, requirements, tickets, artifacts, events, evidence, and release state. No credentials.

WHERE TO VERIFY: The exported JSON. Search it for token patterns before sharing it.

## 21. Import mission

ACTION: `node packages/cli/dist/main.js import <file>` in a copy of the workspace, or in the same demo workspace.

EXPECTED RESULT: The mission loads. Other mission directories remain.

WHERE TO VERIFY: `node packages/cli/dist/main.js mission list`

## 22. Reset demo

ACTION: From the repository root, `node packages/cli/dist/main.js demo reset`

EXPECTED RESULT: `.bmad-demo` is gone. Missions under the repository `.bmad-next` are still there.

WHERE TO VERIFY: The filesystem.
