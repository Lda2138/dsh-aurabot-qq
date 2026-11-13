// 交友圈：记账、挑人邀请、自动通过、回顾后淡下来、被删检测、试运行和开关。用假 api / 假 OneBot 测。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { default: circle, activeFriends, listCandidates, canInvite, parsePick, parseReview, emptyState } = await import('../src/modules/circle/index.js')
const { normalize } = await import('../src/core/config.js')

const OWNER = '10001'
const BOT = '20002'
const G = '555'
const DAY = 86400000
const NOON = Date.parse('2026-11-09T12:00:00')

function setup({ cfg = {}, friends = [], think = null, pick = '{"pick": "30003", "reason": "聊游戏很投缘"}', keep = '{"keep": true, "reason": "聊得挺好"}', failAccept = false } = {}) {
  let config = normalize({ enabled: true, dryRun: false, ownerQQ: OWNER, botQQ: BOT, allow: { private: [], groups: [G] }, circle: { enabled: true }, ...cfg })
  const calls = []
  const sent = []
  const pushes = []
  const thinks = []
  const laters = []
  const listeners = {}
  let builder
  const friendSet = new Set(friends)
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-circle-'))
  const api = {
    core: {
      hub: {
        turnSendersAllOwner: () => true,
        groupName: (g) => (g === G ? '游戏群' : g),
        pushToSession: async (chat, content) => { pushes.push({ chat, text: content[0].text }) },
      },
      onebot: {
        call: async (action, params) => {
          calls.push({ action, params })
          if (action === 'get_friend_list') return [...friendSet].map((u) => ({ user_id: Number(u) }))
          if (action === 'set_friend_add_request' && failAccept) throw new Error('retcode 1200')
          return null
        },
      },
      mutes: { muted: () => false },
    },
    log: { warn() {}, info() {}, debug() {} },
    config: () => config,
    setConfig: (fn) => { config = normalize(fn(config)) },
    dataDir: (...p) => join(dir, ...p),
    on: (name, fn) => { listeners[name] = fn },
    tool: (b) => { builder = b },
    rule: () => {},
    every: () => {},
    later: (ms, fn) => { laters.push(fn) },
    use: () => null,
    think: async (prompt) => { thinks.push(prompt); if (think) return think(prompt); return prompt.includes('回顾') ? keep : pick },
    sendText: async (chatId, text) => { sent.push({ chatId, text }) },
  }
  const mod = circle.setup(api)
  const say = (qq, { group = true, direct = true, at = Date.now() } = {}) => {
    const real = Date.now
    Date.now = () => at
    try { listeners.activity({ kind: 'in', chatId: group ? `group:${G}` : `private:${qq}`, userId: qq, nickname: `友${qq}`, text: 'hi', direct, owner: qq === OWNER }) } finally { Date.now = real }
  }
  const out = (chatId, reply, at = Date.now()) => {
    const real = Date.now
    Date.now = () => at
    try { listeners.activity({ kind: 'out', chatId, reply }) } finally { Date.now = real }
  }
  const tools = (chat) => Object.fromEntries(builder({ chat, sessionId: 's1' }).map((t) => [t.name, t]))
  return {
    mod, calls, sent, pushes, thinks, laters, friendSet, say, out, tools,
    event: (ev) => listeners.onebot(ev),
    cfg: () => config,
    set: (patch) => { config = normalize({ ...config, ...patch }) },
  }
}

/** 让某人在两天里各找她 n 次 */
function chatty(t, qq, n = 2, at = NOON) {
  for (let i = 0; i < n; i++) { t.say(qq, { at: at - DAY }); t.say(qq, { at }) }
}

test('配置：默认关、5~7 个；max 不小于 min', () => {
  assert.deepEqual(normalize({}).circle, { enabled: false, min: 5, max: 7, autoAccept: true, minHits: 2, groupCooldownDays: 7, reviewDays: 3 })
  assert.equal(normalize({ circle: { min: 9, max: 3 } }).circle.max, 9)
})

test('记账：群里直接找她才算；不是对她说的、主人说的不算', () => {
  const t = setup()
  t.say('30003', { at: NOON })
  t.say('30004', { direct: false, at: NOON })
  t.say(OWNER, { at: NOON })
  const s = t.mod.state()
  assert.equal(s.people['30003'].hits.length, 1)
  assert.equal(s.people['30003'].groupId, G)
  assert.equal(s.people['30004']?.hits?.length || 0, 0)
  assert.equal(s.people[OWNER], undefined)
})

