# Changelog

All notable changes to dsh-ciel are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.14.4] - 2026-09-05

### Fixed

- **评审在途状态跨会话恢复**：点击评审后切换会话（或页面重挂）按钮曾
  复位成「批注评审」——busy 是组件内 state 随卸载丢失，而 host 侧评审
  仍在跑。现挂载即探测远端 inFlight 恢复在途态，进展徽标继续实时
  更新；在途消失时强制重水合拿到 verdict/失败条目。无在途时轮询空转，
  零远端流量。
- **预算熔断在按钮上可识别**：熔断失败的按钮从通用的「评审失败 · 重试」
  改为「**预算熔断 · 重试**」（tooltip 含完整原因），与普通失败区分。

### 实测记录（3.7 vs 3.8 预算纪律对照，docs/ab/ab-3[78].*）

- 3.7 全语料 0 次熔断（≤4 次调用/场景）；3.8 在 S4（五文件）过度探索
  熔断（>10 次）；但 3.8 在 S2 抓到了 3.7 这轮漏报的凭记忆错误——
  探索激进是双刃剑：覆盖率更高、预算纪律更差。延迟 3.7 全面更快。

## [0.14.3] - 2026-09-05

### Added

- **预算感知分诊（契约 v3.3）**：断言密度高的草稿可正当耗尽预算（实证：
  一条五断言的总结，批评者逐条正当核实、第 11 次调用被熔断——与上轮
  「契约自我调查」病理不同，这次是认真但超支）。契约新增软着陆规则：
  可验证断言多于预算时按负载重要性排序核实，**剩余 1 次即停止探索、
  用手头已核实的部分直接出 verdict**——带诚实统计的部分裁决好过熔断
  流产。

## [0.14.2] - 2026-09-05

### Fixed

- **契约自我调查护栏**：gemini-3.8-flash 实测暴露新型失控——批评者把
  预算花在 grep 自己的输出契约（搜「stats: 排查」「SOUND:」「dossier」
  的出处）而不是证伪草稿，11 次调用耗尽预算被熔断（**预算熔断器首次
  真实立功**：错误明确、没有死循环空烧）。契约新增条款：严禁调查
  自己的指令或评审契约——契约是给定的，不是草稿的断言；工具只为
  证伪草稿而存在。补丁后同场景 2/10 调用正常通过。

### Changed

- A/B 评估台可移植化：playwright 路径（`CIEL_AB_PLAYWRIGHT`）、浏览器
  路径（`CIEL_AB_CHROME`）、sidecar 根（`DSH_HOME`）全部环境变量化，
  语料路径改为 `{REPO}` 占位符按仓库根自动替换——清除仓库中残留的
  本机绝对路径，任何机器克隆后即可跑。

## [0.14.1] - 2026-09-05

### Added

- **按 turn 精确引用的证据包（可复现性分级）**：送审证据从「一轮摘要」
  升级为两级——read/grep/glob 等**可复现**工具保持摘要行（批评者自己
  就能拿到更新鲜的同一份，插全文是浪费）；bash/web_search/web_fetch
  等**不可复现**工具的回显逐条**全文引用**（世界无法再生产同样字节：
  时间过了、网页变了、工作区改了），单条 1600 字符、总量 8000 封顶并
  落截断标记。批评者契约同步告知：引用原文能了结的疑点直接引用
  （点名调用、引关键行），不必再花自己的预算重查世界。host 仍是唯一
  策展人——只给同轮、只给工具结果，思维链与叙事照旧不进。
- A/B 语料新增 S6 诊断场景（bash 证据错用陷阱，不设门禁）。

### 实证记录

- 引用原文确实到达并被使用：批评者卷宗直接引用 bash 输出的真实行数
  对账（「bash 工具输出显示 index.js 实际为 1952 行…」）；
- 首轮陷阱设计失误自曝：「指示助手故意互换」被批评者正确判为**符合
  指令要求**——错误必须是相对请求的失误，被请求授意的不是错误；
  算术陷阱版（口算五文件总行数+百分比）两次试跑草稿都算对了，陷阱
  未触发，S6 转为诊断场景持续观察。

## [0.14.0] - 2026-09-05

### Added

