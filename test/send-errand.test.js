// 替主人去别的聊天说话：带上「为什么去说」；私聊找主人发不出去时提醒她去家庭群。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { default: qqTools } = await import('../src/modules/qq-tools/index.js')
const { normalize } = await import('../src/core/config.js')

const DAD = '10001'
const MOM = '10002'
function setup({ result = { missedAt: [] }, familyGroups = ['777'] } = {}) {
  const cfg = normalize({ ownerQQ: DAD, ownerName: '老登', botQQ: '20002', coOwners: [{ qq: MOM, name: '老妈' }], familyGroups, files: { enabled: false } })
  const sent = []
  let builder
  qqTools.setup({
    core: { hub: { turnSendersAllOwner: () => true, deliver: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); return result } }, onebot: { call: async () => null } },
    config: () => cfg, tool: (b) => { builder = b }, log: { warn() {}, info() {} },
  })
  const tool = Object.fromEntries(builder({ chat: { kind: 'private', userId: DAD, chatId: `private:${DAD}` }, level: 'full', sessionId: 's' }).map((t) => [t.name, t])).qq_send_message
  return { tool, sent }
}

test('替老登去找老妈：why 带到那边（标明是谁交代的），对方看不到', async () => {
  const { tool, sent } = setup()
  const r = await tool.execute({ target: `private:${MOM}`, text: '妈 早点睡', why: '劝老妈别熬夜' })
  assert.equal(r.ok, true)
  assert.equal(sent[0].chatId, `private:${MOM}`)
  assert.equal(sent[0].text, '妈 早点睡')
  assert.equal(sent[0].opts.errand, '老登交代的：劝老妈别熬夜')
  await tool.execute({ target: `private:${MOM}`, text: 'hi' })
  assert.deepEqual(sent[1].opts, {}, '没写 why 就不带')
})

test('私聊找主人发不出去（多半被拉黑）：照实说，并提醒去家庭群找；给别人发不出去时不提家庭群', async () => {
  const { tool } = setup({ result: { failed: 1, errors: ['retcode 1200'] } })
  const r = await tool.execute({ target: `private:${MOM}`, text: '妈', why: 'x' })
  assert.equal(r.ok, false)
  assert.match(r.message, /照实告诉对方[\s\S]*家庭群（group:777）/)
  const other = setup({ result: { failed: 1, errors: ['e'] } })
  other.tool && (await other.tool.execute({ target: 'group:777', text: 'x' }).then((m) => assert.doesNotMatch(m.message, /家庭群（group/)))
})
