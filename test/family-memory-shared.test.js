import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { normalize } from '../src/core/config.js'
import { createMemoryStore, parseMemoryCommand } from '../src/features/memory.js'
import memoryModule from '../src/modules/memory/index.js'
import { createHub } from '../src/chat/hub.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const DAD = '10001', MOM = '10002', OTHER = '10003'
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const log = { info() {}, warn() {}, debug() {}, error() {} }
const dad = { kind: 'private', chatId: `private:${DAD}`, userId: DAD, nickname: '爸爸' }
const mom = { kind: 'private', chatId: `private:${MOM}`, userId: MOM, nickname: '妈妈' }
const family = { kind: 'group', chatId: 'group:777', groupId: '777', userId: MOM }
function setup(t, patch = {}) {
  const old = process.env.AURABOT_DATA_DIR
  const oldWorkspace = process.env.AURABOT_WORKSPACE
  const data = mkdtempSync(join(tmpdir(), 'aurabot-family-memory-'))
  process.env.AURABOT_DATA_DIR = data
  process.env.AURABOT_WORKSPACE = join(data, 'workspace')
  t.after(() => {
    if (old === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = old
    if (oldWorkspace === undefined) delete process.env.AURABOT_WORKSPACE; else process.env.AURABOT_WORKSPACE = oldWorkspace
  })
  const cfg = normalize({ ownerQQ: DAD, ownerName: '爸爸', coOwners: [{ qq: MOM, name: '妈妈' }], familyGroups: ['777'],
    enabled: true, voice: { enabled: false }, stickers: { enabled: false }, ...patch })
  return { cfg, data }
}

test('默认共享覆盖爸爸、妈妈、家庭群，标明人和来源；外人和普通群不带入', (t) => {
  const { cfg } = setup(t)
  const now = Date.now()
  const rows = [
    { t: now - 60000, chatId: dad.chatId, who: '爸爸', uid: DAD, text: '爸爸明天想去看海' },
    { t: now - 50000, chatId: mom.chatId, who: '妈妈', uid: MOM, text: '妈妈今天喜欢喝柠檬茶' },
    { t: now - 40000, chatId: family.chatId, who: '妈妈', uid: MOM, text: '家庭群里约好周六吃饭' },
    { t: now - 30000, chatId: `private:${OTHER}`, who: 'bot', text: '外人的私聊秘密不能转进来' },
    { t: now - 20000, chatId: 'group:888', who: 'bot', text: '普通群聊天不能串进来' },
    { t: now - 10000, chatId: mom.chatId, who: '妈妈', uid: MOM, text: '已经忘掉的内容', forgottenAt: now },
  ]
  const mem = createMemoryStore({ getConfig: () => cfg, dsh: { get: () => null }, hub: { chatLogOf: () => rows }, log })
  assert.equal(cfg.memory.crossContext, true)
  for (const [chat, expected] of [[dad, '妈妈今天喜欢'], [mom, '爸爸明天想'], [family, '妈妈今天喜欢']]) {
    const hint = mem.recallHint(chat, '今天怎么样')
    assert.ok(hint.includes(expected), hint)
    assert.match(hint, /家人共享近况[\s\S]*分清是谁对谁说的/)
    assert.doesNotMatch(hint, /外人的私聊秘密|普通群聊天|已经忘掉/)
  }
  for (const chat of [{ kind: 'private', chatId: `private:${OTHER}`, userId: OTHER }, { kind: 'group', chatId: 'group:888', groupId: '888' }]) {
    assert.doesNotMatch(mem.recallHint(chat, '今天怎么样'), /家人共享近况|柠檬茶|想去看海/)
  }
})

test('自然记忆命令即时保存：请你、帮我、记一下、记下来；妈妈和家庭群同权', (t) => {
  const { cfg } = setup(t)
  const mem = createMemoryStore({ getConfig: () => cfg, dsh: { get: () => null }, hub: {}, log })
  for (const text of ['请你记住：我喜欢柠檬茶', '帮我记一下我喜欢茉莉茶', '你记下来：周六一起吃饭']) {
    assert.equal(parseMemoryCommand(text)?.action, 'remember')
    assert.equal(mem.handleCommand(mom, text)?.ok, true)
  }
  assert.equal(mem.handleCommand(family, '记住了，以后语音叫妈妈时亲近一点')?.ok, true)
  assert.match(mem.contextFor(dad), /语音叫妈妈/)
  assert.ok(mem.list('').some((m) => m.about === MOM && m.text.includes('柠檬茶')))
  assert.equal(parseMemoryCommand('记住了吗'), null)
})

test('DSH 面板直接输入记住：即时入库并标注真实操作者，不假装是妈妈说的', async (t) => {
  const { cfg, data } = setup(t)
  const fake = createFakeDsh({ brain: async () => '' })
  const mem = createMemoryStore({ getConfig: () => cfg, dsh: { get: () => null }, hub: {}, log })
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg, log, onebot: { connected: true, call: async () => ({ message_id: 1 }) }, onMemoryCommand: (chat, text) => mem.handleCommand(chat, text) })
  t.after(() => { hub.dispose(); fake.dispose() })
  await hub.pushToSession(mom, [{ type: 'text', text: '你好' }], MOM)
  const sid = hub.sessions()[mom.chatId].sessionId
  hub.onSessionEvent({ id: sid }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请你记住我喜欢喝乌龙茶' }] } })
  const saved = mem.list('').find((m) => m.text.includes('乌龙茶'))
  assert.ok(saved)
  assert.equal(saved.speaker, DAD)
  assert.equal(saved.about, DAD)
  const text = readFileSync(join(data, 'chatlog', dayKey() + '.jsonl'), 'utf8')
  assert.match(text, /DSH面板/)
})

test('记忆工具区分发言者和事实主体，不把妈妈的事写成爸爸的事', async (t) => {
  const { cfg } = setup(t)
  let build
  const mem = memoryModule.setup({ config: () => cfg, dsh: { get: () => null }, log,
    core: { hub: { turnSendersAllOwner: () => true, turnSenders: () => [DAD] }, http: {} },
    context() {}, on() {}, every() {}, route() {}, rule() {}, tool: (fn) => { build = fn } })
  const remember = build({ chat: dad, sessionId: 's' }).find((t) => t.name === 'remember')
  assert.equal((await remember.execute({ text: '妈妈喜欢柠檬茶', about: '妈妈', about_qq: MOM })).ok, true)
  const item = mem.list('').find((m) => m.text.includes('柠檬茶'))
  assert.equal(item.speaker, DAD)
  assert.equal(item.about, MOM)
  await remember.execute({ text: '小花喜欢看海', about: '小花' })
  assert.equal(mem.list('').find((m) => m.text.includes('小花'))?.about, '')
})
