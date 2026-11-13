import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'aurabot-interaction-'))
process.env.AURABOT_DATA_DIR = join(root, 'boot')
process.env.AURABOT_WORKSPACE = join(root, 'workspace')
const { createHub } = await import('../src/chat/hub.js')
const { normalize } = await import('../src/core/config.js')
const { createFakeDsh } = await import('./helpers/fake-dsh.js')
const chat = { chatId: 'private:10001', kind: 'private', userId: '10001', nickname: '爸爸' }
const quiet = { info() {}, warn() {}, debug() {}, error() {} }
const settle = async () => { for (let n = 0; n < 40; n++) await new Promise(setImmediate) }
function setup(t, brain, call) {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(root, 'case-'))
  const events = [], fake = createFakeDsh({ brain })
  const cfg = normalize({ enabled: true, dryRun: false, ownerQQ: '10001', familyGroups: ['777'], merge: { enabled: false }, voice: { enabled: false }, stickers: { enabled: false, faces: false } })
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg, log: quiet, onebot: { call: call || (async () => ({ message_id: 1 })) }, onActivity: (e) => events.push(e) })
  fake.ctx.on('session/event', (s, e) => hub.onSessionEvent(s, e))
  t.after(() => { hub.dispose(); fake.dispose() })
  return { hub, fake, events }
}

test('排队两轮各保留真实输入和唯一轮次，不把下一条消息配给上一条回复', async (t) => {
  let release, entered
  const gate = new Promise((r) => { release = r }), ready = new Promise((r) => { entered = r })
  const s = setup(t, async ({ text }) => { if (text.includes('第一条认真请求')) { entered(); await gate } return text.includes('第一条认真请求') ? '第一条答复' : '后续答复' })
  await s.hub.pushToSession(chat, [{ type: 'text', text: '初始化' }], chat.userId); await settle(); s.events.length = 0
  const a = s.hub.pushToSession(chat, [{ type: 'text', text: '第一条认真请求' }], chat.userId)
  await ready
  const b = s.hub.pushToSession(chat, [{ type: 'text', text: '6' }], chat.userId)
  await new Promise(setImmediate); release(); await Promise.all([a, b]); await settle()
  const out = s.events.filter((e) => e.kind === 'out' && e.source === 'interaction')
  assert.equal(out.length, 2)
  assert.equal(out[0].userText, '第一条认真请求'); assert.equal(out[1].userText, '6')
  assert.notEqual(out[0].turnId, out[1].turnId)
  assert.equal(out[0].input.family, true); assert.equal(out[0].input.realUserInput, true)
  assert.equal(out[0].input.speakers[0].id, chat.userId)
  assert.equal(out[0].input.humanMessages[0].text, '第一条认真请求')
  assert.equal(out[1].input.humanMessages[0].text, '6')
  assert.notEqual(out[0].input.humanMessages[0].id, out[1].input.humanMessages[0].id)
})

test('本轮真实人类证据不混入所引用的助手回复或前文', async (t) => {
  const s = setup(t, async () => '看到了', async (action) => action === 'get_msg' ? { user_id: 20002, sender: { user_id: 20002, nickname: 'bot' }, message: [{ type: 'text', data: { text: '旧助手拒绝原话' } }] } : { message_id: 1 })
  await s.hub.onMessage({ post_type: 'message', message_type: 'private', self_id: 20002, user_id: 10001, message_id: 12, sender: { nickname: '爸爸' }, message: [{ type: 'reply', data: { id: 11 } }, { type: 'text', data: { text: '换成普通生活照吧' } }] })
  await settle()
  const out = s.events.find((e) => e.source === 'interaction')
  assert.match(out.userText, /旧助手拒绝原话/)
  assert.equal(out.input.humanMessages.length, 1)
  assert.equal(out.input.humanMessages[0].text, '换成普通生活照吧')
  assert.equal(out.input.humanMessages[0].speakerId, '10001')
})

test('群判断保留名字、引用和前文；外部发送保留direct来源', async (t) => {
  const s = setup(t, async () => '我明白你的意思了')
  const group = { kind: 'group', groupId: '777', chatId: 'group:777' }
  await s.hub.pushToSession(group, [{ type: 'text', text: '爸爸(10001)：6（接刚才的梗）' }], chat.userId, { queryText: '6', interactionInput: { text: '爸爸(10001)：6', context: '刚才妈妈说了个笑话', speakers: [{ id: '10001', name: '爸爸', direct: false }], quotes: [{ speaker: '妈妈', text: '刚才那个笑话' }] } })
  await settle()
  const out = s.events.find((e) => e.source === 'interaction')
  assert.equal(out.input.context, '刚才妈妈说了个笑话')
  assert.equal(out.input.quotes[0].speaker, '妈妈')
  await s.hub.sendText(chat.chatId, '一条系统通知'); await settle()
  const direct = s.events.find((e) => e.source === 'direct')
  assert.equal(direct.kind, 'out'); assert.equal(direct.userText, '')
})

test('主动沉默与发送失败返回结果，成功带proactiveId而不伪装真人输入', async (t) => {
  const s = setup(t, async ({ text }) => text.includes('沉默') ? '[沉默]' : '想起你啦', async (_action, params) => { if (params.message?.some((x) => x.data?.text === '想起你啦')) throw new Error('明确拒绝'); return { message_id: 1 } })
  await s.hub.pushToSession(chat, [{ type: 'text', text: '主动考虑但沉默' }], '', { origin: 'speak-up', proactiveId: 'silent-id' }); await settle()
  assert.ok(s.events.some((e) => e.kind === 'proactive-result' && e.proactiveId === 'silent-id' && e.outcome === 'silent'))
  await s.hub.pushToSession(chat, [{ type: 'text', text: '主动说一句' }], '', { origin: 'speak-up', proactiveId: 'fail-id' }); await settle()
  assert.ok(s.events.some((e) => e.kind === 'proactive-result' && e.proactiveId === 'fail-id' && e.outcome === 'failed'))
})
