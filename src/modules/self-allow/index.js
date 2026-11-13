// 内置模块：自己管白名单（默认关）。白名单还是那张表（谁能和她说话、她能往哪发），只是改由她自己来增删。
//
//  · 私聊：有人成了她的好友（不管是谁加的），她看看对方是谁、查查记忆，自己决定要不要私聊往来；
//    已经是好友但不在名单里的，也会一个个过一遍。不想的过 30 天再想一次。
//  · 群邀请：有人邀请她进群，她自己决定去不去（通过 / 拒绝邀请）。
//  · 群里开口：进了群先不说话，旁听 observeHours 小时（收原始消息做样本），再决定要不要在这个群说话（加进群白名单）；
//    决定不说话的群过 14 天再旁听一次。被踢出群就从名单里拿掉。
//  · 主动找谁：答应私聊时她一并决定要不要偶尔主动找对方聊（主动搭话白名单 speakUp.allow）；
//    已经在私聊名单里、还没想过这件事的人也会过一遍（不想的 30 天后再想）；聊着聊着也能用 qq_reach_out 改主意。
//  · 退出：在私聊或群里，她觉得不想再理这个人 / 这个群了，用 qq_leave_whitelist 自己移出。
// 每次增删都私聊告诉主人一声。试运行时只记日志，不改名单、不处理邀请（邀请照常交给主人）。

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { defineTool, str } from '../../tools/tools.js'
import { isOwner, isOwnerSpaceChat, ownerNameOf } from '../../chat/access.js'

const DAY = 86400000
const HOUR = 3600000
const PERSON_RETRY_DAYS = 30
const GROUP_RETRY_DAYS = 14
const SAMPLES = 40
const SCAN_EVERY_MS = HOUR

export const emptyState = () => ({ people: {}, groups: {}, queue: [], reachQueue: [], lastScan: 0 })

/** 她的决定：找回答里第一个带 key 布尔值的 JSON；读不懂返回 null（当作这次不改）。 */
export function parseDecision(text, key) {
  const all = String(text || '').match(/\{[^{}]*\}/g) || []
  for (const raw of all) {
    try {
      const j = JSON.parse(raw)
      if (typeof j[key] === 'boolean') return { yes: j[key], reach: j.reach === true, reason: String(j.reason || '').trim().slice(0, 60) }
    } catch (error) { /* 下一个 */ }
  }
  return null
}

/** 原始群消息 → 一行样本：「昵称：文字」 */
export function sampleOf(ev) {
  const who = String(ev.sender?.card || ev.sender?.nickname || ev.user_id || '有人').slice(0, 16)
  let text = ''
  if (Array.isArray(ev.message)) text = ev.message.map((s) => (s?.type === 'text' ? s.data?.text || '' : s?.type === 'image' ? '[图片]' : s?.type === 'face' ? '[表情]' : '')).join('')
  else text = String(ev.raw_message || ev.message || '').replace(/\[CQ:image[^\]]*\]/g, '[图片]').replace(/\[CQ:[^\]]*\]/g, '')
  text = text.replace(/\s+/g, ' ').trim().slice(0, 80)
  return text ? `${who}：${text}` : ''
}

