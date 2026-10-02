<p align="center">
  <img src="https://capsule-render.vercel.app/api?type=waving&color=0:7c3aed,100:06b6d4&height=170&section=header&text=dsh-ciel%20%E5%A4%8F%E5%B0%94&fontSize=52&fontColor=ffffff&animation=fadeIn&desc=%E8%A7%84%E5%88%92%E5%89%8D%E9%A1%BE%E9%97%AE%20%C2%B7%20%E6%94%B6%E6%95%9B%E6%89%B9%E8%AF%84%E8%80%85&descSize=20&descAlignY=72" alt="dsh-ciel 夏尔" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-ciel"><img src="https://img.shields.io/npm/v/dsh-ciel?style=for-the-badge&logo=npm&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/dsh-ciel"><img src="https://img.shields.io/npm/dm/dsh-ciel?style=for-the-badge&color=2563eb" alt="npm downloads"></a>
  <a href="https://github.com/higekibaka/dsh-ciel/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/higekibaka/dsh-ciel/ci.yml?style=for-the-badge&logo=githubactions&logoColor=white&label=ci" alt="ci status"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e?style=for-the-badge" alt="license: MIT"></a>
</p>

<p align="center"><a href="./README.en.md">English</a> | <b>中文</b></p>

# dsh-ciel（夏尔）

<!-- ciel-doc: current -->

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的规划前顾问与批注评审插件。主模型先探查，顾问通过 `ask_advisor` 提供思路；用户对助手回复发起两阶段受限评审，再决定如何处理批注。

