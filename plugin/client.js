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
      criticModel: 'gemini-3.7-flash',
      criticEffort: 'medium',
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
        summarize: (staged) => `${staged.criticProvider} / ${staged.criticModel} · ${staged.criticEffort}`,
        children: [
          { kind: 'route', key: 'criticProvider', label: '批评者提供方', options: 'provider', hint: '评审子代理的 provider 路由；跨家族纠错收益最大。独立于上面的顾问管道。' },
          { kind: 'route', key: 'criticModel', label: '批评者模型', options: 'criticModel', hint: 'gemini-3.7-flash 过载时可临时切走（如 deepseek flash）。' },
          {
            kind: 'effort', key: 'criticEffort', label: '批评者思考深度', opts: 'critic', fallback: 'medium',
            hintReady: '注入评审子代理的每个请求；跟随提供方默认则不注入。选项与所选模型声明的档位一致（gemini-3.7-flash 仅 low/medium/high）。',
            hintFallback: '注入评审子代理的每个请求；跟随提供方默认则不注入。模型目录不可用，未校验档位支持。',
          },
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
      descriptors: ['list', 'start', 'feedback'].map((method) => ({
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
      const isHeading = (l) => /^#{1,6}\s/.test(l)
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
            if (j < lines.length && (isListItem(lines[j]) || /^\s{2,}\S/.test(lines[j]))) { i = j; continue }
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
          const dispose = await remoteService.$mount(ADVISOR_REMOTE)
          reviewApiResolve(ctx.get('remote.advisorReview') ?? null)
          return async () => { await dispose() }
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
        popover: null,
        // 回传状态，全部按 reviewId 归键——面板是 imperative DOM，React 重建
        // 后由 buildPanel 从这里重读，勾选/已回传/注记随重绘保留。
        feedback: {
          sel: new Map(),      // reviewId -> Set<annotation index>
          sent: new Map(),     // reviewId -> Set<index>（hydrate 自 sentKeys，发送后更新）
          note: new Map(),     // reviewId -> 面板头注记文本
          sending: new Set(),  // 有在途回传的 reviewId
          tick: new Map(),     // messageId -> 重绘计数器（回传 settle 后 bump）
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
        store.byMessage.set(entry.messageId, entry)
      }
      async function hydrate(sessionId) {
        if (typeof sessionId !== 'string' || store.hydrated.has(sessionId)) return
        store.hydrated.add(sessionId)
        try {
          const res = await reviewCall('list', { sessionId })
          const reviews = res && Array.isArray(res.reviews) ? res.reviews : []
          for (const r of reviews) absorb(r)
          // 已回传去重键（reviewId#index）→ 置灰对应条目，刷新后不依赖服务端重放拒绝。
          const sentKeys = res && Array.isArray(res.sentKeys) ? res.sentKeys : []
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
          emit()
        } catch (error) {
          store.hydrated.delete(sessionId)
          console.error('review.list failed', error && error.message)
        }
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
        for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) {
          if (node === (anchorEl.ownerDocument && anchorEl.ownerDocument.body)) return null
          const hay = textOf(node, anchorEl).replace(/\s+/g, ' ')
          if (probes.length === 0 ? hay.length > 200 : probes.some((p) => hay.includes(p))) return node
        }
        return null
      }

      // ── undo exactly what one effect created: mark spans unwrap back to
      // their text; badge spans are chrome, not content — remove them outright.
      // Spans already gone (React re-rendered the body) are skipped.
      function clearOwned(created) {
        for (const item of created) {
          const span = item.el
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
        annotations.forEach((a, i) => {
          if (!a || typeof a.anchor !== 'string') return
          const needle = normalizeAnchor(a.anchor)
          if (needle.length < 4) return
          stats.total += 1
          try {
            const range = locateRange(collectTextNodes(root, anchorEl), needle, anchorEl)
            if (!range) {
              stats.failures.push('#' + (i + 1) + ' anchor not found in DOM text')
              return
            }
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
        const head = doc.createElement('div')
        head.className = 'dsr-tail-head'
        head.textContent = (entry.status === 'sound'
          ? '✓ 批评者：草案整体成立'
          : '批评者批注 · ' + annotations.length + ' 条'
            + (stats ? ' · 标记 ' + stats.marked + '/' + stats.total : '')
            + '（点击卡片定位到原文；波浪下划线与角标也可点击）'
            + (entry.status === 'completed-unparsed' ? '（未解析出结构化批注，原文如下）' : '')
            + (stats && stats.failures.length > 0 ? '　标记失败：' + stats.failures.join('；') : ''))
          + targetsNote
        // ── 回传选中：勾选态/已回传态都在 store.feedback（随重绘重读），
        // reviewId 直接取自 entry——原型里的 title 匹配猜测链已删除。
        if (fb && annotations.length > 0) {
          const sendBtn = doc.createElement('button')
          sendBtn.className = 'dsrf-send'
          sendBtn.title = '把勾选的批注回传给主模型修复（author-owns-the-remedy）'
          const syncLabel = () => {
            sendBtn.textContent = fb.sending ? '回传中…' : (fb.sel.size > 0 ? '回传选中 (' + fb.sel.size + ')' : '回传选中')
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
        annotations.forEach((a, i) => {
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
            cb.title = isSent ? '已回传过' : '勾选后点「回传选中」发给主模型修复'
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
          if (!a.matched) {
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
          const cm = doc.createElement('div')
          cm.className = 'dsr-comment'
          cm.textContent = a.comment || ''
          item.appendChild(cm)
          panel.appendChild(item)
        })
        if (typeof entry.raw === 'string' && entry.raw !== '') {
          const raw = doc.createElement('div')
          raw.className = 'dsr-raw'
          raw.textContent = entry.raw
          panel.appendChild(raw)
        }
        return panel
      }

      function ReviewButton(props) {
        useStoreTick()
        const messageId = props.messageId
        const sessionId = props.sessionId
        const [busy, setBusy] = useState(false)
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
            if (!store.feedback.sel.has(reviewId)) store.feedback.sel.set(reviewId, new Set())
            if (!store.feedback.sent.has(reviewId)) store.feedback.sent.set(reviewId, new Set())
            const sel = store.feedback.sel.get(reviewId)
            const sent = store.feedback.sent.get(reviewId)
            fb = {
              sel,
              sent,
              note: store.feedback.note.get(reviewId) || '',
              sending: store.feedback.sending.has(reviewId),
              onToggle: (index, checked) => { if (checked) sel.add(index); else sel.delete(index) },
              onSend: () => {
                if (store.feedback.sending.has(reviewId)) return
                const indices = Array.from(sel).sort((a, b) => a - b)
                if (indices.length === 0) {
                  store.feedback.note.set(reviewId, '先勾选要回传的批注')
                  bumpTick()
                  return
                }
                const annotations = Array.isArray(entry.annotations) ? entry.annotations : []
                const items = indices
                  .filter((i) => annotations[i] !== undefined && !sent.has(i))
                  .map((i) => ({
                    index: i,
                    severity: annotations[i].severity === 'blocker' ? 'blocker' : 'nit',
                    title: String(annotations[i].title || ''),
                    anchor: String(annotations[i].anchor || ''),
                    comment: String(annotations[i].comment || ''),
                  }))
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
                      const skipped = Array.isArray(res.skippedIndices) ? res.skippedIndices : []
                      for (const item of items) {
                        if (skipped.includes(item.index)) continue
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
        const count = entry && Array.isArray(entry.annotations) ? entry.annotations.length : 0
        const label = busy
          ? '评审中…'
          : entry === undefined
            ? '批注评审'
            : entry.status === 'sound'
              ? '✓ 无阻断 (' + count + ')'
              : entry.status === 'error'
                ? '评审失败 · 重试'
                : '批注 ' + count + ' · 复审'
        const onClick = () => {
          if (busy) return
          setBusy(true)
          reviewCall('start', { sessionId, messageId })
            .then((res) => {
              if (res && res.review) absorb(res.review)
              else if (!res || !res.ok) {
                store.byMessage.set(messageId, { messageId, status: 'error', error: String(res && res.error || 'unknown error'), annotations: [] })
              }
              if (!res || !res.ok) console.error('review.start failed:', res && res.error)
              emit()
            })
            .catch((error) => {
              store.byMessage.set(messageId, { messageId, status: 'error', error: String(error && error.message || error), annotations: [] })
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
        return h('button', {
          className: 'dsr-btn',
          onClick,
          disabled: busy,
          title: tip,
          ref: rootRef,
        }, label)
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
    }

    exports.apply = apply
    // Test hook: the node test harness loads this factory with a stubbed
    // ModuleLoader and asserts the two splitMarkdownBlocks copies agree.
    exports.__test = { splitMarkdownBlocks }
    exports.inject = ['settingsScope', 'slots']
    // The module system materializes the factory's RETURN VALUE as the plugin
    // exports — assigning without returning leaves the kernel `undefined`.
    return module.exports
  },
})
