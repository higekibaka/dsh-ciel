# Ciel × DSH 0.1.5：兼容性与交接说明

> 本文是 0.16.x 基线的历史兼容记录。当前版本为 0.18.0，见 [README](../README.md) 与 [CHANGELOG](../CHANGELOG.md)。

## 目标基线

- 最低基线：DSH `dsh-v0.1.5-alpha.1` / commit `5dda764ed3aa172535a7967b06ff95d9cbfe536a`；Ciel 以该版本为最低兼容目标。
- 使用的新能力：新版 API、原生评审/顾问侧栏、宿主证据 ID、有界引用片段保存、历史证据与当前文件对照。

## 边界与取舍

- 只处理 Ciel 自己的评审/反馈/调用记录；不删除 DSH 聊天、配置、路由或凭据。旧 `dsh-advisor` JSONL 不迁移、不读取。
- Ciel 额外证据存储只保存本次被引用、通过隐私检查、有大小上限的片段，不另存完整资料副本或代理过程。
- **DSH 本身仍可能保存顾问/评审子会话日志（包括未被最终引用的读取）**；Ciel 的片段限额不是全局留存上限，也不承诺全局无痕。
- 证据按 session/review/evidence 寻址，内容指纹只做一致性检查，不证明防篡改或语义正确。
- 使用官方 `dsh-resource://ciel-evidence/...`；当前文件复用官方 `fileAddressFor` 与文档预览。
- 完整内存副本在评审结束后释放；有限引用片段随评审保存；侧栏订阅随最后持有者释放。关闭侧栏不是取消模型。
- 原生双栏「当时证据 / 当前文件」；当前文件不能覆盖或补作历史证据。
- 敏感内容在模型输入前与落盘前各检查一次；检测是**启发式**，可能漏掉短或默认形状的凭据。
- 顾问观点不冒充核实证据；浏览/切页/刷新不调用模型或自动发送；资源地址不是访问许可。

## 兼容性检查清单

- [x] 隔离安装锁定依赖并构建目标 Host/Web 产物。
- [x] runner 使用 `setup(childCtx, child)` 与显式 `parentAgent`。
- [x] 真实执行链断言子代理不属 roots、正确归属、守卫早于首请求、失败回滚/取消无泄漏。
- [x] Session V3 与共享依赖一致性验证；提示词仍由原生接口管理。
- [x] 新数据根与 `schemaVersion`，保持 `ciel` 设置；不读取/迁移旧评审。
- [x] 宿主证据 ID 绑定真实 read/grep/glob 结果，不信任模型自写源码或路径。
- [x] 最终引用校验、有界片段保存、缺失/截断/扣留/损坏状态外显。
- [x] 会话归属检查、安全读写与有界大小，不新增任意文件 RPC。
- [x] 评审与顾问资源/标签页，复用 `useResource`/`useTabInfo`。
- [x] 聊天摘要/原文批注到侧栏定位，仍手动填输入框。
- [x] 历史片段只读、当前文件行定位/原生分栏、窄屏适配。
- [x] 失败不把上一次成功值当最新成功；静态证据不后台监听/轮询。

## 历史验证（0.16.x 基线）

- 单元回归 369/369；当前实际 DSH checkout 的离线执行链 19 场景、原生侧栏 19 项通过；完整生成客户端的 Chromium 验证 15 项通过（真实 CSS、轻量卡、原文角标、Lexical 草稿、证据对照、深浅色/窄屏，无模型调用）。
- 这些是 0.16.x 的隔离验证计数，不代表 0.18.0 的结果；0.18.0 计数见 CHANGELOG。
- 验证使用合成记录与临时 `DSH_HOME`；离线夹具不等于正式实例上的人工验收。

## 复现

```sh
pnpm install
pnpm --dir plugin install --ignore-workspace --frozen-lockfile=false
node scripts/build-client.mjs --check
node --test plugin/test/*.test.js
DSH_CHECKOUT=/path/to/deepseek-harness node scripts/verify-runtime.mjs
```
