const { execSync } = require('child_process');
execSync('sed -i "s/import { existsSync } from \\\'node:fs\\\'/import { existsSync } from \\\'node:fs\\\'/" scripts/verify-protocol.mjs');
