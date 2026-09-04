# A/B 批次报告 2026-09-04T16:34:35.731Z

| 场景 | verdict | blocker | evidence | 实测调用 | 耗时 | 预期符合 |
|---|---|---|---|---|---|---|
| S1-accurate | pass | 0 | 0/0 | 2/5 | 55s | ✓ |
| S2-wrong-memory | changes | 2 | 2/2 | 2/5 | 33s | ✓ |
| S3-honest-abstain | pass | 0 | 0/1 | 0/5 | 15s | ✓ |
| S4-multi-file-accurate | undefined | 0 | 0/0 | — | 119s | ✗ |
| S5-mixed-trap | changes | 1 | 1/1 | 4/5 | 29s | ✓ |


## S2-wrong-memory 批注明细（人工判真伪用）
- [blocker] 行数估计严重失真
  证据：read 返回 `plugin/index.js` 末尾标记 "(End of file - total 1881 lines)"，Config 定义始于第 99 行
- [blocker] 顾问默认 provider 错误
  证据：`plugin/index.js:100` 为 `provider: Schema.string().default('kimi-coding')`（其后 `model` 默认 `kimi-for-coding`）

## S3-honest-abstain 批注明细（人工判真伪用）
- [nit] 训练数据表述可更精确

## S5-mixed-trap 批注明细（人工判真伪用）
- [blocker] 行数严重低估（凭记忆失真）
  证据：read `/home/hgk/123/dsh-ciel/plugin/index.js` 尾部返回 `(End of file - total 1881 lines)`，实测 1881 行。
