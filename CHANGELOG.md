# Changelog

All notable changes to dsh-ciel are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.19.0] - 2026-09-19

### Removed

- 移除 `/advise` 人工咨询命令、专用命令卡片、自动上下文装配和结果回注；顾问咨询保留 `ask_advisor` 工具。已有命令/顾问记录不删除，历史记录读取接口保持兼容。Host 需重新加载、浏览器需刷新后生效。

### Fixed

- Host/Client 共用实际请求/返回校验，修复 strict codec 仅透传值的边界；Ciel 主动验证 DSH alpha.2 不校验的返回值及所属会话。坏结构明确报协议错误并暂停同步，不伪装空历史或结束。
- 页面历史加载期间多次强制刷新合并成一次后续新加载；卸载后的迟到成功/失败不回填缓存。未使用会话结果按 LRU 保留最多 8 个、16 MiB 正文估算，在用及在途会话 pin，释放后可重新读取；不删除历史。
- 顾问记录在原子发布前检查取消/停用，评审资料清理异常不会阻断在途 registry 的最终释放。

- 评审请求按目标回复前的消息替换关系读取：原生嵌套压缩保留可核对的真人原文，未关联的替换不回带已撤销输入；原生 goal 续跑按目标 ID/版本承接真人要求及补充，改目标后不串用旧要求。分叉只读子会话前缀，旧回复不受后来的消息影响。未纳入的图片/附件及其他上下文不足有具体原因提示，并降低覆盖范围。
- 评审请求按消息来源筛选，只把目标回复之前、对应轮次的真人输入作为任务要求；动态上下文、其他代理和目标续跑文本不再冒充用户请求。旧 `/advise` 回注按生成身份、完整包装和历史命令记录识别，关联成功时恢复原真人任务及命令问题，顾问原文始终不进入存疑；关联不明、来源缺失或输入截断时明确标为上下文受限，提示补充请求，不宣称完整核实。
- 规划提醒与顾问额度门共用咨询状态：表单/准入拒绝不占额度、不抑制提醒；在途及已接受调用抑制重复提醒；只用宿主实际生成的提醒快照判断“已经提醒”，不会因用户引用标记而漏提醒。
- 修复分叉会话复用 messageId 时串用评审：Host/Client 共用会话与消息复合键，迟到结果只回写来源会话。
- 修复取消已获接受后仍提交正常评审的竞态：summary 原子发布前设同步提交边界，提交阶段明确返回取消已太晚。
- 进度故障改为最多四次连续探测、退避后暂停，永久能力错误立即暂停；新增显式同步重试，Remote 注册失败及服务更换可恢复。
- restricted 初始化错误按依赖、接口、服务就绪、守卫、运行时与工具注册分类，脱敏代码/阶段经 Host 返回并保存，保持受限执行。
- 原文批注角标使用原生按钮、可访问名称与焦点样式；浅色收件箱会话标识改用正文辅助语义色。
- 适配 DSH 0.1.6-alpha.2 的严格 Remote 编解码器工厂：前后端评审与收件箱接口提供 `create()`，同时保留旧版 `schema`。修复 `评审记录未完整加载 · review remote unavailable`；不涉及记录格式迁移。

### Added

- 提取 ReviewCoordinator / ReviewRepository、顾问咨询状态、内容解析、Client ReviewState / progress scheduler 和 DOM 锚点模块；保持私有受限运行时、宿主证据回执及原有取消提交点。仓储支持注入 I/O 故障，不需要修改全局 fs。
- 增加当前 DSH Registry/Gateway 协议回归 `scripts/verify-protocol.mjs`，以及 [架构现状](docs/architecture.md) 和 [容量/部署/恢复决策](docs/architecture-decisions.md)。
- CI 固定到本轮验证的 DSH 0.1.6-alpha.2，检查共享 peer 身份和实际协议；原生侧栏验证脚本使用当前会话保留接口。

