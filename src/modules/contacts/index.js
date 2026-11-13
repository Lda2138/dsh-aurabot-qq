// 内置模块：好友 / 加群申请与白名单。
//  · qq_handle_friend_request：通过 / 拒绝别人加她为好友的申请（SnowLuma：set_friend_add_request；被 QQ 过滤的「可能认识的人」走 set_doubt_friends_add_request）。
//  · qq_whitelist：听主人的话把 QQ 号 / 群号加进、移出白名单（allow.private / allow.groups），写进配置并保存。
// 「她主动加别人为好友 / 申请加群」网关做不到：SnowLuma 没有这个接口，维护者明确说公开版不会加（SnowLuma#480）。
//  · qq_wish_contact：所以她想交新朋友、想进新群时，私聊问主人，由主人在机器人号 QQ 上手动加 / 邀请她。
//    每天有次数上限，同一个人 / 群等主人处理前不重复问，主人说「算了」的不再提；加上 / 进群后自动记为完成。
//  · qq_contact_wishes：主人私聊里列出 / 撤销她的心愿。开关和次数在 contactWish（面板「权限」页）。
// 两个工具各一档权限（面板「权限」页）：off 关 / owner 仅主人私聊（默认）/ all 所有人。

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { defineTool, str, bool } from '../../tools/tools.js'
import { profileToolVisible, profilePermits, isOwner, isOwnerSpaceChat, ownerNameOf } from '../../chat/access.js'

const PENDING_MAX = 50
const WISH_MAX = 100
const WISH_DROP_QUIET_MS = 30 * 86400000 // 主人说「算了」后 30 天内不再提
const ID_RE = /^\d{5,12}$/

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString()
const wishLabel = (w) => `${w.kind === 'group' ? '群' : 'QQ'} ${w.id}${w.name ? `（${w.name}）` : ''}`

/**
 * 想加好友 / 想进群的纯判断：返回 { ok, message } 或 { ok: true, wish }。
 * wishes = 已有心愿；known = { friends:Set, groups:Set } 已经是好友 / 已在的群（查不到时为 null）。
 */
export function planWish(cfg, wishes, { kind, id, name, reason }, { now = Date.now(), from = '', known = null } = {}) {
  const k = String(kind || '').trim().toLowerCase()
  if (!['friend', 'group'].includes(k)) return { ok: false, message: 'kind 只能是 friend（加好友）或 group（进群）' }
  const n = cleanId(id)
  if (!n) return { ok: false, message: '号码不对：要 5~12 位数字的 QQ 号 / 群号' }
  const why = String(reason || '').trim().slice(0, 120)
  if (!why) return { ok: false, message: '要写清楚为什么想加（reason），主人要据此决定' }
  if (k === 'friend' && n === String(cfg.botQQ || '')) return { ok: false, message: '这是我自己的号' }
  if (k === 'friend' && isOwner(cfg, n)) return { ok: false, message: '主人本来就是好友' }
  if (k === 'friend' && known?.friends?.has(n)) return { ok: false, message: `QQ ${n} 已经是好友了，不用再加` }
  if (k === 'group' && known?.groups?.has(n)) return { ok: false, message: `我已经在群 ${n} 里了` }
  const same = wishes.filter((w) => w.kind === k && w.id === n)
  if (same.some((w) => w.status === 'pending')) return { ok: false, message: `已经跟主人说过想加 ${k === 'group' ? '群' : 'QQ'} ${n} 了，等主人处理，别重复问` }
  if (same.some((w) => w.status === 'dropped' && now - (w.doneAt || w.at) < WISH_DROP_QUIET_MS)) return { ok: false, message: `主人之前说过不加 ${k === 'group' ? '群' : 'QQ'} ${n}，这次就算了` }
  const limit = cfg.contactWish?.perDay ?? 3
  const today = wishes.filter((w) => sameDay(w.at, now)).length
  if (today >= limit) return { ok: false, message: `今天已经问过主人 ${today} 次了（上限 ${limit}），明天再说吧` }
  return { ok: true, wish: { kind: k, id: n, name: String(name || '').trim().slice(0, 30), reason: why, from: String(from || ''), at: now, status: 'pending' } }
}

