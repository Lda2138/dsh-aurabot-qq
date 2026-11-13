import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-family-care-import-'))
const { normalize } = await import('../src/core/config.js')
const { createSpeakUp } = await import('../src/features/companion.js')
const { refreshFamilyActivity, observeFamilyActivity, familyActivityFacts } = await import('../src/features/family-activity.js')
const MINUTE = 60_000, DAD = '10001', MOM = '10002', GROUP = '777'
const originalFetch = globalThis.fetch
before(() => { globalThis.fetch = async () => { throw new Error('network disabled in family-care tests') } })
after(() => { globalThis.fetch = originalFetch })

function rig(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-family-care-test-'))
  process.env.AURABOT_DATA_DIR = dir
  const originalNow = Date.now
  let now = Date.parse('2026-11-11T01:00:00Z')
  Date.now = () => now
  t.after(() => { Date.now = originalNow })
  const cfg = normalize({ enabled: true, ownerQQ: DAD, ownerName: '老登', ownerRole: '爸爸', coOwners: [{ qq: MOM, name: '', role: '妈妈' }], familyGroups: [GROUP],
    speakUp: { enabled: true, awakeFrom: 0, awakeTo: 24, idleMinutes: 1, minIntervalMinutes: 1, maxIntervalMinutes: 1, maxPerDay: 3, nudge: false,
      family: { enabled: true, idleMinutes: 75, maxPerDay: 5 } } })
  const rows = [], plans = [], pushed = [], warnings = []
  let choose = () => JSON.stringify({ target: `group:${GROUP}`, next_check_minutes: 5 })
  const hub = { chatLogDays: () => ['2026-11-10', '2026-11-11'], chatLogOf: (day) => day === '2026-11-11' ? rows : [],
    lastPrivateAt: () => now, lastGroupAt: () => 0, canSendPrivate: (qq) => qq !== MOM,
    runSystemTurn: async (_name, _title, prompt, opts) => { plans.push({ prompt, opts, options: JSON.parse(prompt.match(/候选：(.*)\n只输出/)[1]) }); return choose() },
    pushToSession: async (chat, content, _who, opts) => pushed.push({ chat, text: content[0].text, opts }) }
  const make = () => createSpeakUp({ getConfig: () => cfg, hub, log: { info() {}, warn: (text) => warnings.push(text) } })
  const su = make()
  return { cfg, hub, rows, plans, pushed, warnings, su, make, dir, now: () => now, advance: (minutes) => { now += minutes * MINUTE }, choose: (fn) => { choose = fn },
    row: (uid, minutes, extra = {}) => ({ uid, t: now - minutes * MINUTE, chatId: `group:${GROUP}`, who: uid === MOM ? '妈妈' : '爸爸', text: 'hello', ...extra }),
    facts: (options) => options.find((o) => o.role === 'family')?.familyActivity,
    event: (index, extra = {}) => ({ chatId: pushed[index].chat.chatId, proactiveId: pushed[index].opts.proactiveId, kind: 'out', sent: 1, ...extra }) }
}

test('称呼留空仍保留妈妈身份，可达性与未知发言均如实提供', (t) => {
  const r = rig(t)
  const facts = r.facts(r.su.preview(r.now() + 2 * MINUTE))
  const mom = facts.members.find((p) => p.qq === MOM)
  assert.equal(mom.identity, '妈妈')
  assert.equal(mom.privateReachable, false)
  assert.equal(mom.lastHumanAt, null)
  assert.equal(mom.quietMinutes, null)
  assert.equal(facts.members.find((p) => p.qq === DAD).privateReachable, null, '允许尝试不等于已核实好友关系')
  assert.equal(r.cfg.coOwners[0].name, '')
  const family = r.su.preview(r.now() + 2 * MINUTE).find((o) => o.role === 'family')
  assert.deepEqual(family.unreachableFamily, [{ qq: MOM, name: '妈妈' }])
  assert.equal(existsSync(join(r.dir, 'speakup.json')), false)
})

test('真实 OneBot 客户端的 state 接口触发好友检查，未知可达性不被报成已核实', async (t) => {
  const r = rig(t)
  const { createHub } = await import('../src/chat/hub.js')
  const { createFakeDsh } = await import('./helpers/fake-dsh.js')
  const fake = createFakeDsh({ brain: async () => '' }), calls = []
  const onebot = { state: 'disconnected', call: async (action) => { calls.push(action); return action === 'get_friend_list' ? [{ user_id: DAD }] : {} } }
  const hub = createHub({ dsh: fake.ctx, getConfig: () => r.cfg, log: { info() {}, warn() {}, debug() {} }, onebot })
  t.after(() => { hub.dispose(); fake.dispose() })
  assert.equal(hub.privateReachability(MOM), null)
  await hub.refreshPrivateReachability()
  assert.equal(calls.length, 0)
  onebot.state = 'connected'
  assert.equal(onebot.connected, undefined, '与真实客户端相同，不伪造 connected 属性')
  await hub.refreshPrivateReachability()
  assert.deepEqual(calls, ['get_friend_list'])
  assert.equal(hub.canSendPrivate(MOM), false)
  assert.equal(hub.privateReachability(MOM), false)
  assert.equal(hub.privateReachability(DAD), true)
  await hub.onNotice({ notice_type: 'friend_add', user_id: MOM })
  assert.equal(hub.privateReachability(MOM), true)
})