- [架构检查与演进方向](docs/architecture.md)：记录消息身份、终态提交、错误与资源所有权约束，以及后续职责拆分和容量策略。
- **夏尔收件箱首版**（原生左栏入口/中央面板、后端服务、RPC 与测试；不含 GUI 验收结论）。新增独立 `inbox` 记录类型与 `advisorReview.inboxList` / `advisorReview.inboxSetIntent` 两个严格 Remote 描述符：列表读取既有评审记录并返回有界投影（默认且最多每页 25 条；计数与筛选仅针对当前页），每条批注带 `pending`（待判断）/ `planned`（准备处理）/ `rejected`（暂不采纳）意向。
- 意向是收件箱自己的标记，**不是修复动作**：不驱动模型、不修改输入草稿，也不复用旧的 accept/dismiss 勾选；旧 `feedback` 状态既不迁移也不读取。
- 意向写入以服务端内容指纹 `reviewFingerprint` 加每条评审的 `revision` 做比较并交换；存量指纹与当前评审不一致时，读取与写入都显式失败（`fingerprint_mismatch`），不做隐式重置或落基。

### Verification

- 单元测试 **605/605**，当前 DSH **0.1.6-alpha.2** 实际受限执行链 **52/52**；执行链使用脚本模型、网络 0。真实 Registry/Gateway 协议校验和隔离 Web 的评审、收件箱、分叉、刷新、主题、协议故障及启停验证通过，Node **24.21.0**。
- 源码与生成 Client 一致，发布包包含全部 Host 模块。未进行真实 provider 质量/成本验证，也未启动或重启日常 DSH；安装后的 Host 变更需下次启动并刷新页面生效。

### Notes

- 列表只覆盖当前会话，按持久化哈希文件名顺序分页；打开、切换会话或手动刷新时拉取单页，无新增常驻轮询或 DOM 观察器，页面只缓存当前页与有界游标。
- 列表与意向读写**零模型调用**、不访问草稿；返回字段有界，不返回 raw、证据原文或源码；查看评审与证据复用原生右侧栏。
- 限制：同一条评审的并发写入仅在进程内串行（模块级队列跨服务实例生效，跨进程只剩原子重命名窗口）；历史锚点定位与历史加载由用户触发且有界，本版不保证自动定位成功；指纹失配后的恢复需要显式方案，首版不提供隐式 reset。
- 回到会话时，评审与证据通过原生右侧栏打开；本版不提供「中央面板与右侧栏同时常驻」的布局。

## [0.18.0] - 2026-09-09

> 0.18.0 实现与验证已完成；宿主变更需重启 DSH 并刷新页面后生效。正式实例上的人工 GUI 验收仍待进行。

### Changed

- 评审工具化核实阶段改为**受限 PTC**：模型只能调用原生保留的 `run_code`，程序内通过 `JSON.parse(await tools.read/grep/glob(...))` 查询评审开始时的不可变内存副本；`grep` 为字面量搜索（非正则），程序只接受 TypeScript 可擦除语法（`enum`/`namespace` 明确失败），结果携带宿主 `evidence_refs` 与 `review_time`。
- 批评者程序运行在 **Ciel 私有的 worker + QuickJS/WASM** 运行时，不是 DSH 库存 worker 代码运行时（后者在宿主机上 bash 等价，能读整机文件、起进程，会绕过源码副本）。宿主用私有官方 `ToolRuntime` + 私有 `codeRuntime` + 惰性私有 prompt sink；作用域 `tools/execute` 钩子只把评审子会话的外层 `run_code` 路由到私有官方 PTC 定义，根 `codeRuntime` 不变，DSH 源码不改，能力缺失时失败关闭，没有不受限回退。
- 存疑/纯草稿阶段仍为无工具原生路径；共用 180 秒（10–600）总时限包含资料准备、存疑与核实，每个 PTC 程序使用剩余时间，不重置、不追加抢救模型；查询与模型请求次数仍只统计。
- 私有注册表沿用 DSH 嵌套调度与日志格式，由 Ciel 守卫控制范围与时限；隔离的私有 `tools/result` 事件不进入根观察者，不声称所有全局策略插件都作用于评审子会话。
- 证据措辞收紧：程序收到宿主裁剪后的回执，模型上下文只收到程序打印/返回的摘要与必要片段，不把程序读取等同于模型看到全部文件。Ciel 归档 128 条 / 128 KiB、单条 16 KiB / 200 行不变；DSH 原生子会话日志仍可能保留每次嵌套查询，不是全局无痕承诺。

### Added