test('关着不记账、不跑', async () => {
  const t = setup({ cfg: { circle: { enabled: false } } })
  t.say('30003', { at: NOON })
  assert.deepEqual(t.mod.state().people, {})
  assert.equal(await t.mod.tick(NOON, { force: true }), null)
})

test('活跃朋友：14 天内私聊找过 / 刚加上 3 天内；淡下来、被删、主人不算', () => {
  const cfg = normalize({ ownerQQ: OWNER, botQQ: BOT })
  const s = emptyState()
  s.people.a = { status: 'none', privIn: [NOON - DAY] }
  s.people.b = { status: 'friend', addedAt: NOON - DAY, privIn: [] }
  s.people.c = { status: 'friend', addedAt: NOON - 10 * DAY, privIn: [NOON - 20 * DAY] }
  s.people.d = { status: 'faded', privIn: [NOON] }
  s.people.e = { status: 'gone', privIn: [NOON] }
  s.people[OWNER] = { status: 'none', privIn: [NOON] }
  assert.deepEqual(activeFriends(s, cfg, NOON).sort(), ['a', 'b'])
})

test('候选名单：够门槛、群在白名单、群冷却过了、不是好友；按来往多少排', () => {
  const cfg = normalize({ ownerQQ: OWNER, botQQ: BOT, allow: { groups: [G] }, circle: { enabled: true, minHits: 2 } })
  const s = emptyState()
  s.people.a = { status: 'none', groupId: G, hits: [NOON] }
  s.people.b = { status: 'none', groupId: G, hits: [NOON, NOON - DAY] }
  s.people.c = { status: 'none', groupId: G, hits: [NOON, NOON - DAY, NOON - 2] }
  s.people.d = { status: 'none', groupId: '999', hits: [NOON, NOON - 1, NOON - 2] }
  s.people.e = { status: 'none', groupId: G, hits: [NOON, NOON - 1], cooldownUntil: NOON + DAY }
  assert.deepEqual(listCandidates(s, cfg, NOON).map((x) => x.qq), ['c', 'b'])
  assert.deepEqual(listCandidates(s, cfg, NOON, { friends: new Set(['c']) }).map((x) => x.qq), ['b'])
  s.groupAskedAt[G] = NOON - 2 * DAY
  assert.deepEqual(listCandidates(s, cfg, NOON), [], '一周内这个群邀请过人')
})

test('防骚扰上限 canInvite：只管上限，不管该不该', () => {
  const cfg = normalize({ ownerQQ: OWNER, botQQ: BOT, allow: { groups: [G] }, circle: { enabled: true, min: 1, max: 2 } })
  const s = emptyState()
  assert.equal(canInvite(s, cfg, { qq: '30003', groupId: G }, NOON).ok, true)
  assert.equal(canInvite(s, cfg, { qq: '30003', groupId: '999' }, NOON).ok, false, '不在群白名单')
  assert.equal(canInvite(s, cfg, { qq: OWNER, groupId: G }, NOON).ok, false)
  assert.equal(canInvite(s, cfg, { qq: '30003', groupId: G }, NOON, { friends: new Set(['30003']) }).ok, false)
  s.people.x = { status: 'none', privIn: [NOON] }
  s.people.y = { status: 'invited' }
  assert.match(canInvite(s, cfg, { qq: '30003', groupId: G }, NOON).message, /够多/)
  delete s.people.y
  s.groupAskedAt[G] = NOON - DAY
  assert.match(canInvite(s, cfg, { qq: '30003', groupId: G }, NOON).message, /最近邀请过/)
})

test('挑人交给她：活跃不够时把名单给她看，她挑中谁就提醒她去那个群邀请', async () => {
  const t = setup()
  chatty(t, '30003')
  chatty(t, '30004', 1)
  const r = await t.mod.tick(NOON, { force: true })
  assert.equal(r.invited, '30003')
  const ask = t.thinks.find((x) => x.includes('还不是好友的人'))
  assert.match(ask, /30003/)
  assert.match(ask, /30004/)
  assert.match(ask, /宁缺毋滥/)
  assert.equal(t.pushes.length, 1)
  assert.equal(t.pushes[0].chat.chatId, `group:${G}`)
  assert.match(t.pushes[0].text, /聊游戏很投缘/)
  assert.match(t.pushes[0].text, /qq_invite_friend/)
  assert.match(t.pushes[0].text, /\[沉默\]/)
  // 没被挑中的人过两天再给她看
  assert.ok(t.mod.state().people['30004'].cooldownUntil >= NOON + 2 * DAY)
  // 只是提醒，没登记前不算邀请
  assert.equal(t.mod.expects('30003'), false)
})

