import { isAdvisorJev } from '../review-protocol.js'

const statusLabels = { completed: '已完成', partial: '部分完成', skipped: '已跳过', error: '不可用', cancelled: '已取消' }
const reasons = {
  disabled: '开关已关闭', 'no-eligible-claims': '没有可检查的结构化建议', 'missing-key': '请在设置 → 夏尔 Ciel → Jev API 配置中填写密钥；官方接口也可使用 TYPESAFE_API_KEY',
  'invalid-config': 'Jev API 配置无效，请检查 HTTPS 地址、模型 ID 和密钥格式',
  'time-unavailable': '咨询剩余时间不足', cancelled: '检查已取消', timeout: '检查超时',
  'http-error': '服务请求失败', 'invalid-response': '服务响应无法解析', 'transport-error': '服务连接失败',
  'no-exact-claim': '建议缺少方向正文', 'sensitive-input': '输入包含敏感内容',
  'input-too-large': '问题、背景和建议超过单次检查大小限制',
}

export function advisorJevSummary(result) {
  if (!isAdvisorJev(result)) return 'Jev 顾问建议检查：结果无法解析'
  const conflicts = result.checks.filter(row => row.relation === 'contradicts').length
  return 'Jev 顾问建议检查 · ' + statusLabels[result.status] + (conflicts ? ' · 背景冲突 ' + conflicts + ' 项' : '')
}

/** Historical results only; rendering never starts a check. */
export function advisorJevPanel(h, result) {
  if (!result) return null
  if (!isAdvisorJev(result)) return h('p', { 'data-ciel-advisor-jev': 'invalid' }, advisorJevSummary(result))
  return h('section', { 'data-ciel-advisor-jev': result.status, 'aria-label': 'Jev 顾问建议检查' },
    h('strong', {}, advisorJevSummary(result)),
    h('p', {}, '仅对照本次传入的背景，未独立查证事实。依据不足不代表建议错误，采用前仍需验证。'),
    result.reason ? h('p', {}, reasons[result.reason] || result.reason) : null,
    result.omittedChecks ? h('p', {}, '另有 ' + result.omittedChecks + ' 条建议未检查。') : null,
    h('p', {}, (result.model || result.requestedModel) + ' · ' + result.requestCount + ' 次请求 · ' + result.elapsedMs + ' ms'
      + (result.usage ? ' · 输入 ' + result.usage.inputTokens + ' / 输出 ' + result.usage.outputTokens + ' tokens' : '')),
    ...result.checks.map(row => h('p', { key: row.id, 'data-ciel-advisor-jev-check': row.id },
      '建议 ' + row.id.slice(1) + '：' + (row.status === 'completed'
        ? { supports: '背景支持', contradicts: '背景冲突', insufficient: '依据不足' }[row.relation]
        : '未检查（' + (reasons[row.reason] || row.reason) + '）'))))
}
