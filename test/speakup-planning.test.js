import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 所有状态显式放临时目录，宿主/模型/发送均为桩；网络调用一律失败。
process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-proactive-import-'))
const { normalize } = await import('../src/core/config.js')
const { createSpeakUp } = await import('../src/features/companion.js')
const MINUTE = 60_000, DAD = '10001', MOM = '10002', GROUP = '777'
const originalFetch = globalThis.fetch
before(() => { globalThis.fetch = async () => { throw new Error('network disabled in proactive tests') } })
after(() => { globalThis.fetch = originalFetch })

function rig(t, { speakUp = {}, family = false, choose, hub: supplied = {}, config = {} } = {}) {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-proactive-test-'))
  const originalNow = Date.now
  let now = Date.UTC(2026, 10, 10, 3)
  Date.now = () => now
  t.after(() => { Date.now = originalNow })
  const cfg = normalize({ enabled: true, ownerQQ: DAD, ownerName: '爸爸', coOwners: [{ qq: MOM, name: '妈妈' }], familyGroups: family ? [GROUP] : [],
    speakUp: { enabled: true, awakeFrom: 0, awakeTo: 24, idleMinutes: 1, minIntervalMinutes: 1, maxIntervalMinutes: 1, maxPerDay: 2, nudge: false,
      family: { enabled: true, idleMinutes: 75, maxPerDay: 5 }, ...speakUp }, ...config })
  const plans = [], pushed = []
  let select = choose || ((options) => ({ target: options[0]?.chatId || '', next_check_minutes: 12 }))
  const hub = { lastOwnerChatAt: 0, lastBotToOwner: { at: 0, text: '' }, lastPrivateAt: () => 0, lastGroupAt: () => 0,
    canSendPrivate: () => true,
    runSystemTurn: async (name, title, prompt, opts) => {
      const options = JSON.parse(prompt.match(/候选：(.*)\n只输出/)[1])
      plans.push({ name, title, prompt, opts, options })
      const result = await select(options, prompt)
      return typeof result === 'string' ? result : JSON.stringify(result)
    },
    pushToSession: async (chat, content, sender, opts) => { pushed.push({ chat, text: content[0].text, sender, opts }) }, ...supplied }
  const make = () => createSpeakUp({ getConfig: () => cfg, hub, log: { info() {}, warn() {} } })
  const su = make()
  const event = (index, extra = {}) => {
    const p = pushed[index]
    return { kind: 'out', chatId: p.chat.chatId, proactiveId: p.opts.proactiveId, userText: p.text, sent: 1, ...extra }
  }
  return { cfg, hub, su, make, plans, pushed, event, advance: (minutes) => { now += minutes * MINUTE }, at: () => now, choose: (fn) => { select = fn } }
}

test('未到期只做本地检查；到期才调用无工具选择回合，一次只发一个目标', async (t) => {
  const r = rig(t, { speakUp: { minIntervalMinutes: 60, maxIntervalMinutes: 60 }, config: { allow: { groups: ['888'] } } })
  await r.su.tick()
  r.advance(10)
  await r.su.tick()
  assert.equal(r.plans.length, 0)
  r.advance(51)
  await r.su.tick()
  assert.equal(r.plans.length, 1)
  assert.equal(r.plans[0].opts.noTools, true)
  assert.equal(r.plans[0].opts.stateless, true)
  assert.equal(r.pushed.length, 1)
  assert.equal(r.pushed[0].opts.origin, 'speak-up')
  assert.ok(r.pushed[0].opts.proactiveId)
  assert.ok(r.plans[0].options.every((o) => o.chatId.startsWith('private:')))
  await r.su.tick()
  assert.equal(r.plans.length, 1, '一分钟定时器不等于每分钟调用模型')
})

test('AI 可先选妈妈；送达前不扣额度，直接工具回执和重复/沉默回执只计一次', async (t) => {
  const r = rig(t, { choose: () => ({ target: `private:${MOM}`, topic: '接着你们的话题', next_check_minutes: 10 }) })
  await r.su.tick(); r.advance(2); await r.su.tick()
  assert.equal(r.pushed[0].chat.chatId, `private:${MOM}`)
  assert.match(r.pushed[0].text, /妈妈[\s\S]*也是你的主人/)
  assert.equal(r.su.state().friends[MOM].count, 0)
  assert.equal(r.su.state().friends[MOM].attempts, 1)
  r.su.observe(r.event(0, { sent: 0 }))
  assert.equal(r.su.state().friends[MOM].count, 0)
  const out = r.event(0, { source: 'direct' })
  r.su.observe(out); r.su.observe(out)
  r.su.observe(r.event(0, { kind: 'proactive-result', outcome: 'silent' }))
  assert.equal(r.su.state().friends[MOM].count, 1)
  assert.equal(r.su.state().friends[MOM].lastOutcome, 'sent')
  assert.equal(r.su.state().friends[MOM].silences || 0, 0)
  assert.equal(r.su.state().count, 0, '爸爸和妈妈独立记成功次数')
})

