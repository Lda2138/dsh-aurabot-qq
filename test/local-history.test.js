import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'aurabot-local-history-'))
process.env.AURABOT_DATA_DIR = join(root, 'boot')
process.env.AURABOT_WORKSPACE = join(root, 'work')
const { createHub } = await import('../src/chat/hub.js')
const { normalize } = await import('../src/core/config.js')
const { createFakeDsh } = await import('./helpers/fake-dsh.js')
const { localHistoryRows, localHistoryBlock } = await import('../src/chat/local-history.js')
const { parseMemoryCommand } = await import('../src/features/memory.js')
const { memoryPromptRanges, promptFingerprint } = await import('../src/security/leak-guard.js')
const DAD = '10001', MOM = '10002', CHAT = `private:${DAD}`
const chat = { kind: 'private', chatId: CHAT, userId: DAD }
const body = [{ type: 'text', text: '【私聊】爸爸：快点' }]
const log = { info() {}, warn() {}, debug() {} }
const row = (who, text, age = 10000, chatId = CHAT) => ({ chatId, who, text, ...(who === 'bot' ? {} : { uid: DAD }), t: Date.now() - age })

function setup(t) {
  const dir = mkdtempSync(join(root, 'case-')); process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize({ enabled: true, dryRun: true, ownerQQ: DAD, ownerName: '爸爸', ownerRole: '爸爸', coOwners: [{ qq: MOM, role: '妈妈' }], familyGroups: ['777'],
    chat: { seedHistory: false }, memory: { crossContext: false }, voice: { enabled: false }, stickers: { enabled: false } })
  const fake = createFakeDsh({ brain: async () => '' }), calls = [], hubs = []
  const make = () => {
    const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg, log, onebot: { async call(action) { calls.push(action); throw new Error('No QQ calls allowed') } } })
    const off = fake.ctx.on('session/event', hub.onSessionEvent)
    hubs.push({ hub, off }); return hub
  }
  const hub = make()
  t.after(() => { for (const h of hubs) { h.off(); h.hub.dispose() }; fake.dispose() })
  const sessions = () => JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8'))
  return { dir, cfg, fake, hub, make, calls, sessions, restart() { const h = hubs.at(-1); h.off(); h.hub.dispose(); return make() } }
}

test('新会话首轮从本地补本窗口的双方原话、时间和承诺，不依赖QQ或seedHistory', async (t) => {
  const s = setup(t)
  s.hub.logChat(CHAT, '爸爸', '出门之前说一声', DAD, { at: Date.now() - 20000 })
  s.hub.logChat(CHAT, 'bot', '我出门时拍给你', '', { at: Date.now() - 10000 })
  s.hub.logChat(`private:${MOM}`, '妈妈', '其他窗口不能混入这段', MOM, { at: Date.now() - 10000 })
  await s.hub.pushToSession(chat, body, DAD)
  const input = s.fake.turns.at(-1).userText
  assert.match(input, /先补看最近 2 条本聊天本地记录/)
  assert.match(input, /\[\d{2}-\d{2} \d{2}:\d{2}\] 爸爸\(10001\)：出门之前说一声/)
  assert.match(input, /你当时说：我出门时拍给你/)
  assert.doesNotMatch(input, /其他窗口不能混入/)
  assert.equal(s.sessions().chats[CHAT].localHistoryPending, undefined)
  assert.ok(s.sessions().chats[CHAT].localHistorySeededAt)
  assert.equal(s.calls.length, 0)
  await s.hub.pushToSession(chat, body, DAD)
  assert.doesNotMatch(s.fake.turns.at(-1).userText, /补看最近/)
  const restored = s.restart()
  await restored.pushToSession(chat, body, DAD)
  assert.doesNotMatch(s.fake.turns.at(-1).userText, /补看最近/)
})

test('会话被归档后补回自己的最近发言，原会话和其他窗口会话保留', async (t) => {
  const s = setup(t)
  await s.hub.pushToSession(chat, body, DAD)
  const old = s.sessions().chats[CHAT].sessionId
  s.hub.logChat(CHAT, 'bot', '刚才答应明天提醒你带雨伞', '', { at: Date.now() - 1000 })
  s.fake.ctx.workspaceRegistry.archivedSessionIds.push(old)
  await s.hub.pushToSession(chat, body, DAD)
  assert.notEqual(s.sessions().chats[CHAT].sessionId, old)
  assert.match(s.fake.turns.at(-1).userText, /你当时说：刚才答应明天提醒你带雨伞/)
  assert.ok(s.fake.agents.has(old))
})

