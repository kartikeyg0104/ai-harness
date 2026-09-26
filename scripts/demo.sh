#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
node packages/cli/dist/main.js doctor
node packages/cli/dist/main.js demo fresh
node packages/cli/dist/main.js demo run
