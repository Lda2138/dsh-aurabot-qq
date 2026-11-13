// 惦记清单：家里人说到接下来要做的事或当下状态（上课、考试、加班、不舒服、熬夜、心情不好……），
// 她在回复里顺手写一个不发出去的 <惦记 分钟后="N">要问什么</惦记>，到点后由主动联系优先拿来问一句。
// 只存在本地文件里；每次操作都重新读写文件，hub 和主动联系各自创建实例也能共用。

import { dataDir, readJson, writeJson } from '../core/store.js'
import { clipText } from '../core/text.js'

const MINUTE = 60_000
const TAG = /<惦记((?:\s+[^<>]*?)?)>([\s\S]*?)<\/惦记>|<惦记((?:\s+[^<>]*?)?)\/>/g
export const CARE_DEFAULT_MINUTES = 120
export const CARE_MIN_MINUTES = 10
export const CARE_MAX_MINUTES = 3 * 24 * 60
/** 到点后多久还算数：过了就不再问（问晚了反而奇怪）。 */
export const CARE_STALE_MINUTES = 8 * 60
const PER_CHAT = 3
const TOTAL = 40
/** 没回应时再试：提醒（答应过的事）最多 3 次、间隔 20 / 40 分钟；问候最多 2 次、隔 90 分钟。对方一说话就算结束。 */
export const CARE_RETRY = { remind: [20, 40], ask: [90] }

/**
 * 「今晚」「明早」「半小时后」「九点」这类说法换成分钟数；认不出返回 null（不硬猜）。
 * 只认常见说法，时间按本机时区。
 */
export function minutesUntil(text, now = Date.now()) {
  const t = String(text || '')
  if (!t.trim()) return null
  const d = new Date(now)
  const at = (dayOffset, h, m = 0) => { const x = new Date(d); x.setDate(x.getDate() + dayOffset); x.setHours(h, m, 0, 0); return Math.round((x.getTime() - now) / MINUTE) }
  const cn = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 }
  const num = (v) => (/^\d+$/.test(v) ? Number(v) : cn[v])
  let m
  if (/半(?:个)?(?:小时|钟头)/.test(t)) return 30
  if ((m = t.match(/(\d+|[一两二三四五六七八九十]+)\s*分钟/))) return num(m[1]) || null
  if ((m = t.match(/(\d+|[一两二三四五六七八九十]+)\s*(?:个)?(?:小时|钟头)/))) return num(m[1]) ? num(m[1]) * 60 : null
  const tomorrow = /明[天早晚]|明儿/.test(t) ? 1 : /后天/.test(t) ? 2 : 0
  if ((m = t.match(/(\d{1,2}|十[一二]?|[一两二三四五六七八九])\s*(?:点|:|：)\s*(半|\d{1,2})?/))) {
    let h = num(m[1]), min = m[2] === '半' ? 30 : Number(m[2] || 0)
    if (!Number.isFinite(h)) return null
    if (/下午|晚上|今晚|明晚|傍晚/.test(t) && h < 12) h += 12
    // 晚上七点说「9点」多半是今晚九点，不是明早
    else if (!tomorrow && h < 12 && !/上午|早上|早晨|凌晨/.test(t) && at(0, h, min) <= 0 && at(0, h + 12, min) > 0) h += 12
    const v = at(tomorrow, h, min)
    return v > 0 ? v : tomorrow ? null : at(1, h, min)
  }
  const slot = /早上|早晨|明早|起床/.test(t) ? [8, 30] : /中午/.test(t) ? [12, 0] : /下午/.test(t) ? [15, 0] : /晚上|今晚|明晚|夜里|睡前/.test(t) ? [21, 0] : null
  if (slot) { const v = at(tomorrow, ...slot); return v > 0 ? v : tomorrow ? null : 30 }
  if (tomorrow) return at(tomorrow, 10, 0)
  if (/忙完|下课|下班|回来|一会|待会|等下|等会/.test(t)) return 120
  return null
}

