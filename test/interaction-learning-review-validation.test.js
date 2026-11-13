// 只用假模型和临时数据复现复核流程的静默跳过；不接触生产模型或生产记忆。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { createMemoryStore } from '../src/features/memory.js'
import { readMemoryState } from './helpers/memory-state.js'

const KEY = 'qq:10001', CHAT = 'private:10001'
const original = '我今天很累，先陪我聊会儿，别一直怼我'
function setup(t, response, finishKind = 'completed') {
  const previous = process.env.AURABOT_DATA_DIR
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-review-validation-'))
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => { if (previous === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = previous })
  const cfg = normalize({ ownerQQ: '10001', familyGroups: ['777'], model: { provider: 'review-test', model: 'fake' }, memory: { gistEnabled: false } })
  const rows = [{ chatId: CHAT, uid: '10001', who: '爸爸', t: Date.now()-1000, text: original },
    { chatId: CHAT, who: 'bot', t: Date.now(), text: '说人话，别老等我喂' }]
  const calls = [], warnings = []
  const dsh = { get: () => null, llm: { async *stream(request) {
    calls.push(request)
    yield { type: 'text-delta', text: response }
    yield { type: 'finish', reason: { kind: finishKind } }
  } } }
  const mem = createMemoryStore({ dsh, getConfig: () => cfg,
    hub: { chatLogDays: () => ['2026-11-10'], chatLogOf: () => rows },
    log: { info() {}, debug() {}, warn: (...args) => warnings.push(args) } })
  mem.setInsights(KEY, ['对方回6时说人话有效'])
  mem.setStyle(KEY, ['爱怼人'])
  return { dir, mem, rows, calls, warnings }
}
const candidate = { text: '累的时候先陪伴', speaker: '10001', quote: original }

test('真实流水同样的uid/text结构和数值speaker都能通过证据验证', async (t) => {
  const f = setup(t, JSON.stringify({ insights: [{ ...candidate, speaker: 10001 }], style: [] }))
  const r = await f.mem.reviewInteractionLearning([KEY])
  assert.equal(r.reviewed, 1)
  const input = JSON.parse(f.calls[0].messages[0].content[0].text)
  assert.equal(input.transcript[0].speaker, f.rows[0].uid)
  assert.equal(input.transcript[0].text, f.rows[0].text)
  assert.equal(input.transcript[1].speaker, 'bot-context-only')
  assert.equal(readMemoryState(f.dir).learningArchive.length, 1)
})

test('非空JSON被max-tokens截断时明确报告原因，保留原数据且不重试补写', async (t) => {
  const f = setup(t, '{"insights":[{"text":"累的时候先陪伴","speaker":"10001","quote":"我今天很累', 'max-tokens')
  const r = await f.mem.reviewInteractionLearning([KEY])
  assert.equal(r.ok, false)
  assert.equal(r.status, 'failed')
  assert.equal(r.reviewed, 0)
  assert.equal(r.scopes[0].reason, 'incomplete_json_object')
  assert.equal(r.scopes[0].finish, 'max-tokens')
  assert.ok(r.scopes[0].outputChars > 0)
  assert.equal(f.calls.length, 1, '非空截断响应不会进入askModel的空输出重试')
  assert.equal(f.calls[0].maxTokens, 4000)
  assert.equal(f.calls[0].reasoningEffort, 'off')
  assert.equal(f.warnings.length, 1)
  assert.equal(readMemoryState(f.dir).learningArchive?.length || 0, 0)
})

test('完整JSON前有解释或style字段写成styles仍可复核，不修补不完整JSON', async (t) => {
  for (const response of [
    '结合原话，建议如下：\n'+JSON.stringify({ insights: [candidate], style: [] }),
    JSON.stringify({ insights: [candidate], styles: [] }),
  ]) {
    const f = setup(t, response)
    assert.equal((await f.mem.reviewInteractionLearning([KEY])).reviewed, 1)
    assert.equal(f.warnings.length, 0)
    assert.equal(f.mem.insights()[0].list[0].text, '累的时候先陪伴')
  }
})

