import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'aurabot-learning-'))
process.env.AURABOT_DATA_DIR = join(root, 'boot')
const { normalize } = await import('../src/core/config.js')
const { createMemoryStore } = await import('../src/features/memory.js')
const { readMemoryState } = await import('./helpers/memory-state.js')
const key = 'qq:10001', chatId = 'private:10001'
const day = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
function setup(t, answer) {
  const dir = mkdtempSync(join(root, 'case-')); process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize({ ownerQQ: '10001', coOwners: [{ qq: '10002' }], familyGroups: ['777'], model: { provider: 'p', model: 'm' }, memory: { gistEnabled: false } })
  const rows = [{ chatId, uid: '10001', who: '爸爸', t: Date.now() - 1000, text: '我今天很累，先陪我聊会儿，别一直怼我' }, { chatId, who: 'bot', t: Date.now(), text: '说人话，别老等我喂' }]
  const dsh = { get: () => null, llm: { async *stream(p) { yield { type: 'text-delta', text: await answer(p) }; yield { type: 'finish', reason: { kind: 'completed' } } } } }
  const hub = { chatLogDays: () => [day()], chatLogOf: () => rows, deleteChatLog() {} }
  const mem = createMemoryStore({ dsh, hub, getConfig: () => cfg, log: { info() {}, warn() {}, debug() {} } })
  return { dir, mem, rows }
}

test('复核由AI决定替换旧经验，有人类原话依据；原数据归档，事实偏好保留', async (t) => {
  const s = setup(t, async () => JSON.stringify({ insights: [{ text: '累时先陪伴，别用顶嘴回应', speaker: '10001', quote: '我今天很累，先陪我聊会儿，别一直怼我' }], style: [] }))
  s.mem.setInsights(key, ['对方回6时说人话有效']); s.mem.setStyle(key, ['爱怼人'])
  s.mem.add({ text: '叫爸爸时两个字连着说', source: 'panel', about: '10001', tags: ['家人偏好'], tier: 0 })
  const reviewed = await s.mem.reviewInteractionLearning([key])
  assert.equal(reviewed.reviewed, 1)
  assert.equal(s.mem.insights()[0].list[0].speaker, '10001')
  assert.match(s.mem.insights()[0].list[0].text, /陪伴/)
  assert.deepEqual(s.mem.styles()[key], [])
  const saved = readMemoryState(s.dir)
  assert.equal(saved.learningArchive[0].insights[0].text, '对方回6时说人话有效')
  assert.ok(s.mem.list('').some((x) => x.text.includes('两个字连着说')))
})

test('机器人自己的顶嘴不能当人类偏好依据；伪造原话的复核不能清空已有经验', async (t) => {
  const s = setup(t, async () => JSON.stringify({ insights: [{ text: '对方喜欢被怼', speaker: '10001', quote: '说人话，别老等我喂' }], style: [] }))
  s.mem.setInsights(key, ['先关心再聊天'])
  const r = await s.mem.reviewInteractionLearning([key])
  assert.equal(r.reviewed, 0)
  assert.equal(s.mem.insights()[0].list[0].text, '先关心再聊天')
})

test('自动反思也验证人类原话，不把自己的拒绝写成长久相处经验', async (t) => {
  const s = setup(t, async ({ system }) => system.includes('整理长期记忆') ? '[]' : system.includes('回顾自己和') ? JSON.stringify({ insights: [{ text: '对方喜欢被拒绝', speaker: '10001', quote: '说人话，别老等我喂' }], style: [{ text: '说话简短', speaker: '10001', quote: '我今天很累' }] }) : '[]')
  await s.mem.consolidate({ includeToday: true })
  assert.ok(!s.mem.insights().some((x) => x.list.some((v) => v.text.includes('喜欢被拒绝'))))
  assert.deepEqual(s.mem.styles()[key], ['说话简短'])
  assert.equal(readMemoryState(s.dir).styleEvidence[key][0].quote, '我今天很累')
})
