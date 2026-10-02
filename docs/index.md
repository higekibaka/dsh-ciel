# 文档索引与维护规则

<!-- ciel-doc: current -->

当前发布基线：**Ciel 0.20.1**。功能与默认值以代码为依据，发布事实以版本化记录和成功的远端结果为依据；“文件已修改”不等于日常实例已加载。

## 现行文档

- [中文 README](../README.md) / [English README](../README.en.md)：安装、功能、费用与配置；英文版是 npm README 的唯一正文来源。
- [评审契约](review-contract.md)：输入归属、逐项调查、证据、取消和草稿交互。
- [架构](architecture.md) / [容量与恢复决策](architecture-decisions.md)：模块责任、生命周期与尚未实现的能力。
- [读取隔离](read-isolation.md) / [安全与发布](../SECURITY.md)：源码副本、归档、凭据、数据出口和公开范围。
- [Jev 配置与实验](jev-evidence-experiment.md) / [历史事实证据](host-fact-evidence.md)：可选检查、API 配置及数据来源。
- [共享依赖](compatibility-alpha2.md) / [0.1.7 设置迁移](compatibility-017.md)：开发链接和升级边界。

## 发布验证记录

**0.20.1** 是文档补丁，将校准后的 npm README 与文档一致性检查纳入发布；运行时代码、默认值和记录格式与 0.20.0 相同，无需迁移。版本说明见 [CHANGELOG](../CHANGELOG.md)。本版发布前本地验证通过 703 项插件测试、8 项文档测试及 23 份公开 Markdown 一致性检查；未扩展日常 GUI 或真实模型验收范围。

以下记录固定于 **0.20.0**，以后新增测试不回改这些计数：

- 发布标签 v0.20.0 指向 `f0eb5c5044e6b9f851ebbeffd5e7da4aba85d996`。发布提交的 [CI](https://github.com/higekibaka/dsh-ciel/actions/runs/37063769171) 通过；后续仅工作流修复提交 `555a8d05aed3d9a680a10e0e3e4f7f855af38e55` 的 [CI](https://github.com/higekibaka/dsh-ciel/actions/runs/37064618781) 也通过。
- 固定集成目标：
  - dsh-v0.1.6-alpha.2：ddefc45fbc7f8e46dd73185e68295696d1297887
  - dsh-v0.1.7-alpha.1：c36a83ff6bb95e3f82cf79f9be7c724270a8aa61
  - dsh-v0.2.0-rc.2：639ed015397290b3745d163aafe02ffee4aa3f84
- 703 项单元测试、57 个真实 Host 离线执行链场景、22 项原生侧栏检查通过；另有协议、原生设置、Profile 持久化/密钥脱敏/清除、迁移检查。执行链使用脚本模型，未请求外部付费 API。
- [发布流水线](https://github.com/higekibaka/dsh-ciel/actions/runs/37064758406) 用已验证的原标签完成 npm OIDC 发布和 [GitHub Release](https://github.com/higekibaka/dsh-ciel/releases/tag/v0.20.0)，未移动标签。首次发布在 npm 上传前因 npm 12 打包 JSON 变化失败，后将工具固定为 npm 11 后重试。
- 当时 npm latest 已核验为 0.20.0；30 个包内文件逐字节匹配当时的候选，完整性摘要通过，具有 [来源证明](https://registry.npmjs.org/-/npm/v1/attestations/dsh-ciel@0.20.0)。Host 模块导入和打包的 QuickJS worker 在生产依赖 + 宿主共享模块下通过冒烟。
- **未验证**：新 Jev API 字段的日常 GUI 在线验收、真实提供方质量/成本、长期负载及 Windows Desktop。2026-09-30 的隔离 Web UI 检查不包含随后加入的 API 设置。安装仍需正常重启 Host 和刷新浏览器。

## 历史资料

历史页保留写作时的事实、计数和待办，不自动升级为当前保证：

- [设计动机](design.md)、[早期批评者计划](iteration-critic-ux.md)。
- [0.17 只限时](time-only-review.md)、[0.18 受限 PTC](ptc-review.md)、[2026-09-30 UI 集成](ui-redesign-20260930.md)。
- [DSH 0.1.5](upgrade-dsh-0.1.5.md)、[DSH 0.1.5-alpha.2](upgrade-dsh-0.1.5-alpha.2.md)。
- [0.13 A/B](ab/ab-comparison-0.13.0.md)、[早期稳定性验证](ab/stability-verification.md)。
- [CHANGELOG](../CHANGELOG.md) 中已发布条目保留历史；新改动写入 Unreleased。

## 维护与自动检查

1. 修改设置字段/默认值时，同步中英文 README 配置表；检查器直接比较 Host Config，不另抄一份默认值。
2. 修改产品行为时同步现行契约与安全边界；不要只在历史页追加“开发版”补丁。新的能力若未发布，应明确归于 Unreleased，不把发布页说成已有。
3. 更新英文 README 后执行 `pnpm docs:sync`，生成 npm README，再运行 `pnpm check:docs`。生成页不要手改；默认值、版本、最新 changelog 版本、现行/历史分类、相对链接和 CI 固定目标有自动约束。
4. 测试数量必须带版本/日期/范围，远端通过须附成功 run 链接；离线夹具、隔离 Web、日常 GUI 和真实模型分别记录。自动检查不能证明所有自然语言描述或外部链接正确。
5. 发布前更新版本、安装命令和 CHANGELOG；先通过 CI，再推标签。发布流程使用 npm 11。上传前失败可修复 workflow 后以 workflow_dispatch 指定既有标签重试，不移动已公开标签；需要仓库 Actions 写权限。上传已成功时先核对 registry 状态，不直接重复 publish。
6. **main 文档与不可变 npm 包不是同一份状态**：发布后的文档修正可先落在仓库；已发布版本的包内 README 不会随 main 更新，也不能覆盖同版本。0.20.1 携带本轮更新后的 npm README；后续文档修正仍需新版本才能进入 npm 包。
