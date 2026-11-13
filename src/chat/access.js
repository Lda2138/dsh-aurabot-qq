// 谁能跟她说话、她在每个会话里有多大权限。纯函数。

/** 权限档位：full = DSH 完整工具；social = 只有 QQ 社交工具；chat = 纯聊天，没有工具。 */
export const LEVELS = ['full', 'social', 'chat']

/**
 * @param {object} cfg 插件配置
 * @param {{kind:'private'|'group', userId:string, groupId:string}} msg
 * @returns {{allowed: boolean, reason: string}}
 */
export function checkAllowed(cfg, msg) {
  if (msg.kind === 'private') {
    if (isOwner(cfg, msg.userId)) return { allowed: true, reason: '主人' }
    const list = (cfg.allow?.private || []).map(String)
    return list.includes(msg.userId)
      ? { allowed: true, reason: '私聊白名单' }
      : { allowed: false, reason: '不在私聊白名单' }
  }
  // 家庭群：只有主人们说的话才交给她（别人混进来也不理，因为这里她有主人的权限）
  if (isFamilyGroup(cfg, msg.groupId)) {
    return isOwner(cfg, msg.userId)
      ? { allowed: true, reason: '家庭群' }
      : { allowed: false, reason: '家庭群只听主人的' }
  }
  const groups = (cfg.allow?.groups || []).map(String)
  return groups.includes(msg.groupId)
    ? { allowed: true, reason: '群白名单' }
    : { allowed: false, reason: '不在群白名单' }
}

/** 这个会话用哪一档权限。普通群聊永远不超过 social；家庭群（只听主人的）和主人私聊同一档。 */
export function levelFor(cfg, chat) {
  if (isOwnerSpaceChat(cfg, chat)) {
    return LEVELS.includes(cfg.ownerLevel) ? cfg.ownerLevel : 'full'
  }
  return 'social'
}

/** 家庭群：主人在面板里指定的、只有家里人的群。 */
export function isFamilyGroup(cfg, groupId) {
  const id = String(groupId || '')
  return id !== '' && (Array.isArray(cfg?.familyGroups) ? cfg.familyGroups : []).map(String).includes(id)
}

/** 「主人的地盘」：主人私聊，或家庭群。这里她按主人视角看记忆、用主人的工具。 */
export function isOwnerSpaceChat(cfg, chat) {
  if (!chat) return false
  if (chat.kind === 'private') return isOwner(cfg, chat.userId)
  if (chat.kind === 'group') return isFamilyGroup(cfg, chat.groupId)
  return false
}

/** 同上，按 chatId 判断（private:QQ / group:群号）。 */
export function isOwnerSpace(cfg, chatId) {
  const id = String(chatId || '')
  if (id.startsWith('private:')) return isOwner(cfg, id.slice(8))
  if (id.startsWith('group:')) return isFamilyGroup(cfg, id.slice(6))
  return false
}

/** 档位 → agent preset id。 */
export function presetFor(level, cfg) {
  if (level !== 'full') return 'aurabot-social'
  return cfg && cfg.longTasks ? 'aurabot-private-long' : 'aurabot-private'
}

/**
 * 所有主人的 QQ 号：第一位是 ownerQQ（通知、主动搭话默认找的那位），后面是 coOwners 里的其他主人。
 * 每一位主人的权限完全一样。
 */
export function ownerQQs(cfg) {
  const list = [cfg?.ownerQQ, ...(Array.isArray(cfg?.coOwners) ? cfg.coOwners.map((o) => o?.qq) : [])]
  return [...new Set(list.map((q) => String(q || '').trim()).filter(Boolean))]
}

/** 只有主人能做的事（群管、点歌、写文件……）。任意一位主人都算。 */
export function isOwner(cfg, userId) {
  const id = String(userId || '')
  return id !== '' && ownerQQs(cfg).includes(id)
}

/** chatId 是不是某位主人的私聊。 */
export function isOwnerChat(cfg, chatId) {
  const id = String(chatId || '')
  return id.startsWith('private:') && isOwner(cfg, id.slice(8))
}

/** 怎么称呼这位主人：ownerQQ 用 ownerName，其他主人用各自的 name；不是主人返回空串。 */
export function ownerNameOf(cfg, userId) {
  const id = String(userId || '')
  if (!id) return ''
  if (id === String(cfg?.ownerQQ || '')) return cfg.ownerName || ownerRoleOf(cfg, id) || '主人'
  const o = (Array.isArray(cfg?.coOwners) ? cfg.coOwners : []).find((x) => String(x?.qq || '') === id)
  return o ? o.name || ownerRoleOf(cfg, id) || '主人' : ''
}

/** 家庭身份和实际叫法分开；未配置身份时不猜谁是爸爸或妈妈。 */
export function ownerRoleOf(cfg, userId) {
  const id = String(userId || '')
  if (!id) return ''
  return String(id === String(cfg?.ownerQQ || '') ? cfg.ownerRole || '' : (cfg?.coOwners || []).find((o) => String(o.qq) === id)?.role || '')
}

export function ownerIdentityOf(cfg, userId) {
  const role = ownerRoleOf(cfg, userId), name = ownerNameOf(cfg, userId)
  return role && name && role !== name ? `${role}（称呼${name}）` : role || name
}

/** 改资料类操作（改昵称 / 签名 / 头像、改 B 站签名），以及处理好友申请、改白名单的三档权限。 */
export const PROFILE_PERM_LEVELS = ['off', 'owner', 'all']
export const DOUYIN_PERM_KEYS = ['douyinBrowse', 'douyinLike', 'douyinComment', 'douyinShareOwner', 'douyinDm']
/** 小黑盒：浏览（含热榜/搜索）、点赞、评论、发帖（含删自己的帖）。 */
export const HEYBOX_PERM_KEYS = ['heyboxBrowse', 'heyboxLike', 'heyboxComment', 'heyboxPost']
export const PROFILE_PERM_KEYS = ['qqNickname', 'qqSignature', 'qqAvatar', 'biliSign', 'biliAvatar', 'biliComment', 'qqFriendRequest', 'whitelist', ...DOUYIN_PERM_KEYS, ...HEYBOX_PERM_KEYS]
/** 没设过的档位：一律默认仅主人（含抖音浏览/互动/改资料项；用户要放开自己在面板开）。 */
export const profilePermDefault = (key) => 'owner'
export const permOf = (cfg, key) => {
  const p = cfg?.profilePerms?.[key]
  return PROFILE_PERM_LEVELS.includes(p) ? p : profilePermDefault(key)
}

/** 这一档在这个会话里要不要挂工具。owner = 只在主人私聊里挂；all = 哪都挂；off = 不挂。 */
export function profileToolVisible(cfg, key, chat) {
  const p = permOf(cfg, key)
  if (p === 'all') return chat.kind === 'private' || chat.kind === 'group'
  if (p === 'owner') return isOwnerSpaceChat(cfg, chat)
  return false
}

/** 执行时再查一遍（面板可能刚改过）。allOwner = 这一轮说话的人全是主人。 */
export function profilePermits(cfg, key, chat, allOwner) {
  const p = permOf(cfg, key)
  if (p === 'off') return { ok: false, message: '这个操作在面板里关掉了' }
  if (!profileToolVisible(cfg, key, chat)) return { ok: false, message: '这里不能做这个操作' }
  if (p === 'owner' && !allOwner) return { ok: false, message: '只有主人私聊让我改才行' }
  return { ok: true }
}