/** 发给主人的那句话。 */
export function wishText(w) {
  const where = w.from.startsWith('group:') ? `，是在群 ${w.from.slice(6)} 里认识的` : ''
  if (w.kind === 'group') {
    return `我想进${wishLabel(w)}${where}：${w.reason}。我自己申请不了，你在那个群的话可以邀请我，或者在机器人号的 QQ 上搜群号申请；进群后记得把它加进群白名单。不想让我去就跟我说「算了 ${w.id}」。`
  }
  return `我想加 ${wishLabel(w)} 为好友${where}：${w.reason}。我自己加不了，你同意的话就在机器人号的 QQ 上搜这个号加一下；不想加就跟我说「算了 ${w.id}」。`
}

/** 取纯数字号码；不像 QQ 号 / 群号的返回空串。 */
export function cleanId(v) {
  const s = String(v ?? '').replace(/\D/g, '')
  return ID_RE.test(s) ? s : ''
}

/** 白名单增删的纯逻辑：返回 { ok, message, next? }。next = 改完后的这张表（没变化时不给）。 */
export function planWhitelist(cfg, { action, kind, id }) {
  const act = String(action || '').trim().toLowerCase()
  if (!['add', 'remove'].includes(act)) return { ok: false, message: 'action 只能是 add 或 remove' }
  const k = String(kind || '').trim().toLowerCase()
  if (!['private', 'group'].includes(k)) return { ok: false, message: 'kind 只能是 private（私聊的人）或 group（群）' }
  const n = cleanId(id)
  if (!n) return { ok: false, message: '号码不对：要 5~12 位数字的 QQ 号 / 群号' }
  const label = k === 'private' ? 'QQ' : '群'
  const listName = k === 'private' ? '私聊白名单' : '群白名单'
  if (k === 'private' && isOwner(cfg, n)) {
    return act === 'remove'
      ? { ok: false, message: '主人不能被移出私聊白名单' }
      : { ok: true, message: '主人本来就能私聊，不用加白名单' }
  }
  if (k === 'private' && act === 'add' && n === String(cfg.botQQ || '')) return { ok: false, message: '这是我自己的号，不用加' }
  const list = (k === 'private' ? cfg.allow?.private : cfg.allow?.groups) || []
  const has = list.map(String).includes(n)
  if (act === 'add') {
    if (has) return { ok: true, message: `${label} ${n} 已经在${listName}里了` }
    return { ok: true, changed: true, message: `${label} ${n} 加进${listName}了`, next: [...list.map(String), n] }
  }
  if (!has) return { ok: true, message: `${label} ${n} 本来就不在${listName}里` }
  return { ok: true, changed: true, message: `${label} ${n} 从${listName}移出了`, next: list.map(String).filter((x) => x !== n) }
}

