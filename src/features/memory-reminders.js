// Civil calendar arithmetic: fixed date, yearly anniversary, or every N days.
// No timers or sending here; the existing proactive planner owns delivery.
const DAY = 86400_000
const dateNumber = (text) => {
  const match = String(text || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const [, y, m, d] = match.map(Number), at = Date.UTC(y, m - 1, d)
  const value = new Date(at)
  return value.getUTCFullYear() === y && value.getUTCMonth() === m - 1 && value.getUTCDate() === d ? at / DAY : null
}
const dateString = (day) => new Date(day * DAY).toISOString().slice(0, 10)
export function normalizeReminder(value) {
  if (!value || typeof value !== 'object' || dateNumber(value.date) === null || !['once', 'yearly', 'days'].includes(value.repeat)) return null
  const everyDays = Number(value.everyDays)
  if (value.repeat === 'days' && (!Number.isSafeInteger(everyDays) || everyDays < 1 || everyDays > 36525)) return null
  return { date: value.date, repeat: value.repeat, ...(value.repeat === 'days' ? { everyDays } : {}), ...(value.enabled === false ? { enabled: false } : {}) }
}
export function calendarDate(at, timeZone = 'Asia/Tokyo') {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at))
  const part = (key) => parts.find((p) => p.type === key).value
  return `${part('year')}-${part('month')}-${part('day')}`
}
export function reminderSupported(value, text, saidAt = Date.now(), timeZone = 'Asia/Tokyo') {
  const reminder = normalizeReminder(value), raw = String(text || '')
  if (!reminder || !/提醒|纪念日|周年|生日|别忘|记住/.test(raw)) return false
  const [year, month, day] = reminder.date.split('-').map(Number)
  const dated = raw.includes(reminder.date) || new RegExp(`${year}年0?${month}月0?${day}[日号]`).test(raw)
  const today = dateNumber(calendarDate(saidAt, timeZone))
  const relative = ['今天', '明天', '后天'].some((word, offset) => raw.includes(word) && dateString(today + offset) === reminder.date)
  if (!dated && !relative) return false
  if (reminder.repeat === 'yearly') return /每年|周年|生日|结婚纪念日|恋爱纪念日/.test(raw)
  if (reminder.repeat === 'days') return new RegExp(`每(?:隔)?\\s*${reminder.everyDays}\\s*天`).test(raw)
  return true
}
export function dueOccurrences(reminder, now = Date.now(), { timeZone = 'Asia/Tokyo', daysAhead = 1 } = {}) {
  const value = normalizeReminder(reminder)
  if (!value || value.enabled === false) return []
  const today = dateNumber(calendarDate(now, timeZone)), start = dateNumber(value.date), due = []
  for (let offset = 0; offset <= Math.min(7, Math.max(0, daysAhead)); offset++) {
    const day = today + offset, date = dateString(day)
    if (day < start) continue
    const elapsed = day - start
    if (value.repeat === 'once' ? day !== start : value.repeat === 'yearly' ? date.slice(5) !== value.date.slice(5) : elapsed % value.everyDays !== 0) continue
    due.push({ date, daysAway: offset, ...(value.repeat === 'days' ? { elapsedDays: elapsed } : {}) })
  }
  return due
}

// Legacy facts stay byte-for-byte intact. Only an explicit family reminder
// request enables deriving annual dates already recorded as relationship facts.
export function legacyAnniversary(item, items) {
  if (!/相恋|恋爱|结婚/.test(item.text || '') || !items.some((m) => /(?:以后|每年|到时候).{0,20}(?:注意|提醒|记得|记着).{0,10}(?:纪念日|周年)/.test(m.text || ''))) return null
  const match = String(item.text).match(/(\d{4})年(\d{1,2})月(\d{1,2})[日号]/)
  return match ? normalizeReminder({ date: `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`, repeat: 'yearly' }) : null
}
