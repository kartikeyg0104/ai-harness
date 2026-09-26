# Testing BMAD Next

Run these from the repository root after `npm install`.

## Product suite

```bash
npm test
npm run build
```

`npm test` is the control-plane suite. Unset `BMAD_RUNTIME` first. A configured runtime makes the "not configured" tests call the real binary. `bmad-next test` with no ticket runs that same `npm test`. `bmad-next test 1.1` reports the ticket's recorded verification and does not run the product suite.

## Doctor and configuration

```bash
node packages/cli/dist/main.js doctor
```

Required variables are listed in `.env.example`: `BMAD_RUNTIME`, `BMAD_MODEL`, `BMAD_RUNNER`, `BMAD_REVIEWER_RUNNER`, and `BMAD_ATTACK_RUNNER`. Optional provider variables are in the same file. Unset means not configured.

## Demo

```bash
export BMAD_RUNTIME=opencode
export BMAD_MODEL=nvidia/openai/gpt-oss-20b
node packages/cli/dist/main.js demo fresh
node packages/cli/dist/main.js demo run
```

Or `bash scripts/demo.sh`. The script builds, runs doctor, creates a fresh demo mission, and runs it. A failed stage exits non-zero. Evidence stays in `.bmad-demo/.bmad-next`.

## Mission commands

Inside a project that already has a mission:

```bash
node packages/cli/dist/main.js status <mission-id>
node packages/cli/dist/main.js run <mission-id>
node packages/cli/dist/main.js verify <mission-id>
node packages/cli/dist/main.js release verify <mission-id>
```

`verify <mission-id>` summarizes effective evidence and does not write `release.json`. `release` writes `release.json` only when the gate passes. `run` builds the next ticket that is not built, or prints the next recommendation when every ticket is built.

## VS Code

Launch configuration **Run BMAD Next** is in `.vscode/launch.json`. It builds, then opens an Extension Development Host. GUI activation was **NOT VERIFIED** here. The extension typecheck is part of `npm run build`.

## Export and import

```bash
node packages/cli/dist/main.js export <mission-id>
node packages/cli/dist/main.js import <file>
```

Export redacts secrets. Import rejects a package that has no mission id, requirements, or evidence, and it does not delete other missions.

## Reset

```bash
node packages/cli/dist/main.js demo reset
```

## Troubleshooting

| Failure | Cause | What to do |
| --- | --- | --- |
| Model timeout | The runtime produced no `step_finish` reason `stop` before `BMAD_RUNNER_TIMEOUT`. | Raise the timeout or choose a model that finishes tool calls. Do not treat the partial files as success. |
| Runtime missing | `BMAD_RUNTIME` is unset or the binary is not on `PATH`. | Install OpenCode and set `BMAD_RUNTIME=opencode`. |
| Browser missing | Playwright or Chromium is absent. | Install the `playwright` package and Chromium. Doctor stays `NOT_CONFIGURED` until then. |
| Security tool missing | Semgrep, Trivy, or TruffleHog is absent. | Install the missing binary. A version check is not a scan, and a missing tool cannot pass. |
| Docker unavailable | `docker` is not on `PATH`. | Optional. Local OpenCode does not need it. |
| BMAD module unavailable | `_bmad/scripts/memlog.py` is not installed. | `npx skills add bmad-code-org/BMAD-METHOD --skill bmad`. The control plane still runs without it. |

Demo failures print `STOP`, the mission id, the failing gate, the evidence path, and a suggested next command. The mission is kept.
