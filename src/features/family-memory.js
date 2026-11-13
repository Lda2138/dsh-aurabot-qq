// Family identity, source evidence and topic matching shared by live recall and previews.
import { createHash } from 'node:crypto'
import { isOwner, isOwnerSpace, ownerQQs, ownerRoleOf, ownerNameOf } from '../chat/access.js'

export const familySpaceIds = (cfg) => [...ownerQQs(cfg).map((q) => `private:${q}`), ...(cfg.familyGroups || []).map((g) => `group:${g}`)]
export const FAMILY_RECALL_PREFIX = '【家庭联想记忆 v1，'
export const FAMILY_RECALL_END = '【家庭联想记忆结束】'
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)
export function sourceRef(row) {
  return row?._sourceRef || { id: hash([String(row.chatId || ''), Number(row.t) || 0, row.who === 'bot' ? 'bot' : String(row.uid || ''), String(row.text || '')]),
    chatId: String(row.chatId || ''), at: Number(row.t) || 0, speaker: row.who === 'bot' ? 'bot' : String(row.uid || ''), role: row.who === 'bot' ? 'assistant' : 'human' }
}
export const refsOf = (rows) => [...new Map(rows.map((row) => { const ref = sourceRef(row); return [ref.id, ref] })).values()]
export const provenanceBlocked = (entry, blocked) => Boolean(entry?.sourceForgottenAt || (entry?.sourceRefs || []).some((ref) => blocked.has(ref.id)))

const withoutPluginNotes = (text) => String(text || '').replace(/[（(]引用[^\n]*?[」”][）)]|[（(](?:其中\s*\d+\s*张是动图|这里有\s*\d+\s*张图片|这一段里对方一共发了)[^）)\n]*[）)]/g, ' ')
export function cleanRecallQuery(text) {
  return withoutPluginNotes(text)
    .replace(/\[CQ:[^\]]*\]|\[[^\]]{0,100}\]|【(?:图片|动画表情|表情|语音)[^】]*】|<at\b[^>]*>.*?<\/at>|@\d+/gi, ' ')
    .replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim()
}
const GENERIC = new Set(['你好','您好','好的','好吧','知道','谢谢','再见','嘿嘿','哈哈','呵呵','嗯嗯','今天','昨天','明天','现在','刚才','最近','以前','之前','一下','什么','怎么','时候','事情','已经','还有','那个','这个','记得','记住','说过','告诉','是不是','有没有','妈妈','爸爸','主人','回来','上午','中午','下午','晚上','凌晨','早上','早晨','傍晚','今晚','明早','怎么样','近况','好像','问题','注意','前面','发现','觉得','所以','只是','其实','应该','可能','一直','一个','出来','喜欢','帮忙','看看','再说','一遍'])
const WEAK_CHAR = /[的了吗呢吧我你他她它这那啥什怎么也都很就给把让被和与及啊呀哦嗯唉哈呗得着过是有在会能要别再来]/
for (const word of ['非常', '特别', '十分', '比较', '有点', '有些', '一些', '一点', '一件', '一次', '为了', '突然', '真的', '实在', '确实', '当然', '感觉', '好好', '无论', '不过', '但是', '还是', '然后', '而且']) GENERIC.add(word)
const strongTerm = (term) => !GENERIC.has(term) && !WEAK_CHAR.test(term) && !/^(.)\1$/u.test(term) && !/^(?:快|慢|等)(?:点|些)$/.test(term) && !/^[一二两三四五六七八九十几多每些][个张次种条件段点]/.test(term)
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
export function familyAliases(cfg, qq) {
  const role = ownerRoleOf(cfg, qq)
  const aliases = [String(qq), ownerNameOf(cfg, qq), role]
  if (role === '妈妈') aliases.push('你妈', '你妈妈', '咱妈', '妈咪', '母亲')
  if (role === '爸爸') aliases.push('你爸', '你爸爸', '咱爸', '父亲')
  return [...new Set(aliases.filter((s) => s && s !== '主人'))].sort((a, b) => b.length - a.length)
}
export function mentionedFamily(cfg, text) {
  const value = cleanRecallQuery(text)
  return ownerQQs(cfg).filter((qq) => familyAliases(cfg, qq).some((name) => value.includes(name)))
}
export function resolveFamilyPerson(cfg, name) {
  return ownerQQs(cfg).find((qq) => familyAliases(cfg, qq).includes(String(name || '').trim())) || ''
}
export function contentTerms(text, cfg = {}) {
  let value = cleanRecallQuery(text).toLowerCase()
  const aliases = ownerQQs(cfg).flatMap((qq) => familyAliases(cfg, qq)).sort((a, b) => b.length - a.length)
  for (const alias of aliases) value = value.split(alias.toLowerCase()).join(' ')
  const words = [...withoutPluginNotes(text).matchAll(/《([^》]+)》/g)].map((m) => m[1].toLowerCase())
  // Keep actual ICU word boundaries. Unknown single characters are skipped;
  // joining them again would recreate accidental character combinations.
  for (const part of segmenter.segment(value)) {
    const word = part.segment
    if (part.isWordLike && /[\p{L}]/u.test(word) && word.length >= 2) words.push(word)
  }
  return [...new Set(words.filter(strongTerm))]
}
export function meaningfulQuery(text, cfg = {}) {
  const value = cleanRecallQuery(text)
  if (/^(?:[好嗯哦啊哈嘿唉哎呀耶哇啦]+|(?:快|慢|等)(?:点|些|一下|一点)|(?:早|午|晚)安(?:好梦)?|拜拜|ok(?:ay)?)$/i.test(value)) return false
  let body = value
  for (const qq of ownerQQs(cfg)) for (const alias of familyAliases(cfg, qq)) body = body.split(alias).join(' ')
  // This gate also controls fresh cross-window context. A normal sentence can
  // admit fresh context without having enough topic terms to recall old facts.
  const hasSentence = [...body.replace(/[的了吗呢吧我你他她它这那啥什怎么也都很就给把让被和与及啊呀哦嗯唉哎哈呗得着过是有在会能要别再来\s]/g, '').matchAll(/\p{L}/gu)].length >= 3
  return hasSentence || contentTerms(value, cfg).some(strongTerm) || /记得|回忆|想起|说过什么|聊过什么|怎么样|近况|说点|聊点|聊聊|谈心/.test(value) || asksSelfExperience(value)
}
export const explicitRecall = (text) => /记得|回忆|想起|说过什么|聊过什么|上次|之前|昨天|前天|近况|怎么样|后来呢|答应/.test(cleanRecallQuery(text))
export const assistantCommitment = (text) => /我(?:答应|保证)|(?:明天|后天|下次|到时候|我会|我来|我帮你).{0,30}(?:提醒|联系|告诉|转告|问|买|发|做|记着)/s.test(String(text || ''))

