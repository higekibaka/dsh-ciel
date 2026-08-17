#!/usr/bin/env bash
# Install/sync the preset into the DSH user preset roster.
#
# The roster root (${DSH_HOME:-~/.dsh}/.agent-presets/) lies outside the
# session workspace, so an agent running this script must retry with
# sandbox_permissions escalation after the first denial. The repository copy
# is the source of truth: sync is one-way, never edit the installed copy.
set -euo pipefail

ROOT="${DSH_HOME:-$HOME/.dsh}/.agent-presets"
TARGET="$ROOT/advisor"
SOURCE="$(cd "$(dirname "$0")/../preset" && pwd)"

mkdir -p "$ROOT"
mkdir -p "$TARGET"
cp "$SOURCE/agent.cordis.yml" "$SOURCE/preset.yml" "$SOURCE/advisor-section.mjs" "$TARGET/"

echo "installed: $TARGET"
ls -la "$TARGET"
