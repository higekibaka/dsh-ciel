// 「只想不说」环境徽章原型 pkg-9：pkg-8 的中断排除对「零输出中断」失效——
// 什么都没产出的中断轮没有 assistant 节点，interrupted 标记无处附着；
// 快照也不带 turn/end 结局（aborted/error），客户端拿不到。
// 换正条件：强信号 = 轮已结束 + 有工作痕迹（思维或工具块存在）+ 零正文 + 无出错节点。
// 零输出中断轮无工作痕迹 → 自然不计；出错轮排除不变。
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    const h = React.createElement

    const THINK_THRESHOLD = 1500

    function computeStats(snap) {
      if (!snap || !Array.isArray(snap.nodes)) return null
      const turnText = new Map()
      const turnError = new Map()
      const turnWorked = new Map() // 该轮是否有任何思维/工具痕迹
      const weakSteps = []
      for (const node of snap.nodes) {
        if (!node) continue
        if (node.kind === 'turn-error' && typeof node.turn === 'number') {
          turnError.set(node.turn, true)
          continue
        }
        if (node.kind !== 'assistant' || !Array.isArray(node.blocks)) continue
        let textLen = 0
        let thinkLen = 0
        const tools = []
        for (const b of node.blocks) {
          if (!b) continue
          if (b.kind === 'text' && typeof b.text === 'string') textLen += b.text.trim().length
          else if (b.kind === 'reasoning' && typeof b.text === 'string') thinkLen += b.text.length
          else if (b.kind === 'tool-call') tools.push(b.name)
        }
        if (thinkLen > 0 || tools.length > 0) turnWorked.set(node.turn, true)
        if (textLen > 0) {
          turnText.set(node.turn, true)
          continue
        }
        if (thinkLen >= THINK_THRESHOLD) {
          weakSteps.push({ turn: node.turn, step: node.step, thinkLen, tools: tools.slice(0, 3) })
        }
      }
      const strongTurns = []
      if (snap.turnEnds && typeof snap.turnEnds.keys === 'function') {
        for (const turn of snap.turnEnds.keys()) {
          if (turnWorked.get(turn) && !turnText.get(turn) && !turnError.get(turn)) strongTurns.push(turn)
        }
      }
      return { strong: strongTurns.length, strongTurns: strongTurns.slice(-10), weakSteps: weakSteps.slice(-20) }
    }

    function StepEchoDock(props) {
      const [open, setOpen] = React.useState(false)
      const stats = props.useSession(computeStats)
      if (!stats || stats.strong === 0) return null
      return h('div', { style: { fontSize: '12px', padding: '2px 10px', opacity: open ? 1 : 0.85 } },
        h('button', {
          type: 'button',
          onClick: () => setOpen(!open),
          title: '存在「模型有工作痕迹（思维/工具）但整轮零可见正文」的已完成轮次（出错轮已排除）——用户视角的沉默。点击看明细。',
          style: {
            appearance: 'none',
            border: '1px solid #f85149',
            borderRadius: '999px',
            background: 'transparent',
            color: '#f85149',
            font: 'inherit',
            fontSize: '11px',
            padding: '1px 10px',
            cursor: 'pointer',
          },
        }, '🔇 整轮零正文 ' + stats.strong),
        open
          ? h('div', {
              style: {
                marginTop: '4px',
                padding: '6px 10px',
                border: '1px solid rgba(130,130,130,.3)',
                borderRadius: '8px',
                fontFamily: 'ui-monospace,monospace',
                fontSize: '11px',
                lineHeight: 1.6,
                opacity: 0.9,
              },
            },
              h('div', { style: { color: '#f85149', marginBottom: '4px' } },
                '有工作痕迹但整轮零正文：turn ' + stats.strongTurns.join(', ') + '（出错轮已排除）'),
              stats.weakSteps.length > 0
                ? h('div', { style: { marginTop: '4px' } },
                    h('div', { style: { opacity: 0.65, marginBottom: '2px' } },
                      '参考：长思维零正文步骤（≥' + THINK_THRESHOLD + ' 字符；k3 长思考后直接调工具是常态，非异常）：'),
                    stats.weakSteps.map((s) =>
                      h('div', { key: s.turn + ':' + s.step },
                        'turn ' + s.turn + ' step ' + s.step + ' · 思维 ' + s.thinkLen + ' · 工具 ' + (s.tools.join(',') || '无'))))
                : null)
          : null)
    }

    slots.inject('conversation.composer.dock', () => slots.register(
      { name: 'conversation.composer.dock', id: 'advisor-step-echo', order: 10, label: '无正文检测' },
      (props) => h(StepEchoDock, props),
    ))
  },
}
