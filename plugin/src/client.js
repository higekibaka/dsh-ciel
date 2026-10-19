import { ADVISOR_REMOTE } from '../advisor-protocol.js'
import { createCielSidebar } from './sidebar.js'
import { advisorJevPanel, advisorJevSummary } from './advisor-jev.js'
import { JEV_MODEL, JEV_ENDPOINT, validJevEndpoint, validJevModel, validJevKey } from '../jev-config.js'
import SIDEBAR_CSS from './sidebar.css'
import SETTINGS_CSS from './settings.css'

// dsh-ciel browser half: a dedicated Settings → 夏尔 Ciel page editing the
// existing `ciel` namespace. Local controls use the host theme tokens.
// The hand-written module factory remains the package's browser artifact.
//
// The dedicated page retains staged edits with one atomic Save, per-field
// override/reset, and revision fencing. Its plugin-owned draft survives
// navigation; model groups retain their original folding and selectors.
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

    // Keep these small controls local: the host palette is the only UI dependency.
    function Switch({ id, checked, onChange, label, disabled = false, title }) {
      return h('button', { id, type: 'button', role: 'switch', 'aria-checked': checked,
        'aria-label': label, title, disabled, className: 'ciel-switch',
        onClick: () => { if (!disabled) onChange(!checked) } }, h('span', { className: 'ciel-switch-thumb' }))
    }
    function Tag({ tone = 'outline', className = '', children }) {
      return h('span', { className: 'ciel-tag ' + className, 'data-tone': tone }, children)
    }
    function Button({ variant = 'ghost', size = 'md', icon, className = '', children, ...rest }) {
      return h('button', { type: 'button', ...rest, className: 'ciel-button ciel-button-' + variant + ' ciel-button-' + size + ' ' + className },
        icon == null ? null : h('span', { className: 'ciel-button-icon', 'aria-hidden': true }, icon), children)
    }

    // Navigation is a filled, full-size action, not a readonly status chip.
    const navigationButton = (props, label) => h(Button, {
      type: 'button',
      variant: 'primary', size: 'md', icon: h('span', { 'aria-hidden': true }, '→'),
      'data-ciel-action': '',
      ...props,
    }, label)

    /** Bound in apply() before the card registers. */
    let scope = null
    let settingsDescribe = null
    let sidebar = null
    /** Lazy remote readers: a hard inject would park the card's registration. */
    let getSessionRemote = () => undefined
    let getRemote = () => undefined
    /** Client cordis event subscription, bound in apply(). */
    let clientOn = null
    /** Exact invocation lookup for historical model-usage records and tool metadata. */
    let readCallModelUsage = async () => null
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
      advisorJevEnabled: false,
      jevApiKey: '',
      jevEndpoint: JEV_ENDPOINT,
      jevModel: JEV_MODEL,
      enabled: true,
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
        kind: 'check', key: 'enabled', label: '启用 Ciel',
        hint: '关闭并保存后，停止顾问咨询（ask_advisor），并取消正在进行的 Ciel 请求；既有结果仍可查看。重新开启也须保存。',
      },
      {
        kind: 'group', key: 'common', label: '常用设置', defaultOpen: true,
        summarize: (staged) => `每回合最多 ${staged.maxCallsPerTurn} 次 · 最多 ${staged.advisorTimeoutSeconds} 秒`,
        children: [
          { kind: 'check', key: 'advisorJevEnabled', label: '启用顾问建议检查（Jev）', hint: '顾问回答后，把本次问题、背景和建议发给 TypeSafe 对照检查，产生额外 API 用量。默认关闭；仅检查背景一致性，不独立查证事实。结果一起返回主模型并保存在顾问详情；最多额外等待10秒，计入咨询总时限。密钥在下方 Jev API 配置中填写；关闭并保存会取消在途检查。' },
          { kind: 'number', key: 'maxCallsPerTurn', label: '每个代理回合最多咨询几次', min: MAX_CALLS_MIN, max: MAX_CALLS_MAX, hint: '限制主代理在一个实际 turn（代理回合）内调用 ask_advisor 的次数，包含追问；不等于一个语义上的规划阶段。咨询太频繁时调低，需要更多追问时调高；超过后会拒绝调用。' },
          { kind: 'number', key: 'advisorTimeoutSeconds', label: '顾问最多等多久（秒）', min: 10, max: 600, hint: '一次 ask_advisor 从开始到结束的总等待时间；经常等不到回复时可调高，想更快结束等待时调低。超时会中断，不是费用上限，已发生的调用仍可能计费。' },
        ],
      },
      {
        kind: 'group', key: 'jevApi', label: 'Jev API 配置', defaultOpen: true,
        summarize: staged => staged.jevModel,
        children: [
          { kind: 'secret', key: 'jevApiKey', label: 'Jev API Key', hint: '留空保留原值；输入新值会替换。清除覆盖后继承部署配置，未配置时仅官方接口回退到 TYPESAFE_API_KEY。密钥保存在本机 DSH 配置（不是加密保险库），不回传原值；草稿只留在当前页面内存。' },
          { kind: 'text', key: 'jevEndpoint', label: 'Jev 接口地址', fallback: JEV_ENDPOINT, hint: '完整 HTTPS 地址（含 /v1/systemone 或代理对应路径），不会自动追加路径；必须兼容 TypeSafe systemone 协议，不是 OpenAI 接口。自定义地址将收到 API Key 和检查原文，请只填写可信服务；不自动发送环境变量密钥。不允许 URL 内凭据、查询参数、片段或重定向。' },
          { kind: 'text', key: 'jevModel', label: 'Jev 模型 ID', fallback: JEV_MODEL, hint: '默认 jev-1.13.0，可填写接口支持的其他模型 ID；不经过「设置 → 模型」路由。保存后下一次 Jev 检查使用，正在进行的请求不变。' },
        ],
      },
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
        ],
      },
      {
        kind: 'group', key: 'advanced', label: '高级设置（通常保持默认）', defaultOpen: false,
        summarize: () => '回答长度与咨询提醒',
        children: [
          { kind: 'number', key: 'maxTokens', label: '顾问每次请求最多输出多少（tokens）', min: MAX_TOKENS_MIN, max: MAX_TOKENS_MAX, hint: 'tokens 是模型的文本计量单位，不等于汉字数。顾问回复经常被截断时可调高；这是每次模型请求的输出长度上限，不是整次咨询的费用上限。' },
          { kind: 'check', key: 'requireExploration', label: '首次咨询前先了解现场', hint: '开启后，本会话第一次 ask_advisor 之前必须先用过一次其他工具，例如读取、搜索或运行命令；否则拒绝咨询。只在确实不需要先查现场时关闭；这项检查不判断查得是否充分。' },
          { kind: 'check', key: 'enforceFollowupGap', label: '再次咨询前先做一点工作', hint: '开启后，同一代理回合内两次 ask_advisor 之间须至少调用一次其他工具；否则拒绝追问。想避免连续空问时保持开启，确需连续讨论时才关闭。' },
          { kind: 'check', key: 'planReminderEnabled', label: '开始规划时提醒咨询顾问', hint: '主代理本回合尚未咨询、但调用 todo_write 或 exit_plan_mode 时，下一步提醒一次。它不判断任务是否需要顾问，也不自动咨询；觉得提醒多余时可关闭。' },
          { kind: 'check', key: 'guidanceEnabled', label: '向主代理说明何时使用顾问', hint: '保存后，在系统提示中提供咨询时机、先查事实和追问规则。通常保持开启；已有自己的同类提示时可关闭以减少重复。关闭只移除这段说明，不会停用 Ciel 或取消其他限制。' },
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

    function createSettingsEditor() {
      const initial = () => ({ drafts: null, resets: {}, revision: undefined, saving: false, saveFailed: false, catalog: { status: 'idle', groups: [] }, groupClosed: { ...INITIAL_CLOSED_GROUPS } })
      let state = initial(), active = true
      const listeners = new Set()
      return {
        get: (key) => state[key],
        set(key, next) {
          if (!active) return
          const value = typeof next === 'function' ? next(state[key]) : next
          if (Object.is(value, state[key])) return
          state = { ...state, [key]: value }
          for (const listener of listeners) listener()
        },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        dispose() { active = false; listeners.clear(); state = initial() },
      }
    }
    let settingsEditor = createSettingsEditor()
    function useSettingsField(key) {
      const editor = settingsEditor
      const [, tick] = useState(0)
      useEffect(() => editor.subscribe(() => tick((n) => n + 1)), [editor])
      return [editor.get(key), (next) => editor.set(key, next)]
    }

    const css = {
      card: {
        listStyle: 'none',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '12px',
        background: 'var(--dsw-alias-bg-layer-3)',
        transition: 'border-color .16s, background .16s',
      },
      body: { padding: '0 16px 8px' },
      readOnly: { margin: '12px 0 0', fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
      field: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px 0' },
      fieldBorder: { borderTop: '1px solid var(--dsw-alias-border-l2)' },
      head: { display: 'flex', alignItems: 'center', gap: '8px' },
      label: { flex: 1, minWidth: 0, fontSize: '13px', fontWeight: 500, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)' },
      badges: { display: 'inline-flex', alignItems: 'center', gap: '8px' },
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
    function FieldHead({ htmlFor, label, overridden, disabled, onReset }) {
      return h('div', { style: css.head, 'data-ciel-setting-head': '' },
        h(htmlFor ? 'label' : 'span', { htmlFor, style: css.label }, label),
        overridden
          ? h('span', { style: css.badges },
              h(Tag, { tone: 'neutral' }, '已覆盖'),
              h('button', { type: 'button', className: 'ciel-reset-button', disabled, onClick: onReset, 'aria-label': `重置${label}`, title: `重置${label}` }, '重置'))
          : null,
      )
    }

    const SHORT_HINTS = {
      enabled: '保存后生效；停用时已有结果仍可查看。',
      advisorJevEnabled: '独立检查建议与本次背景是否一致；会产生额外 API 用量。',
      maxCallsPerTurn: '每个代理回合最多咨询次数，包含追问。',
      advisorTimeoutSeconds: '等待上限，不是费用上限。',
    }
    function settingHelp(key, hint, brief) {
      const short = brief || SHORT_HINTS[key]
      return h('div', { id: 'ciel-setting-hint-' + key, 'data-ciel-setting-help': '' },
        short ? h('p', { style: css.hint }, short) : null,
        short ? h('details', {}, h('summary', {}, '详细说明'), h('p', {}, hint)) : h('p', { style: css.hint }, hint))
    }
    function hasSettingsDraft() {
      const draft = settingsEditor.get('drafts')
      if (!draft) return false
      const snapshot = scope?.getSnapshot?.()
      if (snapshot?.status !== 'ready') return true
      const resets = settingsEditor.get('resets')
      return FIELD_KEYS.some(key => {
        if (resets[key]) return true
        const def = FIELD_DEF_BY_KEY[key], value = snapshot.value?.[key]
        if (def.kind === 'secret') return Boolean(draft[key])
        if (def.kind === 'number') return String(draft[key]).trim() === '' || Number(draft[key]) !== value
        return def.kind === 'check' ? draft[key] !== Boolean(value) : draft[key] !== String(value ?? def.fallback ?? '')
      })
    }
    function SettingsDraftNotice() {
      useSettingsField('drafts'); useSettingsField('resets')
      return hasSettingsDraft() ? h(Tag, { tone: 'warning' }, 'Ciel 草稿未保存') : null
    }

    function CielSettingsSection() {
      const [, setTick] = useState(0)
      const editor = settingsEditor
      const [drafts, setDrafts] = useSettingsField('drafts')
      const [resets, setResets] = useSettingsField('resets')
      const [saving, setSaving] = useSettingsField('saving')
      const [saveFailed, setSaveFailed] = useSettingsField('saveFailed')
      const [catalog, setCatalog] = useSettingsField('catalog')
      const [groupClosed, setGroupClosed] = useSettingsField('groupClosed')

      useEffect(() => {
        if (scope === null) return undefined
        return scope.subscribe(() => setTick((tick) => tick + 1))
      }, [])

      // Load the catalog on page entry, retained across navigation. Source:
      // `session.modelCatalog` Remote (ClientResult envelope), successor of
      // the removed `connection.api.llm.models` RPC — same groups shape the
      // shipped Subagent card consumes. A failed load is NOT latched: the
      // hint offers a retry that re-stages 'idle'.
      useEffect(() => {
        if (catalog.status !== 'idle') return
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
      }, [catalog.status])

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
      if (snap.status !== 'ready') return h('section', { 'aria-label': '夏尔 Ciel' },
        h('h2', { style: { marginTop: 0 } }, '夏尔 Ciel'),
        h('p', { role: 'status' }, snap.status === 'loading' ? '正在加载 Ciel 设置…' : 'Ciel 设置暂不可用，请检查连接或插件状态。'))
      const value = snap.value || {}
      const section = settingsDescribe?.getSnapshot?.().view?.namespaces?.find(row => row.ns === 'advisor')
      const secretSlot = (section?.secrets || snap.secrets)?.find(row => row.path?.length === 1 && row.path[0] === 'jevApiKey')
      const jevSettingsReady = secretSlot !== undefined && typeof value.jevEndpoint === 'string' && typeof value.jevModel === 'string'
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
        advisorJevEnabled: Boolean(value.advisorJevEnabled ?? false),
        jevApiKey: '', // Never copy a saved secret (even from a legacy snapshot).
        jevEndpoint: String(value.jevEndpoint ?? JEV_ENDPOINT),
        jevModel: String(value.jevModel ?? JEV_MODEL),
        enabled: Boolean(value.enabled ?? true),
        advisorTimeoutSeconds: String(value.advisorTimeoutSeconds ?? ''),
      }
      // Pristine pages follow the latest snapshot; first edit captures the
      // revision. Unsaved drafts live in the plugin-owned editor, not this mount.
      const startDraft = () => { if (editor.get('drafts') === null) editor.set('revision', snap.revision) }

      /** Parse/validate one number descriptor against the staged draft. */
      const numState = (def) => {
        const parsed = Number(staged[def.key])
        const invalid = staged[def.key].trim() === ''
          || !Number.isInteger(parsed)
          || parsed < def.min
          || parsed > def.max
        return { parsed, invalid }
      }

      const textInvalid = key => key === 'jevEndpoint' ? !validJevEndpoint(staged[key])
        : key === 'jevModel' ? !validJevModel(staged[key])
          : key === 'jevApiKey' && Boolean(staged[key]) && !validJevKey(staged[key])
      const dirtyKey = (key) => {
        if (resets[key]) return true
        const def = FIELD_DEF_BY_KEY[key]
        if (def && def.kind === 'number') {
          const { parsed, invalid } = numState(def)
          return invalid ? String(staged[key]) !== String(value[key] ?? '') : parsed !== value[key]
        }
        if (def && def.kind === 'check') return staged[key] !== Boolean(value[key])
        if (def && def.kind === 'secret') return Boolean(staged[key])
        return staged[key] !== String(value[key] ?? (def && def.fallback) ?? '')
      }
      const dirty = FIELD_KEYS.some(dirtyKey)

      const edit = (key, next) => {
        startDraft()
        const changes = { [key]: next }
        if (key === 'provider') {
          const group = catalog.groups?.find(group => group.id === next)
          if (Array.isArray(group?.models) && group.models.length > 0) {
            changes.model = group.models[0].id
            changes.reasoningEffort = 'provider'
          }
        }
        setDrafts({ ...staged, ...changes })
        if (Object.keys(changes).some(changed => resets[changed])) {
          const rest = { ...resets }
          for (const changed of Object.keys(changes)) delete rest[changed]
          setResets(rest)
        }
        setSaveFailed(false)
      }
      const resetField = (key) => {
        startDraft()
        const next = FIELD_DEF_BY_KEY[key].kind === 'number' ? String(DEFAULTS[key]) : DEFAULTS[key]
        setDrafts({ ...staged, [key]: next })
        setResets({ ...resets, [key]: true })
        setSaveFailed(false)
      }
      const discard = () => {
        editor.set('revision', undefined)
        setDrafts(null)
        setResets({})
        setSaveFailed(false)
      }
      const invalidField = key => {
        const def = FIELD_DEF_BY_KEY[key]
        return (def.kind === 'number' && numState(def).invalid)
          || (def.kind === 'paths' && pathsState(key).invalid) || textInvalid(key)
          || (['jevApiKey', 'jevEndpoint', 'jevModel'].includes(key) && !jevSettingsReady && dirtyKey(key))
      }
      const save = async () => {
        if (editor.get('saving') || !snap.writable || FIELD_KEYS.some(invalidField)) return
        setSaving(true)
        setSaveFailed(false)
        try {
          const revision = editor.get('revision')
          if (revision !== undefined && scope.getSnapshot().revision !== revision) throw new Error('settings revision changed')
          const ops = []
          for (const key of FIELD_KEYS) {
            if (resets[key]) {
              ops.push({ op: 'unset', path: [key] })
            } else if (dirtyKey(key)) {
              const def = FIELD_DEF_BY_KEY[key]
              const parsed = def && def.kind === 'number' ? numState(def).parsed : undefined
              ops.push({ op: 'set', path: [key], value: parsed !== undefined ? parsed : staged[key] })
            }
          }
          // One explicit Save, one atomic namespace operation; never save on
          // navigation or a Switch click, and never overwrite a newer snapshot.
          if (ops.length > 0 && await scope.mutate(ops, revision) === false) throw new Error('settings write refused')
          editor.set('revision', undefined)
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
      // when the catalog advertises them (adapter-supplied names, and the
      // model's own default marked); otherwise the full host-schema set
      // stays offered so the field remains usable without the catalog.
      // 跟随提供方默认 leaves the advisor request's reasoning setting untouched.
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

      const selectStyle = { ...css.input, appearance: 'auto' }

      /** One dropdown or text fallback field for provider/model. */
      const routeField = (key, label, hint, options) => {
        const fieldId = 'ciel-setting-' + key
        const selectOptions = options.some((option) => option.value === staged[key])
          ? options
          : [...options, { value: staged[key], label: `${staged[key]}（自定义）` }]
        return h('div', { key, 'data-ciel-setting': key, 'data-ciel-setting-kind': 'route', style: { ...css.field, ...css.fieldBorder } },
          h(FieldHead, {
            htmlFor: fieldId,
            label,
            overridden: overridden(key) && !resets[key],
            disabled,
            onReset: () => resetField(key),
          }),
          options.length > 0
            ? h('select', {
                id: fieldId,
                style: selectStyle,
                value: staged[key],
                'aria-describedby': 'ciel-setting-hint-' + key,
                disabled,
                onChange: (event) => edit(key, event.target.value),
              }, selectOptions.map((option) =>
                h('option', { key: option.value, value: option.value }, option.label)))
            : h('input', {
                id: fieldId,
                style: css.input,
                type: 'text',
                value: staged[key],
                'aria-describedby': 'ciel-setting-hint-' + key,
                disabled,
                onChange: (event) => edit(key, event.target.value),
              }),
          h('p', { id: 'ciel-setting-hint-' + key, style: css.hint },
            catalog.status === 'loading'
              ? '正在加载模型目录（与「设置 → 模型」同源）…'
              : catalog.status === 'unavailable'
                ? h(React.Fragment, null,
                    '模型目录不可用，请直接输入 id。',
                    h('button', {
                      type: 'button',
                      className: 'ciel-reset-button',
                      disabled,
                      'aria-label': '重试加载模型目录',
                      title: '重试加载模型目录',
                      onClick: () => setCatalog({ status: 'idle', groups: [] }),
                    }, '重试'),
                    ' ',
                    hint)
                : hint),
        )
      }

      const checkField = (key, label, hint) => {
        const fieldId = 'ciel-setting-' + key
        return h('div', { key, 'data-ciel-setting': key, 'data-ciel-setting-kind': 'check', style: { ...css.field, ...(key === 'enabled' ? {} : css.fieldBorder) } },
          h(FieldHead, {
            htmlFor: fieldId,
            label,
            overridden: overridden(key) && !resets[key],
            disabled,
            onReset: () => resetField(key),
          }),
          h('div', { style: css.checkRow, 'data-ciel-setting-control': '', role: 'group', 'aria-describedby': 'ciel-setting-hint-' + key },
            h(Switch, {
              id: fieldId,
              label,
              title: hint,
              checked: Boolean(staged[key]),
              disabled,
              onChange: (next) => edit(key, next),
            }),
            dirtyKey(key) ? h(Tag, { tone: 'warning' }, '待保存 · ' + (Boolean(staged[key]) ? '已开启' : '已关闭')) : null,
          ),
          settingHelp(key, hint),
        )
      }

      /** The reasoning-effort dropdown: always a select, options track the model. */
      const effortField = (key, label, opts, hintReady, hintFallback) => {
        const fieldId = 'ciel-setting-' + key
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
            htmlFor: fieldId,
            label,
            overridden: overridden(key) && !resets[key],
            disabled,
            onReset: () => resetField(key),
          }),
          h('select', {
            id: fieldId,
            style: selectStyle,
            value: staged[key],
            'aria-describedby': 'ciel-setting-hint-' + key,
            disabled,
            onChange: (event) => edit(key, event.target.value),
          }, options.map((option) =>
            h('option', { key: option.value, value: option.value }, option.label))),
          h('p', { id: 'ciel-setting-hint-' + key, style: css.hint }, hint),
        )
      }

      const textField = ({ key, label, hint, kind, fallback }) => {
        const fieldId = 'ciel-setting-' + key
        const secret = kind === 'secret', invalid = textInvalid(key)
        return h('div', { key, 'data-ciel-setting': key, style: { ...css.field, ...css.fieldBorder } },
          h(FieldHead, { htmlFor: fieldId, label, overridden: !secret && overridden(key) && !resets[key], disabled: disabled || !jevSettingsReady, onReset: () => resetField(key) }),
          h('input', { id: fieldId, style: css.input, type: secret ? 'password' : 'text', value: staged[key],
            'aria-invalid': invalid, 'aria-describedby': 'ciel-setting-hint-' + key,
            autoComplete: secret ? 'new-password' : 'off', spellCheck: false,
            placeholder: secret ? '留空保留；输入以替换' : fallback,
            disabled: disabled || !jevSettingsReady, onChange: event => edit(key, event.target.value) }),
          secret ? h('p', { role: 'status', style: css.hint }, !jevSettingsReady ? '宿主尚未提供 Jev API 安全配置，请更新并重启 DSH 后刷新页面。'
            : resets[key] ? '待保存：清除密钥覆盖' : staged[key] ? '待保存：替换密钥'
              : secretSlot.set ? '已配置密钥（原值不回传）' : '未在设置中配置；官方接口将尝试环境变量，是否可用由检查结果确认。') : null,
          secret ? h('button', { type: 'button', className: 'ciel-reset-button', disabled: disabled || !jevSettingsReady || resets[key], onClick: () => resetField(key), 'aria-label': `清除${label}覆盖`, title: `清除${label}覆盖` }, '清除密钥覆盖') : null,
          !secret && key === 'jevEndpoint' && staged[key] !== JEV_ENDPOINT ? h('p', { role: 'status', style: css.hint }, '自定义服务将收到密钥和原文；请另填该服务的 API Key。') : null,
          invalid ? h('p', { role: 'alert', style: css.hint }, secret ? '密钥须为 1–4096 个可打印 ASCII 字符，不含空白。'
            : key === 'jevEndpoint' ? '请输入完整 HTTPS 地址，不含凭据、查询参数或片段。' : '请输入 1–128 位模型 ID（字母、数字、点、下划线、冒号、斜杠或连字符）。') : null,
          settingHelp(key, hint))
      }

      /** One validated numeric input, driven by its descriptor. */
      const numberField = (def) => {
        const fieldId = 'ciel-setting-' + def.key
        const { invalid } = numState(def)
        return h('div', { key: def.key, 'data-ciel-setting': def.key, 'data-ciel-setting-kind': 'number', style: { ...css.field, ...css.fieldBorder } },
          h(FieldHead, {
            htmlFor: fieldId,
            label: def.key === 'advisorTimeoutSeconds' ? '顾问时限（秒）' : def.label,
            overridden: overridden(def.key) && !resets[def.key],
            disabled,
            onReset: () => resetField(def.key),
          }),
          h('input', {
            id: fieldId,
            style: invalid ? { ...css.input, ...css.inputInvalid } : css.input,
            type: 'text',
            inputMode: 'numeric',
            value: staged[def.key],
            'aria-describedby': 'ciel-setting-hint-' + def.key,
            disabled,
            'aria-invalid': invalid || undefined,
            placeholder: String(DEFAULTS[def.key] ?? ''),
            onChange: (event) => edit(def.key, event.target.value),
          }),
          invalid ? h('p', { id: 'ciel-setting-hint-' + def.key, 'data-ciel-setting-help': '', style: css.invalidText, role: 'alert' }, `须是 ${def.min}–${def.max} 之间的整数`) : settingHelp(def.key, def.hint),
        )
      }

      const ROUTE_OPTIONS = { provider: providerOptions, model: modelOptions }
      const EFFORT_OPTS = { advisor: advisorEffort }

      /** Dirty check across a group's whole descendant leaf set. */
      const groupDirty = (def) => def.children.some((child) =>
        child.kind === 'group' ? groupDirty(child) : dirtyKey(child.key))

      /** The card body: one recursive renderer dispatch over FIELD_DEFS. */
      const renderField = (def, depth) => {
        if (def.kind === 'group') {
          const open = groupClosed[def.key] !== true
          const bodyId = 'ciel-group-' + def.key
          return h('section', { key: def.key, 'data-ciel-settings-group': def.key },
            h('button', {
              type: 'button', 'data-ciel-settings-group-head': '', 'aria-expanded': open, 'aria-controls': bodyId,
              onClick: () => setGroupClosed({ ...groupClosed, [def.key]: open }),
            }, h(Chevron, { open }), h('strong', {}, def.label),
            groupDirty(def) ? h(Tag, { tone: 'warning' }, '未保存') : null,
            open ? null : h('span', { 'data-ciel-settings-group-summary': '' }, def.summarize(staged))),
            open ? h('div', { id: bodyId, 'data-ciel-settings-group-body': '' }, ...def.children.map(child => renderField(child, depth + 1))) : null)
        }
        const el = def.kind === 'route' ? routeField(def.key, def.label, def.hint, ROUTE_OPTIONS[def.options])
          : def.kind === 'effort' ? effortField(def.key, def.label, EFFORT_OPTS[def.opts], def.hintReady, def.hintFallback)
            : def.kind === 'check' ? checkField(def.key, def.label, def.hint)
                : def.kind === 'text' || def.kind === 'secret' ? textField(def)
                  : numberField(def)
        return el
      }

      const blocked = !dirty || FIELD_KEYS.some(invalidField) || saving

      return h('section', { 'aria-label': '夏尔 Ciel', 'data-ciel-settings': '' },
        h('header', { 'data-ciel-settings-header': '' },
          h('div', {}, h('div', { 'data-ciel-settings-heading': '' }, h('h2', {}, '夏尔 Ciel'),
            h(Tag, { tone: value.enabled === false ? 'neutral' : 'success' }, value.enabled === false ? '当前已停用' : '当前已启用')),
            h('p', { 'data-ciel-settings-subtitle': '' }, '顾问提供方向、先例、陷阱与验证目标。')),
          h('div', { 'data-ciel-settings-enabled': '' }, renderField(FIELD_DEFS[0], 0))),
        h('p', { 'data-ciel-settings-notice': '' }, !snap.writable ? '当前设置为只读。' : dirty
          ? '草稿尚未保存。切换设置页或关闭此窗口仍会保留；保存后才生效。'
          : '以下修改均在点击「保存」后生效；恢复默认值也需要保存。'),
        h('div', { 'data-ciel-settings-groups': '' }, ...FIELD_DEFS.slice(1).map(def => renderField(def, 0))),
        h('footer', { 'data-ciel-settings-footer': '', 'data-dirty': dirty, 'aria-label': '设置保存操作' },
          saveFailed ? h('p', { 'data-ciel-settings-footer-error': '', role: 'status' }, '保存未确认，草稿已保留。配置可能已在别处更新，请核对后重试或放弃草稿。') : null,
          h('span', { 'data-ciel-settings-footer-status': '', role: 'status' }, saving ? '正在保存…' : blocked && dirty ? '请先修正无效设置' : dirty ? FIELD_KEYS.filter(dirtyKey).length + ' 项未保存的修改' : '没有未保存的修改'),
          h('div', { 'data-ciel-settings-footer-actions': '' },
            h(Button, { type: 'button', variant: 'toolbar', size: 'md', disabled: (!dirty && !saveFailed) || saving, title: (!dirty && !saveFailed) ? '没有需要放弃的修改' : saving ? '正在保存中' : undefined, onClick: discard }, '放弃'),
          h(Button, { type: 'button', variant: 'primary', size: 'md', disabled: blocked || !snap.writable, title: blocked && dirty ? '请先修正无效设置' : !dirty ? '没有需要保存的修改' : !snap.writable ? '当前设置为只读' : undefined, onClick: save }, saving ? '保存中…' : '保存'))))

    }

    // Only recorded invocation facts belong on historical cards. Never consult
    // settings here: requested is not proof of execution, and older records may
    // have no model provenance at all.
    function modelUsageLabel(modelUsage) {
      const route = (value) => value && typeof value.provider === 'string' && value.provider !== ''
        && typeof value.model === 'string' && value.model !== ''
        ? value.provider + ' / ' + value.model : null
      const used = modelUsage && Array.isArray(modelUsage.used)
        ? modelUsage.used.map(route).filter(Boolean) : []
      if (used.length > 0) return '本次模型：' + [...new Set(used)].join('；')
      const requested = route(modelUsage && modelUsage.requested)
      return requested ? '请求模型：' + requested + '（未确认执行）' : '本次模型：未记录'
    }

    function createModelUsageReader(call) {
      const pending = new Map()
      return (request) => {
        const key = JSON.stringify([request.sessionId, request.kind, request.id])
        if (pending.has(key)) return pending.get(key)
        const promise = Promise.resolve().then(() => call('callModelUsage', request)).then((res) => {
          if (!res || res.ok === false || !Object.prototype.hasOwnProperty.call(res, 'modelUsage')) {
            throw new Error('model usage unavailable')
          }
          return res.modelUsage
        }).finally(() => pending.delete(key))
        pending.set(key, promise)
        return promise
      }
    }

    function useCallModelLabel(modelUsage, sessionId, kind, id, settled) {
      const canRead = settled && modelUsage == null && typeof sessionId === 'string' && sessionId !== ''
        && typeof id === 'string' && id !== ''
      const key = canRead ? JSON.stringify([sessionId, kind, id]) : ''
      const [lookup, setLookup] = useState(null)
      useEffect(() => {
        if (!canRead) return undefined
        let live = true
        setLookup({ key, loading: true, value: null })
        readCallModelUsage({ sessionId, kind, id }).then(
          (value) => { if (live) setLookup({ key, loading: false, value }) },
          () => { if (live) setLookup({ key, loading: false, value: null }) },
        )
        return () => { live = false }
      }, [key])
      if (modelUsage != null) return modelUsageLabel(modelUsage)
      if (!canRead) return modelUsageLabel(null)
      if (!lookup || lookup.key !== key || lookup.loading) return '模型信息加载中…'
      return modelUsageLabel(lookup.value)
    }

    const ADVISOR_CARD_CSS = [
      '.ciel-model-usage{padding:6px 10px;font-size:12px;opacity:.75;overflow-wrap:anywhere}',
      '.adv-card{--ciel-advisor-inset:14px;color:var(--dsw-alias-label-primary);margin:8px 0;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden;font-size:13px;line-height:1.6;background:var(--dsw-alias-bg-layer-2)}',
      '.adv-head{padding:9px var(--ciel-advisor-inset);display:flex;gap:10px;align-items:center;cursor:pointer;user-select:none;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l2)}',
      '.adv-navigation-error{margin:0;padding:6px var(--ciel-advisor-inset);color:var(--dsw-alias-state-error-primary)}',
      '.adv-disclosure{width:100%;border:0;text-align:left;color:inherit;font:inherit}',
      '.adv-disclosure:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}',
      '.adv-head:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.adv-caret{flex:none;width:14px;opacity:.55;font-size:11px}',
      '.adv-head-icon{flex:none;font-size:13px}',
      '.adv-head-title{font-weight:600;font-size:13px;white-space:nowrap;flex:none}',
      '.adv-chips{display:inline-flex;gap:6px;align-items:center;margin-left:2px;flex:none}',
      '.adv-chip{font-size:10.5px;font-family:ui-monospace,monospace;font-weight:600;line-height:16px;padding:0 8px;border-radius:999px}',
      '.adv-chip-high{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 13%, transparent)}',
      '.adv-chip-mid{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 13%, transparent)}',
      '.adv-chip-low{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-3)}',
      '.adv-head-note{margin-left:auto;font-size:11px;opacity:.5;font-family:ui-monospace,monospace;flex:none}',
      '.adv-head-q{margin-left:auto;font-size:12px;opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.adv-head-issues{font-size:11px;color:var(--dsw-alias-state-warn-primary);font-family:ui-monospace,monospace;flex:none}',
      // Summary, Jev and model metadata share the card's content edge. Keep
      // these selectors card-scoped: sidebars own their spacing.
      '.adv-card .adv-head[data-ciel-summary-head]{padding-inline:var(--ciel-advisor-inset)}',
      '.adv-card>.ciel-model-usage,.adv-card>[data-ciel-advisor-jev-summary]{padding:6px var(--ciel-advisor-inset)}',
      '.adv-card>[data-ciel-advisor-jev-summary]{margin:0;font-size:12px;overflow-wrap:anywhere}',
      '.adv-body{padding:4px var(--ciel-advisor-inset) 12px}',
      '.adv-q{margin:8px 0 4px;padding:6px 10px;border-left:2px solid var(--dsw-alias-border-l2);font-size:12px;opacity:.72;font-style:italic;white-space:pre-wrap;word-break:break-word}',
      '.adv-item{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l2)}',
      '.adv-item:first-of-type{border-top:none}',
      '.adv-badge{flex:none;margin-top:2px;font-size:10px;font-family:ui-monospace,monospace;font-weight:700;line-height:15px;padding:0 6px;border-radius:4px;border:1px solid}',
      '.adv-badge-high{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
      '.adv-badge-mid{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
      '.adv-badge-low{color:var(--dsw-alias-label-tertiary);border-color:var(--dsw-alias-label-tertiary)}',
      '.adv-item-content{flex:1;min-width:0}',
      '.adv-item-title{font-weight:600;font-size:13.5px;margin-bottom:6px}',
      '.adv-frow{display:flex;gap:8px;margin-bottom:5px;font-size:12.5px}',
      '.adv-frow:last-child{margin-bottom:0}',
      '.adv-flabel{flex:none;width:56px;font-size:11.5px;opacity:.6;padding-top:1px}',
      '.adv-fval{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word;opacity:.88}',
      '.adv-issues{margin-top:10px;padding:6px 10px;font-size:12px;color:var(--dsw-alias-state-warn-primary);border:1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent);border-radius:8px;background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 6%, transparent)}',
      '.adv-raw{white-space:pre-wrap;word-break:break-word;opacity:.92;font-size:12.5px;padding-top:8px}',
      '.adv-err{color:var(--dsw-alias-state-error-primary);font-size:12.5px;white-space:pre-wrap;word-break:break-word;padding-top:8px}',
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
      const modelLabel = useCallModelLabel(meta && meta.modelUsage, props.sessionId, 'tool', props.callId, settled)
      let items = meta !== null && typeof meta === 'object' && meta.v === 1 && Array.isArray(meta.items)
        ? meta.items.filter((it) => it && typeof it === 'object')
        : []
      let issues = meta !== null && typeof meta === 'object' && Array.isArray(meta.issues)
        ? meta.issues.map(String)
        : []
      const [open, setOpen] = useState(true)
      const [navigationError, setNavigationError] = useState('')

      // In-flight: tool/call seen, result not yet.
      if (!settled) {
        return h('div', { className: 'adv-card' },
          h('div', { className: 'adv-head', style: { cursor: 'default' } },
            h('span', { className: 'adv-head-icon', 'aria-hidden': true }, '💡'),
            h('span', { className: 'adv-head-title', style: { opacity: .7 } }, '顾问咨询中…'),
            question !== '' ? h('span', { className: 'adv-head-note' }, clipAdv(question, 60)) : null))
      }

      const isError = block.isError === true
      const body = advBodyText(block.content)
      // PTC dispatches carry rendered content but no presentationMeta.
      if (!isError && items.length === 0 && body !== '') {
        const parsed = parseAdvisorItems(body); items = parsed.items; issues = [...issues, ...parsed.issues]
      }
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

      if (sidebar && !isError) {
        const callId = props.callId ? 'tool:' + props.callId : null
        if (callId) return h('div', { className: 'adv-card ciel-advice-summary' },
          h('div', { className: 'adv-head', 'data-ciel-summary-head': '' }, h('span', { className: 'adv-head-title' }, headText), chips,
            navigationButton({ onClick: () => {
              const result = sidebar.openAdvice(props.sessionId, callId)
              setNavigationError(result?.ok === false ? String(result.error || '侧栏暂不可用') : '')
            } }, '在侧栏查看')),
          meta?.jev ? h('p', { 'data-ciel-advisor-jev-summary': '' }, advisorJevSummary(meta.jev)) : null,
          h('div', { className: 'ciel-model-usage' }, modelLabel),
          navigationError ? h('p', { role: 'status', className: 'adv-navigation-error' }, navigationError) : null)
      }

      const bodyId = props.callId ? 'adv-body-' + props.callId : undefined

      return h('div', { className: 'adv-card' },
        h('button', {
          type: 'button', className: 'adv-head adv-disclosure',
          onClick: () => setOpen(!open),
          'aria-expanded': open,
          'aria-controls': bodyId,
        },
          h('span', { className: 'adv-caret', 'aria-hidden': true }, open ? '▾' : '▸'),
          h('span', { className: 'adv-head-icon', 'aria-hidden': true }, '💡'),
          h('span', { className: 'adv-head-title', style: isError ? { color: 'var(--dsw-alias-state-error-primary)' } : undefined }, headText),
          chips,
          issues.length > 0 ? h('span', { className: 'adv-head-issues' }, '解析问题 ' + issues.length) : null,
          duration !== '' ? h('span', { className: 'adv-head-note', style: { marginLeft: 0 } }, duration) : null,
          question !== '' ? h('span', { className: 'adv-head-q' }, clipAdv(question, 80)) : null),
        h('div', { className: 'ciel-model-usage' }, modelLabel),
        open
          ? h('div', { id: bodyId, className: 'adv-body' },
              advisorJevPanel(h, meta?.jev),
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

    // PTC tool results lack presentationMeta; recover the structured advisor
    // items from their rendered text using the host Markdown contract.
    function parseAdvisorItems(text) {
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

    function mountClient(ctx, settingsForm) {
      settingsEditor = createSettingsEditor()
      ctx.slots.inject('settings.action', () => ctx.slots.register({ name: 'settings.action', id: 'ciel-draft-status', order: 30 }, SettingsDraftNotice))
      ctx.effect(() => {
        const beforeUnload = event => { if (hasSettingsDraft()) { event.preventDefault(); event.returnValue = '' } }
        if (typeof window.addEventListener !== 'function') return
        window.addEventListener('beforeunload', beforeUnload)
        return () => window.removeEventListener('beforeunload', beforeUnload)
      }, 'Ciel: unsaved browser exit warning')
      const ownedEditor = settingsEditor
      ctx.effect(() => () => ownedEditor.dispose(), 'dsh-ciel: page-local settings draft')
      scope = settingsForm
      settingsDescribe = ctx.configForms?.describe?.() || null
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
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'ciel', order: 30, label: () => '夏尔 Ciel' },
          CielSettingsSection,
        ),
      )

      ctx.effect(() => {
        const styleEl = document.createElement('style')
        styleEl.textContent = ADVISOR_CARD_CSS + '\n' + SIDEBAR_CSS + '\n' + SETTINGS_CSS
        document.head.appendChild(styleEl)
        return () => styleEl.remove()
      }, 'Ciel: advisor styles')

      // One owned, lazy Remote mount. No model invocation is exposed by this UI.
      let active = true, mountedOn, pendingMount, disposeMount
      const identity = remote => remote?.[Symbol.for('cordis.original')] ?? remote
      async function ready() {
        if (!active) throw new Error('顾问界面已关闭')
        if (pendingMount) return pendingMount
        const remote = getRemote()
        if (mountedOn && mountedOn === identity(remote)) return
        pendingMount = (async () => {
          const release = disposeMount
          disposeMount = undefined
          mountedOn = undefined
          await release?.()
          if (!remote || typeof remote.$mount !== 'function') throw new Error('顾问连接尚未就绪，请重试')
          const dispose = await remote.$mount(ADVISOR_REMOTE)
          if (!active) { await dispose?.(); throw new Error('顾问界面已关闭') }
          disposeMount = dispose
          mountedOn = identity(remote)
        })()
        try { await pendingMount } finally { pendingMount = undefined }
      }
      async function advisorCall(method, request) {
        const invocation = ADVISOR_REMOTE.descriptors.find(item => item.method === method)
        if (!invocation) return { ok: false, error: '未知顾问读取操作' }
        try { invocation.parameters[0].codec.create().parse(request) }
        catch { return { ok: false, error: '顾问读取参数无效' } }
        try {
          await ready()
          if (!active) throw new Error('顾问界面已关闭')
          const api = ctx.get('remote.cielAdvisor')
          if (typeof api?.[method] !== 'function') throw new Error('顾问读取接口不可用，请刷新页面后重试')
          const response = await api[method](request)
          if (response?.ok === false && typeof response.error === 'object') {
            return { ok: false, error: String(response.error?.message || '顾问读取失败') }
          }
          const result = response?.ok === true && Object.hasOwn(response, 'value') ? response.value : response
          invocation.result.create().parse(result)
          if (result?.ok === true && method === 'readAdvice' &&
            (result.advice?.sessionId !== request.sessionId || result.advice?.callId !== request.callId)) {
            throw new Error('顾问记录与请求不匹配')
          }
          return result
        } catch { return { ok: false, error: '顾问记录读取失败；请检查连接并重试。' } }
      }
      readCallModelUsage = createModelUsageReader(advisorCall)
      ctx.effect(() => {
        void ready().catch(() => {})
        return async () => {
          active = false
          await pendingMount?.catch(() => {})
          const dispose = disposeMount
          disposeMount = undefined
          mountedOn = undefined
          await dispose?.()
        }
      }, 'Ciel: advisor remote lifetime')
      ctx.on('connection/reset', () => { void ready().catch(() => {}) })

      const installSidebar = sctx => {
        const native = createCielSidebar({ React, Tag })
        native.install(sctx, { call: advisorCall })
        sidebar = native
        sctx.effect(() => () => { native.dispose(); if (sidebar === native) sidebar = null }, 'Ciel: advice sidebar lifetime')
      }
      ctx.inject(['resources', 'sidebarRightTabs', 'sidebarRight'], installSidebar)
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register({ name: 'tool.call.toolview', key: 'ask_advisor' }, props => h(AdvisorToolView, props)))
      Object.assign(__runtime, { advisorCall })
      ctx.effect(() => () => {
        for (const key of Object.keys(__runtime)) delete __runtime[key]
      }, 'Ciel: advisor runtime cleanup')
    }

    exports.__test = {
      modelUsageLabel, createModelUsageReader, CielSettingsSection, AdvisorToolView,
      getSettingsEditor: () => settingsEditor,
      runtime: __runtime,
      remoteMethodNames: ADVISOR_REMOTE.descriptors.map(row => row.method),
      defaults: { ...DEFAULTS },
      fieldKeys: FIELD_KEYS.slice(),
    }
    exports.apply = (ctx) => {
      ctx.inject(['configForms'], child => mountClient(child, child.configForms.get('advisor')))
      ctx.inject(['settingsScope'], child => mountClient(child, child.settingsScope.bind({ namespace: 'ciel' })))
    }
    exports.inject = ['slots', 'resources', 'sidebarRightTabs', 'sidebarRight']
    // The module system materializes the factory's RETURN VALUE as the plugin
    // exports — assigning without returning leaves the kernel `undefined`.
    return module.exports
  },
})