export default {
  id: 'contacts',
  name: '好友申请与白名单',
  version: '1.0.0',
  description: '处理好友申请、加群申请和邀请，改私聊 / 群白名单；想交新朋友 / 进新群时问主人；权限在「权限」页',
  setup(api) {
    const { hub, onebot } = api.core
    const pendingFile = () => api.dataDir('friend-requests.json')
    const groupPendingFile = () => api.dataDir('group-requests.json')

    const loadPending = () => {
      try {
        const f = pendingFile()
        if (!existsSync(f)) return []
        const j = JSON.parse(readFileSync(f, 'utf8'))
        return Array.isArray(j) ? j.filter((x) => x && x.flag && x.userId) : []
      } catch (error) { return [] }
    }
    const savePending = (list) => {
      try { writeFileSync(pendingFile(), JSON.stringify(list.slice(-PENDING_MAX))) } catch (error) { api.log.warn('存好友申请出错：', error.message) }
    }

    const loadGroupPending = () => {
      try {
        const f = groupPendingFile()
        if (!existsSync(f)) return []
        const j = JSON.parse(readFileSync(f, 'utf8'))
        return Array.isArray(j) ? j.filter((x) => x && x.flag && ['add', 'invite'].includes(x.subType)) : []
      } catch (error) { return [] }
    }
    const saveGroupPending = (list) => {
      try { writeFileSync(groupPendingFile(), JSON.stringify(list.slice(-PENDING_MAX))) } catch (error) { api.log.warn('存加群申请出错：', error.message) }
    }
    const groupRequestText = (r, botQQ) => {
      const user = r.userId ? `QQ ${r.userId}` : '未知用户'
      const group = r.groupId ? `群 ${r.groupId}` : '未知群'
      if (r.subType === 'add') return `${user} 申请加入${group}`
      const invited = r.invitedId ? (r.invitedId === String(botQQ) ? '我' : `QQ ${r.invitedId}`) : '成员'
      return `${user} 邀请${invited}加入${group}`
    }
    const groupInFlight = new Set()

    const wishInFlight = new Set()
    const wishFile = () => api.dataDir('contact-wishes.json')
    const loadWishes = () => {
      try {
        const f = wishFile()
        if (!existsSync(f)) return []
        const j = JSON.parse(readFileSync(f, 'utf8'))
        return Array.isArray(j) ? j.filter((x) => x && ['friend', 'group'].includes(x.kind) && ID_RE.test(String(x.id || ''))) : []
      } catch (error) { return [] }
    }
    const saveWishes = (list) => {
      try { writeFileSync(wishFile(), JSON.stringify(list.slice(-WISH_MAX))) } catch (error) { api.log.warn('存交友心愿出错：', error.message) }
    }
    const pendingWish = (kind, id) => loadWishes().find((w) => w.kind === kind && w.id === String(id) && w.status === 'pending')
    /** 加上好友 / 进了群：心愿记为完成，提醒主人白名单的事。 */
    const fulfilWish = (kind, id) => {
      const list = loadWishes()
      const w = list.find((x) => x.kind === kind && x.id === String(id) && x.status === 'pending')
      if (!w) return
      w.status = 'done'
      w.doneAt = Date.now()
      saveWishes(list)
      const cfg = api.config()
      const allowList = (kind === 'group' ? cfg.allow?.groups : cfg.allow?.private) || []
      api.log.info(`交友心愿完成：${wishLabel(w)}`)
      if (!cfg.ownerQQ || allowList.map(String).includes(w.id)) return
      const tip = kind === 'group'
        ? `我进${wishLabel(w)}了，谢谢！要我在群里说话，记得把它加进群白名单（或者跟我说一声）。`
        : `加上 ${wishLabel(w)} 了，谢谢！要我能跟 ta 私聊，记得把 ta 加进私聊白名单（或者跟我说一声）。`
      api.sendText(`private:${cfg.ownerQQ}`, tip).catch(() => {})
    }
    const wishNote = (kind, id) => (pendingWish(kind, id) ? '（是我之前跟你说想加的）' : '')

    // ---- 主人拉她进的群：直接进、直接加进群白名单（主人都拉了，不用再问、再旁听） ----
    const ownerInvites = new Map() // 群号 → 主人邀请的时间：QQ 有时不发申请、直接把她拉进去，进群通知里又不一定带邀请人
    const OWNER_INVITE_MS = 24 * 3600000
    function whitelistOwnerGroup(groupId, inviter) {
      const cfg = api.config()
      if (cfg.dryRun) { api.log.info(`试运行：主人拉我进了群 ${groupId}，本来要加进群白名单`); return false }
      if ((cfg.allow?.groups || []).map(String).includes(groupId)) return false
      api.setConfig((cur) => ({ ...cur, allow: { ...cur.allow, groups: [...new Set([...(cur.allow?.groups || []).map(String), groupId])] } }))
      api.log.info(`主人拉我进了群 ${groupId}，已加进群白名单`)
      if (cfg.ownerQQ) {
        const who = inviter && String(inviter) !== String(cfg.ownerQQ) ? `${ownerNameOf(cfg, inviter) || 'QQ ' + inviter}` : '你'
        api.sendText(`private:${cfg.ownerQQ}`, `进群 ${groupId} 了，是${who}拉我进来的，已经加进群白名单，可以在里面说话了。`).catch(() => {})
      }
      return true
    }
    async function acceptOwnerInvite(ev) {
      const groupId = String(ev.group_id || '')
      ownerInvites.set(groupId, Date.now())
      if (api.config().dryRun) { api.log.info(`试运行：主人邀请我进群 ${groupId}，本来要直接接受`); return }
      try {
        await onebot.call('set_group_add_request', { flag: String(ev.flag), sub_type: 'invite', approve: true }, { timeoutMs: 15000 })
        whitelistOwnerGroup(groupId, String(ev.user_id || ''))
      } catch (error) {
        // 常见情况是 QQ 已经直接把她拉进群了（好友邀请不用审批）：进群通知到了会照样加白名单
        api.log.warn(`接受主人的进群邀请（群 ${groupId}）没成功：${error.message}`)
      }
    }

    const onGroupRequest = (ev) => {
      if (!ev.flag || !['add', 'invite'].includes(ev.sub_type)) return
      if (ev.sub_type === 'invite' && isOwner(api.config(), ev.user_id)) { acceptOwnerInvite(ev).catch(() => {}); return }
      if (ev.sub_type === 'invite' && api.use?.('self-allow')?.handlesGroupInvites?.()) return // 她自己决定去不去，「自己管白名单」模块处理
      const userId = String(ev.user_id || '')
      const groupId = String(ev.group_id || '')
      const list = loadGroupPending()
      if (list.some((x) => x.flag === String(ev.flag))) return
      const req = { flag: String(ev.flag), subType: ev.sub_type, userId, groupId, invitedId: String(ev.invited_id || ''), comment: String(ev.comment || '').slice(0, 80), at: Date.now() }
      list.push(req)
      saveGroupPending(list)
      const cfg = api.config()
      if (cfg.ownerQQ && (cfg.profilePerms?.qqFriendRequest || 'owner') !== 'off') {
        const note = req.comment ? `，验证消息：「${req.comment}」` : ''
        const wished = req.subType === 'invite' ? wishNote('group', groupId) : ''
        api.sendText(`private:${cfg.ownerQQ}`, `${groupRequestText(req, cfg.botQQ)}${note}${wished}。可以让我列出待处理的加群申请并通过或拒绝。`).catch(() => {})
      }
    }

    // 好友申请事件：只记下来（flag 必须原样用，不能自己拼），再给主人提一句
    api.on('onebot', (ev) => {
      if (ev && ev.post_type === 'notice') {
        if (ev.notice_type === 'friend_add' && ev.user_id) fulfilWish('friend', ev.user_id)
        else if (ev.notice_type === 'group_increase' && ev.group_id && String(ev.user_id) === String(api.config().botQQ || ev.self_id || '')) {
          const gid = String(ev.group_id)
          const invitedAt = ownerInvites.get(gid) || 0
          if (isOwner(api.config(), ev.operator_id) || Date.now() - invitedAt < OWNER_INVITE_MS) {
            ownerInvites.delete(gid)
            whitelistOwnerGroup(gid, isOwner(api.config(), ev.operator_id) ? String(ev.operator_id) : '')
          }
          fulfilWish('group', ev.group_id)
        }
        return
      }
      if (!ev || ev.post_type !== 'request') return
      if (ev.request_type === 'group') return onGroupRequest(ev)
      if (ev.request_type !== 'friend' || !ev.flag) return
      const userId = String(ev.user_id || '')
      if (!userId) return
      if (api.use?.('circle')?.expects?.(userId)) return // 她自己邀请的人：交友圈模块会自动通过并告诉主人
      const list = loadPending()
      const isNew = !list.some((x) => x.flag === String(ev.flag))
      if (isNew) {
        list.push({ flag: String(ev.flag), userId, comment: String(ev.comment || '').slice(0, 80), at: Date.now() })
        savePending(list)
      }
      const cfg = api.config()
      if (isNew && cfg.ownerQQ && (cfg.profilePerms?.qqFriendRequest || 'owner') !== 'off') {
        const note = ev.comment ? `，验证消息：「${String(ev.comment).slice(0, 80)}」` : ''
        api.sendText(`private:${cfg.ownerQQ}`, `有人想加我好友：QQ ${userId}${note}${wishNote('friend', userId)}。要通过就跟我说「通过 ${userId}」，不想加说「拒绝 ${userId}」。`).catch(() => {})
      }
    })

    const guarded = (key, chat, sessionId, run) => async (args) => {
      const cfg = api.config()
      const p = profilePermits(cfg, key, chat, hub.turnSendersAllOwner(sessionId))
      if (!p.ok) return p
      return run(args, cfg)
    }

    const groupOwner = (chat) => isOwnerSpaceChat(api.config(), chat)
    const guardedGroup = (chat, sessionId, run) => guarded('qqFriendRequest', chat, sessionId, async (args, cfg) => {
      if (!groupOwner(chat) || !hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '只有主人私聊才能处理加群申请' }
      return run(args, cfg)
    })

    /** 找要处理的那条申请：先看收到过的事件，再看 QQ 过滤掉的「可能认识的人」。 */
    async function findRequest(qq) {
      const pending = loadPending()
      const hit = qq ? pending.find((x) => x.userId === qq) : (pending.length === 1 ? pending[0] : null)
      if (hit) return { ok: true, via: 'event', flag: hit.flag, userId: hit.userId }
      if (!qq && pending.length > 1) {
        return { ok: false, message: `有 ${pending.length} 个待处理的申请：${pending.map((x) => x.userId).join('、')}。说清楚是哪个 QQ 号` }
      }
      let doubt = []
      try { doubt = (await onebot.call('get_doubt_friends_add_request', { count: 50 }, { timeoutMs: 15000 })) || [] } catch (error) { doubt = [] }
      if (!Array.isArray(doubt)) doubt = []
      const d = qq ? doubt.find((x) => String(x.user_id) === qq) : (doubt.length === 1 ? doubt[0] : null)
      if (d && d.uid) return { ok: true, via: 'doubt', flag: String(d.uid), userId: String(d.user_id || qq || '') }
      if (!qq && doubt.length > 1) return { ok: false, message: `有 ${doubt.length} 个被 QQ 过滤的申请：${doubt.map((x) => x.user_id).join('、')}。说清楚是哪个 QQ 号` }
      return { ok: false, message: qq ? `没找到 QQ ${qq} 的好友申请（没收到过，QQ 过滤的列表里也没有）` : '现在没有待处理的好友申请' }
    }

    api.tool(({ chat, sessionId }) => {
      if (chat.kind !== 'private' && chat.kind !== 'group') return []
      const cfg = api.config()
      const tools = []
      if (profileToolVisible(cfg, 'qqFriendRequest', chat)) tools.push(defineTool({
        name: 'qq_handle_friend_request',
        description: '通过或拒绝别人加你为好友的申请。qq 填申请人的 QQ 号（只有一个待处理申请时可不填）；approve 填 true 通过、false 拒绝。你不能主动加别人为好友（想加的话用 qq_wish_contact 问主人）。',
        properties: { qq: str('申请人的 QQ 号，可不填'), approve: bool('true 通过，false 拒绝') },
        required: ['approve'],
        execute: guarded('qqFriendRequest', chat, sessionId, async ({ qq, approve }, c) => {
          if (typeof approve !== 'boolean') return { ok: false, message: 'approve 要写 true（通过）或 false（拒绝）' }
          const want = String(qq ?? '').trim() ? cleanId(qq) : ''
          if (String(qq ?? '').trim() && !want) return { ok: false, message: 'QQ 号不对：要 5~12 位数字' }
          const req = await findRequest(want)
          if (!req.ok) return req
          const verb = approve ? '通过' : '拒绝'
          if (c.dryRun) return { ok: true, message: `试运行：本来要${verb} QQ ${req.userId} 的好友申请` }
          try {
            if (req.via === 'event') await onebot.call('set_friend_add_request', { flag: req.flag, approve }, { timeoutMs: 15000 })
            else await onebot.call('set_doubt_friends_add_request', { flag: req.flag, approve }, { timeoutMs: 15000 })
          } catch (error) {
            return { ok: false, message: `${verb} QQ ${req.userId} 的好友申请没成功：${error.message}` }
          }
          savePending(loadPending().filter((x) => x.flag !== req.flag && x.userId !== req.userId))
          return { ok: true, message: `已${verb} QQ ${req.userId} 的好友申请` }
        }),
      }))
      if (groupOwner(chat) && profileToolVisible(cfg, 'qqFriendRequest', chat)) {
        tools.push(defineTool({
          name: 'qq_list_group_requests',
          description: '列出收到过、尚未处理的加群申请和邀请，处理时使用列表中的 flag。',
          execute: guardedGroup(chat, sessionId, async (_args, c) => {
            const list = loadGroupPending()
            return { ok: true, message: list.length ? list.map((r) => `${groupRequestText(r, c.botQQ)}${r.comment ? `，验证消息：「${r.comment}」` : ''}（flag: ${r.flag}）`).join('\n') : '现在没有待处理的加群申请或邀请' }
          }),
        }))
        tools.push(defineTool({
          name: 'qq_handle_group_request',
          description: '通过或拒绝收到过的加群申请或邀请。flag 从待处理列表原样取得，只有一条时可不填；approve 填 true 或 false，拒绝时可填 reason。',
          properties: { flag: str('待处理列表里的 flag，可不填'), approve: bool('true 通过，false 拒绝'), reason: str('拒绝原因，可不填') },
          required: ['approve'],
          execute: guardedGroup(chat, sessionId, async ({ flag, approve, reason }, c) => {
            if (typeof approve !== 'boolean') return { ok: false, message: 'approve 要写 true（通过）或 false（拒绝）' }
            const list = loadGroupPending()
            const wanted = String(flag ?? '')
            if (!wanted && list.length > 1) return { ok: false, message: '有多条待处理的加群申请，请先列出并指定 flag' }
            const req = wanted ? list.find((x) => x.flag === wanted) : list[0]
            if (!req) return { ok: false, message: '没找到这条待处理的加群申请或邀请' }
            const verb = approve ? '通过' : '拒绝'
            const label = groupRequestText(req, c.botQQ)
            if (c.dryRun) return { ok: true, message: `试运行：本来要${verb}「${label}」` }
            if (groupInFlight.has(req.flag)) return { ok: false, message: '这条申请正在处理' }
            groupInFlight.add(req.flag)
            try {
              await onebot.call('set_group_add_request', { flag: req.flag, sub_type: req.subType, approve, ...(reason && !approve ? { reason: String(reason) } : {}) }, { timeoutMs: 15000 })
              saveGroupPending(loadGroupPending().filter((x) => x.flag !== req.flag))
              return { ok: true, message: `已${verb}「${label}」` }
            } catch (error) {
              return { ok: false, message: `${verb}「${label}」没成功：${error.message}` }
            } finally { groupInFlight.delete(req.flag) }
          }),
        }))
      }
      // 第二位（及以后的）主人：怎么称呼 ta 由 ta 自己说了算，只在 ta 本人的私聊里改
      const coIdx = chat.kind === 'private' ? (cfg.coOwners || []).findIndex((o) => o.qq && String(o.qq) === String(chat.userId)) : -1
      if (coIdx >= 0) tools.push(defineTool({
        name: 'qq_owner_title',
        description: '记下你以后怎么称呼眼前这位主人（比如 ta 让你叫 老妈、妈、某某）。只在 ta 自己说定了的时候用，title 填 ta 定下的叫法。',
        properties: { title: str('以后怎么称呼 ta，2~10 个字') },
        required: ['title'],
        execute: async ({ title }) => {
          if (!hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '只有 ta 本人在私聊里说定了才能改' }
          const t = String(title || '').trim().replace(/\s+/g, ' ')
          if (!t || [...t].length > 10) return { ok: false, message: '称呼要 1~10 个字' }
          const c = api.config()
          if (c.dryRun) return { ok: true, message: `试运行：本来要记下称呼「${t}」` }
          let ok = false
          api.setConfig((cur) => {
            const list = (cur.coOwners || []).map((o) => ({ ...o }))
            const i = list.findIndex((o) => String(o.qq) === String(chat.userId))
            if (i < 0) return cur
            list[i].name = t
            ok = true
            return { ...cur, coOwners: list }
          })
          if (!ok) return { ok: false, message: 'ta 已经不在主人名单里了' }
          api.log.info(`主人 ${chat.userId} 的称呼定为「${t}」`)
          if (c.ownerQQ && String(c.ownerQQ) !== String(chat.userId)) api.sendText(`private:${c.ownerQQ}`, `跟你说一声，QQ ${chat.userId} 让我以后叫 ta「${t}」。`).catch(() => {})
          return { ok: true, message: `记住了，以后叫 ta「${t}」` }
        },
      }))
      if (profileToolVisible(cfg, 'whitelist', chat)) tools.push(defineTool({
        name: 'qq_whitelist',
        description: '改白名单：action 填 add（加进）或 remove（移出），kind 填 private（某个 QQ 号可以私聊你）或 group（某个群你会理），id 填 QQ 号或群号。主人不能被移出。',
        properties: { action: str('add 加进 / remove 移出'), kind: str('private 私聊的人 / group 群'), id: str('QQ 号或群号（数字）') },
        required: ['action', 'kind', 'id'],
        execute: guarded('whitelist', chat, sessionId, async (args, c) => {
          const plan = planWhitelist(c, args)
          if (!plan.ok || !plan.changed) return plan
          if (c.dryRun) return { ok: true, message: `试运行：本来要${plan.message}` }
          const key = String(args.kind).trim().toLowerCase() === 'private' ? 'private' : 'groups'
          // 用保存那一刻最新的配置再算一遍，免得盖掉面板刚改的
          let result = plan
          api.setConfig((cur) => {
            result = planWhitelist(cur, args)
            if (!result.ok || !result.changed) return cur
            return { ...cur, allow: { ...cur.allow, [key]: result.next } }
          })
          return { ok: result.ok, message: result.message }
        }),
      }))
      if (cfg.contactWish?.enabled && cfg.ownerQQ) tools.push(defineTool({
        name: 'qq_wish_contact',
        description: '你自己不能加好友、不能申请进群。真心想和某人做朋友（聊得来、对方邀请你），或想进某个群时，用它私聊问主人，由主人在你的 QQ 上帮你加。kind 填 friend（加好友）或 group（进群）；id 填 QQ 号或群号；name 填对方昵称 / 群名（可不填）；reason 用你的口吻简短说为什么想加。每天次数有限，别随便用；问过之后就等主人，不要跟对方保证一定能加上。',
        properties: { kind: str('friend 加好友 / group 进群'), id: str('QQ 号或群号（数字）'), name: str('昵称或群名，可不填'), reason: str('为什么想加，一两句话') },
        required: ['kind', 'id', 'reason'],
        execute: async (args) => {
          const c = api.config()
          if (!c.contactWish?.enabled) return { ok: false, message: '这个功能在面板里关掉了' }
          if (!c.ownerQQ) return { ok: false, message: '还没设置主人 QQ，没法问' }
          const key = `${String(args.kind || '').trim().toLowerCase()}:${cleanId(args.id)}`
          if (wishInFlight.has(key)) return { ok: false, message: '正在问主人了' }
          wishInFlight.add(key)
          try {
            const known = { friends: new Set(), groups: new Set() }
            const kindNow = key.split(':')[0]
            try {
              const list = await onebot.call(kindNow === 'group' ? 'get_group_list' : 'get_friend_list', {}, { timeoutMs: 8000 })
              for (const x of Array.isArray(list) ? list : []) {
                if (x?.user_id) known.friends.add(String(x.user_id))
                if (x?.group_id) known.groups.add(String(x.group_id))
              }
            } catch (error) { /* 查不到就不查，主人那边自己会看到 */ }
            const plan = planWish(c, loadWishes(), args, { from: chat.chatId || (chat.kind === 'group' ? `group:${chat.groupId}` : `private:${chat.userId}`), known })
            if (!plan.ok) return plan
            if (c.dryRun) return { ok: true, message: `试运行：本来要私聊主人：${wishText(plan.wish)}` }
            try {
              await api.sendText(`private:${c.ownerQQ}`, wishText(plan.wish))
            } catch (error) {
              return { ok: false, message: `没能发给主人：${error.message}` }
            }
            saveWishes([...loadWishes(), plan.wish])
            api.log.info(`交友心愿：${wishLabel(plan.wish)}｜${plan.wish.reason}`)
            return { ok: true, message: `已经私聊问主人了（${wishLabel(plan.wish)}）。主人加上之前别跟对方说已经加了` }
          } finally { wishInFlight.delete(key) }
        },
      }))
      if (groupOwner(chat) && cfg.contactWish?.enabled) tools.push(defineTool({
        name: 'qq_contact_wishes',
        description: '主人私聊专用：列出你想加的好友 / 想进的群（action=list），或按主人的话撤销某一个（action=drop，填 id；主人说「算了 XXX」时用）。',
        properties: { action: str('list 列出 / drop 撤销'), id: str('要撤销的 QQ 号或群号，drop 时必填') },
        required: ['action'],
        execute: async ({ action, id }) => {
          if (!groupOwner(chat) || !hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '只有主人私聊才能管这个' }
          const act = String(action || '').trim().toLowerCase()
          const list = loadWishes()
          if (act === 'list') {
            const pending = list.filter((w) => w.status === 'pending')
            const done = list.filter((w) => w.status === 'done').slice(-5)
            if (!pending.length && !done.length) return { ok: true, message: '现在没有想加的人或群' }
            const lines = [
              ...pending.map((w) => `等主人处理：${wishLabel(w)}——${w.reason}`),
              ...done.map((w) => `已加上：${wishLabel(w)}`),
            ]
            return { ok: true, message: lines.join('\n') }
          }
          if (act !== 'drop') return { ok: false, message: 'action 只能是 list 或 drop' }
          const n = cleanId(id)
          if (!n) return { ok: false, message: '要撤销哪个？填 QQ 号或群号' }
          const hit = list.filter((w) => w.id === n && w.status === 'pending')
          if (!hit.length) return { ok: false, message: `没有等处理的 ${n}` }
          const now = Date.now()
          for (const w of hit) { w.status = 'dropped'; w.doneAt = now }
          saveWishes(list)
          return { ok: true, message: `好，${hit.map(wishLabel).join('、')} 不加了` }
        },
      }))
      return tools
    })
    return {}
  },
}