test('仅真人本人的可见原始发言刷新时间，机器人/系统/遗忘/未来/外群均排除', (t) => {
  const r = rig(t)
  r.rows.push(r.row(MOM, 180), r.row(DAD, 60), r.row(MOM, 20, { who: 'bot' }), r.row(MOM, 15, { who: '系统' }),
    r.row(MOM, 12, { forgottenAt: r.now() }), r.row(MOM, -5), r.row(MOM, 10, { chatId: 'group:999' }),
    r.row(MOM, 8, { kind: 'seen' }), r.row(MOM, 7, { via: 'other-platform' }), r.row(MOM, 6, { chatId: `private:${DAD}` }))
  const facts = r.facts(r.su.preview(r.now() + 2 * MINUTE))
  assert.equal(facts.members.find((p) => p.qq === MOM).quietMinutes, 182)
  assert.equal(facts.members.find((p) => p.qq === DAD).quietMinutes, 62)
})

test('观察活动按QQ与窗口持久化，机器人发送与爸爸说话不重置妈妈；重启能恢复', (t) => {
  const r = rig(t)
  r.su.observe({ kind: 'in', chatId: `group:${GROUP}`, userId: MOM, at: r.now() })
  r.advance(12)
  r.su.observe({ kind: 'out', chatId: `group:${GROUP}`, userId: MOM, sent: 1 })
  r.su.observe({ kind: 'in', chatId: `group:${GROUP}`, userId: DAD })
  const state = r.su.state()
  assert.equal(state.familyActivity.observations[`group:${GROUP}`][MOM], r.now() - 12 * MINUTE)
  const restarted = r.make()
  const facts = r.facts(restarted.preview(r.now() + 6 * MINUTE))
  assert.equal(facts.members.find((p) => p.qq === MOM).quietMinutes, 18)
  assert.equal(facts.members.find((p) => p.qq === DAD).quietMinutes, 6)
  assert.equal(r.su.state().family[GROUP].count || 0, 0)
})

test('真实流水的遗忘标记同时作废先前观察缓存，不把过时/未来缓存当事实', (t) => {
  const r = rig(t), state = {}
  observeFamilyActivity(state, r.cfg, { kind: 'in', chatId: `group:${GROUP}`, userId: MOM, at: r.now() - MINUTE }, r.now())
  r.rows.push(r.row(MOM, 1, { forgottenAt: r.now() }), r.row(MOM, 180))
  refreshFamilyActivity(state, r.cfg, r.hub, r.now())
  assert.equal(familyActivityFacts(state, r.cfg, r.hub, `group:${GROUP}`, r.now()).members.find((p) => p.qq === MOM).quietMinutes, 180)
  observeFamilyActivity(state, r.cfg, { kind: 'in', chatId: `group:${GROUP}`, userId: MOM, at: r.now() + MINUTE }, r.now())
  refreshFamilyActivity(state, r.cfg, r.hub, r.now() + 49 * 3600_000)
  assert.equal(familyActivityFacts(state, r.cfg, r.hub, `group:${GROUP}`, r.now() + 49 * 3600_000).members.find((p) => p.qq === MOM).lastHumanAt, null)
})

test('关闭家庭近况互通后，私聊时间与送达记录不进入家庭群或另一位家人窗口', (t) => {
  const r = rig(t), state = { turns: { a: { status: 'sent', chatId: `private:${MOM}`, finishedAt: r.now() - MINUTE } } }
  r.rows.push(r.row(MOM, 3, { chatId: `private:${MOM}` }), r.row(MOM, 150))
  refreshFamilyActivity(state, r.cfg, r.hub, r.now())
  let facts = familyActivityFacts(state, r.cfg, r.hub, `group:${GROUP}`, r.now())
  assert.equal(facts.members.find((p) => p.qq === MOM).quietMinutes, 3)
  assert.equal(facts.recentProactive.length, 1)
  r.cfg.memory.crossContext = false
  facts = familyActivityFacts(state, r.cfg, r.hub, `group:${GROUP}`, r.now())
  assert.equal(facts.members.find((p) => p.qq === MOM).quietMinutes, 150)
  assert.equal(facts.recentProactive.length, 0)
  assert.deepEqual(familyActivityFacts(state, r.cfg, r.hub, `private:${DAD}`, r.now()).members.map((p) => p.qq), [DAD])
  assert.equal(familyActivityFacts(state, r.cfg, r.hub, 'private:999', r.now()), undefined)
})

