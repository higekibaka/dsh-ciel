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
- **开发流水线（2026-08-20 起执行）**：新能力一律先做动态插件原型（免重启、快速迭代、真实页面直验），**用户确认后才静态化进 bundle**——annrev 原型 → 0.3.0 的路径正式制度化。
- **关键约束**（`packages/preset/agent-presets/src/mount.ts`）：preset 行的 bare 包名解析到 harness 安装目录，相对路径解析到 preset 目录——preset 引用不了树外安装的插件包。因此 M1 只用发行版自带包 + preset 目录内文件，自包含可分发；M2 自写代码走 bundle/patch 安装到 host 层。

### M1 实现（纯组合，零安装包）

- `ask_advisor` 工具 = `@deepseek-ai/dsh-tool-subagent` 的第二个实例（README 明确"另一种模型/人格/工具面 = 另一个独立命名的工具实例"）：
  - `agentOptions`：覆盖子代理 provider/model/maxTokens；
  - `persona`：顾问人格（spawn provider 支持 `persona` capability）；
  - `toolFilter`：固定 `allow: []`——顾问不联网（见 §7"顾问不联网"）；
  - `maxDepth: 1`：绝对委派深度上限，按子代理计算深度（调用方深度 + 1）校验——准入顾问本身（深度 1），禁止顾问再委派（深度 2）；注意 `0` 会连顶层会话的咨询一起拒绝（`subagent depth 1 exceeds maxDepth 0`）。`enableRunInBackground: false`：同步咨询。
- 指导 section = preset 目录内 `advisor-section.mjs`（`boot-persona.mjs` 先例：注册 `ctx.systemPrompt` section，不发布服务，松散放置）。
- 追问通道 = 多次调用同一工具，纪律写在 section 文本。
- 失败降级 = 工具错误结果 + 指导文本明示"顾问不可用时自行规划"。

### M2 实现（树外 bundle 包，已完成）

官方 [develop/basic](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) 路径：`defineTool`（`@deepseek-ai/dsh-tools`）自写 `ask_advisor`，bundle manifest（`dsh.bundle` + `cordis.patch.yml`），纯 ESM JS 无构建步骤（绕开 git 安装的 prepare/allowBuilds 陷阱）。已实现形态（与早期设想的两处偏差均有理由）：

- **子代理走 `subagents.start('spawn')`，不直连 `ctx.llm.stream()`**：早期设想用 llm.stream 省子会话开销，但 spawn 路线才提供 persona capability、`toolFilter` 工具白名单、`maxDepth` 委派深度上限、独立子会话日志，以及错误透传依赖的 `run.localAgent.session.events` 回读通道。
- **`/advise` 命令归 M3**（与 §6 路线图一致），M2 不含命令面。
- 定制工具描述：触发判据（USE WHEN / SKIP）与归因条款内嵌，是 `complete: true` preset 下唯一不被压掉的模型可见面。
- Schemastery `Config` 全配置化：provider/model/maxTokens/maxCallsPerTurn/requireExploration/enforceFollowupGap/reasoningEffort/guidanceEnabled；`reasoningEffort` 经宿主级 `agent/request` waterfall 精确注入在册顾问子代理（`run.id` 集合过滤）。
- 指导 section 经 `ctx.inject(['systemPrompt'])` 注册——裸 `ctx.get` 会输掉启动竞速（服务 fiber 未 ACTIVE 时返回 undefined，section 静默丢失，实测发生）。
- 设置面板由 `plugin/client.js` 注册进 `settings.plugin.item` 槽位，命名空间经 `llm.registerConfigurableProviders` 暴露（见下节架构约束）。

## 5. 社区对照

