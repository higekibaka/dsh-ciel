# dsh-ciel (Ciel)

<!-- ciel-doc: current -->

An advisor-only plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). The main model explores first, then calls `ask_advisor` for alternative framings, prior art, pitfalls and verification targets—not plans or code. The main model verifies the ideas and owns the result.

[中文](README.md) · [Documentation](docs/index.md) · [Security](SECURITY.md) · [Historical changelog](CHANGELOG.md)

## Install and use

Current release: **[0.22.0](https://github.com/higekibaka/dsh-ciel/releases/tag/v0.22.0)** · [npm](https://www.npmjs.com/package/dsh-ciel/v/0.22.0).

This release requires **DSH 0.2.1-rc.2** (exact peer versions) and Node.js `^22.19.0 || >=24.0.0`. Keep a matching older plugin on older hosts; do not bypass compatibility checks. In Desktop, ask the agent in the current GUI to install `dsh-ciel@0.22.0` through `plugin_manager`. CLI users select the intended profile explicitly:

```sh
dsh plugin --profile <target-profile> add dsh-ciel@0.22.0
```

After a package update, follow the installation result's restart requirement and refresh the UI; hot updates are not guaranteed. **0.21.0+ removes annotation review and the inbox; old review files remain but cannot be opened by this version.** Defer upgrading if you still need those features. Keep a profile configuration backup before upgrading. This version does not automatically clean up old review settings; do not delete the shared Jev connection settings. See [upgrade and compatibility notes](docs/compatibility-017.md).

Install the matching package in your intended DSH profile; do not start a second Web profile alongside Desktop. Choose the advisor's registered provider and model under **Settings → 夏尔 Ciel**, then save. Route defaults do not register credentials or providers.

1. Inspect the environment and supply a concrete question plus context to `ask_advisor`.
2. Read the advisor tool card; open the saved advice in DSH's native right sidebar.
3. Work independently, verify claims and state which ideas you adopted or rejected.

The guidance allows one divergent consultation per planning phase and at most two targeted follow-ups with new facts. Runtime admission uses the parent agent's actual turn, not a semantic planning-phase counter: `maxCallsPerTurn` defaults to three, rejects parallel consultations and requires independent work when configured. Rejected admission does not spend quota; provider failure or cancellation after admission still consumes one consultation, while Host transport retries do not consume extra consultations.

Each consultation creates one tool-free child. **The Host provider policy owns network retries**, with every attempt sharing the consultation deadline. Ciel imposes no conflicting request-count cap: a transient `fetch failed` no longer cancels recovery before the second attempt. The total deadline and output cap are not monetary spending caps. Ciel does not automatically rerun a failed or cancelled consultation.

## Current scope and retained data

Ciel provides `ask_advisor`, consultation guidance/reminders, settings, model provenance, optional Jev checks, tool cards and the native advice sidebar. The only business RPCs are `cielAdvisor.readAdvice` and `cielAdvisor.callModelUsage`; history reads do not call models.

Annotation review, critic execution, evidence capture, review inbox, feedback drafts and the private review/PTC runtime have been removed. The old `/advise` command is not registered. Existing review/evidence/feedback/inbox files are **retained inert**: this version neither reads, migrates nor deletes them. Existing addressable advice and tool-call usage records remain readable; retired command-usage lookup is not exposed. There is no history listing or automatic retention cleanup. The historical changelog describes older releases, not current features.

## Configuration

Changes are staged until explicit Save. Revision fencing rejects stale writes, and failed saves retain the draft. Drafts survive settings navigation within the page, not refresh. The supported host uses Profile entry `advisor`; the old `ciel` namespace is described only for migration, not as a promise of older-host support. See [settings compatibility](docs/compatibility-017.md).

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Enable advisor calls; disabling cancels in-flight work. |
| `provider` | `kimi-coding` | Registered DSH provider route. |
| `model` | `kimi-for-coding` | Advisor model ID. |
| `reasoningEffort` | `provider` | Follow provider default or select supported effort. |
| `maxTokens` | `4096` | Output limit per response. |
| `maxCallsPerTurn` | `3` | Consultation cap per parent agent turn (1–20). |
| `requireExploration` | `true` | Require prior independent tool activity. |
| `enforceFollowupGap` | `true` | Require independent work before follow-up. |
| `planReminderEnabled` | `true` | One planning reminder when not yet consulted. |
| `guidanceEnabled` | `true` | Inject the advisor-use protocol. |
| `advisorTimeoutSeconds` | `180` | Total consultation deadline (10–600 seconds). |
| `advisorJevEnabled` | `false` | Optional provided-context consistency check. |
| `jevApiKey` | unset | Native secret setting; never returned in settings reads. |
| `jevEndpoint` | `https://api.typesafe.ai/v1/systemone` | Trusted HTTPS TypeSafe-compatible endpoint. |
| `jevModel` | `jev-1.13.0` | Jev model ID. |

## Optional Jev check

Off by default. Jev receives the supplied question, context and at most six complete original structured sections selected for checking, not necessarily the entire answer. The serialized question/context/selected-items state is capped at 24 KiB; missing or oversized sections are skipped, and suspected sensitive input skips the check, with explicit reasons. It checks only their relationship to that context; it does not independently verify the world or rewrite the advice. At most one optional batch is sent; failures keep the original answer and return a labeled status. Saved results are displayed without rechecking.

Custom endpoints receive your configured key and text. Only the exact official default endpoint can use `TYPESAFE_API_KEY` as a fallback. HTTPS is required; credential-bearing URLs, query strings, fragments and redirects are rejected. Local configuration storage is not an encrypted vault. See [Security](SECURITY.md).

## Development checks

With the repository's dependencies already available:

```sh
pnpm test
pnpm check:client
pnpm check:docs
node scripts/check-publication.mjs --include-untracked
node scripts/check-publication.mjs --package
```

These are reproducible checks, not a claim that every host or browser has been tested. Native offline integration requires a built DSH checkout; commands and scope are in the [documentation index](docs/index.md).
