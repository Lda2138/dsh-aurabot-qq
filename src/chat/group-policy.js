// 群聊回复策略：什么时候必回、什么时候插话、什么时候闭嘴。纯函数，便于测试。

export const DEFAULT_GROUP_POLICY = {
  wakeWords: ['大肥鱼', '肥鱼'],
  addressedOnly: false, // 普通群仅被明确叫到时才交给模型；家庭群独立判断
  interjectChance: 0.15, // 普通消息的基础插话概率（话题越相关越高，最高 80%）
  cooldownSec: 90, // 两次插话至少间隔
  maxPerHour: 6, // 每群每小时插话上限
  quietHours: [1, 8], // [开始, 结束) 小时，静默时段不插话（必回不受影响）
  minRecentMessages: 3, // 最近 activeWindowSec 内至少有这么多条消息才算「群里在聊」
  activeWindowSec: 300,
  // 话题相关度：群里正在聊的东西和她有关（碰到她感兴趣的话题、或者她记得相关的事），才可能插话
  interests: ['奶茶', '火锅', '甜品', '好吃', '吃饭', '饿了', '游戏', '追剧', '综艺', '番剧', '动漫', '听歌', '猫', '狗', '睡觉', '熬夜', '困', '天气', '下雨', '表情包', '可爱'],
  minRelevance: 0.25, // 相关度低于这个就不插话（0 = 不看话题，纯随机）
  engagedMax: 6, // 没人再叫她时最多连着接几次。该不该停由她自己判断，这里只防失控
  burstMax: 8, // 安全刹车：burstWindowSec 秒内她最多说这么多次，超了就歇着（明确被叫到除外），只防失控
  burstWindowSec: 120,
}

/**
 * 家庭群（没单独设过时）：爸妈说的每一段都交给她，接不接由她自己判断（见 familyGroupDecision / familyHint）；
 * 连续回复达到 burstMax 时只提醒她留意节奏，不按次数截断家人的新消息。
 */
export const FAMILY_GROUP_POLICY = {
  burstMax: 8,
  burstWindowSec: 120,
}

/**
 * 家庭群的决定：规则说「不回」时也交给她，让她结合内容和节奏提醒自己判断。
 * decision 是 decideGroupReply 的结果。
 */
export function familyGroupDecision(decision) {
  if (decision.reply && decision.mode === 'must') return decision
  return { reply: true, mode: 'family', reason: '家庭群：交给她自己判断' }
}

/** 家庭群连续回复偏多时的软提醒；不裁回复、不拦输入，也不要求达到次数就停。 */
export function familyPaceHint(replyTimes = [], now = Date.now()) {
  const recent = replyTimes.filter((t) => now - t >= 0 && now - t < FAMILY_GROUP_POLICY.burstWindowSec * 1000).length
  if (recent < FAMILY_GROUP_POLICY.burstMax) return ''
  return '（你这会儿已经接连回了不少，留意一下聊天节奏：家人还在接你的话、有新问题或需要你回应时，照常自然接着聊；可以说短一点，别重复刚说过的话。只是笑一下、表情，或没有新的话要说时，可以只回 [沉默]。这只是提醒，不是到次数就必须停，也不用向家人报次数或解释限制。）'
}

/** 家庭群里没人直接叫她时给她的提示：放松，自己判断。 */
export function familyHint() {
  return '（家庭群里爸妈没 @ 你也可能在跟你说，或者说给全家听：像在家里当面说话那样接着聊。短句、笑声和表情结合前文理解，可能是回应、疑惑或催你接话，不单凭消息短就停。爸妈两个人在说话且不用你回应，或者确实没新话可接时，可以只回 [沉默]。）'
}

/**
 * 群里最近在聊的内容和她有多相关（0~1）。
 * @param {string[]} recentTexts 最近几条群消息
 * @param {string[]} interests 她感兴趣的话题词
 * @param {number} [memoryScore] 记忆库对这段话题的命中强度（0~1，可选）
 */
