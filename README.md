# dsh-ciel（夏尔）

> **0.11.0 起更名**：`dsh-advisor` → `dsh-ciel`（大贤者夏尔——《关于我转生变成史莱姆这档事》中主角的脑内参谋：不下场干活，只在关键节点给分析与方向）。更名只为避开与 [omdsh-dev/dsh-advisor](https://github.com/omdsh-dev/dsh-advisor) 的撞名；**settings 命名空间 `advisor`、sidecar 目录 `$DSH_HOME/dsh-advisor/`、消息标签 `[advisor:*]` 均为配置与数据连续性保留旧名**。

DeepSeek Harness（DSH）的**规划前顾问 + 收敛批评者**能力：在主模型制定计划之前，由一个知识分布不同的顾问模型提供思路、领域知识与陷阱清单——只给思路，不给步骤；另附每条助手回复的「批注评审」按钮，由批评者模型（gemini-3.7-flash）对草案做红线批注；0.10.0 起另有 `/advise` 人类命令（上下文自动装配 + 卡片 + 自动知会主模型）。

## 设计理念（一句话）

顾问模式的价值不在于"顾问更聪明"，而在于**引入分布多样性 + 分离探索与执行两种认知角色**，并用"只给思路"的约束把理解和落地的工作强制留在主模型身上。完整论证见 [docs/design.md](docs/design.md)。

## 仓库结构

```
plugin/       M2+M3③：树外 bundle 插件包（ask_advisor + 设置面板 + 批注评审）
prototypes/   原型快照（annotation-review = 批注评审的动态插件前身 + DOM 测试台）
scripts/      开发实例脚本
docs/         设计文档
```

> **M1 preset 轨道已暂停**（2026-08-20）：`preset/` 目录与 `scripts/install-preset.sh` 已从工作区移除（git 历史保留，恢复见 `git log --oneline -- preset/`），线上 `~/.dsh/.agent-presets/advisor/` 已卸载。当前只维护 bundle 形态；preset 的静态 `ask_advisor` 行会遮蔽 bundle 的全局工具，两者本就不可同用。

## 安装

### 插件包（带设置面板）

```sh
# 已安装的 dsh：
dsh plugin --profile web add /home/hgk/123/dsh-ciel/plugin
# 或源码 checkout 内：
pnpm dsh plugin --profile web add /home/hgk/123/dsh-ciel/plugin
```

重启 DSH 后生效。打开 **设置 → 插件 → 插件配置 → 夏尔 Ciel (dsh-ciel)** 即可可视化配置；改动即时保存、无需再重启。`ask_advisor` 工具与指导 prompt section 对所有 preset 的会话全局生效。

**批注评审（M3-③，0.3.0 起）**：每条助手回复的操作区出现「批注评审」按钮——点击后批评者子代理（`google/gemini-3.7-flash`，effort 固定 low）对该回复做收敛型红线评审；批注以 severity 波浪下划线 + 角标长在原文上，点击弹出批注卡，回复下方另有完整卡片面板。评审输入（**0.5.0** 起）= 回复正文 + 该轮用户请求与工具结果的**裁决摘要**——不含思维链与过程叙事：批评者证伪输出，不复盘作者心路，全知会使其与作者框架趋同、丧失第二模型的分布多样性（定位推导见 docs/design.md §6「批评者定位」）。评审记录自 **0.4.0** 起持久化在 sidecar 存储（`$DSH_HOME/dsh-advisor/reviews/<sessionId>.jsonl`），跨重启水合；0.3.x 曾写 `advisor/review` 自定义会话事件——harness 的 `Session.append()` 无法给事件信封打 `ignorable` 标记，加载路径又会拒绝一切目录外的非 ignorable 事件类型，导致写过该事件的会话日志被 `SessionFormatUnsupportedError` 整体拒载（实测锁死 5 条会话，已手术修复），故改为 sidecar，**不再往会话日志写任何东西**。host↔browser 走 typert Remote（host 注册 strict descriptor，client `$mount` 后调 `remote.advisorReview`）——两个 `@deepseek-ai/*` 导入（cordis / typert-protocol）经 `plugin/node_modules` 里指向共享 profiles 回退图的 symlink 解析，**不要往 package.json 里加这两个依赖**（重复副本会带自己的 registry 状态）。

## 配置项（设置面板 / settings.yaml 的 `advisor` 节）

| 字段 | 默认 | 说明 |
|---|---|---|
| `provider` | `kimi-coding` | 顾问提供方路由（须已在设置 → 模型 注册） |
| `model` | `kimi-for-coding` | 顾问模型 id；跨家族模型多样性收益更大 |
| `maxTokens` | `4096` | 顾问单次输出上限（256–32768） |
| `allowWebSearch` | `true` | 允许顾问使用 web_search 查证 |
| `guidanceEnabled` | `true` | 注入顾问使用协议到系统提示词 |

## 开发验证（独立测试实例，不动主 GUI）

```sh
pnpm dsh plugin --profile advisor-test add /home/hgk/123/dsh-ciel/plugin
# 首次需手工把 "@deepseek-ai/dsh-web-app" 加进 ~/.dsh/profiles/advisor-test/package.json 的 bundles
cd /home/hgk/deepseek-harness && pnpm dsh --profile advisor-test --patch /home/hgk/123/dsh-ciel/scripts/dev-instance.patch.yml
# 打开 http://127.0.0.1:3180 → 设置 → 插件 → 插件配置
```

## 路线图

- **M1**（⏸️ 已暂停）：自包含 preset——`ask_advisor` 工具（`dsh-tool-subagent` 实例）+ 指导 prompt section，零安装包。源码保留在 git 历史（最后见于暂停前提交），线上 roster 已卸载。
- **M2**（当前焦点）：`plugin/` 树外 bundle——定制工具描述、设置面板（host settings 命名空间 + `settings.plugin.item` 卡片）、全局指导 section。
- **M3**：plan mode 自动咨询钩子、`/advise` 命令、浏览器 UI 卡片。**已交付**：② 结构化思路输出（0.6.0——`## [tier] 标题` + `framing`/`pitfalls`/`verification_target` 字段小节的结构化 Markdown 契约；canonical value + `presentationMeta` 通道，调用方文本不变，结构随 `tool/result.meta` 供 UI 与批评者 rubric 取用；解析失败一律回退原文，结构是增强不是门槛）；③ 批评者评审（0.3.0 起，0.4.0 sidecar 化、0.5.0 证据面+自愈+点击定位）。

## 社区对照

- [omdsh-dev/dsh-advisor](https://github.com/omdsh-dev/dsh-advisor)：每轮被动评审的第二模型——触发哲学与本项目相反（系统驱动 vs 按需咨询）。**本项目 0.11.0 起更名 dsh-ciel 以避开撞名**。
- [Optim-Agent/dsh-plans](https://github.com/Optim-Agent/dsh-plans)：planning preset + criticizer 子代理——收敛型批评者，是本设计第⑥步的角色而非发散顾问。
