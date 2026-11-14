# Advisor-only architecture

<!-- ciel-doc: current -->

The entry point registers the advisor tool and settings. The advisor remains tool-free: it receives only the caller's question and context, not an ambient filesystem or browser capability.

| Module | Responsibility |
|---|---|
| runtime | Shared host-module resolution: one `@deepseek-ai/schemastery` Schema identity and one `@deepseek-ai/dsh-typert-protocol` service identity with the process that runs the plugin |
| advisor-state | Admission, independent-work gates, reservations and planning reminder state |
| advisor-content | Advisor text parsing and native/PTC event adaptation |
| advisor-operation | One consultation deadline, cancellation and settlement |
| advisor-repository | Exact advice and call-usage persistence |
| advisor-protocol | Two typed request/result contracts and Remote descriptor |
| advisor-service | Read-only advice and model-usage business service |
| sensitive-text | Heuristic credential screening |
| decision-client / decision-advisor / decision-config | Optional bounded Gemini Decision context checks and connection validation |
| record-store | Atomic bounded records, identity and path/link guards |
| Client | Settings, tool cards, model provenance and native advice resource/sidebar |

The parent turn consultation quota counts consultations, not network attempts. One accepted consultation creates one tool-free child. Host provider retries share its deadline; Ciel has no duplicate request counter or retry loop. The optional Gemini Decision batch uses the remaining deadline; it neither replaces the advice nor starts another advisor child. The deadline covers model work, retries and the optional check, not a guaranteed wall-clock return time: once final record commit begins the result is no longer cancelled, and persistence/cleanup may finish afterward.

Requested model routes are not evidence of execution. Badges use captured assistant source metadata; missing or requested-only provenance remains explicit. Saved advice is opened by session and call identity, never by browsing arbitrary paths.

Ciel ships no runtime dependency of its own. `runtime.js` resolves the host's schemastery and Typert protocol copies from a fixed anchor order — `DSH_CIEL_HOST_MODULES`, `DSH_CHECKOUT`, `DSH_INSTALL_DIR`, Desktop's `process.resourcesPath` (`app.asar/dsh`), the `process.argv[1]` entry script, then the plugin's own `node_modules` — and throws `HostDependencyError` (`CIEL_HOST_DEPENDENCY_UNAVAILABLE`) listing every anchor it tried. A second copy of either package is a defect, not a fallback: the settings service and the typert Gateway compare identities.

Admission refusals that do not spend the turn's consultation budget open with a stable `[ciel:gate:<code>]` prefix (`disabled`, `guard_unavailable`, `invalid_route`, `empty_context`, `sensitive_input`, `telemetry_unavailable`, `explore_first`, `budget_exhausted`, `followup_gap`, `in_flight`). The historical English and Chinese heads stay recognised so old session logs keep replaying unchanged. Read-only service failures carry an additive machine-readable `code` (`CIEL_ADVICE_NOT_FOUND`, `CIEL_ADVICE_SENSITIVE`, `CIEL_ADVICE_UNAVAILABLE`, `CIEL_USAGE_UNAVAILABLE`) beside the existing `error` prose.

Package metadata for the plugin manager lives in `locale/en.json` and `locale/zh.json` under a `meta.title` / `meta.description` pair; both are exported and shipped.

Old review records remain on disk but have no active reader, writer, listing, migration or UI. This is removal of a feature, not user-data deletion. No review coordinator, corpus, evidence ledger, inbox, feedback composer or private QuickJS runtime remains in the current architecture.

See [configuration and use](../README.en.md), [security](../SECURITY.md) and [verification commands](index.md).
