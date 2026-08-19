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

## 安装

### 方式一：插件包（推荐，带设置面板）

```sh
# 已安装的 dsh：
dsh plugin --profile web add /home/hgk/123/dsh-advisor/plugin
# 或源码 checkout 内：
pnpm dsh plugin --profile web add /home/hgk/123/dsh-advisor/plugin
```

重启 DSH 后生效。打开 **设置 → 插件 → 插件配置 → 顾问 (dsh-advisor)** 即可可视化配置；改动即时保存、无需再重启。`ask_advisor` 工具与指导 prompt section 对所有 preset 的会话全局生效。

### 方式二：preset（零安装包的静态形态）

```sh
./scripts/install-preset.sh
```

然后在新建会话时选择 **顾问模式** preset。改配置需编辑 `preset/agent.cordis.yml` 后重新运行该脚本。

> **两种方式不要同时用**：advisor preset 内的静态 `ask_advisor` 行会在其作用域内遮蔽插件的全局工具，导致设置面板对该 preset 的会话不生效。

## 配置项（设置面板 / settings.yaml 的 `advisor` 节）

| 字段 | 默认 | 说明 |
|---|---|---|
| `provider` | `kimi-coding` | 顾问提供方路由（须已在设置 → 模型 注册） |
| `model` | `kimi-for-coding` | 顾问模型 id；跨家族模型多样性收益更大 |
| `maxTokens` | `4096` | 顾问单次输出上限（256–32768） |
| `allowWebSearch` | `true` | 允许顾问使用 web_search 查证 |
| `guidanceEnabled` | `true` | 注入顾问使用协议到系统提示词 |

preset 静态形态的同名字段在 `preset/agent.cordis.yml` 的 `tool-advisor` 行。

## 开发验证（独立测试实例，不动主 GUI）

```sh
pnpm dsh plugin --profile advisor-test add /home/hgk/123/dsh-advisor/plugin
# 首次需手工把 "@deepseek-ai/dsh-web-app" 加进 ~/.dsh/profiles/advisor-test/package.json 的 bundles
cd /home/hgk/deepseek-harness && pnpm dsh --profile advisor-test --patch /home/hgk/123/dsh-advisor/scripts/dev-instance.patch.yml
# 打开 http://127.0.0.1:3180 → 设置 → 插件 → 插件配置
```

## 路线图

- **M1**：自包含 preset——`ask_advisor` 工具（`dsh-tool-subagent` 实例）+ 指导 prompt section，零安装包。
- **M2**（当前）：`plugin/` 树外 bundle——定制工具描述、设置面板（host settings 命名空间 + `settings.plugin.item` 卡片）、全局指导 section。
- **M3**：plan mode 自动咨询钩子、结构化思路输出、`/advise` 命令、批评者评审角色（③ 已有实测原型：[`prototypes/annotation-review/`](prototypes/annotation-review/)——按钮触发 + 锚定批注 + 行内波浪线/角标/弹出卡，DOM 测试台 14 断言全绿）。

## 社区对照

- [omdsh-dev/dsh-advisor](https://github.com/omdsh-dev/dsh-advisor)：每轮被动评审的第二模型——触发哲学与本项目相反（系统驱动 vs 按需咨询）。
- [Optim-Agent/dsh-plans](https://github.com/Optim-Agent/dsh-plans)：planning preset + criticizer 子代理——收敛型批评者，是本设计第⑥步的角色而非发散顾问。