/** Document frequency is measured on this visible pool, never on unrelated group chats. */
export function familyTermStats(cfg, items) {
  const counts = new Map(), pairs = new Map()
  for (const item of items) {
    for (const term of contentTerms(item.text, cfg).filter(strongTerm)) counts.set(term, (counts.get(term) || 0) + 1)
    for (const pair of contentPairs(item.text, cfg)) pairs.set(pair, (pairs.get(pair) || 0) + 1)
  }
  return { counts, pairs, size: items.length }
}

/**
 * Two-character pieces after removing family names, used as a second, looser
 * channel when word segmentation finds nothing in common (「拉出来」 vs 「拉出来没有」).
 * Pieces made only of weak characters, or repeated characters, are skipped.
 */
const COMMON_PAIRS = new Set(['没有', '有没', '现在', '在还', '还在', '可能', '不是', '是不', '一个', '这个', '那个', '知道', '时候', '什么', '怎么', '就是', '还是', '不过', '但是', '因为', '所以', '如果', '已经', '一下', '一点', '自己', '我们', '你们', '他们', '她们', '没事', '不要', '要不', '可以', '不能', '能不', '不会', '会不', '不了', '好不', '不好', '真的', '其实', '然后', '一起', '一样', '这么', '那么', '多少', '今天', '明天', '昨天', '晚上', '早上', '中午', '下午', '东西', '事情', '说话', '觉得', '感觉', '的话', '一直', '还没', '没什', '有点', '一会'])
export function contentPairs(text, cfg = {}) {
  let value = cleanRecallQuery(text).toLowerCase()
  for (const alias of ownerQQs(cfg).flatMap((qq) => familyAliases(cfg, qq)).sort((a, b) => b.length - a.length)) value = value.split(alias.toLowerCase()).join(' ')
  const out = new Set()
  for (const run of value.match(/[一-鿿]{2,}/g) || []) {
    for (let i = 0; i < run.length - 1; i++) {
      const pair = run.slice(i, i + 2)
      if (WEAK_CHAR.test(pair[0]) && WEAK_CHAR.test(pair[1])) continue
      if (pair[0] === pair[1] || GENERIC.has(pair) || COMMON_PAIRS.has(pair) || !strongTerm(pair) && WEAK_CHAR.test(pair[0]) || /[妈爸]/.test(pair)) continue
      out.add(pair)
    }
  }
  return [...out]
}