test('失败和沉默分别退避，均不消耗私人发言额度，成功后才恢复配置间隔', async (t) => {
  const r = rig(t, { speakUp: { minIntervalMinutes: 60, maxIntervalMinutes: 60 }, choose: () => ({ target: `private:${MOM}`, next_check_minutes: 12 }), hub: { canSendPrivate: (qq) => qq === MOM } })
  await r.su.tick(); r.advance(61); await r.su.tick()
  r.su.observe(r.event(0, { kind: 'proactive-result', outcome: 'failed' }))
  let st = r.su.state().friends[MOM]
  assert.equal(st.count, 0)
  assert.equal(st.failures, 1)
  assert.equal(st.retryAt, r.at() + 5 * MINUTE)
  r.advance(4); await r.su.tick(); assert.equal(r.pushed.length, 1)
  r.advance(1); await r.su.tick(); assert.equal(r.pushed.length, 2)
  r.su.observe(r.event(1, { kind: 'proactive-result', outcome: 'silent' }))
  st = r.su.state().friends[MOM]
  assert.equal(st.count, 0)
  assert.equal(st.silences, 1)
  assert.equal(st.retryAt, r.at() + 12 * MINUTE)
  r.advance(11); await r.su.tick(); assert.equal(r.pushed.length, 2)
  r.advance(1); await r.su.tick(); assert.equal(r.pushed.length, 3)
  r.su.observe(r.event(2))
  st = r.su.state().friends[MOM]
  assert.equal(st.count, 1)
  assert.equal(st.nextAt, r.at() + 60 * MINUTE)
})

test('提交异常与重复失败事件不计成功，也不重复增加失败计数', async (t) => {
  const r = rig(t, { choose: () => ({ target: `private:${MOM}` }) })
  r.hub.pushToSession = async (chat, content, sender, opts) => {
    r.pushed.push({ chat, text: content[0].text, opts })
    r.su.observe({ kind: 'proactive-result', chatId: chat.chatId, proactiveId: opts.proactiveId, outcome: 'failed' })
    throw new Error('simulated submit failure')
  }
  await r.su.tick(); r.advance(2); await r.su.tick()
  assert.equal(r.su.state().friends[MOM].count, 0)
  assert.equal(r.su.state().friends[MOM].failures, 1)
})

test('家庭发送失败用独立故障退避，不被 AI 正常考虑窗口拖延', async (t) => {
  const r = rig(t, { family: true, speakUp: { maxPerDay: 0 }, choose: () => ({ target: `group:${GROUP}`, next_check_minutes: 60 }) })
  r.advance(2); await r.su.tick()
  r.su.observe(r.event(0, { kind: 'proactive-result', outcome: 'failed' }))
  const st = r.su.state().family[GROUP]
  assert.equal(st.count, 0)
  assert.equal(st.checkAt, r.at() + 5 * MINUTE)
  r.advance(5); await r.su.tick()
  assert.equal(r.pushed.length, 2)
  assert.equal(r.su.state().family[GROUP].count, 0)
})

test('选择失败或越界目标不自动找第一个人，退避后才重试', async (t) => {
  const r = rig(t, { choose: () => 'invalid json' })
  await r.su.tick(); r.advance(2); await r.su.tick()
  assert.equal(r.pushed.length, 0)
  assert.equal(r.su.state().planner.failures, 1)
  r.advance(4); await r.su.tick(); assert.equal(r.plans.length, 1)
  r.choose(() => ({ target: 'group:888' }))
  r.advance(1); await r.su.tick()
  assert.equal(r.pushed.length, 0)
  assert.equal(r.su.state().friends[MOM].attempts, 0)
  assert.equal(r.su.state().planner.failures, 2)
})

test('每个联系人独立节奏，没有主主人优先 return，未联系者下次排在前面', async (t) => {
  const r = rig(t, { speakUp: { maxPerDay: 1 } })
  await r.su.tick(); r.advance(2); await r.su.tick()
  assert.deepEqual(r.plans[0].options.map((o) => o.chatId), [`private:${DAD}`, `private:${MOM}`])
  r.su.observe(r.event(0))
  r.advance(5); await r.su.tick()
  assert.equal(r.pushed[1].chat.chatId, `private:${MOM}`)
  r.su.observe(r.event(1))
  r.advance(10); await r.su.tick()
  assert.equal(r.pushed.length, 2, '成功额度用完后停止')
})

