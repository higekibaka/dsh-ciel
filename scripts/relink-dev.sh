#!/bin/sh
# Linked-development repair: `pnpm install` in plugin/ materializes the two
# devDependencies as REAL copies, but @deepseek-ai/cordis and
# @deepseek-ai/dsh-typert-protocol must stay singletons shared with the app
# (a second copy carries its own registry state and breaks the plugin when
# the checkout is linked into a profile). Re-point them at the profile's
# shared fallback copies. No-op for npm-installed (non-linked) deployments.
set -e
SHARED="${DSH_HOME:-$HOME/.dsh}/profiles/node_modules/@deepseek-ai"
TARGET="$(cd "$(dirname "$0")/../plugin" && pwd)/node_modules/@deepseek-ai"
mkdir -p "$TARGET"
ln -sfn "$SHARED/cordis" "$TARGET/cordis"
ln -sfn "$SHARED/dsh-typert-protocol" "$TARGET/dsh-typert-protocol"
echo "relinked: cordis, dsh-typert-protocol -> $SHARED"
