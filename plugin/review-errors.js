// Public diagnostics contain no paths, provider payloads, prompts or causes.
const errors = {
  CIEL_PROTOCOL_REQUEST_INVALID: ['评审请求与当前协议不匹配；请刷新页面，持续失败时核对 Ciel Host 与 Client 版本。', false],
  CIEL_PROTOCOL_RESPONSE_INVALID: ['评审返回结构无效；请核对 Ciel Host 与 Client 版本后重新加载记录。未将其当作空记录或评审结束。', false],
  CIEL_REVIEW_MODULE_MISSING: ['评审依赖模块无法加载；请检查 Ciel 与 DSH 安装是否完整。', false],
  CIEL_REVIEW_INTERFACE_MISMATCH: ['评审依赖接口不兼容；请核对 Ciel 与当前 DSH 版本。', false],
  CIEL_REVIEW_SERVICE_NOT_READY: ['评审服务尚未就绪；请稍后重试。', true],
  CIEL_REVIEW_GUARD_UNAVAILABLE: ['受限评审守卫不可用；请检查 DSH 工具服务，未启动评审。', false],
  CIEL_REVIEW_RUNTIME_INCOMPATIBLE: ['评审运行时语言或接口不兼容；请核对 DSH 运行时配置。', false],
  CIEL_REVIEW_RUNTIME_INIT_FAILED: ['私有评审运行时初始化失败；请检查运行环境后重试。', false],
  CIEL_REVIEW_REGISTRY_INIT_FAILED: ['私有评审工具注册失败；请检查 DSH 工具接口后重试。', false],
  CIEL_REVIEW_BACKEND_UNAVAILABLE: ['受限评审后端初始化失败；请检查插件与 DSH 依赖后重试。', false],
  CIEL_REVIEW_EXECUTION_FAILED: ['评审执行失败；可重试本次评审。', true],
  CIEL_REVIEW_CLEANUP_FAILED: ['评审资源释放失败；请查看宿主诊断后再试。', false],
  CIEL_REVIEW_ACCESS_LIMITED: ['评审访问被限制；请检查批准的资料范围，未放宽权限。', false],
  CIEL_REVIEW_CANCELLED: ['评审已取消；可重新发起评审。', false],
  CIEL_REVIEW_TIMEOUT: ['review timeout：评审已到总时限，本次已停止；请缩小评审范围后重试。', false],
  CIEL_REMOTE_NOT_READY: ['评审服务尚未就绪；请稍后点击重试。', true],
  CIEL_REMOTE_INTERFACE_MISMATCH: ['评审 Remote 接口不兼容；请核对安装并刷新页面。', false],
  CIEL_REMOTE_MOUNT_FAILED: ['评审 Remote 注册失败；请点击重试，持续失败时核对 DSH 接口。', false],
  CIEL_REMOTE_DISPOSED: ['Ciel 已停用；请启用插件后重试。', false],
}

export function reviewErrorDetails(code) {
  if (!Object.hasOwn(errors, code)) return undefined
  const [error, retryable] = errors[code]
  return { code, error, retryable }
}

export function reviewFailure(code, stage) {
  const detail = reviewErrorDetails(code) || reviewErrorDetails('CIEL_REVIEW_BACKEND_UNAVAILABLE')
  const error = new Error(detail.error)
  Object.assign(error, detail, { stage: ['dependencies', 'guard', 'runtime', 'registry', 'provider', 'create', 'run', 'cleanup'].includes(stage) ? stage : undefined })
  // A public error must not expose the original stack/cause to Remote or disk.
  error.stack = 'Error: ' + error.message
  return error
}

export function classifyReviewFailure(error, fallback, stage) {
  return reviewFailure(reviewErrorDetails(error?.code) ? error.code : fallback, stage)
}
