# Changelog

All notable changes to dsh-ciel are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.11.0] - 2026-09-01

First public release.

### Changed

- **Renamed `dsh-advisor` → `dsh-ciel`** (大贤者夏尔 — the in-head advisor
  from *That Time I Got Reincarnated as a Slime*), clearing the name
  collision with [omdsh-dev/dsh-advisor](https://github.com/omdsh-dev/dsh-advisor).
- **Settings namespace migrated `advisor` → `ciel`** for the same reason:
  legacy `advisor` sections in `settings.yaml` are copied over automatically
  on first boot (the legacy section is left in place, so downgrades lose
  nothing), and the name is then released for the other plugin.
- Settings card model catalog now rides the `session.modelCatalog` Remote
  (the `connection.api.llm.models` RPC it used was removed in DSH 0.1.1).
  A failed load can be retried from the card, and provider-topology pushes
  (`llm/adapters-updated`) or connection resets expire the cached catalog.
- Reasoning-effort dropdowns track the selected model on both pipelines:
  options come from the model's declared `reasoning.efforts` (with the
  model's own default marked), and the critic route gained the
  跟随提供方默认 (`provider`) option the advisor route already had.
- The settings card is now driven by a declarative field-descriptor table
  and folds into collapsible groups (顾问管道 → 生成参数与行为开关 /
  批评者路由), each closed group summarizing its current values.
- Message tags (`[advisor:*]`), the sidecar directory
  (`$DSH_HOME/dsh-advisor/`), and the typert contract ids intentionally keep
  their old names for data continuity.

## [0.10.0] - 2026-08-24

- `/advise` human command: auto-assembled context (≤8 visible turns, ~1800
  chars), dual slot registration, result card plus automatic `steer`
  re-injection that notifies the main model.

## [0.9.3] - 2026-08-23

- Review panel header states when advisor verification targets participated.

## [0.9.2] - 2026-08-23

- Fixed the targets-scope regression introduced by 0.9.0's staticization.

## [0.9.1] - 2026-08-22

- Critic routing configurable: `criticProvider` / `criticModel` /
  `criticEffort` entered the settings namespace.

## [0.9.0] - 2026-08-22

- The critic's input now includes the current turn's advisor verification
  checklist (A/B verified adoption).

## [0.8.1] - 2026-08-21

- Critic effort pin low→medium per the official Gemini thinking docs.

## [0.8.0] - 2026-08-21

- Advisor output card in the conversation (keyed tool view for
  `ask_advisor`), sharing the review panel's visual language.

## [0.7.0] - 2026-08-20

- One-click "send review back to the main model" on annotation reviews.

## [0.6.0] - 2026-08-20

- Structured advisor output: `## [tier] 标题` sections with
  `framing`/`pitfalls`/`verification_target` fields; canonical text value
  unchanged for the caller, structure rides `tool/result.meta`.

## [0.5.0] - 2026-08-19

- Critic evidence floor (reply text plus adjudicated digests of the turn's
  user request and tool results — never chain-of-thought) and self-healing
  marks.

## [0.4.0] - 2026-08-19

- Review records moved to sidecar storage
  (`$DSH_HOME/dsh-advisor/reviews/<sessionId>.jsonl`) after custom session
  events proved unloadable; nothing is written to session logs anymore.

## [0.3.0] - 2026-08-18

- Annotation review: a per-reply 批注评审 button runs the convergent critic
  (gemini-3.7-flash) whose red-line annotations anchor onto the reply text.

## [0.2.0] - 2026-08-15

- Reasoning-effort setting, mechanized consultation gates (explore-first,
  follow-up gap), plan-moment reminder, confidence tiers.

## [0.1.0] - 2026-08-13

- M2 bundle: `ask_advisor` tool, guidance prompt section, host settings
  namespace, and the Settings → Plugins configuration card.
