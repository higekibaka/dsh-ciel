# DSH 0.1.7-alpha.1 适配

开发目录已适配 [DSH dsh-v0.1.7-alpha.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-alpha.1)，固定验证提交 `c36a83ff6bb95e3f82cf79f9be7c724270a8aa61`。这些改动纳入 Ciel 0.20.0；Ciel 0.19.0 仍以其原发布说明为准。

## 行为变化

- 新版从插件的 volatile Config 生成设置表单，通过 `configForms.get('advisor')` 编辑 Profile 中的入口。Ciel 保留自己的设置页，以 `.get()` 读取最新配置，响应 `loader/volatile-update`；关闭 Ciel / Jev 时继续取消相应在途操作。
- 旧版继续走 `settings.register('ciel', ...)` / `settingsScope`。设置服务可以晚到、替换或卸载；客户端只解除自身订阅，不销毁共享 ConfigForm。
- Session V4 的独立 `tool` 消息映射到只读证据视图，保留错误、咨询配额与结果归属；不会重写会话。
- 识别 `compact-checkpoint`、`runtime-context` 和 `developer/message`。恢复原始用户输入仍要求完整的压缩事务和被替换节点引用，压缩摘要不会冒充用户原话。
- 原生侧栏现在保留隐藏的 Session 子树。验证按当前可见 Session 和宿主布局顺序定位，覆盖 Jev、原文凭据、会话切换及文件对照。
- DeepSeek 的显式付费验证入口允许新版 `/v1/messages`，旧版 `/chat/completions` 仍受支持；离线验证未调用外部模型。

## 升级前保留旧设置

[新版 Settings](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-alpha.1/packages/settings/settings/README.md) 一次性导入旧 `settings.yaml`，按入口 ID 匹配。Ciel 的旧命名空间 `ciel` 与入口 `advisor` 不同；本地玻璃主题的 `dsh-theme-endfield-glass` 与入口 `endfield-glass` 也不同。

工具同时迁移两个宿主设置：`subagent-model-selection` → `subagent-model-selection-settings`；`agent-presets.default` → `agent-preset-registry.selectedDefault`，保留用户选择并与宿主部署默认值区分。

先停止将要升级的实例，再预览：

```sh
DSH_CHECKOUT=/path/to/built/dsh node scripts/migrate-dsh-017-settings.mjs --home /path/to/dsh-home
```

核对后加 `--apply`：迁移上述命名空间和预设字段，保留其他设置、注释，以及目标段已有的字段；同名冲突以目标段为准。预览只显示名称与字段数，不输出值。执行前创建权限为 0600 的原文备份，替换前检查输入未变化，重复执行不再改写。此工具用于升级前的旧文档，不会覆盖新版已写入 Profile 的设置。

如果新版已把文档改名为 `settings.yaml.imported`，先停止实例，单独核对 Profile 中的现有选择，再恢复需要的字段；不要把旧备份盲目导入。自动脚本不推断这种升级后的冲突。

升级时需要安装本目录构建出的适配包，不能仅升级 DSH 后继续使用旧主题安装包。源码链接环境还应重新运行 `scripts/link-harness-peers.mjs`，将共享模块指向实际运行的 DSH；**隔离验证时不要把正式插件链接切到验证 worktree**。

## 已验证

- Ciel 637 项单元测试，在 Schema 3.18.3 的引用配置下通过。
- 新版真实 Agent / PTC / Session 链路 54 个离线场景通过，包含 Jev 旁路、压缩、分叉、全文证据和取消。
- 新版原生侧栏 22 项、原生设置页面、真实 Registry / Gateway 协议通过。
- 真实 Loader + ConfigEditor + Settings：表单发现、即时修改、同一 fiber、通知、输入拒绝、Profile 持久化及重启恢复通过；同一脚本可同时验证玻璃主题。
- 迁移工具的预览、备份、冲突保留、注释、非法输入、幂等及输出脱敏测试通过。
- CI 增加 0.1.6-alpha.2 / 0.1.7-alpha.1 两个固定提交；本地结果不等同于远端 CI 已运行。

```sh
DSH_CHECKOUT=/path/to/built/dsh node scripts/verify-runtime.mjs
DSH_CHECKOUT=/path/to/built/dsh node scripts/verify-protocol.mjs
DSH_CHECKOUT=/path/to/built/dsh GLASS_PLUGIN=/path/to/glass node scripts/verify-profile-settings.mjs
DSH_CHECKOUT=/path/to/built/dsh node --test scripts/test/settings-migration.test.mjs
# 以下从 DSH checkout 执行，使用其 tsx 和客户端 tsconfig：
DSH_CHECKOUT="$PWD" TSX_TSCONFIG_PATH="$PWD/tsconfig.base.client.json" node --import tsx/esm /path/to/ciel/scripts/verify-sidebar-native.mjs
DSH_CHECKOUT="$PWD" TSX_TSCONFIG_PATH="$PWD/tsconfig.base.client.json" node --import tsx/esm /path/to/ciel/scripts/verify-native-settings.mjs
```

本轮没有升级或重启正式实例，没有迁移正式设置或会话，也没有调用付费模型。Session V4 的实际升级与回退风险属于宿主迁移流程；不能把只读兼容消费解释为会话格式可降级。
