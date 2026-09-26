# Security

Autonomous runs are privileged. Command policy rejects `sh -c` and destructive commands. Coding runtimes may write only inside the ticket worktree. Plugins must declare read, write, execute, network, credentials, and filesystem permissions before they can be installed. A plugin is disabled until it is explicitly enabled.

Secrets are redacted in review prompts, security evidence, and `.bmad-next/traces.jsonl`. Do not put API keys in mission text, events, or evidence.

Security PASS requires a real scan, a valid result, Semgrep, Trivy, and TruffleHog all executed, no blocking finding, and an evidence file. A missing tool is `NOT_CONFIGURED`. A version check is not a scan. Findings of high or critical severity, and any secret finding, fail the gate and can open a repair that runs tests, review, attack, and a new scan.

Local directory isolation is not a secure sandbox. The Docker provider does not claim otherwise.
