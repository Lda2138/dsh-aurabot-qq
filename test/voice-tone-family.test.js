// 语音语气由她自己定（不浮夸）；家庭群冷清时她可以主动说一句。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 主动搭话的状态文件写在数据目录里：一定要用临时目录，别碰真正的 ~/.dsh/plugins-data/aurabot
process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-family-'))
beforeEach(() => { process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-family-case-')) })

const { parseReply } = await import('../src/chat/reply.js')
const { breezeInstructions, breezeSpeech } = await import('../src/voice/breeze.js')
const { normalize } = await import('../src/core/config.js')
const { createSpeakUp } = await import('../src/features/companion.js')

test('语音标签：<voice 语气="…"> 带出这一条的语气；不写语气照旧；英文属性不认', () => {
  const items = (s) => parseReply(s).items || parseReply(s)
  assert.deepEqual(items('<voice 语气="懒洋洋、有点嫌弃">知道了</voice>'), [{ kind: 'voice', value: '知道了', tone: '懒洋洋、有点嫌弃' }])
  assert.deepEqual(items('<voice 语气：小声嘀咕>行吧</voice>'), [{ kind: 'voice', value: '行吧', tone: '小声嘀咕' }])
  assert.deepEqual(items('<voice>晚安</voice>'), [{ kind: 'voice', value: '晚安' }])
})

test('念法提示：固定风格与本句语气都传入，不再统一压平情绪', async () => {
  const s = breezeInstructions('年轻女生，有点嘴硬', '懒洋洋')
  assert.match(s, /^年轻女生，有点嘴硬。这一句的语气：懒洋洋。/)
  assert.doesNotMatch(s, /语速平稳|不戏剧化|不拖长腔/)
  assert.match(breezeInstructions('', ''), /自主判断这句的情绪/)
  const calls = []
  const f = async (url, init) => { calls.push(JSON.parse(init.body)); return new Response(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(800)])) }
  await breezeSpeech('嗯', { apiKey: 'k', voiceId: 'v' }, { instructions: breezeInstructions('', '开心') }, f)
  assert.match(calls[0].instructions, /这一句的语气：开心。[\s\S]*不要一律平静/)
})

function familyRig({ lastGroupAt = 0, cfg = {} } = {}) {
  const config = normalize({ enabled: true, ownerQQ: '1', familyGroups: ['777'], speakUp: { enabled: true, awakeFrom: 0, awakeTo: 24, family: { idleMinutes: 60, maxPerDay: 2 } }, ...cfg })
  const pushed = []
  const hub = { lastOwnerChatAt: Date.now(), lastBotToOwner: { at: 0, text: '' }, lastPrivateAt: () => Date.now(), lastGroupAt: () => lastGroupAt, runSystemTurn: async () => JSON.stringify({ target: 'group:777', next_check_minutes: 60 }), pushToSession: async (chat, content) => pushed.push({ chat, text: content[0].text }) }
  return { su: createSpeakUp({ getConfig: () => config, hub, log: { info() {} } }), pushed }
}

test('家庭群主动：短启动保护、AI 安排下一次考虑、每日成功发言有上限', async () => {
  const realNow = Date.now
  const date = new Date(realNow()), t0 = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12).getTime()
  try {
    Date.now = () => t0 // 固定同一日，避免晚间运行时 +190 分钟跨午夜重置每日额度。
    const { su, pushed } = familyRig()
    await su.tick()
    assert.equal(pushed.filter((p) => p.chat.chatId === 'group:777').length, 0, '刚启动有短保护')
    Date.now = () => t0 + 61 * 60_000
    await su.tick()
    const fam = () => pushed.filter((p) => p.chat.chatId === 'group:777')
    assert.equal(fam().length, 1)
    assert.match(fam()[0].text, /你想在家庭群说句话[\s\S]*只回 \[沉默\]/)
    su.observe({ kind: 'out', chatId: 'group:777', userText: fam()[0].text, sent: 1 })
    await su.tick()
    assert.equal(fam().length, 1, '刚说完，要再隔够安静时间')
    Date.now = () => t0 + 125 * 60_000
    await su.tick()
    assert.equal(fam().length, 2)
    su.observe({ kind: 'out', chatId: 'group:777', userText: fam()[1].text, sent: 1 })
    Date.now = () => t0 + 190 * 60_000
    await su.tick()
    assert.equal(fam().length, 2, '每天 2 次用完了')
  } finally { Date.now = realNow }
})

test('家庭群有人在聊就不插；没设家庭群 / 关掉了就不动', async () => {
  const realNow = Date.now
  const t0 = realNow()
  try {
    Date.now = () => t0 + 5 * 3600_000
    const busy = familyRig({ lastGroupAt: t0 + 5 * 3600_000 - 10 * 60_000 })
    await busy.su.tick()
    assert.equal(busy.pushed.filter((p) => p.chat.chatId === 'group:777').length, 0)
    const none = familyRig({ cfg: { familyGroups: [] } })
    await none.su.tick()
    assert.equal(none.pushed.filter((p) => String(p.chat.chatId).startsWith('group:')).length, 0)
    const off = familyRig({ cfg: { speakUp: { enabled: true, awakeFrom: 0, awakeTo: 24, family: { enabled: false } } } })
    await off.su.tick()
    assert.equal(off.pushed.filter((p) => String(p.chat.chatId).startsWith('group:')).length, 0)
  } finally { Date.now = realNow }
})
