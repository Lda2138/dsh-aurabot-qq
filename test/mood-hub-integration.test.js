// 复现已安装 DSH 的事件次序：turn/start 先于 user/message，followup 只投递输入，
// 同一 driver 在它最初的异步上下文里继续处理后续轮次。所有发送及模型都是本地假服务。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { normalize } from '../src/core/config.js'

const root = mkdtempSync(join(tmpdir(), 'aurabot-mood-hub-'))
process.env.AURABOT_DATA_DIR = join(root, 'boot')
process.env.AURABOT_WORKSPACE = join(root, 'workspace')
const { createHub } = await import('../src/chat/hub.js')
const OWNER = '10001', CHAT = `private:${OWNER}`
const chat = { kind: 'private', chatId: CHAT, userId: OWNER, nickname: '爸爸' }
const settle = async () => { for (let n = 0; n < 25; n++) await new Promise(setImmediate) }
const textBlock = (text) => [{ type: 'text', text }]
async function setup(t) {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(root, 'case-'))
  const fake = createFakeDsh({ brain: async () => '' }), events = []
  const cfg = normalize({ enabled: true, dryRun: false, ownerQQ: OWNER, voice: { enabled: false }, stickers: { enabled: false, faces: false } })
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    onebot: { async call() { return { message_id: 1 } } }, onActivity: (e) => events.push(e),
    buildTools: () => [{ name: 'send-probe', execute: () => hub.sendText(CHAT, '工具探针') }] })
  fake.ctx.on('session/event', hub.onSessionEvent)
  t.after(() => { hub.dispose(); fake.dispose() })
  await hub.pushToSession(chat, textBlock('初始化'), OWNER)
  await settle()
  events.length = 0
  const agent = [...fake.agents.values()][0]
  const emit = (type, data) => fake.emit('session/event', agent.session, { type, data })
  const finish = (turn, text) => {
    emit('assistant/message', { turn, message: { content: textBlock(text) } })
    emit('turn/end', { turn, reason: { kind: 'completed' } })
  }
  const submitted = []
  agent.followup = (message) => { submitted.push(message) }
  return { hub, agent, events, emit, finish, submitted }
}
const interactionOut = (s) => s.events.filter((e) => e.kind === 'out' && e.source === 'interaction')

test('真实事件次序下本机输入仍归当前轮，不遗漏或滞留到下一轮', async (t) => {
  const s = await setup(t)
  s.emit('turn/start', { turn: 2 })
  s.emit('user/message', { id: 'desktop-input', source: { kind: 'user' }, content: textBlock('本机输入A') })
  s.finish(2, '本机A的答复')
  await settle()
  await s.hub.pushToSession(chat, textBlock('下一轮QQ输入B'), OWNER)
  s.emit('turn/start', { turn: 3 })
  s.emit('user/message', s.submitted.at(-1))
  s.finish(3, 'QQ输入B的答复')
  await settle()
  const out = interactionOut(s)
  assert.equal(out[0].input?.text, '本机输入A', 'turn/start 后登记的人类输入必须补领给当前轮')
  assert.equal(out[1].input?.text, '下一轮QQ输入B', '不能拿上一轮本机输入评价本轮QQ回复')
})

test('活动轮中的本机插话合入当前完整互动，不额外占下一轮队列', async (t) => {
  const s = await setup(t)
  await s.hub.pushToSession(chat, textBlock('起初QQ请求A'), OWNER)
  s.emit('turn/start', { turn: 2 })
  s.emit('user/message', s.submitted.at(-1))
  s.emit('assistant/message', { turn: 2, message: { content: [{ type: 'tool-call', name: 'probe' }] } })
  s.emit('user/message', { id: 'desktop-steer', source: { kind: 'user' }, content: textBlock('本机补充要求B') })
  s.finish(2, '结合A和B的完整答复')
  await settle()
  const out = interactionOut(s)
  assert.match(out[0].input?.text || '', /起初QQ请求A/)
  assert.match(out[0].input?.text || '', /本机补充要求B/)
})

