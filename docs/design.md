# dsh-advisor 设计文档

## 1. 问题与动机

主模型自己制定计划时，候选方案受限于其自回归生成的路径依赖——它能想到的，集中在训练分布里高概率的方案模板附近。顾问模式在**规划阶段**引入一个知识分布不同的模型，专门提供可能带来启发的思路与达成目标的方法。

核心判断：顾问模式的价值不在于"顾问更聪明"，而在于三件事——

1. **引入分布外采样（多样性）**：不同训练分布的模型能采样到主模型低概率但高价值的候选方向。多智能体辩论（[Du et al., 2023](https://arxiv.org/abs/2305.14325)）与 Mixture-of-Agents（[Wang et al., 2024](https://arxiv.org/abs/2406.04692)）都验证过多模型聚合超过单一模型。
2. **分离探索与执行**：规划者与执行者分离，缓解主模型对"自己想的计划"的承诺与锚定偏差；主模型对顾问思路做筛选、批判、翻译，而不是辩护。
3. **低成本买候选空间**：顾问只在规划期调用一两次、输出受限长，是性价比很高的 test-time compute 形式。

### "只给思路，不给步骤"是设计而非让步

- 顾问不了解具体环境（代码库、工具、约束），其具体步骤大概率水土不服；抽象层的思路（原理、模式、类比、陷阱、评估维度）可迁移性强得多。
- 主模型必须把思路翻译成自己语境下的可执行步骤——翻译过程就是理解过程，无法外包，防止搬运式执行（cargo-culting）。
- 思路清单紧凑，注入规划 prompt 的上下文成本低。

## 2. 单次 vs 多轮：追问协议

| 形态 | 问题 |
|---|---|
| 纯单次 | 首次回答打偏无法纠正；探查后浮现的具体知识缺口无法补问 |
| 自由对话 | 多样性蒸发（几轮后趋同）、顾问侧承诺偏差、责任稀释（顾问事实上共同撰写计划）、无终止条件 |

**采用协议：一次发散 + 有预算的定向追问。**

```
① 发散咨询（一次）   → 思路、框架、领域知识、陷阱      （产生多样性）
② 主模型独立工作     → 探查环境、验证事实、搭计划骨架   （理解与落地）
③ 定向追问（≤2 次）  → 只问具体知识缺口，不回传草案    （补根基）
④ 主模型独立完成计划  → 注明采纳/拒绝了哪些思路及理由   （所有权）
```

三条契约约束第③步：

1. **追问由问题驱动，不由草案驱动**。"方案 B 的常见失败模式是什么"合法；"这是我的草稿你怎么看"不合法——后者是评审角色（不同契约，可见草案，见 §6 M3）。
2. **追问有硬预算**：每个规划阶段 ≤2 次。
3. **每次追问必须带上新探明的事实**——让主模型的环境根基回流，是纠正顾问幻觉的唯一机制。

追问走**新的无状态调用**（主模型自行筛选携带的上下文），顾问不被自己的历史锚定。

## 3. 工作流：顾问在生命周期的哪里介入

```
用户提出任务
   │
   ▼
① 轻量分类：缺的是"信息"还是"知识"？
   │     信息缺口（代码在哪、现状如何）→ 自己探查，不问顾问
   │     知识缺口（领域先例、方案空间、方法论）→ 进入顾问流程
   ▼
② 先探查，后咨询（顺序关键：无根基的咨询只能得到正确的废话）
   ▼
③ 发散咨询（ask_advisor 一次）：目标 + 已探明事实 + 约束 + 输出契约
   ▼
④ 主模型消化：筛选 → 对照环境验证 → 搭计划骨架
   ├── 具体知识缺口？──≤2 次──▶ 定向追问（带新事实）
   ▼
⑤ 主模型独立完成计划，注明采纳/拒绝及理由
   ▼
⑥（可选，M3）批评者评审：看得见草案的收敛型角色，专挑漏洞
```

介入窗口：**探查之后、成型之前**。太早得到泛泛建议；太晚主模型已有承诺偏差。

### 触发权三个来源（优先级递减）

1. **人类显式触发**：用户直接要求"先问问顾问"——精度最高；
2. **模型自主触发（默认）**：工具目录里的 `ask_advisor` + 指导 section 中的判据；
3. **系统自动触发（M3 才考虑）**：生命周期钩子最钝，读不懂任务内容，会污染不需要的会话。

### 触发判据

**该咨询**（满足其一且任务规模够大）：方案空间开放（架构/选型/数据模型）；陌生领域；高不可逆性（迁移、对外契约）；疑难排障（常规手段失败两轮以上）。

**不该咨询**：答案就在环境里；模式固定的机械任务；小型任务（咨询往返成本超过任务本身）。

## 4. harness 架构映射

### 平面归属

- **不进 host composition**：顾问能力不跨会话共享、不发布服务，是一个会话贡献给注册表的工具 + prompt section——正是 agent preset 的定义域。
- **不停留在动态插件**：进程重启即消失，只适合原型验证。
- **关键约束**（`packages/preset/agent-presets/src/mount.ts`）：preset 行的 bare 包名解析到 harness 安装目录，相对路径解析到 preset 目录——preset 引用不了树外安装的插件包。因此 M1 只用发行版自带包 + preset 目录内文件，自包含可分发；M2 自写代码走 bundle/patch 安装到 host 层。

### M1 实现（纯组合，零安装包）

- `ask_advisor` 工具 = `@deepseek-ai/dsh-tool-subagent` 的第二个实例（README 明确"另一种模型/人格/工具面 = 另一个独立命名的工具实例"）：
  - `agentOptions`：覆盖子代理 provider/model/maxTokens；
  - `persona`：顾问人格（spawn provider 支持 `persona` capability）；
  - `toolFilter`：工具白名单（`allow: [web_search]` 或 `[]`）；
  - `maxDepth: 0`：顾问不得再委派；`enableRunInBackground: false`：同步咨询。
- 指导 section = preset 目录内 `advisor-section.mjs`（`boot-persona.mjs` 先例：注册 `ctx.systemPrompt` section，不发布服务，松散放置）。
- 追问通道 = 多次调用同一工具，纪律写在 section 文本。
- 失败降级 = 工具错误结果 + 指导文本明示"顾问不可用时自行规划"。

### M2 实现（树外 bundle 包）

官方 [develop/basic](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) 路径：`defineTool`（`@deepseek-ai/dsh-tools`）自写 `ask_advisor`——定制描述、直连 `ctx.llm.stream()`（省子会话开销）、Schemastery `Config` 全配置化；`/advise` 命令走 `ctx.commands`。bundle manifest（`dsh.bundle` + `cordis.patch.yml`），纯 ESM JS 无构建步骤（绕开 git 安装的 prepare/allowBuilds 陷阱）。

## 5. 社区对照

| 项目 | 做法 | 与本设计的关系 |
|---|---|---|
| [omdsh-dev/dsh-advisor](https://github.com/omdsh-dev/dsh-advisor) | 第二模型每轮被动审查并注入批注 | 系统驱动、角色是评审——触发哲学相反；证明"第二模型注入"可行 |
| [Optim-Agent/dsh-plans](https://github.com/Optim-Agent/dsh-plans) | planning preset + reviewer/criticizer 子代理 | 证明 preset+子代理路线可行；其角色是收敛型批评者（本设计第⑥步），不是发散顾问 |
| [toolclub/dsh-agent-team-gui](https://github.com/toolclub/dsh-agent-team-gui) | 常驻多模型小队 | 团队协作，非按需咨询 |
| [cpj-dev/dsh-plugin-cc](https://github.com/cpj-dev/dsh-plugin-cc) | 桥接 Claude Code 做 review/critique | 外部产品当第二模型 |

结论：「规划前介入、只给思路、一次发散 + 预算追问」的形态目前无人实现；两个关键零件分别被 dsh-plans 与 dsh-advisor 验证过。

## 6. 路线图

- **M1**：自包含 preset（本仓库 `preset/`）。
- **M2**：树外 bundle 包（本仓库 `plugin/`）：定制工具描述、直连 `llm.stream`、`/advise` 命令。
- **M3**：plan mode 自动咨询钩子（`agent/pre-step` / plan 事件）、`outputSchema` 结构化思路、批评者评审角色（参考 dsh-plans）、浏览器 UI。

## 7. 风险与边界情况

- **顾问幻觉**：领域知识可能貌似合理实则错误——协议要求主模型对照真实环境验证，追问必须带新事实。
- **选择过载**：思路太多稀释注意力——输出契约限制条数与长度，`maxTokens` 硬上限。
- **同质化**：顾问与主模型同家族时边际收益小——配置项允许换跨家族路由。
- **KV cache**：新增 section 与工具 schema 改变 prompt 前缀（一次性成本）。
- **安全边界**：spawn 子代理自动继承 sandbox override、审批固定 never；顾问允许 `web_search` 无需审批。
- **压缩丢失**：顾问输出作为工具结果可能被 `tool-result-pruner` 裁剪——协议要求计划正文注明采纳思路，形成第二载体。