当前版本：**[0.20.1](https://github.com/higekibaka/dsh-ciel/releases/tag/v0.20.1)** · [npm](https://www.npmjs.com/package/dsh-ciel/v/0.20.1) · [变更记录](CHANGELOG.md)。本轮本地验证目标为 **DSH 0.2.0-rc.2**，CI 包含固定的 0.1.6 / 0.1.7 / 0.2.0 目标。

本版包含 **DSH 0.1.7-alpha.1** 设置与会话适配，升级前请先阅读 [设置迁移与验证说明](docs/compatibility-017.md)。

## 安装与开始使用

```sh
dsh plugin --profile web add dsh-ciel@0.20.1
```

在自己的目标 profile 中安装或更新后，重启 DSH 并刷新浏览器。进入 **设置 → 夏尔 Ciel**，选择已在 DSH 中配置的顾问、批评者模型并保存；默认路由不会替你注册提供方或凭据。

1. 主模型先读、搜或执行必要的探查，再按需调用 `ask_advisor`。顾问只提供思路、先例、陷阱与验证清单，主模型负责计划和实现。
2. 在助手回复上点击 **批注评审**。默认先提出疑点，再在受限资料范围内核实；生成的批注显示在原文和原生右侧栏。
3. 打开左侧 **夏尔收件箱**，查看当前会话的评审，为批注标记「待判断／准备处理／暂不采纳」。这些标记只记录你的处理意向。
4. 在评审详情选择批注并点 **填入输入框**，编辑草稿后手动发送。已有草稿时可选择追加、取消或替换；追加保留文字、引用和附件，替换须二次确认并覆盖原文字与行内引用。收件箱标记不会触发修复或发送消息。

`/advise` 命令已移除，已有顾问和命令记录保留；顾问咨询使用 `ask_advisor`。

## 工作流程

```mermaid
flowchart TD
    U[用户请求] --> E[主模型先探查]
    E --> A[按需调用 ask_advisor]
    A --> I[顾问：思路、先例、陷阱与验证清单]
    I --> M[主模型制定计划、实现并回复]
    M --> C[用户点击批注评审]
    C --> S[存疑：真人请求与目标回复]
    S --> V[核实：受限资料与宿主证据引用]
    V --> R[原文批注与右侧栏详情]
    R --> B[收件箱：记录处理意向]
    R --> D[选择批注，填入输入框]
    D --> F[用户编辑并手动发送]
```

规划提醒与咨询额度共用咨询状态；被准入门拒绝的请求不占额度。评审由用户触发，进度恢复和历史加载不会自动启动模型。

## 0.20.1 更新

- 文档补丁：修正配置、安全边界、证据及草稿交互说明，区分当前规范与历史验证。
- npm README 从英文版生成；新增文档一致性检查，并接入 CI 和发布流程。
- 运行时代码、默认值和记录格式与 0.20.0 相同，无需迁移。

## 0.20.0 功能回顾

- Jev 评审证据检查和顾问建议检查，两个独立开关，默认关闭；新增 API Key、HTTPS 接口地址和模型设置。
- 至多 8 个疑点独立并发调查，保存逐项结论、未核实原因及调用计数，共享原总时限。
- 历史宿主模型/权限/工具声明、有界工具输出及受限目录清单可作有来源的证据，不用当前配置补历史。
- 设置、评审与证据界面更新；原生确认草稿追加/替换，保持会话和草稿版本保护。
- 原文读取与引用归档分离，分页不再误降级；修复进度查询误取消与部分覆盖整体通过的表述。
- Profile 引用配置、Session V4 与升级前设置迁移支持；详情见 [变更记录](CHANGELOG.md)。

## 收件箱、草稿与历史

收件箱只列出当前选中的会话，每页最多 25 条评审；计数和筛选只针对当前页。列表与意向读写不调用模型，也不改写草稿。打开评审、证据与顾问历史使用 DSH 原生右侧栏。

意向与评审详情中的批注选择相互独立。另一标签页已修改同一条意向时会提示冲突，可刷新后重试；若持久化意向绑定的评审内容已变化，会明确报指纹不匹配，当前版本不自动重置或迁移。多个 Host 同时写入同一 `DSH_HOME` 不受支持。

历史批注按会话和消息共同关联。缺少原消息、证据不可用、加载失败与没有记录分别提示；定位历史消息可能需要先加载对应历史。打开「当前文件」是查看现有源码，不能替代评审时保存的证据。

## 评审范围与费用

默认评审分两阶段：存疑只看真人请求和目标回复；核实再使用受限源码副本与证据引用。工具化核实在 Ciel 私有的 worker + QuickJS/WASM 中执行，只能通过受控的 `read` / `grep` / `glob` 读取本次不可变资料；缺少守卫或运行能力时明确失败，不回退不受限工具。

每个会话最多一个在途评审。默认 180 秒总时限包含资料准备和两个阶段；可手动停止，超时不追加模型整理、不自动延长。进度同步连续失败最多探测四次后暂停，可显式重试同步；重试同步不等于重新评审。

**时限不等于费用上限。** 两阶段及工具后的继续生成会请求模型，提供方也可能重试。输出上限是单次响应限制，停止不会退回已消耗的 tokens。关闭 `enabled` 取消在途顾问和评审，并禁止新调用；关闭 `criticExploreEnabled` 只关闭工具核实，仍会调用模型。

零批注不等于事实已全部核实。未查项、截断输入、缺少附件内容及失败阶段会保留覆盖说明。宿主验证证据引用是否属于本次账本，但引用本身不证明结论为真。程序可见的回执也不等于模型读取了全部文件，模型只看到程序打印或返回的内容。

## 配置

设置位于独立的 **夏尔 Ciel** 页面，新版编辑 Profile 入口 `advisor`（旧宿主命名空间为 `ciel`）。修改后点击保存；切换设置页保留草稿，刷新不自动保存。不同位置的修改有版本冲突保护。

| 字段 | 默认 | 说明 |
|---|---|---|
| `provider` | `kimi-coding` | 顾问提供方路由（须已在设置 → 模型 注册） |
| `model` | `kimi-for-coding` | 顾问模型 id；跨家族模型多样性收益更大 |
| `reasoningEffort` | `provider` | 注入每次咨询的思考深度；`provider` 跟随提供方默认 |
| `maxTokens` | `4096` | 顾问单次输出上限（256–32768） |
| `maxCallsPerTurn` | `3` | 每个代理 turn 的硬上限（1–20），不是语义规划阶段计数 |
| `requireExploration` | `true` | 首次咨询前要求先探查 |
| `enforceFollowupGap` | `true` | 追问之间要求独立工作 |
| `planReminderEnabled` | `true` | 规划时刻提醒 |
| `guidanceEnabled` | `true` | 注入使用协议到系统提示词 |
| `criticProvider` | `google` | 批评者提供方路由（独立于顾问管道） |
| `criticModel` | `gemini-3.8-flash` | 批评者模型 id |
| `criticEffort` | `medium` | 注入评审请求的思考深度；亦接受 `provider` |
| `enabled` | `true` | 本插件调用总开关；关闭取消在途顾问/评审，并禁止新调用与新回传 |
| `advisorTimeoutSeconds` | `180` | 单次 `ask_advisor` 顾问咨询总时限，10–600 秒 |
| `criticExploreEnabled` | `true` | 启用存疑后的受限文件核查；关闭后仍做纯草稿裁决 |
| `jevApiKey` | 未设置 | 原生秘密字段；官方默认接口可回退到 `TYPESAFE_API_KEY` |
| `jevEndpoint` | `https://api.typesafe.ai/v1/systemone` | 完整 HTTPS 接口地址，须兼容 TypeSafe systemone 协议 |
| `jevModel` | `jev-1.13.0` | 顾问与评审共用的 Jev 模型 ID |
| `jevEnabled` | `false` | 可选 Jev 证据检查；向配置服务（默认 TypeSafe）发送主张和已引用原文，展示分歧，不改主裁决 |
| `advisorJevEnabled` | `false` | 独立的顾问建议检查；顾问回答后，对照传入背景检查建议，与原回答一起返回主模型 |
| `criticTimeoutSeconds` | `180` | 评审唯一的执行预算：准备资料、存疑、核实共用总时限，10–600 秒 |
| `criticMaxTokens` | `16384` | 单条模型响应的大小保护，256–32768；存疑最多 4096，不限制模型请求次数 |
| `criticAdditionalRoots` | `[]` | 高级设置：明确允许核查的额外源码目录 |

高级设置 `criticAdditionalRoots` 默认为 `[]`，可添加明确允许核查的源码目录。旧 `criticExploreBudget` / `criticMaxRequests` 仍能加载，但不再限制请求次数。

## 兼容性与数据

- 本轮本地执行链验证 DSH **0.2.0-rc.2**；CI 固定覆盖 0.1.6-alpha.2、0.1.7-alpha.1 和 0.2.0-rc.2。升级前请核对 [设置迁移说明](docs/compatibility-017.md)。旧宿主缺少安全密钥元数据时 API 编辑区禁用，可使用官方接口的环境变量密钥。
- Node.js `^22.19.0` 或 `>=24.0.0`。受限文件捕获目前要求 Linux 与可访问的 procfs；浏览器界面不因此限定为 Linux。
- 需要 DSH 提供共享 Cordis、Typert、`dsh-subagent`、`dsh-llm` 和 `dsh-tools`，不能把 Ciel 当作独立 Host 运行。源码链接安装请读 [共享依赖说明](docs/compatibility-alpha2.md)。
- Ciel 使用 DSH 主题语义变量；默认与终末地玻璃的明暗模式、主题退出和插件卸载已做隔离 Web 回归。
- 记录保存在 `$DSH_HOME/ciel/v1/`，按会话、记录类型和标识关联，采用有界读取与原子写入。旧 `dsh-advisor` JSONL 历史不读取或迁移；设置升级另按 [迁移说明](docs/compatibility-017.md) 处理，不是记录迁移。
- 客户端最多缓存 8 个未使用会话、约 16 MiB 结果正文；显示中或请求中的会话会保留。这是缓存策略，不是整个浏览器内存上限，也不删除磁盘历史。

完整约束见 [评审契约](docs/review-contract.md)、[读取隔离](docs/read-isolation.md) 和 [容量与恢复决策](docs/architecture-decisions.md)。

支持 **设置 → 夏尔 Ciel → 常用设置 → 启用 Jev 证据检查 → 保存**，默认关闭。在 **Jev API 配置** 中填写 API Key、完整 HTTPS 接口地址和模型 ID，点击保存；密钥不回显，留空保留原值，清除覆盖后继承部署配置。仅官方默认接口允许回退到 `TYPESAFE_API_KEY`；自定义地址须另填该服务密钥。密钥保存在本机 DSH 配置，不是加密保险库。代码更新需重启 Host 并刷新页面，之后配置保存对下一次检查生效，无须再重启。保持文件核查开启；新评审的详情会显示支持、矛盾、证据不足，以及与主评审的分歧和证据链接。

开启会把可逐字核对的主张和已引用原文发送给配置的服务（默认 TypeSafe），产生额外用量。每次评审最多一个批量请求、8 条主张、24 KiB 状态；至多等待 10 秒，仍计入评审总时限。不重试，原文超限时跳过并说明原因。缺钥、接口失败或超时保留主评审结果；保存关闭会取消在途 Jev 检查。历史记录不补跑。配置、数据边界和独立实验见 [Jev 说明](docs/jev-evidence-experiment.md)。

顾问流程另有 **常用设置 → 启用顾问建议检查（Jev） → 保存**，独立开关、默认关闭。开启后流程为：顾问给出方向 → Jev 对照本次问题与背景检查 → 原建议和检查结果一起返回主模型，并保存到顾问详情。只检查背景一致性，不独立查证事实；“依据不足”不代表建议错误，主模型仍需验证后决定采用。

该检查共用上述 Jev API 配置，向所配置服务（默认 TypeSafe）发送本次问题、背景及完整建议原文，产生额外用量。每次咨询最多一次批量请求、6 条建议、24 KiB 状态，至多等待 10 秒且计入咨询总时限。超限或缺少结构化正文时明确跳过，不裁剪原文。缺钥、接口失败或检查超时保留顾问回答；保存关闭只取消该检查，历史建议不补跑。

## 开发与验证

根目录是开发包，`plugin/` 是发布包；`plugin/src/` 构建为 `plugin/client.js`。

```sh
pnpm install --frozen-lockfile
pnpm --dir plugin install --frozen-lockfile
pnpm check:docs
node scripts/build-client.mjs --check
node --test plugin/test/*.test.js

# 使用已构建的 DSH 检出；链接脚本只用于开发副本
DSH_CHECKOUT=/path/to/deepseek-harness node scripts/link-harness-peers.mjs
DSH_CHECKOUT=/path/to/deepseek-harness CIEL_VERIFY_NATIVE_PEERS=1 node scripts/verify-runtime.mjs
DSH_CHECKOUT=/path/to/deepseek-harness node scripts/verify-protocol.mjs
```

0.20.0 发布验证：**703 项单元测试、57 个真实 DSH 离线执行链场景、22 项原生侧栏检查通过**，包括设置持久化、密钥脱敏/清除和迁移验证。发布提交的 [三版本 CI](https://github.com/higekibaka/dsh-ciel/actions/runs/37063769171) 与 [发布流水线](https://github.com/higekibaka/dsh-ciel/actions/runs/37064758406) 均成功；npm 30 个发布文件逐字节匹配当时的候选，并带来源证明。

Jev API 设置的日常 GUI 在线验收仍未完成；这些离线测试没有重启日常 Host 或发出付费模型请求。之前的隔离 Web 检查是有日期/范围的独立证据，不证明所有新增功能已在线验收。详见 [文档索引与验证边界](docs/index.md)。Web 联调须使用独立 DSH_HOME；只换端口或 profile 不会隔离会话。

后续实现从 [当前架构](docs/architecture.md) 开始，用 [评审契约](docs/review-contract.md) 验收；历史版本记录见 [CHANGELOG](CHANGELOG.md)，设计动机见 [设计说明](docs/design.md)。

## 许可证

[MIT](LICENSE)