test('预览既不写状态，也不消费启动恢复；接着tick仍遵守最近五分钟活动保护', async (t) => {
  const r = rig(t)
  r.rows.push(r.row(MOM, 1))
  r.advance(2)
  assert.equal(r.su.preview().some((o) => o.role === 'family'), false)
  assert.equal(existsSync(join(r.dir, 'speakup.json')), false)
  await r.su.tick()
  assert.equal(r.plans.length, 0)
  const bytes = readFileSync(join(r.dir, 'speakup.json'))
  r.su.preview()
  assert.deepEqual(readFileSync(join(r.dir, 'speakup.json')), bytes)
  r.advance(3); await r.su.tick()
  assert.equal(r.plans.length, 1)
})

test('选择与实际生成两步都有相同关心原则，生成前补入选择期间的新私聊活动', async (t) => {
  const r = rig(t)
  r.rows.push(r.row(MOM, 180))
  await r.su.tick()
  r.choose(() => {
    r.su.observe({ kind: 'in', chatId: `private:${MOM}`, userId: MOM, at: r.now() })
    return JSON.stringify({ target: `group:${GROUP}`, next_check_minutes: 5 })
  })
  r.advance(2); await r.su.tick()
  assert.equal(r.pushed.length, 1)
  assert.match(r.plans[0].prompt, /要带着具体的事去/)
  assert.match(r.pushed[0].text, /要带着具体的事去/)
  assert.equal(r.facts(r.plans[0].options).members.find((p) => p.qq === MOM).quietMinutes, 182)
  assert.match(r.pushed[0].text, /"lastHumanChatId":"private:10002"/)
  assert.match(r.pushed[0].text, /"quietMinutes":0/)
  assert.equal(r.plans[0].opts.stateless, true)
  assert.equal(r.plans[0].opts.noTools, true)
})

test('只有实际成功的回执进入最近主动联系事实；失败和沉默不计，群送达不指认妈妈已读', async (t) => {
  const r = rig(t)
  await r.su.tick(); r.advance(2); await r.su.tick()
  r.su.observe(r.event(0, { kind: 'proactive-result', outcome: 'failed', sent: 0 }))
  r.advance(5); await r.su.tick()
  assert.equal(r.pushed.length, 2)
  assert.equal(familyActivityFacts(r.su.state(), r.cfg, r.hub, `group:${GROUP}`, r.now()).recentProactive.length, 0)
  r.su.observe(r.event(1))
  const recent = r.facts(r.su.preview(r.now() + 10 * MINUTE)).recentProactive
  assert.equal(recent.length, 1)
  assert.equal(recent[0].chatId, `group:${GROUP}`)
  assert.equal(recent[0].recipientQQ, null)
  assert.equal(r.su.state().family[GROUP].count, 1)
})

test('朋友候选不携带家人活动，未配置身份的共同主人不会被猜成妈妈', async (t) => {
  const r = rig(t)
  r.cfg.coOwners[0] = { qq: MOM, name: '', role: '' }
  r.cfg.speakUp.allow.push('999')
  r.hub.lastPrivateAt = () => 0
  await r.su.tick()
  r.advance(2)
  // First synchronize with an observation to retain the normal schedule.
  r.su.observe({ kind: 'in', chatId: `private:${DAD}`, userId: DAD, at: r.now() - 10 * MINUTE })
  const options = r.su.preview()
  const state = {}
  refreshFamilyActivity(state, r.cfg, r.hub, r.now())
  const person = familyActivityFacts(state, r.cfg, r.hub, `group:${GROUP}`, r.now()).members.find((p) => p.qq === MOM)
  assert.equal(person.familyRole, '')
  assert.doesNotMatch(person.identity, /妈妈/)
  assert.equal(options.filter((o) => o.role === 'friend').length, 1)
  assert.ok(options.filter((o) => o.role === 'friend').every((o) => o.familyActivity === undefined))
})

for (const [category, choose] of [
  ['timeout', () => { throw new Error('request timed out PRIVATE_SENTINEL') }],
  ['request-error', () => { throw new Error('upstream PRIVATE_SENTINEL') }],
  ['invalid-format', () => 'PRIVATE_SENTINEL not JSON'],
  ['invalid-format', () => 'null'],
  ['invalid-target', () => JSON.stringify({ target: 'private:999', topic: 'PRIVATE_SENTINEL' })],
]) test(`选择失败只保存脱敏分类并退避：${category}/${choose.toString().slice(0,20)}`, async (t) => {
  const r = rig(t)
  await r.su.tick(); r.choose(choose); r.advance(2); await r.su.tick()
  assert.equal(r.su.state().planner.lastFailure.category, category)
  assert.ok(r.su.state().planner.nextAt > r.now())
  assert.equal(r.su.state().family[GROUP].count, 0)
  assert.equal(r.pushed.length, 0)
  assert.doesNotMatch(JSON.stringify(r.su.state()) + r.warnings.join('\n'), /PRIVATE_SENTINEL/)
})
