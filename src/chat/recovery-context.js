// Recovered messages belong to their original place in the conversation.
// This is context for a decision, never an instruction to replay old actions.
export const RECOVERY_NOTE = '这些是现在补齐的历史背景，原发送时间已标出，不是对方此刻又说了一遍。先结合其后已经发生的对话和实际送达结果，判断是否还有没回应的问题、交代或重要信息；需要补答时自然接上，已经回答、话题已过去或已经互道晚安时，不必为了旧表情、笑声或收尾重新开口，可以只回 [沉默]。当前新消息和明确更正优先，别重复执行已经办过的事，也别把尚未送达的话当成对方已听到。'

const when = (ms) => new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
const keyOf = (r) => r.messageId && String(r.messageId) !== '0'
  ? `id:${r.messageId}` : `${r.t}|${r.uid || ''}|${r.who || ''}|${r.text || ''}`

/** Pure formatter; callers supply only records from the same permitted chat. */
export function recoveryContext({ recovered, rows = [], label, excludeIds = [], maxRows = 60 }) {
  if (!recovered?.length) return ''
  const floor = Math.min(...recovered.map((r) => Number(r.t)))
  const exclude = new Set(excludeIds.map(String))
  const all = new Map()
  for (const row of rows) {
    if (!(Number(row.t) >= floor) || row.forgottenAt || row.deliveryStatus === 'failed'
      || exclude.has(String(row.messageId))) continue
    all.set(keyOf(row), { ...row, recovered: false })
  }
  for (const row of recovered) all.set(keyOf(row), { ...row, recovered: true })
  const ordered = [...all.values()].sort((a, b) => Number(a.t) - Number(b.t))
  const required = ordered.filter((r) => r.recovered)
  const room = Math.max(0, maxRows - required.length)
  const later = room ? ordered.filter((r) => !r.recovered).slice(-room) : []
  const selected = [...required, ...later].sort((a, b) => Number(a.t) - Number(b.t))
  const omitted = ordered.length - selected.length
  const lines = selected.map((r) => {
    const who = r.who === 'bot' ? '你（实际已发送）' : r.who === '系统' ? '送达或会话记录' : `${r.who || r.uid || '家人'}${r.uid ? `(${r.uid})` : ''}`
    return `${r.ref ? `[${r.ref}] ` : ''}[${when(Number(r.t))}${r.recovered ? '，补齐的原消息' : ''}] ${who}：${String(r.text || '（图片/表情）').slice(0, 800)}`
  })
  return `【${label} · 补齐历史，按原时间排列】\n${RECOVERY_NOTE}\n` +
    (omitted ? `（中间有 ${omitted} 条已有记录省略，不能据此断言对方没有回应过。）\n` : '') +
    lines.join('\n') + '\n【历史补齐结束】\n'
}
