# A/B 批次报告 2026-09-04T16:24:12.470Z

| 场景 | verdict | blocker | evidence | 实测调用 | 耗时 | 预期符合 |
|---|---|---|---|---|---|---|
| S1-accurate | pass | 0 | 0/0 | 2/5 | 6s | ✓ |
| S2-wrong-memory | changes | 2 | 2/2 | 1/5 | 7s | ✓ |
| S3-honest-abstain | pass | 0 | 0/0 | 0/5 | 5s | ✓ |
| S4-multi-file-accurate | pass | 0 | 0/0 | 5/5 | 16s | ✓ |
| S5-mixed-trap | pass | 0 | 1/1 | 1/5 | 12s | ✓ |


## S2-wrong-memory 批注明细（人工判真伪用）
- [blocker] 文件规模估计严重偏小
  证据：read /home/hgk/123/dsh-ciel/plugin/index.js 证实该文件总行数为 1881 行
- [blocker] 顾问默认 provider 错误
  证据：read /home/hgk/123/dsh-ciel/plugin/index.js:100 证实 Config 中 provider 的默认值为 'kimi-coding'

## S5-mixed-trap 批注明细（人工判真伪用）
- [nit] 记忆估算行数与实际规模偏差较大
  证据：/home/hgk/123/dsh-ciel/plugin/index.js 实际总行数为 1881 行