export function topicRelevance(recentTexts, interests, memoryScore = 0) {
  const txt = (recentTexts || []).join(' ')
  let hits = 0
  for (const w of interests || []) if (w && txt.includes(w)) hits++
  return Math.min(1, hits * 0.3 + Math.max(0, Math.min(1, memoryScore)) * 0.5)
}

/** 合并全局策略和单群覆盖。 */
export function policyFor(global, overrides, groupId) {
  const g = { ...DEFAULT_GROUP_POLICY, ...(global || {}) }
  const o = overrides && overrides[String(groupId)]
  return o ? { ...g, ...o } : g
}

export function inQuietHours(hour, quiet) {
  if (!Array.isArray(quiet) || quiet.length !== 2) return false
  const [a, b] = quiet.map(Number)
  if (a === b) return false
  return a < b ? hour >= a && hour < b : hour >= a || hour < b
}

/**
 * 决定这段群消息要不要回。
 * @param {object} p
 * @param {object} p.policy  policyFor() 的结果
 * @param {boolean} p.mentioned  被 @
 * @param {boolean} p.repliedToBot  引用了机器人的消息
 * @param {boolean} [p.fromOwner]  是主人说的
 * @param {boolean} [p.lastIsBot]  这一条之前最近一条是不是她说的（判断「在追问她」用）
 * @param {boolean} [p.atOthersAny]  这条消息是不是 @ 了别人（不管策略开没开「@ 别人不算叫她」）
 * @param {string} p.text  消息正文
 * @param {number} p.now  毫秒时间戳
 * @param {number[]} p.recentTimes  本群最近消息的时间戳（毫秒）
 * @param {number[]} p.interjectTimes  本群最近插话的时间戳（毫秒）
 * @param {number[]} [p.botReplyTimes]  她在本群最近每次说话的时间戳（毫秒）
 * @param {number} p.hour  当前小时
 * @param {() => number} [p.rand]
 * @returns {{reply: boolean, mode: 'must'|'interject'|'engaged'|'none', reason: string}}
 */
