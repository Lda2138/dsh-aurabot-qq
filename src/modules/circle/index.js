// 内置模块：交友圈。让她自己在白名单群里交朋友，把「活跃朋友」维持在 min~max 个（默认 5~7）。
//
// 网关不能主动加好友，所以路子是（「想不想、和谁」都由她自己判断，代码只管记账和防骚扰的上限）：
//  1. 记账：记下白名单群里谁直接找她说话（@她、回她），最近 14 天够 minHits 次就进候选名单。
//  2. 挑人：活跃朋友不够时，把候选名单和来往情况给她看，由她自己挑一个想交朋友的人，或者谁都不挑。
//  3. 邀请：她在群里想邀请谁（不管是被提醒还是平时聊着聊着自己想），先用 qq_invite_friend 登记再开口。
//     上限：同一个群 groupCooldownDays 天内最多邀请一次；活跃 + 等对方加的已到 max 就不再邀请；
//     对方 3 天没加就算了，30 天内不再邀请；删过她的人不再邀请。
//  4. 自动通过：她邀请过的人发来好友申请，直接通过，加进私聊白名单和主动搭话白名单，告诉主人一声，再去打个招呼。
//     之后的「偶尔主动找对方」交给主动搭话模块（speakUp.allow）。
//  5. 她自己判断要不要继续：加上 reviewDays 天后，每隔 reviewDays 天让她回顾一次和这位朋友的相处，
//     不想继续就「淡下来」：不再主动找、不占名额（对方来找她照样回）。聊天中她也能用 qq_friendship 直接决定。
// 活跃 = 最近 14 天对方私聊找过她，或者刚加上 3 天内；主人不算。设置在 cfg.circle（面板「权限」页）。

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { defineTool, str } from '../../tools/tools.js'
import { isOwner, isFamilyGroup } from '../../chat/access.js'

const DAY = 86400000
const ACTIVE_DAYS = 14
const NEW_GRACE_DAYS = 3
const INVITE_WAIT_DAYS = 3 // 邀请后等对方加多久
const INVITE_RETRY_DAYS = 30 // 邀请了没加，多久后才可能再邀请
const SKIP_RETRY_DAYS = 2 // 她看过名单、没挑这个人，多久后再给她看
const SCOUT_EVERY_MS = 6 * 3600000
const HITS_KEEP = 40
const CANDIDATES_MAX = 8

const recent = (list, now, days) => (list || []).filter((t) => now - t < days * DAY)
const keepRecent = (list, now) => recent(list, now, ACTIVE_DAYS).slice(-HITS_KEEP)

export function emptyState() { return { people: {}, groupAskedAt: {}, lastScout: 0 } }

/** 活跃朋友：最近 14 天私聊找过她，或刚加上 3 天内；淡下来的、主人不算。 */
export function activeFriends(state, cfg, now = Date.now()) {
  return Object.entries(state.people)
    .filter(([qq, p]) => !isOwner(cfg, qq) && qq !== String(cfg.botQQ) && !['faded', 'gone'].includes(p.status))
    .filter(([, p]) => recent(p.privIn, now, ACTIVE_DAYS).length > 0 || (p.status === 'friend' && now - (p.addedAt || 0) < NEW_GRACE_DAYS * DAY))
    .map(([qq]) => qq)
}

/** 正在邀请 / 等对方加的人数。 */
export function pendingInvites(state) {
  return Object.values(state.people).filter((p) => p.status === 'inviting' || p.status === 'invited').length
}

/**
 * 候选名单（给她自己挑，不替她决定）：最近 14 天直接找过她 minHits 次以上、群在白名单、群冷却过了、
 * 还不是好友、没在冷却。按来往多少排，最多 8 个。friends = 已经是好友的 QQ 号集合。
 */
