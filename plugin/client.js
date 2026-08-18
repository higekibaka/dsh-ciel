// dsh-advisor browser half: the Settings → Plugins → 插件配置 card editing the
// `advisor` settings namespace owned by the host half. Self-contained by hand
// (no bundler): the client module system wraps this file in a CJS factory and
// the kernel adopts { apply, inject } as a client plugin.
//
// The card mirrors the shipped plugin cards (PluginCard/fields in
// dsh-client-ui-settings-plugins): collapsed by default, name-over-description
// header, staged drafts with one save point, per-field override badge and
// reset, and a save that writes through the revision-fenced settings scope.
// Provider/model are dropdowns fed by the same catalog RPC the Models page
// uses, degrading to text inputs when the catalog is unreachable.

window.__ModuleLoader__.load({
  id: 'dsh-advisor',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const { useState, useEffect } = React
    const h = React.createElement

    /** Bound in apply() before the card registers. */
    let scope = null
    /** Lazy connection reader: a hard inject would park the card's registration. */
    let getConnection = () => undefined

    /** Mirror of the host schema defaults — what a reset stages. */
    const DEFAULTS = {
      provider: 'kimi-coding',
      model: 'kimi-for-coding',
      maxTokens: 4096,
      allowWebSearch: true,
      reasoningEffort: 'provider',
      guidanceEnabled: true,
    }
    const FIELD_KEYS = ['provider', 'model', 'maxTokens', 'allowWebSearch', 'reasoningEffort', 'guidanceEnabled']
    const MAX_TOKENS_MIN = 256
    const MAX_TOKENS_MAX = 32768

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

    /** Unwrap the client RPC envelope: { rpcId, result: { ok, value } }. */
    function unwrapRpc(body) {
      if (body && typeof body === 'object' && body.result && typeof body.result === 'object') {
        if (body.result.ok !== true) {
          const message = body.result.error && body.result.error.message
          throw new Error(message || '模型目录接口返回失败')
        }
        return body.result.value
      }
      return body
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

      useEffect(() => {
        if (scope === null) return undefined
        return scope.subscribe(() => setTick((tick) => tick + 1))
      }, [])

      // Lazy catalog load on first expand: the dropdown source is the same
      // llm.models RPC the Models settings page uses.
      useEffect(() => {
        if (!open || catalog.status !== 'idle') return
        const connection = getConnection()
        const modelsFn = connection && connection.api && connection.api.llm && connection.api.llm.models
        if (typeof modelsFn !== 'function') {
          setCatalog({ status: 'unavailable', groups: [] })
          return
        }
        setCatalog({ status: 'loading', groups: [] })
        Promise.resolve(connection.api.llm.models({}))
          .then(unwrapRpc)
          .then((value) => {
            const groups = value && Array.isArray(value.groups) ? value.groups : []
            setCatalog({ status: 'ready', groups })
          })
          .catch(() => setCatalog({ status: 'unavailable', groups: [] }))
      }, [open, catalog.status])

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
        allowWebSearch: Boolean(value.allowWebSearch),
        reasoningEffort: String(value.reasoningEffort ?? 'provider'),
        guidanceEnabled: Boolean(value.guidanceEnabled),
      }
      if (drafts === null) setDrafts(staged)

      const maxTokensParsed = Math.round(Number(staged.maxTokens))
      const maxTokensInvalid = staged.maxTokens.trim() === ''
        || !Number.isFinite(maxTokensParsed)
        || maxTokensParsed < MAX_TOKENS_MIN
        || maxTokensParsed > MAX_TOKENS_MAX

      const dirtyKey = (key) => {
        if (resets[key]) return true
        if (key === 'maxTokens') return !maxTokensInvalid && maxTokensParsed !== value.maxTokens
        if (key === 'allowWebSearch' || key === 'guidanceEnabled') return staged[key] !== Boolean(value[key])
        if (key === 'reasoningEffort') return staged[key] !== String(value[key] ?? 'provider')
        return staged[key] !== String(value[key] ?? '')
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
              await scope.set(key, key === 'maxTokens' ? maxTokensParsed : staged[key])
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

      // Reasoning-effort options follow the SELECTED model's declared levels
      // when the catalog advertises them; otherwise the full host-schema set
      // stays offered so the field remains usable without the catalog.
      const selectedModel = selectedGroup && Array.isArray(selectedGroup.models)
        ? selectedGroup.models.find((model) => model.id === staged.model)
        : undefined
      const declaredEfforts = selectedModel && selectedModel.reasoning && Array.isArray(selectedModel.reasoning.efforts)
        ? selectedModel.reasoning.efforts
        : []
      const effortLevels = declaredEfforts.length > 0
        ? declaredEfforts.map((effort) => effort.id)
        : EFFORT_LEVELS
      const effortOptions = [
        { value: 'provider', label: EFFORT_LABELS.provider },
        ...effortLevels.map((level) => ({
          value: level,
          label: `${EFFORT_LABELS[level] || level}（${level}）`,
        })),
      ]

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
                ? '模型目录不可用，请直接输入 id。' + hint
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
      const effortField = () => {
        const key = 'reasoningEffort'
        const options = effortOptions.some((option) => option.value === staged[key])
          ? effortOptions
          : [...effortOptions, { value: staged[key], label: `${staged[key]}（自定义）` }]
        const hint = catalog.status === 'ready'
          ? declaredEfforts.length > 0
            ? '注入该次咨询每个请求的思考深度；选项与所选模型声明的档位一致。'
            : '所选模型未声明思考档位；显式选择不支持的档位会在咨询时报错。'
          : '注入该次咨询每个请求的思考深度；模型目录不可用，未校验档位支持。'
        return h('div', { key, style: { ...css.field, ...css.fieldBorder } },
          h(FieldHead, {
            label: '思考深度',
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

      const blocked = !dirty || maxTokensInvalid || saving

      return h('li', { style: css.card },
        h('button', {
          type: 'button',
          style: css.header,
          'aria-expanded': open,
          'aria-label': `${open ? '收起' : '展开'}: 顾问`,
          onClick: () => setOpen(!open),
        },
          h('span', { style: css.headText },
            h('span', { style: css.name }, '顾问'),
            h('span', { style: css.description }, '规划前咨询的第二模型：提供思路、领域知识与陷阱，不输出步骤。'),
          ),
          dirty ? h('span', { style: css.pending }, '未保存') : null,
          h(Chevron, { open }),
        ),
        open
          ? h('div', { style: css.body },
              !snap.writable ? h('p', { style: css.readOnly, role: 'status' }, '当前设置为只读。') : null,
              routeField('provider', '提供方路由', '须是「设置 → 模型」中已注册的 provider 路由。', providerOptions),
              routeField('model', '顾问模型', '与主模型跨家族时多样性收益最大。', modelOptions),
              effortField(),
              h('div', { key: 'maxTokens', style: { ...css.field, ...css.fieldBorder } },
                h(FieldHead, {
                  label: '输出上限（tokens）',
                  overridden: overridden('maxTokens') && !resets.maxTokens,
                  disabled,
                  onReset: () => resetField('maxTokens'),
                }),
                h('input', {
                  style: maxTokensInvalid ? { ...css.input, ...css.inputInvalid } : css.input,
                  type: 'text',
                  inputMode: 'numeric',
                  value: staged.maxTokens,
                  disabled,
                  'aria-invalid': maxTokensInvalid || undefined,
                  onChange: (event) => edit('maxTokens', event.target.value),
                }),
                h('p', { style: maxTokensInvalid ? css.invalidText : css.hint },
                  maxTokensInvalid
                    ? `须是 ${MAX_TOKENS_MIN}–${MAX_TOKENS_MAX} 之间的数字`
                    : '顾问单次回答的长度上限。'),
              ),
              checkField('allowWebSearch', '允许顾问联网搜索', '开启后顾问可使用 web_search 查证；关闭为纯参数知识。'),
              checkField('guidanceEnabled', '注入使用协议到系统提示词', '触发判据与追问预算；改动即刻生效（影响提示词前缀）。'),
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

    function apply(ctx) {
      scope = ctx.settingsScope.bind({ namespace: 'advisor' })
      getConnection = () => {
        try {
          return ctx.get('connection')
        } catch {
          return undefined
        }
      }
      ctx.slots.inject('settings.plugin.item', () =>
        ctx.slots.register(
          { name: 'settings.plugin.item', id: 'advisor', order: 40, label: '顾问 (dsh-advisor)' },
          () => h(AdvisorCard),
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['settingsScope', 'slots']
    // The module system materializes the factory's RETURN VALUE as the plugin
    // exports — assigning without returning leaves the kernel `undefined`.
    return module.exports
  },
})
