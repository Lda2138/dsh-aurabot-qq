// 想交新朋友 / 想进新群：她不能主动加，只能私聊问主人。次数上限、不重复问、「算了」后不再提、加上后自动完成、试运行不发。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { default: contacts, planWish, wishText } = await import('../src/modules/contacts/index.js')
const { normalize } = await import('../src/core/config.js')

const OWNER = '10001'
const BOT = '20002'
const ownerPm = { kind: 'private', userId: OWNER, chatId: `private:${OWNER}` }
const otherPm = { kind: 'private', userId: '30003', chatId: 'private:30003' }
const group = { kind: 'group', userId: '30003', groupId: '555', chatId: 'group:555' }

function setup({ cfg = {}, allOwner = true, friends = [], groups = [], sendFails = false } = {}) {
  let config = normalize({ ownerQQ: OWNER, botQQ: BOT, dryRun: false, ...cfg })
  const calls = []
  const sent = []
  const listeners = {}
  let builder
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-wish-'))
  const api = {
    core: {
      hub: { turnSendersAllOwner: () => allOwner },
      onebot: {
        call: async (action, params) => {
          calls.push({ action, params })
          if (action === 'get_friend_list') return friends.map((u) => ({ user_id: Number(u) }))
          if (action === 'get_group_list') return groups.map((g) => ({ group_id: Number(g) }))
          return null
        },
      },
    },
    log: { warn() {}, info() {} },
    config: () => config,
    setConfig: (fn) => { config = normalize(fn(config)) },
    dataDir: (...p) => join(dir, ...p),
    on: (name, fn) => { listeners[name] = fn },
    tool: (b) => { builder = b },
    sendText: async (chatId, text) => { if (sendFails) throw new Error('网关没连上'); sent.push({ chatId, text }) },
  }
  contacts.setup(api)
  const tools = (chat) => Object.fromEntries(builder({ chat, sessionId: 's1' }).map((t) => [t.name, t]))
  return { calls, sent, tools, event: (ev) => listeners.onebot(ev), set: (patch) => { config = normalize({ ...config, ...patch }) } }
}

test('配置：默认开、每天 3 次；乱填回到范围内', () => {
  assert.deepEqual(normalize({}).contactWish, { enabled: true, perDay: 3 })
  assert.equal(normalize({ contactWish: { perDay: 99 } }).contactWish.perDay, 20)
  assert.equal(normalize({ contactWish: { perDay: 'x', enabled: 'yes' } }).contactWish.perDay, 3)
  assert.equal(normalize({ contactWish: 'on' }).contactWish.enabled, true)
})

test('工具挂在哪：私聊、群里都有 qq_wish_contact；列表 / 撤销只给主人私聊；关了都不挂', () => {
  const t = setup()
  assert.ok(t.tools(group).qq_wish_contact)
  assert.ok(t.tools(otherPm).qq_wish_contact)
  assert.equal(t.tools(group).qq_contact_wishes, undefined)
  assert.equal(t.tools(otherPm).qq_contact_wishes, undefined)
  assert.ok(t.tools(ownerPm).qq_contact_wishes)
  t.set({ contactWish: { enabled: false } })
  assert.equal(t.tools(group).qq_wish_contact, undefined)
  assert.equal(t.tools(ownerPm).qq_contact_wishes, undefined)
})

test('想加好友：私聊问主人，带上在哪个群认识的和理由；只问不加', async () => {
  const t = setup()
  const r = await t.tools(group).qq_wish_contact.execute({ kind: 'friend', id: '30003', name: '小鹿', reason: '聊游戏特别投缘' })
  assert.equal(r.ok, true)
  assert.equal(t.sent.length, 1)
  assert.equal(t.sent[0].chatId, `private:${OWNER}`)
  assert.match(t.sent[0].text, /30003（小鹿）/)
  assert.match(t.sent[0].text, /群 555/)
  assert.match(t.sent[0].text, /聊游戏特别投缘/)
  assert.match(t.sent[0].text, /算了 30003/)
  assert.deepEqual(t.calls.map((c) => c.action), ['get_friend_list'], '不调任何加好友接口')
})