test('同一真实driver中排队的直接工具发送使用当前轮proactiveId', async (t) => {
  const s = await setup(t)
  let release, entered
  const gate = new Promise((r) => { release = r }), ready = new Promise((r) => { entered = r })
  const pending = [], background = []
  let driver, turn = 1
  // DSH followup 返回 void；后续轮次继续使用首次唤醒 driver 时的异步上下文。
  s.agent.followup = (message) => {
    pending.push(message)
    if (!driver) {
      driver = Promise.resolve().then(async () => {
        while (pending.length) {
          const current = pending.shift(), currentTurn = ++turn
          s.emit('turn/start', { turn: currentTurn })
          s.emit('user/message', current)
          if (currentTurn === 2) { entered(); await gate }
          await s.hub.sendText(CHAT, `工具发送${currentTurn}`)
          s.finish(currentTurn, '')
        }
      })
      background.push(driver)
    }
  }
  t.after(() => release())
  await s.hub.pushToSession(chat, textBlock('第一轮主动请求'), '', { origin: 'speak-up', proactiveId: 'proactive-first' })
  await ready
  await s.hub.pushToSession(chat, textBlock('第二轮主动请求'), '', { origin: 'speak-up', proactiveId: 'proactive-second' })
  release()
  await Promise.all(background)
  await settle()
  const direct = s.events.filter((e) => e.kind === 'out' && e.source === 'direct')
  assert.equal(direct.length, 2)
  assert.equal(direct[0].proactiveId, 'proactive-first')
  assert.equal(direct[1].proactiveId, 'proactive-second', '异步上下文不能把第二轮工具回执标成第一轮')
})

test('待接纳输入以宿主消息ID对应，可乱序接纳并保持各轮原文', async (t) => {
  const s = await setup(t)
  await s.hub.pushToSession(chat, textBlock('先提交A'), OWNER)
  const a = s.submitted.at(-1)
  await s.hub.pushToSession(chat, textBlock('后提交B'), OWNER)
  const b = s.submitted.at(-1)
  s.emit('turn/start', { turn: 2 }); s.emit('user/message', b); s.finish(2, '回答B')
  await settle()
  s.emit('turn/start', { turn: 3 }); s.emit('user/message', a); s.finish(3, '回答A')
  await settle()
  assert.deepEqual(interactionOut(s).map((e) => e.input.text), ['后提交B', '先提交A'])
})

test('未被宿主接纳就失败的steer不会污染当前轮心情输入', async (t) => {
  const s = await setup(t)
  await s.hub.pushToSession(chat, textBlock('已接纳A'), OWNER)
  s.emit('turn/start', { turn: 2 }); s.emit('user/message', s.submitted.at(-1))
  s.agent.steer = () => { throw new Error('假的接纳失败') }
  await assert.rejects(s.hub.pushToSession(chat, textBlock('没有进入模型的B'), OWNER, { steer: true }), /假的接纳失败/)
  s.finish(2, '只回答A')
  await settle()
  assert.equal(interactionOut(s)[0].input.text, '已接纳A')
})

test('主动轮中接纳真人插话后以真人互动判心情，主动请求仅作背景', async (t) => {
  const s = await setup(t)
  await s.hub.pushToSession(chat, textBlock('【系统提醒】考虑主动找爸爸'), '', { origin: 'speak-up', proactiveId: 'initiated' })
  s.emit('turn/start', { turn: 2 }); s.emit('user/message', s.submitted.at(-1))
  s.emit('user/message', { id: 'human-reply', source: { kind: 'user' }, content: textBlock('正好，帮我想想这件事') })
  s.finish(2, '一起想想吧')
  await settle()
  const out = interactionOut(s)[0]
  assert.equal(out.origin, 'user')
  assert.equal(out.proactiveId, 'initiated')
  assert.equal(out.input.realUserInput, true)
  assert.equal(out.input.text, '正好，帮我想想这件事')
  assert.match(out.input.context, /主动搭话的后台背景/)
})

test('DSH本机发起的工具调用没有promptCapture也能带当前轮归属', async (t) => {
  const s = await setup(t)
  s.emit('turn/start', { turn: 2 })
  s.emit('user/message', { id: 'native-tool', source: { kind: 'user' }, content: textBlock('请用工具发一条') })
  await s.agent.tools.get('send-probe').execute({}, { agent: s.agent })
  const direct = s.events.find((e) => e.source === 'direct')
  assert.equal(direct.turnId, `${s.agent.session.id}:2`)
  assert.equal(direct.userText, '请用工具发一条')
})