test('她谁都不想加：不提醒、不邀请，名单里的人过两天再说', async () => {
  const t = setup({ pick: '{"pick": "none", "reason": "都不太熟"}' })
  chatty(t, '30003')
  const r = await t.mod.tick(NOON, { force: true })
  assert.equal(r.invited, null)
  assert.equal(t.pushes.length, 0)
  assert.ok(t.mod.state().people['30003'].cooldownUntil > NOON)
  const odd = setup({ pick: '{"pick": "88888"}' })
  chatty(odd, '30003')
  assert.equal((await odd.mod.tick(NOON, { force: true })).invited, null, '挑了名单外的号不算')
})

test('邀请：她登记后对方来加 → 自动通过、加白名单、告诉主人、去打招呼；平时聊着也能自己邀请（不用在名单里）', async () => {
  const t = setup()
  t.say('30003', { at: NOON }) // 只聊过一次，不在候选名单，但她自己想邀请
  const tool = t.tools(groupChat).qq_invite_friend
  assert.ok(tool)
  assert.equal(t.tools({ kind: 'private', userId: '40004', chatId: 'private:40004' }).qq_invite_friend, undefined, '只在群里有')
  const r = await tool.execute({ qq: '30003', reason: '聊游戏很投缘' })
  assert.equal(r.ok, true)
  assert.equal(t.mod.expects('30003'), true)
  const again = await tool.execute({ qq: '30004', reason: '也想加' })
  assert.equal(again.ok, false, '同一个群一周内只邀请一个')
  t.event({ post_type: 'request', request_type: 'friend', user_id: 30003, flag: 'f1' })
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(t.calls.filter((c) => c.action === 'set_friend_add_request'), [{ action: 'set_friend_add_request', params: { flag: 'f1', approve: true } }])
  assert.ok(t.cfg().allow.private.includes('30003'))
  assert.ok(t.cfg().speakUp.allow.includes('30003'))
  assert.equal(t.mod.state().people['30003'].status, 'friend')
  assert.match(t.sent.at(-1).text, /新朋友/)
  assert.match(t.sent.at(-1).text, /游戏群/)
  await t.laters[0]()
  assert.equal(t.pushes.at(-1).chat.chatId, 'private:30003')
  assert.match(t.pushes.at(-1).text, /打个招呼/)
})

test('邀请了 3 天没来加：作罢，30 天内不能再邀请；没登记的人来加照常交给主人', async () => {
  const t = setup()
  const tool = t.tools(groupChat).qq_invite_friend
  const now = Date.now()
  assert.equal((await tool.execute({ qq: '30003', reason: '投缘' })).ok, true)
  await t.mod.tick(now + 4 * DAY, { force: true })
  assert.equal(t.mod.state().people['30003'].status, 'none')
  assert.equal(t.mod.expects('30003'), false)
  t.event({ post_type: 'request', request_type: 'friend', user_id: 40004, flag: 'f2' })
  await new Promise((r) => setImmediate(r))
  assert.equal(t.calls.filter((c) => c.action === 'set_friend_add_request').length, 0)
})

test('活跃朋友够了就不挑人', async () => {
  const t = setup({ cfg: { circle: { enabled: true, min: 1, max: 2 } } })
  t.say('40004', { group: false, at: NOON })
  chatty(t, '30003')
  assert.equal((await t.mod.tick(NOON, { force: true })).invited, null)
  assert.ok(!t.thinks.some((x) => x.includes('还不是好友的人')))
})

test('试运行：登记只回话，不会自动通过，申请照常交给主人', async () => {
  const t = setup({ cfg: { dryRun: true } })
  const r = await t.tools(groupChat).qq_invite_friend.execute({ qq: '30003', reason: '投缘' })
  assert.match(r.message, /试运行/)
  assert.equal(t.mod.expects('30003'), false)
  t.event({ post_type: 'request', request_type: 'friend', user_id: 30003, flag: 'f1' })
  await new Promise((r) => setImmediate(r))
  assert.equal(t.calls.filter((c) => c.action === 'set_friend_add_request').length, 0)
})

test('自动通过失败：告诉主人，不加白名单', async () => {
  const t = setup({ failAccept: true })
  await t.tools(groupChat).qq_invite_friend.execute({ qq: '30003', reason: '投缘' })
  t.event({ post_type: 'request', request_type: 'friend', user_id: 30003, flag: 'f1' })
  await new Promise((r) => setImmediate(r))
  assert.match(t.sent.at(-1).text, /没通过成功/)
  assert.ok(!t.cfg().allow.private.includes('30003'))
})

