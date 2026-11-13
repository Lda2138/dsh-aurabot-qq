// 主动搭话：只看私聊的冷场时间（群里热闹不影响）、追问只追一次。
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let createSpeakUp
let normalize
const OWNER = '10000001'

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-speak-'))
  ;({ createSpeakUp } = await import('../src/features/companion.js'))
  ;({ normalize } = await import('../src/core/config.js'))
})
beforeEach(() => { process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-speak-case-')) })

function setup(hubState, speakUp = {}, choose = (options) => ({ target: options[0].chatId, next_check_minutes: 5 })) {
  const pushed = []
  const cfg = normalize({ enabled: true, ownerQQ: OWNER, speakUp: { awakeFrom: 0, awakeTo: 24, minIntervalMinutes: 5, maxIntervalMinutes: 5, ...speakUp } })
  const hub = { ...hubState, runSystemTurn: async (_name, _title, prompt) => JSON.stringify(choose(JSON.parse(prompt.match(/候选：(.*)\n只输出/)[1]))), pushToSession: async (chat, content) => pushed.push({ chat, text: content[0].text }) }
  const s = createSpeakUp({ getConfig: () => cfg, hub, log: { info() {} } })
  return { s, pushed }
}
const min = 60_000

test('默认打开，只找主人私聊', () => {
  const c = normalize({}).speakUp
  assert.equal(c.enabled, true)
  assert.equal(c.nudge, true)
})

test('群里一直很热闹也不妨碍她私聊找你', async () => {
  const { s, pushed } = setup({ lastOwnerChatAt: Date.now() - 120 * min, lastChatAt: Date.now(), lastBotToOwner: { at: Date.now() - 120 * min, text: '晚安' } })
  await s.tick() // 第一次只排时间
  const st = s.state()
  st.nextAt = Date.now() - 1
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(process.env.AURABOT_DATA_DIR, 'speakup.json'), JSON.stringify(st))
  await s.tick()
  assert.equal(pushed.length, 1)
  assert.equal(pushed[0].chat.chatId, 'private:' + OWNER)
  assert.match(pushed[0].text, /对方在忙或现在没必要开口就只回 \[沉默\]/)
})

test('她问了一句你没回：追问一次，不会反复追', async () => {
  const realRandom = Math.random
  Math.random = () => 0.1
  try {
    const asked = { at: Date.now() - 20 * min, text: '你今天去哪玩了？' }
    const { s, pushed } = setup({ lastOwnerChatAt: Date.now() - 25 * min, lastChatAt: 0, lastBotToOwner: asked }, { idleMinutes: 600 })
    await s.tick()
    await s.tick()
    assert.equal(pushed.length, 1)
    assert.match(pushed[0].text, /自己判断要不要轻轻接一句/)
  } finally {
    Math.random = realRandom
  }
})

test('AI 认为暂时不用追问时保持沉默', async () => {
  const { s, pushed } = setup({ lastOwnerChatAt: Date.now() - 25 * min, lastChatAt: 0, lastBotToOwner: { at: Date.now() - 20 * min, text: '好哦' } }, { idleMinutes: 600 }, () => ({ target: '', next_check_minutes: 15 }))
  await s.tick()
  assert.equal(pushed.length, 0)
})
