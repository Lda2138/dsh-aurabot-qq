// 记忆提炼失败时：关掉思考再试、连续失败跳过这一批、断网不跳过。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let createMemoryStore, normalize
before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-memretry-'))
  ;({ createMemoryStore } = await import('../src/features/memory.js'))
  ;({ normalize } = await import('../src/core/config.js'))
})

function setup(answer) {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-memretry-'))
  const calls = []
  const dsh = {
    get: () => null,
    llm: {
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'low' }] } }),
      async *stream({ system, reasoningEffort, maxTokens }) {
        if (system.includes('整理长期记忆')) {
          calls.push({ reasoningEffort, maxTokens })
          const out = answer(calls.length, reasoningEffort)
          if (out instanceof Error) throw out
          if (out) yield { type: 'text-delta', text: out }
        } else yield { type: 'text-delta', text: '[]' }
        yield { type: 'finish', reason: { kind: 'completed' } }
      },
    },
  }
  const today = new Date()
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const hub = { chatLogDays: () => [day], chatLogOf: () => [{ chatId: 'private:2', who: '阿花', uid: '2', text: '你好' }], deleteChatLog() {} }
  const warns = []
  const cfg = normalize({ model: { provider: 'p', model: 'm' }, ownerQQ: '1' })
  const mem = createMemoryStore({ dsh, getConfig: () => cfg, hub, log: { info() {}, warn: (...a) => warns.push(a.join('')), debug() {} } })
  return { mem, calls, warns }
}

test('首次提炼就关闭思考，不为关闭推理浪费一次请求', async () => {
  const { mem, calls } = setup((n, effort) => (effort === 'off' ? '[]' : ''))
  const r = await mem.consolidate({ includeToday: true })
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(calls, [{ reasoningEffort: 'off', maxTokens: 4000 }])
})

test('已关闭推理仍为空时，保留扩大输出预算的兜底', async () => {
  const { mem, calls } = setup((n) => n > 2 ? '[]' : '')
  const r = await mem.consolidate({ includeToday: true })
  assert.equal(r.ok, true, r.message)
  assert.ok(calls.every((c) => c.reasoningEffort === 'off'))
  assert.ok(calls.some((c) => c.maxTokens === 16000))
})

test('同一批多次格式失败保留进度，诊断包含结束原因，恢复后再处理', async () => {
  let broken = true
  const { mem, warns } = setup(() => broken ? '我不想整理' : '[]')
  const first = await mem.consolidate({ includeToday: true })
  assert.equal(first.ok, false)
  assert.match(first.message, /finish[\s\S]*保留/)
  assert.equal((await mem.consolidate({ includeToday: true })).ok, false)
  assert.equal((await mem.consolidate({ includeToday: true })).ok, false, '第 3 次也不能假装已经处理')
  assert.ok(warns.some((w) => w.includes('格式失败')))
  assert.ok(!warns.some((w) => w.includes('跳过')))
  broken = false
  assert.equal((await mem.consolidate({ includeToday: true })).ok, true)
})

test('断网这类错误不跳过，恢复后接着提炼', async () => {
  const { mem } = setup(() => new Error('Connection error'))
  for (let i = 0; i < 4; i++) assert.equal((await mem.consolidate({ includeToday: true })).ok, false)
})
