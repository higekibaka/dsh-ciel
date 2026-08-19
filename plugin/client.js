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
      maxCallsPerTurn: 3,
      requireExploration: true,
      enforceFollowupGap: true,
      planReminderEnabled: true,
      reasoningEffort: 'provider',
      guidanceEnabled: true,
    }
    const FIELD_KEYS = ['provider', 'model', 'maxTokens', 'maxCallsPerTurn', 'requireExploration', 'enforceFollowupGap', 'planReminderEnabled', 'reasoningEffort', 'guidanceEnabled']
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
        maxCallsPerTurn: String(value.maxCallsPerTurn ?? ''),
        requireExploration: Boolean(value.requireExploration),
        enforceFollowupGap: Boolean(value.enforceFollowupGap),
        planReminderEnabled: Boolean(value.planReminderEnabled),
        reasoningEffort: String(value.reasoningEffort ?? 'provider'),
        guidanceEnabled: Boolean(value.guidanceEnabled),
      }
      if (drafts === null) setDrafts(staged)

      const maxTokensParsed = Math.round(Number(staged.maxTokens))
      const maxTokensInvalid = staged.maxTokens.trim() === ''
        || !Number.isFinite(maxTokensParsed)
        || maxTokensParsed < MAX_TOKENS_MIN
        || maxTokensParsed > MAX_TOKENS_MAX
      const maxCallsParsed = Math.round(Number(staged.maxCallsPerTurn))
      const maxCallsInvalid = staged.maxCallsPerTurn.trim() === ''
        || !Number.isFinite(maxCallsParsed)
        || maxCallsParsed < MAX_CALLS_MIN
        || maxCallsParsed > MAX_CALLS_MAX

      const dirtyKey = (key) => {
        if (resets[key]) return true
        if (key === 'maxTokens') return !maxTokensInvalid && maxTokensParsed !== value.maxTokens
        if (key === 'maxCallsPerTurn') return !maxCallsInvalid && maxCallsParsed !== value.maxCallsPerTurn
        if (key === 'requireExploration' || key === 'enforceFollowupGap' || key === 'planReminderEnabled' || key === 'guidanceEnabled') return staged[key] !== Boolean(value[key])
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
              const parsed = key === 'maxTokens' ? maxTokensParsed : key === 'maxCallsPerTurn' ? maxCallsParsed : undefined
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

      const blocked = !dirty || maxTokensInvalid || maxCallsInvalid || saving

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
              h('div', { key: 'maxCallsPerTurn', style: { ...css.field, ...css.fieldBorder } },
                h(FieldHead, {
                  label: '每轮咨询额度',
                  overridden: overridden('maxCallsPerTurn') && !resets.maxCallsPerTurn,
                  disabled,
                  onReset: () => resetField('maxCallsPerTurn'),
                }),
                h('input', {
                  style: maxCallsInvalid ? { ...css.input, ...css.inputInvalid } : css.input,
                  type: 'text',
                  inputMode: 'numeric',
                  value: staged.maxCallsPerTurn,
                  disabled,
                  'aria-invalid': maxCallsInvalid || undefined,
                  onChange: (event) => edit('maxCallsPerTurn', event.target.value),
                }),
                h('p', { style: maxCallsInvalid ? css.invalidText : css.hint },
                  maxCallsInvalid
                    ? `须是 ${MAX_CALLS_MIN}–${MAX_CALLS_MAX} 之间的数字`
                    : '一个 turn（≈一个规划阶段）内允许的顾问调用上限：1 次发散 + 追问预算；超出即被拒绝。'),
              ),
              checkField('requireExploration', '首次咨询前要求先探查', '本会话内首个 ask_advisor 调用前，必须已有至少一次非顾问工具调用（读/搜/跑）。'),
              checkField('enforceFollowupGap', '追问之间要求独立工作', '同一 turn 内两次咨询之间必须至少有一次非顾问工具调用——追问须由新事实驱动。'),
              checkField('planReminderEnabled', '规划时刻提醒', '检测到本 turn 开始规划（todo_write / exit_plan_mode）且尚未咨询时，在下一步系统提示里注入一次提醒；机制不做任务语义判断。'),
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

    /** Pass-through codec: both halves of this Remote are first-party. */
    const PASS_CODEC = { parse: (value) => value }

    /** The advisorReview Remote contribution this client $mounts on boot. */
    const ADVISOR_REMOTE = {
      package: 'dsh-advisor',
      descriptors: ['list', 'start'].map((method) => ({
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
    ].join('\n')

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
          { name: 'settings.plugin.item', key: 'advisor' },
          () => h(AdvisorCard),
        ),
      )

      // ═══════════════ M3-③ 批注评审 UI（annrev 原型移植） ═══════════════
      // Marks/badges/panel are driven by the per-message button's effect —
      // deliberately NOT the turnTail chain (winner-take-all, deliverables
      // wins file-producing turns). Anchors match by proximity: the last
      // occurrence before the message's own button. Cleanup is owned-spans
      // only, so one message never disturbs another's marks.

      const styleEl = document.createElement('style')
      styleEl.textContent = REVIEW_CSS
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
      const store = { byMessage: new Map(), hydrated: new Set(), popover: null }
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
      function wrapRange(doc, root, range, spanClass, badge, onActivate, created) {
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
          created.push({ kind: 'mark', el: span })
          if (node === last) lastSpan = span
        }
        if (lastSpan && lastSpan.parentNode) {
          lastSpan.parentNode.insertBefore(badge, lastSpan.nextSibling)
        } else if (last.parentNode) {
          last.parentNode.insertBefore(badge, last.nextSibling)
        }
        created.push({ kind: 'badge', el: badge })
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
          return { root: null, stats, created }
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
            wrapRange(doc, root, range, 'dsr-mark dsr-mark-' + sev, badge, open, created)
            stats.marked += 1
          } catch (error) {
            stats.failures.push('#' + (i + 1) + ' ' + String(error && error.message || error))
          }
        })
        if (stats.failures.length > 0) console.error('advisor-review mark failures:', stats.failures.join(' | '))
        return { root, stats, created }
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
      function buildPanel(doc, entry) {
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
        const head = doc.createElement('div')
        head.className = 'dsr-tail-head'
        head.textContent = entry.status === 'sound'
          ? '✓ 批评者：草案整体成立'
          : '批评者批注 · ' + annotations.length + ' 条'
            + (stats ? ' · 标记 ' + stats.marked + '/' + stats.total : '')
            + '（原文中的波浪下划线与角标可点击）'
            + (entry.status === 'completed-unparsed' ? '（未解析出结构化批注，原文如下）' : '')
            + (stats && stats.failures.length > 0 ? '　标记失败：' + stats.failures.join('；') : '')
        panel.appendChild(head)
        annotations.forEach((a, i) => {
          const sev = a.severity === 'blocker' ? 'blocker' : 'nit'
          const item = doc.createElement('div')
          item.className = 'dsr-item'
          const row = doc.createElement('div')
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
        // One effect owns every visual artifact for this message: inline marks,
        // badges, and the card panel inserted right before the message's own
        // tail flow item (the direct child of the chat root on the button's
        // ancestor path).
        useEffect(() => {
          const el = rootRef.current
          if (!el || !entry) return undefined
          const doc = el.ownerDocument
          let markResult = null
          if (entry.status !== 'error') {
            markResult = markTurn(el, entry)
            entry.markStats = markResult.stats
          }
          const root = markResult && markResult.root
            ? markResult.root
            : findChatRoot(el, Array.isArray(entry.annotations) ? entry.annotations : [])
          let panel = null
          if (root) {
            panel = buildPanel(doc, entry)
            let branch = el
            while (branch.parentElement && branch.parentElement !== root) branch = branch.parentElement
            root.insertBefore(panel, branch)
          }
          emit()
          return () => {
            if (markResult) clearOwned(markResult.created)
            if (panel && panel.parentNode) panel.parentNode.removeChild(panel)
          }
        }, [entry])
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
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          { name: 'shell.overlay', id: 'advisor-review-popover' },
          () => h(PopoverLayer),
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
