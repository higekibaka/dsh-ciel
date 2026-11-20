# Settings compatibility

<!-- ciel-doc: current -->

Ciel 0.23.1 supports DSH >=0.2.0-rc.2 (including 0.2.1 and 0.2.2-rc.1+). Node.js must satisfy ^22.19.0 || >=24.0.0. Older-host code paths and the migration utility below are not a support promise for older DSH releases.

The supported host exposes Profile-backed configuration through the advisor entry; earlier releases used the ciel settings namespace. The plugin resolves live references to plain values at operation boundaries. Changes are staged in the Client and saved explicitly with the expected revision, so an old draft cannot silently overwrite a newer configuration.

Gemini Decision API keys use native secret metadata. Settings reads omit the secret value, base and user entries and expose whether a key exists. An unrelated save preserves the key; replacement and clearing require explicit intent. A host without secret mutation support must reject key editing rather than falling back to ordinary text storage.

## Upgrading from 0.20.1 / 0.21.0

Back up the profile configuration before upgrading. Install 0.23.1 through DSH's bundle manager in the intended profile, follow any restart-required result, and refresh the UI. Do not run a second Web profile alongside Desktop to update its plugins.

Annotation review, the inbox, review-only RPCs and the private PTC runtime/export are removed. Existing review files are left untouched but this version cannot open them; users who need those features should defer upgrading. Existing addressable advisor records remain readable. Review-only configuration keys are not automatically deleted; they no longer enable a capability. The retained advisor settings are still used; the retired JEV connection keys are left on disk untouched but are never read again (see the JEV → Gemini Decision section below).

## Upgrading from 0.22.x: JEV → Gemini Decision API

The optional provided-context check now runs against Google's Gemini Decisions API instead of TypeSafe JEV. This is a new provider, not a rename:

- The four retired settings (`advisorJevEnabled`, `jevApiKey`, `jevEndpoint`, `jevModel`) are **not read, not migrated, and not deleted** from disk. They never become Gemini configuration and never act as credentials.
- A TypeSafe/JEV key is not a Gemini API key. Configure `decisionApiKey` again, or let DSH credentials provide `GEMINI_API_KEY` / `GOOGLE_API_KEY`. The check stays **off by default** and must be enabled again.
- Historical advisor records that carry the old `jev` field remain readable; the UI labels them "历史 Jev 顾问建议检查（旧版，仅只读）" / "historical JEV check (read-only)" and never starts a new check from them.
- Gemini Decisions API is in EAP. It is available only on the Gemini Developer API (`v1beta/decisions`) with `gemini-decision-1`; without EAP access the check returns an explicit failure status and the advisor answer is unaffected.

## Historical settings-format migration

The [migration script](../scripts/migrate-dsh-017-settings.mjs) supports the earlier settings-format transition. Run its default dry-run mode first (`--home /path/to/dsh-home --checkout /path/to/dsh`), with an explicit settings path if needed (`--file settings.yaml`) and a built DSH checkout; inspect the result and keep a backup before applying. It rewrites legacy YAML namespace aliases before the Host’s one-time import; it is not a live Profile editor or a history migration. It also retargets theme, subagent-model-selection and agent-preset settings. Inspect every dry-run change: apply preserves existing destination fields, removes migrated source keys and creates a timestamped backup. [Migration regression tests](../scripts/test/settings-migration.test.mjs) use temporary files only.

Review-specific configuration is no longer part of the active advisor UI or execution contract. Old review/evidence/feedback/inbox records stay inert and are not deleted by configuration updates. No data-cleanup action is implied by disabling Ciel or closing a sidebar tab.

See [verification commands](index.md) and [security boundaries](../SECURITY.md).
