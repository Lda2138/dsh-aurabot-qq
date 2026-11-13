// 双主人：coOwners 里的人和 ownerQQ 权限完全一样（白名单、权限档、工具、审批、危险命令确认、规则里的身份），
// 审批 / 危险命令在发起的那位主人私聊里问、只认那位的回复。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { normalize } = await import('../src/core/config.js')
const { checkAllowed, levelFor, isOwner, isOwnerChat, ownerQQs, ownerNameOf, profileToolVisible } = await import('../src/chat/access.js')
const { rulesText, ownersLine } = await import('../src/persona/personas.js')
const { createApprovalRelay } = await import('../src/security/approval.js')
const { createDangerGuard } = await import('../src/security/danger.js')
const { planWhitelist } = await import('../src/modules/contacts/index.js')

const DAD = '10001'
const MOM = '10002'
const BOT = '20002'
const cfgOf = (over = {}) => normalize({ ownerQQ: DAD, ownerName: '老爸', botQQ: BOT, coOwners: [{ qq: MOM, name: '老妈' }], ...over })

test('配置：coOwners 只留数字号码、去重、去掉和主人 / 机器人号相同的；空号码但有称呼的先留着', () => {
  const c = normalize({ ownerQQ: DAD, botQQ: BOT, coOwners: [{ qq: 'QQ 10002', name: ' 老妈 ' }, { qq: MOM }, { qq: DAD }, { qq: BOT }, { qq: '12' }, { qq: '', name: '小姨' }, { qq: '', name: '' }, 'x'] })
  assert.deepEqual(c.coOwners, [{ qq: MOM, name: '老妈' }, { qq: '', name: '小姨' }])
  assert.deepEqual(normalize({}).coOwners, [])
})

test('谁是主人：两位都算；空号码不算；名字各叫各的', () => {
  const c = cfgOf({ coOwners: [{ qq: MOM, name: '老妈' }, { qq: '', name: '小姨' }] })
  assert.deepEqual(ownerQQs(c), [DAD, MOM])
  assert.equal(isOwner(c, MOM), true)
  assert.equal(isOwner(c, ''), false)
  assert.equal(isOwner(c, '30003'), false)
  assert.equal(isOwnerChat(c, `private:${MOM}`), true)
  assert.equal(isOwnerChat(c, `group:${MOM}`), false)
  assert.equal(ownerNameOf(c, DAD), '老爸')
  assert.equal(ownerNameOf(c, MOM), '老妈')
  assert.equal(ownerNameOf(c, '30003'), '')
})

test('第二位主人：不用进白名单就能私聊，权限档和主人一样，「仅主人」的工具也给她', () => {
  const c = cfgOf({ ownerLevel: 'full' })
  const mom = { kind: 'private', userId: MOM, chatId: `private:${MOM}` }
  assert.equal(checkAllowed(c, mom).allowed, true)
  assert.equal(levelFor(c, mom), 'full')
  assert.equal(profileToolVisible(c, 'qqNickname', mom), true)
  assert.equal(levelFor(c, { kind: 'private', userId: '30003' }), 'social')
  assert.equal(checkAllowed(cfgOf({ coOwners: [] }), mom).allowed, false, '没设第二位主人时照旧')
})

test('白名单：第二位主人也不能被移出、本来就能私聊', () => {
  const c = cfgOf()
  assert.equal(planWhitelist(c, { action: 'remove', kind: 'private', id: MOM }).ok, false)
  assert.equal(planWhitelist(c, { action: 'add', kind: 'private', id: MOM }).changed, undefined)
})

test('规则：告诉她两位主人的号码和称呼；只有一位时和以前一样', () => {
  const line = ownersLine(cfgOf())
  assert.match(line, /10001 的人是你的老爸/)
  assert.match(line, /10002 的人是你的老妈/)
  assert.match(line, /权限一样/)
  assert.equal(ownersLine(cfgOf({ coOwners: [] })), 'QQ 号是 10001 的人是你的老爸。')
  assert.equal(ownersLine(cfgOf({ coOwners: [{ qq: '', name: '老妈' }] })), 'QQ 号是 10001 的人是你的老爸。', '没填号码不提')
  assert.match(rulesText('private', cfgOf()), /10002 的人是你的老妈/)
})

