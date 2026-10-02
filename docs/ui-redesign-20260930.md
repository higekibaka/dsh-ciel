# Ciel UI integration — 2026-09-30

This revision integrates the selected settings, review and evidence designs into the actual plugin, using existing Host services, native controls and resource identities. No backend review/exploration/credential logic or persistence schema changes.

## Interaction contracts

- Settings remain explicitly saved with namespace revision fencing, lost-response recovery, staged per-field resets and navigation-persistent drafts.
- The public settings-section API exposes close but no close guard. The real plugin retains drafts across modal close and shows an unsaved header notice instead of intercepting host UI.
- Feedback prepares text through the existing `prepareFeedback` RPC, then uses the existing atomic composer insertion capability. Existing text requires a native decision; replacement requires a second explicit confirmation. Session identity, input identity and draft revision are rechecked after waiting. Missing confirmation mount fails visibly instead of hanging.
- Annotation selection and inbox handling intent retain separate storage and meaning.
- Review conclusions preserve incomplete/failed/cancelled outcomes. Detailed investigation and Jev findings remain accessible, including disagreement.
- Evidence navigation carries display-only annotation context while resource identity remains session + review + evidence. Known path-list JSON gets a readable view and retains raw content; withheld/unknown records never leak content through the formatter.
- Source reply location reuses the inbox's bounded history locator. Records outside the current inbox page return an explicit instruction to locate from that page.

## Validation

Focused settings/sidebar/feedback/presentation tests and conversation/inbox/transport regressions run serially. Actual DSH 0.2.0-rc.2 Web validation uses a private copied home, the candidate plugin, existing historical records and one temporary Chromium with static background effects. No live model request or message submission is part of validation. The original DSH service and user profile are not used for these writes.

The integration fixes a pre-existing feedback bug: reading only `sessions.list.current` incorrectly rejected current DSH sessions. It now reuses the inbox's tested current-session projection, retaining wrong-session refusal.