export function listCandidates(state, cfg, now = Date.now(), { friends = new Set(), muted = () => false } = {}) {
  const c = cfg.circle
  const groups = new Set((cfg.allow?.groups || []).map(String))
  return Object.entries(state.people)
    .filter(([qq, p]) => !isOwner(cfg, qq) && qq !== String(cfg.botQQ) && !friends.has(qq) && (p.status || 'none') === 'none')
    .filter(([, p]) => (p.cooldownUntil || 0) <= now && p.groupId && groups.has(String(p.groupId)) && !muted(`group:${p.groupId}`))
    .filter(([, p]) => now - (state.groupAskedAt[p.groupId] || 0) >= c.groupCooldownDays * DAY)
    .map(([qq, p]) => {
      const hits = recent(p.hits, now, ACTIVE_DAYS)
      return { qq, name: p.name || '', groupId: p.groupId, hits: hits.length, days: new Set(hits.map((t) => new Date(t).toDateString())).size, last: hits[hits.length - 1] || 0 }
    })
    .filter((x) => x.hits >= c.minHits)
    .sort((a, b) => b.hits - a.hits || b.last - a.last)
    .slice(0, CANDIDATES_MAX)
}

/** 她想邀请某人时的防骚扰检查（不判断「该不该」，只管上限）。返回 { ok, message }。 */
export function canInvite(state, cfg, { qq, groupId }, now = Date.now(), { friends = null } = {}) {
  const id = String(qq || '').replace(/\D/g, '')
  if (!/^\d{5,12}$/.test(id)) return { ok: false, message: 'QQ 号不对' }
  if (isOwner(cfg, id) || id === String(cfg.botQQ)) return { ok: false, message: '不用邀请这个号' }
  if (!(cfg.allow?.groups || []).map(String).includes(String(groupId))) return { ok: false, message: '只能在白名单群里邀请' }
  const p = state.people[id] || {}
  if (friends?.has(id) || p.status === 'friend' || p.status === 'faded') return { ok: false, message: '你们已经是好友了' }
  if (p.status === 'gone') return { ok: false, message: 'ta 之前把你删了，别再邀请了' }
  if (p.status === 'invited') return { ok: false, message: '已经邀请过 ta 了，等 ta 来加你' }
  if ((p.cooldownUntil || 0) > now && p.declined) return { ok: false, message: '上次邀请 ta 没来加，过阵子再说吧' }
  const c = cfg.circle
  if (now - (state.groupAskedAt[String(groupId)] || 0) < c.groupCooldownDays * DAY) return { ok: false, message: `这个群最近邀请过人了，${c.groupCooldownDays} 天内别再在这个群要好友，免得像在刷人` }
  const active = activeFriends(state, cfg, now).length
  if (active + pendingInvites(state) >= c.max) return { ok: false, message: `你的朋友已经够多了（活跃 ${active} 个，还有 ${pendingInvites(state)} 个在等对方加），先好好处现在的朋友` }
  return { ok: true, id }
}

/** 她挑人的回答：{"pick": "QQ号" 或 "none", "reason": "..."}；读不懂返回 null。 */
export function parsePick(text) {
  const m = String(text || '').match(/\{[\s\S]*?\}/)
  if (!m) return null
  try {
    const j = JSON.parse(m[0])
    const pick = String(j.pick ?? '').trim()
    if (!pick) return null
    return { pick: /^none$/i.test(pick) ? null : pick.replace(/\D/g, ''), reason: String(j.reason || '').trim().slice(0, 60) }
  } catch (error) { return null }
}

/** 她回顾后的回答：{"keep": true/false, "reason": "..."}；读不懂返回 null（当作继续）。 */
export function parseReview(text) {
  const m = String(text || '').match(/\{[\s\S]*?\}/)
  if (!m) return null
  try {
    const j = JSON.parse(m[0])
    if (typeof j.keep !== 'boolean') return null
    return { keep: j.keep, reason: String(j.reason || '').trim().slice(0, 60) }
  } catch (error) { return null }
}

