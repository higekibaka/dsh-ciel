# dsh-advisor

DeepSeek Harness（DSH）的**规划前顾问**能力：在主模型制定计划之前，由一个知识分布不同的顾问模型提供思路、领域知识与陷阱清单——只给思路，不给步骤。

## 设计理念（一句话）

顾问模式的价值不在于"顾问更聪明"，而在于**引入分布多样性 + 分离探索与执行两种认知角色**，并用"只给思路"的约束把理解和落地的工作强制留在主模型身上。完整论证见 [docs/design.md](docs/design.md)。

## 仓库结构

```
preset/     M1：自包含 agent preset（复制安装到 ~/.dsh/.agent-presets/advisor/）
plugin/     M2：树外 bundle 插件包（dsh plugin add 安装，定制工具与命令）
scripts/    安装与同步脚本
docs/       设计文档
```

## 安装（M1 preset）

```sh
./scripts/install-preset.sh
```

然后在 DSH Web GUI 新建会话时选择 **顾问模式** preset。

## 配置

顾问模型在 `preset/agent.cordis.yml` 的 `tool-advisor` 行中配置：

| 字段 | 默认 | 说明 |
|---|---|---|
| `agentOptions.provider` | `kimi-coding` | 顾问路由（须是 settings 中已注册的 provider） |
| `agentOptions.model` | `kimi-for-coding` | 顾问模型；跨家族模型多样性收益更大 |
| `agentOptions.maxTokens` | `4096` | 顾问单次输出上限 |
| `toolFilter.allow` | `[web_search]` | 顾问可用工具；`[]` 为纯参数知识 |

## 路线图

- **M1**（当前）：自包含 preset——`ask_advisor` 工具（`dsh-tool-subagent` 实例）+ 指导 prompt section，零安装包。
- **M2**：`plugin/` 树外 bundle——定制工具描述、直连 `llm.stream` 的轻量调用、`/advise` 命令。
- **M3**：plan mode 自动咨询钩子、结构化思路输出、批评者评审角色。

## 社区对照

- [omdsh-dev/dsh-advisor](https://github.com/omdsh-dev/dsh-advisor)：每轮被动评审的第二模型——触发哲学与本项目相反（系统驱动 vs 按需咨询）。
- [Optim-Agent/dsh-plans](https://github.com/Optim-Agent/dsh-plans)：planning preset + criticizer 子代理——收敛型批评者，是本设计第⑥步的角色而非发散顾问。