- 可选 peer 依赖 `@deepseek-ai/dsh-tools >= 0.1.5-alpha.2`（受限 PTC 用），插件依赖固定 `quickjs-emscripten 0.32.0`。
- 交接文档 [受限 PTC 评审](docs/ptc-review.md)。

### Verification

- 默认 PTC 执行链 **37/37 通过**（0 失败、0 网络；执行链测试使用脚本模型，未做额外的真实模型评审/A/B 测试）：单程序 75 次嵌套读取（3 次模型请求）、70 程序 / 72 请求、curation 与 `eN` 引用、私有拒绝、类型错误、3 个取消场景、真实 10 秒总时限；缺失/错误运行时在核实阶段前失败（存疑阶段仍允许 1 次模型请求），根运行时不变。
- 单元测试 **428/428**（含运行时 15 项）；Chromium 夹具 **22/22**（页面/控制台错误 0、网络 0）；原生 SettingsRoot 回归通过（网络/模型 0）；生成客户端 `--check` 与源码一致。以上为合成业务数据与原生 UI 组件，不等同正式实例部署/验收。
- 候选包冒烟 **18/18**：解包 12 个文件、仅 production 依赖安装、从 `/tmp` 运行真实 QuickJS（Promise 批量 / `.then` / `for-await`）与模块相对 worker 定位均通过。缓存缺失时 `--prefer-offline` 会拉取依赖包，打包/安装过程不保证全程 0 网络；执行链测试本身 0 网络。仅在 Node 24.20.0 验证，兼容下限 Node 22.19 尚未测试。
- 状态：实现与验证完成，**待用户重启 DSH 并刷新页面**；正式实例上的人工 GUI 验收仍待进行。测试网络 0 只说明测试本身，不代表整个开发任务没有真实模型调用。

## [0.17.0] - 内部里程碑（未发布 npm）

### Changed

- 评审只按总时限控制执行预算（默认180秒，准备资料、存疑、核实共用且不重置）；查询次数和模型请求次数只统计，不再中止评审或据此截取疑点。
- 设置页撤下两个次数上限。旧 `criticExploreBudget` / `criticMaxRequests` 仅作为隐藏兼容字段接受，不再生效（包括旧值0）；是否查文件只由 `criticExploreEnabled` 控制。
- 移除次数熔断后的额外模型整理路径；超时、取消或停用会停止并等待清理，不延时、不自动重试。工具结果提供 `review_time`，界面显示剩余秒数及已查询次数；旧记录的次数上限和抢救标记仍可查看。
- 权限、敏感内容检测、源码副本和证据/记录大小保护、单条模型输出长度保护不变；顾问调用策略不变。本次不切换 PTC。

### Verification

- 390 个单元测试通过，包括跨阶段共用时限、资料准备超时、超时后的工具拒绝和旧配置兼容。
- 22 个真实 DSH 离线执行链场景通过：75次批量读取、70次连续查询/72次模型请求越过旧次数值后仍完成，10秒总时限到后中断且不追加模型。
- 22 项 Chromium 原生服务夹具检查及真实 SettingsRoot 回归通过；执行链测试使用脚本模型，未做真实 A/B。宿主变更需用户重启 DSH 后生效。
- 详情见 [只限时评审交接](docs/time-only-review.md)。

## [0.16.1] - 内部里程碑（未发布 npm）

### Fixed

- 适配 DSH 0.1.5-alpha.2：构建时路径助手升级为官方 alpha.2，当前文件地址始终携带证据归属 Session，修复批准的外部源码根和根未知时被新文档预览器拒绝的问题；工作区内、外部、编码字符、跨会话、Windows 驱动器与 UNC 路径均有回归。
- 证据侧栏提示 Markdown 源码行定位需切换代码或纯文本，历史行号可能已不对应当前内容；仍不回退当前文件来填补历史证据。
- 敏感输入检测不再把占位符当凭据：`?token=…`、`?token=<token>`、`?token=...`、`YOUR_API_KEY`、`changeme`、`[redacted]`、`${ACCESS_TOKEN}` 等示例值不再中断评审；真实形状（长度 ≥8 的凭据值、已知密钥前缀、私钥块、带账号密码的 URL、Bearer/Basic）仍照旧拦截。占位符被 Markdown 反引号、括号或列表标点包住（如反引号包裹的 `?token=…`、`（?token=…）`、`SECRET=changeme,`）同样按占位符处理。为减少示例文本误报增加占位符豁免；检测仍是启发式，短或默认形状的真实凭据可能被漏过（见 [SECURITY.md](SECURITY.md)）。

