# DSH 0.1.6-alpha.2 本地兼容性

## 链接开发安装的共享依赖

Ciel 通过 `link:` 安装时，仓库自己的旧 peer 依赖可能继续参与运行。旧版 `dsh-tools` 使用另一份 `dsh-scope`，导致新版 Agent 的作用域无法被识别，表现为 `Restricted review is unavailable`。修复时保留私有 QuickJS runtime、工具守卫和只读快照。

```bash
DSH_CHECKOUT=/path/to/deepseek-harness node scripts/link-harness-peers.mjs
DSH_CHECKOUT=/path/to/deepseek-harness CIEL_VERIFY_NATIVE_PEERS=1 node scripts/verify-runtime.mjs
```

第一条只改本地 `plugin/node_modules` 中五个共享依赖的符号链接，并保存旧链接清单。第二条默认使用脚本模型、禁止网络；不添加 `--live`。DSH 原目录升级后链接仍指向该目录的新构建；重新安装 Ciel 自身依赖或移动 DSH 后重新执行。普通发布包的 peer 依赖应由安装环境统一解析。

## 会话与主题

收件箱集中通过 `currentSessionId` 读取会话选择：新版使用 `byId[*].retainedBy.mainView`，旧版保留 `current` 兼容。切换、关闭会话都会使在途读取 / 写入 / 定位失效，后台子会话不会冒充主会话。

Ciel 的卡片、状态色、浮层使用 DSH `--dsw-alias-*` 语义变量，随默认主题明暗和主题插件变化。终末地玻璃在其自身启用范围内补充静态材质；Ciel 不判断主题名称，也不启动额外绘制循环。

升级后至少验证：实际安装依赖的无联网评审、真实网页里的已选会话 / 切换 / 无评审状态、默认与玻璃的明暗主题、插件启停。只有 RPC 能调用不足以证明完整评审能启动。

## 审查后回归

新增回归覆盖 DSH fork 保留 messageId、保存阶段取消、持续进度错误、Remote 重新注册及批注键盘入口。初始化诊断现在保留 `code` / `stage`：例如服务未就绪为 `CIEL_REVIEW_SERVICE_NOT_READY`，运行时语言不符为 `CIEL_REVIEW_RUNTIME_INCOMPATIBLE`，不再统一按访问受限处理。

进度同步的重试只读取状态，不会自动重启评审。正常结果在 summary rename 的提交点之后不能再接受取消，API 返回 `cancelled:false` 与当前 `phase`；此前接受的取消保存 cancelled 终态。

开发链接安装需同时核对源码、Client 构建和 Host 进程加载时间；磁盘更新不会证明旧进程已加载新模块。架构边界与后续拆分见 [architecture.md](architecture.md)。
