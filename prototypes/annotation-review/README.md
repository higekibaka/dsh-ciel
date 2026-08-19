# M3-③ 批评者 · 锚定批注原型（annrev）

M3 路线图第 ③ 项的**实测原型**：每条助手回复的操作区多一个「批注评审」按钮，点击后由批评者子代理（默认 `google/gemini-3.7-flash`，effort 钉低）对草案做收敛型红线评审，批注以**波浪下划线 + 角标**长在原文上，点击弹出批注卡；消息下方另有完整卡片面板兜底。评审记录 `session.append('advisor/review')` 持久化，跨进程重启水合无损。

## 形态

- **动态 Cordis 插件**（非 bundle）：`host.js` / `client.js` 的内容就是 `cordis_define` 的 `code.host` / `code.client` 函数体，直接贴进 define 即可运行。包名约定 `annrev`。
- 最终验证版本对应崩溃会话谱系的 pkg-12（本目录 = pkg-12 源码快照）。

## 实测沉淀的硬知识（改动前先读）

1. **`conversation.chat.turnTail` 链是赢者通吃**：deliverables 行随应用启动先注册，凡有产物文件的轮次它必胜。本原型的渲染**不走链**，全部由按钮（`assistant-actions`，每条消息必挂载）的 effect 直驱 DOM。
2. **chat DOM 无"轮次容器"**：assistant-step / turn-tail 等 flow item 互为兄弟。锚点匹配用**就近原则**（按钮之前文档序最后一个出现位置），清理用**按效果记账**（只撤销自己创建的 span）——跨轮清空与错位都源于违反这两条。
3. **锚点是 Markdown 源码、DOM 是渲染后文本**：锚点侧剥语法 + 双侧空白折叠后匹配；host 侧 matched 标志仅作展示（杂散反引号会误判），DOM 侧归一化匹配为准。
4. **批评者模型的两个坑**：kimi 系会"只想不说"（persona 必须显式声明无工具、可见文本才算交付，空文本判评审失败）；gemini 必须钉 `reasoningEffort: 'low'`（pi-ai 把空 effort 映射为被 gemini-3.7-flash 拒绝的 MINIMAL thinkingLevel，经由 `agent/request` waterfall 对活子代理注入）。

## 测试台

`test/` 是离线 DOM 测试台：`build-harness.js` 用真实会话 DOM 夹具（`fixture-chat.html`）拼出两轮共享重复短语的页面，注入提取自 client.js 的纯 DOM 引擎（`engine.js`），`harness-drive.js` 跑 14 条断言（就近匹配 / 跨轮清理 / 复审幂等 / 面板插位 / badge 配对等）并出截图（`harness-1.png`）。

```sh
node test/build-harness.js && node test/harness-drive.js   # 需要 puppeteer-core + dsh-chrome
```