- 强化卡片与侧栏操作按钮：卡片入口使用原生实心主按钮，移除标题区整体透明度；侧栏证据编号改为“查看证据 eN”的有底色按钮，操作区采用至少36px点击高度、可换行布局及可见键盘焦点框。状态标签仍是只读，不改变评审/文件导航/草稿回传行为。

### Verification and upgrade boundary

- 原生夹具使用 root `rightbar` 与 `rightbar.session`，真实文档预览器的地址认领条件，以及主面板切换/资源 pin 保留检查；按真实空间验证窄栏单列回退和全屏双栏对照。
- 执行链验证父 Session 子代理目录唯一性，以及两个评审阶段目录写入失败后的 guard/子代理/在途操作清理，不重试或伪造补偿目录事件。
- Chromium 夹具统一使用自有浏览器启动器，明确关闭自有 CDP 浏览器并清理 profile 后才保存成功报告。实际 GUI 检查新增升级版本前置门，默认等到 alpha.2 才允许继续。
- 隔离验证通过：381 个单元测试、23 个真实执行链场景（含占位符放行与真令牌拒绝各一）、21 项原生侧栏检查、19 项真实 Chromium 夹具检查，另通过原生设置页回归；模型验收请求为 0。CI 固定 alpha.2 commit `b2e3b2a0125854567a4a5fcba75782e42fe84901`。
- 用户手动升级到 alpha.2 后，另用隔离 `DSH_HOME` 的第二实例完成真实浏览器检查：正常 token→cookie 认证与刷新、Ciel 激活、只读分页 RPC、设置页原生控件、空白会话的原生右侧栏挂载、`/advise` 命令注册通过，页面错误与模型 prompt 均为 0。它使用合成记录与隔离状态，**不是正式实例验收**；其 CLI 启动按惯例重写了 `profiles` 模板文件，但正式设置、凭据与会话未被写入。
- 正式实例、真实会话数据上的批注/证据/当前文件交互仍需人工或后续授权验收；这些路径由离线执行链、真实原生服务夹具与 Chromium 完整客户端夹具覆盖，但不等于正式数据验收。详情见 [alpha.2 兼容性说明](docs/upgrade-dsh-0.1.5-alpha.2.md)。

## [0.16.0] - 内部里程碑（未发布 npm）

### Fixed