function minutesOf(attrs) {
  const m = String(attrs || '').match(/(?:分钟后|分钟|after)\s*=\s*["“]?\s*(\d{1,5})/)
  const n = m ? Number(m[1]) : CARE_DEFAULT_MINUTES
  return Math.max(CARE_MIN_MINUTES, Math.min(CARE_MAX_MINUTES, Number.isFinite(n) ? n : CARE_DEFAULT_MINUTES))
}

/**
 * 从回复里取出惦记标签（不管在不在家里聊天，标签本身都不能发出去）。
 * @returns {{ text: string, notes: { text: string, minutes: number }[] }}
 */
export function takeCareTags(text) {
  const notes = []
  const rest = String(text || '').replace(TAG, (all, attrs, body, attrs2) => {
    const what = clipText(String(body || '').replace(/\s+/g, ' ').trim(), 60)
    if (what) notes.push({ text: what, minutes: minutesOf(attrs ?? attrs2), kind: /提醒/.test(String(attrs ?? attrs2)) ? 'remind' : 'ask' })
    return ''
  })
  return { text: notes.length || rest !== String(text || '') ? rest.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : String(text || ''), notes }
}

export function createCareNotes() {
  const file = () => dataDir('care-notes.json')
  const load = () => {
    const s = readJson(file(), () => ({ notes: [] }))
    if (!Array.isArray(s.notes)) s.notes = []
    return s
  }
  const save = (s) => writeJson(file(), s)
  const gaps = (n) => CARE_RETRY[n.kind === 'remind' ? 'remind' : 'ask']
  // 问过还没回应的，按间隔再到点一次
  const nextAt = (n) => n.status === 'waiting' ? (n.askedAt || 0) + (gaps(n)[(n.tries || 1) - 1] || 0) * MINUTE : n.dueAt
  const live = (n, now) => (n.status === 'pending' || n.status === 'waiting') && now < nextAt(n) + CARE_STALE_MINUTES * MINUTE

  function add(chatId, notes, { speaker = '', now = Date.now() } = {}) {
    if (!chatId || !notes?.length) return []
    const s = load(), added = []
    for (const note of notes.slice(0, 1)) { // 一轮最多记一条，免得每句话都变成待办
      // 同一件提醒可能既从 remember 的时间说法记了一条、又在回复里写了惦记：45 分钟内到点的提醒只留一条
      const twin = note.kind === 'remind' && s.notes.find((n) => n.chatId === chatId && n.status === 'pending' && n.kind === 'remind' && Math.abs(n.dueAt - (now + note.minutes * MINUTE)) < 45 * MINUTE)
      if (twin) { added.push(twin); continue }
      const same = s.notes.find((n) => n.chatId === chatId && n.status === 'pending' && n.text === note.text)
      if (same) { same.dueAt = now + note.minutes * MINUTE; added.push(same); continue }
      const item = { id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`, chatId, speaker: String(speaker || ''), text: note.text, kind: note.kind === 'remind' ? 'remind' : 'ask', at: now, dueAt: now + note.minutes * MINUTE, status: 'pending', tries: 0 }
      s.notes.push(item)
      added.push(item)
    }
    // 每个聊天只留最近 3 条还在等的；整体只留最近 40 条记录
    const pending = s.notes.filter((n) => n.chatId === chatId && ['pending', 'waiting'].includes(n.status)).sort((a, b) => b.at - a.at)
    for (const old of pending.slice(PER_CHAT)) old.status = 'dropped'
    s.notes = s.notes.sort((a, b) => b.at - a.at).slice(0, TOTAL)
    save(s)
    return added
  }

  /** 到点、还没过期、还没问过的惦记。 */
  function due(chatId, now = Date.now()) {
    return load().notes.filter((n) => n.chatId === chatId && live(n, now) && nextAt(n) <= now).sort((a, b) => nextAt(a) - nextAt(b))
  }

  /** 有没有到点后还没被主动规划看过的惦记（用来提前叫醒规划，不必等下一个检查窗）。 */
  function fresh(now = Date.now()) {
    return load().notes.some((n) => live(n, now) && nextAt(n) <= now && !n.consideredAt)
  }

  function considered(ids, now = Date.now()) {
    if (!ids?.length) return
    const s = load()
    for (const n of s.notes) if (ids.includes(n.id) && !n.consideredAt) n.consideredAt = now
    save(s)
  }

  function finish(ids, status = 'asked', now = Date.now()) {
    if (!ids?.length) return
    const s = load()
    for (const n of s.notes) {
      if (!ids.includes(n.id) || !['pending', 'waiting'].includes(n.status)) continue
      if (status === 'asked') {
        n.tries = (n.tries || 0) + 1
        n.askedAt = now
        delete n.consideredAt
        // 还能再试就先等着：对方回话就结束，不回到点再提一次
        if (n.tries <= gaps(n).length) { n.status = 'waiting'; continue }
      }
      n.status = status
      n.finishedAt = now
    }
    save(s)
  }

  /** 家里人在这个聊天里说话了：问过、等回应的惦记就算有着落了。 */
  function answered(chatId, at = Date.now()) {
    const s = load()
    let changed = false
    for (const n of s.notes) if (n.chatId === chatId && n.status === 'waiting' && (n.askedAt || 0) < at) { n.status = 'answered'; n.finishedAt = at; changed = true }
    if (changed) save(s)
    return changed
  }

  /** 过期的标记掉，面板 / 排查时能看出是没来得及问。 */
  function sweep(now = Date.now()) {
    const s = load()
    let changed = false
    for (const n of s.notes) if ((n.status === 'pending' || n.status === 'waiting') && !live(n, now)) { n.status = n.status === 'waiting' ? 'unanswered' : 'expired'; changed = true }
    if (changed) save(s)
  }

  return { add, due, fresh, considered, finish, answered, sweep, list: () => load().notes }
}

const NOTICE_TAG = /<记下((?:\s+[^<>]*?)?)>([\s\S]*?)<\/记下>/g
/**
 * 她在回复里顺手记的事：<记下 关于="妈妈">妈妈在上晚课，九点下课</记下>。标签不发出去。
 * @returns {{ text: string, notes: { text: string, about: string }[] }}
 */
export function takeNoticeTags(text) {
  const notes = []
  const raw = String(text || '')
  const rest = raw.replace(NOTICE_TAG, (all, attrs, body) => {
    const what = clipText(String(body || '').replace(/\s+/g, ' ').trim(), 80)
    const about = (String(attrs || '').match(/关于\s*=\s*["“「]?([^"”」\s>]{1,12})/) || [])[1] || ''
    if (what) notes.push({ text: what, about })
    return ''
  })
  return rest === raw ? { text: raw, notes } : { text: rest.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), notes }
}
