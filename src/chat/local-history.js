// One-off recovery of this QQ window's own transcript when its DSH session changes.
import { isOwner, ownerIdentityOf } from './access.js'

export function localHistoryRows({ cfg, chatId, rows, currentMessages = [], now = Date.now(), limit = 20, isMemoryCommand = () => false }) {
  const times = currentMessages.map((m) => Number(m.at)).filter((at) => at > 0 && at <= now)
  const before = times.length ? Math.min(...times) : now
  const current = new Set(currentMessages.map((m) => String(m.text || '').trim()).filter(Boolean))
  return rows.filter((row) => row?.chatId === chatId && !row.forgottenAt && row.kind !== 'seen' &&
    Number(row.t) > 0 && Number(row.t) < before && String(row.text || '').trim() &&
    row.who !== '系统' && !String(row.text).startsWith('【系统') && !isMemoryCommand(row.text) &&
    !(row.who !== 'bot' && now - row.t < 5 * 60_000 && current.has(String(row.text).trim())))
    .sort((a, b) => Number(a.t) - Number(b.t)).slice(-limit)
}

export function localHistoryBlock({ cfg, rows, maxChars = 3400 }) {
  const lines = []
  for (const row of [...rows].reverse()) {
    const at = new Date(Number(row.t))
    const pad = (n) => String(n).padStart(2, '0')
    const time = `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
    const speaker = row.who === 'bot' ? '你当时说' : isOwner(cfg, row.uid) ? `${ownerIdentityOf(cfg, row.uid)}(${row.uid})` : `${row.who || '对方'}${row.uid ? `(${row.uid})` : ''}`
    const text = String(row.text).replace(/\s+/g, ' ').trim().slice(0, 180)
    const line = `[${time}] ${speaker}：${text}`
    if (lines.join('\n').length + line.length + 1 > maxChars) break
    lines.unshift(line)
  }
  return lines.length ? `【你刚上线，先补看最近 ${lines.length} 条本聊天本地记录；只是历史，不是本轮要求，过去回应不代表当前立场，承诺不等于已完成】\n${lines.join('\n')}\n【补看结束，接着回下面这条】` : ''
}