/**
 * What a question is about, beyond literal words: 「多大」 and 「15岁」 are the same
 * topic. `distinct` classes are specific enough to match without naming a person.
 */
export const TOPIC_CLASSES = [
  { key: '年龄', query: /多大|几岁|年龄|年纪|岁数|今年.{0,3}岁/, item: /\d{1,3}\s*(?:周)?岁|[一二三四五六七八九十]{1,3}(?:周)?岁/ },
  { key: '生日', query: /生日|出生|属什么|属相|星座|几月几[号日]/, item: /生日|出生|属[鼠牛虎兔龙蛇马羊猴鸡狗猪]|星座/, distinct: true },
  { key: '怀孕', query: /怀孕|宝宝|弟弟|妹妹|预产期|胎/, item: /怀孕|宝宝|胎|预产期|孕/, distinct: true },
  { key: '纪念日', query: /在一起|相恋|纪念日|恋爱|认识多久|两百天|一百天|周年/, item: /在一起|相恋|纪念日|恋爱|认识|\d+天/, distinct: true },
  { key: '学业', query: /上学|上课|下课|学校|年级|读书|考试|作业|老师|早八|放学/, item: /上学|上课|下课|学校|年级|读书|考试|作业|老师|早八|放学/ },
  { key: '工作', query: /上班|下班|工作|加班|公司|老板|工资/, item: /上班|下班|工作|加班|公司|老板|工资/ },
  { key: '住处', query: /住哪|在哪|哪里人|哪儿人|城市|异地|老家|搬家|离得/, item: /住在|异地|老家|城市|搬家|[省市县]/ },
  { key: '称呼', query: /叫什么|名字|称呼|外号|昵称|怎么叫/, item: /名字|称呼|外号|昵称|叫她|叫他|叫我/ },
  { key: '关系', query: /冷战|吵架|闹别扭|生气|和好|分手|拉黑|黑名单|不理/, item: /冷战|吵架|闹别扭|生气|和好|分手|拉黑|黑名单|不理/ },
  { key: '身体', query: /生病|不舒服|头疼|头痛|感冒|发烧|医院|吃药|难受|累/, item: /生病|不舒服|头疼|头痛|感冒|发烧|医院|吃药|难受/ },
  { key: '喜好', query: /喜欢|爱吃|爱喝|讨厌|不吃|口味|最爱/, item: /喜欢|爱吃|爱喝|讨厌|不吃|口味|最爱/ },
]
export function topicClasses(text, side) {
  const value = cleanRecallQuery(text)
  return TOPIC_CLASSES.filter((c) => c[side].test(value))
}

/**
 * 「他多大了」 has no name in it: take the family member the previous line was about,
 * but only when exactly one family member was mentioned there.
 */
export function resolvePronoun(cfg, query, context = '') {
  if (mentionedFamily(cfg, query).length || !/[他她]|\bta\b/i.test(cleanRecallQuery(query))) return ''
  const people = mentionedFamily(cfg, context)
  return people.length === 1 ? people[0] : ''
}

export const selfExperience = (item) => ['event', 'diary'].includes(item.source) || item.kind === 'seen' || item.sourceType === 'tool_result'
export const asksSelfExperience = (query) => /你.{0,10}(?:(?:看|刷|发|写|画|拍|唱|做|生成).{0,5}(?:过|了|啥|什么)|(?:以前|之前|昨天|今天|最近).{0,6}(?:经历|日记|照片|视频|歌曲))|你(?:的|自己).{0,5}(?:经历|日记|照片|作品)/.test(cleanRecallQuery(query))
export function selfExperienceMatch(query, item) {
  if (!asksSelfExperience(query) || !selfExperience(item)) return false
  if (/日记/.test(query)) return item.source === 'diary'
  if (/照片|图片|画|拍|生图/.test(query)) return /照片|图片|画|改图/.test(item.text) || (item.tags || []).some((t) => /照片|画|改图/.test(t))
  if (/唱|歌曲/.test(query)) return /唱|歌曲/.test(item.text)
  if (/看|刷|视频|B站/i.test(query)) return item.kind === 'seen' || /B站|视频|浏览/.test(item.text)
  return true
}

