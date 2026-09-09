# DSH 0.1.5-alpha.2：Ciel 兼容性说明

> 目标：把 Ciel 从 DSH 0.1.5-alpha.1 适配到 **0.1.5-alpha.2**（commit `b2e3b2a0125854567a4a5fcba75782e42fe84901`）。
> 结论：需要小范围适配后再切换；隔离回归已完成，正式实例仍需重启后人工点验。

## 1. 必须适配：外部文件地址要保留 Session

Ciel 根 `package.json` 将 `@deepseek-ai/dsh-util-workspace-path` 固定在 alpha.1。`scripts/build-client.mjs` 将该助手打进 `plugin/client.js`，所以只升级 DSH 并不会更新 Ciel 内嵌的地址逻辑。

alpha.1 的 `fileAddressFor(sessionId, cwd, path)` 对工作区外绝对路径、或工作区根未知时的绝对路径生成：

```text
dsh-resource://file/absolute/external/src/a.ts
```

alpha.2 改为：

```text
dsh-resource://file/session/<sessionId>//external/src/a.ts
```

Session 后的双斜杠保留绝对路径的前导 `/`，不是拼接错误。新文档预览器的 `canOpen` 只认领 Session 地址；新的 `file` provider 也不会借用当前/Tab Session 为裸 absolute 地址补权限，后者返回 `workspace-file/unknown-workspace`。因此 Ciel 的“打开当前文件”和“与当前文件并排”在批准的额外源码根等情形会失败；工作区内且根已知的路径不受这一变化影响。

**最小修复：**升级构建时路径助手及锁文件，重建客户端，补工作区内、额外根、未知根、跨 Session 和 Windows 路径回归。继续只使用 Host 确认的 `currentPath`，不把历史显示路径当作回退，也不扩大评审读取权限。

用 alpha.1 已安装助手、alpha.2 原始 TS 助手与 alpha.2 `textDefinition().canOpen` 的三组断言：

| 场景 | 旧助手地址被 alpha.2 认领 | 新助手地址被 alpha.2 认领 |
|---|---|---|
| 工作区内且根已知 | 是 | 是 |
| 批准的额外根 | 否 | 是 |
| 根未知的绝对路径 | 否 | 是 |

三组全部符合预期。该测试验证地址构造与查看器认领，不等于验证 Host 文件授权或完整 GUI。

## 2. 新文档预览：可直接受益，但行定位有差异

Web 默认组合用 `ui-sidebar-documentpreview` 替换 `ui-sidebar-textpreview`。新包支持 Markdown、代码高亮、HTML、图片、PDF 与纯文本，tab kind 仍是 `text`，仍通过 `openResource` 接入。Ciel 不直接导入旧预览包，历史证据也仍是自己的资源协议，因此无需为此重做证据侧栏。

注意：`params: { line }` 仍受支持，但只有纯文本与代码正文提供源码行锚点；Markdown 渲染视图不提供，行导航会等待切换到有锚点的视图。Ciel 应给出明确提示，不能宣称所有文件都会立即滚到被批注的源码行。

## 3. 资源 reload 删除：当前 Ciel 未调用

`ResourceSnapshot.reload` 和 `ResourceProvider.reload` 被删除，刷新由具体预览 tab 自己管理。Ciel 使用一次性读取的静态历史资源，不依赖这两个方法。注册、`useResource`、pin/abort 生命周期与失败保留旧值的语义仍在；Ciel 继续在失败时隐藏旧成功值，避免误显示。源码检查未发现这里的直接破坏点。

## 4. Shell 作用域变化：实现入口保留，测试夹具要更新

Shell 的旧 `conversation` slot 被根作用域 keyed `main` 及其 `main.conversation` 子入口替代；`rightbar` 从 Session 改为 root，实际会话内容下沉到 `rightbar.session`。

Ciel 注册的是下游 `sidebar.right.pane.tab`、`conversation.chat.assistant-actions`、`conversation.chat.commandview`、`shell.overlay` 等保留入口，没有替换旧的最外层 conversation/rightbar。不要把 `ctx.get("conversation")` 服务名与被替换的 slot 名混为一谈。

但 `scripts/verify-sidebar-native.mjs` 和 `scripts/fixtures/sidebar-browser-entry.js` 仍声明 Session 作用域 `rightbar`，并直接从它读取 Session store。这些 alpha.1 夹具需要按新 shell 调整，不能原样跑出失败后就归咎于 Ciel，也不能用旧夹具通过冒充 alpha.2 通过。

## 5. 子代理目录新增：自动接入，补失败路径测试

alpha.2 在父 Session 写入 `subagent/catalog`，通过 `subagentCatalog` projection 暴露直接子级。`subagents.start()` 在 provider 返回 `localAgent` 后自动记目录；Ciel 受限 reviewer provider 已返回该字段，不应另写一份重复目录。

目录追加失败会使启动失败，并由 DSH 释放 run、处理结果拒绝。回归应覆盖这种路径下 Ciel 的 guard 解绑、取消和记录状态。`agents.create`、`setup(childCtx, child)`、显式 `parentAgent`、核心 tools/agent-loop 与 child-agent helper 源码在两个 tag 间没有相关实现变化；这只是源码兼容判断，不替代运行验证。

