#!/usr/bin/env bash
# Kept at the repo root because that is where the README, the docs and every existing note point.
#
# The real script now lives inside the extension, so a packaged install carries it too: the editor
# needs to be able to fetch the engine on first run, and it can only run a script that shipped
# with it. This forwards, so both paths stay one implementation.
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/extensions/pscode-ai/scripts/fetch-llm-runtime.sh" "$@"