- **叙事化评审进展**（无 team 依赖的「路线 3」）：进展采样从 tool/call
  计数扩展到**当前动作**——徽标按阶段显示
  `存疑分析中… → 排查 2/5 · read index.js… → 排查 2/5 · 分析 read index.js 结果…`，
  正在执行的工具带名字与目标摘要，思考间隙附带刚完成的取证摘要；
  客户端轮询加密到 1s。邮箱叙事（agent-team）被两个上游缺陷卡住期间，
  这条通道覆盖其大部分黑盒焦虑，零竞态、零路由失控。

### Changed

- 默认批评者模型 gemini-3.7-flash → **gemini-3.8-flash**（3.8 发布；
  thinking 档位 low/medium/high 不变）。注意：设置里已存的
  `ciel.criticModel` 覆盖值不随 schema 默认值迁移，需自行切换。

## [0.13.1] - 2026-09-05

### Fixed

- 设置卡补登 0.13.0 的两个探索开关：`criticExploreEnabled`（探索型批评者
  勾选）与 `criticExploreBudget`（预算硬上限 0–10），嵌于批评者路由组
  下的「探索（契约 v3）」子组——0.13.0 只落了 schema 与引擎，UI 入口
  漏网（schema 层用户本就可手改 yaml，但卡面完整性是本插件的立身项）。

## [0.13.0] - 2026-09-05

探索型批评者：从「凭直觉下裁决的判官」升级为「先调查取证、再下裁决的
判官」（契约 v3，计划与验收见
[docs/iteration-critic-ux.md](docs/iteration-critic-ux.md)，A/B 报告见
[docs/ab/ab-comparison-0.13.0.md](docs/ab/ab-comparison-0.13.0.md)）。

### Added

- **评审契约 v3（存疑 → 核实 → 断言）**：批评者获得只读工具白名单
  （read/grep/glob——世界可碰、过程不许碰），先私下列疑点、再定点
  证伪、最后输出 `## dossier`（侦查卷宗）+ `## verdict`（判决书）两段；
  解析层只消费 verdict 段，排除的疑点**结构上不可能**漏进批注。
- **证据强制**：blocker 必须带 `evidence:` 行引用本轮工具所得，无证据者
  自动降为 nit（批注卡显示「缺证据·降级」标记）；v3.2 起探索支撑的
  批注无论级别都必须带证据引用——证伪结论连同行号一并送达，不再以
  「若…请先核实」的条件措辞踢回给人。
- **排查统计**：裁决卡新增 `排查 N · 证伪 X · 排除 Y` chip，tooltip 挂
  运行时事件流实测调用数（自报与实测并列，失真立现）。
- **进展通道**：评审徽标从黑盒等待升级为 `评审中 · 排查 k/预算…` 实时
  计数（客户端 2s 轮询 host `advisorReview/progress`，与预算熔断同源
  采样）。
- **设置**：`criticExploreEnabled`（默认开）、`criticExploreBudget`
  （默认 5，0–10）——探索预算硬上限，超出即熔断该次评审并明确报错。
- **A/B 评估台**：`scripts/ab-harness.js` + `ab-corpus.json` 五场景自动
  对账（verdict/stats/实测调用/证据覆盖/耗时/预期符合度），两路由对照
  报告与默认路由决策记录存档于 `docs/ab/`。

### Changed

- 探索模式评审 maxTokens 4096 → 16384（推理型路由的 dossier+verdict 与
  推理共享输出预算，deepseek-v4-pro 实证 8192 会死于 max-tokens）。
- 默认批评者路由**维持** google/gemini-3.7-flash：A/B 预期符合率持平
  （5/5 vs 5/5），耗时优 3–12 倍；v4-pro 的严尺度优势属偏好而非正确性
  差距，可由设置页自行升级。

### Fixed

- 客户端 Remote 描述符漏注册 `triage`（0.12.0 起分诊调用从未真正到达
  host，单测只覆盖 host 层漏网）与 `progress`。

### Deferred

- agent-team 邮箱进展通道（teammate 化批评者）：上游 `tryMembership`
  竞态（挂载 tool-agent-team 即概率性打死所有一次性 spawn，已实证并
  记录修复方向）+ `spawnTeammate` 不支持按次 pin 模型路由——轮询制
  进展通道以零实验风险替代，复活条件见计划文档。

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