test('想进群：文案提醒邀请和白名单', async () => {
  const t = setup()
  const r = await t.tools(otherPm).qq_wish_contact.execute({ kind: 'group', id: '777888', reason: '朋友说那里在聊画画' })
  assert.equal(r.ok, true)
  assert.match(t.sent[0].text, /进群 777888/)
  assert.match(t.sent[0].text, /白名单/)
  assert.deepEqual(t.calls.map((c) => c.action), ['get_group_list'])
})

test('不重复问：等处理时同一个号再问就拒绝；已经是好友 / 已在群里也拒绝', async () => {
  const t = setup({ friends: ['40004'], groups: ['555'] })
  const wish = t.tools(group).qq_wish_contact
  assert.equal((await wish.execute({ kind: 'friend', id: '30003', reason: '投缘' })).ok, true)
  const again = await wish.execute({ kind: 'friend', id: '30003', reason: '还是想加' })
  assert.equal(again.ok, false)
  assert.match(again.message, /说过/)
  assert.equal((await wish.execute({ kind: 'friend', id: '40004', reason: 'x' })).ok, false)
  assert.equal((await wish.execute({ kind: 'group', id: '555', reason: 'x' })).ok, false)
  assert.equal((await wish.execute({ kind: 'friend', id: BOT, reason: 'x' })).ok, false)
  assert.equal((await wish.execute({ kind: 'friend', id: OWNER, reason: 'x' })).ok, false)
  assert.equal((await wish.execute({ kind: 'friend', id: '12', reason: 'x' })).ok, false)
  assert.equal((await wish.execute({ kind: 'friend', id: '60006', reason: '  ' })).ok, false, '没有理由不问')
  assert.equal(t.sent.length, 1)
})

test('每天上限：到了就不再问；0 = 不问', async () => {
  const t = setup({ cfg: { contactWish: { perDay: 2 } } })
  const wish = t.tools(group).qq_wish_contact
  assert.equal((await wish.execute({ kind: 'friend', id: '60001', reason: 'a' })).ok, true)
  assert.equal((await wish.execute({ kind: 'group', id: '60002', reason: 'b' })).ok, true)
  const r = await wish.execute({ kind: 'friend', id: '60003', reason: 'c' })
  assert.equal(r.ok, false)
  assert.match(r.message, /上限 2/)
  assert.equal(t.sent.length, 2)
  const z = setup({ cfg: { contactWish: { perDay: 0 } } })
  assert.equal((await z.tools(group).qq_wish_contact.execute({ kind: 'friend', id: '60001', reason: 'a' })).ok, false)
  assert.equal(z.sent.length, 0)
})

test('planWish：昨天问的不占今天名额；「算了」30 天内不再提，过后可以再问', () => {
  const cfg = normalize({ ownerQQ: OWNER, botQQ: BOT, contactWish: { perDay: 1 } })
  const now = Date.parse('2026-11-09T12:00:00')
  const yesterday = { kind: 'friend', id: '70001', status: 'pending', at: now - 86400000 }
  assert.equal(planWish(cfg, [yesterday], { kind: 'friend', id: '70002', reason: 'x' }, { now }).ok, true)
  const dropped = { kind: 'friend', id: '70003', status: 'dropped', at: now - 40 * 86400000, doneAt: now - 5 * 86400000 }
  assert.equal(planWish(cfg, [dropped], { kind: 'friend', id: '70003', reason: 'x' }, { now }).ok, false)
  assert.equal(planWish(cfg, [dropped], { kind: 'friend', id: '70003', reason: 'x' }, { now: now + 30 * 86400000 }).ok, true)
  const w = planWish(cfg, [], { kind: 'group', id: '70004', reason: 'x', name: '画画群' }, { now, from: 'private:30003' }).wish
  assert.doesNotMatch(wishText(w), /认识的/, '私聊里提的不说在哪个群认识')
})

