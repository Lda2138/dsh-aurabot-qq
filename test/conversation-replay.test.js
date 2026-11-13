import { test } from 'node:test'
import assert from 'node:assert/strict'
import { replayConversation } from '../src/chat/conversation-replay.js'
import { clearReasoningCache } from '../src/core/llm.js'

const input = { system: '原始人设与快照', messages: [
  { role: 'user', content: [{ type: 'text', text: '我也想她了' }] },
  { role: 'assistant', content: [{ type: 'text', text: '那你去说呀' }] },
  { role: 'user', content: [{ type: 'text', text: '说了呀' }] },
] }
const cfg = { model: { provider: 'p', model: 'm' } }

test('回放保留历史角色、原文和系统提示，只请求一次，不把输出当工具执行', async () => {
  const requests = []
  const dsh = { get: () => null, llm: { async *stream(p) {
    requests.push(p)
    yield { type: 'text-delta', text: '<voice>知道啦</voice><poke>' }
    yield { type: 'finish', reason: { kind: 'completed' }, usage: { inputTokens: 12, outputTokens: 3 } }
  } } }
  const before = structuredClone(input)
  const r = await replayConversation(dsh, cfg, input)
  assert.equal(requests.length, 1)
  assert.deepEqual(input, before)
  assert.equal(requests[0].system, input.system)
  assert.deepEqual(requests[0].messages.map(({ role, content }) => ({ role, content })), input.messages)
  assert.equal(requests[0].tools, undefined)
  assert.deepEqual(requests[0].messages[1].source, { kind: 'model', provider: 'p', model: 'm' }, '真实 DSH 适配器要求历史助手消息带模型来源')
  assert.equal(requests[0].messages[0].source.kind, 'plugin')
  assert.deepEqual(r.sent, [])
  assert.equal(r.reply, '<voice>知道啦</voice><poke>')
  assert.equal(r.replayOnly, true)
  assert.equal(r.completed, true)
  assert.equal(r.usage.outputTokens, 3)
})

test('拒绝工具块、无用户末条和超量输入，验证前不调用模型', async () => {
  const dsh = { get() { throw new Error('不得触及宿主') } }
  await assert.rejects(replayConversation(dsh, cfg, { ...input, messages: [{ role: 'user', content: [{ type: 'tool-call', name: 'send' }] }] }), /文字块/)
  await assert.rejects(replayConversation(dsh, cfg, { ...input, messages: input.messages.slice(0, 2) }), /最后一条/)
  await assert.rejects(replayConversation(dsh, cfg, { ...input, system: '字'.repeat(800000) }), /2MiB/)
})

test('上游失败不自动重试，保留失败供回放报告区分', async () => {
  let calls = 0
  const dsh = { get: () => null, llm: { async *stream() { calls++; yield { type: 'finish', reason: { kind: 'error', failure: { message: 'network unavailable' } } } } } }
  await assert.rejects(replayConversation(dsh, cfg, input), /network unavailable/)
  assert.equal(calls, 1)
})

test('low/high 对照明确传档位和相同预算，不修改生产配置或输入', async () => {
  clearReasoningCache()
  const requests = [], before = structuredClone(cfg)
  const dsh = { get: () => null, llm: {
    async resolveModelInfo() { return { reasoning: { efforts: ['low', 'high'], defaultEffort: 'low' } } },
    async *stream(p) {
      requests.push(p)
      yield { type: 'reasoning-delta', text: '核对来源' }
      yield { type: 'text-delta', text: '知道了' }
      yield { type: 'finish', reason: { kind: 'completed' } }
    },
  } }
  for (const effort of ['low', 'high']) {
    const r = await replayConversation(dsh, cfg, { ...input, reasoningEffort: effort, maxTokens: 4096 })
    assert.equal(r.requestedReasoningEffort, effort)
    assert.equal(r.reasoningEffort, effort)
    assert.equal(r.reasoningChars, 4)
    assert.equal(r.maxTokens, 4096)
    assert.equal(r.ok, true)
    assert.deepEqual(r.sent, [])
  }
  assert.deepEqual(requests.map((p) => p.reasoningEffort), ['low', 'high'])
  assert.deepEqual(requests.map((p) => p.maxTokens), [4096, 4096])
  assert.deepEqual(cfg, before)
  clearReasoningCache()
})

test('显式档位不支持或不能确认时失败，不悄悄降档调用；非法预算不碰宿主', async () => {
  clearReasoningCache()
  let calls = 0
  const dsh = { get: () => null, llm: {
    async resolveModelInfo() { return { reasoning: { efforts: ['low'], defaultEffort: 'low' } } },
    async *stream() { calls++; throw new Error('不得调用') },
  } }
  await assert.rejects(replayConversation(dsh, cfg, { ...input, reasoningEffort: 'high' }), /不支持或无法确认/)
  const unprobed = { get() { throw new Error('不得触及宿主') } }
  for (const maxTokens of [0, 8193, 2000.5, '4096']) await assert.rejects(replayConversation(unprobed, cfg, { ...input, maxTokens }), /预算/)
  for (const reasoningEffort of ['', null, {}, 'HIGH']) await assert.rejects(replayConversation(unprobed, cfg, { ...input, reasoningEffort }), /档位名称/)
  assert.equal(calls, 0)
  clearReasoningCache()
})

test('有文字但输出截断或没有结束事件时不算成功样本', async () => {
  for (const kind of ['length', null]) {
    const dsh = { get: () => null, llm: { async *stream() {
      yield { type: 'text-delta', text: '尚未写完' }
      if (kind) yield { type: 'finish', reason: { kind } }
    } } }
    const r = await replayConversation(dsh, cfg, input)
    assert.equal(r.reply, '尚未写完')
    assert.equal(r.completed, false)
    assert.equal(r.ok, false)
    assert.equal(r.finishReason, kind)
  }
})

test('指定已配置模型只影响这次回放，助手来源跟随目标且不修改全局选择', async () => {
  clearReasoningCache()
  const requests = [], before = structuredClone(cfg)
  const target = { provider: 'configured', model: 'pro' }
  const dsh = { get: () => null, llm: {
    async resolveModelInfo(provider, model) {
      return provider === target.provider && model === target.model ? { reasoning: { efforts: ['high'] } } : null
    },
    async *stream(params) { requests.push(params); yield { type: 'text-delta', text: '好' }; yield { type: 'finish', reason: { kind: 'completed' } } },
  } }
  const r = await replayConversation(dsh, cfg, { ...input, model: target, reasoningEffort: 'high' })
  assert.deepEqual(r.model, target)
  assert.deepEqual(requests[0].messages[1].source, { kind: 'model', ...target })
  assert.deepEqual(cfg, before)
  assert.equal(requests[0].tools, undefined)
  assert.deepEqual(r.sent, [])
  await assert.rejects(replayConversation(dsh, cfg, { ...input, model: { provider: 'missing', model: 'x' } }), /已配置/)
  await assert.rejects(replayConversation(dsh, cfg, { ...input, model: { provider: 'p' } }), /provider 和 model/)
  assert.equal(requests.length, 1)
  clearReasoningCache()
})
