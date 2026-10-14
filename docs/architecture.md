# Advisor-only architecture

<!-- ciel-doc: current -->

The entry point registers the advisor tool and settings. The advisor remains tool-free: it receives only the caller's question and context, not an ambient filesystem or browser capability.

| Module | Responsibility |
|---|---|
| advisor-state | Admission, independent-work gates, reservations and planning reminder state |
| advisor-content | Advisor text parsing and native/PTC event adaptation |
| advisor-operation | One consultation deadline, cancellation and settlement |
| advisor-repository | Exact advice and call-usage persistence |
| advisor-protocol | Two typed request/result contracts and Remote descriptor |
| advisor-service | Read-only advice and model-usage business service |
| sensitive-text | Heuristic credential screening |
| jev-client / jev-advisor / jev-config | Optional bounded context checks and connection validation |
| record-store | Atomic bounded records, identity and path/link guards |
| Client | Settings, tool cards, model provenance and native advice resource/sidebar |

The parent turn consultation quota counts consultations, not network attempts. One accepted consultation creates one tool-free child. Host provider retries share its deadline; Ciel has no duplicate request counter or retry loop. The optional Jev batch uses the remaining deadline; it neither replaces the advice nor starts another advisor child. The deadline covers model work, retries and the optional check, not a guaranteed wall-clock return time: once final record commit begins the result is no longer cancelled, and persistence/cleanup may finish afterward.

Requested model routes are not evidence of execution. Badges use captured assistant source metadata; missing or requested-only provenance remains explicit. Saved advice is opened by session and call identity, never by browsing arbitrary paths.

Old review records remain on disk but have no active reader, writer, listing, migration or UI. This is removal of a feature, not user-data deletion. No review coordinator, corpus, evidence ledger, inbox, feedback composer or private QuickJS runtime remains in the current architecture.

See [configuration and use](../README.en.md), [security](../SECURITY.md) and [verification commands](index.md).
