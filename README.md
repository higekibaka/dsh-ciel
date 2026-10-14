# dsh-ciel（夏尔）

<!-- ciel-doc: current -->

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的纯顾问插件。主模型先探查，再调用 `ask_advisor` 获取不同思路、先例、陷阱和验证目标；顾问不写计划、不执行代码，主模型负责核实和最终结果。

[English](README.en.md) · [文档](docs/index.md) · [安全说明](SECURITY.md) · [历史变更](CHANGELOG.md)

## 安装与使用

当前版本：**[0.21.0](https://github.com/higekibaka/dsh-ciel/releases/tag/v0.21.0)** · [npm](https://www.npmjs.com/package/dsh-ciel/v/0.21.0)。

本版要求 **DSH 0.2.0-rc.2**（peer 依赖精确匹配），Node.js 为 `^22.19.0 || >=24.0.0`；旧宿主应保留匹配的旧版插件，不要绕过版本校验。桌面版可在当前 GUI 中要求代理通过 `plugin_manager` 安装 `dsh-ciel@0.21.0`。CLI 用户在目标 profile 执行：

```sh
dsh plugin --profile <目标-profile> add dsh-ciel@0.21.0
```

包更新后按安装结果提示重启 DSH 并刷新界面；不承诺自动热更新。**0.21.0 移除了批注评审及收件箱，旧评审文件保留但本版不能打开**；需要这些功能时先不要升级。升级前保留 profile 配置备份；本版不会自动清理旧评审配置，也不要删除共用的 Jev 连接配置。详见[升级与兼容说明](docs/compatibility-017.md)。

在目标 DSH profile 中安装匹配的插件包；使用桌面版时不要并行启动另一个 Web profile。在 **设置 → 夏尔 Ciel** 选择已经注册的顾问提供方和模型并保存。默认路由不会自动配置提供方或凭据。

1. 先检查环境，再向 `ask_advisor` 提供具体问题和背景。
2. 在工具卡片阅读建议，并在 DSH 原生右侧栏打开已保存的建议。
3. 独立推进并核实主张，在最终方案中说明采纳或舍弃了哪些建议。

使用协议要求每个规划阶段至多一次发散咨询，另可有至多两次携带新事实的定向追问。运行时按父代理的真实回合计数，不猜测语义上的规划阶段：`maxCallsPerTurn` 默认三次，同时禁止并行咨询，并按配置要求先探查、追问间隔内做独立工作。准入拒绝不占额度；准入后的提供方失败或取消仍占一次咨询额度，宿主传输重试不额外扣咨询次数。

每次咨询只创建一个无工具子代理；**网络失败重试交给宿主提供方策略**，所有尝试共享咨询总时限。Ciel 不再设置底层请求次数上限，避免第一次 `fetch failed` 后宿主重试被误取消。总时限和单次输出上限都不是费用上限；失败或取消后 Ciel 不自动重新咨询。

## 当前范围与旧数据

保留 `ask_advisor`、咨询协议与提醒、设置、模型来源、可选 Jev 检查、工具卡片和原生建议侧栏。业务 RPC 仅有 `cielAdvisor.readAdvice` 与 `cielAdvisor.callModelUsage`；历史读取不调用模型。

批注评审、批评者执行、证据抓取、评审收件箱、批注草稿与私有评审/PTC 运行时均已移除。旧 `/advise` 命令不再注册。磁盘上的旧 review/evidence/feedback/inbox 数据 **保留但不再使用**：本版不读取、不迁移、不删除。已有可寻址的建议和工具调用用量记录仍可读取；不提供旧命令用量查询；不提供历史列表或自动清理。历史变更记录只描述旧版本，不代表当前功能。

## 配置

修改仅在显式保存后生效。版本校验拒绝覆盖其他位置的新修改；保存失败保留草稿。同页设置导航保留草稿，刷新不保留。支持的宿主使用 Profile 入口 `advisor`；旧 `ciel` 命名空间的迁移仅作为历史兼容说明，不代表支持旧宿主，参见[设置兼容说明](docs/compatibility-017.md)。

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 启用顾问调用；关闭会取消在途调用。 |
| `provider` | `kimi-coding` | 已注册的 DSH 提供方路由。 |
| `model` | `kimi-for-coding` | 顾问模型 ID。 |
| `reasoningEffort` | `provider` | 跟随提供方默认，或选择模型支持的思考深度。 |
| `maxTokens` | `4096` | 单次响应的输出上限。 |
| `maxCallsPerTurn` | `3` | 每个父代理回合的咨询上限（1–20）。 |
| `requireExploration` | `true` | 首次咨询前要求独立探查工具活动。 |
| `enforceFollowupGap` | `true` | 追问前要求新的独立工作。 |
| `planReminderEnabled` | `true` | 尚未咨询时，在开始规划后提醒一次。 |
| `guidanceEnabled` | `true` | 注入顾问使用协议。 |
| `advisorTimeoutSeconds` | `180` | 单次咨询总时限（10–600 秒）。 |
| `advisorJevEnabled` | `false` | 可选的已提供背景一致性检查。 |
| `jevApiKey` | 未设置 | 原生秘密设置；设置读取不回传密钥。 |
| `jevEndpoint` | `https://api.typesafe.ai/v1/systemone` | 可信且兼容 TypeSafe 的 HTTPS 接口。 |
| `jevModel` | `jev-1.13.0` | Jev 模型 ID。 |

## 可选 Jev 检查

默认关闭。Jev 接收本次问题、背景和最多六条符合结构、可检查的建议原始完整段落，不保证整份回答均已检查。问题、背景和已选段落的 JSON 合计上限为 24 KiB；无有效结构或超限条目会跳过，发现疑似敏感输入则跳过本次检查，并返回明确原因。它仅检查建议与已提供背景的一致性；不独立查证外部事实，不改写建议。至多发送一次可选批量请求；失败保留原回答并返回明确状态。历史结果只展示，不重新检查。

自定义接口会收到所配置的密钥和原文。只有完整匹配默认官方接口时才允许回退到 `TYPESAFE_API_KEY`。必须使用 HTTPS；带用户名密码、查询参数或片段的 URL 及重定向会被拒绝。本地配置不是加密保险库，详见[安全说明](SECURITY.md)。

## 开发检查

依赖已经就绪时执行：

```sh
pnpm test
pnpm check:client
pnpm check:docs
node scripts/check-publication.mjs --include-untracked
node scripts/check-publication.mjs --package
```

以上是可复现的检查入口，不代表所有宿主和浏览器均已验收。原生离线集成检查需要已构建的 DSH checkout，见[文档索引](docs/index.md)。