/** Identity helps rank; a short generic noun alone cannot establish a topic. */
export function familyMatch(cfg, query, item, { peopleRequired = true, termStats, expand = false, impliedPerson = '' } = {}) {
  const terms = contentTerms(query, cfg), have = new Set(contentTerms(item.text, cfg))
  const strong = terms.filter(strongTerm), overlap = strong.filter((term) => have.has(term))
  const people = impliedPerson ? [...new Set([...mentionedFamily(cfg, query), impliedPerson])] : mentionedFamily(cfg, query)
  const person = people.some((qq) => String(item.about || '') === qq || String(item.speaker || '') === qq || mentionedFamily(cfg, item.text).includes(qq))
  if (peopleRequired && people.length && !person) return { relevant: false, score: 0, why: [] }
  const askPerson = person && explicitRecall(query) && !strong.length
  const named = (term) => [item.aboutName, ...(item.names || []), ...[...String(item.text || '').matchAll(/《([^》]+)》|「([^」]+)」/g)].map((m) => m[1] || m[2])].some((name) => name && String(name).toLowerCase() === term)
  const specific = overlap.length === 1 && (overlap[0].length >= 3 || named(overlap[0]))
  const rare = specific && termStats && (termStats.counts.get(overlap[0]) || 0) <= Math.min(4, Math.floor(termStats.size * 0.01))
  const topic = overlap.length >= 2 || specific
  // Looser channels, only for live family recall: same topic class, or shared uncommon two-character pieces.
  let classHit = [], pairHit = []
  if (expand) {
    const itemClasses = new Set(topicClasses(item.text, 'item').map((c) => c.key))
    classHit = topicClasses(query, 'query').filter((c) => itemClasses.has(c.key) && (c.distinct || person))
    if (termStats?.pairs) {
      const mine = new Set(contentPairs(item.text, cfg)), limit = Math.max(2, Math.floor(termStats.size * 0.04))
      pairHit = contentPairs(query, cfg).filter((pair) => mine.has(pair) && (termStats.pairs.get(pair) || 0) <= limit)
    }
  }
  // 只对上两个常见字组（「没有」「现在」）不算同一件事：两个时至少一个要少见，三个以上才放宽
  const rarePairs = pairHit.filter((pair) => (termStats?.pairs?.get(pair) || 0) <= 3)
  const pairTopic = pairHit.length >= 3 || (pairHit.length === 2 && rarePairs.length >= 1) || (pairHit.length === 1 && rarePairs.length === 1 && (termStats?.pairs?.get(pairHit[0]) || 0) <= 2 && person)
  const relevant = topic || askPerson || Boolean(person && explicitRecall(query) && overlap.length) || classHit.length > 0 || pairTopic
  return { relevant, score: overlap.length + (rare ? 0.2 : 0) + (person ? 0.8 : 0) + (askPerson ? 0.3 : 0) + (classHit.length ? 1.2 : 0) + (pairTopic && !topic ? 0.5 * pairHit.length : 0),
    why: [...overlap.slice(0, 4), ...classHit.map((c) => `（同一话题：${c.key}）`), ...(!topic && pairTopic ? pairHit.slice(0, 3) : []), ...(person ? ['（提到家人）'] : [])],
    topic: hash(terms.filter((term) => term.length >= 2).sort()), explicit: explicitRecall(query), sameTopic: classHit.length > 0 }
}

/** Raw bot text is context; only actual delivery records or explicit commitments are searchable events. */
export function familyRawItems(cfg, rows, parseCommand = () => null, now = Date.now()) {
  const out = []
  for (const row of rows) {
    if (!row || row.forgottenAt || row.kind === 'seen' || !isOwnerSpace(cfg, row.chatId) || Number(row.t) > now || parseCommand(row.text)) continue
    const speaker = String(row.uid || (String(row.chatId).startsWith('private:') ? String(row.chatId).slice(8) : ''))
    const bot = row.who === 'bot', text = String(row.text || '').trim()
    if (!text || text.startsWith('【系统') || (!bot && !isOwner(cfg, speaker))) continue
    const commitment = bot && assistantCommitment(text)
    const result = bot && (row.sourceType === 'tool_result' || row.via === 'delivery' || row.deliveryStatus || row.media)
    if (bot && !commitment && !result) continue
    if (!meaningfulQuery(text, cfg)) continue
    const ref = sourceRef(row)
    out.push({ id: 'raw-' + ref.id, text, chatId: row.chatId, at: Number(row.t), saidAt: Number(row.t),
      speaker: bot ? 'bot' : speaker, about: bot ? '' : speaker, importance: 0.5, source: 'raw', sourceType: bot ? commitment ? 'assistant_commitment' : 'tool_result' : 'human',
      sourceRefs: [ref], ...(commitment ? { eventState: '曾答应，尚未核实完成' } : result ? { eventState: row.deliveryStatus || '已发送记录，内容效果未另行核实' } : {}) })
  }
  return out
}
