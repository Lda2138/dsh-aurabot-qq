import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let createMemoryStore, normalize, readMemoryState
before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-backoff-boot-'))
  ;({ createMemoryStore } = await import('../src/features/memory.js'))
  ;({ normalize } = await import('../src/core/config.js'))
  ;({ readMemoryState } = await import('./helpers/memory-state.js'))
})

const DAD = '10000001', MOM = '10000002', DAY = 86400_000
const dayKey = (at) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

function setup(t, { family = true, otherChat = true, at = new Date(2026, 10, 11, 12).getTime(), fail } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-backoff-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  t.mock.timers.enable({ apis: ['Date'], now: at })
  t.after(() => {
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  const cfg = normalize({ ownerQQ: DAD, coOwners: [{ qq: MOM, role: '妈妈' }], familyGroups: family ? ['90000001'] : [],
    model: { provider: 'p', model: 'm' }, cost: { enabled: false },
    memory: { dailyConsolidate: true, consolidateTimes: ['23:59'], extractIdleMinutes: 1, extractMinLines: 1,
      shortTerm: false, gistEnabled: false, compress: false, keepChatlogDays: -1 } })
  const days = [dayKey(at - 2 * DAY), dayKey(at - DAY)]
  const rows = new Map(days.map((day, i) => [day, [{ chatId: `private:${DAD}`, uid: DAD, who: '爸爸', text: `爸爸第${i + 1}天说喜欢茶`, t: at - (2 - i) * DAY }]]))
  if (otherChat) rows.get(days[0]).push({ chatId: `private:${MOM}`, uid: MOM, who: '妈妈', text: '妈妈喜欢花', t: at - 2 * DAY })
  const calls = []
  let broken = true
  const dsh = { get: () => null, llm: { async *stream({ system, messages }) {
    const text = messages[0].content[0].text
    if (system.includes('整理长期记忆')) {
      calls.push(text)
      if (broken && text.includes('爸爸第')) {
        fail?.({ t, dir, cfg, at })
        throw new Error('Connection error')
      }
      yield { type: 'text-delta', text: '[]' }
    } else yield { type: 'text-delta', text: '{"insights":[],"style":[]}' }
    yield { type: 'finish', reason: { kind: 'completed' } }
  } } }
  const hub = { chatLogDays: () => days, chatLogOf: (day) => rows.get(day) || [], deleteChatLog() {}, speakersOf: () => [] }
  const mem = createMemoryStore({ dsh, getConfig: () => cfg, hub, log: { info() {}, warn() {}, debug() {} } })
  return { mem, calls, dir, days, at, recover: () => { broken = false }, read: () => readMemoryState(dir) }
}

for (const family of [true, false]) {
  test(`${family ? '家庭' : '普通'}额度：失败暂停同聊天的所有日期，其他聊天继续且仅退失败批次`, async (t) => {
    const f = setup(t, { family })
    await f.mem.tick()
    assert.equal(f.calls.filter((text) => text.includes('爸爸第')).length, 1, '第一天失败后不能继续处理同聊天第二天')
    assert.equal(f.calls.filter((text) => text.includes('妈妈喜欢花')).length, 1)
    const state = f.read()
    assert.equal(family ? state.familyBudgets.extract : state.extractBatches.count, 1, '只留下其他聊天成功处理的额度')
    assert.equal(Object.keys(state.badBatches).length, 1)
    assert.ok(!state.processed?.[f.days[1]], '失败聊天第二天的进度必须保留')
    assert.deepEqual(state.processed[f.days[0]].idle, [[1, 2]], '不能把第一天的失败行标为完成')
  })
}

test('退避期间不请求，恢复后按原进度补完两天，不重复其他聊天', async (t) => {
  const f = setup(t)
  await f.mem.tick()
  const first = f.calls.length
  f.recover()
  t.mock.timers.setTime(f.at + 119_999)
  await f.mem.tick()
  assert.equal(f.calls.length, first)
  t.mock.timers.setTime(f.at + 120_001)
  await f.mem.tick()
  assert.equal(f.calls.filter((text) => text.includes('妈妈喜欢花')).length, 1)
  assert.equal(f.calls.filter((text) => text.includes('爸爸第1天')).length, 2)
  assert.equal(f.calls.filter((text) => text.includes('爸爸第2天')).length, 1)
  assert.equal(f.read().familyBudgets.extract, 3)
})

test('手动整理可以越过退避，在恢复后处理积压', async (t) => {
  const f = setup(t, { otherChat: false })
  await f.mem.tick()
  f.recover()
  const result = await f.mem.consolidate({ includeToday: true })
  assert.equal(result.ok, true, result.message)
  assert.equal(f.calls.filter((text) => text.includes('爸爸第1天')).length, 2)
  assert.equal(f.calls.filter((text) => text.includes('爸爸第2天')).length, 1)
  assert.equal(f.read().familyBudgets.extract, 2)
})

test('跨午夜失败：释放原来预留的批次，不把日期当作请求完成日期', async (t) => {
  const at = new Date(2026, 10, 11, 23, 58, 59).getTime()
  const f = setup(t, { at, otherChat: false, fail: () => t.mock.timers.setTime(at + 62_000) })
  await f.mem.tick()
  assert.equal(f.read().familyBudgets.day, dayKey(at))
  assert.equal(f.read().familyBudgets.extract, 0)
  assert.equal(f.calls.length, 1)
})