for (const target of [chat, { kind: 'group', chatId: 'group:777', groupId: '777', userId: DAD }]) {
  test(`显式刷新 ${target.kind} 后不补旧本地／跨窗对话，重启保持且新近况仍共享`, async (t) => {
    const s = setup(t)
    s.cfg.memory.crossContext = true
    await s.hub.pushToSession(target, [{ type: 'text', text: '建立旧会话' }], DAD)
    await new Promise(setImmediate)
    const old = s.sessions().chats[target.chatId].sessionId
    s.hub.logChat(target.chatId, 'bot', '旧会话中不应重新灌入的建议', '', { at: Date.now() - 10000 })
    s.hub.logChat(`private:${MOM}`, '妈妈', '刷新前另一个窗口的旧近况', MOM, { at: Date.now() - 5000 })
    const turns = s.fake.turns.length
    const result = await s.hub.refreshOwnerContext(target.chatId, { expectedSessionId: old })
    assert.equal(result.ok, true)
    assert.equal(s.fake.turns.length, turns, '刷新本身不启动模型')
    assert.equal(s.sessions().chats[target.chatId].localHistoryPending, undefined)
    assert.ok(s.sessions().chats[target.chatId].contextRefreshedAt)
    const restored = s.restart()
    assert.equal(restored.ownerCrossNote(target.chatId), '')
    await new Promise((resolve) => setTimeout(resolve, 5))
    restored.logChat(`private:${MOM}`, '妈妈', '刷新后新说的晚饭安排', MOM)
    assert.match(restored.ownerCrossNote(target.chatId), /刷新后新说的晚饭安排/)
    await restored.pushToSession(target, [{ type: 'text', text: '现在想聊点别的' }], DAD)
    const input = s.fake.turns.at(-1).userText
    assert.doesNotMatch(input, /先补看最近|旧会话中不应重新灌入|刷新前另一个窗口/)
    assert.match(input, /刷新后新说的晚饭安排/)
    assert.match(input, /现在想聊点别的/)
    assert.ok(s.fake.agents.has(old), '原始会话继续保留')
    assert.equal(s.calls.length, 0)
  })
}

test('首次准入失败不消费补历史机会，插件重启后仍会补入', async (t) => {
  const s = setup(t)
  s.hub.logChat(CHAT, 'bot', '失败后仍应知道自己说过这句话', '', { at: Date.now() - 10000 })
  const ctrl = s.fake.ctx.services.sessionController, create = ctrl.create
  let original
  ctrl.create = async (args) => {
    const result = await create(args), agent = s.fake.agents.get(result.sessionId)
    original = agent.followup; agent.followup = async () => { throw new Error('admission rejected') }; return result
  }
  await assert.rejects(s.hub.pushToSession(chat, body, DAD), /admission rejected/)
  assert.equal(s.sessions().chats[CHAT].localHistoryPending, true)
  s.fake.agents.get(s.sessions().chats[CHAT].sessionId).followup = original
  const restored = s.restart()
  await restored.pushToSession(chat, body, DAD)
  assert.match(s.fake.turns.at(-1).userText, /失败后仍应知道自己说过这句话/)
  assert.equal(s.sessions().chats[CHAT].localHistoryPending, undefined)
})

test('输入已接纳但后续执行抛错时不重复补历史', async (t) => {
  const s = setup(t)
  s.hub.logChat(CHAT, 'bot', '已经接纳的历史只补一次', '', { at: Date.now() - 10000 })
  const ctrl = s.fake.ctx.services.sessionController, create = ctrl.create
  let original
  ctrl.create = async (args) => {
    const result = await create(args), agent = s.fake.agents.get(result.sessionId)
    original = agent.followup; agent.followup = async (message) => { await original(message); throw new Error('after admission') }; return result
  }
  await assert.rejects(s.hub.pushToSession(chat, body, DAD), /after admission/)
  assert.equal(s.sessions().chats[CHAT].localHistoryPending, undefined)
  s.fake.agents.get(s.sessions().chats[CHAT].sessionId).followup = original
  await s.hub.pushToSession(chat, body, DAD)
  assert.doesNotMatch(s.fake.turns.at(-1).userText, /补看最近/)
})

test('本地补历史过滤遗忘、命令、系统、未来和本轮，最近20条保留双方顺序', () => {
  const now = Date.now(), cfg = normalize({ ownerQQ: DAD, ownerRole: '爸爸' })
  const old = Array.from({ length: 25 }, (_, i) => row(i % 2 ? 'bot' : '爸爸', `有效历史${i}`, 100000 - i * 1000))
  const rows = [...old, { ...row('爸爸', '已经忘记的原话'), forgottenAt: now }, row('系统', '【系统】结果'), row('爸爸', '忘记 关于秘密的事'),
    { ...row('bot', '看过内容'), kind: 'seen' }, row('爸爸', '当前这句', 1000), row('bot', '未来不应出现', -1000), row('bot', '另一个聊天', 10000, `private:${MOM}`)]
  const selected = localHistoryRows({ cfg, chatId: CHAT, rows, now, currentMessages: [{ text: '当前这句', at: now - 2000 }], isMemoryCommand: (text) => Boolean(parseMemoryCommand(text)) })
  assert.equal(selected.length, 20)
  assert.equal(selected[0].text, '有效历史5')
  assert.equal(selected.at(-1).text, '有效历史24')
  const block = localHistoryBlock({ cfg, rows: selected })
  assert.doesNotMatch(block, /秘密|已经忘记|当前这句|未来|另一个聊天|看过内容/)
  assert.match(block, /你当时说：有效历史/)
  assert.equal(memoryPromptRanges(block).length, 1)
  assert.equal(promptFingerprint([block]).size, 0, '历史原话可自然接续，不成为禁止复述的规则指纹')
})

test('没有本地记录也完成一次性检查；已有连续会话不因升级自动补历史', async (t) => {
  const s = setup(t)
  await s.hub.pushToSession(chat, body, DAD)
  assert.doesNotMatch(s.fake.turns.at(-1).userText, /补看最近/)
  const m = s.sessions(); delete m.chats[CHAT].localHistorySeededAt
  writeFileSync(join(s.dir, 'sessions.json'), JSON.stringify(m))
  s.hub.logChat(CHAT, 'bot', '连续会话本来已有的原话', '', { at: Date.now() - 10000 })
  const restored = s.restart()
  await restored.pushToSession(chat, body, DAD)
  assert.doesNotMatch(s.fake.turns.at(-1).userText, /补看最近/)
})