- Ciel 设置移至左侧独立“夏尔 Ciel”页面（Agent 预设之后），移除重复插件配置入口；复用原命名空间，跨页面保留未保存草稿，以固定修订号一次原子保存，防止覆盖较新的配置。
- 使用 DSH alpha.2 共享原生 Switch/Tag：设置开关只暂存，状态标签区分当前值与待保存预览；评审标签通过 React portals 渲染，组件卸载自动清理，保留折叠与手动草稿回传。
- 零批注评审卡片也能折叠：模型、读取范围和覆盖说明统一进入详情区；折叠状态按评审保留到当前页面生命周期结束，重绘不再重置。标题使用原生按钮和展开状态，草稿回传按钮保持独立。
- 批注回传改为“填入输入框”：追加且保留原稿/引用/附件，由用户手动发送；新端点只准备文本，旧自动发送端点停用，草稿不误记已发送。切换会话、编辑竞争、命令/发送状态及重复填入均有保护。
- 去掉“本轮无工具记录即可事实性指控未验证”的冲突指令；缺失记录、旧报告或不同测试套件不再作为造假推断依据，仍允许依据真实矛盾提出批注。
- 默认探索额度改为20次、模型请求32次，可调上限分别为50/64；时限不自动延长，已有用户覆盖保留。
- 评审工具结果附带剩余读取额度，耗尽时要求直接收尾；熔断恢复不再只取最后一句，保留此前可见的带引用检查点，冲突/撤回仍为未查。保持硬上限与无证据不抢救规则；失败记录补充本次工具计数，界面使用直白中文解释。
- 评审文件核查改用受限源码副本；专用子代理在首条请求装配前安装读取/搜索接口，阻止普通文件工具、父预设工具及路径/链接绕过。隔离失败无不受限回退；受限或隐私扣留的证据不能显示完整通过。
- 总开关移至设置卡片顶层并正确说明顾问、评审与回传范围；常用/高级设置改为行为说明，修复数字项重置后草稿类型导致的渲染错误。
- 顾问工具、`/advise` 与评审卡片保存并显示本次模型来源；区分已观察到的模型、仅请求的模型和缺失历史，不从当前设置推断。
- 疑点清单解析失败不再冒充零疑点通过；探索裁决必须有唯一有效标题，调查记录不再进入旧格式批注回退。无证据 blocker 降级后重新计算裁决。
- 将覆盖范围与严重度分开：未查完、逐项结果缺失/冲突及抢救结果标为“不完整”；零疑点短路与纯草稿评审不宣称已独立核实。
- 契约 v4.1：宿主给疑点分配稳定编号；批注只允许关联选中的 defect 结果，已排除/未查/未知编号的批注剔除。统计和总评由宿主账本派生，阻止重复计数、擅自扩清单及自由摘要认证未查项目。
- 使用 DSH `tools.guard()` 在工具执行前同步限制预算；结束时继续核对采样，防止快速超额结束漏检。
- 抢救只在工具预算熔断且存在带引用的部分调查记录时允许一次。网络/鉴权失败、取消、超时、请求次数耗尽均不自动增加一次调用。
- 修复加载失败被缓存、断连恢复、勾选差量恢复、工具次数与疑点数量混用；取消和抢救状态直接可见。批注回传从已存评审读取证据、块号和原消息身份。
- 顾问调用执行前占用本轮额度，阻止并发穿透及结果尚未落日志时重复花费。
- 适配V3 PTC子调用事件与无meta顾问条目，普通run_code容器不再误报隐私受限；敏感输入拒绝不占咨询额度，证据引用接受中文分隔符。
- 评审列表游标分页，分诊按评审合并成单记录并串行更新，校验会话/评审/索引；长期会话不再因200次点击耗尽列表。
- 移除旧路径假设：`reviewsPath` 指向 `ciel/v1` 目录，评审/证据/顾问读取只走新记录存储；损坏记录、版本不符或归属不符显式报错，不再以 torn-line 跳过或“缺失即当前文件”兜底。

### Added

- 调用总开关 `enabled`、顾问/评审总时限、评审模型请求次数和每次输出上限；评审取消端点与停止按钮。关闭开关或卸载插件取消并等待在途子代理清理。
- 真实 Cordis 服务的离线流程回归、客户端状态回归，以及 `scripts/verify-runtime.mjs`：无 Web 服务的真实 DSH 工具链回放，可显式选择允许的 DeepSeek 实测。
- 新版版本化记录存储：`$DSH_HOME/ciel/v1/<kind>/<sessionId>/<hash(id)>.json`（`reviews`/`evidence`/`advice`，保留 `calls`/`feedback`）；原子替换同键记录、目录 0700 / 文件 0600、单文件 512 KiB、单会话列表 200 条 / 16 MiB、归属与符号/硬链接校验、有界读取。旧 `dsh-advisor` JSONL 不迁移、不读取，`ciel` 设置保留。
- 宿主证据 ID：`read`/`grep`/`glob` 的真实结果由宿主分配 `e1…`；`groundReview` 只接受本次账本中已存在且被引用的编号，伪造/越权/未返回引用整条作废（疑点退回未查）。片段有界（每条默认 16 KiB / 200 行，每轮合计 128 KiB / 128 条），模型看到与落盘相同的字节，完整内存副本评审结束即释放；`a1` 仅标记作者提供的输出、不另存原文。
- 原生右侧栏资源：评审/历史证据/顾问三个 `dsh-resource://` 资源与标签页；资源读取一次即结束，失败不显示旧值；`readEvidence` 只按已提交评审的 `evidenceIds` 读取，缺失不回退当前文件，当前文件仅由 Host 解析的 `currentPath` 打开。
- 浏览器端源码拆为 `plugin/src/client.js` + `plugin/src/sidebar.js`（含 `sidebar.css`），由根私有开发包（esbuild + 官方 `@deepseek-ai/dsh-util-workspace-path`）的 `scripts/build-client.mjs` 打成单一 `plugin/client.js`。