const groupChat = { kind: 'group', userId: '30003', groupId: G, chatId: `group:${G}` }

async function befriend(t, qq = '30003') {
  chatty(t, qq)
  const r = await t.tools(groupChat).qq_invite_friend.execute({ qq, reason: '投缘' })
  assert.equal(r.ok, true, r.message)
  t.friendSet.add(qq)
  t.event({ post_type: 'request', request_type: 'friend', user_id: Number(qq), flag: 'f' + qq })
  await new Promise((r) => setImmediate(r))
}

test('回顾：她说继续就留着；说不继续就淡下来——移出主动搭话、不占名额、告诉主人，私聊白名单保留', async () => {
  const t = setup({ keep: '想了想……{"keep": false, "reason": "总是敷衍我"}', pick: '{"pick": "none"}' })
  await befriend(t)
  const addedAt = t.mod.state().people['30003'].addedAt
  const r = await t.mod.tick(addedAt + 3 * DAY + 1000, { force: true })
  assert.deepEqual(r.reviewed, { qq: '30003', keep: false })
  assert.ok(t.thinks.some((x) => x.includes('回顾')))
  assert.equal(t.mod.state().people['30003'].status, 'faded')
  assert.ok(!t.cfg().speakUp.allow.includes('30003'))
  assert.ok(t.cfg().allow.private.includes('30003'))
  assert.match(t.sent.at(-1).text, /总是敷衍我/)
  const k = setup({ pick: '{"pick": "none"}' })
  await befriend(k)
  const at = k.mod.state().people['30003'].addedAt
  assert.deepEqual((await k.mod.tick(at + 3 * DAY + 1000, { force: true })).reviewed, { qq: '30003', keep: true })
  assert.equal(k.mod.state().people['30003'].status, 'friend')
  assert.equal((await k.mod.tick(at + 3 * DAY + 2000, { force: true })).reviewed, null, '回顾过的不马上再回顾')
})

test('聊天里她自己决定淡下来：工具只在和这位朋友的私聊里有', async () => {
  const t = setup({ pick: '{"pick": "none"}' })
  await befriend(t)
  assert.equal(t.tools({ kind: 'private', userId: '40004', chatId: 'private:40004' }).qq_friendship, undefined)
  assert.equal(t.tools({ kind: 'group', userId: '30003', groupId: G }).qq_friendship, undefined)
  const tool = t.tools({ kind: 'private', userId: '30003', chatId: 'private:30003' }).qq_friendship
  assert.equal((await tool.execute({ reason: '老说难听的话' })).ok, true)
  assert.equal(t.mod.state().people['30003'].status, 'faded')
})

test('被删了：好友列表里没了就记下、移出白名单、告诉主人；刚加上的不误判；不能再邀请', async () => {
  const t = setup({ pick: '{"pick": "none"}' })
  await befriend(t)
  const addedAt = t.mod.state().people['30003'].addedAt
  t.friendSet.delete('30003')
  await t.mod.tick(addedAt + 60000, { force: true })
  assert.equal(t.mod.state().people['30003'].status, 'friend', '10 分钟内不判')
  await t.mod.tick(addedAt + 20 * 60000, { force: true })
  assert.equal(t.mod.state().people['30003'].status, 'gone')
  assert.ok(!t.cfg().allow.private.includes('30003'))
  assert.ok(!t.cfg().speakUp.allow.includes('30003'))
  assert.match(t.sent.at(-1).text, /把我删了/)
  const status = await t.tools({ kind: 'private', userId: OWNER, chatId: `private:${OWNER}` }).qq_circle_status.execute({})
  assert.match(status.message, /把你删了的：友30003/)
  const again = await t.tools(groupChat).qq_invite_friend.execute({ qq: '30003', reason: '再试试' })
  assert.equal(again.ok, false)
  assert.match(again.message, /删了/)
})

test('parsePick', () => {
  assert.deepEqual(parsePick('{"pick": "30003", "reason": "投缘"}'), { pick: '30003', reason: '投缘' })
  assert.deepEqual(parsePick('{"pick": "none", "reason": "都一般"}'), { pick: null, reason: '都一般' })
  assert.equal(parsePick('嗯……'), null)
})

test('parseReview', () => {
  assert.deepEqual(parseReview('{"keep": true, "reason": "好"}'), { keep: true, reason: '好' })
  assert.equal(parseReview('不知道'), null)
  assert.equal(parseReview('{"keep": "yes"}'), null)
})
