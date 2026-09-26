# AI Harness (BMAD Next) - standard evaluation interface.
#
#   export AI_API_KEY="<PROVIDED_API_KEY>"
#   make setup
#   make run
#
# The credential is read from the AI_API_KEY environment variable at run time. It is never written to a file,
# printed, or passed on a command line. The model is defined in harness.config.json; AI_PROVIDER, AI_MODEL and
# AI_BASE_URL override it without editing any file.
#
# make run ISSUE=https://github.com/<owner>/<repo>/issues/<n>   start with that issue, then keep the session open
# make run REPO=<github-url|path>                                apply plain-text issues to that repository
# make run AUTO=1                                                take default answers for every decision

SHELL := /bin/bash
.DEFAULT_GOAL := help

NODE_MAJOR_REQUIRED := 22
CLI := node packages/cli/dist/main.js

# Pass the credential and model settings through the environment only.
export AI_API_KEY
export AI_PROVIDER
export AI_MODEL
export AI_BASE_URL
export PATH := $(CURDIR)/node_modules/.bin:$(PATH)

ifdef ISSUE
export ISSUE
endif
ifdef REPO
export HARNESS_REPO := $(REPO)
endif
ifeq ($(AUTO),1)
export HARNESS_AUTO := 1
endif

.PHONY: help setup run test clean check-node check-git

help:
	@echo "AI Harness targets:"
	@echo "  make setup   install dependencies and build"
	@echo "  make run     launch the harness (reads AI_API_KEY)"
	@echo "  make test    run the test suite"
	@echo "  make clean   remove build output and harness workspaces"

check-node:
	@command -v node >/dev/null 2>&1 || { echo "Node.js $(NODE_MAJOR_REQUIRED)+ is required: https://nodejs.org"; exit 1; }
	@node -e 'const m=+process.versions.node.split(".")[0]; if (m < $(NODE_MAJOR_REQUIRED)) { console.error("Node.js $(NODE_MAJOR_REQUIRED)+ is required; found " + process.version); process.exit(1); }'
	@command -v npm >/dev/null 2>&1 || { echo "npm is required."; exit 1; }

check-git:
	@command -v git >/dev/null 2>&1 || { echo "git is required."; exit 1; }

setup: check-node check-git
	@echo "==> Installing dependencies (includes the pinned OpenCode runtime)"
	npm ci --no-audit --no-fund
	@echo "==> Building"
	npm run build
	@echo "==> Installing Chromium for browser verification (optional)"
	@npx --no-install playwright install chromium >/dev/null 2>&1 \
		&& echo "Chromium installed." \
		|| echo "Chromium could not be installed; browser gates will report NOT CONFIGURED."
	@echo "==> Checking the runtime"
	@opencode --version >/dev/null 2>&1 \
		&& echo "OpenCode $$(opencode --version) ready." \
		|| { echo "OpenCode did not install. Re-run 'npm ci' with install scripts enabled."; exit 1; }
	@echo "Setup complete. Next: export AI_API_KEY=... && make run"

run: check-node
	@test -f packages/cli/dist/main.js || { echo "Not built. Run 'make setup' first."; exit 1; }
	@if [ -z "$$AI_API_KEY" ]; then echo "Warning: AI_API_KEY is not set. Model calls will fail unless OpenCode has its own login."; fi
	@$(CLI) harness

test: check-node
	@echo "==> Running tests (no model calls; runtime variables are cleared)"
	@env -u BMAD_RUNTIME -u BMAD_MODEL -u BMAD_RUNNER -u BMAD_RUNNER_ARGS \
		-u BMAD_REVIEWER_RUNNER -u BMAD_REVIEWER_ARGS -u BMAD_ATTACK_RUNNER -u BMAD_ATTACKER_ARGS \
		npm test

clean:
	rm -rf packages/*/dist packages/*/*.tsbuildinfo .harness workspace .bmad-demo