test('试运行：不发给主人、不记下来；发送失败要报失败、不记', async () => {
  const t = setup({ cfg: { dryRun: true } })
  const r = await t.tools(group).qq_wish_contact.execute({ kind: 'friend', id: '30003', reason: '投缘' })
  assert.equal(r.ok, true)
  assert.match(r.message, /试运行/)
  assert.equal(t.sent.length, 0)
  t.set({ dryRun: false })
  assert.equal((await t.tools(group).qq_wish_contact.execute({ kind: 'friend', id: '30003', reason: '投缘' })).ok, true, '试运行没占用')
  const f = setup({ sendFails: true })
  const fr = await f.tools(group).qq_wish_contact.execute({ kind: 'friend', id: '30003', reason: '投缘' })
  assert.equal(fr.ok, false)
  assert.match(fr.message, /网关没连上/)
})

test('主人列出 / 撤销：撤销后不再问；混进别人的话不能撤销', async () => {
  const t = setup()
  await t.tools(group).qq_wish_contact.execute({ kind: 'friend', id: '30003', name: '小鹿', reason: '投缘' })
  const tool = t.tools(ownerPm).qq_contact_wishes
  assert.match((await tool.execute({ action: 'list' })).message, /小鹿/)
  assert.equal((await tool.execute({ action: 'drop' })).ok, false)
  assert.equal((await tool.execute({ action: 'drop', id: '30003' })).ok, true)
  assert.match((await tool.execute({ action: 'list' })).message, /没有/)
  const again = await t.tools(group).qq_wish_contact.execute({ kind: 'friend', id: '30003', reason: '再试试' })
  assert.equal(again.ok, false)
  assert.match(again.message, /主人之前说过不加/)
  const m = setup({ allOwner: false })
  await m.tools(group).qq_wish_contact.execute({ kind: 'friend', id: '30003', reason: '投缘' })
  assert.equal((await m.tools(ownerPm).qq_contact_wishes.execute({ action: 'drop', id: '30003' })).ok, false)
})

test('加上好友 / 进了群：心愿完成，提醒主人白名单；已在白名单不提醒；申请来了标注是她想加的', async () => {
  const t = setup()
  await t.tools(group).qq_wish_contact.execute({ kind: 'friend', id: '30003', reason: '投缘' })
  await t.tools(group).qq_wish_contact.execute({ kind: 'group', id: '777888', reason: '画画' })
  t.event({ post_type: 'request', request_type: 'friend', user_id: 30003, flag: 'u_x', comment: '' })
  assert.match(t.sent.at(-1).text, /之前跟你说想加的/)
  t.event({ post_type: 'notice', notice_type: 'friend_add', user_id: 30003 })
  assert.match(t.sent.at(-1).text, /加上 QQ 30003 了/)
  assert.match(t.sent.at(-1).text, /私聊白名单/)
  const before = t.sent.length
  t.event({ post_type: 'notice', notice_type: 'group_increase', group_id: 777888, user_id: 99999 })
  assert.equal(t.sent.length, before, '别人进群不算')
  t.set({ allow: { private: [], groups: ['777888'] } })
  t.event({ post_type: 'notice', notice_type: 'group_increase', group_id: 777888, user_id: Number(BOT) })
  assert.equal(t.sent.length, before, '已在白名单就不啰嗦')
  const list = await t.tools(ownerPm).qq_contact_wishes.execute({ action: 'list' })
  assert.match(list.message, /已加上：QQ 30003/)
  assert.match(list.message, /已加上：群 777888/)
  t.event({ post_type: 'notice', notice_type: 'friend_add', user_id: 30003 })
  assert.equal(t.sent.length, before, '完成过的不重复提醒')
})
