import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'aurabot-recovery-context-'))
process.env.AURABOT_DATA_DIR = join(root, 'boot')
process.env.AURABOT_WORKSPACE = join(root, 'workspace')
const { recoveryContext } = await import('../src/chat/recovery-context.js')
const { createHub } = await import('../src/chat/hub.js')
const { normalize } = await import('../src/core/config.js')
const { createFakeDsh } = await import('./helpers/fake-dsh.js')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const quiet = { info() {}, warn() {}, debug() {}, error() {} }
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII='
async function until(fn) {
  const deadline = Date.now() + 5000
  while (!fn()) { if (Date.now() > deadline) throw new Error('等待恢复上下文或回复超时'); await sleep(10) }
}

function setup(t, brain, merge = false) {
  const data = mkdtempSync(join(root, 'case-'))
  process.env.AURABOT_DATA_DIR = data
  const cfg = normalize({ enabled: true, dryRun: false, ownerQQ: '10001', botQQ: '20002', familyGroups: ['777'],
    merge: { enabled: merge, groupWaitSec: 0.3, groupMaxSec: 1 },
    voice: { enabled: false }, stickers: { collect: false, autoChance: 0 },
    titleFilter: { enabled: false }, chat: { typingDelay: false }, group: { addressedOnly: true },
  })
  const sent = []
  const fake = createFakeDsh({ brain })
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg, log: quiet, onebot: { call: async (action, params) => {
    if (action.startsWith('send_')) { sent.push(params); return { message_id: 'sent-' + sent.length } }
    return {}
  } } })
  fake.ctx.on('session/event', (s, e) => hub.onSessionEvent(s, e))
  t.after(() => { hub.dispose(); fake.dispose() })
  let id = 0
  const send = (text, { late, image = false, privateChat = false, mentioned = false } = {}) => hub.onMessage({
    post_type: 'message', message_type: privateChat ? 'private' : 'group', sub_type: privateChat ? 'friend' : 'normal',
    self_id: 20002, user_id: 10001, ...(!privateChat ? { group_id: 777 } : {}), message_id: ++id,
    sender: { nickname: '爸爸' }, time: Math.floor((late || Date.now()) / 1000),
    message: [...(mentioned ? [{ type: 'at', data: { qq: '20002' } }] : []),
      { type: 'text', data: { text } }, ...(image ? [{ type: 'image', data: { file: 'base64://' + png, sub_type: 1, summary: '[/微笑]' } }] : [])],
    ...(late ? { __late: { at: late } } : {}),
  })
  return { data, fake, hub, send, sent }
}

test('恢复历史排序并保留实际后续回复；不把当前实时输入重复写成旧背景', () => {
  const t = Date.now() - 600_000
  const recovered = [{ t, who: '爸爸', uid: '1', text: '[/微笑]', messageId: 'old' }]
  const rows = [{ ...recovered[0] }, { t: t + 1000, who: 'bot', text: '晚安' },
    { t: t + 2000, who: '爸爸', text: '现在的新问题', messageId: 'new' },
    { t: t + 3000, who: '爸爸', text: '已忘记的内容', forgottenAt: t + 4000 }]
  const text = recoveryContext({ recovered, rows, label: '同一群', excludeIds: ['new'] })
  assert.equal(text.split('[/微笑]').length, 2, '同 ID 不重复')
  assert.ok(text.indexOf('[/微笑]') < text.indexOf('实际已发送）：晚安'))
  assert.doesNotMatch(text, /现在的新问题|已忘记的内容|都要回/)
  assert.match(text, /可以只回 \[沉默\]/)
})

test('上下文预算不丢恢复消息，并明确说明中间已有对话省略', () => {
  const t = Date.now() - 100_000
  const recovered = [{ t, who: '爸爸', text: '漏掉的问题', messageId: 'old' }]
  const rows = Array.from({ length: 10 }, (_, i) => ({ t: t + 1000 + i, who: 'bot', text: `后续${i}` }))
  const text = recoveryContext({ recovered, rows, label: '同一聊天', maxRows: 2 })
  assert.match(text, /漏掉的问题[\s\S]*后续9/)
  assert.match(text, /9 条已有记录省略/)
  assert.doesNotMatch(text, /后续0/)
})

