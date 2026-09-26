# Provider guide

Providers report availability separately from a run result.

| State | Meaning |
| --- | --- |
| NOT CONFIGURED | The binary, package, or credential is absent. Nothing started. |
| AVAILABLE | The tool can be started. |
| TIMEOUT | The process was still running at the deadline. |
| PASS / FAIL | A real run produced a valid result. |

## Coding runtimes

| Id | Command | Completion |
| --- | --- | --- |
| opencode | `opencode run --pure --auto --format json` | `step_finish` reason `stop` |
| openhands | `openhands --headless --json -t` | Process exit. The built protocol is still required. |
| qwen | `qwen -p` | Process exit inside the ticket worktree. Missing binary does not start. |
| goose | `goose run --text` | Same boundary. |
| swe-agent | `sweagent run --problem_statement.text` | Same boundary. A missing agent config is a failed run. |
| mini-swe-agent | `mini -t <prompt> -y` | Same boundary. `mini-swe-agent` is the alternate binary. |

The OpenHands SDK is probed with `require.resolve`. If the package is absent, status is `NOT_CONFIGURED`. Execution stays on the CLI adapter. SDK types are not imported into the plane.

## Other providers

Security uses Semgrep, Trivy (`vuln`, `misconfig`, `secret`), and TruffleHog. NFR reads `BMAD-NFR-VALUE:` from the declared command. Browser verification uses Playwright in process. Context7, Git MCP, LiteLLM, Langfuse, Phoenix, ACP, and A2A stay `not-configured` until their environment variables are set. A configured variable is not a successful call and is not mission evidence.

Docker sandbox reports availability from `docker` on `PATH` and does not call the Docker API.
