# Settings compatibility

<!-- ciel-doc: current -->

Ciel 0.21.0 supports DSH 0.2.0-rc.2; the published peer dependencies are pinned to that exact release. Node.js must satisfy ^22.19.0 || >=24.0.0. Older-host code paths and the migration utility below are not a support promise for older DSH releases.

The supported host exposes Profile-backed configuration through the advisor entry; earlier releases used the ciel settings namespace. The plugin resolves live references to plain values at operation boundaries. Changes are staged in the Client and saved explicitly with the expected revision, so an old draft cannot silently overwrite a newer configuration.

Jev API keys use native secret metadata. Settings reads omit the secret value, base and user entries and expose whether a key exists. An unrelated save preserves the key; replacement and clearing require explicit intent. A host without secret mutation support must reject key editing rather than falling back to ordinary text storage.

## Upgrading from 0.20.1

Back up the profile configuration before upgrading. Install 0.21.0 through DSH's bundle manager in the intended profile, follow any restart-required result, and refresh the UI. Do not run a second Web profile alongside Desktop to update its plugins.

Annotation review, the inbox, review-only RPCs and the private PTC runtime/export are removed. Existing review files are left untouched but this version cannot open them; users who need those features should defer upgrading. Existing addressable advisor records remain readable. Review-only configuration keys are not automatically deleted; they no longer enable a capability. The retained advisor settings and shared Jev connection/key are still used and must not be cleared as part of removing review settings.

## Historical settings-format migration

The [migration script](../scripts/migrate-dsh-017-settings.mjs) supports the earlier settings-format transition. Run its default dry-run mode first (`--home /path/to/dsh-home --checkout /path/to/dsh`), with an explicit settings path if needed (`--file settings.yaml`) and a built DSH checkout; inspect the result and keep a backup before applying. It rewrites legacy YAML namespace aliases before the Host’s one-time import; it is not a live Profile editor or a history migration. It also retargets theme, subagent-model-selection and agent-preset settings. Inspect every dry-run change: apply preserves existing destination fields, removes migrated source keys and creates a timestamped backup. [Migration regression tests](../scripts/test/settings-migration.test.mjs) use temporary files only.

Review-specific configuration is no longer part of the active advisor UI or execution contract. Old review/evidence/feedback/inbox records stay inert and are not deleted by configuration updates. No data-cleanup action is implied by disabling Ciel or closing a sidebar tab.

See [verification commands](index.md) and [security boundaries](../SECURITY.md).
