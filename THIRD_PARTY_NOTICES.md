# Third-party notices

BMAD Next's original code is under the MIT license in `LICENSE`.

## BMAD Method

Repository: https://github.com/bmad-code-org/BMAD-METHOD

Pinned commit: `5e33d3c03ba53187a40ab679d5479cdd4b6ac2fb`

License file blob: `557212d307dbed13aa72e8f158c9e4a626a3243a`

This repository does not vendor BMAD-METHOD. The control plane catalogs its skill ids and writes a ticket tree that follows the upstream rule that status lives in plan files.

The upstream license is the MIT License, copyright (c) 2025 BMad Code, LLC. `TRADEMARK.md` in that repository states that BMAD, BMad Method, and BMad Core are trademarks of BMad Code, LLC. Use of those names here names the method this control plane follows and does not grant other trademark rights.

## Other sources

`sources/manifest.json` lists every repository considered for this system. None of those trees are copied into this repository. Their licenses are not reproduced here because their source is not distributed.

OpenHands, Playwright, Semgrep, Trivy, and TruffleHog are optional local programs. This repository does not vendor them. A missing program is `NOT CONFIGURED`. A version check is not a scan and is not evidence. A completed Semgrep, Trivy, or TruffleHog scan, or a completed Playwright scenario, is evidence only for the command that actually ran. bmad-loop, bmad-builder, and the TEA module are not executed from their repositories. A future vendor step must record the exact commit, license, copyright, and modifications before any of that source is added.
