import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'aurabot-group-cost-'))
process.env.AURABOT_DATA_DIR = join(root, 'boot')
process.env.AURABOT_WORKSPACE = join(root, 'workspace')
const { createHub } = await import('../src/chat/hub.js')
const { normalize } = await import('../src/core/config.js')
const { DEFAULT_GROUP_POLICY, decideGroupReply } = await import('../src/chat/group-policy.js')
const { createFakeDsh } = await import('./helpers/fake-dsh.js')
const settle = async () => { for (let n = 0; n < 100; n++) await new Promise(setImmediate) }
const quiet = { info() {}, warn() {}, debug() {}, error() {} }

test('普通群省用量不因刚聊过、短问句或高相关话题继续触发，明确叫到仍可回应', () => {
  const now = Date.now()
  const p = { policy: { ...DEFAULT_GROUP_POLICY, addressedOnly: true, interjectChance: 1 }, now, hour: 12, relevance: 1, recentTimes: Array(40).fill(now), botReplyTimes: [now - 100], engagedUntil: now + 120000, engagedRun: 0, rand: () => 0 }
  for (const text of ['人呢', '好吃吗？', '猫猫表情好可爱']) assert.equal(decideGroupReply({ ...p, text }).reply, false)
  assert.equal(decideGroupReply({ ...p, text: '大肥鱼 在吗' }).mode, 'must')
  assert.equal(decideGroupReply({ ...p, text: '大肥鱼 在吗', atOthersAny: true }).reply, false)
  assert.equal(decideGroupReply({ ...p, mentioned: true, atOthersAny: true }).mode, 'must')
  assert.equal(decideGroupReply({ ...p, repliedToBot: true }).mode, 'must')
})

test('大量普通群消息不建模型会话、不取图；本地表情收集保留，家庭群正常参与', async (t) => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(root, 'case-'))
  const cfg = normalize({ enabled: true, dryRun: true, botQQ: '20002', ownerQQ: '10001', familyGroups: ['777'], allow: { groups: ['555'] }, merge: { enabled: false }, voice: { enabled: false }, titleFilter: { enabled: false }, group: { addressedOnly: true, interjectChance: 1, minRelevance: 0, minRecentMessages: 0, cooldownSec: 0 }, stickers: { collect: true, collectMode: 'auto', caption: false } })
  const fake = createFakeDsh({ brain: async () => '[沉默]' })
  const calls = [], collected = []
  let decisions = 0
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg, log: quiet,
    onebot: { call: async (action) => { calls.push(action); return {} } },
    stickers: { collect: async (seg, from) => { collected.push({ seg, from }); return { ok: true } } },
    hooks: { groupDecide: () => { decisions++; return { reply: true, mode: 'interject' } } },
  })
  fake.ctx.on('session/event', (s, e) => hub.onSessionEvent(s, e))
  t.after(() => { hub.dispose(); fake.dispose() })
  const send = (text, extra = [], gid = '555', uid = '10003') => hub.onMessage({ post_type: 'message', message_type: 'group', self_id: 20002, group_id: Number(gid), user_id: Number(uid), message_id: 1, sender: { nickname: uid }, message: [{ type: 'text', data: { text } }, ...extra] })
  for (let n = 0; n < 100; n++) await send('猫猫 游戏 表情包 天气？', n === 10 ? [{ type: 'image', data: { sub_type: 1, file: 'never-download', summary: '[可爱猫猫]' } }] : [])
  await send('大肥鱼这个梗', [{ type: 'at', data: { qq: '10004' } }])
  await settle()
  assert.equal(fake.agents.size, 0, '旁听普通消息不创建 DSH 会话')
  assert.equal(fake.turns.length, 0)
  assert.equal(decisions, 0, '扩展群决策也不为这些消息唤醒模型')
  assert.equal(collected.length, 1, '保留本地收集入口，具体间隔和额度由表情库管理')
  assert.equal(collected[0].from, 'group:555')
  assert.equal(calls.includes('get_image'), false)
  await send('叫你一下', [{ type: 'at', data: { qq: '20002' } }]); await settle()
  assert.equal(fake.turns.length, 1)
  await send('今天天气不错', [], '777', '10001'); await settle()
  assert.equal(fake.turns.length, 2, '同一开关不阻断家庭群')
})
