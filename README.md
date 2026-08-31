# dsh-ciel（夏尔）

[![npm version](https://img.shields.io/npm/v/dsh-ciel)](https://www.npmjs.com/package/dsh-ciel)
[![license](https://img.shields.io/npm/l/dsh-ciel)](./LICENSE)

[English](./README.en.md) | **中文**

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的**规划前顾问 + 收敛批评者**：在主模型制定计划之前，由一个知识分布不同的顾问模型提供思路、领域知识与陷阱清单——只给思路，不给步骤；另附每条助手回复的「批注评审」按钮，由批评者模型（默认 `google/gemini-3.7-flash`）对草案做红线批注。命名灵感：《关于我转生变成史莱姆这档事》中主角的脑内参谋大贤者夏尔。

顾问模式的价值不在于"顾问更聪明"，而在于**引入分布多样性 + 分离探索与执行两种认知角色**，并用"只给思路"的约束把理解和落地的工作强制留在主模型身上。完整论证见 [docs/design.md](docs/design.md)。

## 工作流程

```text
                        ┌──────────────── 主模型（探索 + 执行）────────────────┐
                        │                                                      │
 用户请求 ──▶ 探查（读/搜/跑）──┐                                          │
                        │      └─ 规划时刻仍未咨询？──▶ 注入一次提醒 ──┐      │
                        │                                            ▼      │
                        │                                   ask_advisor ────┼──▶ 顾问模型
                        │                                            │      │   （第二模型 ·
                        │                                            │      │    只给思路）
                        │ ◀── 思路 · 先例 · 陷阱 · 验证清单 ──────────┘      │
                        ▼                                                      │
                  自己定计划、自己落地 ──▶ 回复草稿 ──┐                       │
                        │                            │ 「批注评审」按钮      │
                        │                            ▼                      │
                        │                     批评者模型（收敛红线）          │
                        │                            │                      │
                        │ ◀── severity 批注长在原文 ───┘                      │
                        ▼                                                      │
                  一键回传，按批注修正 ──▶ 终稿 ──▶ 用户                     │
                        └──────────────────────────────────────────────────────┘
```

两条管道刻意**角色分离**：

```text
  发散（规划前）                    收敛（成稿后）
  ─────────────                    ─────────────
  顾问管道                          批评者管道
  ask_advisor · /advise            批注评审
  思路 · 先例 · 陷阱 · 验证清单      红线批注 · severity 分级
  只给方向，不下场                  证伪输出，不复盘心路
  开阔主模型的解空间                收窄成稿的风险面
```

## 功能

- **`ask_advisor` 工具**——一次同步咨询：思路、先例、陷阱、验证清单；受「先探查后咨询」门与追问预算约束。
- **指导 prompt section**——咨询协议注入系统提示词（可开关）。
- **批注评审**——每条助手回复操作区的「批注评审」按钮：批评者对草案做收敛型红线评审，批注以 severity 波浪下划线 + 角标长在原文上，另有完整评审面板；评审记录持久化、跨重启水合。
- **`/advise` 命令**——人类触发咨询：上下文自动装配、结果卡片、自动知会主模型。
- **设置卡片**——设置 → 插件 → 插件配置 → 夏尔 Ciel，热生效无需重启。

<p align="center">
  <img src="https://github.com/higekibaka/dsh-ciel/raw/main/docs/images/advise-card.png" width="560" alt="结构化顾问卡片：分档条目带思路、陷阱与验证目标">
</p>
<p align="center">
  <img src="https://github.com/higekibaka/dsh-ciel/raw/main/docs/images/ciel-card-groups.png" width="47%" alt="设置卡片折叠为分组，闭组显示当前路由摘要">
  <img src="https://github.com/higekibaka/dsh-ciel/raw/main/docs/images/ciel-card-critic.png" width="47%" alt="批评者分组展开：由实时模型目录供给的 provider/model 下拉">
</p>

## 安装

```sh
dsh plugin --profile web add dsh-ciel
```

重启 DSH 后生效：工具与指导 section 对所有 preset 全局可用，设置卡片出现在 **设置 → 插件 → 插件配置**。

> 从 dsh-advisor（≤ 0.10.x）升级？`settings.yaml` 里的 `advisor:` 节会在首次启动时**自动迁入**新的 `ciel` 命名空间；旧节保留不删，可随时手工移除。

## 配置项（`ciel` 命名空间）

| 字段 | 默认 | 说明 |
|---|---|---|
| `provider` | `kimi-coding` | 顾问提供方路由（须已在设置 → 模型 注册） |
| `model` | `kimi-for-coding` | 顾问模型 id；跨家族模型多样性收益更大 |
| `reasoningEffort` | `provider` | 注入每次咨询的思考深度；`provider` 跟随提供方默认 |
| `maxTokens` | `4096` | 顾问单次输出上限（256–32768） |
| `maxCallsPerTurn` | `3` | 每轮咨询额度：1 次发散 + 追问预算 |
| `requireExploration` | `true` | 首次咨询前要求先探查 |
| `enforceFollowupGap` | `true` | 追问之间要求独立工作 |
| `planReminderEnabled` | `true` | 规划时刻提醒 |
| `guidanceEnabled` | `true` | 注入使用协议到系统提示词 |
| `criticProvider` | `google` | 批评者提供方路由（独立于顾问管道） |
| `criticModel` | `gemini-3.7-flash` | 批评者模型 id |
| `criticEffort` | `medium` | 注入评审请求的思考深度；亦接受 `provider` |

## 兼容性

- DSH **≥ 0.1.0-rc.7**（keyed `settings.plugin.item` 槽）；在 **0.1.2-alpha.1** 上开发与验证。
- Node.js ≥ 22。
- 可与 [omdsh-dev/dsh-advisor](https://github.com/omdsh-dev/dsh-advisor) 共存：0.11.0 起设置命名空间迁至 `ciel`，两插件可同装。

## 开发验证（独立测试实例，不动主 GUI）

```sh
dsh plugin --profile advisor-test add /path/to/dsh-ciel/plugin
pnpm dsh --profile advisor-test --patch /path/to/dsh-ciel/scripts/dev-instance.patch.yml
# 打开 http://127.0.0.1:3180 → 设置 → 插件 → 插件配置
```

单元测试：在 `plugin/` 下 `node --test`。

## 许可证

[MIT](./LICENSE) © hgk