test('真实图片形式的旧微笑在晚安后补回：带后续送达记录、模型可沉默，不标成最新发言', async (t) => {
  const h = setup(t, async ({ text }) => text.includes('补齐历史，按原时间排列') ? '[沉默]' : '晚安，明天见')
  await h.send('我要睡了，晚安')
  await until(() => h.sent.length === 1)
  const beforeActivity = h.hub.lastChatAt
  const late = Date.now() - 9 * 60_000
  await h.send('[/微笑]', { late, image: true })
  await until(() => h.fake.turns.length === 2)
  await sleep(30)
  const turn = h.fake.turns[1]
  assert.match(turn.userText, /补齐历史，按原时间排列/)
  assert.ok(turn.userText.indexOf('补齐的原消息') < turn.userText.indexOf('实际已发送）：晚安'))
  assert.doesNotMatch(turn.userText, /刚才新说的|都要回|刚看到当时/)
  assert.equal(turn.images, 1, '图片附件保留，模型仍可识别真实表情')
  assert.equal(h.sent.length, 1, '软判断允许沉默，没有机械补发')
  assert.equal(h.hub.lastChatAt, beforeActivity, '历史恢复不伪造新的实时活动')
  const rows = readdirSync(join(h.data, 'chatlog')).flatMap((n) => readFileSync(join(h.data, 'chatlog', n), 'utf8').trim().split('\n').map(JSON.parse))
  assert.ok(rows.some((r) => r.text.includes('[/微笑]') && r.t === late), '原历史仍保存')
})

test('恢复遗漏的问题仍交给模型，允许正常补答，不因是历史就一刀切丢弃', async (t) => {
  const h = setup(t, async () => '明天上午九点提醒你')
  await h.send('明天上午九点提醒我写作业好吗', { late: Date.now() - 600_000, mentioned: true })
  await until(() => h.sent.length === 1)
  assert.match(h.fake.turns[0].userText, /补齐历史[\s\S]*明天上午九点提醒我写作业好吗/)
  assert.ok(JSON.stringify(h.sent[0]).includes('明天上午九点提醒你'))
})

test('实时输入与补收合并时，只有实时输入在“刚才新说的”里', async (t) => {
  const h = setup(t, async () => '听到新的安排了', true)
  await h.send('旧的安排是上午', { late: Date.now() - 600_000 })
  await h.send('改成下午，按这个来')
  await until(() => h.sent.length === 1)
  const text = h.fake.turns[0].userText
  const fresh = text.split('刚才新说的（1 条）')[1]
  assert.match(text, /补齐的原消息[\s\S]*旧的安排是上午/)
  assert.match(fresh, /改成下午，按这个来/)
  assert.doesNotMatch(fresh, /旧的安排是上午/)
})

test('生成新回复期间恢复旧输入：不 steer、不压下正在生成的回复，之后再补上下文', async (t) => {
  let release, entered
  const started = new Promise((r) => { entered = r })
  const held = new Promise((r) => { release = r })
  const h = setup(t, async ({ text }) => {
    if (text.includes('补齐历史，按原时间排列')) return '[沉默]'
    entered(); await held; return '按你刚说的安排好了'
  })
  await h.send('我刚才的新安排是什么')
  await started
  await h.send('很早之前的表情', { late: Date.now() - 600_000 })
  assert.ok([...h.fake.agents.values()].every((a) => a.steered.length === 0))
  release()
  await until(() => h.fake.turns.length === 2 && h.sent.length === 1)
  assert.ok(JSON.stringify(h.sent[0]).includes('按你刚说的安排好了'), '新回复不会被旧输入压下')
})

test('私聊恢复也展示后续晚安，允许沉默，且与群聊历史分开', async (t) => {
  const h = setup(t, async ({ text }) => text.includes('补齐历史，按原时间排列') ? '[沉默]' : '晚安，明天见')
  await h.send('私聊里先说晚安', { privateChat: true })
  await until(() => h.sent.length === 1)
  await h.send('私聊旧微笑', { privateChat: true, late: Date.now() - 600_000 })
  await until(() => h.fake.turns.length === 2)
  await sleep(30)
  assert.match(h.fake.turns[1].userText, /私聊 · 补齐历史[\s\S]*私聊旧微笑[\s\S]*实际已发送）：晚安/)
  assert.doesNotMatch(h.fake.turns[1].userText, /刚才新说的|又有人说了/)
  assert.equal(h.sent.length, 1)
})