test('称呼没定：规则里提醒她去问，问定了用 qq_owner_title 记下，只在那位主人本人的私聊里能改', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { default: contacts } = await import('../src/modules/contacts/index.js')
  assert.match(ownersLine(cfgOf({ coOwners: [{ qq: MOM, name: '' }] })), /10002 的人也是你的主人（怎么称呼 ta 还没定）[\s\S]*qq_owner_title/)
  assert.doesNotMatch(ownersLine(cfgOf()), /qq_owner_title/)
  let config = cfgOf({ coOwners: [{ qq: MOM, name: '' }], dryRun: false })
  let allOwner = true
  const sent = []
  let builder
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-title-'))
  contacts.setup({
    core: { hub: { turnSendersAllOwner: () => allOwner }, onebot: { call: async () => null } },
    log: { warn() {}, info() {} }, config: () => config, setConfig: (fn) => { config = normalize(fn(config)) },
    dataDir: (...p) => join(dir, ...p), on() {}, tool: (b) => { builder = b }, sendText: async (c, t) => { sent.push({ c, t }) },
  })
  const tools = (chat) => Object.fromEntries(builder({ chat, sessionId: 's' }).map((t) => [t.name, t]))
  assert.equal(tools({ kind: 'private', userId: DAD, chatId: `private:${DAD}` }).qq_owner_title, undefined, '原来的主人没有')
  assert.equal(tools({ kind: 'private', userId: '30003', chatId: 'private:30003' }).qq_owner_title, undefined)
  const tool = tools({ kind: 'private', userId: MOM, chatId: `private:${MOM}` }).qq_owner_title
  allOwner = false
  assert.equal((await tool.execute({ title: '老妈' })).ok, false)
  allOwner = true
  assert.equal((await tool.execute({ title: '这个称呼实在是太长太长了吧' })).ok, false)
  assert.equal((await tool.execute({ title: ' 老妈 ' })).ok, true)
  assert.deepEqual(config.coOwners, [{ qq: MOM, name: '老妈' }])
  assert.match(sent.at(-1).t, /老妈/)
  assert.equal(sent.at(-1).c, `private:${DAD}`)
})

function relaySetup() {
  const sent = []
  const cfg = { enabled: true, dryRun: false, approvalViaQQ: true, ownerQQ: DAD, coOwners: [{ qq: MOM, name: '老妈' }] }
  const relay = createApprovalRelay({
    getConfig: () => cfg,
    deliver: async (chatId, text) => { sent.push({ chatId, text }) },
    chatOfSession: (id) => ({ dad: `private:${DAD}`, mom: `private:${MOM}`, other: 'private:30003' })[id] || '',
    timeoutMs: 60_000,
  })
  const req = (session, tool = 'bash') => ({ agent: { session: { id: session } }, toolName: tool, reason: 'r' })
  return { relay, sent, req }
}
const tick = () => new Promise((r) => setTimeout(r, 5))
const unavailable = async () => 'unavailable'

test('审批：妈妈私聊里的授权在妈妈那里问、只认妈妈的「确认」；两位各排各的队', async () => {
  const { relay, sent, req } = relaySetup()
  assert.equal(relay.handles('mom'), true)
  assert.equal(relay.handles('other'), false)
  const pd = relay.onRequest(req('dad', 'dad-tool'), unavailable)
  const pm = relay.onRequest(req('mom', 'mom-tool'), unavailable)
  await tick()
  assert.deepEqual(sent.map((x) => x.chatId), [`private:${DAD}`, `private:${MOM}`], '两边各问自己的，不用等对方')
  assert.equal(relay.handleReply(`private:${MOM}`, DAD, '确认'), false, '爸爸不能在妈妈的私聊里替她点')
  assert.equal(relay.handleReply(`private:${DAD}`, MOM, '确认'), false)
  assert.equal(relay.handleReply(`private:${MOM}`, MOM, '确认'), true)
  assert.equal(await pm, 'allowed-once')
  assert.equal(relay.pending(), 1)
  assert.equal(relay.handleReply(`private:${DAD}`, DAD, '取消'), true)
  assert.equal(await pd, 'rejected')
})

test('审批：同一位主人的第二条，等第一条答完再问', async () => {
  const { relay, sent, req } = relaySetup()
  const a = relay.onRequest(req('mom', 'one'), unavailable)
  const b = relay.onRequest(req('mom', 'two'), unavailable)
  await tick()
  assert.equal(sent.length, 1, '第二条先不问')
  relay.handleReply(`private:${MOM}`, MOM, '确认')
  assert.equal(await a, 'allowed-once')
  await tick()
  assert.ok(sent.some((x) => x.chatId === `private:${MOM}` && /【要授权】two/.test(x.text)))
  relay.handleReply(`private:${MOM}`, MOM, '取消')
  assert.equal(await b, 'rejected')
})

test('危险命令：妈妈私聊里发起的在妈妈那里问，只认妈妈的确认', async () => {
  const delivered = []
  const cfg = { security: { dangerConfirm: true }, coOwners: [{ qq: MOM, name: '老妈' }] }
  const guard = createDangerGuard({
    getConfig: () => cfg,
    deliver: async (chatId, text) => { delivered.push({ chatId, text }) },
    chatOfSession: (sid) => ({ mom: `private:${MOM}`, other: 'private:30003' })[sid] || '',
    ownerQQ: () => DAD,
    timeoutMs: 5000,
  })
  const exec = (sid) => ({ name: 'pwsh', arguments: { command: 'shutdown /s /t 0' }, agent: { session: { id: sid } } })
  assert.equal((await guard.preExecute(exec('other'), () => 'ran')).kind, 'deny')
  let ran = false
  const p = guard.preExecute(exec('mom'), () => { ran = true; return { kind: 'allow' } })
  await tick()
  assert.equal(delivered.at(-1).chatId, `private:${MOM}`)
  assert.equal(guard.handleReply(`private:${MOM}`, DAD, '确认'), false, '别人的回复不算')
  assert.equal(guard.handleReply(`private:${MOM}`, MOM, '确认'), true)
  await p
  assert.equal(ran, true)
})