test('家庭群从真实流水恢复，重启只保护两分钟，不重置成75分钟空闲', async (t) => {
  const rows = []
  const r = rig(t, { family: true, speakUp: { maxPerDay: 0 }, choose: () => ({ target: `group:${GROUP}`, next_check_minutes: 5 }),
    hub: { chatLogDays: () => ['2026-11-10'], chatLogOf: () => rows } })
  rows.push({ t: r.at() - 60 * MINUTE, chatId: `group:${GROUP}`, who: 'bot', text: 'existing group talk' })
  await r.su.tick(); r.advance(1); await r.su.tick()
  assert.equal(r.plans.length, 0)
  r.advance(1); await r.su.tick()
  assert.equal(r.plans[0].options[0].idleMinutes, 62)
  r.su.observe(r.event(0))
  r.advance(10)
  const restarted = r.make()
  await restarted.tick(); assert.equal(r.plans.length, 1)
  r.advance(2); await restarted.tick()
  assert.equal(r.plans.length, 2)
  assert.equal(r.plans[1].options[0].idleMinutes, 12)
})

test('家庭刚在正常聊天时不另发主动轮；观察到的真实活动随状态保存', async (t) => {
  const r = rig(t, { family: true, speakUp: { maxPerDay: 0 } })
  r.su.observe({ kind: 'in', chatId: `group:${GROUP}`, text: 'a real message', at: r.at() })
  r.advance(3); await r.su.tick()
  assert.equal(r.plans.length, 0)
  const restarted = r.make()
  r.advance(2); await restarted.tick()
  assert.equal(r.plans.length, 1)
  assert.equal(r.plans[0].options[0].idleMinutes, 5)
})

test('AI 沉默和 next_check_minutes 控制下一次考虑，最大窗75和最少5分钟生效', async (t) => {
  const r = rig(t, { family: true, speakUp: { maxPerDay: 0 }, choose: () => ({ target: '', next_check_minutes: 7 }) })
  r.advance(2); await r.su.tick()
  assert.equal(r.pushed.length, 0)
  r.advance(6); await r.su.tick(); assert.equal(r.plans.length, 1)
  r.choose(() => ({ target: '', next_check_minutes: 9999 }))
  r.advance(1); await r.su.tick()
  assert.equal(r.su.state().planner.nextAt, r.at() + 75 * MINUTE)
  r.advance(75); r.choose(() => ({ target: '', next_check_minutes: 0 })); await r.su.tick()
  assert.equal(r.su.state().planner.nextAt, r.at() + 5 * MINUTE)
  assert.equal(r.su.state().family[GROUP].count, 0)
})

test('妈妈私聊失败后，AI 可独立选家庭群关心；不转发私聊或算作妈妈已收到', async (t) => {
  let blocked = false
  const r = rig(t, { family: true, choose: () => ({ target: `private:${MOM}`, topic: 'PRIVATE_ONLY_DIRECTION', next_check_minutes: 5 }),
    hub: { canSendPrivate: (qq) => qq !== MOM || !blocked } })
  await r.su.tick(); r.advance(2); await r.su.tick()
  r.su.observe(r.event(0, { kind: 'proactive-result', outcome: 'failed' }))
  blocked = true
  r.choose((options) => {
    assert.ok(!options.some((o) => o.chatId === `private:${MOM}`))
    assert.deepEqual(options.find((o) => o.role === 'family').unreachableFamily, [{ qq: MOM, name: '妈妈' }])
    return { target: `group:${GROUP}`, topic: '在家庭群自然关心', next_check_minutes: 5 }
  })
  r.advance(5); await r.su.tick()
  assert.equal(r.pushed[1].chat.chatId, `group:${GROUP}`)
  assert.match(r.pushed[1].text, /独立决定[\s\S]*不能.*未送达私聊/)
  assert.doesNotMatch(r.pushed[1].text, /PRIVATE_ONLY_DIRECTION/)
  assert.equal(r.su.state().friends[MOM].count, 0)
  assert.equal(r.su.state().family[GROUP].count, 0)
  r.su.observe(r.event(1))
  assert.equal(r.su.state().family[GROUP].count, 1)
  assert.equal(r.su.state().friends[MOM].lastOutcome, 'failed')
})

test('AI 选择期间有人在家庭群说话，重新检查资格并保留新活动，不按旧计划发', async (t) => {
  const r = rig(t, { family: true, speakUp: { maxPerDay: 0 } })
  r.choose(() => {
    r.su.observe({ kind: 'in', chatId: `group:${GROUP}`, at: r.at(), text: 'new talk while planner runs' })
    return { target: `group:${GROUP}`, next_check_minutes: 9 }
  })
  r.advance(2); await r.su.tick()
  assert.equal(r.pushed.length, 0)
  assert.equal(r.su.state().family[GROUP].activityAt, r.at())
})

