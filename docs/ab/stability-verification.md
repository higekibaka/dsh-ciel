# Ciel 稳定性修复验证记录

## 范围

本文为可公开的验证摘要。下文提及的原始 JSON 报告（含失败批次）仅本地留存，不随仓库提交；报告名用于定位历史证据，不是公开下载链接。

验证对象为 0.15.0 之后的稳定性修复（结果契约 v4.1），不是 npm 上已发布的 0.15.0。本次修复提交到仓库，不提升包版本、不发布 npm，也不重启主 GUI；用户设置与日常模型路线未改。下述稳定性测试的 Google 调用为零。

环境：Node.js 24.19.0；DSH 0.1.3-alpha.1 的构建产物。未启动 Web 测试服务。所用真实模型固定为 `deepseek-official/deepseek-v4-flash-vision-exp`，low 档；测试脚本关闭提供方自动重试，限制每请求输出、每评审请求数与时间，并只允许访问 DeepSeek 官方 chat-completions 端点。

## 离线结果

- `cd plugin && node --test`：**145 passed / 0 failed**（Node 运行器计数，包含 3 个夹具模块的加载；142 个测试用例）。
- `node --check`：Host、Client 与测试驱动语法检查通过。
- `npm pack --dry-run --ignore-scripts`：仍只有 LICENSE、README.md、index.js、client.js、cordis.patch.yml、package.json 六个交付文件；测试、报告和凭据不进入包。
- 新增/现有交付文本的常见密钥模式检查未发现凭据；这不是完整的安全认证。

真实 DSH 执行链通过 5 个离线场景：本地报告 `stability-ledger-offline.json`。AgentLoop、SubagentRuntime、子代理驱动、工具注册表和执行前 guard 使用真实实现；模型被脚本化替换，read/grep/glob 是受限的临时文件夹具能力（不是完整生产文件工具/沙箱实现）。验证准确结果、并发工具越限、一次抢救、取消以及 4 次并发顾问请求只实际发起 1 次。

真实 React 18 + Chromium 离线 DOM 验证通过：部分结果不绿、抢救标记可见、停止按钮可用、新请求失败不覆盖旧结果但错误仍可见、勾选在重新挂载后保留、回传携带证据与块号、卸载移除卡片与标记。浏览器网络被阻断，没有模型调用。这不是主 GUI 的部署验收。

## DeepSeek 实测

以下是跨批次的场景结果，不是宣称“一个批次零失败”或模型质量排名：

| 场景 | 最终观察 | 证据 |
|---|---|---|
| 属实文件行数 | 正常核实，0 缺陷、0 批注 | 本地 `stability-ledger-deepseek.json` 前两项 |
| 错误行数及虚假“已核实” | 返回带证据的缺陷批注 | 同上 |
| 诚实弃权 | 无批注；模型额外加的表述建议被程序剔除，报告提示契约偏差 | 本地 `stability-ledger-final.json` 三项 |
| 两个文件、一次读取预算 | 总数 2、排除 1、未查 1；无未查/已排除项的提醒批注 | 同上 |
| 流式生成中取消 | 1 次模型步骤后取消，无工具、无抢救 | 同上 |
| 熔断后的真实抢救书写 | 保留冻结的排除结果，仍显示不完整，不重新制造批注 | 本地 `stability-salvage-final.json` |

最后一项使用混合夹具：存疑与故意超支由脚本化模型确定性触发，但工具执行、熔断及生命周期是真实 DSH；只有最终抢救书写员使用真实 DeepSeek，**1 次 HTTP 请求**。这避免反复诱导模型自然超支来碰运气。

## 实测发现及修复

1. 旧流程会接受模型把已验证正确的断言计入“证伪”，或者把截去的疑点再计算一次。改为宿主编号与逐项结果账本，不信任自报 stats。
2. 模型仍会给已排除/未查项追加条件性 nit。程序按编号和结果剔除；不把这当作模型永不犯错。
3. 模型的自由摘要曾宣称未读取的第二个文件也完全成立。当前卡片总评由账本生成，不展示这个越界认证。
4. 抢救书写员曾把“作者没有工具活动”误当成“核实者没有查过”，抹掉有效的部分发现（本地保留的失败报告 `stability-salvage-deepseek.json`）。现隔离作者摘要，并冻结原核实结果，抢救只能编写、不能重开或新造结论；重测保留排除结果。
5. 实测出现过传输失败（本地记录 `stability-ledger-followup.json`），插件明确失败且没有启动额外抢救；后续仅重测相关场景。没有把失败记录删掉来制造稳定率。
6. 一个早期“诚实弃权必须永远不绿”的测试断言过强：若其陈述确实被核实并排除，非阻断裁决并非惩罚。现按用户要求判定“不能给诚实弃权制造批注”，并在请求中明确允许未知时弃权。旧失败记录保留。

## 限制

这些测试证明编号、计数、取消、恢复与输出边界，不证明所有模型判断为真。实测评论仍出现过错误的比例计算；引用与严重度仍需人核对。只读工具限制也不是敏感文件隔离。

未验证当前主 GUI 已启用新代码；它需要后续明确的部署/重启步骤。Ciel 保存的顾问和批评者路线仍是原配置，不会因为本次测试使用 DeepSeek 就自动切换。

## 复现命令

```sh
(cd plugin && node --test)
DSH_CHECKOUT=/path/to/deepseek-harness node scripts/verify-runtime.mjs
DSH_CHECKOUT=/path/to/deepseek-harness node scripts/verify-client-dom.cjs
# 真实测试需另在环境里提供 DEEPSEEK_API_KEY：
CIEL_ALLOW_PAID_TESTS=1 DSH_CHECKOUT=/path/to/deepseek-harness node scripts/verify-runtime.mjs --live
```

`CIEL_VERIFY_CASES` 可只选择指定场景（逗号分隔）；`CIEL_VERIFY_REPORT` 指定报告路径。`CIEL_VERIFY_KEEP_GOING=1` 允许记录某场景失败后继续其它独立场景，但整批仍以非零状态结束，不吞掉失败。
