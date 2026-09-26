# ADR 0001: BMAD stays the control plane

## Status

Accepted

## Decision

BMAD Next integrates Code - OSS through the extension API and pins BMAD-METHOD at commit `5e33d3c03ba53187a40ab679d5479cdd4b6ac2fb`. External coding systems are runtimes. They are not orchestrators.

The current method uses a ticket tree. BMAD Next writes `tickets.toml` without a status field and keeps plan status separate. It does not revive `sprint-status.yaml`.

Skill completion for spec, PRD, UX, architecture, build, and review requires a configured model runner. The control plane will not mark those skills complete from a local template.

Verification and release read evidence records. A missing run is blocked. A passing record without an artifact file is rejected.

## Consequences

A new mission can be forged, specified as awaiting upstream skills, and held at a blocked release gate with no coding runtime installed. That is the safe default. Configuring `BMAD_RUNNER` and `BMAD_RUNTIME` is what allows skill output and agent dispatch.