export function decideGroupReply(p) {
  const pol = p.policy || DEFAULT_GROUP_POLICY
  const text = String(p.text || '')
  const rand = p.rand || Math.random
  const said = p.botReplyTimes || []
  const burst = said.filter((t) => p.now - t < (pol.burstWindowSec ?? 120) * 1000).length
  // @ 了别人（没 @ 她）：不算在叫她，但仍走正常插话判断
  const atOther = !p.mentioned && (p.atOthers === true || (pol.addressedOnly && p.atOthersAny))
  const hit = atOther ? undefined : (pol.wakeWords || []).find((w) => w && text.includes(w))
  // 她刚说完，别人追一句「人呢」「不说话了」也算在问她。要她这几分钟确实说过话（burst > 0），
  // 且这一条之前最近一条不是她——群里 A/B 正常聊天、B 回 A 一句「人呢」时别抢答
  const shortAsk = Boolean(!pol.addressedOnly && burst > 0 && !p.lastIsBot && !atOther && !p.atOthersAny && String(text).trim().length <= 12 &&
    /[？?]|不说话了|人呢|跑了|去哪|怎么了|在吗|说话/.test(text))
  // 明确被叫到（@、引用、叫名字、被追问）不算她主动接话，刹车不拦；刹车只拦她自己想插话
  const calling = Boolean(p.mentioned || p.repliedToBot || hit || shortAsk)
  if (burst >= (pol.burstMax ?? 8) && !calling) {
    return { reply: false, mode: 'none', reason: `刚说了太多（${burst} 次），歇一会儿` }
  }
  if (p.mentioned) return { reply: true, mode: 'must', reason: '被 @' }
  if (p.repliedToBot) return { reply: true, mode: 'must', reason: '引用了她的消息' }
  if (hit) return { reply: true, mode: 'must', reason: `叫到了「${hit}」` }
  if (shortAsk) return { reply: true, mode: 'must', reason: '刚说完被追问' }
  if (pol.addressedOnly) return { reply: false, mode: 'none', reason: '普通群省用量：这条没有明确叫她' }
  const rel = typeof p.relevance === 'number' ? p.relevance : 1

  if (!(pol.interjectChance > 0)) return { reply: false, mode: 'none', reason: '插话关着' }
  if (inQuietHours(p.hour, pol.quietHours)) return { reply: false, mode: 'none', reason: '静默时段' }
  const minRel = Number(pol.minRelevance) || 0
  // 已经加入了这个话题：接着聊（每段看完再回，不受冷却和每小时上限限制）。她说话会续上这个状态，
  // 她会看到自己接了几次、自己决定停不停，engagedMax 只是兜底
  if (p.engagedUntil && p.now < p.engagedUntil && rel >= minRel && (p.engagedRun || 0) < (pol.engagedMax ?? 2)) {
    return { reply: true, mode: 'engaged', reason: `正聊得起劲，接着说（相关度 ${rel.toFixed(2)}）` }
  }
  const times = p.interjectTimes || []
  const lastHour = times.filter((t) => p.now - t < 3600_000).length
  if (lastHour >= pol.maxPerHour) return { reply: false, mode: 'none', reason: '这小时插话够多了' }
  const last = times.length ? Math.max(...times) : 0
  if (p.now - last < pol.cooldownSec * 1000) return { reply: false, mode: 'none', reason: '插话冷却中' }
  const recent = (p.recentTimes || []).filter((t) => p.now - t < pol.activeWindowSec * 1000).length
  if (recent < pol.minRecentMessages) return { reply: false, mode: 'none', reason: '群里没在聊' }
  // 话题和她有关才插，越相关越容易插（不传 relevance 时按「不看话题」处理，兼容旧调用）
  if (minRel > 0 && rel < minRel) return { reply: false, mode: 'none', reason: `话题和她关系不大（相关度 ${rel.toFixed(2)}）` }
  const chance = minRel > 0 ? Math.min(0.8, pol.interjectChance * (1 + 4 * rel)) : pol.interjectChance
  if (rand() < chance) return { reply: true, mode: 'interject', reason: `话题相关，插一句（相关度 ${rel.toFixed(2)}）` }
  return { reply: false, mode: 'none', reason: '这次不插话' }
}

/**
 * 这一批要自动引用并 @ 谁。只有一个人在说话时才自动：多人时她回的可能是别人的话，
 * 自动 @ 会把话安到错的人头上（#160）；想回某一条她自己会用编号引用。
 */
export function pickAutoReply(fresh) {
  if (new Set(fresh.map((x) => x.uid)).size !== 1) return null
  const target = fresh.filter((x) => x.direct).at(-1)
  return target ? { mid: target.mid, uid: target.uid } : null
}

/** 接话时给她的提示：告诉她已经连着说了几次没人理，让她自己判断要不要停。 */
export function engagedHint(run = 0) {
  const said = run > 1 ? `你已经连着接了 ${run - 1} 次，这期间没人叫你或回你。` : ''
  return `（这段没人提到你。${said}不想接就不接，只回 [沉默]，想停就停，不用找理由。大量重复、没意思的话题不用接，大家在聊自己的、没人接你的话，也该停了；真有话想说再说）`
}

/** 同一段里有重名的人时提醒她按 QQ 号分：名字一样时她很容易忽略括号（#160）。 */
export function sameNameNote(lines) {
  const byName = new Map()
  for (const x of lines) {
    if (!x.nick || !x.uid) continue
    if (!byName.has(x.nick)) byName.set(x.nick, new Set())
    byName.get(x.nick).add(String(x.uid))
  }
  const dup = [...byName].filter(([, ids]) => ids.size > 1).map(([name]) => `「${name}」`)
  return dup.length ? `【注意：${dup.join('、')}这个名字不止一个人在用，他们是不同的人，按括号里的 QQ 号分清楚，别把一个人的事安到另一个人头上。】
` : ''
}
