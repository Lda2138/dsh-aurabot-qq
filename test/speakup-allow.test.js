import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let normalize, createSpeakUp, parseCommand, runCommand
before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-speakup-'))
  ;({ normalize } = await import('../src/core/config.js'))
  ;({ createSpeakUp } = await import('../src/features/companion.js'))
  ;({ parseCommand, runCommand } = await import('../src/chat/commands.js'))
})
beforeEach(() => { process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-speakup-case-')) })
const chooseFirst = async (_name, _title, prompt) => JSON.stringify({ target: JSON.parse(prompt.match(/候选：(.*)\n只输出/)[1])[0].chatId, next_check_minutes: 5 })

test('每天次数：默认 20，留空 20，填多少算多少', () => {
  assert.equal(normalize({}).speakUp.maxPerDay, 20)
  assert.equal(normalize({ speakUp: { maxPerDay: '' } }).speakUp.maxPerDay, 20)
  assert.equal(normalize({ speakUp: { maxPerDay: 500 } }).speakUp.maxPerDay, 500)
  assert.equal(normalize({ speakUp: { maxPerDay: 0 } }).speakUp.maxPerDay, 0)
})

test('上下限放宽，天然范围保留', () => {
  const c = normalize({ speakUp: { idleMinutes: 3000 }, bili: { maxCommentsPerDay: 999, perRun: 40 }, stickers: { autoChance: 5 }, mood: { base: 95 } })
  assert.equal(c.speakUp.idleMinutes, 3000)
  assert.equal(c.bili.maxCommentsPerDay, 999)
  assert.equal(c.bili.perRun, 40)
  assert.equal(c.mood.base, 95)
  assert.equal(c.stickers.autoChance, 1, '概率还是 0~1')
})

test('白名单：只留 QQ 号并去重', () => {
  assert.deepEqual(normalize({ speakUp: { allow: ['123456', 123456, 'abc', '12'] } }).speakUp.allow, ['123456'])
})

test('/speak 加人时也进私聊白名单，能移除', async () => {
  let cfg = normalize({ ownerQQ: '1' })
  const ctx = { getConfig: () => cfg, setConfig: (n) => { cfg = n } }
  const run = (text) => runCommand(parseCommand(text), { chatId: 'private:1', kind: 'private', userId: '1' }, ctx)
  assert.match(await run('/speak'), /空的/)
  assert.match(await run('/speak add 123456'), /主动找 123456/)
  assert.deepEqual(cfg.speakUp.allow, ['123456'])
  assert.ok(cfg.allow.private.includes('123456'))
  assert.match(await run('/搭话'), /123456/)
  assert.match(await run('/speak del 123456'), /不再/)
  assert.deepEqual(cfg.speakUp.allow, [])
  assert.match(await run('/speak add abc'), /用法/)
})

test('白名单的人到点才找，一轮只找一个，次数到顶就停', async () => {
  const cfg = normalize({ enabled: true, ownerQQ: '1', speakUp: { enabled: true, allow: ['22222', '33333'], minIntervalMinutes: 1, maxIntervalMinutes: 1, idleMinutes: 1, maxPerDay: 1, awakeFrom: 0, awakeTo: 24 } })
  const sent = []
  const hub = { get lastOwnerChatAt() { return Date.now() }, lastBotToOwner: { at: 0, text: '' }, lastPrivateAt: () => 0, runSystemTurn: chooseFirst, pushToSession: async (chat, content) => sent.push({ chat, text: content[0].text }) }
  const realNow = Date.now
  const anchor = new Date().setHours(12, 0, 0, 0)
  Date.now = () => anchor
  const su = createSpeakUp({ getConfig: () => cfg, hub, log: { info() {} } })
  try {
    await su.tick() // 第一次只排时间
    assert.equal(sent.length, 0)
    Date.now = () => anchor + 5 * 60_000
    await su.tick()
    assert.deepEqual(sent.map((x) => x.chat.chatId), ['private:22222'])
    assert.doesNotMatch(sent[0].text, /主人(?!或别人的私事)/)
    su.observe({ kind: 'out', chatId: sent[0].chat.chatId, userText: sent[0].text, sent: 1 })
    Date.now = () => anchor + 10 * 60_000
    await su.tick()
    assert.deepEqual(sent.map((x) => x.chat.chatId), ['private:22222', 'private:33333'])
    su.observe({ kind: 'out', chatId: sent[1].chat.chatId, userText: sent[1].text, sent: 1 })
    Date.now = () => anchor + 60 * 60_000
    await su.tick()
    assert.equal(sent.length, 2, '每人一天 1 次用完了')
  } finally { Date.now = realNow }
})

test('第二位主人：不用进主动搭话白名单也会被主动找，提醒按主人口吻、带上称呼', async () => {
  const cfg = normalize({ enabled: true, ownerQQ: '1', coOwners: [{ qq: '44444', name: '老妈' }], speakUp: { enabled: true, allow: [], minIntervalMinutes: 1, maxIntervalMinutes: 1, idleMinutes: 1, maxPerDay: 1, awakeFrom: 0, awakeTo: 24 } })
  const sent = []
  const hub = { get lastOwnerChatAt() { return Date.now() }, lastBotToOwner: { at: 0, text: '' }, lastPrivateAt: () => 0, runSystemTurn: chooseFirst, pushToSession: async (chat, content) => sent.push({ chat, text: content[0].text }) }
  const realNow = Date.now
  const su = createSpeakUp({ getConfig: () => cfg, hub, log: { info() {} } })
  try {
    await su.tick()
    Date.now = () => realNow() + 5 * 60_000
    await su.tick()
    assert.deepEqual(sent.map((x) => x.chat.chatId), ['private:44444'])
    assert.match(sent[0].text, /老妈/)
    assert.match(sent[0].text, /也是你的主人/)
    assert.equal(sent[0].chat.nickname, '老妈')
  } finally { Date.now = realNow }
})
