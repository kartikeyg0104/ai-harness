# Releases

The release gate reads current effective evidence. Historical failures stay in the mission and in attempt files.

A gate is PASS only when its evidence exists, the run passed, and the artifact is on disk. `NOT_RUN`, `NOT_CONFIGURED`, `BLOCKED`, `TIMEOUT`, and `ERROR` are not PASS.

Evidence recorded against an older requirement version is stale after `correctCourse` bumps that requirement. Stale evidence does not satisfy the current gate. It is not deleted.

`SUPERSEDED` applies when a later valid pass covers the same kind, ticket, and requirement. An unrelated failure still blocks.

Human release approval is an appended decision from:

```bash
bmad-next release approve <mission-id> --by "Name"
bmad-next release reject <mission-id> --by "Name"
```

or `@bmad approve release by Name`. Casual text is ignored. Environment variables are ignored.

`release.json` is written on the first pass or waiver and is never replaced. `bmad-next release verify <mission-id>` re-evaluates the stored decision and does not write a new file. `lastVerifiedBuild` records the commit, mission, timestamp, and release evidence path only when that first pass happens.
