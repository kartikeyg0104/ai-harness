# Examples

These are invocation shapes. They are not recorded releases.

| Shape | How to start | What must stay fail-closed |
| --- | --- | --- |
| Greenfield | `bmad-next mission create "Add a health check for the expense service."` | Forge questions stay open until answered. Harden writes requirements. |
| Quick task | A small idea classifies as simple and selects spec, build, and review. | Attack, browser, security, and NFR are not required for that depth. |
| Critical task | An expense or payment idea classifies as critical. | Release stays blocked without unit, review, attack, browser, security, NFR, architecture, traceability, and a named approval. |
| Failed mission | A runtime timeout leaves the execution `TIMED_OUT`. | `lastVerifiedBuild` stays null. The timeout event remains. |
| Custom plugin | `bmad-next plugin install plugin.json` | The plugin stays disabled until `plugin enable`. Missing permissions are rejected. |

A successful release is `release.json` plus `lastVerifiedBuild` after the gate passes. Do not copy a release file into a mission to simulate that.