test('等待回执超时不算成功；迟到成功仍只计一次，后续失败不反向覆盖', async (t) => {
  const r = rig(t, { choose: () => ({ target: `private:${MOM}`, next_check_minutes: 10 }) })
  await r.su.tick(); r.advance(2); await r.su.tick()
  r.advance(11)
  r.choose(() => ({ target: '', next_check_minutes: 10 }))
  await r.su.tick()
  assert.equal(r.su.state().friends[MOM].count, 0)
  assert.equal(r.su.state().friends[MOM].lastOutcome, 'timeout')
  r.su.observe(r.event(0)); r.su.observe(r.event(0))
  r.su.observe(r.event(0, { kind: 'proactive-result', outcome: 'failed' }))
  assert.equal(r.su.state().friends[MOM].count, 1)
  assert.equal(r.su.state().friends[MOM].lastOutcome, 'sent')
})

test('是否追问由 AI 判断，不用问号或随机概率代替判断；追问仍不占每日额度', async (t) => {
  const r = rig(t, { speakUp: { nudge: true, idleMinutes: 600 }, choose: () => ({ target: `private:${DAD}`, next_check_minutes: 5 }) })
  r.hub.lastOwnerChatAt = r.at() - 25 * MINUTE
  r.hub.lastBotToOwner = { at: r.at() - 20 * MINUTE, text: '好哦' }
  await r.su.tick()
  assert.equal(r.pushed.length, 1)
  assert.equal(r.plans[0].options[0].mode, 'nudge')
  r.su.observe(r.event(0))
  assert.equal(r.su.state().count, 0)
  r.advance(5); await r.su.tick()
  assert.equal(r.pushed.length, 1)
})

test('真实 hub 接通选择回合、QQ 回执与沉默事件，JSON 计划不会被发给联系人', async (t) => {
  const r = rig(t)
  r.cfg.workspaceDir = join(process.env.AURABOT_DATA_DIR, 'workspace')
  r.cfg.dryRun = false
  r.cfg.voice.enabled = false
  r.cfg.stickers.enabled = false
  r.cfg.stickers.faces = false
  const { createHub } = await import('../src/chat/hub.js')
  const { createFakeDsh } = await import('./helpers/fake-dsh.js')
  let reply = '妈妈，今天怎么样呀', speak
  const events = [], sent = [], selections = []
  const fake = createFakeDsh({ brain: async () => reply })
  fake.ctx.systemPrompt.variable('aurabot_persona', () => 'PERSONA_SENTINEL_LONG_CONTEXT')
  fake.ctx.llm.stream = async function* (params) {
    selections.push(params)
    yield { type: 'text-delta', text: JSON.stringify({ target: `private:${MOM}`, next_check_minutes: 5 }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const hub = createHub({ dsh: fake.ctx, getConfig: () => r.cfg,
    log: { info() {}, warn() {}, debug() {}, error() {} },
    onebot: { connected: true, call: async (action, params) => { sent.push({ action, params }); return { message_id: sent.length } } },
    onActivity: (event) => { events.push(event); speak?.observe(event) } })
  fake.ctx.on('session/event', (session, event) => hub.onSessionEvent(session, event))
  speak = createSpeakUp({ getConfig: () => r.cfg, hub, log: { info() {}, warn() {} } })
  t.after(() => { hub.dispose(); fake.dispose() })
  const settle = async () => { for (let n = 0; n < 40; n++) await new Promise(setImmediate) }
  await speak.tick(); r.advance(2); await speak.tick(); await settle()
  const outgoing = sent.filter((x) => x.action === 'send_private_msg')
  assert.equal(outgoing.length, 1)
  assert.equal(String(outgoing[0].params.user_id), MOM)
  assert.equal(speak.state().friends[MOM].count, 1)
  assert.ok(events.some((e) => e.kind === 'out' && e.proactiveId && e.source === 'interaction'))
  assert.doesNotMatch(JSON.stringify(outgoing[0].params.message), /next_check_minutes|候选：/)
  assert.equal(selections.length, 1)
  assert.equal(selections[0].messages.length, 1)
  assert.equal(selections[0].tools, undefined)
  assert.doesNotMatch(selections[0].system, /PERSONA_SENTINEL_LONG_CONTEXT/)
  assert.ok(Object.keys(hub.sessions()).every((id) => !id.startsWith('system:')), '选择计划不创建或复用长历史后台会话')
  reply = '[沉默]'
  r.advance(5); await speak.tick(); await settle()
  assert.equal(speak.state().friends[MOM].count, 1)
  assert.equal(speak.state().friends[MOM].silences, 1)
  assert.equal(sent.filter((x) => x.action === 'send_private_msg').length, 1)
  assert.equal(selections.length, 2)
  assert.equal(selections[1].messages.length, 1, '下一次选择仍只有本次输入')
})
