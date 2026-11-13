import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { ownerNameOf, ownerRoleOf } from '../src/chat/access.js'
import { createMemoryStore } from '../src/features/memory.js'
import { sourceRef, familyMatch, familyTermStats } from '../src/features/family-memory.js'
import { readMemoryState, writeMemoryState } from './helpers/memory-state.js'
import { stripLegacyShortTermPrefix } from '../src/chat/context-recovery.js'

const DAD = '10001', MOM = '10002', GROUP = '777'
const dayKey = (time = Date.now()) => { const d = new Date(time); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` }
const dad = { kind: 'private', userId: DAD, chatId: `private:${DAD}` }
const mom = { kind: 'private', userId: MOM, chatId: `private:${MOM}` }
const family = { kind: 'group', groupId: GROUP, chatId: `group:${GROUP}`, userId: MOM }
function setup(t, rows = [], respond) {
  const previous = process.env.AURABOT_DATA_DIR, workspace = process.env.AURABOT_WORKSPACE
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-association-'))
  process.env.AURABOT_DATA_DIR = dir; process.env.AURABOT_WORKSPACE = join(dir, 'work')
  t.after(() => { if (previous === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = previous; if (workspace === undefined) delete process.env.AURABOT_WORKSPACE; else process.env.AURABOT_WORKSPACE = workspace })
  const cfg = normalize({ ownerQQ: DAD, ownerName: '老登', ownerRole: '爸爸', coOwners: [{ qq: MOM, name: '', role: '妈妈' }], familyGroups: [GROUP], model: { provider: 'p', model: 'm' },
    memory: { dailyConsolidate: false, shortTerm: false, gistEnabled: false, keepChatlogDays: -1, compress: false, extractIdleMinutes: 0 } })
  const requests = [], log = { info() {}, warn() {}, debug() {} }
  const dsh = { get: () => null, llm: { async *stream(request) {
    requests.push(request)
    const result = respond ? await respond(request) : request.system.includes('整理自己的记忆') ? { text: '我记得妈妈喝柠檬茶，爸爸计划周六一起去公园' } : request.system.includes('整理长期记忆') ? { facts: [] } : { insights: [], style: [] }
    yield { type: 'text-delta', text: typeof result === 'string' ? result : JSON.stringify(result) }; yield { type: 'finish', reason: { kind: 'completed' } }
  } } }
  const hub = { chatLogDays: () => [...new Set(rows.map((r) => dayKey(r.t)))], chatLogOf: (day) => rows.filter((r) => dayKey(r.t) === day),
    speakersOf: () => [MOM], lastTextOf: () => '', forgetChatLog: (_qq, query) => { let n=0; for (const row of rows) if (row.text.includes(query) && !row.forgottenAt) { row.forgottenAt = Date.now(); n++ } return n } }
  const mem = createMemoryStore({ dsh, hub, getConfig: () => cfg, log })
  return { cfg, mem, dir, rows, requests, make: () => createMemoryStore({ dsh, hub, getConfig: () => cfg, log }), read: () => readMemoryState(dir), write: (state) => writeMemoryState(dir, state) }
}
const row = (chatId, uid, text, offset = 200000) => ({ chatId, uid, who: uid === DAD ? '爸爸昵称' : uid === MOM ? '妈妈昵称' : 'bot', text, t: Date.now() - offset })
const hint = (mem, chat, q, session = '') => mem.recallHint(chat, q, '', session, [], [], true, false)

test('家庭身份持久化且不替妈妈决定实际称呼', (t) => {
  const { cfg } = setup(t)
  assert.equal(cfg.coOwners[0].name, '')
  assert.equal(ownerNameOf(cfg, MOM), '妈妈'); assert.equal(ownerRoleOf(cfg, DAD), '爸爸')
  assert.equal(ownerRoleOf(normalize({ ownerQQ: DAD }), DAD), '')
})
test('私聊原话跨到家庭群，妈妈群聊事实跨到爸爸私聊；来源和人保持清楚', (t) => {
  const f = setup(t, [row(dad.chatId, DAD, '妈妈今天身体不舒服，在家休息'), row(family.chatId, MOM, '我喜欢喝柠檬茶')])
  assert.match(hint(f.mem, family, '妈妈身体不舒服好点了吗'), /爸爸.*人类原话.*妈妈今天身体不舒服/)
  assert.match(hint(f.mem, dad, '妈妈喜欢喝什么柠檬茶'), /家庭群.*妈妈.*我喜欢喝柠檬茶/)
  const outsider = { kind: 'group', groupId: '888', chatId: 'group:888', userId: '10003' }
  assert.doesNotMatch(hint(f.mem, outsider, '妈妈柠檬茶'), /身体不舒服|我喜欢喝柠檬茶/)
})
test('表情占位、标点和重复提妈妈但换事情，不带旧冲突或外群同名人物', (t) => {
  const f = setup(t, [row(dad.chatId, DAD, '妈妈之前因为工作加班很烦恼'), row('group:888', '10003', '群友称另一个人为妈妈')])
  f.mem.add({ text: '外群称呼某人为妈妈', chatId: 'group:888', about: '10003' })
  for (const q of ['[动画表情]', '[图片]', '。', '嘿嘿', '6', '妈妈回来了', '妈妈吃了吗']) assert.equal(hint(f.mem, dad, q), '', q)
  assert.equal(hint(f.mem, dad, '[动画表情]', 'session-a'), '')
})
test('同一记忆在会话内30分钟去重；换说法或短暂换题不重复；明确追问与到期可重现', (t) => {
  const f = setup(t)
  f.mem.add({ text: '妈妈喜欢喝柠檬茶', about: MOM, speaker: MOM, chatId: family.chatId })
  assert.match(hint(f.mem, dad, '妈妈柠檬茶', 's'), /柠檬茶/)
  assert.equal(hint(f.mem, dad, '妈妈柠檬茶', 's'), '')
  assert.equal(hint(f.make(), dad, '妈妈柠檬茶', 's'), '', '重启后仍识别同一会话里已提醒的证据')
  hint(f.mem, dad, '周末公园路线', 's')
  assert.equal(hint(f.mem, dad, '妈妈柠檬茶', 's'), '')
  assert.equal(hint(f.mem, dad, '妈妈喜欢柠檬茶吗', 's'), '')
  assert.match(hint(f.mem, dad, '再说一遍妈妈柠檬茶', 's'), /柠檬茶/)
  const before = f.read().familyRecallShown
  hint(f.mem, dad, '妈妈柠檬茶')
  assert.deepEqual(f.read().familyRecallShown, before, '只读预览不消耗提醒机会')
  const state = f.read(); state.familyRecallShown.forEach((entry) => { entry.at -= 31 * 60_000 }); f.write(state)
  assert.match(hint(f.mem, dad, '妈妈柠檬茶', 's'), /柠檬茶/)
})

test('不召回本轮任一行或同窗口15分钟内的原话，其他家庭窗口的新消息仍可检索', (t) => {
  const f = setup(t, [row(dad.chatId, DAD, '明天要出差三天', 1), row(dad.chatId, DAD, '昨天喝了柠檬茶', 10 * 60_000),
    row(dad.chatId, DAD, '明天去公园散步', 3600_000), row(mom.chatId, MOM, '我想去公园散步', 1000)])
  assert.equal(hint(f.mem, dad, '明天要出差三天'), '')
  assert.equal(hint(f.mem, dad, '柠檬茶好喝吗'), '')
  assert.doesNotMatch(hint(f.mem, dad, '明天去公园散步\n顺便看看公园路线'), /人类原话\] 明天去公园散步/)
  assert.match(hint(f.mem, dad, '公园散步路线'), /与妈妈私聊/)
})

test('复查原句的弱字组、问句碎片和时间词不构成相关性', (t) => {
  const cases = [
    ['你多大了', '脑洞也太大了'], ['给你加个更棒的音轨', '给你自己也来一张'],
    ['给你加个更棒的音轨', '记得让你妈赶紧给你起个名字'], ['商家送了点水煎包', '我刚才送了一张照片'],
    ['吃了', '爸爸昨晚吃了零食'], ['放香蕉干什么', '那你喜欢干什么'], ['中午吃什么', '今天中午爸爸问她在哪里'],
  ]
  for (const [query, text] of cases) {
    const f = setup(t, [row(mom.chatId, MOM, text, 3600_000)])
    assert.equal(hint(f.mem, dad, query), '', query + ' → ' + text)
  }
})

test('单个普通短词不命中；长实词、专名和两个话题词可以命中', (t) => {
  const { cfg } = setup(t)
  const items = Array.from({ length: 8 }, (_, i) => ({ text: `午饭安排第${i}次` }))
  const termStats = familyTermStats(cfg, items)
  assert.equal(familyMatch(cfg, '午饭准备吃饺子', items[0], { termStats }).relevant, false)
  assert.equal(familyMatch(cfg, '午饭', items[0], { termStats }).relevant, false)
  items.push({ text: '录好了新的音轨' })
  assert.equal(familyMatch(cfg, '给你加个更棒的音轨', items.at(-1), { termStats: familyTermStats(cfg, items) }).relevant, false)
  assert.equal(familyMatch(cfg, '妈妈喝柠檬茶', { text: '妈妈喜欢喝柠檬茶' }, { termStats }).relevant, true)
  assert.equal(familyMatch(cfg, '周末去公园散步', { text: '周末公园野餐' }, { termStats }).relevant, true)
})

test('连续换说法催照片不重贴同一记录；新会话、明确追问和更新内容可重新提示', (t) => {
  const f = setup(t)
  const item = f.mem.add({ text: '生成并发送了一张角色照片', source: 'event', sourceType: 'tool_result', chatId: mom.chatId })
  assert.equal(hint(f.mem, dad, '拍张照片看看', 's'), '', '请求新照片不是在回忆以往发图')
  assert.match(hint(f.mem, dad, '你之前发过什么照片', 's'), /角色照片/)
  assert.equal(hint(f.mem, dad, '照片呢快点', 's'), '')
  assert.equal(hint(f.mem, dad, '再来一张照片', 's'), '')
  assert.match(hint(f.mem, dad, '你发过照片吗', 'other'), /角色照片/)
  assert.match(hint(f.mem, dad, '记得你之前发过什么照片吗', 's'), /角色照片/)
  f.mem.update(item.id, { text: '生成并发送了一张角色照片，已补充发送状态' })
  assert.match(hint(f.mem, dad, '你发过照片吗', 's'), /补充发送状态/)
})

test('同一原话的提炼条目和原话不能换入口重复提示；寒暄不召回旧片段', (t) => {
  const original = row(mom.chatId, MOM, '妈妈分享了一张角色照片', 3600_000)
  const f = setup(t, [original])
  f.mem.add({ text: '妈妈分享过角色照片', about: MOM, speaker: MOM, source: 'auto', sourceType: 'human', chatId: mom.chatId, sourceRefs: [sourceRef(original)] })
  assert.match(hint(f.mem, dad, '角色照片', 's'), /角色照片/)
  assert.equal(hint(f.mem, dad, '照片再看看', 's'), '')
  f.mem.add({ text: '爸爸昨晚说过晚安好梦', about: DAD, chatId: dad.chatId })
  for (const q of ['OK', '快点', '好耶', '晚安', '晚安好梦']) assert.equal(hint(f.mem, dad, q), '', q)
})

test('明确询问昨天家庭群时，显式回忆兜底也尊重日期和窗口', (t) => {
  const f = setup(t); f.cfg.memory.gistEnabled = true
  const start = new Date().setHours(0, 0, 0, 0), state = f.read()
  state.gists = [
    { id: 'yesterday-group', kind: 'gist', chatId: family.chatId, text: '家庭群昨天聊了野餐', at: Date.now(), saidAt: start - 3600_000 },
    { id: 'today-group', kind: 'gist', chatId: family.chatId, text: '家庭群今天聊了画画', at: Date.now(), saidAt: start + 1000 },
    { id: 'yesterday-private', kind: 'gist', chatId: dad.chatId, text: '爸爸私聊时谈到家庭群', at: Date.now(), saidAt: start - 3600_000 },
  ]; f.write(state)
  const text = hint(f.mem, dad, '昨天家庭群聊过什么')
  assert.match(text, /昨天聊了野餐/)
  assert.doesNotMatch(text, /今天聊了画画|爸爸私聊时/)
})

test('家庭群和代词不触发外群背景，指定外群时只补所问群', (t) => {
  const f = setup(t, [row(family.chatId, MOM, '家庭群真实近况', 3600_000), row('group:888', '30001', '外群八号的聊天', 3600_000), row('group:999', '30002', '外群九号的聊天', 3600_000)])
  f.cfg.group.ownerBrief = { enabled: true, lines: 12, groups: [] }
  for (const q of ['昨天家庭群聊过什么', '他们在干什么', '大家最近怎么样']) assert.doesNotMatch(hint(f.mem, dad, q), /外群八号|外群九号/)
  const text = hint(f.mem, dad, '群888聊过什么')
  assert.match(text, /外群八号/)
  assert.doesNotMatch(text, /外群九号|家庭群真实近况/)
})

test('常驻经历同类只留一条，图片提示词保留在原记录而不进入常驻上下文', (t) => {
  const f = setup(t)
  f.mem.addEvent({ text: '翻唱了一首歌曲', tags: ['翻唱'] })
  for (const tag of ['照片', '照片', '改图', '画画']) f.mem.addEvent({ text: `生成并发送了一张图片（按提示词生成）：独有提示词${tag}`, tags: [tag] })
  const text = f.mem.contextFor(dad)
  assert.equal((text.match(/生成并发送了一张图片/g) || []).length, 1)
  assert.match(text, /翻唱了一首歌曲/)
  assert.doesNotMatch(text, /独有提示词|按提示词生成/)
  assert.ok(f.mem.list('').some((m) => m.text.includes('独有提示词')))
})
test('旧助手拒绝不是画像证据；已发出的承诺可以回忆且不算完成', (t) => {
  const f = setup(t, [row(mom.chatId, '', '我说过了，不愿意聊这个'), row(mom.chatId, '', '我明天提醒妈妈带雨伞', 100000)])
  assert.equal(hint(f.mem, dad, '妈妈愿意聊什么'), '')
  assert.match(hint(f.mem, dad, '你答应提醒妈妈带雨伞'), /你的承诺.*尚未核实完成/)
})
test('遗忘源同时撤下换说法的事实、梗概、画像和经验，关联不能绕过', (t) => {
  const original = row(mom.chatId, MOM, '我今天去花店买了玫瑰')
  const f = setup(t, [original]), sourceRefs = [sourceRef(original)]
  const r = f.mem.add({ text: '妈妈买鲜花送给家人', about: MOM, chatId: mom.chatId, sourceRefs })
  const s = f.read(); s.gists = [{ id: 'g', kind: 'gist', chatId: mom.chatId, text: '妈妈给家人准备花束', sourceRefs, at: Date.now(), saidAt: Date.now() }]
  s.profiles = { [MOM]: { text: '妈妈准备花束', sourceRefs } }; s.insights = { [`qq:${MOM}`]: [{ id: 'i', text: '妈妈准备花束', sourceRefs }] }; f.write(s)
  original.forgottenAt = Date.now()
  assert.equal(hint(f.mem, dad, '妈妈花束鲜花'), '')
  assert.doesNotMatch(f.mem.contextFor(dad), /花束|鲜花/)
  assert.equal(f.mem.gists().length, 0); assert.equal(f.mem.list('').find((m) => m.id === r.id).sourceForgottenAt > 0, true)
})
test('家庭跨人跨窗口建关联，外群仍然隔离', (t) => {
  const f = setup(t)
  const a = f.mem.add({ text: '妈妈想去周末公园散步', about: MOM, chatId: mom.chatId })
  const b = f.mem.add({ text: '爸爸准备周末公园野餐', about: DAD, chatId: dad.chatId })
  const c = f.mem.add({ text: '外群周末公园聚餐', about: '10003', chatId: 'group:888' })
  const items = f.mem.list('')
  assert.ok(items.find((m) => m.id === a.id).related.includes(b.id))
  assert.ok(!items.find((m) => m.id === a.id).related.includes(c.id))
})
test('家庭回补使用独立预算，包含已处理日常；忽略已忘来源且相同请求可安全重试', async (t) => {
  const rows = [row(family.chatId, MOM, '我今天喝了柠檬茶'), { ...row(dad.chatId, DAD, '这句旧话不要回来'), forgottenAt: Date.now() }]
  const f = setup(t, rows, (request) => request.system.includes('整理长期记忆') ? { facts: [{ text: '妈妈告诉我今天喝了柠檬茶', speaker: MOM, about_qq: MOM, status: 'fact' }] } : { insights: [], style: [] })
  const s = f.read(); s.extractBatches = { day: dayKey(), count: 24 }; s.processed = { [dayKey()]: { offset: 2, end: 2, chats: {} } }; f.write(s)
  const preview = await f.mem.backfillFamily({ days: [dayKey()], dryRun: true })
  assert.equal(preview.excludedSources, 1)
  const result = await f.mem.backfillFamily({ days: [dayKey()], requestId: 'once' })
  assert.equal(result.status, 'completed'); assert.equal(f.read().extractBatches.count, 24)
  assert.equal(f.read().familyBudgets.backfill, 1); assert.equal(f.read().familyBudgets.extract, 0)
  assert.match(hint(f.mem, dad, '妈妈柠檬茶'), /柠檬茶/)
  assert.ok(f.mem.list('').find((m) => m.text.includes('柠檬茶')).sourceRefs.length)
  const n = f.requests.length
  assert.equal((await f.mem.backfillFamily({ days: [dayKey()], requestId: 'once' })).status, 'already_completed')
  assert.equal(f.requests.length, n)
})
test('模型处理中提出遗忘，不提交旧事实或处理进度', async (t) => {
  const original = row(family.chatId, MOM, '我去了公园赏樱')
  let f
  f = setup(t, [original], (request) => {
    if (request.system.includes('整理长期记忆')) { original.forgottenAt = Date.now(); return { facts: [{ text: '妈妈去了公园赏樱', speaker: MOM, about_qq: MOM }] } }
    return { insights: [], style: [] }
  })
  const result = await f.mem.backfillFamily({ days: [dayKey()], requestId: 'forget-race' })
  assert.equal(result.ok, false)
  assert.equal(result.job.completed.length, 0)
  assert.doesNotMatch(JSON.stringify(f.mem.list('')), /公园赏樱/)
})
test('每日各窗口及全家梗概独立记账并可跨窗口召回', async (t) => {
  const f = setup(t, [row(mom.chatId, MOM, '妈妈今天喝柠檬茶'), row(dad.chatId, DAD, '爸爸计划周六一起去公园')])
  f.cfg.memory.gistEnabled = true
  const result = await f.mem.familyDailyGists({ days: [dayKey()], force: true })
  assert.equal(result.generated, 3)
  assert.equal(f.read().familyBudgets.gist, 3)
  assert.equal(f.read().extractBatches, undefined)
  assert.ok(f.mem.gists().some((g) => g.chatId === 'family:all'))
  assert.match(hint(f.mem, family, '妈妈柠檬茶'), /柠檬茶/)
})
test('更正后的事实不会被旧原话和旧梗概覆盖', (t) => {
  const old = row(mom.chatId, MOM, '我喜欢喝浓咖啡', 400000), current = row(family.chatId, MOM, '我已经改喝柠檬茶了', 200000)
  const f = setup(t, [old, current]), s = f.read()
  s.items = [{ id:'old', text:'妈妈喜欢浓咖啡', about:MOM, chatId:mom.chatId, at:old.t, saidAt:old.t, invalidAt:current.t, validUntil:current.t, sourceRefs:[sourceRef(old)] },
    { id:'new', text:'妈妈现在改喝柠檬茶', about:MOM, speaker:MOM, chatId:family.chatId, at:current.t, saidAt:current.t, sourceRefs:[sourceRef(current)] }]
  s.gists = [{ id:'old-gist', kind:'gist', chatId:mom.chatId, text:'妈妈喜欢浓咖啡', at:old.t, saidAt:old.t, sourceRefs:[sourceRef(old)] }]
  f.write(s)
  assert.doesNotMatch(hint(f.mem, dad, '妈妈现在喝浓咖啡还是柠檬茶'), /喜欢浓咖啡|喜欢喝浓咖啡/)
  assert.match(hint(f.mem, dad, '妈妈现在喝浓咖啡还是柠檬茶'), /改喝柠檬茶/)
})
test('家庭群短期证据按真实人归档，两位家人不混成同一个对方', async (t) => {
  const f = setup(t, [row(family.chatId, DAD, '我准备周六去公园', 400000), row(family.chatId, MOM, '我最近喜欢喝柠檬茶', 300000)],
    (request) => request.system.includes('整理短期对话') ? { human:[{source:0}], assistant:[], feelings:[] } : {insights:[],style:[]})
  f.cfg.memory.shortTerm = true
  const result = await f.mem.reviewShortTerm([DAD, MOM])
  assert.equal(result.reviewed, 2)
  assert.deepEqual(f.read().shortTerm[DAD].evidence.human.map((e)=>e.speaker), [DAD])
  assert.deepEqual(f.read().shortTerm[MOM].evidence.human.map((e)=>e.speaker), [MOM])
  assert.equal(f.read().shortTerm[MOM].evidence.human[0].chatId, family.chatId)
})
test('新联想块从下一轮派生上下文撤下，真实用户原话和媒体不变', (t) => {
  const f=setup(t,[row(mom.chatId,MOM,'妈妈今天喝柠檬茶')])
  const recalled=hint(f.mem,dad,'妈妈柠檬茶')
  const content=[{type:'text',text:recalled},{type:'image',url:'keep-image'},{type:'text',text:'妈妈今天喝柠檬茶，这是我的真实提问'}]
  const cleaned=stripLegacyShortTermPrefix(content,{includeV2:true,includeCross:true})
  assert.equal(cleaned.removedBlocks,1)
  assert.deepEqual(cleaned.content,content.slice(1))
  assert.equal(cleaned.removedCrossBlocks,0,'联想清理不推进近况推送水位')
})
test('标点或数字可说明表达形式，不能作为长期相处建议或性格的证据', async (t) => {
  const f=setup(t,[row(family.chatId,MOM,'666')],(request)=>request.system.includes('在回顾') ?
    {insights:[{text:'对方希望我以后不追问并软性拒绝',speaker:MOM,quote:'666'}],style:[{text:'常用简短数字回复',speaker:MOM,quote:'666'}]} : {facts:[]})
  const result=await f.mem.backfillFamily({days:[dayKey()],requestId:'short-evidence'})
  assert.equal(result.ok,true)
  assert.deepEqual(f.read().insights?.[`qq:${MOM}`]||[],[])
  assert.deepEqual(f.read().styles?.[`qq:${MOM}`],['常用简短数字回复'])
})
test('家庭梗概拒收被截断的JSON，失败保留原话并允许以后重试', async (t) => {
  let broken=true
  const f=setup(t,[row(mom.chatId,MOM,'妈妈今天喝柠檬茶')],(request)=>request.system.includes('整理自己的记忆') ? (broken ? '{"text":"半截内容' : {text:'妈妈告诉我今天喝了柠檬茶'}) : {facts:[]})
  f.cfg.memory.gistEnabled=true
  assert.equal((await f.mem.familyDailyGists({days:[dayKey()],force:true})).generated,0)
  assert.equal(f.mem.gists().length,0)
  assert.equal(f.rows.length,1)
  broken=false
  assert.equal((await f.mem.familyDailyGists({days:[dayKey()],force:true})).generated,1)
  assert.equal(f.mem.gists()[0].text,'妈妈告诉我今天喝了柠檬茶')
  assert.equal(f.requests[0].reasoningEffort,'off')
})
test('模型提炼内容明确标为非逐字，不冒充人类原话', (t) => {
  const f=setup(t)
  f.mem.add({text:'妈妈告诉我她喜欢柠檬茶',about:MOM,speaker:MOM,source:'auto',sourceType:'human',chatId:mom.chatId})
  assert.match(hint(f.mem,dad,'妈妈柠檬茶'),/原话提炼（非逐字）/)
})