test('一类证据无效保留整个scope原记录，并返回不含私聊原文的诊断', async (t) => {
  const f = setup(t, JSON.stringify({ insights: [candidate], style: [{ text: '消息简短', speaker: '10001', quote: '我今天很累……先陪我' }] }))
  const r = await f.mem.reviewInteractionLearning([KEY])
  assert.equal(r.ok, false)
  assert.equal(r.reviewed, 0)
  assert.equal(r.scopes[0].reason, 'invalid_human_evidence')
  assert.equal(r.scopes[0].validInsights, 1)
  assert.equal(r.scopes[0].rejected.legacy_evidence_not_found, 1)
  assert.doesNotMatch(JSON.stringify(r), /我今天很累|别一直怼我|我今天很累……先陪我/)
  assert.equal(f.warnings.length, 1)
  assert.equal(f.mem.insights()[0].list[0].text, '对方回6时说人话有效')
})

test('空keys和非授权key明确报告没有合格scope，不调用模型', async (t) => {
  const f = setup(t, JSON.stringify({ insights: [candidate], style: [] }))
  for (const keys of [[], ['private:10001']]) {
    const result = await f.mem.reviewInteractionLearning(keys)
    assert.equal(result.ok, false)
    assert.equal(result.status, 'no_eligible_scopes')
    assert.equal(result.reviewed, 0)
  }
  assert.equal(f.calls.length, 0)
})

test('稳定source行号可还原真实人类证据，支持Markdown外壳并保留事实偏好', async (t) => {
  const f = setup(t, '复核结果如下：\n```json\n'+JSON.stringify({ insights: [{ text: '累的时候先陪伴', source: 0 }], style: [{ text: '说话简短直接', source: '0' }] })+'\n```\n以上。')
  f.mem.add({ text: '叫爸爸时两个字连着说', about: '10001', source: 'panel', tags: ['家人偏好'], tier: 0 })
  const beforeFacts = readMemoryState(f.dir).items
  const result = await f.mem.reviewInteractionLearning([KEY])
  assert.equal(result.ok, true)
  assert.equal(result.reviewed, 1)
  assert.equal(result.scopes[0].finish, 'completed')
  const state = readMemoryState(f.dir)
  assert.equal(state.insights[KEY][0].speaker, '10001')
  assert.equal(state.insights[KEY][0].quote, original)
  assert.equal(state.insights[KEY][0].saidAt, f.rows[0].t)
  assert.equal(state.styleEvidence[KEY][0].chatId, CHAT)
  assert.deepEqual(state.items, beforeFacts)
})

test('source引用机器人或同时提供伪造quote时都不得替换原数据', async (t) => {
  for (const item of [{ text: '喜欢被怼', source: 1 }, { text: '句子短', source: 0, quote: '模型概括而非原话' }]) {
    const f = setup(t, JSON.stringify({ insights: [item], style: [] }))
    const result = await f.mem.reviewInteractionLearning([KEY])
    assert.equal(result.ok, false)
    assert.equal(result.scopes[0].reason, 'invalid_human_evidence')
    assert.equal(f.mem.insights()[0].list[0].text, '对方回6时说人话有效')
    assert.equal(readMemoryState(f.dir).learningArchive?.length || 0, 0)
  }
})

test('部分scope成功、部分输出无效时明确标记partial；空scope有单独结果', async (t) => {
  let call = 0
  const f = setup(t, '')
  const cfg = normalize({ ownerQQ: '10001', coOwners: [{ qq: '10002' }], model: { provider: 'review-test', model: 'fake' }, memory: { gistEnabled: false } })
  const dsh = { get: () => null, llm: { async *stream() {
    yield { type: 'text-delta', text: call++ === 0 ? JSON.stringify({ insights: [{ text: '先陪伴', source: 0 }], style: [] }) : '{"insights":[' }
    yield { type: 'finish', reason: { kind: call === 1 ? 'completed' : 'max-tokens' } }
  } } }
  const mem = createMemoryStore({ dsh, getConfig: () => cfg, hub: { chatLogDays: () => ['2026-11-10'], chatLogOf: () => f.rows }, log: { warn() {} } })
  mem.setStyle('self', ['旧的全局说法'])
  const result = await mem.reviewInteractionLearning([KEY, 'qq:10002', 'self'])
  assert.equal(result.ok, false)
  assert.equal(result.partial, true)
  assert.equal(result.status, 'partial')
  assert.equal(result.reviewed, 1)
  assert.equal(result.failed, 1)
  assert.deepEqual(result.scopes.map((x) => x.status), ['reviewed', 'empty', 'skipped'])
  assert.equal(mem.styles().self[0], '旧的全局说法')
})
