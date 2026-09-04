# Changelog

All notable changes to dsh-ciel are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.12.0] - 2026-09-05

批评者体验的换代迭代（计划见
[docs/iteration-critic-ux.md](docs/iteration-critic-ux.md)），外加 DSH 0.1.3
适配与一个宿主级死循环修复。

### Added

- **评审契约 v2**：批评者回复以 `## verdict: pass|changes + summary` 开头，
  批注携带 `block: bN` 块级锚点（送审附块地图）；旧记录按旧形态渲染，
  零迁移。
- **裁决卡**：verdict 徽标（✓ 整体成立 / ⚠ 建议修改）+ 总评 + 统计 chips +
  可折叠批注列表，PR Review 心智取代拼写检查心智。
- **块级 gutter**：批注以块左侧徽章呈现（段落/列表/表格），代码块收进右上
  内沿；文本零侵入。块解析失败或锚引文证据不符时退回旧 proximity 划线
  （证据护栏，绝不错挂）。
- **分诊**：默认采纳（复选框=剔除误报）、全部/只看 blocker 过滤、
  仅选 blocker 快捷键、回传按钮实时显示采纳数；分诊状态经 feedback WAL
  **持久化、跨重启水合**。
- 生命周期徽标 verdict 感知（⚠ 批注 N · 复审）。

### Changed

- 顾问卡与裁决卡统一视觉语言：tier 计数徽章卡头、描边徽章、标签列字段行。
- **适配 DSH 0.1.3**：`Session.events` 数组属性退役为 `snapshotEvents()`
  方法，插件全部事件读取点走双形态兼容层；兼容性声明扩至
  0.1.2 / 0.1.3。

### Fixed

- **块切分列表延续死循环**（严重）：草稿含「列表项后紧跟缩进围栏/标题」
  时同步死循环卡死宿主事件循环（实例端口全灭）；修复并要求严格前进，
  双端副本同步，回归夹具两例。
- pass 卡不再把契约原文（`## verdict:`/`SOUND:`）泄漏为 raw 文本。
- 渐进挂载下 `findChatRoot` 落空导致评审渲染整场丢失（改退回最近足够大
  祖先）。

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
