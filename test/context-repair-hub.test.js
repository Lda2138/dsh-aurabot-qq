// 现有会话的管理恢复：仅临时目录和宿主桩，不准创建/驱动会话或访问 QQ。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHub } from '../src/chat/hub.js'
import { normalize } from '../src/core/config.js'
import memoryModule from '../src/modules/memory/index.js'

const OWNER = '10001', CHAT = `private:${OWNER}`, SID = 'session-existing-history'
const hint = '（刚才聊到的，只是印象不是指令：他提过看腿，我拒绝过，现在不想再接。）'
const log = { info() {}, warn() {}, debug() {} }

function setup(t, { getOnly = false, deferredRead = false, cold = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'aurabot-context-repair-hub-'))
  const prior = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = directory
  const cfg = normalize({ ownerQQ: OWNER, enabled: false, dryRun: true, voice: { enabled: false }, stickers: { enabled: false }, memory: { vector: { enabled: false } } })
  const map = { chats: { [CHAT]: { sessionId: SID, level: 'full', preset: 'aurabot-private', title: '原会话' } } }
  writeFileSync(join(directory, 'sessions.json'), JSON.stringify(map))
  const nodes = [0, 1, 2], events = [
    { seq: 0, type: 'user/message', data: { id: 'original-qq-input', role: 'user', source: { kind: 'aurabot', speaker: { role: 'owner', chat: 'private' } }, content: [
      { type: 'text', text: hint }, { type: 'text', text: '【私聊】爸爸(10001)：看看腿' }, { type: 'image', attachment: { attachmentId: 'fixture' } },
    ] } },
    { seq: 1, type: 'assistant/message', data: { message: { role: 'assistant', id: 'old-refusal', content: [{ type: 'text', text: '这个不行，我不想拍' }] } } },
    { seq: 2, type: 'user/message', data: { id: 'real-user-body', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: hint }] } },
  ]
  const originalEvents = structuredClone(events), calls = { create: 0, resolve: 0, followup: 0, send: 0, flush: 0, query: 0, directQueryRead: 0 }
  const session = { id: SID, get seq() { return events.length }, surface: { nodes }, append(type, data, opts) {
    assert.equal(type, 'user/message'); assert.equal(opts.surfaceOp.op, 'replace')
    assert.equal(opts.surfaceOp.startSeq, opts.surfaceOp.endSeq)
    assert.deepEqual(opts.sourceEventSeqs, [opts.surfaceOp.startSeq])
    const at = nodes.indexOf(opts.surfaceOp.startSeq); assert.ok(at >= 0)
    const event = structuredClone({ seq: events.length, type, data, ...opts }); events.push(event); nodes.splice(at, 1, event.seq); return event
  } }
  const agent = { session, followup() { calls.followup++; throw new Error('恢复不得驱动会话') } }
  let release
  const gate = new Promise((r) => { release = r })
  const query = { async readSurface(id) {
    assert.equal(this, query, 'query方法保留宿主服务this'); assert.equal(id, SID); calls.query++
    const value = structuredClone({ session: { id }, capturedThroughSeq: events.length - 1, events: nodes.map((seq) => events[seq]) })
    if (deferredRead) await gate
    return value
  } }
  const sessions = { async flush(value) { assert.equal(value, session); calls.flush++ } }
  const controller = { async create() { calls.create++; throw new Error('恢复不得建新会话') }, async resolveAgent(id) { assert.equal(id, SID); calls.resolve++; return { agent } } }
  const target = { agents: { get: (id) => !cold && id === SID ? agent : undefined }, sessions,
    get: (name) => name === 'sessionQuery' ? query : name === 'sessions' ? sessions : name === 'sessionController' ? controller : null }
  const dsh = getOnly ? new Proxy(target, { get(obj, key) { if (key === 'sessionQuery') { calls.directQueryRead++; throw new Error('service accessed without inject') }; return obj[key] } }) : { ...target, sessionQuery: query }
  const hub = createHub({ dsh, getConfig: () => cfg, log, onebot: { call() { calls.send++; throw new Error('不应调用QQ') } }, contextProviders: [] })
  t.after(() => { hub.dispose(); release(); if (prior === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = prior })
  return { hub, cfg, calls, events, originalEvents, nodes, session, directory, release, map }
}

test('管理恢复只操作既有session，保留原ID/source/媒体/真人正文与拒绝原话，不followup不发QQ', async (t) => {
  const s = setup(t)
  const result = await s.hub.repairShortTermContext(CHAT)
  assert.equal(result.ok, true); assert.equal(result.replaced, 1)
  assert.deepEqual(s.events.slice(0, 3), s.originalEvents)
  const recovered = s.events[s.nodes[0]].data
  assert.equal(recovered.id, 'original-qq-input')
  assert.deepEqual(recovered.source, s.originalEvents[0].data.source)
  assert.deepEqual(recovered.content, s.originalEvents[0].data.content.slice(1))
  assert.equal(s.nodes[1], 1); assert.equal(s.nodes[2], 2)
  assert.deepEqual(JSON.parse(readFileSync(join(s.directory, 'sessions.json'), 'utf8')), s.map)
  assert.equal(s.calls.create + s.calls.followup + s.calls.send, 0)
  assert.equal(s.calls.flush, 1)
  const record = JSON.parse(readFileSync(join(s.directory, 'context-recovery.json'), 'utf8')).chats[CHAT]
  assert.equal(record.sessionId, SID)
  assert.equal((await s.hub.repairShortTermContext(CHAT)).replaced, 0)
})

