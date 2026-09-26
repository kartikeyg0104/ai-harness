# User guide

BMAD Next runs inside a Code - OSS workspace. The control plane is the source of truth. Chat, the CLI, and Mission Control call the same API.

## Start

```bash
bmad-next mission create "Add a health check for the expense service."
bmad-next forge answer <answer>
bmad-next forge harden
bmad-next tickets accept "Your Name"
bmad-next build 1.1
```

`@bmad` accepts the same verbs: forge, brainstorm, party, research, spec, prd, ux, architecture, tea, stories, build, review, attack, browser, security, nfr, verify, release, retrospective, and doctor.

## What a pass means

A tool being installed is not a pass. An exit code of 0 is not a pass. A file change is not runtime completion for OpenCode. OpenCode completes only after `step_finish` reason `stop`. The ticket is built only when a changed file contains `BMAD-TICKET-STATUS: built`.

Missing evidence, a timeout, a missing tool, and an explicit rejection stay visible. They do not become a pass.

## Release

```bash
bmad-next release approve <mission-id> --by "Your Name"
bmad-next release <mission-id>
bmad-next release verify <mission-id>
```

`looks good` is not approval. `release.json` is written once, on the first genuine pass, and is not rewritten. `lastVerifiedBuild` moves only then.

## When something is blocked

Mission Control and `bmad-next release` name the gate, the missing or failed evidence, and the command that produced it. Run that gate again after the cause is fixed. A later pass of the same ticket and requirement supersedes the earlier result. The old record stays.
