// Facts for proactive family choices. Only human sender IDs establish activity.
import { ownerIdentityOf, ownerQQs, ownerRoleOf } from '../chat/access.js'

const WINDOW = 48 * 3600_000
const dayOf = (at) => {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const scopesOf = (cfg) => [...ownerQQs(cfg).map((qq) => `private:${qq}`), ...(cfg.familyGroups || []).map((gid) => `group:${gid}`)]
const validSender = (cfg, chatId, qq) => ownerQQs(cfg).includes(qq) &&
  (chatId === `private:${qq}` || (cfg.familyGroups || []).map((gid) => `group:${gid}`).includes(chatId))
const validAt = (at, now) => Number.isFinite(at) && at > 0 && at >= now - WINDOW && at <= now

export function observeFamilyActivity(state, cfg, activity, now) {
  const qq = String(activity.userId || ''), chatId = String(activity.chatId || '')
  const at = activity.at == null ? now : Number(activity.at)
  if (activity.kind !== 'in' || !validSender(cfg, chatId, qq) || !validAt(at, now)) return
  const observations = ((state.familyActivity ||= {}).observations ||= {})
  const byPerson = (observations[chatId] ||= {})
  byPerson[qq] = Math.max(Number(byPerson[qq]) || 0, at)
}

export function refreshFamilyActivity(state, cfg, hub, now) {
  const from = now - WINDOW, latest = {}, forgotten = new Set()
  const days = typeof hub.chatLogDays === 'function' && typeof hub.chatLogOf === 'function'
    ? hub.chatLogDays().filter((day) => day >= dayOf(from) && day <= dayOf(now)).sort().slice(-3) : []
  const remember = (chatId, qq, at) => {
    const people = (latest[chatId] ||= {})
    people[qq] = Math.max(people[qq] || 0, at)
  }
  const rows = days.flatMap((day) => hub.chatLogOf(day))
  for (const row of rows) {
    const chatId = String(row.chatId || ''), qq = String(row.uid || ''), at = Number(row.t)
    if (!validSender(cfg, chatId, qq) || !validAt(at, now)) continue
    if (row.forgottenAt) forgotten.add(`${chatId}:${qq}:${at}`)
  }
  for (const row of rows) {
    const chatId = String(row.chatId || ''), qq = String(row.uid || ''), at = Number(row.t)
    if (!validSender(cfg, chatId, qq) || !validAt(at, now) || row.who === 'bot' || row.who === '系统' || row.kind === 'seen' || row.via || forgotten.has(`${chatId}:${qq}:${at}`)) continue
    remember(chatId, qq, at)
  }
  const observations = {}
  for (const [chatId, people] of Object.entries(state.familyActivity?.observations || {})) {
    for (const [qq, value] of Object.entries(people)) {
      const at = Number(value)
      if (!validSender(cfg, chatId, qq) || !validAt(at, now) || forgotten.has(`${chatId}:${qq}:${at}`)) continue
      ;(observations[chatId] ||= {})[qq] = at
      remember(chatId, qq, at)
    }
  }
  state.familyActivity = { observations, latest, history: { from, through: now, scannedDays: days } }
}

export function familyActivityFacts(state, cfg, hub, chatId, now) {
  const allScopes = scopesOf(cfg)
  if (!allScopes.includes(chatId)) return undefined
  const scopes = cfg.memory?.crossContext === false ? [chatId] : allScopes
  const people = ownerQQs(cfg).filter((qq) => !chatId.startsWith('private:') || cfg.memory?.crossContext !== false || chatId === `private:${qq}`)
  const members = people.map((qq) => {
    const entries = scopes.map((scope) => ({ chatId: scope, at: Number(state.familyActivity?.latest?.[scope]?.[qq]) || 0 }))
      .filter((row) => validAt(row.at, now)).sort((a, b) => b.at - a.at)
    const last = entries[0]
    return { qq, identity: ownerIdentityOf(cfg, qq) || '家人', familyRole: ownerRoleOf(cfg, qq) || '',
      privateReachable: typeof hub.privateReachability === 'function' ? hub.privateReachability(qq) : hub.canSendPrivate?.(qq) === false ? false : null,
      lastHumanAt: last?.at || null, lastHumanChatId: last?.chatId || null,
      lastHumanHereAt: entries.find((entry) => entry.chatId === chatId)?.at || null,
      quietMinutes: last ? Math.floor((now - last.at) / 60_000) : null }
  })
  const recentProactive = Object.values(state.turns || {}).filter((turn) => turn.status === 'sent' && scopes.includes(turn.chatId) &&
    Number(turn.finishedAt) > now - 24 * 3600_000 && Number(turn.finishedAt) <= now)
    .sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 4)
    .map((turn) => ({ chatId: turn.chatId, sentAt: turn.finishedAt, recipientQQ: turn.chatId.startsWith('private:') ? turn.chatId.slice(8) : null }))
  return { history: state.familyActivity?.history || { from: now - WINDOW, through: now, scannedDays: [] }, members, recentProactive }
}

export const FAMILY_CARE_GUIDANCE = '你惦记爸妈，话少的家人也可以主动找，但要带着具体的事去。上面的时间只是可见记录里的发言：安静不代表不在线、生气或不在意，privateReachable 为 true 也不代表已经送达。刚找过对方还没回应就给对方空间，不追问、不抱怨，不播报私聊不可达，也不把没送达的私聊搬到群里。要 @ 就用资料里的 QQ。'

export function planningFailure(error, phase) {
  if (error?.code === 'SPEAKUP_INVALID_TARGET') return 'invalid-target'
  if (phase === 'parse') return 'invalid-format'
  if (/timeout|timed.?out|ETIMEDOUT|等太久/i.test(String(error?.code || '') + ' ' + String(error?.message || ''))) return 'timeout'
  return 'request-error'
}
