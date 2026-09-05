// dsh-ciel browser half: the Settings → Plugins → 插件配置 card editing the
// `ciel` settings namespace owned by the host half (renamed from `advisor`
// in 0.11.0; the host migrates legacy sections on boot). Self-contained by hand
// (no bundler): the client module system wraps this file in a CJS factory and
// the kernel adopts { apply, inject } as a client plugin.
//
// The card mirrors the shipped plugin cards (PluginCard/fields in
// dsh-client-ui-settings-plugins): collapsed by default, name-over-description
// header, staged drafts with one save point, per-field override badge and
// reset, and a save that writes through the revision-fenced settings scope.
// Provider/model are dropdowns fed by the `session.modelCatalog` Remote (the
// same source the shipped Subagent card uses; it replaced the removed
// `connection.api.llm.models` RPC), degrading to text inputs when the
// catalog is unreachable.

window.__ModuleLoader__.load({
  id: 'dsh-ciel',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const { useState, useEffect } = React
    const h = React.createElement

    /** Bound in apply() before the card registers. */
    let scope = null
    /** Lazy remote readers: a hard inject would park the card's registration. */
    let getSessionRemote = () => undefined
    let getRemote = () => undefined
    /** Client cordis event subscription, bound in apply(). */
    let clientOn = null
    /** Live internals captured by apply() for node integration tests. */
    const __runtime = {}

    /** Mirror of the host schema defaults — what a reset stages. */
    const DEFAULTS = {
      provider: 'kimi-coding',
      model: 'kimi-for-coding',
      maxTokens: 4096,
      maxCallsPerTurn: 3,
      requireExploration: true,
      enforceFollowupGap: true,
      planReminderEnabled: true,
      reasoningEffort: 'provider',
      guidanceEnabled: true,
      criticProvider: 'google',
      criticModel: 'gemini-3.8-flash',
      criticEffort: 'medium',
      criticExploreEnabled: true,
      criticExploreBudget: '5',
      enabled: true,
      criticTimeoutSeconds: 180,
      criticMaxRequests: 16,
      criticMaxTokens: 16384,
      advisorTimeoutSeconds: 180,
    }
    const MAX_TOKENS_MIN = 256
    const MAX_TOKENS_MAX = 32768
    const MAX_CALLS_MIN = 1
    const MAX_CALLS_MAX = 20

    /** Reasoning-effort levels the host schema admits, in escalation order. */
    const EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    const EFFORT_LABELS = {
      provider: '跟随提供方默认',
      off: '关闭',
      minimal: '极简',
      low: '低',
      medium: '中',
      high: '高',
      xhigh: '极高',
      max: '最大',
    }

    /**
     * Declarative field descriptors — the card body is one map over this
     * list. kinds: route (catalog dropdown, text fallback), effort (reasoning
     * dropdown tracking the selected route), number (validated text input),
     * check (boolean toggle), group (collapsible section folding its
     * children behind a header row; groups nest, and `summarize` renders the
     * closed-state preview of the descendant staged values).
     * `fallback` is the value a dirty-check compares against when the
     * snapshot leaves the key unset.
     */
    const FIELD_DEFS = [
      {
        kind: 'group', key: 'advisor', label: '顾问管道', defaultOpen: false,
        summarize: (staged) => `${staged.provider} / ${staged.model} · ${staged.reasoningEffort}`,
        children: [
          { kind: 'route', key: 'provider', label: '提供方路由', options: 'provider', hint: '须是「设置 → 模型」中已注册的 provider 路由。' },
          { kind: 'route', key: 'model', label: '顾问模型', options: 'model', hint: '与主模型跨家族时多样性收益最大。' },
          {
            kind: 'effort', key: 'reasoningEffort', label: '思考深度', opts: 'advisor', fallback: 'provider',
            hintReady: '注入该次咨询每个请求的思考深度；跟随提供方默认则不注入。选项与所选模型声明的档位一致。',
            hintFallback: '注入该次咨询每个请求的思考深度；跟随提供方默认则不注入。模型目录不可用，未校验档位支持。',
          },
          {
            kind: 'group', key: 'advisor-advanced', label: '生成参数与行为开关', defaultOpen: false,
            summarize: (staged) => `${staged.maxTokens} tokens · ${staged.maxCallsPerTurn} 次/轮`,
            children: [
              { kind: 'number', key: 'maxTokens', label: '输出上限（tokens）', min: MAX_TOKENS_MIN, max: MAX_TOKENS_MAX, hint: '顾问单次回答的长度上限。' },
              { kind: 'number', key: 'maxCallsPerTurn', label: '每轮咨询额度', min: MAX_CALLS_MIN, max: MAX_CALLS_MAX, hint: '一个 turn（≈一个规划阶段）内允许的顾问调用上限：1 次发散 + 追问预算；超出即被拒绝。' },
              { kind: 'check', key: 'requireExploration', label: '首次咨询前要求先探查', hint: '本会话内首个 ask_advisor 调用前，必须已有至少一次非顾问工具调用（读/搜/跑）。' },
              { kind: 'check', key: 'enforceFollowupGap', label: '追问之间要求独立工作', hint: '同一 turn 内两次咨询之间必须至少有一次非顾问工具调用——追问须由新事实驱动。' },
              { kind: 'check', key: 'planReminderEnabled', label: '规划时刻提醒', hint: '检测到本 turn 开始规划（todo_write / exit_plan_mode）且尚未咨询时，在下一步系统提示里注入一次提醒；机制不做任务语义判断。' },
              { kind: 'check', key: 'guidanceEnabled', label: '注入使用协议到系统提示词', hint: '触发判据与追问预算；改动即刻生效（影响提示词前缀）。' },
            ],
          },
        ],
      },
      {
        kind: 'group', key: 'critic', label: '批评者（批注评审）路由', defaultOpen: false,
        summarize: (staged) => `${staged.criticProvider} / ${staged.criticModel} · ${staged.criticEffort}${staged.enabled ? '' : ' · 已停用'}`,
        children: [
          {
            kind: 'check', key: 'enabled', label: '启用批评者评审',
            hint: '控制批评者模型调用与评审/回传/分诊的模型请求。关闭后不再发起新的评审模型调用，但仍可查看既有评审结果（不读取也不屏蔽现有内容）。',
          },
          { kind: 'route', key: 'criticProvider', label: '批评者提供方', options: 'provider', hint: '评审子代理的 provider 路由；跨家族纠错收益最大。独立于上面的顾问管道。' },
          { kind: 'route', key: 'criticModel', label: '批评者模型', options: 'criticModel', hint: 'gemini-3.8-flash 过载时可临时切走（如 deepseek flash）。' },
          {
            kind: 'effort', key: 'criticEffort', label: '批评者思考深度', opts: 'critic', fallback: 'medium',
            hintReady: '注入评审子代理的每个请求；跟随提供方默认则不注入。选项与所选模型声明的档位一致（gemini-3.8-flash 仅 low/medium/high）。',
            hintFallback: '注入评审子代理的每个请求；跟随提供方默认则不注入。模型目录不可用，未校验档位支持。',
          },
          {
            kind: 'group', key: 'critic-safety', label: '评审安全参数', defaultOpen: false,
            summarize: (staged) => `${staged.criticTimeoutSeconds}s · ≤${staged.criticMaxRequests} 请求 · ≤${staged.criticMaxTokens}tokens`,
            children: [
              { kind: 'number', key: 'criticTimeoutSeconds', label: '评审超时（秒）', min: 10, max: 600, hint: '单次评审的硬超时，超时即熔断标记失败。是每次评审的时限，不是计费额度。' },
              { kind: 'number', key: 'criticMaxRequests', label: '模型请求上限', min: 2, max: 32, hint: '单次评审允许的模型请求次数（阶段1+阶段2+抢救）上限，超限即熔断。按「次」计，不直接等于费用。' },
              { kind: 'number', key: 'criticMaxTokens', label: '单次请求输出上限（tokens）', min: 256, max: 32768, hint: '评审子代理单次回答的长度上限（输出侧）；技术上限，不是金额配置。' },
            ],
          },
          {
            kind: 'group', key: 'critic-explore', label: '探索（两阶段评审）', defaultOpen: false,
            summarize: (staged) => (staged.criticExploreEnabled ? '开' : '关') + ' · 预算 ' + staged.criticExploreBudget,
            children: [
              { kind: 'check', key: 'criticExploreEnabled', label: '探索型批评者（先取证后裁决）', hint: '评审时对可证伪疑点做只读定点核实（read/grep/glob 白名单——世界可碰、过程不许碰），排除的疑点只计入统计不进批注；关闭后仅做阶段1存疑与裁决，不做只读核实。' },
              { kind: 'number', key: 'criticExploreBudget', label: '探索预算硬上限', min: 0, max: 10, hint: '单次评审允许的只读工具调用次数，超出即熔断该次评审并明确报错；0 = 不启用探索（只做存疑与裁决），模型仍会调用并计费，不等于停用评审。' },
            ],
          },
        ],
      },
      {
        kind: 'group', key: 'advisor-safety', label: '顾问安全参数', defaultOpen: false,
        summarize: (staged) => `${staged.advisorTimeoutSeconds}s`,
        children: [
          { kind: 'number', key: 'advisorTimeoutSeconds', label: '单次咨询总超时（秒）', min: 10, max: 600, hint: '一次 ask_advisor 或 /advise 的整体（总）截止时间，超时即中断返回。按「次」计，不是计费额度。' },
        ],
      },
    ]
    /** Recursive leaf walk: group wrappers index their descendants. */
    const FIELD_DEF_BY_KEY = {}
    const FIELD_KEYS = []
    const INITIAL_CLOSED_GROUPS = {}
    const walkDefs = (defs) => {
      for (const def of defs) {
        if (def.kind === 'group') {
          if (def.defaultOpen === false) INITIAL_CLOSED_GROUPS[def.key] = true
          walkDefs(def.children)
          continue
        }
        FIELD_DEF_BY_KEY[def.key] = def
        FIELD_KEYS.push(def.key)
      }
    }
    walkDefs(FIELD_DEFS)

    const css = {
      card: {
        listStyle: 'none',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '12px',
        background: 'var(--dsw-alias-bg-layer-3)',
        transition: 'border-color .16s, background .16s',
      },
      header: {
        width: '100%',
        appearance: 'none',
        border: 0,
        background: 'none',
        font: 'inherit',
        color: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '14px 16px',
        borderRadius: '12px',
      },
      headText: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' },
      name: { fontSize: '15px', fontWeight: 600, lineHeight: 1.4, color: 'var(--dsw-alias-label-primary)' },
      description: { fontSize: '13px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
      pending: {
        flex: 'none',
        borderRadius: '999px',
        padding: '1px 8px',
        fontSize: '11px',
        lineHeight: '17px',
        fontWeight: 500,
        whiteSpace: 'nowrap',
        background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      body: {
        borderTop: '1px solid var(--dsw-alias-border-l2)',
        margin: '0 16px',
        paddingBottom: '8px',
      },
      readOnly: { margin: '12px 0 0', fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
      field: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px 0' },
      fieldBorder: { borderTop: '1px solid var(--dsw-alias-border-l2)' },
      head: { display: 'flex', alignItems: 'center', gap: '8px' },
      label: { flex: 1, minWidth: 0, fontSize: '13px', fontWeight: 500, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)' },
      badges: { display: 'inline-flex', alignItems: 'center', gap: '8px' },
      badge: {
        borderRadius: '999px',
        padding: '1px 8px',
        fontSize: '11px',
        lineHeight: '17px',
        whiteSpace: 'nowrap',
        fontWeight: 500,
        background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      reset: {
        border: 'none',
        background: 'none',
        padding: 0,
        font: 'inherit',
        fontSize: '12px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
      },
      input: {
        height: '34px',
        padding: '0 12px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-3)',
        font: 'inherit',
        fontSize: '13px',
        color: 'var(--dsw-alias-label-primary)',
        width: '100%',
        boxSizing: 'border-box',
      },
      inputInvalid: {
        border: '1px solid var(--dsw-alias-label-error)',
      },
      hint: { margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
      groupHead: {
        width: '100%',
        appearance: 'none',
        border: 'none',
        background: 'none',
        padding: 0,
        font: 'inherit',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        cursor: 'pointer',
        textAlign: 'left',
      },
      groupLabel: { fontSize: '12px', fontWeight: 600, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
      groupSummary: {
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        textAlign: 'right',
        fontSize: '12px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-tertiary)',
      },
      invalidText: { margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-error)' },
      checkRow: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
      footer: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: '8px',
        padding: '12px 0 4px',
        borderTop: '1px solid var(--dsw-alias-border-l2)',
      },
      failed: { flex: 1, minWidth: 0, margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-error)' },
      discard: {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '8px',
        padding: '5px 14px',
        font: 'inherit',
        fontSize: '13px',
        lineHeight: 1.5,
        cursor: 'pointer',
        background: 'none',
        color: 'var(--dsw-alias-label-secondary)',
      },
      save: {
        appearance: 'none',
        border: '1px solid transparent',
        borderRadius: '8px',
        padding: '5px 14px',
        font: 'inherit',
        fontSize: '13px',
        lineHeight: 1.5,
        cursor: 'pointer',
        background: 'var(--dsw-alias-label-primary)',
        color: 'var(--dsw-alias-bg-layer-3)',
      },
      disabled: { opacity: 0.4, cursor: 'default' },
    }

    function Chevron({ open }) {
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 14 14',
        'aria-hidden': true,
        style: {
          flex: 'none',
          color: 'var(--dsw-alias-label-tertiary)',
          transition: 'transform .16s',
          transform: open ? 'rotate(180deg)' : 'none',
        },
      }, h('path', {
        d: 'M3.5 5.25 7 8.75l3.5-3.5',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    }

    /** Field head row: label plus the override badge and reset link. */
    function FieldHead({ label, overridden, disabled, onReset }) {
      return h('div', { style: css.head },
        h('span', { style: css.label }, label),
        overridden
          ? h('span', { style: css.badges },
              h('span', { style: css.badge }, '已覆盖'),
              h('button', { type: 'button', style: css.reset, disabled, onClick: onReset }, '重置'))
          : null,
      )
    }

    function AdvisorCard() {
      const [, setTick] = useState(0)
      const [open, setOpen] = useState(false)
      const [drafts, setDrafts] = useState(null)
      const [resets, setResets] = useState({})
      const [saving, setSaving] = useState(false)
      const [saveFailed, setSaveFailed] = useState(false)
      const [catalog, setCatalog] = useState({ status: 'idle', groups: [] })
      const [groupClosed, setGroupClosed] = useState(() => ({ ...INITIAL_CLOSED_GROUPS }))

      useEffect(() => {
        if (scope === null) return undefined
        return scope.subscribe(() => setTick((tick) => tick + 1))
      }, [])

      // Lazy catalog load on expand: the dropdown source is the
      // `session.modelCatalog` Remote (ClientResult envelope), successor of
      // the removed `connection.api.llm.models` RPC — same groups shape the
      // shipped Subagent card consumes. A failed load is NOT latched: the
      // hint offers a retry that re-stages 'idle'.
      useEffect(() => {
        if (!open || catalog.status !== 'idle') return
        const session = getSessionRemote()
        if (!session || typeof session.modelCatalog !== 'function') {
          setCatalog({ status: 'unavailable', groups: [] })
          return
        }
        setCatalog({ status: 'loading', groups: [] })
        Promise.resolve(session.modelCatalog())
          .then((response) => {
            if (response && typeof response === 'object' && response.ok === false) {
              throw new Error((response.error && response.error.message) || '模型目录接口返回失败')
            }
            const value = response && typeof response === 'object' && 'value' in response
              ? response.value
              : response
            const groups = value && Array.isArray(value.groups) ? value.groups : []
            setCatalog({ status: 'ready', groups })
          })
          .catch(() => setCatalog({ status: 'unavailable', groups: [] }))
      }, [open, catalog.status])

      // New invalidation model: provider-topology pushes and connection
      // resets expire a fetched catalog, so the next expand refetches (and
      // an open card converges without polling), matching the shipped cards.
      useEffect(() => {
        const expire = () => setCatalog((current) =>
          current.status === 'ready' ? { status: 'idle', groups: [] } : current)
        const disposers = []
        if (clientOn) disposers.push(clientOn('connection/reset', expire))
        const remote = getRemote()
        if (remote && typeof remote.$on === 'function') {
          disposers.push(remote.$on('llm/adapters-updated', expire))
        }
        return () => { for (const dispose of disposers) dispose() }
      }, [])

      if (scope === null) return null
      const snap = scope.getSnapshot()
      // Like the shipped cards, an unavailable (or still-loading) namespace
      // renders nothing rather than a disabled shell.
      if (snap.status !== 'ready') return null
      const value = snap.value || {}
      const user = snap.user && typeof snap.user === 'object' ? snap.user : {}
      const overridden = (key) => Object.prototype.hasOwnProperty.call(user, key)

      // Stage drafts from the first ready snapshot; user edits own them until
      // a save lands or a discard re-stages.
      const staged = drafts || {
        provider: String(value.provider ?? ''),
        model: String(value.model ?? ''),
        maxTokens: String(value.maxTokens ?? ''),
        maxCallsPerTurn: String(value.maxCallsPerTurn ?? ''),
        requireExploration: Boolean(value.requireExploration),
        enforceFollowupGap: Boolean(value.enforceFollowupGap),
        planReminderEnabled: Boolean(value.planReminderEnabled),
        reasoningEffort: String(value.reasoningEffort ?? 'provider'),
        guidanceEnabled: Boolean(value.guidanceEnabled),
        criticProvider: String(value.criticProvider ?? ''),
        criticModel: String(value.criticModel ?? ''),
        criticEffort: String(value.criticEffort ?? 'medium'),
        criticExploreEnabled: Boolean(value.criticExploreEnabled ?? true),
        criticExploreBudget: String(value.criticExploreBudget ?? '5'),
        enabled: Boolean(value.enabled ?? true),
        criticTimeoutSeconds: String(value.criticTimeoutSeconds ?? ''),
        criticMaxRequests: String(value.criticMaxRequests ?? ''),
        criticMaxTokens: String(value.criticMaxTokens ?? ''),
        advisorTimeoutSeconds: String(value.advisorTimeoutSeconds ?? ''),
      }
      if (drafts === null) setDrafts(staged)

      /** Parse/validate one number descriptor against the staged draft. */
      const numState = (def) => {
        const parsed = Math.round(Number(staged[def.key]))
        const invalid = staged[def.key].trim() === ''
          || !Number.isFinite(parsed)
          || parsed < def.min
          || parsed > def.max
        return { parsed, invalid }
      }

      const dirtyKey = (key) => {
        if (resets[key]) return true
        const def = FIELD_DEF_BY_KEY[key]
        if (def && def.kind === 'number') {
          const { parsed, invalid } = numState(def)
          return !invalid && parsed !== value[key]
        }
        if (def && def.kind === 'check') return staged[key] !== Boolean(value[key])
        return staged[key] !== String(value[key] ?? (def && def.fallback) ?? '')
      }
      const dirty = FIELD_KEYS.some(dirtyKey)

      const edit = (key, next) => {
        setDrafts({ ...staged, [key]: next })
        if (resets[key]) {
          const rest = { ...resets }
          delete rest[key]
          setResets(rest)
        }
        setSaveFailed(false)
      }
      const resetField = (key) => {
        setDrafts({ ...staged, [key]: DEFAULTS[key] })
        setResets({ ...resets, [key]: true })
        setSaveFailed(false)
      }
      const discard = () => {
        setDrafts(null)
        setResets({})
        setSaveFailed(false)
      }
      const save = async () => {
        setSaving(true)
        setSaveFailed(false)
        try {
          for (const key of FIELD_KEYS) {
            if (resets[key]) {
              await scope.unset(key)
            } else if (dirtyKey(key)) {
              const def = FIELD_DEF_BY_KEY[key]
              const parsed = def && def.kind === 'number' ? numState(def).parsed : undefined
              await scope.set(key, parsed !== undefined ? parsed : staged[key])
            }
          }
          setDrafts(null)
          setResets({})
        } catch {
          setSaveFailed(true)
        } finally {
          setSaving(false)
        }
      }

      const disabled = !snap.writable || saving
      const groups = catalog.status === 'ready' ? catalog.groups : []
      const providerOptions = groups.map((group) => ({
        value: group.id,
        label: group.displayName || group.name || group.id,
      }))
      const selectedGroup = groups.find((group) => group.id === staged.provider)
      const modelOptions = selectedGroup && Array.isArray(selectedGroup.models)
        ? selectedGroup.models.map((model) => ({
            value: model.id,
            label: model.name ? `${model.name}（${model.id}）` : model.id,
          }))
        : []
      // 批评者路由（0.9.1）：独立于顾问路由的第二条子代理管道。
      const criticGroup = groups.find((group) => group.id === staged.criticProvider)
      const criticModelOptions = criticGroup && Array.isArray(criticGroup.models)
        ? criticGroup.models.map((model) => ({
            value: model.id,
            label: model.name ? `${model.name}（${model.id}）` : model.id,
          }))
        : []

      // Reasoning-effort options follow the SELECTED model's declared levels
      // when the catalog advertises them (adapter-supplied names, and the
      // model's own default marked); otherwise the full host-schema set
      // stays offered so the field remains usable without the catalog.
      // Both routes prepend 跟随提供方默认 — the host pin treats 'provider'
      // as "leave the request untouched" for advisor and critic alike.
      const effortOptionsFor = (providerKey, modelKey) => {
        const group = groups.find((g) => g.id === staged[providerKey])
        const sel = group && Array.isArray(group.models)
          ? group.models.find((model) => model.id === staged[modelKey])
          : undefined
        const declared = sel && sel.reasoning && Array.isArray(sel.reasoning.efforts)
          ? sel.reasoning.efforts
          : []
        const declaredName = {}
        for (const effort of declared) {
          if (effort && typeof effort.id === 'string') declaredName[effort.id] = effort.name
        }
        const modelDefault = sel && sel.reasoning && typeof sel.reasoning.defaultEffort === 'string'
          ? sel.reasoning.defaultEffort
          : undefined
        const levels = declared.length > 0 ? declared.map((effort) => effort.id) : EFFORT_LEVELS
        return {
          declared,
          options: [
            { value: 'provider', label: EFFORT_LABELS.provider },
            ...levels.map((level) => ({
              value: level,
              label: `${EFFORT_LABELS[level] || declaredName[level] || level}（${level}）${level === modelDefault ? ' · 模型默认' : ''}`,
            })),
          ],
        }
      }
      const advisorEffort = effortOptionsFor('provider', 'model')
      const criticEffortOpts = effortOptionsFor('criticProvider', 'criticModel')

      const selectStyle = { ...css.input, appearance: 'auto' }

      /** One dropdown or text fallback field for provider/model. */
      const routeField = (key, label, hint, options) => {
        const selectOptions = options.some((option) => option.value === staged[key])
          ? options
          : [...options, { value: staged[key], label: `${staged[key]}（自定义）` }]
        return h('div', { key, style: { ...css.field, ...css.fieldBorder } },
          h(FieldHead, {
            label,
            overridden: overridden(key) && !resets[key],
            disabled,
            onReset: () => resetField(key),
          }),
          options.length > 0
            ? h('select', {
                style: selectStyle,
                value: staged[key],
                disabled,
                onChange: (event) => edit(key, event.target.value),
              }, selectOptions.map((option) =>
                h('option', { key: option.value, value: option.value }, option.label)))
            : h('input', {
                style: css.input,
                type: 'text',
                value: staged[key],
                disabled,
                onChange: (event) => edit(key, event.target.value),
              }),
          h('p', { style: css.hint },
            catalog.status === 'loading'
              ? '正在加载模型目录（与「设置 → 模型」同源）…'
              : catalog.status === 'unavailable'
                ? h(React.Fragment, null,
                    '模型目录不可用，请直接输入 id。',
                    h('button', {
                      type: 'button',
                      style: css.reset,
                      disabled,
                      onClick: () => setCatalog({ status: 'idle', groups: [] }),
                    }, '重试'),
                    ' ',
                    hint)
                : hint),
        )
      }

      const checkField = (key, label, hint) =>
        h('div', { key, style: { ...css.field, ...css.fieldBorder } },
          h(FieldHead, {
            label,
            overridden: overridden(key) && !resets[key],
            disabled,
            onReset: () => resetField(key),
          }),
          h('label', { style: css.checkRow },
            h('input', {
              type: 'checkbox',
              checked: Boolean(staged[key]),
              disabled,
              onChange: (event) => edit(key, event.target.checked),
            }),
            h('span', null, Boolean(staged[key]) ? '已开启' : '已关闭'),
          ),
          h('p', { style: css.hint }, hint),
        )

      /** The reasoning-effort dropdown: always a select, options track the model. */
      const effortField = (key, label, opts, hintReady, hintFallback) => {
        const options = opts.options.some((option) => option.value === staged[key])
          ? opts.options
          : [...opts.options, { value: staged[key], label: `${staged[key]}（自定义）` }]
        const hint = catalog.status === 'ready'
          ? opts.declared.length > 0
            ? hintReady
            : '所选模型未声明思考档位；显式选择不支持的档位会在运行时报错。'
          : hintFallback
        return h('div', { key, style: { ...css.field, ...css.fieldBorder } },
          h(FieldHead, {
            label,
            overridden: overridden(key) && !resets[key],
            disabled,
            onReset: () => resetField(key),
          }),
          h('select', {
            style: selectStyle,
            value: staged[key],
            disabled,
            onChange: (event) => edit(key, event.target.value),
          }, options.map((option) =>
            h('option', { key: option.value, value: option.value }, option.label))),
          h('p', { style: css.hint }, hint),
        )
      }

      /** One validated numeric input, driven by its descriptor. */
      const numberField = (def) => {
        const { invalid } = numState(def)
        return h('div', { key: def.key, style: { ...css.field, ...css.fieldBorder } },
          h(FieldHead, {
            label: def.label,
            overridden: overridden(def.key) && !resets[def.key],
            disabled,
            onReset: () => resetField(def.key),
          }),
          h('input', {
            style: invalid ? { ...css.input, ...css.inputInvalid } : css.input,
            type: 'text',
            inputMode: 'numeric',
            value: staged[def.key],
            disabled,
            'aria-invalid': invalid || undefined,
            onChange: (event) => edit(def.key, event.target.value),
          }),
          h('p', { style: invalid ? css.invalidText : css.hint },
            invalid ? `须是 ${def.min}–${def.max} 之间的数字` : def.hint),
        )
      }

      const ROUTE_OPTIONS = { provider: providerOptions, model: modelOptions, criticModel: criticModelOptions }
      const EFFORT_OPTS = { advisor: advisorEffort, critic: criticEffortOpts }

      /** Dirty check across a group's whole descendant leaf set. */
      const groupDirty = (def) => def.children.some((child) =>
        child.kind === 'group' ? groupDirty(child) : dirtyKey(child.key))

      /** The card body: one recursive renderer dispatch over FIELD_DEFS. */
      const renderField = (def, depth) => {
        if (def.kind === 'group') {
          const open = groupClosed[def.key] !== true
          return h(React.Fragment, { key: def.key },
            h('div', { style: { ...css.field, ...css.fieldBorder, marginLeft: depth * 14 } },
              h('button', {
                type: 'button',
                style: css.groupHead,
                'aria-expanded': open,
                onClick: () => setGroupClosed({ ...groupClosed, [def.key]: open }),
              },
                h(Chevron, { open }),
                h('span', { style: css.groupLabel }, def.label),
                groupDirty(def) ? h('span', { style: css.pending }, '未保存') : null,
                open ? null : h('span', { style: css.groupSummary }, def.summarize(staged)))),
            open ? def.children.map((child) => renderField(child, depth + 1)) : null)
        }
        const el = def.kind === 'route' ? routeField(def.key, def.label, def.hint, ROUTE_OPTIONS[def.options])
          : def.kind === 'effort' ? effortField(def.key, def.label, EFFORT_OPTS[def.opts], def.hintReady, def.hintFallback)
            : def.kind === 'check' ? checkField(def.key, def.label, def.hint)
              : numberField(def)
        return depth > 0
          ? React.cloneElement(el, { style: { ...el.props.style, marginLeft: depth * 14 } })
          : el
      }

      const blocked = !dirty
        || FIELD_KEYS.some((key) => {
          const def = FIELD_DEF_BY_KEY[key]
          return def.kind === 'number' && numState(def).invalid
        })
        || saving

      return h('li', { style: css.card },
        h('button', {
          type: 'button',
          style: css.header,
          'aria-expanded': open,
          'aria-label': `${open ? '收起' : '展开'}: 夏尔 Ciel`,
          onClick: () => setOpen(!open),
        },
          h('span', { style: css.headText },
            h('span', { style: css.name }, '夏尔 Ciel'),
            h('span', { style: css.description }, '规划前咨询的第二模型：提供思路、领域知识与陷阱，不输出步骤。'),
          ),
          dirty ? h('span', { style: css.pending }, '未保存') : null,
          h(Chevron, { open }),
        ),
        open
          ? h('div', { style: css.body },
              !snap.writable ? h('p', { style: css.readOnly, role: 'status' }, '当前设置为只读。') : null,
              FIELD_DEFS.map((def) => renderField(def, 0)),
              h('div', { style: css.footer },
                saveFailed ? h('p', { style: css.failed, role: 'status' }, '保存未生效，请重试。') : null,
                h('button', {
                  type: 'button',
                  style: !dirty || saving ? { ...css.discard, ...css.disabled } : css.discard,
                  disabled: !dirty || saving,
                  onClick: discard,
                }, '放弃'),
                h('button', {
                  type: 'button',
                  style: blocked ? { ...css.save, ...css.disabled } : css.save,
                  disabled: blocked,
                  onClick: save,
                }, saving ? '保存中…' : '保存'),
              ),
            )
          : null,
      )
    }

    /** Pass-through codec: both halves of this Remote are first-party. */
    const PASS_CODEC = { parse: (value) => value }

    /** The advisorReview Remote contribution this client $mounts on boot. */
    const ADVISOR_REMOTE = {
      package: 'dsh-advisor',
      descriptors: ['list', 'start', 'feedback', 'triage', 'progress', 'cancel'].map((method) => ({
        id: `dsh-advisor#advisorReview/${method}`,
        service: 'advisorReview',
        namespace: 'advisorReview',
        method,
        invocation: { kind: 'direct' },
        parameters: [
          {
            name: 'request',
            wire: 'request',
            source: 'json',
            codec: { mode: 'strict', typeSymbol: `dsh-advisor/${method}Request`, schema: PASS_CODEC },
          },
        ],
        result: { mode: 'strict', typeSymbol: `dsh-advisor/${method}Result`, schema: PASS_CODEC },
      })),
    }

    /**
     * 0.12.0 ①块切分——host 半边的同算法副本（两端无共享打包通道）。
     * 任何修改必须与 plugin/index.js 的 splitMarkdownBlocks 逐行一致；
     * 共享夹具 test/blocks.fixtures.js 锁定两端输出。
     */
    function splitMarkdownBlocks(text) {
      const lines = String(text).split('\n')
      const blocks = []
      const isBlank = (l) => /^\s*$/.test(l)
      const isHeading = (l) => /^\s{0,3}#{1,6}\s/.test(l)
      const fenceMark = (l) => {
        const m = /^(\s*)(`{3,}|~{3,})/.exec(l)
        return m ? { ch: m[2][0], len: m[2].length } : null
      }
      const isTable = (l) => /^\s*\|/.test(l)
      const isQuote = (l) => /^\s*>/.test(l)
      const isListItem = (l) => /^\s*(?:[-*+]|\d{1,9}[.)])\s/.test(l)
      const isHr = (l) => /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(l)
      const push = (type, start, end) => {
        const body = lines.slice(start, end).join('\n')
        if (body.trim() === '') return
        blocks.push({ id: 'b' + (blocks.length + 1), type, text: body })
      }
      let i = 0
      while (i < lines.length) {
        if (isBlank(lines[i])) { i += 1; continue }
        const start = i
        const fence = fenceMark(lines[i])
        if (fence) {
          i += 1
          while (i < lines.length) {
            const m = fenceMark(lines[i])
            if (m && m.ch === fence.ch && m.len >= fence.len) { i += 1; break }
            i += 1
          }
          push('code', start, i)
          continue
        }
        if (isHeading(lines[i])) { push('heading', start, start + 1); i += 1; continue }
        if (isHr(lines[i])) { push('hr', start, start + 1); i += 1; continue }
        if (isTable(lines[i])) {
          i += 1
          while (i < lines.length && isTable(lines[i])) i += 1
          push('table', start, i)
          continue
        }
        if (isQuote(lines[i])) {
          i += 1
          while (i < lines.length && (isQuote(lines[i]) || (!isBlank(lines[i]) && !isHeading(lines[i]) && !fenceMark(lines[i])))) i += 1
          push('quote', start, i)
          continue
        }
        if (isListItem(lines[i])) {
          i += 1
          for (;;) {
            while (i < lines.length && !isBlank(lines[i]) && !isHeading(lines[i]) && !fenceMark(lines[i]) && !isTable(lines[i]) && !isHr(lines[i])) i += 1
            let j = i
            while (j < lines.length && isBlank(lines[j])) j += 1
            // 松散列表延续必须以严格前进为前提：j === i 意味着下一行就是边界
            // （缩进围栏/缩进标题等），i = j 会原地死循环——与 host 副本逐行一致。
            if (j > i && j < lines.length && (isListItem(lines[j]) || /^\s{2,}\S/.test(lines[j]))) { i = j; continue }
            break
          }
          push('list', start, i)
          continue
        }
        i += 1
        while (i < lines.length && !isBlank(lines[i]) && !isHeading(lines[i]) && !fenceMark(lines[i]) && !isTable(lines[i]) && !isQuote(lines[i]) && !isListItem(lines[i]) && !isHr(lines[i])) i += 1
        push('paragraph', start, i)
      }
      return blocks
    }

    /** ── Pure view-model helpers (factored for node tests) ────────────────
     * These derive coverage/soundness/labels/selection from a review entry and
     * progress object WITHOUT touching DOM or React, so plugin/test/*.test.js
     * can assert the exact decisions the review panel makes. Keep in sync with
     * the host contract in index.js (status/coverage/verdict/explore shapes).
     */

    // Normalize an entry's coverage. Explicit host field wins; otherwise derive
    // 'partial' from a legacy salvage marker or unchecked>0 count, else treat a
    // legacy sound/pass entry as 'complete' (backward compatibility).
    function deriveCoverage(entry) {
      if (!entry || typeof entry !== 'object') return 'not-verified'
      const cov = entry.coverage
      if (cov === 'complete' || cov === 'partial' || cov === 'not-verified') return cov
      if (entry.explore && entry.explore.salvaged) return 'partial'
      if (entry.stats && Number(entry.stats.unchecked) > 0) return 'partial'
      return 'complete'
    }

    // A fully covered nonblocking verdict may still contain verified nits.
    // Completion and severity are separate; unknown/incomplete work never
    // earns green, while legacy sound/pass records remain readable.
    function isSoundEntry(entry) {
      if (!entry || typeof entry !== 'object') return false
      const status = entry.status
      if (status === 'error' || status === 'cancelled' || status === 'incomplete' || status === 'unverified' || status === 'completed-unparsed') return false
      if (status !== 'sound' && entry.verdict !== 'pass') return false
      if (entry.verdict === 'changes' || (Array.isArray(entry.annotations) && entry.annotations.some((a) => a?.severity === 'blocker'))) return false
      if (deriveCoverage(entry) !== 'complete') return false
      if (entry.explore && entry.explore.salvaged) return false
      if (entry.stats && Number(entry.stats.unchecked) > 0) return false
      return true
    }

    function verdictBadgeClass(entry) {
      if (isSoundEntry(entry)) return 'dsr-vbadge-pass'
      if (entry && entry.verdict === 'changes') return 'dsr-vbadge-changes'
      return 'dsr-vbadge-neutral'
    }

    function verdictBadgeText(entry) {
      if (entry?.status === 'incomplete' || deriveCoverage(entry) === 'partial') return '◇ 部分核实'
      if (entry?.status === 'unverified' || deriveCoverage(entry) === 'not-verified') return '◇ 未独立核实'
      if (isSoundEntry(entry)) return '✓ 整体成立'
      if (entry && entry.verdict === 'changes') return '⚠ 建议修改'
      if (entry && entry.verdict === 'pass') return '◇ 未独立核实'
      return '批注评审'
    }

    // Button label for a settled (not in-flight) review.
    function statusButtonLabel(entry) {
      if (entry === undefined || entry === null) return '批注评审'
      const count = Array.isArray(entry.annotations) ? entry.annotations.length : 0
      if (isSoundEntry(entry)) return '✓ 无阻断 (' + count + ')'
      if (entry.status === 'cancelled') return '已取消 · 重新评审'
      if (entry.status === 'error') return /budget exceeded/i.test(String(entry.error || '')) ? '预算熔断 · 重试' : '评审失败 · 重试'
      if (entry.status === 'incomplete') return '◇ 部分核实 · ' + count + ' 条'
      if (entry.status === 'unverified') return '◇ 未核实 · ' + count + ' 条'
      if (entry.verdict === 'changes') return '⚠ 批注 ' + count + ' · 复审'
      // A 'sound' status that failed isSoundEntry (partial/not-verified coverage,
      // salvaged, unchecked>0) is NOT green — report it neutrally.
      return '批注 ' + count + ' · 复审'
    }

    // In-flight label. Phase 1=存疑分析, 2=核验, 3=抢救; explore detail shows
    // toolCalls/budget and suspects SEPARATELY (not toolCalls/suspects).
    function inFlightLabel(prog) {
      const p = prog && typeof prog === 'object' ? prog : undefined
      if (!p) return '评审中…'
      if (!p.explore) return '评审中…'
      const phase = p.phase
      const phaseLabel = phase === 1 ? '存疑分析' : phase === 2 ? '核验' : phase === 3 ? '抢救' : '评审中'
      const calls = typeof p.toolCalls === 'number' ? p.toolCalls : 0
      const budget = typeof p.budget === 'number' ? p.budget : 0
      let d = '排查 ' + calls + (budget ? '/' + budget : '')
      if (typeof p.suspects === 'number' && p.suspects > 0) d += ' · 疑点 ' + p.suspects
      const action = p.action
      if (action) {
        if (action.kind === 'tool') d += ' · ' + String(action.name || '') + (action.target ? ' ' + action.target : '')
        else if (action.last) d += ' · 分析 ' + String(action.last.name || '') + (action.last.target ? ' ' + action.last.target : '') + ' 结果'
        else d += ' · 分析取证结果'
      }
      return '评审中 · ' + phaseLabel + ' · ' + d + '…'
    }

    // Restore selection from a base of all indices minus sent, then apply WAL
    // accept/dismiss deltas. A filter-only record leaves the selection intact.
    function restoreSelection(annotationCount, sent, triageStates) {
      const sel = new Set()
      for (let i = 0; i < annotationCount; i += 1) if (!sent || !sent.has(i)) sel.add(i)
      if (triageStates && typeof triageStates === 'object') {
        for (const [idxText, state] of Object.entries(triageStates)) {
          const idx = Number(idxText)
          if (!Number.isInteger(idx) || idx < 0 || idx >= annotationCount) continue
          if (state === 'accept') sel.add(idx)
          else if (state === 'dismiss') sel.delete(idx)
        }
      }
      return sel
    }

    // Build the feedback payload for the given annotation indices.
    function buildFeedbackItems(annotations, indices) {
      return indices
        .filter((i) => annotations[i] !== undefined)
        .map((i) => {
          const a = annotations[i]
          const item = {
            index: i,
            severity: a.severity === 'blocker' ? 'blocker' : 'nit',
            title: String(a.title || ''),
            anchor: String(a.anchor || ''),
            comment: String(a.comment || ''),
          }
          if (typeof a.block === 'string') item.block = a.block
          if (typeof a.evidence === 'string' && a.evidence !== '') item.evidence = a.evidence
          return item
        })
    }

    // A list result is "loaded" only when it is a success-shaped envelope with
    // a reviews array. Malformed / error-shaped returns are NOT loaded — the
    // caller leaves the session dirty so mount/reconnect retries.
    function isListResultLoaded(res) {
      return !!res && res.ok !== false && Array.isArray(res.reviews)
    }

    // Cancel outcome normalization. A failed request stays retryable and must
    // NOT clear active state; an accepted request with cancelled:false means
    // nothing was in flight (already finished/never started) → force refresh.
    function cancelOutcome(res) {
      if (res && res.ok === true) {
        const cancelled = res.cancelled === true
        return { kind: 'accepted', cancelled, refresh: cancelled !== true }
      }
      return { kind: 'failed', error: String((res && res.error) || '取消失败') }
    }

    // The ordering key used to fence which entry "wins" for a message. Host
    // entries carry `createdAt`; client-transient entries (start failures) are
    // stamped with Date.now() too, so they compete by time. Missing/non-finite
    // timestamps sort as the OLDEST (-Infinity) so a real entry always beats
    // untimestamped legacy data.
    function entryTime(entry) {
      if (entry && typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)) {
        return entry.createdAt
      }
      return -Infinity
    }

    // Durability tier: a durable HOST result (has a reviewId) outranks a
    // client-side transient (transport error, `transient:true`) regardless of
    // wall clock. An unmarked legacy entry (no reviewId, no transient flag)
    // sits in between.
    function entryRank(entry) {
      if (entry && entry.transient === true) return 0
      if (entry && typeof entry.reviewId === 'string' && entry.reviewId !== '') return 2
      return 1
    }

    // Whether `incoming` should replace `existing` for the same message.
    // Durability wins first (a committed host result always beats a transient
    // error, even one stamped later by the client wall clock); within the same
    // tier newer timestamp wins. This prevents a lost-RPC transient at t=200
    // from sticking past a durable host result committed at t=100. It also
    // prevents a transient from ever overwriting an existing durable review.
    function shouldReplace(existing, incoming) {
      if (existing === undefined) return true
      const er = entryRank(existing)
      const ir = entryRank(incoming)
      if (ir !== er) return ir > er
      return entryTime(incoming) >= entryTime(existing)
    }

    // Project ONLY the leaf critic route strings into data-* attrs. Used for the
    // AB/harness correlation: a script can refuse to click a review that ran
    // under a different critic route. Never serializes the snapshot — reads two
    // leaf strings and omits anything non-string/empty so the script "fails
    // closed" (no route attrs) when the route is unknown.
    function criticRouteAttrs(snapshotValue) {
      const out = {}
      if (!snapshotValue || typeof snapshotValue !== 'object') return out
      const p = snapshotValue.criticProvider
      const m = snapshotValue.criticModel
      if (typeof p === 'string' && p !== '') out['data-ciel-critic-provider'] = p
      if (typeof m === 'string' && m !== '') out['data-ciel-critic-model'] = m
      return out
    }

    /** Review UI stylesheet (dynamic-plugin styles.insert has no bundle twin). */
    const REVIEW_CSS = [
      '.dsr-btn{font-size:11px;padding:1px 8px;border:1px solid currentColor;border-radius:4px;background:transparent;color:inherit;opacity:.65;cursor:pointer}',
      '.dsr-btn:hover{opacity:1}',
      '.dsr-btn:disabled{cursor:wait;opacity:.45}',
      '.dsr-tail{margin:8px 0 2px;border:1px solid rgba(130,130,130,.28);border-radius:8px;overflow:hidden;font-size:13px;line-height:1.55}',
      '.dsr-tail-head{padding:6px 10px;font-size:12px;opacity:.75;border-bottom:1px solid rgba(130,130,130,.2);display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.dsr-item{padding:8px 10px;border-top:1px solid rgba(130,130,130,.14)}',
      '.dsr-item:first-of-type{border-top:none}',
      '.dsr-sev{display:inline-block;font-size:10.5px;font-family:ui-monospace,monospace;padding:0 6px;border-radius:3px;margin-right:6px;vertical-align:1px}',
      '.dsr-sev-blocker{color:#f85149;border:1px solid #f85149}',
      '.dsr-sev-nit{color:#d29922;border:1px solid #d29922}',
      '.dsr-title{font-weight:600}',
      '.dsr-unanchored{font-size:10.5px;opacity:.6;margin-left:6px}',
      '.dsr-anchor{margin:5px 0 3px;padding:3px 8px;border-left:2px solid rgba(130,130,130,.5);font-family:ui-monospace,monospace;font-size:11.5px;opacity:.7;white-space:pre-wrap;word-break:break-word}',
      '.dsr-comment{opacity:.92;white-space:pre-wrap;word-break:break-word}',
      '.dsr-raw{padding:8px 10px;white-space:pre-wrap;word-break:break-word;opacity:.85;font-size:12.5px}',
      '.dsr-error{padding:8px 10px;color:#f85149;font-size:12.5px;white-space:pre-wrap;word-break:break-word}',
      '.dsr-mark{cursor:pointer;border-radius:2px}',
      '.dsr-mark-blocker{text-decoration:underline wavy #f85149 1.5px;text-underline-offset:3px;background:rgba(248,81,73,.07)}',
      '.dsr-mark-nit{text-decoration:underline wavy #d29922 1.5px;text-underline-offset:3px;background:rgba(210,153,34,.07)}',
      '.dsr-badge{display:inline-block;font-size:9.5px;font-family:ui-monospace,monospace;line-height:1.4;padding:0 3px;border-radius:3px;margin-left:2px;vertical-align:super;cursor:pointer;user-select:none}',
      '.dsr-badge-blocker{color:#f85149;border:1px solid #f85149}',
      '.dsr-badge-nit{color:#d29922;border:1px solid #d29922}',
      '.dsr-pop{position:fixed;z-index:99999;max-width:420px;border:1px solid rgba(130,130,130,.45);border-radius:8px;padding:10px 12px;font-size:13px;line-height:1.55;box-shadow:0 10px 32px rgba(0,0,0,.4);background:#1b2129;color:#e6e9ee}',
      '.dsr-pop-head{margin-bottom:5px}',
      '.dsr-pop-anchor{margin:6px 0 4px;padding:3px 8px;border-left:2px solid rgba(130,130,130,.5);font-family:ui-monospace,monospace;font-size:11.5px;opacity:.7;white-space:pre-wrap;word-break:break-word}',
      '.dsr-pop-comment{white-space:pre-wrap;word-break:break-word}',
      '.dsr-item{cursor:pointer;border-radius:4px}',
      '.dsr-item:hover{background:rgba(255,255,255,.045)}',
      '.dsr-flash{animation:dsrFlash 1.4s ease}',
      '@keyframes dsrFlash{0%{outline:2px solid #d29922;outline-offset:1px}100%{outline:2px solid transparent;outline-offset:5px}}',
      // ── 回传（annfbk 原型移植）：勾选框、发送按钮、状态注记、已回传置灰
      '.dsrf-box{margin-right:7px;vertical-align:1px;accent-color:#3fb950;cursor:pointer}',
      '.dsrf-send{margin-left:10px;padding:2px 10px;font-size:11.5px;border:1px solid #3fb950;border-radius:4px;background:transparent;color:#3fb950;cursor:pointer;font-family:inherit}',
      '.dsrf-send:disabled{opacity:.45;cursor:default}',
      '.dsrf-note{margin-left:8px;font-size:11px;opacity:.75}',
      '.dsr-item.dsrf-sent{opacity:.55}',
      '.dsr-item.dsrf-sent .dsrf-box{pointer-events:none}',
      // ── 0.12.0 ①裁决卡 + 块级 gutter（demo: prototypes/verdict-card-demo.html）
      '.dsr-tail.dsr-verdict{border-left:3px solid rgba(130,130,130,.4)}',
      '.dsr-tail.dsr-verdict-pass{border-left-color:#3fb950}',
      '.dsr-tail.dsr-verdict-changes{border-left-color:#d29922}',
      '.dsr-tail.dsr-verdict-neutral{border-left-color:#8b949e}',
      '.dsr-tail.dsr-rise{animation:dsrRise .3s ease}',
      '@keyframes dsrRise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
      '.dsr-vbadge{flex:none;font-size:13px;font-weight:700}',
      '.dsr-vbadge-pass{color:#3fb950}',
      '.dsr-vbadge-changes{color:#d29922}',
      '.dsr-vbadge-neutral{color:#8b949e}',
      '.dsr-vsum{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.75;font-size:12.5px}',
      '.dsr-vchips{display:inline-flex;gap:6px;flex:none}',
      '.dsr-vchip{font-size:10.5px;font-family:ui-monospace,monospace;font-weight:600;line-height:16px;padding:0 8px;border-radius:999px}',
      '.dsr-vchip-b{color:#f85149;background:rgba(248,81,73,.13)}',
      '.dsr-vchip-n{color:#d29922;background:rgba(210,153,34,.13)}',
      '.dsr-vchip-ok{color:#3fb950;background:rgba(63,185,80,.13)}',
      // 0.13.0 契约 v3：排查统计 chip（中性蓝灰，区别于批注计数的红黄）
      '.dsr-vchip-s{color:#79a7e8;background:rgba(88,166,255,.12);cursor:default}',
      // 抢救产出 chip（显式可见，非 tooltip 专属）
      '.dsr-vchip-warn{color:#d29922;background:rgba(210,153,34,.16);cursor:help}',
      // 停止控制（评审在途时的取消按钮）
      '.dsr-cancel{font-size:11px;padding:1px 8px;border:1px solid currentColor;border-radius:4px;background:transparent;color:#f85149;opacity:.8;cursor:pointer}',
      '.dsr-cancel:hover{opacity:1}',
      '.dsr-cancel:disabled{cursor:wait;opacity:.45}',
      '.dsr-cancel.dsr-cancel-failed{color:#d29922;border-style:dashed}',
      '.dsr-evidence{margin:4px 0 2px;padding:3px 8px;border-left:2px solid rgba(88,166,255,.5);font-size:11.5px;opacity:.85;white-space:pre-wrap;word-break:break-word}',
      '.dsr-downgraded{font-size:10px;font-family:ui-monospace,monospace;color:#79a7e8;border:1px solid rgba(88,166,255,.4);border-radius:4px;padding:0 5px;margin-left:6px;white-space:nowrap;cursor:help}',
      '.dsr-vcaret{flex:none;width:14px;opacity:.55;font-size:11px;transition:transform .18s}',
      '.dsr-tail.dsr-collapsed .dsr-vcaret{transform:rotate(-90deg)}',
      '.dsr-tail.dsr-collapsed .dsr-vbody{display:none}',
      '.dsr-blk{position:relative}',
      '.dsr-gutter{position:absolute;left:-24px;top:2px;display:flex;flex-direction:column;gap:4px;z-index:2}',
      // 代码块（pre 横向 overflow 会裁掉左外侧徽章）→ 收进右上内沿，横排。
      'pre.dsr-blk>span.dsr-gutter{left:auto;right:6px;top:6px;flex-direction:row}',
      '.dsr-gmark{width:17px;height:17px;border-radius:4px;font-size:10px;font-family:ui-monospace,monospace;line-height:15px;text-align:center;cursor:pointer;user-select:none;border:1px solid}',
      '.dsr-gmark-blocker{color:#f85149;border-color:#f85149;background:rgba(248,81,73,.12)}',
      '.dsr-gmark-nit{color:#d29922;border-color:#d29922;background:rgba(210,153,34,.10)}',
      '.dsr-blk-hl{outline:1px solid rgba(88,166,255,.45);outline-offset:2px;border-radius:4px;background:rgba(88,166,255,.06)}',
      '.dsr-blocktag{font-size:10px;font-family:ui-monospace,monospace;opacity:.5;margin-left:6px}',
      '.dsrf-filter{display:inline-flex;border:1px solid rgba(130,130,130,.35);border-radius:6px;overflow:hidden;margin-left:10px}',
      '.dsrf-filter button{appearance:none;background:none;border:none;color:inherit;opacity:.6;padding:2px 9px;font-size:11px;cursor:pointer;font-family:inherit}',
      '.dsrf-filter button.on{opacity:1;background:rgba(130,130,130,.18)}',
      '.dsrf-blockers{margin-left:6px;padding:2px 10px;font-size:11px;border:1px solid rgba(130,130,130,.4);border-radius:4px;background:transparent;color:inherit;opacity:.8;cursor:pointer;font-family:inherit}',
      '.dsrf-blockers:hover{opacity:1}',
    ].join('\n')

    // ═══════════════ M3-④ 顾问输出卡片（advcrd 原型 v2 移植） ═══════════════
    // ask_advisor 的 keyed tool view：结构化条目直读 tool/result.meta（② 的
    // presentationMeta 通道），tier 色左边条 + 实色胶囊徽章 + 字段标签 chip；
    // 未解析回退原文——任何状态都不比通用卡片差。边框/背景走主题 token 自适应
    // 亮暗，rgba 为兜底。
    const ADVISOR_CARD_CSS = [
      '.adv-card{margin:8px 0;border:1px solid var(--dsw-alias-border-l2, rgba(130,130,130,.22));border-radius:12px;overflow:hidden;font-size:13px;line-height:1.6;background:var(--dsw-alias-bg-layer-2, rgba(255,255,255,.018))}',
      '.adv-head{padding:9px 14px;display:flex;gap:10px;align-items:center;cursor:pointer;user-select:none;background:rgba(127.5,127.5,127.5,.06);border-bottom:1px solid var(--dsw-alias-border-l2, rgba(130,130,130,.16))}',
      '.adv-head:hover{background:rgba(127.5,127.5,127.5,.12)}',
      '.adv-caret{flex:none;width:14px;opacity:.55;font-size:11px}',
      '.adv-head-icon{flex:none;font-size:13px}',
      '.adv-head-title{font-weight:600;font-size:13px;white-space:nowrap;flex:none}',
      '.adv-chips{display:inline-flex;gap:6px;align-items:center;margin-left:2px;flex:none}',
      '.adv-chip{font-size:10.5px;font-family:ui-monospace,monospace;font-weight:600;line-height:16px;padding:0 8px;border-radius:999px}',
      '.adv-chip-high{color:#3fb950;background:rgba(63,185,80,.13)}',
      '.adv-chip-mid{color:#d29922;background:rgba(210,153,34,.13)}',
      '.adv-chip-low{color:#8b949e;background:rgba(139,148,158,.16)}',
      '.adv-head-note{margin-left:auto;font-size:11px;opacity:.5;font-family:ui-monospace,monospace;flex:none}',
      '.adv-head-q{margin-left:auto;font-size:12px;opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.adv-head-issues{font-size:11px;color:#d29922;font-family:ui-monospace,monospace;flex:none}',
      '.adv-body{padding:4px 14px 12px}',
      '.adv-q{margin:8px 0 4px;padding:6px 10px;border-left:2px solid rgba(130,130,130,.45);font-size:12px;opacity:.72;font-style:italic;white-space:pre-wrap;word-break:break-word}',
      '.adv-item{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-top:1px solid rgba(130,130,130,.14)}',
      '.adv-item:first-of-type{border-top:none}',
      '.adv-badge{flex:none;margin-top:2px;font-size:10px;font-family:ui-monospace,monospace;font-weight:700;line-height:15px;padding:0 6px;border-radius:4px;border:1px solid}',
      '.adv-badge-high{color:#3fb950;border-color:#3fb950}',
      '.adv-badge-mid{color:#d29922;border-color:#d29922}',
      '.adv-badge-low{color:#8b949e;border-color:#8b949e}',
      '.adv-item-content{flex:1;min-width:0}',
      '.adv-item-title{font-weight:600;font-size:13.5px;margin-bottom:6px}',
      '.adv-frow{display:flex;gap:8px;margin-bottom:5px;font-size:12.5px}',
      '.adv-frow:last-child{margin-bottom:0}',
      '.adv-flabel{flex:none;width:56px;font-size:11.5px;opacity:.6;padding-top:1px}',
      '.adv-fval{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word;opacity:.88}',
      '.adv-issues{margin-top:10px;padding:6px 10px;font-size:12px;color:#d29922;border:1px solid rgba(210,153,34,.35);border-radius:8px;background:rgba(210,153,34,.06)}',
      '.adv-raw{white-space:pre-wrap;word-break:break-word;opacity:.92;font-size:12.5px;padding-top:8px}',
      '.adv-err{color:#f85149;font-size:12.5px;white-space:pre-wrap;word-break:break-word;padding-top:8px}',
      '.adv-ctx{margin-top:10px;font-size:12px;opacity:.7}',
      '.adv-ctx summary{cursor:pointer;opacity:.8}',
      '.adv-ctx-body{margin-top:4px;white-space:pre-wrap;word-break:break-word;font-style:normal}',
    ].join('\n')

    /** One-line clip for the card head/question quote. */
    function clipAdv(text, max) {
      const oneLine = String(text).replace(/\s+/g, ' ').trim()
      return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '…'
    }
    /** Visible text of a settled tool result's content blocks. */
    function advBodyText(content) {
      if (!Array.isArray(content)) return ''
      return content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim()
    }
    /** ask_advisor argsRaw → { question, context } (tolerant). */
    function advArgs(raw) {
      if (typeof raw !== 'string' || raw === '') return {}
      try {
        const v = JSON.parse(raw)
        return v && typeof v === 'object' ? v : {}
      } catch { return {} }
    }

    const ADV_TIERS = ['high', 'mid', 'low']

    /** Tier-count chips for the card head: one pill per present tier. */
    function advTierChips(items) {
      const counts = { high: 0, mid: 0, low: 0 }
      for (const it of items) {
        if (Object.prototype.hasOwnProperty.call(counts, it.tier)) counts[it.tier] += 1
      }
      const chips = []
      for (const t of ADV_TIERS) {
        if (counts[t] > 0) chips.push(h('span', { key: t, className: 'adv-chip adv-chip-' + t }, counts[t] + ' ' + t))
      }
      return chips.length > 0 ? h('span', { className: 'adv-chips' }, chips) : null
    }

    /** One labeled field row inside an advisor item. */
    function AdvField({ label, value }) {
      if (!value) return null
      return h('div', { className: 'adv-frow' },
        h('span', { className: 'adv-flabel' }, label),
        h('span', { className: 'adv-fval' }, String(value)))
    }

    function AdvisorItem({ item }) {
      const tier = ADV_TIERS.includes(item.tier) ? item.tier : 'low'
      return h('div', { className: 'adv-item' },
        h('span', { className: 'adv-badge adv-badge-' + tier }, tier),
        h('div', { className: 'adv-item-content' },
          h('div', { className: 'adv-item-title' }, String(item.title || '（无标题）')),
          h(AdvField, { label: '思路', value: item.framing }),
          h(AdvField, { label: '陷阱', value: item.pitfalls }),
          h(AdvField, { label: '验证目标', value: item.verificationTarget })))
    }

    /** The ask_advisor keyed tool view (tool.call.toolview, key 'ask_advisor'). */
    function AdvisorToolView(props) {
      const block = props.block
      const settled = block !== null && typeof block === 'object' && 'kind' in block
      const argsRaw = settled
        ? (block.call && typeof block.call.argsRaw === 'string' ? block.call.argsRaw : '')
        : (block && typeof block.argsRaw === 'string' ? block.argsRaw : '')
      const args = advArgs(argsRaw)
      const question = typeof args.question === 'string' ? args.question : ''
      const context = typeof args.context === 'string' ? args.context : ''
      const meta = settled ? block.meta : undefined
      const items = meta !== null && typeof meta === 'object' && meta.v === 1 && Array.isArray(meta.items)
        ? meta.items.filter((it) => it && typeof it === 'object')
        : []
      const issues = meta !== null && typeof meta === 'object' && Array.isArray(meta.issues)
        ? meta.issues.map(String)
        : []
      const [open, setOpen] = useState(true)

      // In-flight: tool/call seen, result not yet.
      if (!settled) {
        return h('div', { className: 'adv-card' },
          h('div', { className: 'adv-head', style: { cursor: 'default' } },
            h('span', { className: 'adv-head-icon' }, '💡'),
            h('span', { className: 'adv-head-title', style: { opacity: .7 } }, '顾问咨询中…'),
            question !== '' ? h('span', { className: 'adv-head-note' }, clipAdv(question, 60)) : null))
      }

      const isError = block.isError === true
      const body = advBodyText(block.content)
      const chips = advTierChips(items)
      // 耗时：settled 节点同时带 callTime 与 time。
      const duration = typeof block.callTime === 'number' && typeof block.time === 'number' && block.time >= block.callTime
        ? Math.round((block.time - block.callTime) / 1000) + 's'
        : ''
      const headText = isError
        ? '顾问咨询失败'
        : items.length > 0
          ? '顾问建议 · ' + items.length + ' 条'
          : '顾问建议（未解析出结构化条目，原文如下）'

      return h('div', { className: 'adv-card' },
        h('div', {
          className: 'adv-head',
          onClick: () => setOpen(!open),
          'aria-expanded': open,
        },
          h('span', { className: 'adv-caret' }, open ? '▾' : '▸'),
          h('span', { className: 'adv-head-icon' }, '💡'),
          h('span', { className: 'adv-head-title', style: isError ? { color: '#f85149' } : undefined }, headText),
          chips,
          issues.length > 0 ? h('span', { className: 'adv-head-issues' }, '解析问题 ' + issues.length) : null,
          duration !== '' ? h('span', { className: 'adv-head-note', style: { marginLeft: 0 } }, duration) : null,
          question !== '' ? h('span', { className: 'adv-head-q' }, clipAdv(question, 80)) : null),
        open
          ? h('div', { className: 'adv-body' },
              question !== '' ? h('div', { className: 'adv-q' }, '咨询：' + clipAdv(question, 300)) : null,
              isError
                ? h('div', { className: 'adv-err' }, body !== '' ? body : '（无错误详情）')
                : items.length > 0
                  ? items.map((item, i) => h(AdvisorItem, { key: i, item }))
                  : h('div', { className: 'adv-raw' }, body !== '' ? body : '（空回复）'),
              issues.length > 0
                ? h('div', { className: 'adv-issues' }, '解析问题：' + issues.join('；'))
                : null,
              context !== ''
                ? h('details', { className: 'adv-ctx' },
                    h('summary', null, '已确立的事实与约束（咨询输入）'),
                    h('div', { className: 'adv-ctx-body' }, context))
                : null)
          : null)
    }

    // ── P3: /advise 命令卡片（advcmd 原型 pkg-16 移植）─────────────────────
    // host 侧 parseAdvisorItems 的客户端复刻（同一正则契约）——命令结果只有
    // text 通道（无工具的 output.schema/meta），结构化全靠 persona + 解析。
    function parseAdviseItems(text) {
      const heads = []
      const re = /^## \[(high|mid|low)\][ \t]*(.*)$/gm
      let m
      while ((m = re.exec(text)) !== null) {
        heads.push({ tier: m[1], title: (m[2] || '').trim(), at: m.index, end: re.lastIndex })
      }
      if (heads.length === 0) return { items: [], issues: [] }
      const issues = []
      if (heads.length > 6) issues.push('item count ' + heads.length + ' exceeds the 6-item cap')
      const FIELD_NAMES = ['framing', 'pitfalls', 'verification_target']
      const items = []
      for (let i = 0; i < heads.length; i += 1) {
        const body = text.slice(heads[i].end, i + 1 < heads.length ? heads[i + 1].at : text.length)
        const field = (name) => {
          const match = new RegExp(
            '(?:^|\\n)[ \\t]*' + name + '[ \\t]*:[ \\t]*([\\s\\S]*?)(?=\\n[ \\t]*(?:' + FIELD_NAMES.join('|') + ')[ \\t]*:|$)',
          ).exec(body)
          return match ? match[1].trim() : ''
        }
        const item = {
          tier: heads[i].tier,
          title: heads[i].title.slice(0, 120),
          framing: field('framing').slice(0, 1200),
          pitfalls: field('pitfalls').slice(0, 1200),
          verificationTarget: field('verification_target').slice(0, 600),
        }
        if (item.framing === '') issues.push('item ' + (i + 1) + ' ("' + item.title + '") lacks framing')
        if (item.verificationTarget === '') issues.push('item ' + (i + 1) + ' ("' + item.title + '") lacks verification_target')
        items.push(item)
      }
      return { items, issues }
    }

    // CommandNode 数据源：args=问题原文，outcome=null 在途，
    // outcome.kind/text 定成败。条目渲染复用 AdvisorItem（同一视觉语言）。
    function AdviseCommandView(props) {
      const node = props.node
      const question = node && typeof node.args === 'string' ? node.args.trim() : ''
      const outcome = node ? node.outcome : null
      const [open, setOpen] = useState(true)

      if (outcome === null || outcome === undefined) {
        return h('div', { className: 'adv-card' },
          h('div', { className: 'adv-head', style: { cursor: 'default' } },
            h('span', { className: 'adv-head-icon' }, '💡'),
            h('span', { className: 'adv-head-title', style: { opacity: .7 } }, '顾问咨询中…'),
            h('span', { className: 'adv-head-note' }, '/advise 人类触发'),
            question !== '' ? h('span', { className: 'adv-head-note', style: { marginLeft: 0 } }, clipAdv(question, 60)) : null))
      }

      const isError = outcome.kind === 'error'
      const body = typeof outcome.text === 'string' ? outcome.text : ''
      const parsed = isError ? { items: [], issues: [] } : parseAdviseItems(body)
      const items = parsed.items
      const issues = parsed.issues

      const chips = advTierChips(items)
      const headText = isError
        ? '顾问咨询失败'
        : items.length > 0
          ? '顾问建议 · ' + items.length + ' 条'
          : '顾问建议（未解析出结构化条目，原文如下）'

      return h('div', { className: 'adv-card' },
        h('div', {
          className: 'adv-head',
          onClick: () => setOpen(!open),
          'aria-expanded': open,
        },
          h('span', { className: 'adv-caret' }, open ? '▾' : '▸'),
          h('span', { className: 'adv-head-icon' }, '💡'),
          h('span', { className: 'adv-head-title', style: isError ? { color: '#f85149' } : undefined }, headText),
          chips,
          issues.length > 0 ? h('span', { className: 'adv-head-issues' }, '解析问题 ' + issues.length) : null,
          h('span', { className: 'adv-head-note' }, '/advise 人类触发'),
          question !== '' ? h('span', { className: 'adv-head-q', style: { marginLeft: 0 } }, clipAdv(question, 60)) : null),
        open
          ? h('div', { className: 'adv-body' },
              question !== '' ? h('div', { className: 'adv-q' }, '咨询：' + clipAdv(question, 300)) : null,
              isError
                ? h('div', { className: 'adv-err' }, body !== '' ? body : '（无错误详情）')
                : items.length > 0
                  ? items.map((item, i) => h(AdvisorItem, { key: i, item }))
                  : h('div', { className: 'adv-raw' }, body !== '' ? body : '（空回复）'),
              issues.length > 0
                ? h('div', { className: 'adv-issues' }, '解析问题：' + issues.join('；'))
                : null)
          : null)
    }

    function apply(ctx) {
      scope = ctx.settingsScope.bind({ namespace: 'ciel' })
      clientOn = (name, fn) => ctx.on(name, fn)
      getSessionRemote = () => {
        try {
          return ctx.get('remote.session')
        } catch {
          return undefined
        }
      }
      getRemote = () => {
        try {
          return ctx.get('remote')
        } catch {
          return undefined
        }
      }
      ctx.slots.inject('settings.plugin.item', () =>
        ctx.slots.register(
          { name: 'settings.plugin.item', key: 'ciel' },
          () => h(AdvisorCard),
        ),
      )

      // ═══════════════ P3: /advise 命令卡片（advcmd 原型移植） ═══════════════
      // conversation.chat.commandview 键控 'advise'（开放键域，纯增量），
      // 与 ask_advisor 工具卡片同一视觉语言：条目渲染直接复用 AdvisorItem，
      // CSS 复用 ADVISOR_CARD_CSS。数据源是 CommandNode：args=问题原文，
      // outcome=null 在途，outcome.kind/text 定成败；解析器是 host 侧
      // parseAdvisorItems 的客户端复刻（同一正则契约），失败一律回退原文。
      ctx.slots.inject('conversation.chat.commandview', () =>
        ctx.slots.register(
          { name: 'conversation.chat.commandview', key: 'advise' },
          (props) => h(AdviseCommandView, props),
        ),
      )

      // ═══════════════ M3-③ 批注评审 UI（annrev 原型移植） ═══════════════
      // Marks/badges/panel are driven by the per-message button's effect —
      // deliberately NOT the turnTail chain (winner-take-all, deliverables
      // wins file-producing turns). Anchors match by proximity: the last
      // occurrence before the message's own button. Cleanup is owned-spans
      // only, so one message never disturbs another's marks.

      const styleEl = document.createElement('style')
      styleEl.textContent = REVIEW_CSS + '\n' + ADVISOR_CARD_CSS
      document.head.appendChild(styleEl)
      ctx.effect(() => () => styleEl.remove(), 'dsh-advisor: review styles')

      // Mount the advisorReview Remote namespace; callers await readiness.
      let reviewApiResolve
      const reviewApiReady = new Promise((resolve) => { reviewApiResolve = resolve })
      const remoteService = ctx.get('remote')
      if (remoteService !== undefined && typeof remoteService.$mount === 'function') {
        ctx.effect(async () => {
          let dispose = null
          try {
            dispose = await remoteService.$mount(ADVISOR_REMOTE)
            reviewApiResolve(ctx.get('remote.advisorReview') ?? null)
          } catch (error) {
            // A failed $mount must still settle readiness — otherwise every
            // reviewCall hangs forever awaiting a promise that never resolves.
            console.error('dsh-advisor: review remote mount failed', error && error.message)
            reviewApiResolve(null)
          }
          return async () => { if (dispose) await dispose() }
        }, 'dsh-advisor: review remote mount')
      } else {
        reviewApiResolve(null)
      }

      async function reviewCall(method, request) {
        const api = await reviewApiReady
        if (!api || typeof api[method] !== 'function') return { ok: false, error: 'review remote unavailable' }
        let res
        try {
          res = await api[method](request)
        } catch (error) {
          return { ok: false, error: String(error && error.message || error) }
        }
        if (res && typeof res === 'object' && res.ok === true) return res.value
        if (res && typeof res === 'object' && res.ok === false) {
          return { ok: false, error: String((res.error && (res.error.message || res.error.code)) || 'remote failure') }
        }
        return res
      }

      const listeners = new Set()
      const store = {
        byMessage: new Map(),
        hydrated: new Set(),
        retrySessions: new Set(), // 加载失败的 session——重连后重试
        popover: null,
        // 回传状态，全部按 reviewId 归键——面板是 imperative DOM，React 重建
        // 后由 buildPanel 从这里重读，勾选/已回传/注记随重绘保留。
        feedback: {
          sel: new Map(),      // reviewId -> Set<annotation index>
          sent: new Map(),     // reviewId -> Set<index>（hydrate 自 sentKeys，发送后更新）
          note: new Map(),     // reviewId -> 面板头注记文本
          sending: new Set(),  // 有在途回传的 reviewId
          tick: new Map(),     // messageId -> 重绘计数器（回传 settle 后 bump）
          filter: new Map(),   // reviewId -> 'all' | 'blocker'（分诊过滤）
          meta: new Map(),     // reviewId -> { triageStates, filter }（WAL 规范化元数据）
          touched: new Set(),  // 本次页面生命周期内被本地编辑过的 reviewId（防旧水合覆盖）
          triageChain: new Map(), // reviewId -> Promise，串行化分诊写入，避免竞态
        },
      }
      const emit = () => { for (const l of Array.from(listeners)) l() }
      function useStoreTick() {
        const [, set] = useState(0)
        useEffect(() => {
          const tick = () => set((v) => v + 1)
          listeners.add(tick)
          return () => { listeners.delete(tick) }
        }, [])
      }
      function absorb(entry) {
        if (!entry || typeof entry.messageId !== 'string') return
        // Fence by createdAt/review generation: never let an older list entry or
        // an untimestamped legacy record clobber a newer start result.
        if (shouldReplace(store.byMessage.get(entry.messageId), entry)) {
          store.byMessage.set(entry.messageId, entry)
        }
      }
      // Hydration is deduplicated (a concurrent non-force call joins the
      // in-flight one) and retryable: an error-shaped list result does NOT mark
      // the session loaded, so a mount/reconnect re-runs it. `force` bypasses
      // the loaded set for inFlight->false refreshes, and — importantly — when a
      // load is already running a forced call does NOT settle from that stale
      // query: it chains a FRESH load after it so the terminal result is seen.
      const hydratePromises = new Map()
      async function hydrate(sessionId, { force = false } = {}) {
        if (typeof sessionId !== 'string') return
        if (!force && store.hydrated.has(sessionId)) return
        const prev = hydratePromises.get(sessionId)
        if (prev && !force) return prev
        const p = (async () => {
          if (prev) await prev // forced: wait out the stale query, then reload fresh
          let res
          try {
            res = await reviewCall('list', { sessionId })
          } catch (error) {
            store.hydrated.delete(sessionId)
            store.retrySessions.add(sessionId)
            console.error('review.list threw', error && error.message)
            return
          }
          // Malformed / error-shaped return is NOT success — leave the session
          // un-loaded so the next mount/reconnect retries.
          if (!isListResultLoaded(res)) {
            store.hydrated.delete(sessionId)
            store.retrySessions.add(sessionId)
            console.error('review.list error-shaped', res && res.error)
            return
          }
          for (const r of res.reviews) absorb(r)
          // 已回传去重键（reviewId#index）→ 置灰对应条目，刷新后不依赖服务端重放拒绝。
          const sentKeys = res.sentKeys && Array.isArray(res.sentKeys) ? res.sentKeys : []
          for (const key of sentKeys) {
            if (typeof key !== 'string') continue
            const at = key.lastIndexOf('#')
            if (at <= 0) continue
            const rid = key.slice(0, at)
            const idx = Number(key.slice(at + 1))
            if (!Number.isInteger(idx)) continue
            if (!store.feedback.sent.has(rid)) store.feedback.sent.set(rid, new Set())
            store.feedback.sent.get(rid).add(idx)
          }
          // 0.12.0 ④分诊水合：WAL 里的采纳/忽略与过滤器恢复进 store（规范化
          // 为 meta，供 buildPanel 首建选择时应用）；仅对未被本地编辑过的
          // review 应用，防止旧水合覆盖新分诊。
          const triage = res.triage && typeof res.triage === 'object' ? res.triage : {}
          for (const [rid, t] of Object.entries(triage)) {
            if (!t || typeof t !== 'object') continue
            if (store.feedback.touched.has(rid)) continue
            const states = t.states && typeof t.states === 'object' ? t.states : {}
            store.feedback.meta.set(rid, {
              triageStates: states,
              filter: t.filter === 'all' || t.filter === 'blocker' ? t.filter : undefined,
            })
            if (t.filter === 'all' || t.filter === 'blocker') store.feedback.filter.set(rid, t.filter)
          }
          store.hydrated.add(sessionId)
          store.retrySessions.delete(sessionId)
          emit()
        })().finally(() => { if (hydratePromises.get(sessionId) === p) hydratePromises.delete(sessionId) })
        hydratePromises.set(sessionId, p)
        return p
      }
      // Reconnect reconcile: retry sessions that failed to load AND force a
      // fresh load of already-hydrated sessions — a disconnected start can
      // finish offscreen, so reconnecting must re-fetch to surface the terminal
      // entry. Touched-guard + createdAt fence make the refresh non-clobbering.
      if (typeof clientOn === 'function') {
        ctx.effect(() => {
          const dispose = clientOn('connection/reset', () => {
            const sessions = new Set([...store.hydrated, ...store.retrySessions])
            for (const sessionId of sessions) void hydrate(sessionId, { force: true })
          })
          return () => { dispose() }
        }, 'dsh-advisor: review reconnect retry')
      }

      // ── anchor normalization: anchors quote MARKDOWN SOURCE (with **, `, []()
      // etc.) while the DOM holds RENDERED text — strip markdown syntax from the
      // anchor, collapse whitespace on both sides, then substring-match.
      function normalizeAnchor(anchor) {
        return String(anchor)
          .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/[*`_~#>]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
      }

      // ── text-node collection excluding our own chrome: the card panel quotes
      // the anchors and would self-match (reject .dsr-tail explicitly); the
      // popover lives outside the turn anyway.
      function inOurChrome(n) {
        const el = n.parentElement
        return el !== null && typeof el.closest === 'function' && el.closest('.dsr-tail') !== null
      }
      function collectTextNodes(container, excludeEl) {
        const doc = container.ownerDocument
        const walker = doc.createTreeWalker(container, 4, {
          acceptNode: (n) => (excludeEl.contains(n) || inOurChrome(n) ? 2 : n.nodeValue.trim() === '' ? 3 : 1),
        })
        const nodes = []
        let cur = walker.nextNode()
        while (cur) { nodes.push(cur); cur = walker.nextNode() }
        return nodes
      }
      function textOf(container, excludeEl) {
        return collectTextNodes(container, excludeEl).map((n) => n.nodeValue).join(' ')
      }

      // ── smallest ancestor of the button whose text holds at least one probe:
      // the text universe for matching. In the real chat DOM this settles on the
      // shared flow column (flow items have no per-turn wrapper) — which is SAFE
      // here, because matching is proximity-disambiguated and cleanup is by
      // owned spans, so a big universe cannot leak across turns.
      function findChatRoot(anchorEl, annotations) {
        const probes = (annotations || [])
          .filter((a) => a && typeof a.anchor === 'string')
          .map((a) => normalizeAnchor(a.anchor))
          .filter((s) => s.length >= 4)
          .map((s) => s.slice(0, 40))
        let node = anchorEl.parentElement
        // 渐进挂载兜底：长消息分多个 mutation 周期上树，probe 可能暂时落空。
        // 记住沿途第一个「够大」的祖先——被评审文本总在按钮自己的 flow item
        // 里，而匹配本来就是 proximity 消歧，落到这里不跨消息串味。
        let firstBig = null
        for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) {
          if (node === (anchorEl.ownerDocument && anchorEl.ownerDocument.body)) break
          const hay = textOf(node, anchorEl).replace(/\s+/g, ' ')
          if (firstBig === null && hay.length > 200) firstBig = node
          if (probes.length === 0 ? hay.length > 200 : probes.some((p) => hay.includes(p))) return node
        }
        return firstBig
      }

      // ── undo exactly what one effect created: mark spans unwrap back to
      // their text; badge spans are chrome, not content — remove them outright.
      // Spans already gone (React re-rendered the body) are skipped.
      function clearOwned(created) {
        for (const item of created) {
          const span = item.el
          if (item.kind === 'gutter') {
            if (span.isConnected && span.parentNode) span.parentNode.removeChild(span)
            if (item.host && item.host.classList) item.host.classList.remove('dsr-blk', 'dsr-blk-hl')
            continue
          }
          if (!span.isConnected || !span.parentNode) continue
          const parent = span.parentNode
          if (item.kind === 'badge') {
            parent.removeChild(span)
          } else {
            parent.replaceChild(span.ownerDocument.createTextNode(span.textContent), span)
          }
          parent.normalize()
        }
      }

      // ── 0.12.0 ①块级解析：entry.blocks（host 落库的 id+type 序号空间）对到
      // 渲染 DOM 的顶层块元素。规则与切分器同纪律——宁简勿繁 + 失败退回
      // proximity：候选 = root 内按文档序、位于按钮之前的块元素（P/H1-6/PRE/
      // UL/OL/TABLE/BLOCKQUOTE/HR，未分类的薄壳 div 下降一层），取末尾
      // blocks.length 个按序号 zip；类型不符即放弃该块映射。
      function classifyBlockEl(el) {
        const tag = el.tagName
        if (/^H[1-6]$/.test(tag)) return 'heading'
        if (tag === 'PRE') return 'code'
        if (tag === 'UL' || tag === 'OL') return 'list'
        if (tag === 'TABLE') return 'table'
        if (tag === 'BLOCKQUOTE') return 'quote'
        if (tag === 'HR') return 'hr'
        if (tag === 'P') return 'paragraph'
        return null
      }
      function resolveBlockDoms(root, beforeEl, blocks) {
        const map = new Map()
        if (!root || !Array.isArray(blocks) || blocks.length === 0) return map
        const candidates = []
        const precedes = (el) => {
          if (!beforeEl || el === beforeEl || beforeEl.contains(el)) return false
          const pos = el.compareDocumentPosition(beforeEl)
          return (pos & 4) !== 0 // beforeEl follows el
        }
        // 有界 DFS：文档序收集按钮之前的块元素。命中的元素不再下降（块内嵌套
        // 如 blockquote>p 只记外层）；评审自身的 chrome 与按钮操作区跳过。
        const visit = (el) => {
          if (el.classList && (el.classList.contains('dsr-tail') || el.classList.contains('dsr-pop') || el.classList.contains('dsr-gutter'))) return
          if (beforeEl && el !== beforeEl && beforeEl.contains(el)) return
          const type = classifyBlockEl(el)
          if (type !== null) {
            if (precedes(el)) candidates.push({ el, type })
            return
          }
          for (const child of el.children) visit(child)
        }
        visit(root)
        if (candidates.length === 0) return map
        // 类型序列对齐 + 前缀位置对齐的混合：正文之后的交付物/折叠段会让
        // 候选比块少（渲染器把富代码卡渲成自定义组件而非 pre，折叠段整块
        // 不上树），盲目取末尾 N 个或要求全长相等都会清零。做法：对每个偏移
        // 按「类型一致数 / 重叠长度」打分取最优；匹配率 ≥60% 时按位置映射
        // 全部重叠块（吸收组件分类噪音），否则只映射类型一致的位置——对不
        // 上的块保持未映射，消费方退回 proximity。
        const overlap = (o) => Math.min(candidates.length - o, blocks.length)
        let bestOffset = -1
        let bestRatio = 0
        for (let o = 0; o < candidates.length; o += 1) {
          const n = overlap(o)
          if (n <= 0) break
          let score = 0
          for (let i = 0; i < n; i += 1) {
            if (candidates[o + i].type === blocks[i].type) score += 1
          }
          const ratio = score / n
          if (ratio > bestRatio) { bestRatio = ratio; bestOffset = o }
          if (ratio === 1) break
        }
        if (bestOffset < 0) return map
        const n = overlap(bestOffset)
        const positional = bestRatio >= 0.6
        for (let i = 0; i < n; i += 1) {
          if (positional || candidates[bestOffset + i].type === blocks[i].type) {
            map.set(blocks[i].id, candidates[bestOffset + i].el)
          }
        }
        return map
      }

      // ── locate one normalized anchor in the concatenated text (whitespace
      // collapsed) and map it back to raw node/offset boundaries. Duplicate
      // phrases are disambiguated by PROXIMITY: the last occurrence whose start
      // node precedes `beforeEl` (the message's own button) wins — the reviewed
      // text always sits right above its own action row, while duplicates in
      // older turns are further up. Falls back to the first occurrence.
      function locateRange(nodes, needle, beforeEl) {
        let collapsed = ''
        const map = []
        let prevSpace = true
        for (let ni = 0; ni < nodes.length; ni += 1) {
          const v = nodes[ni].nodeValue
          for (let i = 0; i < v.length; i += 1) {
            const isSpace = /\s/.test(v[i])
            if (isSpace) {
              if (!prevSpace) { collapsed += ' '; map.push([ni, i]); prevSpace = true }
            } else { collapsed += v[i]; map.push([ni, i]); prevSpace = false }
          }
        }
        const before = (node) => {
          if (!beforeEl || node === beforeEl || beforeEl.contains(node)) return true
          const pos = node.compareDocumentPosition(beforeEl)
          return (pos & 4) !== 0 // DOCUMENT_POSITION_FOLLOWING: beforeEl follows node
        }
        let chosen = null
        let first = null
        let at = collapsed.indexOf(needle)
        while (at >= 0) {
          const start = map[at]
          const end = map[at + needle.length - 1]
          if (start && end) {
            const range = { startNode: nodes[start[0]], startOffset: start[1], endNode: nodes[end[0]], endOffset: end[1] + 1 }
            if (!first) first = range
            if (before(range.startNode)) chosen = range
          }
          at = collapsed.indexOf(needle, at + 1)
        }
        return chosen || first
      }

      // ── index-based portion splitting: the anchor occupies exactly
      // [startOffset, endOffset) of the raw text; split so it becomes whole text
      // node(s), then wrap them. The DFS is bounded by `root` so a bug can never
      // escape the chat root. Every created span is recorded in `created` for
      // owned cleanup.
      function wrapRange(doc, root, range, spanClass, badge, onActivate, created, index) {
        let first
        let last
        if (range.startNode === range.endNode) {
          const mid = range.startNode.splitText(range.startOffset)
          mid.splitText(range.endOffset - range.startOffset)
          first = mid
          last = mid
        } else {
          range.endNode.splitText(range.endOffset)
          first = range.startNode.splitText(range.startOffset)
          last = range.endNode
        }
        const nodes = []
        let cur = first
        while (cur) {
          if (cur.nodeType === 3) nodes.push(cur)
          if (cur === last) break
          let next = cur.firstChild || cur.nextSibling
          let climb = cur
          while (!next && climb !== root && climb.parentNode) { climb = climb.parentNode; next = climb.nextSibling }
          cur = next
        }
        let lastSpan = null
        for (const node of nodes) {
          if (node.nodeValue.trim() === '') continue
          const span = doc.createElement('span')
          span.className = spanClass
          span.addEventListener('click', onActivate)
          node.parentNode.replaceChild(span, node)
          span.appendChild(node)
          created.push({ kind: 'mark', el: span, index })
          if (node === last) lastSpan = span
        }
        if (lastSpan && lastSpan.parentNode) {
          lastSpan.parentNode.insertBefore(badge, lastSpan.nextSibling)
        } else if (last.parentNode) {
          last.parentNode.insertBefore(badge, last.nextSibling)
        }
        created.push({ kind: 'badge', el: badge, index })
      }

      // ── mark every annotation with per-item try/catch and return visible
      // stats plus the owned span list for cleanup.
      function markTurn(anchorEl, entry) {
        const annotations = Array.isArray(entry.annotations) ? entry.annotations : []
        const stats = { marked: 0, total: 0, failures: [] }
        const created = []
        const root = findChatRoot(anchorEl, annotations)
        if (!root) {
          stats.failures.push('chat root not found')
          console.error('advisor-review: chat root not found')
          return { root: null, stats, created, byIndex: new Map() }
        }
        const doc = root.ownerDocument
        // 0.12.0 ①：有块地图时先解析块级 DOM；块命中的批注挂 gutter 徽章
        // （零文本侵入），未命中的退回旧 proximity 划线（旧记录/解析失败）。
        const blockDoms = resolveBlockDoms(root, anchorEl, entry.blocks)
        const gutterByBlock = new Map() // blockEl -> gutter el（多块共用去重）
        annotations.forEach((a, i) => {
          if (!a || typeof a.anchor !== 'string') return
          const sev = a.severity === 'blocker' ? 'blocker' : 'nit'
          const open = (event) => {
            event.stopPropagation()
            const rect = event.currentTarget.getBoundingClientRect()
            const docEl = doc.documentElement
            const maxX = Math.max(12, (docEl ? docEl.clientWidth : 800) - 440)
            store.popover = {
              annotation: a,
              index: i + 1,
              x: Math.min(Math.max(12, rect.left), maxX),
              y: rect.bottom + 6,
            }
            emit()
          }
          const mapped = typeof a.block === 'string' ? blockDoms.get(a.block) : undefined
          // 证据护栏：位置映射只是猜测，锚引文才是证据。块元素文本不含锚引文
          // 时（渲染器折叠/改写了块，如富代码卡）退回 proximity 找精确位置，
          // 绝把徽章挂到错块上。
          const blockEl = (() => {
            if (mapped === undefined) return undefined
            const probe = normalizeAnchor(a.anchor)
            if (probe.length < 4) return mapped
            const hay = textOf(mapped, anchorEl).replace(/\s+/g, ' ')
            return hay.includes(probe) ? mapped : undefined
          })()
          if (blockEl !== undefined) {
            stats.total += 1
            try {
              blockEl.classList.add('dsr-blk')
              let gutter = gutterByBlock.get(blockEl)
              if (gutter === undefined) {
                gutter = doc.createElement('span')
                gutter.className = 'dsr-gutter'
                blockEl.insertBefore(gutter, blockEl.firstChild)
                gutterByBlock.set(blockEl, gutter)
                created.push({ kind: 'gutter', el: gutter, host: blockEl })
              }
              const mark = doc.createElement('span')
              mark.className = 'dsr-gmark dsr-gmark-' + sev
              mark.textContent = String(i + 1)
              mark.title = (a.severity === 'blocker' ? 'blocker' : 'nit') + ' · ' + (a.title || '')
              mark.addEventListener('click', open)
              gutter.appendChild(mark)
              created.push({ kind: 'badge', el: mark, index: i })
              stats.marked += 1
            } catch (error) {
              stats.failures.push('#' + (i + 1) + ' ' + String(error && error.message || error))
            }
            return
          }
          const needle = normalizeAnchor(a.anchor)
          if (needle.length < 4) return
          stats.total += 1
          try {
            const range = locateRange(collectTextNodes(root, anchorEl), needle, anchorEl)
            if (!range) {
              stats.failures.push('#' + (i + 1) + ' anchor not found in DOM text')
              return
            }
            const badge = doc.createElement('span')
            badge.className = 'dsr-badge dsr-badge-' + sev
            badge.textContent = String(i + 1)
            badge.title = (a.severity === 'blocker' ? 'blocker' : 'nit') + ' · ' + (a.title || '')
            badge.addEventListener('click', open)
            wrapRange(doc, root, range, 'dsr-mark dsr-mark-' + sev, badge, open, created, i)
            stats.marked += 1
          } catch (error) {
            stats.failures.push('#' + (i + 1) + ' ' + String(error && error.message || error))
          }
        })
        if (stats.failures.length > 0) console.error('advisor-review mark failures:', stats.failures.join(' | '))
        // Spans grouped by annotation index: panel cards click-locate through this.
        const byIndex = new Map()
        for (const item of created) {
          if (item.index === undefined) continue
          if (!byIndex.has(item.index)) byIndex.set(item.index, [])
          byIndex.get(item.index).push(item.el)
        }
        return { root, stats, created, byIndex }
      }

      // ── the annotation card panel, built as plain DOM and inserted right
      // before the message's own tail flow item.
      function appendSevBadge(doc, parent, sev) {
        const s = doc.createElement('span')
        s.className = 'dsr-sev dsr-sev-' + sev
        s.textContent = sev
        parent.appendChild(s)
      }
      function appendIndexBadge(doc, parent, sev, n) {
        const b = doc.createElement('span')
        b.className = 'dsr-badge dsr-badge-' + sev
        b.setAttribute('style', 'vertical-align:1px;margin-right:4px')
        b.textContent = String(n)
        parent.appendChild(b)
      }
      function buildPanel(doc, entry, locate, fb) {
        const panel = doc.createElement('div')
        panel.className = 'dsr-tail'
        if (entry.status === 'error') {
          const e = doc.createElement('div')
          e.className = 'dsr-error'
          e.textContent = '批注评审失败：' + String(entry.error || 'unknown')
          panel.appendChild(e)
          return panel
        }
        const annotations = Array.isArray(entry.annotations) ? entry.annotations : []
        const stats = entry.markStats
        // 0.9.3：清单可见性——评审输入是否携带顾问验证目标（③深化），面板头明示；
        // 旧 entry 无 targetsProvided 字段时什么都不显示（后向兼容）。
        const targetsNote = typeof entry.targetsProvided === 'number' && entry.targetsProvided > 0
          ? ' · 含顾问验证清单 ' + entry.targetsProvided + ' 条'
          : ''
        // 0.12.0 ①：v2 评审（带 verdict）渲染裁决卡头——verdict 徽标 + 总评 +
        // 统计 chips + 可折叠；旧 entry 保持纯文本头。绿色「整体成立」仅当
        // isSoundEntry（verdict pass 且核实完整、无抢救/未查）才出现。
        const panelVerdict = isSoundEntry(entry) ? 'pass' : entry.verdict === 'changes' ? 'changes' : 'neutral'
        const isV2 = typeof entry.verdict === 'string'
        if (isV2) panel.classList.add('dsr-verdict', 'dsr-verdict-' + panelVerdict, 'dsr-rise')
        const head = doc.createElement('div')
        head.className = 'dsr-tail-head'
        if (isV2) {
          head.style.cursor = 'pointer'
          head.title = '点击折叠/展开批注列表'
          const caret = doc.createElement('span')
          caret.className = 'dsr-vcaret'
          caret.textContent = '▾'
          head.appendChild(caret)
          const badge = doc.createElement('span')
          badge.className = 'dsr-vbadge ' + verdictBadgeClass(entry)
          badge.textContent = verdictBadgeText(entry)
          head.appendChild(badge)
          const sum = doc.createElement('span')
          sum.className = 'dsr-vsum'
          sum.textContent = entry.summary || '批评者批注 · ' + annotations.length + ' 条'
          head.appendChild(sum)
          const blockers = annotations.filter((a) => a && a.severity === 'blocker').length
          const nits = annotations.length - blockers
          const chips = doc.createElement('span')
          chips.className = 'dsr-vchips'
          if (blockers > 0) {
            const c = doc.createElement('span')
            c.className = 'dsr-vchip dsr-vchip-b'
            c.textContent = blockers + ' blocker'
            chips.appendChild(c)
          }
          if (nits > 0) {
            const c = doc.createElement('span')
            c.className = 'dsr-vchip dsr-vchip-n'
            c.textContent = nits + ' nit'
            chips.appendChild(c)
          }
          if (blockers === 0 && nits === 0) {
            const c = doc.createElement('span')
            c.className = 'dsr-vchip dsr-vchip-ok'
            c.textContent = '0 批注'
            chips.appendChild(c)
          }
          // Suspect outcomes and tool-call reservations are different units.
          // New records are host-counted; legacy records retain their origin.
          if (entry.stats && typeof entry.stats.checked === 'number') {
            const c = doc.createElement('span')
            c.className = 'dsr-vchip dsr-vchip-s'
            c.textContent = '疑点 ' + entry.stats.checked + ' · 证伪 ' + entry.stats.confirmed + ' · 排除 ' + entry.stats.excluded
              + (typeof entry.stats.unchecked === 'number' && entry.stats.unchecked > 0 ? ' · 未查 ' + entry.stats.unchecked : '')
            if (entry.explore) c.title = '工具调用 ' + entry.explore.toolCalls + '/' + entry.explore.budget + (entry.outcomes ? '（执行前计数，包含已放行但失败的调用）' : '（旧版事件流采样）') + (entry.explore.salvaged ? '；本卡由熔断后的部分记录恢复' : '')
            chips.appendChild(c)
          } else if (entry.explore) {
            const c = doc.createElement('span')
            c.className = 'dsr-vchip dsr-vchip-s'
            c.textContent = '探索调用 ' + entry.explore.toolCalls + '/' + entry.explore.budget
            chips.appendChild(c)
          }
          head.appendChild(chips)
          if (targetsNote !== '') {
            const tn = doc.createElement('span')
            tn.className = 'dsrf-note'
            tn.textContent = targetsNote
            head.appendChild(tn)
          }
          head.addEventListener('click', () => panel.classList.toggle('dsr-collapsed'))
        } else {
          head.textContent = (isSoundEntry(entry)
            ? '✓ 批评者：草案整体成立'
            : '批评者批注 · ' + annotations.length + ' 条'
              + (stats ? ' · 标记 ' + stats.marked + '/' + stats.total : '')
              + '（点击卡片定位到原文；波浪下划线与角标也可点击）'
              + (entry.status === 'completed-unparsed' ? '（未解析出结构化批注，原文如下）' : '')
              + (stats && stats.failures.length > 0 ? '　标记失败：' + stats.failures.join('；') : ''))
            + targetsNote
        }
        // 抢救产出作为显式可见标签（不只 tooltip）：熔断抢救的卡片一眼可辨。
        if (entry.explore && entry.explore.salvaged) {
          const sg = doc.createElement('span')
          sg.className = 'dsr-vchip dsr-vchip-warn'
          sg.textContent = '抢救产出'
          sg.title = '本卡由熔断后的抢救书写员产出（阶段 2 中断后单次裁决恢复）'
          head.appendChild(sg)
        }
        // ── 回传选中：勾选态/已回传态都在 store.feedback（随重绘重读），
        // reviewId 直接取自 entry——原型里的 title 匹配猜测链已删除。
        if (fb && annotations.length > 0) {
          const sendBtn = doc.createElement('button')
          sendBtn.className = 'dsrf-send'
          sendBtn.title = '把勾选的批注回传给主模型修复（author-owns-the-remedy）'
          const syncLabel = () => {
            sendBtn.textContent = fb.sending ? '回传中…' : (fb.sel.size > 0 ? '回传 ' + fb.sel.size + ' 条批注' : '回传选中')
          }
          syncLabel()
          sendBtn.disabled = fb.sending
          sendBtn.addEventListener('click', (event) => { event.stopPropagation(); fb.onSend() })
          head.appendChild(sendBtn)
          if (fb.note !== '') {
            const note = doc.createElement('span')
            note.className = 'dsrf-note'
            note.textContent = fb.note
            head.appendChild(note)
          }
          fb._syncLabel = syncLabel
        }
        panel.appendChild(head)
        if (typeof entry.coverageNote === 'string' && entry.coverageNote !== '') {
          const note = doc.createElement('div')
          note.className = 'dsrf-note'
          note.textContent = entry.coverageNote
          panel.appendChild(note)
        }
        const vbody = doc.createElement('div')
        vbody.className = 'dsr-vbody'
        annotations.forEach((a, i) => {
          if (fb && fb.filter === 'blocker' && a.severity !== 'blocker') return
          const sev = a.severity === 'blocker' ? 'blocker' : 'nit'
          const item = doc.createElement('div')
          item.className = 'dsr-item'
          item.title = '点击定位到原文对应位置'
          if (typeof locate === 'function') {
            item.addEventListener('click', () => locate(i))
          }
          const row = doc.createElement('div')
          if (fb) {
            const isSent = fb.sent.has(i)
            const cb = doc.createElement('input')
            cb.type = 'checkbox'
            cb.className = 'dsrf-box'
            cb.checked = !isSent && fb.sel.has(i)
            cb.disabled = fb.sending || isSent
            cb.title = isSent ? '已回传过' : '取消勾选=剔除误报，不回传给主模型'
            cb.addEventListener('click', (event) => event.stopPropagation())
            cb.addEventListener('change', () => {
              fb.onToggle(i, cb.checked)
              if (typeof fb._syncLabel === 'function') fb._syncLabel()
            })
            row.appendChild(cb)
            if (isSent) item.classList.add('dsrf-sent')
          }
          appendSevBadge(doc, row, sev)
          appendIndexBadge(doc, row, sev, i + 1)
          const title = doc.createElement('span')
          title.className = 'dsr-title'
          title.textContent = a.title || '（无标题）'
          row.appendChild(title)
          if (typeof a.block === 'string') {
            const bt = doc.createElement('span')
            bt.className = 'dsr-blocktag'
            bt.textContent = '⌖ ' + a.block
            row.appendChild(bt)
          }
          // 0.13.0 契约 v3：探索模式下无证据 blocker 被降为 nit，标记原因。
          if (a.downgraded === 'evidence-missing') {
            const dg = doc.createElement('span')
            dg.className = 'dsr-downgraded'
            dg.textContent = '缺证据·降级'
            dg.title = '探索契约要求 blocker 引用本轮只读工具所得证据；该批注未通过核验，已降为 nit'
            row.appendChild(dg)
          }
          if (!a.matched && typeof a.block !== 'string') {
            const un = doc.createElement('span')
            un.className = 'dsr-unanchored'
            un.textContent = '未锚定'
            row.appendChild(un)
          }
          item.appendChild(row)
          if (a.anchor) {
            const an = doc.createElement('div')
            an.className = 'dsr-anchor'
            an.textContent = a.anchor.length > 220 ? a.anchor.slice(0, 219) + '…' : a.anchor
            item.appendChild(an)
          }
          // 0.13.0 契约 v3：探索取证的证据行（批评者只读核实所得）。
          if (typeof a.evidence === 'string' && a.evidence !== '') {
            const ev = doc.createElement('div')
            ev.className = 'dsr-evidence'
            ev.textContent = '证据：' + (a.evidence.length > 260 ? a.evidence.slice(0, 259) + '…' : a.evidence)
            item.appendChild(ev)
          }
          const cm = doc.createElement('div')
          cm.className = 'dsr-comment'
          cm.textContent = a.comment || ''
          item.appendChild(cm)
          vbody.appendChild(item)
        })
        if (typeof entry.raw === 'string' && entry.raw !== '') {
          const raw = doc.createElement('div')
          raw.className = 'dsr-raw'
          raw.textContent = entry.raw
          vbody.appendChild(raw)
        }
        // 分诊脚行（v2 + 有批注）：过滤 + 「仅回传 blocker」快捷键。
        if (isV2 && fb && annotations.length > 0) {
          const foot = doc.createElement('div')
          foot.className = 'dsr-tail-head'
          foot.style.borderBottom = 'none'
          foot.style.borderTop = '1px solid rgba(130,130,130,.2)'
          const filter = doc.createElement('span')
          filter.className = 'dsrf-filter'
          for (const [f, label] of [['all', '全部'], ['blocker', '只看 blocker']]) {
            const b = doc.createElement('button')
            b.className = fb.filter === f ? 'on' : ''
            b.textContent = label
            b.addEventListener('click', (event) => { event.stopPropagation(); fb.onFilter(f) })
            filter.appendChild(b)
          }
          foot.appendChild(filter)
          const blockersBtn = doc.createElement('button')
          blockersBtn.className = 'dsrf-blockers'
          blockersBtn.textContent = '仅选 blocker'
          blockersBtn.title = '采纳全部 blocker、剔除其余（随后可点「回传」）'
          blockersBtn.addEventListener('click', (event) => { event.stopPropagation(); fb.onBlockers() })
          foot.appendChild(blockersBtn)
          vbody.appendChild(foot)
        }
        panel.appendChild(vbody)
        return panel
      }

      function ReviewButton(props) {
        useStoreTick()
        const messageId = props.messageId
        const sessionId = props.sessionId
        const [busy, setBusy] = useState(false)
        // 0.13.0 契约 v3 进展通道 + 在途恢复（修复「点评审后切换会话按钮
        // 复位」）：busy 是组件内 state，随卸载丢失；挂载即探一次远端
        // inFlight（host 侧评审可能仍在跑），在途期间每秒轮询，在途消失
        // 时强制重水合（完成/失败条目此刻已落 sidecar）。无在途时 tick
        // 空转，不产生远端流量。
        const [prog, setProg] = useState(null)
        const progRef = React.useRef(null)
        const aliveRef = React.useRef(true)
        const genRef = React.useRef(0)        // 丢弃过期响应（响应乱序）
        const pollBusyRef = React.useRef(false) // 避免同一消息的并发请求
        const idleRef = React.useRef(false)    // true 仅当确认无在途（停止轮询）
        useEffect(() => {
          let live = true
          aliveRef.current = true
          // 新代际：复位 idleRef，避免「上一代在途请求未回时初始 probe 被跳过」
          // 且 idleRef 仍为 true 而导致轮询永久停摆。
          idleRef.current = false
          const probe = () => {
            if (!live) return
            if (pollBusyRef.current) return // 不重叠：上一请求未回，不发新的
            pollBusyRef.current = true
            const gen = genRef.current
            reviewCall('progress', { sessionId, messageId })
              .then((res) => {
                if (!live || gen !== genRef.current) return // 忽略迟到的过期响应
                // 失败/错误形状/缺 inFlight 字段一律不是「完成」：保留既有
                // progRef/idleRef、继续轮询，绝不把 {} 之类误判为无在途。
                if (res === null || res.ok === false || typeof res !== 'object' || typeof res.inFlight !== 'boolean') return
                const inflight = res.inFlight === true
                const next = inflight ? res : null
                if (progRef.current && !inflight) {
                  // 评审在别处（或本页上一生命周期）结束：条目已持久化，
                  // 强制重水合拿到 verdict/失败态。
                  store.hydrated.delete(sessionId)
                  hydrate(sessionId, { force: true })
                }
                idleRef.current = !inflight
                progRef.current = next
                setProg(next)
              })
              .catch(() => { /* 网络错误：不是完成，保持轮询 */ })
              .finally(() => { pollBusyRef.current = false })
          }
          probe()
          const iv = setInterval(() => { if (busy || !idleRef.current) probe() }, 1000)
          return () => { live = false; aliveRef.current = false; genRef.current += 1; clearInterval(iv) }
        }, [busy, messageId, sessionId])
        // 停止控制：取消本次 session+message 的评审。失败必须保持可见可重试，
        // 不因请求失败而错误清除在途状态。
        const [cancelling, setCancelling] = useState(false)
        const [cancelError, setCancelError] = useState('')
        const [startError, setStartError] = useState(null)
        const cancelStop = () => {
          if (cancelling || !aliveRef.current) return
          setCancelling(true)
          setCancelError('')
          reviewCall('cancel', { sessionId, messageId })
            .then((res) => {
              if (!aliveRef.current) return
              const o = cancelOutcome(res)
              if (o.kind === 'accepted') {
                // 取消请求被接受。若服务端报告无在途（cancelled:false），说明
                // 评审已结束/未开始——强制刷新一次拿最终形态。
                if (o.refresh) {
                  store.hydrated.delete(sessionId)
                  hydrate(sessionId, { force: true })
                }
              } else {
                // 取消请求失败：保留停止按钮并显示可重试的错误，不清除在途。
                setCancelError(o.error)
              }
            })
            .catch((error) => {
              if (!aliveRef.current) return
              setCancelError(String(error && error.message || '取消失败'))
            })
            .finally(() => { if (aliveRef.current) setCancelling(false) })
        }
        const rootRef = React.useRef(null)
        useEffect(() => { void hydrate(sessionId) }, [sessionId])
        const entry = store.byMessage.get(messageId)
        // 回传 settle 后的重绘触发器：bump 本消息的 tick → 下面的 effect 重跑。
        const fbTick = store.feedback.tick.get(messageId) || 0
        const bumpTick = () => {
          store.feedback.tick.set(messageId, (store.feedback.tick.get(messageId) || 0) + 1)
          emit()
        }
        // One effect owns every visual artifact for this message: inline marks,
        // badges, and the card panel inserted right before the message's own
        // tail flow item (the direct child of the chat root on the button's
        // ancestor path). The paint is imperative DOM surgery, so React can
        // silently destroy it whenever it rebuilds the message subtree (turn
        // regrouping when a new turn starts, list re-slicing); a MutationObserver
        // self-heals by repainting once every owned span has disconnected.
        useEffect(() => {
          const el = rootRef.current
          if (!el || !entry) return undefined
          const doc = el.ownerDocument
          let markResult = null
          let panel = null
          let painting = false
          // ── 回传上下文：真实 reviewId 来自 entry 本身（host 落库时生成），
          // 勾选/已回传/注记全部 store 化，本 effect 的任何重绘都重新读出。
          const reviewId = typeof entry.reviewId === 'string' ? entry.reviewId : ''
          let fb
          if (entry.status !== 'error' && reviewId !== '') {
            if (!store.feedback.sent.has(reviewId)) store.feedback.sent.set(reviewId, new Set())
            // 0.12.0 ④默认采纳 + WAL 恢复：从「全部索引减已回传」出发，应用
            // accept/dismiss 增量；仅 filter 的记录不会清空选择。一旦本地分诊
            // 过（touched），不再用旧 WAL 重算，避免旧水合覆盖新操作。
            if (!store.feedback.sel.has(reviewId)) {
              const anns = Array.isArray(entry.annotations) ? entry.annotations : []
              const meta = store.feedback.meta.get(reviewId)
              const sentSet0 = store.feedback.sent.get(reviewId)
              store.feedback.sel.set(reviewId, restoreSelection(anns.length, sentSet0, meta && meta.triageStates))
            }
            const sel = store.feedback.sel.get(reviewId) ?? new Set()
            if (!store.feedback.sel.has(reviewId)) store.feedback.sel.set(reviewId, sel)
            const sent = store.feedback.sent.get(reviewId)
            // 分诊写入：串行化（逐 review 排队），失败注记到头部并保持可重试，
            // 不再 fire-and-forget 静默吞掉。
            const sendTriage = (payload) => {
              store.feedback.touched.add(reviewId)
              if (!store.feedback.triageChain.has(reviewId)) store.feedback.triageChain.set(reviewId, Promise.resolve())
              store.feedback.triageChain.set(reviewId, store.feedback.triageChain.get(reviewId)
                .then(() => reviewCall('triage', { sessionId, reviewId, ...payload }))
                .then((res) => {
                  if (!res || res.ok === false) {
                    store.feedback.note.set(reviewId, '分诊保存失败：' + String((res && res.error) || 'unknown'))
                    bumpTick()
                  }
                })
                .catch((error) => {
                  store.feedback.note.set(reviewId, '分诊保存异常：' + String(error && error.message || error))
                  bumpTick()
                }))
            }
            fb = {
              sel,
              sent,
              note: store.feedback.note.get(reviewId) || '',
              sending: store.feedback.sending.has(reviewId),
              filter: store.feedback.filter.get(reviewId) || 'all',
              onToggle: (index, checked) => {
                if (checked) sel.add(index); else sel.delete(index)
                sendTriage({ changes: [{ index, state: checked ? 'accept' : 'dismiss' }] })
              },
              onFilter: (f) => {
                store.feedback.filter.set(reviewId, f === 'blocker' ? 'blocker' : 'all')
                sendTriage({ filter: f === 'blocker' ? 'blocker' : 'all' })
                bumpTick()
              },
              onBlockers: () => {
                const anns = Array.isArray(entry.annotations) ? entry.annotations : []
                sel.clear()
                const changes = []
                anns.forEach((a, i) => {
                  const accept = a && a.severity === 'blocker' && !sent.has(i)
                  if (accept) sel.add(i)
                  changes.push({ index: i, state: accept ? 'accept' : 'dismiss' })
                })
                sendTriage({ changes })
                store.feedback.note.set(reviewId, '已选全部 blocker，其余剔除')
                bumpTick()
              },
              onSend: () => {
                if (store.feedback.sending.has(reviewId)) return
                const indices = Array.from(sel).sort((a, b) => a - b)
                if (indices.length === 0) {
                  store.feedback.note.set(reviewId, '先勾选要回传的批注')
                  bumpTick()
                  return
                }
                const annotations = Array.isArray(entry.annotations) ? entry.annotations : []
                const items = buildFeedbackItems(annotations, indices)
                  .filter((item) => !sent.has(item.index))
                if (items.length === 0) {
                  store.feedback.note.set(reviewId, '所选批注均已回传过')
                  bumpTick()
                  return
                }
                store.feedback.sending.add(reviewId)
                bumpTick()
                reviewCall('feedback', { sessionId, reviewId, messageId, items })
                  .then((res) => {
                    if (res && res.ok === true) {
                      // Delivered AND already-delivered (skipped) both count as
                      // sent: grey out + deselect so the panel matches server.
                      for (const item of items) {
                        sent.add(item.index)
                        sel.delete(item.index)
                      }
                      store.feedback.note.set(reviewId,
                        '✓ 已回传 ' + res.delivered + ' 条'
                        + (res.skipped > 0 ? '（跳过重复 ' + res.skipped + '）' : '')
                        + (res.warn ? ' · ' + res.warn : ''))
                    } else {
                      store.feedback.note.set(reviewId, '回传失败：' + String(res && res.error || 'unknown'))
                    }
                  })
                  .catch((error) => {
                    store.feedback.note.set(reviewId, '回传异常：' + String(error && error.message || error))
                  })
                  .finally(() => {
                    store.feedback.sending.delete(reviewId)
                    bumpTick()
                  })
              },
            }
          }
          const paint = () => {
            painting = true
            try {
              if (markResult) clearOwned(markResult.created)
              if (panel && panel.parentNode) panel.parentNode.removeChild(panel)
              markResult = null
              panel = null
              if (entry.status !== 'error') {
                markResult = markTurn(el, entry)
                entry.markStats = markResult.stats
              }
              const root = markResult && markResult.root
                ? markResult.root
                : findChatRoot(el, Array.isArray(entry.annotations) ? entry.annotations : [])
              panel = buildPanel(doc, entry, locate, fb)
              if (root) {
                let branch = el
                while (branch.parentElement && branch.parentElement !== root) branch = branch.parentElement
                root.insertBefore(panel, branch)
              } else {
                // Anchor text absent from the DOM (e.g. the critic quoted the
                // evidence section instead of the draft): the review must not
                // vanish together with its marks — park the panel right after
                // the message container reached a few levels up from the button.
                let host2 = el
                for (let d = 0; d < 4 && host2.parentElement && host2.parentElement !== doc.body; d += 1) host2 = host2.parentElement
                if (host2.parentElement) host2.parentElement.insertBefore(panel, host2.nextSibling)
              }
            } finally {
              painting = false
            }
          }
          // Panel card click → smooth-scroll to the annotation's inline mark
          // and flash it; marks absent (wiped or unmatchable) → repaint once,
          // then fall back to scrolling the message itself into view.
          const locate = (index) => {
            let spans = markResult && markResult.byIndex ? markResult.byIndex.get(index) : undefined
            let targetEl = spans ? spans.find((s) => s.isConnected) : undefined
            if (targetEl === undefined) {
              paint()
              emit()
              spans = markResult && markResult.byIndex ? markResult.byIndex.get(index) : undefined
              targetEl = spans ? spans.find((s) => s.isConnected) : undefined
            }
            ;(targetEl || el).scrollIntoView({ behavior: 'smooth', block: 'center' })
            if (targetEl !== undefined && spans) {
              for (const s of spans) {
                s.classList.remove('dsr-flash')
                void s.offsetWidth // restart the animation
                s.classList.add('dsr-flash')
              }
            }
          }
          paint()
          emit()
          let timer = null
          let deadRepaints = 0
          const observer = new MutationObserver(() => {
            if (painting || !el.isConnected || timer !== null) return
            const marksAlive = markResult !== null
              && markResult.created.some((item) => item.el.isConnected)
            const panelAlive = panel !== null && panel.parentNode !== null
            if (marksAlive && panelAlive) return
            timer = setTimeout(() => {
              timer = null
              if (!el.isConnected) return
              const before = entry.markStats ? entry.markStats.marked : 0
              paint()
              emit()
              const after = entry.markStats ? entry.markStats.marked : 0
              deadRepaints = after > 0 || after !== before ? 0 : deadRepaints + 1
              if (deadRepaints >= 3) observer.disconnect() // anchor truly unmatchable; stop retrying
            }, 120)
          })
          observer.observe(doc.body, { childList: true, subtree: true })
          return () => {
            observer.disconnect()
            if (timer !== null) clearTimeout(timer)
            if (markResult) clearOwned(markResult.created)
            if (panel && panel.parentNode) panel.parentNode.removeChild(panel)
          }
        }, [entry, fbTick])
        // 在途 = 本地点击 busy 或远端 inFlight（跨会话/页面生命周期恢复）。
        const inFlight = busy || (prog !== null && prog.inFlight === true)
        const label = inFlight ? inFlightLabel(prog) : statusButtonLabel(entry)
        const onClick = () => {
          if (inFlight) return
          setBusy(true)
          setStartError(null)
          reviewCall('start', { sessionId, messageId })
            .then((res) => {
              if (res && res.review) {
                absorb(res.review)
                setStartError(null)
              } else if (!res || !res.ok) {
                setStartError({ message: String(res && res.error || 'unknown error'), reviewId: entry?.reviewId })
                // Server-sided start failure. If the server actually accepted
                // start (e.g. a disconnect after it began, or an
                // "already in flight" veto), progress polling will override
                // this transient entry once inFlight->false force-rehydrates.
                // Marked `transient:true` so a durable host result (reviewId)
                // always outranks it regardless of the client wall-clock stamp.
                absorb({ messageId, status: 'error', error: String(res && res.error || 'unknown error'), annotations: [], createdAt: Date.now(), transient: true })
                if (res && res.error && /already in flight/i.test(String(res.error))) {
                  store.hydrated.delete(sessionId)
                  hydrate(sessionId, { force: true })
                }
              }
              if (!res || !res.ok) console.error('review.start failed:', res && res.error)
              emit()
            })
            .catch((error) => {
              // reviewCall usually converts a thrown call to {ok:false}; a raw
              // catch here means the process disconnects mid-start. The review
              // may still be running remotely — leave a transient error and let
              // polling (force-rehydrate on inFlight->false) surface the truth.
              setStartError({ message: String(error && error.message || error), reviewId: entry?.reviewId })
              absorb({ messageId, status: 'error', error: String(error && error.message || error), annotations: [], createdAt: Date.now(), transient: true })
              console.error('review.start call threw:', error && error.message)
              emit()
            })
            .then(() => setBusy(false))
        }
        const stats = entry && entry.markStats
        const tip = entry && entry.status === 'error'
          ? String(entry.error || 'unknown error')
          : '让批评者模型对这条回复做锚定批注评审'
            + (stats ? '（标记 ' + stats.marked + '/' + stats.total + (stats.failures.length > 0 ? '，失败：' + stats.failures.join('；') : '') + '）' : '')
        const stopButton = inFlight
          ? h('button', {
              className: 'dsr-cancel' + (cancelError ? ' dsr-cancel-failed' : ''),
              title: cancelError ? '取消失败：' + cancelError + '（点此重试）' : '停止本次评审',
              disabled: cancelling,
              onClick: cancelStop,
            }, cancelling ? '停止中…' : (cancelError ? '取消·重试' : '停止'))
          : null
        // AB/评审脚本关联：把本消息的 session/message 与（就绪时的）批评者路由
        // 投影成 data-* 属性。路由只在快照就绪时投影；快照/scope 不可用时省略，
        // 让脚本「fail closed」（不点/拒绝点击不匹配的评审）。
        let routeAttrs = {}
        try {
          if (typeof scope !== 'object' || typeof scope.getSnapshot !== 'function') {
            routeAttrs = {}
          } else {
            const snap = scope.getSnapshot()
            routeAttrs = criticRouteAttrs(snap && snap.status === 'ready' ? snap.value : undefined)
          }
        } catch {
          routeAttrs = {}
        }
        return h('span', { style: { display: 'inline-flex', gap: '4px', alignItems: 'center' } },
          h('button', {
            className: 'dsr-btn',
            'data-ciel-session-id': sessionId,
            'data-ciel-message-id': messageId,
            ...routeAttrs,
            onClick,
            disabled: inFlight,
            title: tip,
            ref: rootRef,
          }, label),
          stopButton,
          startError && (!entry || entry.transient || entry.reviewId === startError.reviewId)
            ? h('span', { className: 'dsr-start-error', title: startError.message, style: { fontSize: '11px', color: '#d29922' } }, '本次请求失败 · 可重试')
            : null,
        )
      }

      // ── frame overlay: the annotation popover, positioned at the clicked mark.
      function PopoverLayer() {
        useStoreTick()
        const pop = store.popover
        useEffect(() => {
          if (!pop) return undefined
          const close = () => { store.popover = null; emit() }
          document.addEventListener('click', close)
          return () => document.removeEventListener('click', close)
        }, [pop])
        if (!pop || !pop.annotation) return null
        const a = pop.annotation
        const sev = a.severity === 'blocker' ? 'blocker' : 'nit'
        return h('div', {
          className: 'dsr-pop',
          style: { left: pop.x + 'px', top: pop.y + 'px' },
          onClick: (event) => event.stopPropagation(),
        },
          h('div', { className: 'dsr-pop-head' },
            h('span', { className: 'dsr-sev dsr-sev-' + sev }, sev),
            h('span', { className: 'dsr-badge dsr-badge-' + sev, style: { verticalAlign: '1px', marginRight: '5px' } }, String(pop.index)),
            h('span', { className: 'dsr-title' }, a.title || '（无标题）')),
          a.anchor ? h('div', { className: 'dsr-pop-anchor' }, a.anchor.length > 220 ? a.anchor.slice(0, 219) + '…' : a.anchor) : null,
          h('div', { className: 'dsr-pop-comment' }, a.comment || ''))
      }

      ctx.slots.inject('conversation.chat.assistant-actions', () =>
        ctx.slots.register(
          { name: 'conversation.chat.assistant-actions', id: 'advisor-review', order: 20, label: '批注评审' },
          (props) => h(ReviewButton, props),
        ),
      )
      // ── M3-④: ask_advisor 的 keyed tool view（未占用键，纯增量；通用行兜底不变）
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register(
          { name: 'tool.call.toolview', key: 'ask_advisor' },
          (props) => h(AdvisorToolView, props),
        ),
      )
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          { name: 'shell.overlay', id: 'advisor-review-popover' },
          () => h(PopoverLayer),
        ),
      )
      // Test hook: expose live runtime internals so node integration tests can
      // drive the actual apply/hydrate/ReviewButton wiring (not helper logic).
      Object.assign(__runtime, { store, hydrate, reviewCall, emit, absorb, ReviewButton, buildPanel })
      // Clear the test-runtime capture on teardown so a stopped runtime is not
      // retained (avoids stale store/slots after plugin stop).
      ctx.effect(() => () => {
        for (const k of Object.keys(__runtime)) delete __runtime[k]
      }, 'dsh-advisor: review runtime cleanup')
    }

    exports.apply = apply
    // Test hook: the node test harness loads this factory with a stubbed
    // ModuleLoader and asserts splitter parity plus the reviewed-UI pure
    // helpers (coverage/soundness/labels/selection/feedback shaping).
    exports.__test = {
      splitMarkdownBlocks,
      deriveCoverage,
      isSoundEntry,
      verdictBadgeClass,
      verdictBadgeText,
      statusButtonLabel,
      inFlightLabel,
      restoreSelection,
      buildFeedbackItems,
      isListResultLoaded,
      cancelOutcome,
      entryTime,
      shouldReplace,
      entryRank,
      criticRouteAttrs,
      // live internals captured by apply() (undefined until apply runs)
      runtime: __runtime,
      // descriptor / settings completeness (refresh-free snapshots for tests)
      remoteMethodNames: ADVISOR_REMOTE.descriptors.map((d) => d.method),
      defaults: { ...DEFAULTS },
      fieldDefinition: (key) => {
        const def = FIELD_DEF_BY_KEY[key]
        return def ? { kind: def.kind, min: def.min, max: def.max, label: def.label } : undefined
      },
      fieldKeys: FIELD_KEYS.slice(),
      hasGroup: (key) => Object.prototype.hasOwnProperty.call(INITIAL_CLOSED_GROUPS, key) && INITIAL_CLOSED_GROUPS[key] === true,
    }
    exports.inject = ['settingsScope', 'slots']
    // The module system materializes the factory's RETURN VALUE as the plugin
    // exports — assigning without returning leaves the kernel `undefined`.
    return module.exports
  },
})