### Changed

- 存疑阶段仅接收用户请求、块地图与草稿；作者工具证据和顾问清单留到核实阶段。
- 设置和 README 明确：工具预算不是金额上限；预算 0 仍然调用模型。当前安全调用依赖 DSH 的 `tools.guard()`，缺失时拒绝发起调用而非静默降级。
- A/B 运行必须显式允许付费；模型选择与评审身份不明确时停止，不再猜最近写入的评审文件。
- 目标 DSH 提升到 **0.1.5-alpha.1**：使用原生 resources 与右侧栏服务、共享 Switch/Tag/Button，不复制组件或样式，不申请额外文件权限。
- 开发/安装：根 `pnpm-workspace.yaml` 只包含根包，插件依赖用 `pnpm --dir plugin install --ignore-workspace --frozen-lockfile=false` 单独安装；`node scripts/build-client.mjs --check` 校验 `client.js` 与源码一致。
- CI 增加根依赖安装、`build-client.mjs --check`，以及一个固定上游 commit `5dda764ed3aa172535a7967b06ff95d9cbfe536a` 的独立集成 job（`--ignore-scripts` 安装 + `build:lib` 后运行离线 `verify-runtime.mjs` 与 `verify-sidebar-native.mjs`；不跑付费、不加 `--live`）。

### 历史验证（0.16.0 基线）

- 历史验证：369 个单元测试、19 个真实执行链场景、19 项原生侧栏检查、15 项真实 Chromium 夹具检查通过。另有隔离实例的认证、只读 RPC、原生设置页与刷新检查通过；未执行 `--live` 模型验收。
- 合成夹具的深浅色/窄屏截图不随公开文档发布；不把用户真实会话截图发布到 README。

## [0.15.0] - 2026-09-05

两阶段评审（契约 v4）——用户提案①③的合体落地：把「存疑→核实」从单回合
自觉变成编排强制，预算分诊从 prompt 恳求变成 host 机械截取。

### Added

- **阶段 1「存疑」独立 spawn**（无工具、便宜）：只交结构化疑点清单
  （`- suspect: … | block: bN | bearing: high|low | falsify: …`），并明确
  「提名 ≠ 判定」——证据已支撑的断言照样提名（证实也是裁决），修复
  3.8 两次对可验证草稿交白卷。清单为空即短路 pass，不烧阶段 2。
- **host 机械分诊**：bearing 高优先稳定排序、按预算截取，其余计
  「未查 Z」——清单在送审前定型，模型不再掌握「查几个」的决定权。
- **stats 四元组**：`排查 M · 证伪 X · 排除 Y · 未查 Z`，host 把预截取数
  并入 Z 持久化；评审条目带 `suspects: {total, triaged, skipped}` 地面
  真值；裁决卡 chip 显示未查数。
- **熔断抢救书写员（仅一次）**：阶段 2 被熔断（或任何非 completed
  终态）时，抓子代理死前部分卷宗 → 无工具书写员出最终 dossier+verdict，
  未了结疑点一律进未查、不落批注；条目标记 `explore.salvaged`，chip
  tooltip 注明抢救产出。**设计评审抓出并修复致命伤：抢救 spawn 最初
  与阶段 2 共享 abort signal（breach 时已耗尽）——现每个 spawn 独立
  控制器。** 真实例未触发（triage 后 3.8 不再超支——特性生效的表现），
  路径已代码评审+值守。
- 进展徽标分母从「预算」升级为阶段 1 清单送审数（真 M）。

### Changed

- A/B 评估台：模型选择器适配 0.1.3 新版两步弹层（chip → Model 行 →
  条目），回复等待 150s → 300s（多步核实场景）。

### 实证记录

- S4（历史熔断场景）v4 下 3 疑点 4 调用 25s 正常通过；S7 全链
  （清单→分诊→核实→四元 stats）；budget=1 实测 排查 1 · 排除 1 ·
  未查 2/3——机械分诊与 Z 合并精确；
- 顺带修复评测台被新版选择器静默放倒的问题（模糊匹配点不中 gemini
  条目，会话回落到无效 key 的默认模型整批哑火）。

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