## 新能力中值得利用的部分

- **原生多格式预览：**继续把当前文件交给原生查看器；历史证据与当前文件严格区分。浏览器预览不是给 reviewer 新增 PDF/HTML 读取工具的理由。
- **客户端 action 命令：**`CommandUiSpec` 新增 `kind: "action"`，可只开界面、不提交 prompt。以后可用作打开 Ciel 记录的入口；本版没有新增命令。
- **原生主面板：**根作用域 `main` keyed slot 为将来的独立记录页面提供扩展点。不是这次兼容修复的必需项，不需要现在重构侧栏。
- **present 文件交付：**新增 `present` 与 `deliverables/presented`，可以声明包括 Bash 生成文件在内的最终交付。它只记路径和说明，打开的是当前源文件，不复制内容，也不随 Session ZIP 保存文件字节。可以考虑用于未来导出评审报告，但绝不能替代 Ciel 的历史证据归档。父 Session 如需交付子级产物，要由父级声明。

## 数据与升级边界

- alpha.2 的 `SESSION_FORMAT_VERSION` 仍是 **3**；没有发现需要给 Ciel `ciel/v1` 归档做迁移的格式变动。不需要再次清理 Ciel 记录。
- 新增 Session 事件和 projection 不等于所有旧版本都能无损回读；真正切换前仍应备份，不承诺任意降级。
- DSH 原生子会话日志仍可能保留提示词和工具结果。alpha.2 没有把 Ciel 的片段归档上限变成全局日志保留上限。

## 历史验证（0.16.1 基线）

- 隔离安装/构建通过；单元 **381/381**；离线执行链 **23/23**（含占位符放行与真令牌拒绝）；原生侧栏 **21/21**；完整生成客户端的 Chromium **19/19**（页面/console 错误 0、网络 0）；SettingsRoot/Switch/Tag 离线回归通过。
- 另有使用隔离 `DSH_HOME` 的第二实例完成真实浏览器检查：正常 token→cookie 认证与刷新、Ciel 激活、只读分页 RPC、原生设置页控件、空白会话的原生右侧栏挂载、`/advise` 命令注册，页面错误与模型 prompt 均为 0。它使用合成记录与隔离状态，**不是正式实例验收**；其 CLI 启动按惯例重写了 `profiles` 模板文件，但正式设置、凭据与会话未被写入。
- 正式实例上基于真实会话的批注/证据/当前文件交互仍需人工或后续授权验收。
- 这些计数是 0.16.1 基线的历史结果，不代表 0.18.0 的结果。

## 升级与重启要求

1. 按原有方式把 DSH 更新到精确 tag，安装匹配依赖并重建受影响的 Web/插件产物。**不要另起一个服务器当作已升级正式实例。**
2. 正常停止并重启 DSH，然后刷新页面；只刷新页面不足以加载新的后台逻辑。
3. 走正常的 token→cookie 认证流程。启动日志可能含入口 token，**不要把日志内容或 token 发到聊天中**。
4. 建议在停止 DSH 后备份当前 checkout 与最新 `DSH_HOME`；新增 Session 事件和 projection 不保证旧版本无损回读。

## 敏感输入误报修复（0.16.1，需重启生效）

评审输入会带上被回复的用户请求与草稿全文，文档示例（如 `?token=…`）曾命中凭据规则而被拒绝。

- 明显占位符（`…`、`...`、`<token>`、`YOUR_API_KEY`、`changeme`、`[redacted]`、`${ACCESS_TOKEN}` 等）不再拦截；被 Markdown 反引号、括号或列表标点包住时同样按占位符处理。
- 真实形状（≥8 字符的凭据值、已知密钥前缀、私钥块、带账号密码的 URL、Bearer/Basic）仍会拒绝，且拒绝发生在任何模型请求之前。
- **检测仍是启发式**：拆分、编码、伪装或短/默认形状的凭据仍可能被漏过；详见 [SECURITY.md](../SECURITY.md)。这不是“检测所有秘密”的保证。
- 修复在宿主插件中，需要重启 DSH 才生效；只刷新页面不够。

## 源码依据

- [官方发布页](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-alpha.2)
- [两 tag 比较](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.1.5-alpha.1...dsh-v0.1.5-alpha.2)
- [路径助手](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.5-alpha.2/packages/util/workspace-path/src/index.ts)
- [file provider 的 Session 归属](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.5-alpha.2/packages/api/workspace-files/src/client/provider.ts)
- [文档预览及行定位](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.5-alpha.2/packages/client/ui-sidebar-documentpreview/README.zh.md)
- [资源契约](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.5-alpha.2/packages/client/resources/src/client/contract.ts)
- [Shell slot 声明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.5-alpha.2/packages/client/ui-layout/src/client/index.ts)
- [子代理启动与目录写入](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.5-alpha.2/packages/subagent/subagent/src/index.ts)
- [present 语义及限制](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.5-alpha.2/packages/fs/tool-present/README.zh.md)
