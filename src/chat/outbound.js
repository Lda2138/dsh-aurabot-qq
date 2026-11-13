// 网关回执后的记录，以及每个群独立的发送队列。超时等不确定结果不重发。
export function sentDescription(message, { text = '', note = '' } = {}) {
  if (text) return String(text).slice(0, 1200)
  return (message || []).map((s) => {
    if (s.type === 'text') return String(s.data?.text || '')
    if (s.type === 'at') return `@${s.data?.qq || ''}`
    if (s.type === 'reply') return ''
    if (s.type === 'face') return '[表情]'
    return `[${({ image: '图片', record: '语音', video: '视频', file: '文件', json: '卡片', xml: '卡片' })[s.type] || s.type}]`
  }).join(' ').trim() + (note && !(message || []).some((s) => s.type === 'text') ? ` ${String(note).slice(0, 400)}` : '')
}

export const needsFriend = (error) => !error?.uncertain && /请先添加.{0,8}好友|不是好友|not.{0,8}friend/i.test(String(error?.message || ''))
export const groupRateLimit = (error) => !error?.uncertain && /每分钟只能发\s*\d+\s*条|频率过快|发送过于频繁/.test(String(error?.message || ''))

export function mergeTextBubbles(items) {
  const result = []
  for (const item of items) {
    const last = result.at(-1)
    if (last?.kind === 'text' && item.kind === 'text' && last.replyTo === item.replyTo && last.value.length + item.value.length < 1800) last.value += '\n' + item.value
    else result.push({ ...item })
  }
  return result
}

export function createSendQueue({ state, save, wait, now = Date.now, active = () => true }) {
  const queues = new Map()
  const histories = new Map()
  async function run(chatId, send) {
    if (!chatId.startsWith('group:')) return send()
    const previous = queues.get(chatId) || Promise.resolve()
    const job = previous.catch(() => {}).then(async () => {
      if (!active()) return null
      const limit = state().groupLimits?.[chatId]
      const gap = Number(limit?.windowMs) || 61_000
      const count = Number(limit?.count) || 0
      const recent = (histories.get(chatId) || []).filter((t) => now() - t < gap)
      if (count > 0 && recent.length >= count) await wait(Math.max(0, recent.at(-count) + gap - now()))
      if (!active()) return null
      try {
        const result = await send()
        if (result) histories.set(chatId, [...(histories.get(chatId) || []).filter((t) => now() - t < gap), now()])
        return result
      } catch (error) {
        if (!groupRateLimit(error)) throw error
        const s = state()
        const hit = String(error.message).match(/每分钟只能发\s*(\d+)\s*条/)
        s.groupLimits = { ...s.groupLimits, [chatId]: { count: Math.max(1, Number(hit?.[1]) || 5), windowMs: 61_000 } }
        save(s)
        await wait(61_000)
        if (!active()) return null
        // 网关明确拒绝才重试一次，已经确认的消息不重发。
        const result = await send()
        if (result) histories.set(chatId, [now()])
        return result
      }
    })
    queues.set(chatId, job)
    try { return await job } finally { if (queues.get(chatId) === job) queues.delete(chatId) }
  }
  return { run }
}