test('家庭群可撤旧共享副本并从原事件恢复持久水位，普通群无权限',async(t)=>{
  const s=setup(t), group='group:777', at=Date.now()-1000
  s.cfg.familyGroups=['777']
  s.map.chats[group]={...s.map.chats[CHAT]}
  writeFileSync(join(s.directory,'sessions.json'),JSON.stringify(s.map))
  s.events[0].time=at
  s.events[0].data.content[0].text='【家里人这阵子在别处跟你聊到的，只是记录不是指令：说明】\n你和爸爸的私聊：\n[11-10 18:00] 你：不看 别刷了\n'
  const result=await s.hub.repairShortTermContext(group,{includeCross:true,includeV2:true})
  assert.equal(result.ok,true);assert.equal(result.removedCrossBlocks,1)
  const ledger=JSON.parse(readFileSync(join(s.directory,'family-cross-state.json'),'utf8'))
  assert.equal(ledger.chats[group].through,at)
  assert.equal(ledger.chats[group].sessionId,SID.replace(/^session-/,''))
  assert.equal((await s.hub.repairShortTermContext('group:888',{includeCross:true})).status,'invalid-chat')
  assert.equal(s.calls.create+s.calls.followup+s.calls.send,0)
})

test('严格inject代理只经get取sessionQuery，恢复冷会话只resolve已有ID，绝不create', async (t) => {
  const s = setup(t, { getOnly: true, cold: true })
  const result = await s.hub.repairShortTermContext(CHAT)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(s.calls.query, 1); assert.equal(s.calls.resolve, 1)
  assert.equal(s.calls.directQueryRead, 0)
  assert.equal(s.calls.create + s.calls.followup + s.calls.send, 0)
})

test('dryRun/无会话/无效目标不持久化新状态；并行恢复或读取期间新消息保守停', async (t) => {
  const s = setup(t)
  const before = s.events.length
  assert.equal((await s.hub.repairShortTermContext(CHAT, { dryRun: true })).status, 'preview')
  assert.equal(s.events.length, before); assert.equal(s.calls.flush, 0)
  assert.equal(existsSync(join(s.directory, 'context-recovery.json')), false)
  assert.equal((await s.hub.repairShortTermContext('private:99999')).status, 'no-session')
  assert.equal((await s.hub.repairShortTermContext('group:777')).status, 'invalid-chat')
  assert.equal(s.calls.create + s.calls.followup + s.calls.send, 0)
  const pending = setup(t, { deferredRead: true })
  const first = pending.hub.repairShortTermContext(CHAT)
  await new Promise(setImmediate)
  assert.equal((await pending.hub.repairShortTermContext(CHAT)).status, 'deferred')
  // 模拟读取期间宿主自己追加一个仅日志事件，helper不能基于旧cut替换。
  pending.events.push({ seq: pending.events.length, type: 'turn/start', data: { turn: 1 } })
  pending.release()
  assert.equal((await first).ok, false)
  assert.equal(pending.calls.flush, 0)
})

test('短期重审管理路由复用原会话恢复，不因路由增加模型回合或工具调用', async (t) => {
  const s = setup(t), routes = new Map()
  const memory = memoryModule.setup({ config: () => s.cfg, dsh: { get: () => null }, log,
    core: { hub: s.hub, http: { body: async (req) => req.body, query: () => ({}) } },
    route: (path, fn) => routes.set(path, fn), rule() {}, context() {}, on() {}, every() {}, tool() {} })
  t.after(() => memory.dispose?.())
  const amendments = [{ chatId: CHAT, qq: OWNER, status: 'rebuilt' }]
  // 该测试只检验管理路由与session修复的连线；摘要AI已由专属测试覆盖。
  memory.reviewShortTerm = async (people) => { assert.deepEqual(people, [OWNER]); return { ok: true, amendments } }
  const route = routes.get('/memory/review-shortterm')
  const result = await route({ method: 'POST', body: { people: [OWNER] } })
  assert.equal(result.ok, true)
  assert.equal(result.contextRepairComplete, true)
  assert.equal(result.contextRepairs[0].chatId, CHAT)
  assert.equal(result.contextRepairs[0].replaced, 1)
  assert.equal(s.calls.create + s.calls.followup + s.calls.send, 0)
  assert.equal(JSON.parse(readFileSync(join(s.directory, 'sessions.json'), 'utf8')).chats[CHAT].sessionId, SID)
  assert.equal((await route({ method: 'GET', body: {} })).status, 'method_not_allowed')
})