export default {
  id: 'circle',
  name: '交友圈',
  version: '1.0.0',
  description: '自己在白名单群里交朋友：邀请聊得来的群友加她、自动通过，活跃朋友维持在设定人数，并自己决定和谁继续来往',
  tab: 'access',
  setup(api) {
    const { hub, onebot, mutes } = api.core
    const file = () => api.dataDir('circle.json')
    const load = () => {
      try {
        if (!existsSync(file())) return emptyState()
        const j = JSON.parse(readFileSync(file(), 'utf8'))
        return { ...emptyState(), ...j, people: j.people || {}, groupAskedAt: j.groupAskedAt || {} }
      } catch (error) { return emptyState() }
    }
    const save = (s) => { try { writeFileSync(file(), JSON.stringify(s)) } catch (error) { api.log.warn('存交友圈出错：', error.message) } }
    const on = () => { const cfg = api.config(); return cfg.enabled && cfg.circle?.enabled && cfg.ownerQQ }
    const person = (s, qq) => (s.people[qq] = s.people[qq] || { status: 'none', hits: [], privIn: [], privOut: [] })
    const tellOwner = (text) => { const cfg = api.config(); if (cfg.ownerQQ) api.sendText(`private:${cfg.ownerQQ}`, text).catch(() => {}) }
    const groupLabel = (gid) => { try { const n = hub.groupName?.(gid); return n && n !== String(gid) ? `「${n}」` : `群 ${gid}` } catch (error) { return `群 ${gid}` } }

    // ---- 记账：谁在群里直接找她、私聊来往 ----
    api.on('activity', (a) => {
      if (!a || !a.chatId) return
      const cfg = api.config()
      if (!cfg.circle?.enabled) return
      const now = Date.now()
      const s = load()
      let dirty = false
      if (a.kind === 'in' && a.userId && !a.owner && String(a.userId) !== String(cfg.botQQ)) {
        const p = person(s, String(a.userId))
        if (a.nickname) p.name = String(a.nickname).slice(0, 30)
        if (a.chatId.startsWith('group:') && a.direct) {
          p.hits = keepRecent([...(p.hits || []), now], now)
          p.groupId = a.chatId.slice(6)
          dirty = true
        } else if (a.chatId.startsWith('private:')) {
          p.privIn = keepRecent([...(p.privIn || []), now], now)
          dirty = true
        }
      }
      if (a.kind === 'out' && a.chatId.startsWith('private:')) {
        const qq = a.chatId.slice(8)
        if (!isOwner(cfg, qq) && s.people[qq]) { s.people[qq].privOut = keepRecent([...(s.people[qq].privOut || []), now], now); dirty = true }
      }
      if (dirty) save(s)
    })

    // ---- 她邀请过的人来加她：自动通过 ----
    const accepting = new Set()
    async function accept(qq, flag) {
      const cfg = api.config()
      const s = load()
      const p = s.people[qq]
      if (!p) return
      if (cfg.dryRun) {
        api.log.info(`交友圈（试运行）：本来要自动通过 ${p.name || qq}（${qq}）的好友申请`)
        return
      }
      accepting.add(qq)
      try {
        await onebot.call('set_friend_add_request', { flag, approve: true }, { timeoutMs: 15000 })
      } catch (error) {
        accepting.delete(qq)
        api.log.warn(`交友圈：自动通过 ${qq} 没成功：${error.message}`)
        tellOwner(`${p.name || qq}（QQ ${qq}）来加我了，是我邀请的，但我没通过成功（${error.message}）。你可以让我再试一次「通过 ${qq}」。`)
        return
      }
      const now = Date.now()
      const s2 = load()
      Object.assign(person(s2, qq), { status: 'friend', statusAt: now, addedAt: now, reviewedAt: now })
      save(s2)
      api.setConfig((cur) => {
        const priv = (cur.allow?.private || []).map(String)
        const talk = (cur.speakUp?.allow || []).map(String)
        return {
          ...cur,
          allow: { ...cur.allow, private: priv.includes(qq) ? priv : [...priv, qq] },
          speakUp: { ...cur.speakUp, allow: talk.includes(qq) ? talk : [...talk, qq] },
        }
      })
      api.log.info(`交友圈：自动通过 ${p.name || qq}（${qq}）`)
      tellOwner(`我交了个新朋友：${p.name || 'QQ ' + qq}（QQ ${qq}），是在${groupLabel(p.groupId)}里认识的，我邀请 ta 加我的～已经放进私聊白名单了。`)
      api.later(60_000, async () => {
        accepting.delete(qq)
        if (!on()) return
        const name = p.name || '对方'
        const prompt = `【系统提醒，不是对方说的话】你刚和「${name}」加上好友，是你在${groupLabel(p.groupId)}里邀请 ta 的。主动打个招呼吧，自然一点，一两句就好；只说你们之间的事，别提主人或别人的私事。`
        await hub.pushToSession({ chatId: `private:${qq}`, kind: 'private', userId: qq, nickname: name }, [{ type: 'text', text: prompt }], '').catch((error) => api.log.warn('交友圈打招呼出错：', error.message))
      })
    }

    api.on('onebot', (ev) => {
      if (!ev || ev.post_type !== 'request' || ev.request_type !== 'friend' || !ev.flag || !ev.user_id) return
      const cfg = api.config()
      if (!on() || !cfg.circle.autoAccept) return
      const qq = String(ev.user_id)
      const p = load().people[qq]
      if (!p || !['inviting', 'invited'].includes(p.status) || accepting.has(qq)) return
      accept(qq, String(ev.flag)).catch((error) => api.log.warn('交友圈自动通过出错：', error.message))
    })

    // ---- 淡下来 ----
    function fade(qq, reason, { notify = true } = {}) {
      const s = load()
      const p = s.people[qq]
      if (!p || p.status !== 'friend') return { ok: false, message: '这不是交友圈里的朋友' }
      Object.assign(p, { status: 'faded', statusAt: Date.now(), fadeReason: reason })
      save(s)
      api.setConfig((cur) => ({ ...cur, speakUp: { ...cur.speakUp, allow: (cur.speakUp?.allow || []).map(String).filter((x) => x !== qq) } }))
      api.log.info(`交友圈：和 ${p.name || qq}（${qq}）淡下来了：${reason}`)
      if (notify) tellOwner(`我和 ${p.name || 'QQ ' + qq}（QQ ${qq}）好像不太聊得来${reason ? '：' + reason : ''}。以后我不主动找 ta 了，ta 来找我还是会好好回。`)
      return { ok: true, message: `好，以后不主动找 ${p.name || qq} 了；对方来找你时照常回` }
    }

    // ---- 定时：收尾过期邀请、物色新朋友、回顾老朋友 ----
    async function knownFriends() {
      try {
        const list = await onebot.call('get_friend_list', {}, { timeoutMs: 15000 })
        return new Set((Array.isArray(list) ? list : []).map((x) => String(x?.user_id || '')).filter(Boolean))
      } catch (error) { return null }
    }

    /**
     * 被删好友：网关没有「被删」通知，只能对比好友列表。交友圈里的朋友不在列表里了 → 记为 gone，
     * 移出私聊 / 主动搭话白名单，告诉主人。刚加上 10 分钟内的不算（列表可能还没刷新）。
     */
    function detectGone(s, friends, now) {
      const gone = []
      for (const [qq, p] of Object.entries(s.people)) {
        if (!['friend', 'faded'].includes(p.status) || friends.has(qq) || now - (p.addedAt || 0) < 10 * 60000) continue
        Object.assign(p, { status: 'gone', statusAt: now })
        gone.push(qq)
      }
      if (!gone.length) return gone
      api.setConfig((cur) => ({
        ...cur,
        allow: { ...cur.allow, private: (cur.allow?.private || []).map(String).filter((x) => !gone.includes(x)) },
        speakUp: { ...cur.speakUp, allow: (cur.speakUp?.allow || []).map(String).filter((x) => !gone.includes(x)) },
      }))
      for (const qq of gone) {
        const p = s.people[qq]
        api.log.info(`交友圈：${p.name || qq}（${qq}）不在好友列表里了（被删了）`)
        tellOwner(`${p.name || 'QQ ' + qq}（QQ ${qq}）把我删了……已经从私聊白名单里拿掉了，我也不会再邀请 ta。`)
      }
      return gone
    }

    function expire(s, now) {
      let dirty = false
      for (const p of Object.values(s.people)) {
        if (p.status === 'invited' && now - p.statusAt >= INVITE_WAIT_DAYS * DAY) { Object.assign(p, { status: 'none', statusAt: now, declined: true, cooldownUntil: now + INVITE_RETRY_DAYS * DAY }); dirty = true }
      }
      return dirty
    }

    async function scout(now) {
      const cfg = api.config()
      const s = load()
      const active = activeFriends(s, cfg, now).length
      if (active >= cfg.circle.min || active + pendingInvites(s) >= cfg.circle.max) return null
      if (pendingInvites(s) > 0) return null // 一次只邀请一个，等结果
      const friends = await knownFriends()
      if (!friends) return null
      const list = listCandidates(s, cfg, now, { friends, muted: (id) => Boolean(mutes?.muted?.(id)) })
        .filter((x) => !cfg.group?.addressedOnly || isFamilyGroup(cfg, x.groupId))
      if (!list.length) return null
      // 名单交给她自己挑：想和谁交朋友、还是谁都不想，由她判断
      const dislikes = (qq) => Boolean(api.use('memory')?.dislikes?.(qq))
      const ago = (t) => { const d = Math.round((now - t) / DAY); return d <= 0 ? '今天' : `${d} 天前` }
      const lines = list.map((x) => `- ${x.name || '（没名字）'}，QQ ${x.qq}，在${groupLabel(x.groupId)}：最近两周有 ${x.days} 天找你聊过、共 ${x.hits} 次，上次是${ago(x.last)}${dislikes(x.qq) ? '（你记忆里标了讨厌 ta）' : ''}`)
      const prompt = `【系统提醒，不是谁说的话】你现在经常聊的朋友有 ${active} 个（你自己想保持在 ${cfg.circle.min}~${cfg.circle.max} 个左右）。下面是最近在群里常找你说话、还不是好友的人：\n${lines.join('\n')}\n可以查查你对他们的记忆，想想有没有谁是你真心想交朋友的。宁缺毋滥：都不想就选 none，不用为了凑数。只回一行 JSON：{"pick": "QQ号" 或 "none", "reason": "十几个字的理由"}`
      let answer = ''
      try { answer = await api.think(prompt, { title: '想不想交个新朋友' }) } catch (error) { api.log.warn('交友圈挑人出错：', error.message); return null }
      const r = parsePick(answer)
      const chosen = r?.pick ? list.find((x) => x.qq === r.pick) : null
      const s2 = load()
      // 这次给她看过、没被挑中的人，过两天再给她看
      for (const x of list) if (x !== chosen && s2.people[x.qq]) s2.people[x.qq].cooldownUntil = now + SKIP_RETRY_DAYS * DAY
      save(s2)
      if (!chosen) { api.log.info(`交友圈：看了 ${list.length} 个人，这次谁都不想加${r?.reason ? '：' + r.reason : ''}`); return null }
      const name = chosen.name || `QQ ${chosen.qq}`
      api.log.info(`交友圈：活跃朋友 ${active} 个，她想和 ${name}（${chosen.qq}）交朋友：${r.reason}`)
      const push = `【系统提醒，不是群友说的话】你刚才想过，想和群友「${name}」（QQ ${chosen.qq}）交个朋友（${r.reason || '你觉得合得来'}）。如果现在时机合适，先用 qq_invite_friend 登记，登记成功再找个自然的方式 @ta 邀请 ta 加你好友（说一次就好，别强求、别提系统）。时机不合适或者改主意了，就只回 [沉默]，以后聊着合适时再说。`
      await hub.pushToSession({ chatId: `group:${chosen.groupId}`, kind: 'group', groupId: chosen.groupId, userId: chosen.qq, nickname: name }, [{ type: 'text', text: push }], '')
      return chosen.qq
    }

    async function review(now) {
      const cfg = api.config()
      const s = load()
      const every = cfg.circle.reviewDays * DAY
      const active = activeFriends(s, cfg, now)
      const due = Object.entries(s.people)
        .filter(([, p]) => p.status === 'friend' && now - (p.addedAt || 0) >= every && now - (p.reviewedAt || 0) >= every)
        .sort((a, b) => (a[1].reviewedAt || 0) - (b[1].reviewedAt || 0))[0]
      if (!due) return null
      const [qq, p] = due
      p.reviewedAt = now
      save(s)
      const ago = (list) => (list?.length ? `${Math.max(0, Math.round((now - list[list.length - 1]) / DAY))} 天前` : '没有过')
      const crowd = active.length > cfg.circle.max ? `你现在活跃的朋友有 ${active.length} 个，比你想要的（${cfg.circle.min}~${cfg.circle.max} 个）多，没那么投缘的可以淡下来。` : ''
      const prompt = `【系统提醒，不是谁说的话】回顾一下你和朋友「${p.name || qq}」（QQ ${qq}）的相处：你们是在${groupLabel(p.groupId)}认识的，加上好友 ${Math.round((now - p.addedAt) / DAY)} 天了；最近 7 天 ta 私聊找你 ${recent(p.privIn, now, 7).length} 次，你说了 ${recent(p.privOut, now, 7).length} 句；ta 上次找你是${ago(p.privIn)}。${crowd}可以查查你对 ta 的记忆，想想你们聊得开不开心、你还想不想继续和 ta 来往。只回一行 JSON：{"keep": true 或 false, "reason": "十几个字的理由"}`
      let answer = ''
      try { answer = await api.think(prompt, { title: `回顾和 ${p.name || qq} 的友谊` }) } catch (error) { api.log.warn('交友圈回顾出错：', error.message); return null }
      const r = parseReview(answer)
      if (!r) { api.log.debug?.(`交友圈：回顾 ${qq} 没读懂她的回答，先当继续`); return { qq, keep: true } }
      if (r.keep) { api.log.info(`交友圈：还想和 ${p.name || qq}（${qq}）继续来往：${r.reason}`); return { qq, keep: true } }
      fade(qq, r.reason)
      return { qq, keep: false }
    }

    let busy = false
    async function tick(now = Date.now(), { force = false } = {}) {
      if (busy || !on()) return null
      const cfg = api.config()
      const h = new Date(now).getHours()
      if (!force && !(h >= (cfg.speakUp?.awakeFrom ?? 8) && h < (cfg.speakUp?.awakeTo ?? 23))) return null
      busy = true
      try {
        const s = load()
        let dirty = expire(s, now)
        if (force || now - (s.lastGoneCheck || 0) >= 3600000) {
          const friends = await knownFriends()
          if (friends) { s.lastGoneCheck = now; dirty = true; detectGone(s, friends, now) }
        }
        if (dirty) save(s)
        const reviewed = await review(now)
        if (!force && now - (load().lastScout || 0) < SCOUT_EVERY_MS) return { reviewed, invited: null }
        const s2 = load()
        s2.lastScout = now
        save(s2)
        const invited = await scout(now)
        return { reviewed, invited }
      } finally { busy = false }
    }
    api.every(10 * 60_000, () => tick(), '交友圈')

    // ---- 工具 ----
    api.tool(({ chat, sessionId }) => {
      const cfg = api.config()
      if (!cfg.circle?.enabled) return []
      if (chat.kind === 'group' && chat.groupId) {
        const groupId = String(chat.groupId)
        return [defineTool({
          name: 'qq_invite_friend',
          description: '你自己没法加别人好友，只能请对方加你。你真心想和这个群里的某个人交朋友时（聊得来、对方也友好），先用它登记，登记成功了再在群里邀请对方加你好友；登记过的人来加你会自动通过。登记失败（比如最近在这个群邀请过人、朋友已经够多）就别开口邀请。qq 填对方的 QQ 号，reason 写一句为什么想交这个朋友。',
          properties: { qq: str('对方的 QQ 号'), reason: str('为什么想交这个朋友，一句话') },
          required: ['qq', 'reason'],
          execute: async ({ qq, reason }) => {
            const c = api.config()
            if (!c.circle?.enabled) return { ok: false, message: '交友圈在面板里关掉了' }
            const now = Date.now()
            const s = load()
            const check = canInvite(s, c, { qq, groupId }, now, { friends: await knownFriends() })
            if (!check.ok) return check
            const p = person(s, check.id)
            const name = p.name || `QQ ${check.id}`
            if (c.dryRun) return { ok: true, message: `试运行：本来要登记邀请 ${name}（不会自动通过申请）` }
            Object.assign(p, { status: 'invited', statusAt: now, invitedAt: now, groupId, inviteReason: String(reason || '').trim().slice(0, 60) })
            s.groupAskedAt[groupId] = now
            save(s)
            api.log.info(`交友圈：在${groupLabel(groupId)}邀请 ${name}（${check.id}）：${p.inviteReason}`)
            return { ok: true, message: `登记好了。现在可以邀请 ${name} 加你好友；ta ${INVITE_WAIT_DAYS} 天内来加会自动通过` }
          },
        })]
      }
      if (chat.kind !== 'private') return []
      const tools = []
      const qq = String(chat.userId || '')
      if (qq && !isOwner(cfg, qq) && load().people[qq]?.status === 'friend') tools.push(defineTool({
        name: 'qq_friendship',
        description: '决定和眼前这位朋友「淡下来」：以后不再主动找 ta，ta 来找你时照常回。只在你真的觉得聊不下去时用（话不投机、对方让你不舒服、总是敷衍），别因为一次小别扭就用。reason 写一句理由（会告诉主人）。',
        properties: { reason: str('为什么不想继续，一句话') },
        required: ['reason'],
        execute: async ({ reason }) => fade(qq, String(reason || '').trim().slice(0, 60)),
      }))
      if (isOwner(cfg, qq)) tools.push(defineTool({
        name: 'qq_circle_status',
        description: '主人私聊专用：看你的交友圈——现在活跃的朋友、正在邀请的人、淡下来的朋友。主人问「你最近交了哪些朋友」时用。',
        execute: async () => {
          if (!hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '只有主人私聊才能看' }
          const c = api.config()
          const s = load()
          const now = Date.now()
          const name = (q) => `${s.people[q]?.name || 'QQ ' + q}（${q}）`
          const active = activeFriends(s, c, now)
          const inviting = Object.entries(s.people).filter(([, p]) => ['inviting', 'invited'].includes(p.status)).map(([q]) => q)
          const faded = Object.entries(s.people).filter(([, p]) => p.status === 'faded').map(([q, p]) => `${name(q)}${p.fadeReason ? '：' + p.fadeReason : ''}`)
          const gone = Object.entries(s.people).filter(([, p]) => p.status === 'gone').map(([q]) => name(q))
          return { ok: true, message: [
            `把你删了的：${gone.join('、') || '没有'}`,
            `活跃朋友 ${active.length} 个（目标 ${c.circle.min}~${c.circle.max}）：${active.map(name).join('、') || '还没有'}`,
            `正在邀请：${inviting.map(name).join('、') || '没有'}`,
            `淡下来的：${faded.join('；') || '没有'}`,
          ].join('\n') }
        },
      }))
      return tools
    })

    api.rule((kind, cfg) => (cfg.circle?.enabled && kind === 'social'
      ? '你会自己交朋友，和谁交、要不要交都由你自己决定：在群里遇到真心合得来的人，可以先用 qq_invite_friend 登记，再邀请对方加你好友（你没法主动加别人）；对方来加会自动通过。不用为了凑数去加人。私聊里觉得和某位朋友实在聊不下去，可以用 qq_friendship 淡下来。'
      : ''))

    return {
      tick,
      state: load,
      /** 这个 QQ 的好友申请是不是交友圈在处理（好友申请模块据此不再重复打扰主人）。 */
      expects(qq) {
        const cfg = api.config()
        if (!on() || !cfg.circle.autoAccept || cfg.dryRun) return false // 试运行不真通过，照旧交给主人
        const p = load().people[String(qq)]
        return Boolean(p && (['inviting', 'invited'].includes(p.status) || (p.status === 'friend' && Date.now() - (p.addedAt || 0) < 10 * 60000)))
      },
    }
  },
}