export default {
  id: 'self-allow',
  name: '自己管白名单',
  version: '1.0.0',
  description: '让她自己决定和谁私聊、进不进群、在哪个群说话；每次改动都告诉主人',
  tab: 'access',
  setup(api) {
    const { onebot } = api.core
    const file = () => api.dataDir('self-allow.json')
    const load = () => {
      try {
        if (!existsSync(file())) return emptyState()
        const j = JSON.parse(readFileSync(file(), 'utf8'))
        return { ...emptyState(), ...j, people: j.people || {}, groups: j.groups || {}, queue: Array.isArray(j.queue) ? j.queue : [], reachQueue: Array.isArray(j.reachQueue) ? j.reachQueue : [] }
      } catch (error) { return emptyState() }
    }
    const save = (s) => { try { writeFileSync(file(), JSON.stringify(s)) } catch (error) { api.log.warn('存白名单决定出错：', error.message) } }
    const on = () => { const cfg = api.config(); return Boolean(cfg.enabled && cfg.selfAllow?.enabled && cfg.ownerQQ) }
    const tellOwner = (text) => { const cfg = api.config(); if (cfg.ownerQQ) api.sendText(`private:${cfg.ownerQQ}`, text).catch(() => {}) }
    const inList = (kind, id) => ((kind === 'group' ? api.config().allow?.groups : api.config().allow?.private) || []).map(String).includes(String(id))
    const setList = (kind, id, add) => api.setConfig((cur) => {
      const key = kind === 'group' ? 'groups' : 'private'
      const list = (cur.allow?.[key] || []).map(String)
      const next = add ? [...new Set([...list, String(id)])] : list.filter((x) => x !== String(id))
      return { ...cur, allow: { ...cur.allow, [key]: next } }
    })
    const inReach = (id) => (api.config().speakUp?.allow || []).map(String).includes(String(id))
    const setReach = (id, add) => api.setConfig((cur) => {
      const list = (cur.speakUp?.allow || []).map(String)
      const next = add ? [...new Set([...list, String(id)])] : list.filter((x) => x !== String(id))
      return { ...cur, speakUp: { ...cur.speakUp, allow: next } }
    })
    const think = async (prompt, title) => {
      try { return await api.think(prompt, { title }) } catch (error) { api.log.warn(`${title}出错：`, error.message); return '' }
    }
    const groupInfo = async (gid) => {
      try { const g = await onebot.call('get_group_info', { group_id: Number(gid) }, { timeoutMs: 8000 }); return { name: String(g?.group_name || ''), members: Number(g?.member_count) || 0 } } catch (error) { return { name: '', members: 0 } }
    }
    const groupLabel = (gid, name) => (name ? `群「${name}」（${gid}）` : `群 ${gid}`)

    // ---------- 私聊 ----------
    function queuePerson(qq) {
      const cfg = api.config()
      const id = String(qq || '')
      if (!/^\d{5,12}$/.test(id) || isOwner(cfg, id) || id === String(cfg.botQQ) || inList('private', id)) return
      const s = load()
      if (!s.queue.includes(id)) { s.queue.push(id); save(s) }
    }

    async function decidePerson(qq) {
      const cfg = api.config()
      const s = load()
      s.queue = s.queue.filter((x) => x !== qq)
      save(s)
      if (inList('private', qq) || isOwner(cfg, qq)) return null
      let nick = ''
      try { nick = String((await onebot.call('get_stranger_info', { user_id: Number(qq) }, { timeoutMs: 8000 }))?.nickname || '') } catch (error) { /* 没名字也能判断 */ }
      const circle = api.use?.('circle')?.state?.()?.people?.[qq]
      const how = circle?.groupId ? `你们在群 ${circle.groupId} 里聊过${circle.status === 'invited' || circle.status === 'friend' ? '，是你邀请 ta 加你的' : ''}` : '你们之前好像没怎么聊过'
      const prompt = `【系统提醒，不是谁说的话】${nick ? `「${nick}」` : '有个人'}（QQ ${qq}）现在是你的 QQ 好友了，${how}。要不要和 ta 私聊往来，由你自己决定：答应了，ta 私聊你时你会回；不答应，ta 发的私聊你就看不到。答应的话，再想想要不要偶尔主动去找 ta 聊天。可以查查你对 ta 的记忆再想。只回一行 JSON：{"allow": true 或 false, "reach": 要不要主动找 ta（true 或 false）, "reason": "十几个字的理由"}`
      const r = parseDecision(await think(prompt, `要不要和 ${nick || qq} 私聊`), 'allow')
      if (!r) return null
      const s2 = load()
      const reach = r.yes && r.reach
      s2.people[qq] = { decided: r.yes ? 'allow' : 'deny', at: Date.now(), reason: r.reason, name: nick, ...(r.yes ? { reach, reachAt: Date.now() } : {}) }
      save(s2)
      const who = `${nick || 'QQ ' + qq}（QQ ${qq}）`
      if (api.config().dryRun) { api.log.info(`自己管白名单（试运行）：本来要${r.yes ? '让' : '不让'} ${who} 私聊${reach ? '，还会主动找 ta' : ''}：${r.reason}`); return r }
      if (r.yes) {
        setList('private', qq, true)
        if (reach) setReach(qq, true)
        tellOwner(`我把 ${who} 加进私聊白名单了${reach ? '，也会偶尔主动找 ta 聊' : ''}：${r.reason}`)
      } else tellOwner(`${who} 加了我好友，不过我先不和 ta 私聊：${r.reason}`)
      api.log.info(`自己管白名单：${r.yes ? '允许' : '不允许'} ${who} 私聊：${r.reason}`)
      return r
    }

    /** 已经在私聊名单里的人：要不要偶尔主动找 ta。 */
    async function decideReach(qq) {
      const s = load()
      s.reachQueue = s.reachQueue.filter((x) => x !== qq)
      save(s)
      if (!inList('private', qq) || inReach(qq)) return null
      const p = s.people[qq] || {}
      const name = p.name || `QQ ${qq}`
      const prompt = `【系统提醒，不是谁说的话】${name}（QQ ${qq}）在你的私聊名单里，ta 找你时你会回。要不要也偶尔主动去找 ta 聊天，由你自己决定。可以查查你对 ta 的记忆、你们最近聊得怎么样再想；不熟、不想打扰就别找。只回一行 JSON：{"reach": true 或 false, "reason": "十几个字的理由"}`
      const r = parseDecision(await think(prompt, `要不要主动找 ${name}`), 'reach')
      if (!r) return null
      const s2 = load()
      s2.people[qq] = { ...(s2.people[qq] || {}), reach: r.yes, reachAt: Date.now(), reachReason: r.reason }
      save(s2)
      if (api.config().dryRun) { api.log.info(`自己管白名单（试运行）：本来要${r.yes ? '' : '不'}主动找 ${name}：${r.reason}`); return r }
      if (r.yes) { setReach(qq, true); tellOwner(`以后我会偶尔主动找 ${name}（QQ ${qq}）聊天：${r.reason}`) }
      api.log.info(`自己管白名单：${r.yes ? '会' : '不'}主动找 ${name}（${qq}）：${r.reason}`)
      return r
    }

    // ---------- 群邀请 ----------
    async function decideInvite(ev) {
      const cfg = api.config()
      const gid = String(ev.group_id || '')
      const inviter = String(ev.user_id || '')
      const info = await groupInfo(gid)
      const rel = isOwner(cfg, inviter) ? `邀请你的是${ownerNameOf(cfg, inviter)}（你的主人）` : inList('private', inviter) ? '邀请你的是你私聊白名单里的朋友' : '邀请你的人你不太熟'
      const prompt = `【系统提醒，不是谁说的话】QQ ${inviter} 邀请你进${groupLabel(gid, info.name)}${info.members ? `，群里有 ${info.members} 人` : ''}；${rel}${ev.comment ? `，附言「${String(ev.comment).slice(0, 60)}」` : ''}。去不去由你自己决定。进群后你会先旁听一阵，再决定要不要在里面说话。只回一行 JSON：{"join": true 或 false, "reason": "十几个字的理由"}`
      const r = parseDecision(await think(prompt, `要不要进群 ${gid}`), 'join')
      if (!r) { tellOwner(`QQ ${inviter} 邀请我进${groupLabel(gid, info.name)}，我没想好，你帮我看看？可以让我列出待处理的加群申请。`); return null }
      try {
        await onebot.call('set_group_add_request', { flag: String(ev.flag), sub_type: 'invite', approve: r.yes }, { timeoutMs: 15000 })
      } catch (error) {
        tellOwner(`QQ ${inviter} 邀请我进${groupLabel(gid, info.name)}，我想${r.yes ? '去' : '拒绝'}，但没处理成功（${error.message}）。`)
        return null
      }
      tellOwner(r.yes ? `我接受了 QQ ${inviter} 的邀请，进${groupLabel(gid, info.name)}了：${r.reason}。我先旁听一阵再决定要不要说话。` : `QQ ${inviter} 邀请我进${groupLabel(gid, info.name)}，我拒绝了：${r.reason}`)
      api.log.info(`自己管白名单：${r.yes ? '接受' : '拒绝'}进群 ${gid}：${r.reason}`)
      if (r.yes) startObserve(gid, info.name)
      return r
    }

    // ---------- 群里开不开口 ----------
    function startObserve(gid, name = '') {
      if (inList('group', gid)) return
      const s = load()
      const g = s.groups[gid]
      if (g && (g.status === 'observing' || (g.status === 'quiet' && Date.now() - (g.decidedAt || 0) < GROUP_RETRY_DAYS * DAY))) return
      s.groups[gid] = { status: 'observing', since: Date.now(), name: name || g?.name || '', count: 0, samples: [] }
      save(s)
      api.log.info(`自己管白名单：开始旁听群 ${gid}`)
    }

    async function decideGroup(gid) {
      const cfg = api.config()
      const s = load()
      const g = s.groups[gid]
      if (!g) return null
      const info = g.name ? { name: g.name } : await groupInfo(gid)
      const talk = g.samples.length ? g.samples.join('\n') : '（这段时间群里没人说话）'
      const prompt = `【系统提醒，不是谁说的话】你在${groupLabel(gid, info.name)}旁听了 ${Math.round((Date.now() - g.since) / HOUR)} 小时，群里一共说了 ${g.count} 条消息，最近的是：\n${talk}\n要不要在这个群里说话（有人叫你会回，偶尔也会接话），由你自己决定。只回一行 JSON：{"speak": true 或 false, "reason": "十几个字的理由"}`
      const r = parseDecision(await think(prompt, `要不要在群 ${gid} 说话`), 'speak')
      if (!r) return null
      const s2 = load()
      s2.groups[gid] = { ...g, name: info.name || g.name, status: r.yes ? 'speak' : 'quiet', decidedAt: Date.now(), reason: r.reason, samples: [] }
      save(s2)
      const label = groupLabel(gid, info.name || g.name)
      if (cfg.dryRun) { api.log.info(`自己管白名单（试运行）：本来要${r.yes ? '在' : '不在'}${label}说话：${r.reason}`); return r }
      if (r.yes) { setList('group', gid, true); tellOwner(`我决定在${label}里说话了，已经加进群白名单：${r.reason}`) } else tellOwner(`我在${label}旁听了一阵，先不在里面说话：${r.reason}`)
      api.log.info(`自己管白名单：${r.yes ? '在' : '不在'}${label}说话：${r.reason}`)
      return r
    }

    // ---------- 事件 ----------
    api.on('onebot', (ev) => {
      if (!ev || !on()) return
      const cfg = api.config()
      const bot = String(cfg.botQQ || ev.self_id || '')
      if (ev.post_type === 'notice') {
        if (ev.notice_type === 'friend_add' && ev.user_id) queuePerson(ev.user_id)
        else if (ev.notice_type === 'group_increase' && ev.group_id && String(ev.user_id) === bot) startObserve(String(ev.group_id))
        else if (ev.notice_type === 'group_decrease' && ev.group_id && String(ev.user_id) === bot) {
          const gid = String(ev.group_id)
          const s = load()
          delete s.groups[gid]
          save(s)
          if (inList('group', gid) && !cfg.dryRun) { setList('group', gid, false); tellOwner(`我${ev.sub_type === 'kick_me' ? '被踢出' : '离开了'}群 ${gid}，已经从群白名单里拿掉。`) }
        }
        return
      }
      if (ev.post_type === 'request' && ev.request_type === 'group' && ev.sub_type === 'invite' && ev.flag && !cfg.dryRun) {
        if (isOwner(cfg, ev.user_id)) return // 主人拉的群：好友申请模块直接接受并加白名单，不用她再想、再旁听
        decideInvite(ev).catch((error) => api.log.warn('处理群邀请出错：', error.message))
        return
      }
      if (ev.post_type === 'message' && ev.message_type === 'group' && ev.group_id) {
        const gid = String(ev.group_id)
        const s = load()
        const g = s.groups[gid]
        if (!g || g.status !== 'observing' || String(ev.user_id) === bot) return
        const line = sampleOf(ev)
        g.count = (g.count || 0) + 1
        if (line) g.samples = [...(g.samples || []), line].slice(-SAMPLES)
        save(s)
      }
    })

    // ---------- 定时 ----------
    async function scan(now) {
      const s = load()
      s.lastScan = now
      save(s)
      try {
        const friends = await onebot.call('get_friend_list', {}, { timeoutMs: 15000 })
        const st = load()
        for (const f of Array.isArray(friends) ? friends : []) {
          const qq = String(f?.user_id || '')
          const d = st.people[qq]
          if (d && !(d.decided === 'deny' && now - d.at >= PERSON_RETRY_DAYS * DAY)) continue
          queuePerson(qq)
        }
      } catch (error) { /* 下次再扫 */ }
      {
        const cfg = api.config()
        const st = load()
        for (const qq of (cfg.allow?.private || []).map(String)) {
          if (isOwner(cfg, qq) || inReach(qq) || st.reachQueue.includes(qq)) continue
          const p = st.people[qq]
          if (p && typeof p.reach === 'boolean' && !(p.reach === false && now - (p.reachAt || 0) >= PERSON_RETRY_DAYS * DAY)) continue
          st.reachQueue.push(qq)
        }
        save(st)
      }
      try {
        const groups = await onebot.call('get_group_list', {}, { timeoutMs: 15000 })
        for (const g of Array.isArray(groups) ? groups : []) {
          const gid = String(g?.group_id || '')
          if (gid && !inList('group', gid)) startObserve(gid, String(g?.group_name || ''))
        }
      } catch (error) { /* 下次再扫 */ }
    }

    let busy = false
    async function tick(now = Date.now(), { force = false } = {}) {
      if (busy || !on()) return null
      busy = true
      try {
        const cfg = api.config()
        if (force || now - (load().lastScan || 0) >= SCAN_EVERY_MS) await scan(now)
        const s = load()
        // 一次只想一件事，免得一口气烧很多次模型
        if (s.queue.length) return { person: s.queue[0], result: await decidePerson(s.queue[0]) }
        if (s.reachQueue.length) return { reach: s.reachQueue[0], result: await decideReach(s.reachQueue[0]) }
        const wait = cfg.selfAllow.observeHours * HOUR
        // 旁听期间已经进了群白名单（主人拉的、主人手动加的）：不用再旁听了
        const listed = Object.keys(s.groups).filter((gid) => s.groups[gid].status === 'observing' && inList('group', gid))
        if (listed.length) { for (const gid of listed) s.groups[gid] = { ...s.groups[gid], status: 'speak', decidedAt: now, reason: '已在群白名单', samples: [] }; save(s) }
        const due = Object.entries(s.groups).find(([gid, g]) => g.status === 'observing' && !inList('group', gid) && now - g.since >= wait)
        if (due) return { group: due[0], result: await decideGroup(due[0]) }
        return null
      } finally { busy = false }
    }
    api.every(10 * 60_000, () => tick(), '自己管白名单')

    // ---------- 工具：她自己移出 ----------
    api.tool(({ chat }) => {
      const cfg = api.config()
      if (!cfg.selfAllow?.enabled) return []
      const isOwnerChat = isOwnerSpaceChat(cfg, chat)
      if (isOwnerChat || !['private', 'group'].includes(chat.kind)) return []
      const kind = chat.kind
      const id = String(kind === 'group' ? chat.groupId : chat.userId)
      const tools = []
      if (kind === 'private') tools.push(defineTool({
        name: 'qq_reach_out',
        description: '决定以后要不要偶尔主动找眼前这个人聊天（want=true 会主动找，false 只在 ta 找你时回）。聊着聊着觉得很投缘、想常联系，或者觉得主动找 ta 会打扰 ta 时用。reason 写一句理由（会告诉主人）。',
        properties: { want: { type: 'boolean', description: 'true 以后会主动找 ta；false 不主动找' }, reason: str('为什么，一句话') },
        required: ['want', 'reason'],
        execute: async ({ want, reason }) => {
          const c = api.config()
          if (!c.selfAllow?.enabled) return { ok: false, message: '这个功能在面板里关掉了' }
          if (typeof want !== 'boolean') return { ok: false, message: 'want 要写 true 或 false' }
          const why = String(reason || '').trim().slice(0, 60)
          if (want === inReach(id)) return { ok: true, message: want ? '本来就会主动找 ta' : '本来就不会主动找 ta' }
          if (c.dryRun) return { ok: true, message: `试运行：本来要${want ? '' : '不再'}主动找对方` }
          const s = load()
          s.people[id] = { ...(s.people[id] || {}), reach: want, reachAt: Date.now(), reachReason: why }
          save(s)
          setReach(id, want)
          tellOwner(want ? `以后我会偶尔主动找 QQ ${id} 聊天：${why}` : `以后我不主动找 QQ ${id} 了，ta 找我还会回：${why}`)
          api.log.info(`自己管白名单：${want ? '会' : '不'}主动找 ${id}：${why}`)
          return { ok: true, message: want ? '好，以后会偶尔主动找 ta' : '好，以后不主动找 ta，ta 找你时照常回' }
        },
      }))
      tools.push(defineTool({
        name: 'qq_leave_whitelist',
        description: kind === 'group'
          ? '你不想再在这个群里说话了（话题不合、气氛让你不舒服、总被刷屏骚扰），用它把这个群移出你的群白名单，之后这个群的消息你就看不到了。别因为一次小别扭就用。reason 写一句理由（会告诉主人）。'
          : '你不想再和眼前这个人私聊了（对方骚扰你、让你不舒服、话不投机），用它把 ta 移出私聊白名单，之后 ta 的私聊你就看不到了。别因为一次小别扭就用。reason 写一句理由（会告诉主人）。',
        properties: { reason: str('为什么，一句话') },
        required: ['reason'],
        execute: async ({ reason }) => {
          const c = api.config()
          if (!c.selfAllow?.enabled) return { ok: false, message: '这个功能在面板里关掉了' }
          const why = String(reason || '').trim().slice(0, 60)
          if (!why) return { ok: false, message: '要写一句理由' }
          if (c.dryRun) return { ok: true, message: `试运行：本来要把${kind === 'group' ? '这个群' : '对方'}移出白名单` }
          const s = load()
          if (kind === 'group') s.groups[id] = { ...(s.groups[id] || {}), status: 'quiet', decidedAt: Date.now(), reason: why, samples: [] }
          else s.people[id] = { ...(s.people[id] || {}), decided: 'deny', at: Date.now(), reason: why, reach: false, reachAt: Date.now() }
          save(s)
          setList(kind, id, false)
          if (kind === 'private') setReach(id, false)
          tellOwner(kind === 'group' ? `我不想在群 ${id} 里说话了，已经移出群白名单：${why}` : `我不想再和 QQ ${id} 私聊了，已经移出私聊白名单：${why}`)
          api.log.info(`自己管白名单：移出 ${kind === 'group' ? '群' : 'QQ'} ${id}：${why}`)
          return { ok: true, message: kind === 'group' ? '好，之后这个群的消息你就不看了（这条回复还会发出去，可以道个别，也可以不说）' : '好，之后 ta 的私聊你就不看了（这条回复还会发出去）' }
        },
      }))
      return tools
    })

    api.rule((kind, cfg) => (cfg.selfAllow?.enabled && kind === 'social'
      ? '和谁私聊、主动找谁聊、在哪个群说话是你自己决定的。私聊里想常联系某人、或者觉得主动找 ta 会打扰 ta，可以用 qq_reach_out 改；真不想再理某个人或某个群时，可以用 qq_leave_whitelist 自己移出。'
      : ''))

    return {
      tick,
      state: load,
      /** 群邀请是不是由她自己处理（好友申请模块据此不再存、不再问主人）。 */
      handlesGroupInvites: () => on() && !api.config().dryRun,
    }
  },
}
