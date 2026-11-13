import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'aurabot-family-soft-pace-'))
process.env.AURABOT_DATA_DIR = root
process.env.AURABOT_WORKSPACE = join(root, 'workspace')
const { createHub } = await import('../src/chat/hub.js')
const { normalize } = await import('../src/core/config.js')
const { createFakeDsh } = await import('./helpers/fake-dsh.js')
const quiet = { info() {}, warn() {}, debug() {}, error() {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn) {
  const deadline = Date.now() + 5000
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('Expected chat input or reply did not arrive')
    await sleep(10)
  }
}

test('家庭群实际发过八轮后：新话和 @ 都进入模型并带软提醒；是否沉默仍由内容决定', async (t) => {
  const cfg = normalize({ enabled: true, dryRun: false, botQQ: '20002', ownerQQ: '10001',
    familyGroups: ['777'], allow: { groups: ['555'] }, merge: { enabled: false },
    chat: { typingDelay: false }, voice: { enabled: false }, stickers: { collect: false, autoChance: 0 },
    titleFilter: { enabled: false }, group: { addressedOnly: true },
  })
  const sent = []
  const fake = createFakeDsh({ brain: async ({ text }) => text.includes('暂时不用回答') ? '[沉默]' : '听着呢，接着说' })
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg, log: quiet,
    onebot: { call: async (action, params) => {
      if (action === 'send_group_msg') { sent.push(params); return { message_id: 5000 + sent.length } }
      return {}
    } },
  })
  fake.ctx.on('session/event', (s, e) => hub.onSessionEvent(s, e))
  t.after(() => { hub.dispose(); fake.dispose() })
  let seq = 0
  const send = (text, mentioned = false, gid = '777') => hub.onMessage({
    post_type: 'message', message_type: 'group', self_id: 20002, group_id: Number(gid),
    user_id: 10001, message_id: ++seq, sender: { nickname: '爸爸' },
    message: [...(mentioned ? [{ type: 'at', data: { qq: '20002' } }] : []), { type: 'text', data: { text } }],
  })
  for (let i = 0; i < 8; i++) await hub.deliver('group:777', `之前已回第 ${i + 1} 轮`, { own: true })
  assert.equal(sent.length, 8, '通过真实投递回执路径累计已回复轮数')
  await send('钱都充中转站了')
  await until(() => fake.turns.length === 1 && sent.length === 9)
  assert.match(fake.turns[0].userText, /钱都充中转站了/)
  assert.match(fake.turns[0].userText, /留意一下聊天节奏/)
  assert.match(fake.turns[0].userText, /照常自然接着聊/)
  await send('那你继续，接着讲刚才的事', true)
  await until(() => fake.turns.length === 2 && sent.length === 10)
  assert.match(fake.turns[1].userText, /家里人在叫你/)
  assert.match(fake.turns[1].userText, /留意一下聊天节奏/)
  await send('暂时不用回答，你先听我讲')
  await until(() => fake.turns.length === 3)
  await sleep(50)
  assert.equal(sent.length, 10, '模型可以按内容选择沉默，软提醒不会强制回复')
  assert.ok(sent.every((p) => !JSON.stringify(p.message).includes('留意一下聊天节奏')), '内部节奏提醒不作为 QQ 消息发出')
  for (let i = 0; i < 8; i++) await hub.deliver('group:555', '普通群的既有回复', { own: true })
  await send('那你继续', false, '555')
  await sleep(50)
  assert.equal(fake.turns.length, 3, '普通群策略保持')
})