| 项目 | 做法 | 与本设计的关系 |
|---|---|---|
| [omdsh-dev/dsh-advisor](https://github.com/omdsh-dev/dsh-advisor) | 第二模型每轮被动审查并注入批注 | 系统驱动、角色是评审——触发哲学相反；证明"第二模型注入"可行 |
| [Optim-Agent/dsh-plans](https://github.com/Optim-Agent/dsh-plans) | planning preset + reviewer/criticizer 子代理 | 证明 preset+子代理路线可行；其角色是收敛型批评者（本设计第⑥步），不是发散顾问 |
| [toolclub/dsh-agent-team-gui](https://github.com/toolclub/dsh-agent-team-gui) | 常驻多模型小队 | 团队协作，非按需咨询 |
| [cpj-dev/dsh-plugin-cc](https://github.com/cpj-dev/dsh-plugin-cc) | 桥接 Claude Code 做 review/critique | 外部产品当第二模型 |

结论：「规划前介入、只给思路、一次发散 + 预算追问」的形态目前无人实现；两个关键零件分别被 dsh-plans 与 dsh-advisor 验证过。

## 6. 路线图

- **M1**（已完成 → ⏸️ 2026-08-20 起暂停）：自包含 preset（原 `preset/`，已从工作区移除、git 历史保留，线上 `~/.dsh/.agent-presets/advisor/` 已卸载）；`maxDepth: 1` 修复后可用。暂停期间只维护 M2 bundle 形态。
- **M2**（已完成，经真实会话端到端验证）：树外 bundle 包（本仓库 `plugin/`）：定制工具描述、设置面板、全局指导 section；计划外加固了 `maxDepth`、`reasoningEffort` 注入与错误透传。
- **M3**：~~`outputSchema` 结构化思路~~（② 已落地 0.6.0：结构化 Markdown 契约——`## [tier]` 头 + framing/pitfalls/verification_target 字段；harness 工具契约的 canonical value + `presentationMeta` 通道让结构随 `tool/result.meta` 直达 UI 与批评者 rubric，解析一次处处可用；失败回退原文，结构是增强不是门槛。llm 层仍无 responseSchema，输出端维持 persona 指令 + 插件容错解析）、`/advise` 命令与一键触发（人类触发面）、批评者评审角色（③ 已交付并硬化，见下节）、浏览器 UI。规划时刻提醒已提前在 M2 落地（agent 级 context 行为信号版，见 §7"肯定判定的落点"）。

### 批评者定位：注意力提示，不是审计（M3-③ 交付后经 15 条真实评审实测收敛，2026-08-20）

- **与 review 的本质区别**：review 追求确认正确（assurance），权威来自证据准入，最怕漏报；批评者是对用户**注意力预算的分配提示**，最怕错报——错误提示不止无用，还偷走本该落在真问题上的怀疑、并可能误导（实测「截图不可行」错批注 ×2 即此）。习惯化（banner blindness）是该品类的死刑，「人类显式触发优先」（§3）天然防之：提示只出现在用户主动怀疑的时刻。
- **资源模型统一**：顾问防「没想到」，批评者防「信错句」；两者的数量上限（6 条思路 / 8 条批注）是同一注意力预算的两面，不是任意拍的数字。
- **批评者不应全知**：全知 = 与作者框架趋同（§2「自由对话→多样性蒸发」的对称形态），且稀释「author owns the remedy」。给的是**最小可证伪面**：草案 + 该轮用户请求 + 工具结果裁决摘要（isError/片段，不含全文）；思维链与过程叙事明确不给（锚定对称性——批评者评输出，不复盘作者心路）；批评者工具不给（§7 grounding 单一归属）。逃生门：需要读源码才能判的断言已出现首例（假 blocker：把 inbox 通路才有的轮次唤醒当成裸 append 的行为），样本不足不开门，再积累再议。
- **批注的用户指导意义 = 可行动性 × 可裁决性**：读完知道下一步做什么；自带用户 30 秒可核查的指针（commit、矛盾点、证据引用），而不是要求用户信任批评者。「不可查证」批注配给纪律：仅承重断言、至多 2 条、强制条件句式（「若 X 不成立…先核实」），禁事实语气；产品能力事实（图片附件、操作区插件、bundle 重启 vs 动态热更）直接注入 persona，消灭知识缺失型错报。
- **实测账单**：干货簇多次命中真 bug——pkg 版本自相矛盾、失败诊断循环论证（均被 HANDOFF 根因事后证实）、已删脚本（git 证实）、「starting≠激活成功」（与 harness 语义一致）；废话簇集中于盲区断言事实化 + 产品知识缺失，均为 persona 级修复，不需架构升级。可靠性缺口另计：3/15 评审 spawn 失败或未解析。
- **修复回路**：主模型看不到评审，用户是批评者发现 → 作者修复之间的过滤器；「回传主模型」按钮（用户勾选制）是规划中的下一面——勾选行为同时提供注意力投放质量的地面真值，成为调 prompt/证据面的评估回路。

### M2 设置面板的两个架构约束（已核实）

1. **settings 命名空间是 host 平面**：preset 挂载的插件不能注册 settings 命名空间（见 `dsh-client-ui-settings-plugins` README），所以设置面板必须由 host 层 bundle 插件承载，不能由 preset 承担。
2. **命名空间暴露在 apiproxy 是硬编码白名单 + 可配置 provider 目录**：外部插件无法让 apiproxy 直接放行自己的命名空间，但 `ctx.llm.registerConfigurableProviders([{ settingsNs: 'advisor', ... }])` 会让该命名空间随"模型提供方"通道被 serve——dsh-vision-router 用同一 seam 暴露了其设置区。客户端卡片注册进 `settings.plugin.item` 槽位，经 `settingsScope.bind({ namespace })` 读写（修订号围栏写、写后回读确认）。

## 7. 风险与边界情况

- **顾问幻觉**：领域知识可能貌似合理实则错误——协议要求主模型对照真实环境验证，追问必须带新事实。
- **选择过载**：思路太多稀释注意力——输出契约限制条数与长度，`maxTokens` 硬上限。
- **同质化**：顾问与主模型同家族时边际收益小——配置项允许换跨家族路由。
- **KV cache**：新增 section 与工具 schema 改变 prompt 前缀（一次性成本）。
- **安全边界**：spawn 子代理自动继承 sandbox override、审批固定 never；顾问 `toolFilter` 固定空表，不持有任何工具。
- **顾问不联网**（已决策）：时效性事实由主模型先自行查证、作为已探明事实经 `context` 传入——grounding 单一归属，顾问的分布外多样性不被与主模型相同的 web 共识重新锚定，时延与上下文成本也随之消除。顾问幻觉风险被压到只剩框架层，而那层的验证本来就走主模型的批判筛选。persona 要求顾问在问题依赖未供给的时效事实时于开头声明局限。
- **置信度分档**（已决策）：persona 要求每条思路带 `[high]/[mid]/[low]` 标签（共识 / 有依据但依情境 / 推测或类比迁移），禁止数字分数——LLM 口头概率系统性过度自信，虚假精度比没有更糟；标签的用途是帮主模型分配验证精力，不是精确概率。logprob 级真置信在 spawn 管道与 Gemini 路由上均不可得；自一致性采样违背多样性目标，均不采用。
- **机制化否定判定**（M2 已实现，M1 无此通道）：四条门把协议形状变成硬约束——`context` 必填（schema required）、每 turn 调用额度（`maxCallsPerTurn` 默认 3 = 1 发散 + 2 追问）、探索门（`requireExploration`：会话内首次咨询前须已有非顾问工具调用）、追问间隔门（`enforceFollowupGap`：同 turn 两次咨询间须有独立工作动作）。门状态从调用方 `session.events` **无状态回读**（以 settled 的 tool/result 计数，在途调用不自锁；遥测不可读时 fail-open 退回 prompt 纪律）。**只有真实咨询计入额度与间隔**：被门拒绝的调用是表单错误而非咨询，按结果文本前缀识别并排除——C5 实测空 context 的拒绝曾误毒化紧随其后的合规重试；但通过门之后在 provider 处失败的咨询照计（防重试风暴）。"该不该问"仍是语义判断、留在 prompt 层——机制只强制"什么时候不许问"。规格错误不经顾问：事实冲突交给证据，取舍冲突交给用户，顾问只在修正重新打开设计空间时进场。
- **肯定判定的落点**（已决策 B，M2 已实现）：机制读不懂任务内容，改判调用方**行为**——每个 agent 创建时（`agent/created`）注册一个 **agent 级 prompt context**，其 text 在每次装配时自求值：本 turn 出现规划信号（`todo_write` / `exit_plan_mode`）、无 `ask_advisor` 调用、且本 turn 快照日志中尚无提醒自带标记时，渲染提醒文本（否则空串=不出现），每 turn 至多一次。条件全部读持久会话日志，免疫压缩与重启。实现教训：**`system-prompt/assemble` waterfall 是 scope 过滤分发，host 监听器收不到 preset 挂载 agent 的装配**（动态探针实证：同一代码路径在 cordis preset agent 上触发、在 minimal-v5 会话上不触发），而 agent 级 context 走 agent 自己的 scope 层，且穿透 complete preset（sections 被压、contexts 保留，runtime 快照信道在 minimal-v5 会话实测存在）。判据不消失，只是从静态系统提示移到决策点动态出现。升级路径：C（便宜分类器判任务、必要时宿主代跑顾问注入结果）留作实测仍漏触发后的选项——注意那是"常驻评审"的哲学转向；D（`/advise` 命令等人类触发面）在 M3。
- **陌生领域协议**（③ 决定的残余风险，已补）：陌生领域不需要顾问联网，需要**调用方先研究**——guidance HOW(1) 要求"领域陌生时先做一次研究并把摘要经 context 传入"（黑洞 GR 光线追踪咨询实测：主模型自备推导公式与积分器验证，顾问零工具输出六条正确思路）；persona 诚实条款兜底垃圾进：知识范围外明说、相关条目挂 `[low]`、禁编造具体名称/链接/版本/文献。逃生门：若实测出现陌生领域幻觉，加 per-call `research` 布尔临时放开该次咨询的 web_search——无知领域里 web 共识好过编造，多样性损失在那里最小。
- **触发边界文本**（已统一，随 B 同批落地）：工具描述与 guidance 判据取并集（开放设计空间=架构/场景美学构图/技术选型/数据建模；陌生领域；不可逆决策；困难诊断失败两轮）；消歧"判决策空间、不判 prompt 篇幅"（一句话可藏大设计，长规格可藏零决策）；a′ 条款（规格错误不经顾问）；频次上限（每规划阶段一次 + 至多两追问）进入工具描述——complete preset 下唯一可见面现在自带全部判据与预算。
- **压缩丢失**：顾问输出作为工具结果可能被 `tool-result-pruner` 裁剪——协议要求计划正文注明采纳思路，形成第二载体。
- **子代理思考级别缺省**（已修）：`AgentOptions` 不带 effort，显式选型的子代理请求退回 provider 默认思考行为——pi-ai 对"无 effort"的 Gemini-3-Flash 映射出 `MINIMAL` thinkingLevel，而 gemini-3.7-flash 的 API 拒绝该级别（400）。M2 的 `reasoningEffort` 配置通过宿主级 `agent/request` waterfall 精确注入在册顾问子代理（payload 携带 subject agent，`run.id` 集合过滤）；`provider` 档位不触碰请求。M1（tool-subagent 实例）无此注入通道，只能靠 provider profile 的 `reasoning` 默认值兜底；M1 同样无法定制工具描述（tool-subagent 的 description 由 providerWording 固定生成），触发判据只在 M2 的描述文本里。
- **触发依赖工具描述**（已加固）：`complete: true` 的 preset（如 minimal-v5）会丢弃 guidance section，模型只能看到工具描述——实测"创建 3D 体素场景"这类开放设计任务未触发咨询。因此触发判据（USE WHEN 开放设计空间/陌生领域/不可逆决策，SKIP 机械任务）与归因条款直接写进 M2 的工具描述：工具 schema 是唯一不被 complete prompt 压掉的模型可见面。
- **错误透传**（已增强）：`SubagentResult` 只有 `stopReason`，模型/传输 400 细节原本丢失；M2 在 `stopReason === 'error'` 时经 `run.localAgent.session.events` 回读子代理末次 `turn/end` 的错误消息（嵌套 JSON 信封逐层解开、截断 300 字符），拼进工具错误。
