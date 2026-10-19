# Documentation and verification

<!-- ciel-doc: current -->

Current docs describe the advisor-only source tree. [CHANGELOG](../CHANGELOG.md) is historical and is not an active feature specification.

- [中文](../README.md) / [English](../README.en.md): use, defaults and data retention.
- [Architecture](architecture.md): current module boundaries.
- [Settings compatibility](compatibility-017.md): DSH 0.2.1-rc.2 requirement, 0.22.0 upgrade and historical configuration migration.
- [Security](../SECURITY.md): credential, storage and data-egress boundaries.

## Offline checks

Run from this repository after dependencies are available:


default checks: `pnpm test`, `pnpm check:client`, `pnpm check:docs`, `node scripts/check-publication.mjs --include-untracked`, `node scripts/check-publication.mjs --package`.

For a built DSH 0.2.1-rc.2 checkout, export `DSH_CHECKOUT=/path/to/deepseek-harness` explicitly and run:

```sh
node scripts/verify-runtime.mjs
node scripts/verify-retry.mjs
node scripts/verify-protocol.mjs
node scripts/verify-profile-settings.mjs
node --test scripts/test/settings-migration.test.mjs
```

Run native Client checks from the DSH checkout with its tsx loader and client tsconfig:

```sh
TSX_TSCONFIG_PATH="$DSH_CHECKOUT/tsconfig.base.client.json" node --import tsx/esm /path/to/dsh-ciel/scripts/verify-native-settings.mjs
TSX_TSCONFIG_PATH="$DSH_CHECKOUT/tsconfig.base.client.json" node --import tsx/esm /path/to/dsh-ciel/scripts/verify-sidebar-native.mjs
```

These integration checks use synthetic data and do not start a server or request paid models. Native DOM checks are not a visual accessibility certification. CI pins its target revisions in [ci.yml](../.github/workflows/ci.yml); an unexecuted target is not a local verification claim.

## Maintenance

Keep documented configuration rows aligned with Config. The npm README is generated from the English README using `pnpm docs:sync`. Current Markdown uses one current/historical classification marker and live relative links. Never copy old test counts into current docs: retain actual run output separately and state its scope.
