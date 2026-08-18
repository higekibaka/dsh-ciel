// dsh-advisor browser half: the Settings → Plugins → 插件配置 card editing the
// `advisor` settings namespace owned by the host half. Self-contained by hand
// (no bundler): the client module system wraps this file in a CJS factory and
// the kernel adopts { apply, inject } as a client plugin.
//
// The card writes through the client settings scope: every commit is fenced
// by the namespace revision, and the host remains the only authority on
// whether a value was accepted — the card re-reads the snapshot after writes
// and shows the last accepted values.

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

    const css = {
      card: {
        border: '1px solid var(--border, #3a3a3a)',
        borderRadius: '8px',
        padding: '12px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      },
      title: { fontWeight: 600, fontSize: '14px' },
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

    const FIELDS = [
      { key: 'provider', label: '提供方路由', kind: 'text', placeholder: 'kimi-coding', desc: '须是「设置 → 模型」中已注册的 provider 路由。' },
      { key: 'model', label: '顾问模型', kind: 'text', placeholder: 'kimi-for-coding', desc: '模型 id；与主模型跨家族时多样性收益最大。' },
      { key: 'maxTokens', label: '输出上限（tokens）', kind: 'number', min: 256, max: 32768, desc: '顾问单次回答的长度上限。' },
      { key: 'allowWebSearch', label: '允许顾问联网搜索', kind: 'checkbox', desc: '开启后顾问可使用 web_search 查证；关闭为纯参数知识。' },
      { key: 'guidanceEnabled', label: '注入使用协议到系统提示词', kind: 'checkbox', desc: '触发判据与追问预算；改动即刻生效（影响提示词前缀）。' },
    ]

    function commit(key, value, setError) {
      Promise.resolve(scope.set(key, value)).catch((error) => {
        setError(error && error.message ? error.message : String(error))
      })
    }

    function TextField({ field, value, overridden, writable, setError }) {
      const [draft, setDraft] = useState(value === undefined || value === null ? '' : String(value))
      useEffect(() => {
        setDraft(value === undefined || value === null ? '' : String(value))
      }, [value])
      const flush = () => {
        if (field.kind === 'number') {
          if (draft.trim() === '') return
          const parsed = Number(draft)
          if (!Number.isFinite(parsed)) {
            setError(`${field.label} 必须是数字`)
            return
          }
          const clamped = Math.round(parsed)
          if (clamped < field.min || clamped > field.max) {
            setError(`${field.label} 须在 ${field.min}–${field.max} 之间`)
            return
          }
          if (clamped !== value) commit(field.key, clamped, setError)
          return
        }
        if (draft !== (value ?? '')) commit(field.key, draft, setError)
      }
      return h('label', { style: css.field },
        h('span', { style: css.labelRow },
          h('span', null, field.label),
          overridden ? h('span', { style: css.overridden }, '已覆盖') : null,
        ),
        h('input', {
          style: css.input,
          value: draft,
          placeholder: field.placeholder,
          disabled: !writable,
          inputMode: field.kind === 'number' ? 'numeric' : undefined,
          onChange: (event) => setDraft(event.target.value),
          onBlur: flush,
          onKeyDown: (event) => {
            if (event.key === 'Enter') event.target.blur()
          },
        }),
        field.desc ? h('span', { style: css.desc }, field.desc) : null,
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
          overridden ? h('span', { style: css.overridden }, '已覆盖') : null,
        ),
        field.desc ? h('span', { style: css.desc }, field.desc) : null,
      )
    }

    function AdvisorCard() {
      const [, setTick] = useState(0)
      const [error, setError] = useState('')
      useEffect(() => {
        if (scope === null) return undefined
        return scope.subscribe(() => setTick((tick) => tick + 1))
      }, [])
      if (scope === null) {
        return h('div', { style: css.card }, h('span', { style: css.error }, 'settingsScope 服务不可用'))
      }
      const snap = scope.getSnapshot()
      if (snap.status === 'loading') {
        return h('div', { style: css.card }, h('span', { style: css.status }, '读取顾问设置…'))
      }
      if (snap.status === 'unavailable') {
        return h('div', { style: css.card },
          h('span', { style: css.error }, 'advisor 设置命名空间未向浏览器暴露（插件未挂载或目录注册失败）。'))
      }
      const value = snap.value || {}
      const user = snap.user && typeof snap.user === 'object' ? snap.user : {}
      const overridden = (key) => Object.prototype.hasOwnProperty.call(user, key)
      const anyOverride = FIELDS.some((field) => overridden(field.key))
      const resetAll = () => {
        setError('')
        for (const field of FIELDS) {
          if (overridden(field.key)) {
            Promise.resolve(scope.unset(field.key)).catch((err) => {
              setError(err && err.message ? err.message : String(err))
            })
          }
        }
      }
      return h('div', { style: css.card },
        h('span', { style: css.title }, '顾问（规划前咨询）'),
        h('span', { style: css.desc },
          'ask_advisor 工具使用的第二模型：规划前提供思路、领域知识与陷阱，不输出步骤。改动即刻生效，无需重启。'),
        FIELDS.map((field) =>
          field.kind === 'checkbox'
            ? h(CheckField, {
                key: field.key, field, value: value[field.key],
                overridden: overridden(field.key), writable: snap.writable, setError,
              })
            : h(TextField, {
                key: field.key, field, value: value[field.key],
                overridden: overridden(field.key), writable: snap.writable, setError,
              }),
        ),
        h('div', { style: css.footer },
          h('button', { style: css.button, disabled: !anyOverride || !snap.writable, onClick: resetAll }, '全部重置为默认'),
          h('span', { style: css.status }, snap.writable ? '改动即时保存' : '当前设置为只读'),
        ),
        error === '' ? null : h('span', { style: css.error }, error),
      )
    }

    function apply(ctx) {
      scope = ctx.settingsScope.bind({ namespace: 'advisor' })
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
