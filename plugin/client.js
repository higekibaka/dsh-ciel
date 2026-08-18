// dsh-advisor browser half: the Settings → Plugins → 插件配置 card editing the
// `advisor` settings namespace owned by the host half. Self-contained by hand
// (no bundler): the client module system wraps this file in a CJS factory and
// the kernel adopts { apply, inject } as a client plugin.
//
// The card writes through the client settings scope: every commit is fenced
// by the namespace revision, and the host remains the only authority on
// whether a value was accepted — the card re-reads the snapshot after writes
// and shows the last accepted values. Provider/model fields are dropdowns fed
// by the same catalog RPC the Models settings page uses (connection.api
// .llm.models); when the catalog is unreachable they degrade to free text.

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

    const css = {
      card: {
        border: '1px solid var(--border, #3a3a3a)',
        borderRadius: '8px',
        display: 'flex',
        flexDirection: 'column',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        padding: '10px 16px',
        background: 'transparent',
        border: 'none',
        color: 'inherit',
        cursor: 'pointer',
        textAlign: 'left',
        fontSize: '14px',
      },
      title: { fontWeight: 600 },
      summary: { opacity: 0.55, fontSize: '12px', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      chevron: { opacity: 0.6, fontSize: '12px' },
      body: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '0 16px 12px',
      },
      desc: { opacity: 0.75, fontSize: '12px', lineHeight: 1.6 },
      field: { display: 'flex', flexDirection: 'column', gap: '4px' },
      labelRow: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' },
      overridden: {
        fontSize: '11px',
        opacity: 0.65,
        border: '1px solid currentColor',
        borderRadius: '4px',
        padding: '0 4px',
      },
      input: {
        background: 'var(--input-bg, transparent)',
        border: '1px solid var(--border, #3a3a3a)',
        borderRadius: '6px',
        padding: '6px 8px',
        fontSize: '13px',
        color: 'inherit',
      },
      checkRow: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' },
      footer: { display: 'flex', alignItems: 'center', gap: '12px', fontSize: '12px', opacity: 0.8 },
      button: {
        border: '1px solid var(--border, #3a3a3a)',
        borderRadius: '6px',
        padding: '4px 10px',
        fontSize: '12px',
        cursor: 'pointer',
        background: 'transparent',
        color: 'inherit',
      },
      status: { opacity: 0.6 },
      error: { color: 'var(--error, #e06c75)', fontSize: '12px' },
    }

    const TOGGLE_FIELDS = [
      { key: 'allowWebSearch', label: '允许顾问联网搜索', desc: '开启后顾问可使用 web_search 查证；关闭为纯参数知识。' },
      { key: 'guidanceEnabled', label: '注入使用协议到系统提示词', desc: '触发判据与追问预算；改动即刻生效（影响提示词前缀）。' },
    ]

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

    function commit(key, value, setError) {
      Promise.resolve(scope.set(key, value)).catch((error) => {
        setError(error && error.message ? error.message : String(error))
      })
    }

    function OverriddenTag() {
      return h('span', { style: css.overridden }, '已覆盖')
    }

    /** Dropdown fed by the model catalog; the current value always stays
     * selectable even when absent from the catalog (custom route). */
    function SelectField({ fieldKey, label, value, options, writable, setError, desc, overridden }) {
      const has = options.some((option) => option.value === value)
      const all = has || value === undefined || value === ''
        ? options
        : [...options, { value, label: `${value}（自定义）` }]
      return h('label', { style: css.field },
        h('span', { style: css.labelRow }, h('span', null, label), overridden ? h(OverriddenTag) : null),
        h('select', {
          style: css.input,
          value: value ?? '',
          disabled: !writable,
          onChange: (event) => commit(fieldKey, event.target.value, setError),
        }, all.map((option) => h('option', { key: option.value, value: option.value }, option.label))),
        desc ? h('span', { style: css.desc }, desc) : null,
      )
    }

    function NumberField({ label, value, min, max, writable, setError, desc, overridden }) {
      const [draft, setDraft] = useState(value === undefined || value === null ? '' : String(value))
      useEffect(() => {
        setDraft(value === undefined || value === null ? '' : String(value))
      }, [value])
      const flush = () => {
        if (draft.trim() === '') return
        const parsed = Math.round(Number(draft))
        if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
          setError(`${label} 须是 ${min}–${max} 之间的数字`)
          return
        }
        if (parsed !== value) commit('maxTokens', parsed, setError)
      }
      return h('label', { style: css.field },
        h('span', { style: css.labelRow }, h('span', null, label), overridden ? h(OverriddenTag) : null),
        h('input', {
          style: css.input,
          value: draft,
          inputMode: 'numeric',
          disabled: !writable,
          onChange: (event) => setDraft(event.target.value),
          onBlur: flush,
          onKeyDown: (event) => {
            if (event.key === 'Enter') event.target.blur()
          },
        }),
        desc ? h('span', { style: css.desc }, desc) : null,
      )
    }

    function CheckField({ field, value, overridden, writable, setError }) {
      return h('div', { style: css.field },
        h('label', { style: css.checkRow },
          h('input', {
            type: 'checkbox',
            checked: Boolean(value),
            disabled: !writable,
            onChange: (event) => commit(field.key, event.target.checked, setError),
          }),
          h('span', null, field.label),
          overridden ? h(OverriddenTag) : null,
        ),
        field.desc ? h('span', { style: css.desc }, field.desc) : null,
      )
    }

    function AdvisorCard() {
      const [, setTick] = useState(0)
      const [error, setError] = useState('')
      const [open, setOpen] = useState(false)
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
          .catch((loadError) => {
            setCatalog({
              status: 'unavailable',
              groups: [],
              error: loadError && loadError.message ? loadError.message : String(loadError),
            })
          })
      }, [open, catalog.status])

      if (scope === null) {
        return h('div', { style: css.card }, h('span', { style: css.error }, 'settingsScope 服务不可用'))
      }
      const snap = scope.getSnapshot()
      const value = snap.value || {}
      const summary = `${value.provider ?? '…'}/${value.model ?? '…'}`

      const children = [
        h('button', {
          key: 'header',
          style: css.header,
          'aria-expanded': open,
          onClick: () => setOpen(!open),
        },
          h('span', { style: css.title }, '顾问（规划前咨询）'),
          h('span', { style: css.summary }, summary),
          h('span', { style: css.chevron }, open ? '▾' : '▸'),
        ),
      ]

      if (open) {
        if (snap.status === 'loading') {
          children.push(h('div', { key: 'body', style: css.body }, h('span', { style: css.status }, '读取顾问设置…')))
        } else if (snap.status === 'unavailable') {
          children.push(h('div', { key: 'body', style: css.body },
            h('span', { style: css.error }, 'advisor 设置命名空间未向浏览器暴露（插件未挂载或目录注册失败）。')))
        } else {
          const user = snap.user && typeof snap.user === 'object' ? snap.user : {}
          const overridden = (key) => Object.prototype.hasOwnProperty.call(user, key)
          const anyOverride = ['provider', 'model', 'maxTokens', 'allowWebSearch', 'guidanceEnabled'].some(overridden)
          const resetAll = () => {
            setError('')
            for (const key of ['provider', 'model', 'maxTokens', 'allowWebSearch', 'guidanceEnabled']) {
              if (overridden(key)) {
                Promise.resolve(scope.unset(key)).catch((err) => {
                  setError(err && err.message ? err.message : String(err))
                })
              }
            }
          }

          const groups = catalog.status === 'ready' ? catalog.groups : []
          const providerOptions = groups.map((group) => ({
            value: group.id,
            label: group.displayName || group.name || group.id,
          }))
          const selectedGroup = groups.find((group) => group.id === value.provider)
          const modelOptions = selectedGroup && Array.isArray(selectedGroup.models)
            ? selectedGroup.models.map((model) => ({
                value: model.id,
                label: model.name ? `${model.name}（${model.id}）` : model.id,
              }))
            : []
          const catalogNote = catalog.status === 'loading'
            ? '正在加载模型目录…'
            : catalog.status === 'unavailable'
              ? '模型目录不可用，请直接输入路由/模型 id。'
              : null

          children.push(h('div', { key: 'body', style: css.body },
            h('span', { style: css.desc },
              'ask_advisor 工具使用的第二模型：规划前提供思路、领域知识与陷阱，不输出步骤。改动即刻生效，无需重启。'),
            providerOptions.length > 0
              ? h(SelectField, {
                  key: 'provider', fieldKey: 'provider', label: '提供方路由', value: value.provider,
                  options: providerOptions, writable: snap.writable, setError,
                  desc: '须是「设置 → 模型」中已注册的 provider 路由。',
                  overridden: overridden('provider'),
                })
              : h(SelectField, {
                  key: 'provider', fieldKey: 'provider', label: '提供方路由', value: value.provider,
                  options: [{ value: value.provider ?? '', label: value.provider || '（未选择）' }],
                  writable: false, setError,
                  desc: catalogNote || '模型目录为空。',
                  overridden: overridden('provider'),
                }),
            modelOptions.length > 0
              ? h(SelectField, {
                  key: 'model', fieldKey: 'model', label: '顾问模型', value: value.model,
                  options: modelOptions, writable: snap.writable, setError,
                  desc: '与主模型跨家族时多样性收益最大。',
                  overridden: overridden('model'),
                })
              : h(SelectField, {
                  key: 'model', fieldKey: 'model', label: '顾问模型', value: value.model,
                  options: [{ value: value.model ?? '', label: value.model || '（未选择）' }],
                  writable: false, setError,
                  desc: catalogNote || '所选路由下没有目录模型。',
                  overridden: overridden('model'),
                }),
            catalogNote && providerOptions.length > 0
              ? h('span', { style: css.status }, catalogNote)
              : null,
            h(NumberField, {
              key: 'maxTokens', label: '输出上限（tokens）', value: value.maxTokens,
              min: 256, max: 32768, writable: snap.writable, setError,
              desc: '顾问单次回答的长度上限。',
              overridden: overridden('maxTokens'),
            }),
            TOGGLE_FIELDS.map((field) =>
              h(CheckField, {
                key: field.key, field, value: value[field.key],
                overridden: overridden(field.key), writable: snap.writable, setError,
              })),
            h('div', { style: css.footer },
              h('button', { style: css.button, disabled: !anyOverride || !snap.writable, onClick: resetAll }, '全部重置为默认'),
              h('span', { style: css.status }, snap.writable ? '改动即时保存' : '当前设置为只读'),
            ),
            error === '' ? null : h('span', { style: css.error }, error),
          ))
        }
      }

      return h('div', { style: css.card }, children)
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
