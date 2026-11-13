import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { createMemoryStore } from '../src/features/memory.js'
import { readMemoryState, writeMemoryState } from './helpers/memory-state.js'
import memoryModule from '../src/modules/memory/index.js'

const OWNER = '10001', OTHER = '10002', log = { info() {}, warn() {}, debug() {} }
const chat = (id) => ({ kind: 'private', chatId: `private:${id}`, userId: id })
const answer = (human = [], assistant = [], feelings = []) => ({ human, assistant, feelings })
function setup(t, { respond = () => answer([{ source: 0 }]), rows, legacy = true } = {}) {
  const previous = process.env.AURABOT_DATA_DIR, previousWorkspace = process.env.AURABOT_WORKSPACE, dir = mkdtempSync(join(tmpdir(), 'aurabot-shortterm-evidence-'))
  process.env.AURABOT_DATA_DIR = dir
  process.env.AURABOT_WORKSPACE = join(dir, 'workspace')
  t.after(() => {
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = previous
    if (previousWorkspace === undefined) delete process.env.AURABOT_WORKSPACE; else process.env.AURABOT_WORKSPACE = previousWorkspace
  })
  const cfg = normalize({ ownerQQ: OWNER, coOwners: [{ qq: OTHER, name: '妈妈' }], model: { provider: 'short-evidence', model: 'fake' },
    memory: { dailyConsolidate: false, keepChatlogDays: -1, gistEnabled: false } })
  const now = Date.now(), calls = []
  rows ||= [{ chatId: `private:${OWNER}`, who: '爸爸', uid: OWNER, text: '请帮我想一条周末的旅行路线', t: now-5*60_000, via: 'douyin' },
    { chatId: `private:${OWNER}`, who: 'bot', text: '刚才没空查，等你说目的地后再一起看', t: now-4*60_000, via: 'qq' },
    { chatId: `private:${OWNER}`, who: 'bot', text: '我刚才有点疲倦', t: now-3*60_000, via: 'qq' }]
  const dsh = { get: () => null, llm: { async *stream(request) {
    calls.push(request)
    const value = await respond(request, calls.length-1)
    if (value instanceof Error) throw value
    yield { type: 'text-delta', text: typeof value === 'string' ? value : JSON.stringify(value) }
    yield { type: 'finish', reason: { kind: 'completed' } }
  } } }
  const logDay = (at) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` }
  const days = () => [...new Set(rows.map((r) => logDay(r.t)))].sort()
  const hub = { chatLogDays: days, chatLogOf: (day) => rows.filter((r) => logDay(r.t) === day), forgetChatLog() {}, logChat() {} }
  const mem = createMemoryStore({ dsh, getConfig: () => cfg, hub, log })
  mem.add({ text: '家里约好周六一起去公园', source: 'panel', about: OWNER, tags: ['家人偏好'], tier: 0 })
  if (legacy) {
    const state = readMemoryState(dir)
    state.shortTerm = { [OWNER]: { text: '旧无来源推断：他不尊重我，所以以后必须拒绝这个话题', at: now-200000, through: now-240000 },
      [OTHER]: { text: '另一个人的旧印象', at: now-200000, through: now-240000 } }
    writeMemoryState(dir, state)
  }
  return { dir, cfg, mem, hub, dsh, rows, now, calls, read: () => readMemoryState(dir) }
}
const transcript = (request) => JSON.parse(request.messages[0].content[0].text).transcript

test('忘记旧话后只剩助手记录时不调用摘要模型；真正的新输入仍能形成短期记录',async(t)=>{
  const now=Date.now(),f=setup(t,{legacy:false,rows:[
    {chatId:`private:${OWNER}`,who:'爸爸',uid:OWNER,text:'已要求忘掉的旧话',t:now-5000,forgottenAt:now-4000},
    {chatId:`private:${OWNER}`,who:'bot',text:'助手自己的历史回应',t:now-3000}],respond:()=>answer([{source:1}])})
  f.cfg.memory.shortTermIdleMinutes=0
  await f.mem.tick()
  assert.equal(f.calls.length,0)
  assert.equal(f.mem.personaPerson(OWNER).shortTerm,null)
  f.rows.push({chatId:`private:${OWNER}`,who:'爸爸',uid:OWNER,text:'现在有一条全新的旅行安排',t:Date.now()-1})
  await f.mem.tick()
  assert.equal(f.calls.length,1)
  assert.match(f.mem.shortTermContextFor(OWNER),/全新的旅行安排/)
  assert.doesNotMatch(f.mem.shortTermContextFor(OWNER),/已要求忘掉|助手自己的历史回应/)
})

test('无证据v1不再进入当前私聊推断，也不把旧动机判断喂给重建模型', async (t) => {
  const f = setup(t)
  assert.equal(f.mem.personaPerson(OWNER).shortTerm, null)
  assert.doesNotMatch(f.mem.recallHint(chat(OWNER), '你好'), /旧无来源推断|不尊重我|必须拒绝/)
  assert.doesNotMatch(f.mem.contextVia({ qq: OWNER }), /旧无来源推断/)
  assert.equal(f.calls.length, 0)
  await f.mem.reviewShortTerm([OWNER])
  assert.doesNotMatch(f.calls[0].messages[0].content[0].text, /旧无来源推断|不尊重我|必须拒绝/)
})

test('v2仅提醒人类原话，助手历史回应和主观感受单独留存不重复注入', async (t) => {
  const f = setup(t, { respond: () => answer([{ source: 0, text: '没有证据的动机结论' }], [{ source: 1 }], [{ source: 2 }]) })
  const result = await f.mem.reviewShortTerm([OWNER])
  assert.equal(result.ok, true)
  assert.equal(result.reviewed, 1)
  const state = f.read().shortTerm[OWNER]
  assert.equal(state.version, 2)
  assert.equal(state.evidence.human[0].speaker, OWNER)
  assert.equal(state.evidence.human[0].at, f.rows[0].t)
  assert.equal(state.evidence.human[0].via, 'douyin')
  assert.equal(state.evidence.assistant[0].speaker, 'bot')
  assert.equal(state.evidence.feelings[0].quote, '我刚才有点疲倦')
  const hint = f.mem.recallHint(chat(OWNER), '接着聊')
  assert.match(hint, /短期对话记录 v2，原聊/)
  assert.match(hint, /整理于/)
  assert.match(hint, /爸爸说.*抖音.*请帮我想一条周末的旅行路线/)
  assert.match(hint, /助手历史回应仍在原会话中，不在短期提醒重复/)
  assert.match(hint, /不代表当前立场或今后的规则/)
  assert.doesNotMatch(hint, /刚才没空查|我刚才有点疲倦|没有证据的动机结论|旧无来源推断/)
  assert.doesNotMatch(state.text, /刚才没空查|我刚才有点疲倦/)
  assert.equal(f.mem.personaPerson(OWNER).shortTerm.text, state.text)
  assert.match(f.mem.contextVia({ qq: OWNER }), /短期对话记录 v2/)
  assert.doesNotMatch(f.mem.recallHint(chat(OTHER), '接着聊'), /短期对话记录 v2/)
  assert.doesNotMatch(f.mem.recallHint({ kind: 'group', chatId: 'group:777', groupId: '777', userId: OWNER }, '接着聊'), /短期对话记录 v2/)
})

test('指定人重建只归档该人，持久迁移标记可供旧会话失效且不修改事实items', async (t) => {
  const f = setup(t)
  const before = f.read(), result = await f.mem.reviewShortTerm([`qq:${OWNER}`]), after = f.read()
  assert.deepEqual(after.items, before.items)
  assert.deepEqual(after.shortTerm[OTHER], before.shortTerm[OTHER])
  assert.equal(after.shortTermArchive.length, 1)
  assert.deepEqual(after.shortTermArchive[0].state, before.shortTerm[OWNER])
  const revision = f.mem.shortTermRevisionOf(OWNER)
  assert.equal(revision.version, 2)
  assert.equal(revision.previousAt, before.shortTerm[OWNER].at)
  assert.equal(revision.previousThrough, before.shortTerm[OWNER].through)
  assert.ok(revision.revision)
  assert.equal(result.amendments[0].chatId, `private:${OWNER}`)
  assert.equal(result.amendments[0].revision, revision.revision)
  assert.match(result.amendments[0].text, /旧版无来源的短期印象已经失效/)
})

test('bot不能冒充human证据，改写引文和不完整JSON不激活旧摘要且不重试', async (t) => {
  for (const value of [answer([{ source: 1 }]), answer([{ source: 0, quote: '拼造的用户原话' }]), '{"human":[']) {
    const f = setup(t, { respond: () => value })
    const before = f.read().items, result = await f.mem.reviewShortTerm([OWNER])
    assert.equal(result.ok, false)
    assert.equal(result.failed, 1)
    assert.equal(f.calls.length, 1)
    assert.equal(f.read().shortTerm[OWNER], undefined)
    assert.equal(f.mem.personaPerson(OWNER).shortTerm, null)
    assert.equal(f.read().shortTermArchive.length, 1)
    assert.ok(f.mem.shortTermRevisionOf(OWNER))
    assert.deepEqual(f.read().items, before)
    assert.doesNotMatch(JSON.stringify(result), /旧无来源推断|拼造的用户原话/)
  }
})

test('模型输入只取窗口内该人的有界原话，截断源码行仍可验证精确节选', async (t) => {
  const rows = [], now = Date.now()
  for (let n=0;n<110;n++) rows.push({ chatId: `private:${OWNER}`, who: '爸爸', uid: OWNER, t: now-500000+n*1000, text: `第${n}条：`+'甲'.repeat(700) })
  rows.push({ chatId: `private:${OTHER}`, who: '妈妈', uid: OTHER, t: now-250000, text: '另一个人的内容' })
  rows.push({ chatId: `private:${OWNER}`, who: 'bot', kind: 'seen', t: now-220000, text: '不能纳入旁观记录' })
  rows.push({ chatId: `private:${OWNER}`, who: '系统', t: now-210000, text: '不能纳入系统事件' })
  const f = setup(t, { rows, respond: (request) => {
    const input = transcript(request)
    assert.ok(input.length <= 40)
    assert.ok(input.reduce((n,row) => n+row.text.length,0) <= 12000)
    assert.ok(input.every((row) => row.text.length <= 500))
    assert.ok(input.every((row) => row.speaker === OWNER))
    assert.doesNotMatch(JSON.stringify(input), /另一个人的内容|旁观记录|系统事件/)
    return answer([{ source: input.length-1, quote: input.at(-1).text.slice(0,20) }])
  } })
  assert.equal((await f.mem.reviewShortTerm([OWNER])).ok, true)
})

test('未空闲不运行普通摘要；v2按最后原聊时间过期，关闭后不注入', async (t) => {
  const f = setup(t, { legacy: false })
  f.rows.forEach((row) => { row.t=Date.now()-1000; row.via='qq' })
  await f.mem.tick()
  assert.equal(f.calls.length, 0)
  assert.equal((await f.mem.reviewShortTerm([OWNER])).ok, true)
  assert.match(f.mem.contextVia({ qq: OWNER }), /短期对话记录 v2/)
  f.cfg.memory.shortTermHours = 0.000001
  assert.doesNotMatch(f.mem.contextVia({ qq: OWNER }), /短期对话记录 v2/)
  f.cfg.memory.shortTermHours = 2
  f.cfg.memory.shortTerm = false
  assert.doesNotMatch(f.mem.contextVia({ qq: OWNER }), /短期对话记录 v2/)
})

test('无明确人和非POST管理请求不启动重建，管理route仅返回修正不发送QQ', async (t) => {
  const f = setup(t)
  assert.equal((await f.mem.reviewShortTerm([])).status, 'no_eligible_people')
  assert.equal((await f.mem.reviewShortTerm(['group:777'])).status, 'no_eligible_people')
  let management, sends = 0
  const api = { config: () => f.cfg, dsh: f.dsh, log,
    core: { hub: { ...f.hub, sendText() { sends++ } }, http: { body: async (req) => req.body || {} } },
    route: (path, fn) => { if (path === '/memory/review-shortterm') management = fn }, rule() {}, context() {}, on() {}, every() {}, tool() {} }
  memoryModule.setup(api)
  assert.equal((await management({ method: 'GET', body: { people: [OWNER] } })).status, 'method_not_allowed')
  assert.equal(f.calls.length, 0)
  const result = await management({ method: 'POST', body: { people: [OWNER] } })
  assert.equal(result.reviewed, 1)
  assert.equal(sends, 0)
})

test('重建期间忘记请求使结果失效，不把已忘记原话再次激活', async (t) => {
  let memory
  const f = setup(t, { respond: () => {
    memory.handleCommand(chat(OWNER), '忘掉旅行路线')
    return answer([{ source: 0 }])
  } })
  memory = f.mem
  const result = await f.mem.reviewShortTerm([OWNER])
  assert.equal(result.ok, false)
  assert.equal(result.people[0].status, 'stale')
  assert.equal(f.read().shortTerm?.[OWNER], undefined)
  assert.doesNotMatch(f.mem.contextVia({ qq: OWNER }), /短期对话记录 v2/)
})

test('新v2提示在跨午夜或括号原话中仍整块剥离，不当成下一轮人类证据', async (t) => {
  const f = setup(t)
  f.rows[0].text = '请聊旅行（只是想法）以及天气'
  await f.mem.reviewShortTerm([OWNER])
  const hint = f.mem.recallHint(chat(OWNER), '继续', '', '', undefined, undefined, false, false)
  f.rows.push({ chatId: `private:${OWNER}`, who: '爸爸', uid: OWNER, t: Date.now()-1000, text: hint+'\n现在只聊今天的天气' })
  await f.mem.reviewShortTerm([OWNER])
  const input = transcript(f.calls.at(-1))
  assert.equal(input.at(-1).text.trim(), '现在只聊今天的天气')
  assert.doesNotMatch(input.at(-1).text, /短期对话记录 v2|只是想法/)
})

test('人名参数规范化去重，显示摘要沿用shortTermChars且证据不被展示截断改写', async (t) => {
  const f = setup(t)
  f.cfg.memory.shortTermChars = 16
  const result = await f.mem.reviewShortTerm([OWNER, `qq:${OWNER}`, `private:${OWNER}`])
  assert.equal(result.people.length, 1)
  assert.equal(f.calls.length, 1)
  const state = f.read().shortTerm[OWNER]
  assert.ok([...state.text].length <= 16)
  assert.equal(state.evidence.human[0].quote, f.rows[0].text)
})

test('已存v2的assistant旧立场不会从hint或UI再注入，跨平台真实动作记录仍可独立召回', async (t) => {
  const f = setup(t)
  await f.mem.reviewShortTerm([OWNER])
  const before = f.read(), sourceAt = before.shortTerm[OWNER].through
  before.shortTerm[OWNER].text = '不提供这个；我不会改主意；不要再问'
  before.shortTerm[OWNER].evidence.assistant = ['不提供这个', '我不会改主意', '不要再问'].map((quote, source) => ({ role: 'assistant', source, speaker: 'bot', at: sourceAt, quote, chatId: `private:${OWNER}`, via: 'qq' }))
  writeMemoryState(f.dir, before)
  f.mem.addEvent({ text: '已在小黑盒发出周末旅行路线的提醒', tags: ['小黑盒'], importance: 0.8 })
  const factsBefore = f.read().items
  const ui = f.mem.personaPerson(OWNER).shortTerm
  assert.match(ui.text, /请帮我想一条周末的旅行路线/)
  assert.doesNotMatch(ui.text, /不提供这个|不会改主意|不要再问/)
  assert.equal(ui.evidence.assistant.length, 3, '历史回应仍可审计和按需查看')
  const hint = f.mem.recallHint(chat(OWNER), '周末旅行路线提醒', '', '', undefined, undefined, false, false)
  assert.doesNotMatch(hint, /不提供这个|不会改主意|不要再问/)
  assert.match(f.mem.contextFor(chat(OWNER), ''), /已在小黑盒发出周末旅行路线的提醒/)
  assert.deepEqual(f.read().items.map(({ hits, hitDays, lastHit, ...row }) => row), factsBefore.map(({ hits, hitDays, lastHit, ...row }) => row), '只允许召回计数更新，动作事实内容保持')
  assert.equal(f.calls.length, 1, '读已有v2无需再次调用模型')
})

test('只读shortTermContextFor与实际短期提醒一致，不触发召回或写入', async (t) => {
  const f = setup(t, { respond: () => answer([{ source: 0 }], [{ source: 1 }], [{ source: 2 }]) })
  await f.mem.reviewShortTerm([OWNER])
  const before = f.read(), recalls = f.mem.recalls(), calls = f.calls.length
  const preview = f.mem.shortTermContextFor(OWNER)
  assert.match(preview, /短期对话记录 v2/)
  assert.match(preview, /请帮我想一条周末的旅行路线/)
  assert.doesNotMatch(preview, /刚才没空查|我刚才有点疲倦/)
  assert.equal(f.mem.shortTermContextFor(OTHER), '')
  assert.deepEqual(f.mem.recalls(), recalls)
  assert.deepEqual(f.read(), before)
  assert.equal(f.calls.length, calls)
})

test('同一会话同revision只提示一次且跨实例持久，新revision或不同会话可再提示', async (t) => {
  const f = setup(t)
  await f.mem.reviewShortTerm([OWNER])
  const first = f.mem.recallHint(chat(OWNER), '继续', '', 'session-one', undefined, undefined, false, false)
  assert.match(first, /短期对话记录 v2/)
  assert.match(first, /本轮新陈述、明确更正与换话题优先/)
  assert.doesNotMatch(f.mem.recallHint(chat(OWNER), '现在换个问题', '', 'one', undefined, undefined, false, false), /短期对话记录 v2/)
  const reloaded = createMemoryStore({ dsh: f.dsh, getConfig: () => f.cfg, hub: f.hub, log })
  assert.doesNotMatch(reloaded.recallHint(chat(OWNER), '重新加载后的新问题', '', 'session-one', undefined, undefined, false, false), /短期对话记录 v2/)
  assert.match(reloaded.recallHint(chat(OWNER), '另一个会话', '', 'session-two', undefined, undefined, false, false), /短期对话记录 v2/)
  const saved = f.read(), revision = saved.shortTerm[OWNER].revision
  saved.shortTerm[OWNER].revision = 'fresh-revision'
  saved.shortTerm[OWNER].evidence.human[0].quote = '刚刚更正，周末暂时不去旅行'
  saved.shortTerm[OWNER].evidence.human[0].at += 1
  writeMemoryState(f.dir, saved)
  assert.match(f.mem.recallHint(chat(OWNER), '接新话题', '', 'session-one', undefined, undefined, false, false), /短期对话记录 v2/)
  assert.ok(f.read().shortTermShown.some((entry) => entry.revision === revision))
  assert.ok(f.read().shortTermShown.some((entry) => entry.revision.startsWith('human-') && entry.revision !== revision))
})

test('没有sessionId的只读短期预览不消耗实际会话机会，ledger有界且原始流水不改', async (t) => {
  const f = setup(t)
  await f.mem.reviewShortTerm([OWNER])
  const before = f.read(), rows = structuredClone(f.rows)
  assert.match(f.mem.shortTermContextFor(OWNER), /短期对话记录 v2/)
  assert.match(f.mem.contextVia({ qq: OWNER }), /短期对话记录 v2/)
  assert.match(f.mem.recallHint(chat(OWNER), '无session的检查', '', '', undefined, undefined, false, false), /短期对话记录 v2/)
  assert.deepEqual(f.read().shortTermShown, before.shortTermShown)
  const state = f.read()
  state.shortTermShown = Array.from({ length: 400 }, (_, n) => ({ personId: OWNER, sessionId: `old-${n}`, revision: 'old', at: n }))
  writeMemoryState(f.dir, state)
  assert.match(f.mem.recallHint(chat(OWNER), '实际会话', '', 'current', undefined, undefined, false, false), /短期对话记录 v2/)
  assert.equal(f.read().shortTermShown.length, 400)
  assert.deepEqual(f.rows, rows)
  assert.match(f.calls[0].system, /不要因为旧话题重复次数多/)
})

test('相同human只变排序source行号或assistant感受，不因旧随机revision重新提醒', async (t) => {
  const f = setup(t)
  await f.mem.reviewShortTerm([OWNER])
  const stored = f.read()
  stored.shortTerm[OWNER].revision = 'legacy-random-v2'
  stored.shortTerm[OWNER].evidence.human.push({ ...stored.shortTerm[OWNER].evidence.human[0], at: stored.shortTerm[OWNER].from+1, quote: '目的地暂定在附近' })
  stored.shortTermShown = [{ personId: OWNER, sessionId: 'existing', revision: 'legacy-random-v2', at: Date.now() }]
  writeMemoryState(f.dir, stored)
  const beforePreview = f.read()
  assert.match(f.mem.shortTermContextFor(OWNER), /短期对话记录 v2/)
  assert.deepEqual(f.read(), beforePreview, '兼容投影的预览也不改旧账本')
  assert.doesNotMatch(f.mem.recallHint(chat(OWNER), '新问题', '', 'existing', undefined, undefined, false, false), /短期对话记录 v2/)
  const bridged = f.read(), stableRevision = bridged.shortTermShown[0].revision
  assert.match(stableRevision, /^human-/)
  bridged.shortTerm[OWNER].revision = 'another-random-value'
  bridged.shortTerm[OWNER].at += 1000
  bridged.shortTerm[OWNER].through += 1
  bridged.shortTerm[OWNER].evidence.human.reverse().forEach((entry, n) => { entry.source = 30-n; entry.name = '仅显示名变化' })
  bridged.shortTerm[OWNER].evidence.assistant = [{ role: 'assistant', at: Date.now(), quote: '新的助手回应' }]
  bridged.shortTerm[OWNER].evidence.feelings = [{ role: 'assistant', at: Date.now(), quote: '新的主观感受' }]
  writeMemoryState(f.dir, bridged)
  const reloaded = createMemoryStore({ dsh: f.dsh, getConfig: () => f.cfg, hub: f.hub, log })
  assert.doesNotMatch(reloaded.recallHint(chat(OWNER), '继续新问题', '', 'session-existing', undefined, undefined, false, false), /短期对话记录 v2/)
  assert.equal(f.read().shortTermShown[0].revision, stableRevision)
  const corrected = f.read()
  corrected.shortTerm[OWNER].evidence.human.push({ role: 'human', source: 99, speaker: OWNER, name: '爸爸', chatId: `private:${OWNER}`, at: Date.now(), via: 'qq', quote: '刚刚改了安排，现在先讨论别的事' })
  writeMemoryState(f.dir, corrected)
  assert.match(reloaded.recallHint(chat(OWNER), '新更正', '', 'existing', undefined, undefined, false, false), /短期对话记录 v2/)
})

test('自动重建只新增assistant行而human证据相同，复用展示revision并兼容未转换旧账本', async (t) => {
  const f = setup(t)
  await f.mem.reviewShortTerm([OWNER])
  const original = f.read(), record = original.shortTerm[OWNER]
  record.revision = 'old-before-first-recall'
  original.shortTermShown = [{ personId: OWNER, sessionId: 'same', revision: record.revision, at: Date.now() }]
  writeMemoryState(f.dir, original)
  f.rows.push({ chatId: `private:${OWNER}`, who: 'bot', t: Date.now()-4*60_000, text: '仅增加了一条助手回应', via: 'qq' })
  // 原始行排序仍以 t 为准，此处不新增人类原话。
  f.rows.sort((a,b) => a.t-b.t)
  f.cfg.memory.shortTermIdleMinutes = 0
  f.rows.push({ chatId: `private:${OWNER}`, who: 'bot', t: Date.now()-1, text: '另一条较新的助手回应', via: 'qq' })
  await f.mem.tick()
  const after = f.read()
  assert.match(after.shortTerm[OWNER].revision, /^human-/)
  assert.equal(after.shortTermShown[0].revision, after.shortTerm[OWNER].revision)
  assert.doesNotMatch(f.mem.recallHint(chat(OWNER), '此刻的新问题', '', 'same', undefined, undefined, false, false), /短期对话记录 v2/)
})

test('显式重建兼容旧随机版本账本，相同human不会因归档重建再提示', async (t) => {
  const f = setup(t)
  await f.mem.reviewShortTerm([OWNER])
  const saved = f.read()
  saved.shortTerm[OWNER].revision = 'legacy-before-manual-rebuild'
  saved.shortTermShown = [{ personId: OWNER, sessionId: 'manual', revision: saved.shortTerm[OWNER].revision, at: Date.now() }]
  writeMemoryState(f.dir, saved)
  await f.mem.reviewShortTerm([OWNER])
  const after = f.read()
  assert.equal(after.shortTermShown[0].revision, after.shortTerm[OWNER].revision)
  assert.doesNotMatch(f.mem.recallHint(chat(OWNER), '这次只聊新的话题', '', 'manual', undefined, undefined, false, false), /短期对话记录 v2/)
})
