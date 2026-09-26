# Developer guide

The control plane lives in `packages/control-plane`. The CLI and the VS Code extension are clients. Do not put mission rules in either client.

## Build and test

```bash
npm test
npm run build
```

Tests compile the control plane and run `node --test` on the JavaScript output. Git, Semgrep, Trivy, TruffleHog, and Playwright need to run outside a sandbox that blocks `.git` or tool caches.

## Adding a behavior

1. Put the rule in the control plane.
2. Persist it on the mission or under `.bmad-next`.
3. Emit an event only when the action happened.
4. Surface it from the CLI or Mission Control by calling the plane.
5. Test the failure path. A missing binary, a timeout, and invalid output must not pass.

`DeterministicTestRuntime`, `DeterministicReviewer`, `DeterministicAttacker`, `DeterministicBrowser`, `DeterministicSecurity`, and `DeterministicNfr` are test-only. The production registry does not construct them.

## State

Missions are JSON under `.bmad-next/missions/<id>`. Events are append-only `events.jsonl`. Local traces are `.bmad-next/traces.jsonl` with secret redaction. A future database can sit behind the same domain types. Do not bypass `saveMission`.
