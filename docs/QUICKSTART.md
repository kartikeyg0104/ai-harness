# Quickstart

Start from a clone of this repository. Node 22 or newer is required.

For the standard evaluation flow, use the Makefile: `export AI_API_KEY=...`, then `make setup` and `make run`. The model is defined in `harness.config.json`. See the Evaluation section of the README. The steps below cover the development CLI.

## Install

```bash
cd ai-harness
npm install
npm test
npm run build
```

`npm test` builds the control plane and runs its compiled tests. `npm run build` also builds the CLI and the VS Code extension. Run `npm test` without `BMAD_RUNTIME` set. Tests that expect a missing runtime will call OpenCode if that variable is exported.

## Configure

Copy `.env.example` to a place your shell can source. Do not commit filled-in values.

```bash
export BMAD_RUNTIME=opencode
export BMAD_MODEL=nvidia/openai/gpt-oss-20b
export BMAD_RUNNER_TIMEOUT=180000
```

`BMAD_MODEL` must be a model your OpenCode login can call. `nvidia/openai/gpt-oss-20b` completed a local file-writing probe. A timeout, zero tokens, or a run with no `step_finish` reason `stop` is a failure.

Optional reviewers and attackers:

```bash
export BMAD_REVIEWER_RUNNER=opencode
export BMAD_REVIEWER_ARGS='["run","--pure","--auto","--format","default","--model","nvidia/openai/gpt-oss-20b","{prompt}"]'
export BMAD_ATTACK_RUNNER=opencode
export BMAD_ATTACKER_ARGS='["run","--pure","--auto","--format","default","--model","nvidia/openai/gpt-oss-20b","{prompt}"]'
```

Leave them unset to keep those gates unconfigured. The demo command fills OpenCode review and attack only inside `.bmad-demo` when those variables are empty and `BMAD_RUNTIME=opencode`.

## Doctor

```bash
node packages/cli/dist/main.js doctor
```

Read the grouped lines. `AVAILABLE` means the binary or package is present. It is not a pass. `CONFIGURED` means an environment value is set and no successful call was made. `NOT_CONFIGURED` includes the setup detail. `FAILED` means a check is blocked.

## Launch

CLI, from this repository:

```bash
node packages/cli/dist/main.js mission create "Build a local payroll health check for employees."
node packages/cli/dist/main.js status
```

VS Code or Cursor: open this folder and launch **Run BMAD Next**. That starts the Extension Development Host with `packages/vscode`. The activity bar, Mission Control, `@bmad`, trees, and commands load from persisted mission files. This environment did not launch that host, so the GUI is **NOT VERIFIED**.

## Demo

```bash
node packages/cli/dist/main.js demo fresh
node packages/cli/dist/main.js demo run
```

`demo fresh` creates `.bmad-demo` and a new mission id. `demo run` uses the real runtime and stops on a failed gate. Approve a release yourself:

```bash
cd .bmad-demo
node ../packages/cli/dist/main.js release approve <mission-id> --by "Your Name"
node ../packages/cli/dist/main.js release
node ../packages/cli/dist/main.js release verify <mission-id>
```

Run those from `.bmad-demo` so the control plane reads the demo mission. Reset with:

```bash
cd ..
node packages/cli/dist/main.js demo reset
```

That deletes `.bmad-demo` only.
