// v14 单元：时间说法换算、提醒没回应再试、对方说话即结束、<记下> 解析、<poke:QQ> 解析、连着没人回就降频。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-sense-import-'))
const { normalize } = await import('../src/core/config.js')
const { createSpeakUp } = await import('../src/features/companion.js')
const { minutesUntil, createCareNotes, takeCareTags, takeNoticeTags, CARE_RETRY } = await import('../src/features/care-notes.js')
const { parseReply } = await import('../src/chat/reply.js')
const MINUTE = 60_000, DAD = '10001', MOM = '10002', GROUP = '777'
const freshDir = (name) => { const dir = mkdtempSync(join(tmpdir(), name)); process.env.AURABOT_DATA_DIR = dir; return dir }

test('时间说法换成分钟：今晚、明早、半小时、几个小时、晚上说的「9点」', () => {
  const now = new Date(2026, 10, 12, 19, 8).getTime()
  assert.equal(minutesUntil('今晚忙完', now), 112)
  assert.equal(minutesUntil('半小时后', now), 30)
  assert.equal(minutesUntil('两个小时后', now), 120)
  assert.equal(minutesUntil('9点', now), 112, '晚上七点说 9 点是今晚九点')
  assert.equal(minutesUntil('晚上九点半', now), 142)
  assert.equal(minutesUntil('明早', now), (24 * 60 + 8 * 60 + 30) - (19 * 60 + 8))
  assert.equal(minutesUntil('下课后', now), 120)
  assert.equal(minutesUntil('过几天', now), null, '认不出不硬猜')
  assert.equal(minutesUntil('', now), null)
})

test('提醒没回应：按 20 / 40 分钟再试，最多 3 次；对方一说话就结束', () => {
  freshDir('aurabot-sense-retry-')
  const notes = createCareNotes(), t0 = Date.parse('2026-11-12T12:00:00Z'), chat = `private:${DAD}`
  notes.add(chat, [{ text: '提醒爸爸教我唱歌', minutes: 10, kind: 'remind' }], { now: t0 })
  let due = notes.due(chat, t0 + 10 * MINUTE)
  assert.equal(due.length, 1)
  notes.finish([due[0].id], 'asked', t0 + 10 * MINUTE)
  assert.equal(notes.due(chat, t0 + 25 * MINUTE).length, 0, '第一次之后等 20 分钟')
  due = notes.due(chat, t0 + 31 * MINUTE)
  assert.equal(due.length, 1, '没回应，20 分钟后再提')
  assert.equal(due[0].tries, 1)
  assert.equal(notes.fresh(t0 + 31 * MINUTE), true, '再试时提前叫醒规划')
  notes.finish([due[0].id], 'asked', t0 + 31 * MINUTE)
  due = notes.due(chat, t0 + 72 * MINUTE)
  assert.equal(due.length, 1, '再 40 分钟后第三次')
  notes.finish([due[0].id], 'asked', t0 + 72 * MINUTE)
  assert.equal(notes.list()[0].status, 'asked', `提醒最多 ${CARE_RETRY.remind.length + 1} 次`)
  notes.add(chat, [{ text: '问问考试', minutes: 10 }], { now: t0 })
  const ask = notes.due(chat, t0 + 11 * MINUTE)
  notes.finish([ask[0].id], 'asked', t0 + 11 * MINUTE)
  assert.equal(notes.answered(`group:${GROUP}`, t0 + 20 * MINUTE), false, '别的聊天说话不算')
  assert.equal(notes.answered(chat, t0 + 20 * MINUTE), true)
  assert.equal(notes.list().find((n) => n.text === '问问考试').status, 'answered')
})

test('提醒和惦记同一件事只留一条；<惦记 … 提醒> 记成提醒', () => {
  freshDir('aurabot-sense-twin-')
  const notes = createCareNotes(), t0 = Date.parse('2026-11-12T12:00:00Z')
  notes.add(`group:${GROUP}`, [{ text: '提醒爸爸：教我唱歌', minutes: 112, kind: 'remind' }], { now: t0 })
  const tag = takeCareTags('好<惦记 分钟后="120" 提醒>提醒爸爸教我唱歌</惦记>')
  assert.equal(tag.notes[0].kind, 'remind')
  notes.add(`group:${GROUP}`, tag.notes, { now: t0 })
  assert.equal(notes.list().length, 1)
})

test('<记下> 标签：取出内容和关于谁，标签不留在文字里', () => {
  const r = takeNoticeTags('九点吧<记下 关于="妈妈">妈妈晚上九点下课</记下>')
  assert.equal(r.text, '九点吧')
  assert.deepEqual(r.notes, [{ text: '妈妈晚上九点下课', about: '妈妈' }])
  assert.deepEqual(takeNoticeTags('普通回复').notes, [])
})

test('<poke:QQ> 解析出要戳谁；<poke> 照旧', () => {
  const a = parseReply(`好<poke:${MOM}>`, {})
  assert.equal(a.items.find((i) => i.kind === 'poke').value, MOM)
  const b = parseReply('戳你<poke>', {})
  assert.equal(b.items.find((i) => i.kind === 'poke').value, '')
})

test('连着两次主动找人都没人回：24 小时内只在惦记到点时才找', async (t) => {
  freshDir('aurabot-sense-ignored-')
  const originalNow = Date.now
  let now = Date.parse('2026-11-12T01:00:00Z')
  Date.now = () => now
  t.after(() => { Date.now = originalNow })
  const cfg = normalize({ enabled: true, ownerQQ: DAD, ownerName: '老登', ownerRole: '爸爸', coOwners: [{ qq: MOM, name: '', role: '妈妈' }], familyGroups: [GROUP],
    speakUp: { enabled: true, awakeFrom: 0, awakeTo: 24, idleMinutes: 1, minIntervalMinutes: 1, maxIntervalMinutes: 1, maxPerDay: 20, nudge: false, family: { enabled: false } } })
  const pushed = []
  const hub = { chatLogDays: () => [], chatLogOf: () => [], lastPrivateAt: () => 0, lastGroupAt: () => 0, canSendPrivate: (qq) => qq !== MOM,
    runSystemTurn: async () => JSON.stringify({ target: `private:${DAD}`, topic: '随便聊聊', next_check_minutes: 5 }),
    pushToSession: async (chat, content, _who, opts) => pushed.push({ chat, text: content[0].text, opts }) }
  const su = createSpeakUp({ getConfig: () => cfg, hub, log: { info() {}, warn() {} } })
  const sendOnce = async () => {
    const before = pushed.length
    await su.tick()
    if (pushed.length > before) su.observe({ kind: 'out', chatId: `private:${DAD}`, proactiveId: pushed.at(-1).opts.proactiveId, sent: 1 })
    return pushed.length > before
  }
  now += 3 * MINUTE
  await su.tick() // 第一次只排时间
  now += 2 * MINUTE
  assert.equal(await sendOnce(), true)
  now += 4 * 60 * MINUTE
  assert.equal(await sendOnce(), true, '第一次没人回，还会再试')
  now += 4 * 60 * MINUTE
  assert.equal(await sendOnce(), false, '连着两次没人回，先不找了')
  createCareNotes().add(`private:${DAD}`, [{ text: '问问爸爸考试', minutes: 10 }], { now })
  now += 11 * MINUTE
  assert.equal(await sendOnce(), true, '惦记到点照样问')
  su.observe({ kind: 'in', chatId: `private:${DAD}`, userId: DAD, at: now + MINUTE })
  now += 2 * MINUTE
  assert.equal(su.state().turns[pushed.at(-1).opts.proactiveId].replied > 0, true, '3 小时内回了话就算有回应')
})
