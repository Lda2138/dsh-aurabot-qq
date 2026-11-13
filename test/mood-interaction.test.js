import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTick } from 'node:timers/promises'
import { createMood } from '../src/features/companion.js'
import { normalize } from '../src/core/config.js'
import moodModule from '../src/modules/mood/index.js'

const OWNER = '11111111', FAMILY = '22222222', OTHER = '33333333'
const answer = (delta = 0, confidence = 0.9, reason = '依据本轮互动') => ({ delta, confidence, reason, ...(delta <= -2 ? { evidence: [{ source: 0 }] } : {}) })
function interaction(overrides = {}) {
  return {
    kind: 'out', source: 'interaction', turnId: 'turn-1', origin: 'user',
    chatId: `group:${FAMILY}`, userText: '666', reply: '这个剪辑我也觉得厉害',
    input: {
      text: `爸爸(${OWNER})回复你：666`, context: '刚才一起看了一个很精彩的剪辑',
      speakers: [{ id: OWNER, name: '爸爸', role: 'owner', direct: true }],
      quotes: [{ speaker: '爸爸', text: '这个剪辑真厉害' }],
      family: true, relationship: '爸爸与女儿', realUserInput: true,
      humanMessages: [{ id: `human:${overrides.turnId || 'turn-1'}`, speakerId: OWNER, name: '爸爸', text: '666', at: Date.now() }],
    }, ...overrides,
  }
}
function fixture(t, { respond = () => answer(), cfg: config = {} } = {}) {
  const previous = process.env.AURABOT_DATA_DIR
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-mood-interaction-'))
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => { if (previous === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = previous })
  const cfg = normalize({ ownerQQ: OWNER, ownerName: '爸爸', familyGroups: [FAMILY], mood: { judge: true }, model: { provider: 'mood-test', model: 'fake' }, ...config })
  const calls = [], logs = []
  const log = { debug: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')) }
  const dsh = { get: () => null, llm: { async *stream(request) {
    const index = calls.push(request) - 1
    const result = await respond(request, index)
    yield { type: 'text-delta', text: typeof result === 'string' ? result : JSON.stringify(result) }
    yield { type: 'finish', reason: { kind: 'completed' } }
  } } }
  const create = () => createMood({ getConfig: () => cfg, dsh, log })
  return { dir, cfg, calls, logs, log, dsh, create, mood: create(), read: () => JSON.parse(readFileSync(join(dir, 'mood.json'), 'utf8')) }
}
const payload = (request) => JSON.parse(request.messages[0].content[0].text)

test('送达、系统事件和没有真实输入的输出都不会触发人际心情判断', async (t) => {
  const f = fixture(t, { respond: () => answer(-12) })
  for (const event of [
    interaction({ source: 'direct' }),
    interaction({ source: 'system' }),
    interaction({ source: undefined }),
    interaction({ chatId: 'system:notice' }),
    interaction({ turnId: undefined }),
    interaction({ input: { text: '', realUserInput: true } }),
    interaction({ input: { text: '未说明来源的后台提示' } }),
    interaction({ input: { text: '【系统提醒】分享截图', realUserInput: false } }),
  ]) assert.equal(await f.mood.judge(event), null)
  assert.equal(f.calls.length, 0)
  assert.equal(f.mood.current(), 60)
})

test('模型看到带人名、对象、引用和前文的完整输入，并自行理解短回复', async (t) => {
  const f = fixture(t)
  const e = interaction({ userText: '故意不带人名的检索文本', reply: '我刚才有点烦，但这句是夸剪辑' })
  await f.mood.judge(e)
  const p = payload(f.calls[0])
  assert.equal(p.interaction, e.input.text)
  assert.deepEqual(p.speakers, e.input.speakers)
  assert.deepEqual(p.quotes, e.input.quotes)
  assert.equal(p.context, e.input.context)
  assert.equal(p.relationship, '爸爸与女儿')
  assert.equal(p.family, true)
  assert.equal(p.herReplyForContextOnly, e.reply)
  assert.deepEqual(p.humanSources.map((s) => ({ source: s.source, text: s.text, speakerId: s.speakerId })), [{ source: 0, text: '666', speakerId: OWNER }])
  assert.match(f.calls[0].system, /不能因为她已经讽刺、拒绝或生气就反推对方有恶意/)
  assert.equal(f.mood.current(), 60, '短回复交给模型理解，代码没有强行扣分')
  assert.equal(f.read().judgments[0].status, 'unchanged')
})

test('负面归因缺少当前真人来源或引用助手/背景时保留诊断，不扣分也不重复问模型', async (t) => {
  const responses = [
    { delta: -8, confidence: 0.95, reason: '她拒绝了所以对方冒犯', evidence: [{ source: 0 }] },
    { delta: -8, confidence: 0.95, reason: '她拒绝了所以对方冒犯' },
    { delta: -8, confidence: 0.95, reason: '被拒后的不适', evidence: [{ source: 'herReplyForContextOnly' }] },
    { delta: -8, confidence: 0.95, reason: '被拒后的不适', evidence: [{ source: 9 }] },
    { delta: -8, confidence: 0.95, reason: '被拒后的不适', evidence: [{ source: 0, quote: '不行，我拒绝' }] },
    { delta: -8, confidence: 0.95, reason: '前文仍让我难过', evidence: [{ source: 0, quote: '旧背景说过的话' }] },
  ]
  const f = fixture(t, { respond: (_, index) => responses[index] })
  const first = interaction({ turnId: 'missing-human', input: { text: '普通请求', realUserInput: true } })
  await f.mood.judge(first)
  for (let i = 1; i < responses.length; i++) await f.mood.judge(interaction({ turnId: `bad-source-${i}`, reply: '不行，我拒绝', input: {
    text: '普通请求', context: '旧背景说过的话', quotes: [{ speaker: '她', text: '不行，我拒绝' }], realUserInput: true,
    humanMessages: [{ id: `real-${i}`, speakerId: OWNER, name: '爸爸', text: '普通请求' }],
  } }))
  assert.equal(f.mood.current(), 60)
  assert.equal(f.calls.length, responses.length)
  assert.equal(await f.mood.judge(first), null)
  assert.equal(f.calls.length, responses.length, '无效证据也完成一次诊断，不反复补问模型')
  assert.deepEqual(f.read().judgments.map((j) => j.evidenceValidation.reason).reverse(), ['missing_human_sources', 'missing_evidence', 'invalid_evidence_source', 'invalid_evidence_source', 'quote_mismatch', 'quote_mismatch'])
  assert.ok(f.read().judgments.every((j) => j.status === 'evidence_rejected'))
  assert.equal(f.read().history.length, 0)
  assert.match(f.calls[1].system, /旧拒绝和同一件旧事实不能重复扣分/)
  assert.match(f.calls[1].system, /reason.*自己感受与新依据/)
})

test('负面变化引用本轮真人原话才可应用，引用原文由代码还原并存入主观cause', async (t) => {
  const f = fixture(t, { respond: () => ({ delta: -6, confidence: 0.9, reason: '新追问让我有点疲惫', evidence: [{ source: '0', quote: '再说一次' }] }) })
  const e = interaction({ input: { text: '爸爸：再说一次', realUserInput: true,
    humanMessages: [{ id: 'new-ask', speakerId: OWNER, name: '爸爸', text: '再说一次', at: Date.now() }] } })
  await f.mood.judge(e)
  assert.equal(f.mood.current(), 54, '保留AI对确有新输入的合理负面感受')
  const state = f.read(), judged = state.judgments[0]
  assert.equal(judged.evidenceValidation.status, 'verified')
  assert.equal(judged.evidence[0].text, '再说一次')
  assert.equal(judged.evidence[0].speakerId, OWNER)
  assert.equal(state.cause.evidenceStatus, 'verified')
  assert.equal(state.cause.at, state.at)
  assert.equal(state.cause.delta, -6)
})

test('相同真人message来源不能跨轮重复扣分，新message重复追问仍交AI判断', async (t) => {
  const f = fixture(t, { respond: () => answer(-8, 0.9, '新的追问让我疲惫') })
  const input = { text: '再问一句', realUserInput: true, humanMessages: [{ id: 'same-message', speakerId: OWNER, text: '再问一句' }] }
  await f.mood.judge(interaction({ turnId: 'first-evidence', input }))
  await f.mood.judge(interaction({ turnId: 'same-evidence', input }))
  assert.equal(f.mood.current(), 52)
  assert.equal(f.read().judgments[0].evidenceValidation.reason, 'reused_human_evidence')
  await f.mood.judge(interaction({ turnId: 'new-evidence', input: { ...input, humanMessages: [{ ...input.humanMessages[0], id: 'new-message' }] } }))
  assert.equal(f.mood.current(), 44)
  assert.equal(f.read().history.length, 2)
})

test('仅助手主动输出和旧quoted资料不能充当负分的人类来源', async (t) => {
  const f = fixture(t, { respond: () => answer(-10) })
  await f.mood.judge(interaction({ origin: 'speak-up', input: { text: '【系统提醒】主动发一句', realUserInput: false, humanMessages: [{ id: 'not-human', speakerId: OWNER, text: '复制的旧句子' }] } }))
  assert.equal(payload(f.calls[0]).humanSources.length, 0)
  assert.equal(f.read().judgments[0].evidenceValidation.reason, 'missing_human_sources')
  assert.equal(f.mood.current(), 60)
})

test('旧无证据原因不重新注入，保留原值和时间自然恢复', (t) => {
  const f = fixture(t)
  const originalNow = Date.now, at = originalNow()
  const old = { value: 17, at, reason: '对方被拒绝仍提某话题，边界被冒犯', cause: { chatId: `group:${FAMILY}`, source: 'interaction', turnId: 'legacy' }, history: [] }
  writeFileSync(join(f.dir, 'mood.json'), JSON.stringify(old))
  const line = f.mood.contextLine({ chatId: `group:${FAMILY}`, family: true })
  assert.match(line, /不太开心[\s\S]*依据未核实/)
  assert.doesNotMatch(line, /边界被冒犯|因为|某话题/)
  assert.match(line, /不说明对方有错/)
  assert.deepEqual(f.read(), old, '渲染上下文不迁移、不清零、不改生产式旧数据')
  Date.now = () => at + 3 * 3600_000
  t.after(() => { Date.now = originalNow })
  assert.equal(f.mood.current(), 39)
})

test('稳定模式（默认）：上下文里只留心情档位，不带每次都变的原因和时间', async (t) => {
  const f = fixture(t, { respond: () => answer(-15, 0.9, '这句新话让我有点难过') })
  await f.mood.judge(interaction({ turnId: 'stable-1' }))
  await f.mood.judge(interaction({ turnId: 'stable-2' }))
  const line = f.mood.contextLine({ chatId: `group:${FAMILY}`, family: true })
  assert.match(line, /你现在不太开心/)
  assert.doesNotMatch(line, /这句新话让我有点难过|的记录中曾主观感到/)
  assert.match(line, /不说明对方有错/)
  const before = line
  await f.mood.judge(interaction({ turnId: 'stable-3' }))
  assert.equal(f.mood.contextLine({ chatId: `group:${FAMILY}`, family: true }).replace(/你现在[^。]+。/, ''), before.replace(/你现在[^。]+。/, ''), '心情原因变了，上下文这一行除档位外不变')
})

test('已验证原因也以带时间的过去主观感受呈现，不变成对方事实或内容禁令', async (t) => {
  const f = fixture(t, { respond: () => answer(-15, 0.9, '这句新话让我有点难过'), cfg: { chat: { stableContext: false } } })
  await f.mood.judge(interaction({ turnId: 'feel-1' }))
  await f.mood.judge(interaction({ turnId: 'feel-2' }))
  const line = f.mood.contextLine({ chatId: `group:${FAMILY}`, family: true })
  assert.match(line, /你在 .+ 的记录中曾主观感到「这句新话让我有点难过」/)
  assert.match(line, /不说明对方有错/)
  assert.doesNotMatch(line, /因为/)
  assert.doesNotMatch(f.mood.contextLine({ chatId: `private:${OWNER}`, family: true }), /这句新话让我有点难过/)
})

test('旧负面变化即使数值仍高于基线，也不把无证据原因重新注入', (t) => {
  const f = fixture(t), at = Date.now()
  writeFileSync(join(f.dir, 'mood.json'), JSON.stringify({ value: 75, at, reason: '已拒绝所以对方冒犯', cause: { chatId: `group:${FAMILY}`, source: 'interaction' }, history: [{ at, from: 85, to: 75 }] }))
  const line = f.mood.contextLine({ chatId: `group:${FAMILY}`, family: true })
  assert.match(line, /心情不错[\s\S]*依据未核实/)
  assert.doesNotMatch(line, /已拒绝所以对方冒犯/)
  assert.equal(f.mood.current(), 75)
})

test('显式主动搭话保持独立 origin，未获回复不被自动当成冷落', async (t) => {
  const f = fixture(t, { respond: () => answer(3, 0.9, '主动分享真实见闻感到轻松') })
  await f.mood.judge(interaction({ origin: 'speak-up', userText: '', input: { text: '', realUserInput: false }, reply: '刚看到一只猫趴在雨窗边' }))
  assert.equal(f.calls.length, 1)
  assert.equal(payload(f.calls[0]).origin, 'speak-up')
  assert.match(f.calls[0].system, /尚未有回应并不代表被冷落/)
  assert.equal(f.mood.current(), 63)
  assert.equal(f.read().history[0].origin, 'speak-up')
})

test('同一轮在判断中、判断结束和重新创建模块后都至多评估一次', async (t) => {
  let release
  const block = new Promise((resolve) => { release = resolve })
  const f = fixture(t, { respond: async () => { await block; return answer(7) } })
  const e = interaction(), first = f.mood.judge(e)
  assert.equal(await f.mood.judge({ ...e, reply: '重复投递最终回复' }), null)
  await nextTick()
  assert.equal(f.calls.length, 1)
  assert.equal(await f.create().judge(e), null, '持久化认领也覆盖尚未完成的判断')
  release()
  await first
  assert.equal(await f.mood.judge(e), null)
  assert.equal(await f.create().judge(e), null)
  assert.equal(f.calls.length, 1)
  const s = f.read()
  assert.equal(s.history.length, 1)
  assert.equal(s.history[0].turnId, e.turnId)
  assert.equal(s.history[0].chatId, e.chatId)
  assert.equal(s.history[0].source, 'interaction')
})

test('不同轮判断串行应用，后一轮使用已更新状态，零变化也有诊断', async (t) => {
  let release
  const block = new Promise((resolve) => { release = resolve })
  const f = fixture(t, { respond: async (_, index) => {
    if (index === 0) { await block; return answer(-10) }
    return answer(5)
  } })
  const first = f.mood.judge(interaction({ turnId: 'first' }))
  const second = f.mood.judge(interaction({ turnId: 'second', chatId: `group:${OTHER}` }))
  await nextTick()
  assert.equal(f.calls.length, 1, '前轮未返回时不并发猜测同一全局状态')
  release()
  await Promise.all([first, second])
  assert.match(f.calls[1].system, /现在心情 50\/100/)
  assert.equal(f.mood.current(), 55)
  assert.deepEqual(f.read().history.map((x) => x.turnId), ['second', 'first'])
  assert.equal(f.read().judgments.length, 2)
})

test('模型无把握、无效输出及失败不会写情绪，下一轮仍能继续', async (t) => {
  const results = [answer(-12, 0.2), '无法确定', new Error('假的离线失败'), answer(4)]
  const f = fixture(t, { respond: (_, index) => {
    if (results[index] instanceof Error) throw results[index]
    return results[index]
  } })
  for (let i = 0; i < results.length; i++) await f.mood.judge(interaction({ turnId: `result-${i}` }))
  assert.equal(f.mood.current(), 64)
  assert.deepEqual(f.read().judgments.map((x) => x.status), ['applied', 'error', 'invalid', 'unchanged'])
  assert.equal(f.read().history.length, 1)
  assert.match(f.logs.join('\n'), /假的离线失败/)
})

test('超时判断让后续轮次继续，迟到的模型结果不能反写心情', async (t) => {
  let release
  const block = new Promise((resolve) => { release = resolve })
  const f = fixture(t, { respond: async (_, index) => {
    if (index === 0) { await block; return answer(-15) }
    return answer(5)
  } })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const first = f.mood.judge(interaction({ turnId: 'timeout' }))
  const second = f.mood.judge(interaction({ turnId: 'next' }))
  await nextTick()
  t.mock.timers.tick(45_001)
  await Promise.all([first, second])
  assert.equal(f.mood.current(), 65)
  assert.equal(f.read().judgments.find((x) => x.turnId === 'timeout').status, 'error')
  release()
  await nextTick()
  assert.equal(f.mood.current(), 65)
  assert.deepEqual(f.read().history.map((x) => x.turnId), ['next'])
})

test('谷底没有实际变化时，判断诊断保留但自然恢复起点不重置', async (t) => {
  const f = fixture(t, { respond: () => answer(-8) })
  const originalNow = Date.now, at = originalNow() - 1000
  const original = { value: 5, at, reason: '旧经历', history: [{ at, from: 13, to: 5, reason: '旧经历' }] }
  writeFileSync(join(f.dir, 'mood.json'), JSON.stringify(original))
  Date.now = () => at + 1000
  t.after(() => { Date.now = originalNow })
  await f.mood.judge(interaction())
  const s = f.read()
  assert.equal(s.at, at)
  assert.equal(s.reason, '旧经历')
  assert.deepEqual(s.history, original.history)
  assert.equal(s.judgments[0].status, 'unchanged')
  Date.now = () => at + 3 * 3600_000
  assert.equal(f.mood.current(), 33, '仍从原始起点按三小时半衰期恢复')
})

test('全局低落保留自然连续，家庭上下文校准关系并隐藏外群原因', (t) => {
  const f = fixture(t)
  f.mood.nudge(-40, '外群有人骂了她', { chatId: `group:${OTHER}`, source: 'interaction', turnId: 'elsewhere', origin: 'user' })
  const before = f.mood.current()
  const familyLine = f.mood.contextLine({ chatId: `group:${FAMILY}`, family: true, relationship: '爸妈和女儿' })
  assert.match(familyLine, /不太开心/)
  assert.match(familyLine, /温和表达边界/)
  assert.match(familyLine, /心情不好也不冲他们发火/)
  assert.match(familyLine, /先前别处的经历/)
  assert.doesNotMatch(familyLine, /外群有人骂了她|可能会怼一句/)
  assert.doesNotMatch(f.mood.contextLine({ chatId: `group:${OTHER}` }), /外群有人骂了她/)
  assert.match(f.mood.contextLine({ chatId: `group:${OTHER}` }), /依据未核实/)
  assert.equal(f.mood.current(), before, '换聊天只校准表达，不改全局心情数值')
})

test('开启模型判断后，普通、静默及峰时输入都不再由关键词替它定情绪', async (t) => {
  const f = fixture(t, { cfg: { cost: { offPeak: true } } })
  f.mood.observe('滚 烦死了', '群友', { direct: true })
  f.mood.observe('滚 烦死了', '群友', { silent: true })
  const originalDate = globalThis.Date
  const peak = originalDate.UTC(2026, 10, 10, 2)
  class PeakDate extends originalDate { constructor(...args) { super(...(args.length ? args : [peak])) } static now() { return peak } }
  globalThis.Date = PeakDate
  try {
    f.mood.observe('滚 烦死了', '群友', { direct: true })
    assert.equal(await f.mood.judge(interaction()), null)
    assert.equal(f.mood.current(), 60)
    assert.equal(f.calls.length, 0)
  } finally { globalThis.Date = originalDate }
})

test('模块接线仅接受完整互动，并把家庭聊天身份用于上下文', async (t) => {
  const f = fixture(t)
  let activity, context
  const mood = moodModule.setup({ config: () => f.cfg, dsh: f.dsh, log: f.log, on: (name, handler) => { if (name === 'activity') activity = handler }, context: (handler) => { context = handler } })
  await activity(interaction({ source: 'direct' }))
  await activity(interaction({ source: 'system' }))
  await activity(interaction({ source: undefined }))
  assert.equal(f.calls.length, 0)
  await activity(interaction())
  assert.equal(f.calls.length, 1)
  mood.nudge(-40, '外群的事', { chatId: `group:${OTHER}`, source: 'interaction' })
  assert.match(context({ chat: { kind: 'group', groupId: FAMILY } }), /亲近的家人/)
  assert.doesNotMatch(context({ chat: { kind: 'private', userId: OTHER } }), /亲近的家人/)
  assert.equal(context({ chat: { kind: 'system' } }), '')
})
