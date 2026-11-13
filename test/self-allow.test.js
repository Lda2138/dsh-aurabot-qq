// 自己管白名单：新好友她判断要不要私聊、群邀请她决定去不去、进群旁听后决定开不开口、自己移出、被踢清理、试运行和开关。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { default: selfAllow, parseDecision, sampleOf } = await import('../src/modules/self-allow/index.js')
const { default: contacts } = await import('../src/modules/contacts/index.js')
const { normalize } = await import('../src/core/config.js')

const OWNER = '10001'
const BOT = '20002'
const HOUR = 3600000

function setup({ cfg = {}, answers = {}, friends = [], groups = [], failCall = '' } = {}) {
  let config = normalize({ enabled: true, dryRun: false, ownerQQ: OWNER, botQQ: BOT, selfAllow: { enabled: true, observeHours: 24 }, ...cfg })
  const calls = []
  const sent = []
  const thinks = []
  const listeners = {}
  let builder
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-selfallow-'))
  const api = {
    core: {
      hub: { turnSendersAllOwner: () => true },
      onebot: {
        call: async (action, params) => {
          calls.push({ action, params })
          if (action === failCall) throw new Error('retcode 1200')
          if (action === 'get_friend_list') return friends.map((u) => ({ user_id: Number(u) }))
          if (action === 'get_group_list') return groups.map((g) => ({ group_id: Number(g), group_name: '群' + g }))
          if (action === 'get_stranger_info') return { nickname: '小鹿' }
          if (action === 'get_group_info') return { group_name: '画画群', member_count: 30 }
          return null
        },
      },
    },
    log: { warn() {}, info() {}, debug() {} },
    config: () => config,
    setConfig: (fn) => { config = normalize(fn(config)) },
    dataDir: (...p) => join(dir, ...p),
    on: (name, fn) => { listeners[name] = fn },
    tool: (b) => { builder = b },
    rule: () => {},
    every: () => {},
    use: () => null,
    think: async (prompt) => {
      thinks.push(prompt)
      for (const [k, v] of Object.entries(answers)) if (prompt.includes(k)) return v
      return ''
    },
    sendText: async (chatId, text) => { sent.push({ chatId, text }) },
  }
  const mod = selfAllow.setup(api)
  const tools = (chat) => Object.fromEntries((builder({ chat, sessionId: 's1' }) || []).map((t) => [t.name, t]))
  return { mod, calls, sent, thinks, tools, event: (ev) => listeners.onebot(ev), cfg: () => config }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

test('配置：默认关、旁听 24 小时', () => {
  assert.deepEqual(normalize({}).selfAllow, { enabled: false, observeHours: 24 })
  assert.equal(normalize({ selfAllow: { observeHours: 0 } }).selfAllow.observeHours, 1)
})

test('新好友：她答应就加进私聊白名单并告诉主人；不答应不加，也告诉主人', async () => {
  const t = setup({ answers: { 现在是你的: '{"allow": true, "reason": "聊得来"}' } })
  t.event({ post_type: 'notice', notice_type: 'friend_add', user_id: 30003 })
  const r = await t.mod.tick(Date.now())
  assert.equal(r.person, '30003')
  assert.match(t.thinks[0], /小鹿/)
  assert.deepEqual(t.cfg().allow.private, ['30003'])
  assert.match(t.sent.at(-1).text, /加进私聊白名单/)
  const n = setup({ answers: { 现在是你的: '{"allow": false, "reason": "不认识"}' } })
  n.event({ post_type: 'notice', notice_type: 'friend_add', user_id: 30003 })
  await n.mod.tick(Date.now())
  assert.deepEqual(n.cfg().allow.private, [])
  assert.match(n.sent.at(-1).text, /先不和 ta 私聊/)
  assert.equal(n.mod.state().people['30003'].decided, 'deny')
})

test('已有的好友：扫一遍挨个想；已在名单的、主人不问；不答应的 30 天内不再问', async () => {
  const t = setup({ friends: ['30003', '30004', OWNER], cfg: { allow: { private: ['30004'], groups: [] } }, answers: { 现在是你的: '{"allow": false, "reason": "不熟"}' } })
  const now = Date.now()
  const asked = () => t.thinks.filter((x) => x.includes('现在是你的'))
  await t.mod.tick(now, { force: true })
  assert.equal(asked().length, 1)
  assert.match(asked()[0], /30003/)
  await t.mod.tick(now + 1000, { force: true })
  await t.mod.tick(now + 2000, { force: true })
  assert.equal(asked().length, 1, '刚拒绝过，不再问')
  await t.mod.tick(now + 31 * 24 * HOUR, { force: true })
  assert.equal(asked().length, 2, '30 天后再想一次')
})

test('主动找谁：答应私聊时一并决定；答应主动找就加进主动搭话白名单', async () => {
  const t = setup({ answers: { 现在是你的: '{"allow": true, "reach": true, "reason": "很投缘"}' } })
  t.event({ post_type: 'notice', notice_type: 'friend_add', user_id: 30003 })
  await t.mod.tick(Date.now())
  assert.match(t.thinks[0], /主动去找 ta/)
  assert.deepEqual(t.cfg().allow.private, ['30003'])
  assert.deepEqual(t.cfg().speakUp.allow, ['30003'])
  assert.match(t.sent.at(-1).text, /主动找 ta 聊/)
  const n = setup({ answers: { 现在是你的: '{"allow": false, "reach": true, "reason": "不熟"}' } })
  n.event({ post_type: 'notice', notice_type: 'friend_add', user_id: 30003 })
  await n.mod.tick(Date.now())
  assert.deepEqual(n.cfg().speakUp.allow, [], '不让私聊就不会主动找')
})

test('主动找谁：已在私聊名单、还没想过的人挨个想；不想的 30 天后再想；已在主动名单的不问', async () => {
  const t = setup({ cfg: { allow: { private: ['30003', '30004', OWNER], groups: [] }, speakUp: { allow: ['30004'] } }, answers: { 主动去找: '{"reach": false, "reason": "怕打扰"}' } })
  const now = Date.now()
  const asked = () => t.thinks.filter((x) => x.includes('在你的私聊名单里'))
  await t.mod.tick(now, { force: true })
  assert.equal(asked().length, 1)
  assert.match(asked()[0], /30003/)
  await t.mod.tick(now + 1000, { force: true })
  assert.equal(asked().length, 1, '不想的先不再问；30004 已在主动名单、主人不问')
  assert.deepEqual(t.cfg().speakUp.allow, ['30004'])
  await t.mod.tick(now + 31 * 24 * HOUR, { force: true })
  assert.equal(asked().length, 2)
  const y = setup({ cfg: { allow: { private: ['30003'], groups: [] } }, answers: { 主动去找: '{"reach": true, "reason": "想常聊"}' } })
  await y.mod.tick(now, { force: true })
  assert.deepEqual(y.cfg().speakUp.allow, ['30003'])
  assert.match(y.sent.at(-1).text, /主动找/)
})

test('主动找谁：聊着聊着用 qq_reach_out 改主意；移出私聊白名单时也不再主动找', async () => {
  const t = setup({ cfg: { allow: { private: ['30003'], groups: [] } } })
  const pm = { kind: 'private', userId: '30003', chatId: 'private:30003' }
  assert.equal(t.tools({ kind: 'group', groupId: '777', chatId: 'group:777' }).qq_reach_out, undefined, '群里没有')
  assert.equal((await t.tools(pm).qq_reach_out.execute({ want: true, reason: '很投缘' })).ok, true)
  assert.deepEqual(t.cfg().speakUp.allow, ['30003'])
  assert.match(t.sent.at(-1).text, /很投缘/)
  assert.equal((await t.tools(pm).qq_reach_out.execute({ want: 'yes', reason: 'x' })).ok, false)
  await t.tools(pm).qq_leave_whitelist.execute({ reason: '骚扰我' })
  assert.deepEqual(t.cfg().speakUp.allow, [])
  assert.deepEqual(t.cfg().allow.private, [])
})

test('她没想清楚（读不懂回答）：不改名单、不打扰主人', async () => {
  const t = setup({ answers: { 现在是你的: '嗯……' } })
  t.event({ post_type: 'notice', notice_type: 'friend_add', user_id: 30003 })
  await t.mod.tick(Date.now())
  assert.deepEqual(t.cfg().allow.private, [])
  assert.equal(t.sent.length, 0)
})

test('群邀请：她决定去 → 通过邀请、开始旁听、告诉主人；不去 → 拒绝', async () => {
  const t = setup({ cfg: { allow: { private: ['30003'], groups: [] } }, answers: { 邀请你进: '{"join": true, "reason": "画画我喜欢"}' } })
  t.event({ post_type: 'request', request_type: 'group', sub_type: 'invite', group_id: 777, user_id: 30003, flag: 'g1' })
  await flush(); await flush()
  assert.match(t.thinks[0], /私聊白名单里的朋友/)
  assert.match(t.thinks[0], /画画群/)
  assert.deepEqual(t.calls.find((c) => c.action === 'set_group_add_request').params, { flag: 'g1', sub_type: 'invite', approve: true })
  assert.equal(t.mod.state().groups['777'].status, 'observing')
  assert.deepEqual(t.cfg().allow.groups, [], '进群了也先不说话')
  assert.match(t.sent.at(-1).text, /旁听/)
  const n = setup({ answers: { 邀请你进: '{"join": false, "reason": "不认识"}' } })
  n.event({ post_type: 'request', request_type: 'group', sub_type: 'invite', group_id: 777, user_id: 40004, flag: 'g2' })
  await flush(); await flush()
  assert.equal(n.calls.find((c) => c.action === 'set_group_add_request').params.approve, false)
  assert.match(n.sent.at(-1).text, /拒绝了/)
})

test('群邀请交给她时，好友申请模块不再存、不再问主人；关了 / 试运行时照旧', () => {
  const run = (cfgPatch, handles) => {
    const sent = []
    const dir = mkdtempSync(join(tmpdir(), 'aurabot-c-'))
    let builderListener
    const config = normalize({ ownerQQ: OWNER, botQQ: BOT, ...cfgPatch })
    contacts.setup({
      core: { hub: { turnSendersAllOwner: () => true }, onebot: { call: async () => null } },
      log: { warn() {}, info() {} }, config: () => config, setConfig() {}, dataDir: (...p) => join(dir, ...p),
      on: (n, fn) => { builderListener = fn }, tool() {}, sendText: async (c, x) => { sent.push(x) },
      use: (id) => (id === 'self-allow' ? { handlesGroupInvites: () => handles } : null),
    })
    builderListener({ post_type: 'request', request_type: 'group', sub_type: 'invite', group_id: 777, user_id: 40004, flag: 'g1' })
    return sent.length
  }
  assert.equal(run({}, true), 0)
  assert.equal(run({}, false), 1)
})

test('旁听：收原始群消息做样本，到时间后她决定开口就加进群白名单；不开口就安静', async () => {
  const t = setup({ answers: { 旁听了: '{"speak": true, "reason": "大家很友好"}' } })
  const now = Date.now()
  t.event({ post_type: 'notice', notice_type: 'group_increase', group_id: 777, user_id: Number(BOT) })
  t.event({ post_type: 'message', message_type: 'group', group_id: 777, user_id: 50005, sender: { card: '阿木' }, message: [{ type: 'text', data: { text: '今天画了只猫' } }] })
  t.event({ post_type: 'message', message_type: 'group', group_id: 777, user_id: Number(BOT), message: [{ type: 'text', data: { text: '她自己的不算' } }] })
  t.event({ post_type: 'message', message_type: 'group', group_id: 888, user_id: 50005, message: [{ type: 'text', data: { text: '别的群不记' } }] })
  assert.equal(t.mod.state().groups['777'].count, 1)
  assert.equal(await t.mod.tick(now + HOUR), null, '旁听时间没到')
  const r = await t.mod.tick(now + 25 * HOUR)
  assert.equal(r.group, '777')
  const ask = t.thinks.find((x) => x.includes('旁听了'))
  assert.match(ask, /阿木：今天画了只猫/)
  assert.deepEqual(t.cfg().allow.groups, ['777'])
  assert.match(t.sent.at(-1).text, /群白名单/)
  const q = setup({ answers: { 旁听了: '{"speak": false, "reason": "全是广告"}' } })
  q.event({ post_type: 'notice', notice_type: 'group_increase', group_id: 777, user_id: Number(BOT) })
  await q.mod.tick(now + 25 * HOUR)
  assert.deepEqual(q.cfg().allow.groups, [])
  assert.equal(q.mod.state().groups['777'].status, 'quiet')
})

test('扫描：在的群不在名单里就开始旁听；被踢出群就从名单里拿掉', async () => {
  const t = setup({ groups: ['777'], cfg: { allow: { private: [], groups: ['999'] } } })
  await t.mod.tick(Date.now(), { force: true })
  assert.equal(t.mod.state().groups['777'].status, 'observing')
  t.event({ post_type: 'notice', notice_type: 'group_decrease', sub_type: 'kick_me', group_id: 999, user_id: Number(BOT) })
  assert.deepEqual(t.cfg().allow.groups, [])
  assert.match(t.sent.at(-1).text, /被踢出/)
})

test('她自己移出：私聊里移出对方、群里移出这个群；主人私聊没有这个工具', async () => {
  const t = setup({ cfg: { allow: { private: ['30003'], groups: ['777'] } } })
  assert.equal(t.tools({ kind: 'private', userId: OWNER, chatId: `private:${OWNER}` }).qq_leave_whitelist, undefined)
  const p = await t.tools({ kind: 'private', userId: '30003', chatId: 'private:30003' }).qq_leave_whitelist.execute({ reason: '一直骚扰我' })
  assert.equal(p.ok, true)
  assert.deepEqual(t.cfg().allow.private, [])
  assert.match(t.sent.at(-1).text, /一直骚扰我/)
  assert.equal((await t.tools({ kind: 'group', userId: '50005', groupId: '777', chatId: 'group:777' }).qq_leave_whitelist.execute({ reason: '全是广告' })).ok, true)
  assert.deepEqual(t.cfg().allow.groups, [])
  assert.equal(t.mod.state().groups['777'].status, 'quiet')
})

test('试运行：她照常想，但不改名单、不处理群邀请', async () => {
  const t = setup({ cfg: { dryRun: true }, answers: { 现在是你的: '{"allow": true, "reason": "好"}' } })
  assert.equal(t.mod.handlesGroupInvites(), false)
  t.event({ post_type: 'notice', notice_type: 'friend_add', user_id: 30003 })
  await t.mod.tick(Date.now())
  assert.deepEqual(t.cfg().allow.private, [])
  t.event({ post_type: 'request', request_type: 'group', sub_type: 'invite', group_id: 777, user_id: OWNER, flag: 'g1' })
  await flush()
  assert.equal(t.calls.filter((c) => c.action === 'set_group_add_request').length, 0)
  const r = await t.tools({ kind: 'group', groupId: '777', chatId: 'group:777' }).qq_leave_whitelist.execute({ reason: 'x' })
  assert.match(r.message, /试运行/)
})

test('关着：什么都不做，也没有工具', async () => {
  const t = setup({ cfg: { selfAllow: { enabled: false } } })
  t.event({ post_type: 'notice', notice_type: 'friend_add', user_id: 30003 })
  assert.equal(await t.mod.tick(Date.now(), { force: true }), null)
  assert.deepEqual(t.tools({ kind: 'group', groupId: '777', chatId: 'group:777' }), {})
  assert.equal(t.mod.handlesGroupInvites(), false)
})

test('parseDecision / sampleOf', () => {
  assert.deepEqual(parseDecision('想了想 {"speak": true, "reason": "好"}', 'speak'), { yes: true, reach: false, reason: '好' })
  assert.equal(parseDecision('{"speak": "yes"}', 'speak'), null)
  assert.equal(parseDecision('{"other": true} {"join": false}', 'join').yes, false)
  assert.equal(sampleOf({ sender: { nickname: 'A' }, message: [{ type: 'text', data: { text: '你好' } }, { type: 'image' }] }), 'A：你好[图片]')
  assert.equal(sampleOf({ sender: { nickname: 'A' }, raw_message: '[CQ:at,qq=1] 嗨' }), 'A：嗨')
  assert.equal(sampleOf({ message: [] }), '')
})

test('主人邀请进群：她不再自己琢磨（交给好友申请模块直接进），旁听中的群进了白名单就不再旁听', async () => {
  const t = setup({ answers: { 邀请你进: '{"join": false, "reason": "x"}', 旁听了: '{"speak": false, "reason": "x"}' } })
  t.event({ post_type: 'request', request_type: 'group', sub_type: 'invite', group_id: 777, user_id: Number(OWNER), flag: 'g1' })
  await flush(); await flush()
  assert.equal(t.thinks.length, 0)
  assert.equal(t.calls.filter((c) => c.action === 'set_group_add_request').length, 0)
  const now = Date.now()
  t.event({ post_type: 'notice', notice_type: 'group_increase', group_id: 888, user_id: Number(BOT) })
  t.event({ post_type: 'notice', notice_type: 'group_increase', group_id: 999, user_id: Number(BOT) })
  // 888 旁听期间被加进了白名单
  const s = t.mod.state()
  assert.equal(s.groups['888'].status, 'observing')
  t.cfg().allow.groups.push('888')
  await t.mod.tick(now + 25 * HOUR)
  assert.equal(t.mod.state().groups['888'].status, 'speak')
  assert.ok(!t.thinks.some((x) => x.includes('888')), '已在白名单的群不用再问她')
})
