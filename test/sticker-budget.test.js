// 只用临时 data、本地假图片和模型/下载/OneBot 桩，绝不连接真实 QQ。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { createStickerStore } from '../src/features/stickers.js'

const HOUR = 3600_000, DAY = 86400_000
const log = { info() {}, warn() {}, debug() {} }
const image = (id) => {
  const buf = Buffer.alloc(96, id)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buf)
  buf.writeUInt32BE(200, 16); buf.writeUInt32BE(200, 20)
  return buf
}
const segment = (id, summary = '[动画表情]', extra = {}) => ({ type: 'image', data: { file: `fixture-${id}.png`, id, summary, sub_type: 1, ...extra } })
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
async function settle(store) {
  for (let i = 0; i < 100; i++) {
    await store.waitForCaptions()
    if (!store.captionStatus().running && !store.captionStatus().budget.queued) return
    await Promise.resolve()
  }
  throw new Error('模拟后台队列没有结束')
}

function rig(t, { stickers = {}, caption = async () => '点头的小猫 #开心', read, imports = [] } = {}) {
  const old = process.env.AURABOT_DATA_DIR
  const directory = mkdtempSync(join(tmpdir(), 'aurabot-sticker-budget-'))
  process.env.AURABOT_DATA_DIR = directory
  const cfg = normalize({ dryRun: true, familyGroups: ['777'], stickers: { enabled: true, collect: true, caption: true,
    maxPerHour: 100, maxLibrary: 300, ...stickers } })
  const clock = { time: 1_700_000_000_000, tick(ms) { this.time += ms } }
  const calls = [], downloads = [], qq = [], instances = []
  let active = 0, maxActive = 0
  function create() {
    const store = createStickerStore({ dsh: {}, getConfig: () => cfg, log, now: () => clock.time,
      onebot: { call: async (action) => { qq.push(action); if (action === 'fetch_custom_face') return imports; if (action === 'add_custom_face') return { emoji_id: 'mock-' + qq.length }; if (action === 'modify_custom_face') return {}; throw new Error('测试没有此 OneBot 桩') } },
      see: async () => true,
      ask: async (_dsh, opts) => {
        calls.push(opts)
        active++; maxActive = Math.max(maxActive, active)
        try { return await caption(opts, calls.length) } finally { active-- }
      },
      readSegment: async (seg, _onebot, opts) => {
        assert.equal(opts.maxBytes, 5 * 1024 * 1024)
        downloads.push(seg.data.id)
        if (read) return read(seg)
        return image(seg.data.id)
      },
      download: async (url, opts) => { assert.equal(opts.maxBytes, 5 * 1024 * 1024); downloads.push(url); return image(Number(url.split(':').at(-1))) },
    })
    instances.push(store)
    return store
  }
  t.after(async () => {
    instances.forEach((store) => store.dispose())
    await Promise.all(instances.map((store) => store.waitForCaptions()))
    if (old === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = old
  })
  const store = create()
  return { store, create, cfg, clock, calls, downloads, qq, directory, maxActive: () => maxActive,
    budget: () => JSON.parse(readFileSync(join(directory, 'stickers', 'budget.json'), 'utf8')) }
}

test('高流量普通群只在本地资格通过时收图；具体QQ描述优先，100条后续不下载不调模型', async (t) => {
  const s = rig(t)
  const first = await s.store.collect(segment(1, '[疑惑地歪头]'), 'group:900')
  assert.equal(first.ok, true)
  const flood = await Promise.all(Array.from({ length: 100 }, (_, i) => s.store.collect(segment(i + 2), 'group:901')))
  await settle(s.store)
  assert.ok(flood.every((r) => !r.ok))
  assert.equal(s.downloads.length, 1)
  assert.equal(s.calls.length, 0)
  assert.equal(s.store.library().items[0].name, '疑惑地歪头')
  assert.equal(s.store.library().items[0].nameSource, 'qq-summary')
  assert.equal(s.budget().externalCollected.length, 1)
  assert.deepEqual(s.qq, [])
})

test('沿用QQ描述后照样写回收藏备注，无需额外调用视觉模型', async (t) => {
  const s = rig(t)
  s.cfg.dryRun = false // 仍然只调用上面的 OneBot 桩。
  const result = await s.store.collect(segment(1, '[开心]'), 'group:777')
  await settle(s.store)
  assert.equal(result.ok, true)
  assert.deepEqual(s.qq, ['add_custom_face', 'modify_custom_face'])
  assert.equal(s.calls.length, 0)
  assert.equal(s.store.library().items[0].name, '开心')
})

test('外群成功额度跨群和store持久共享；家庭与私聊不吃外群次数，滚动一天后恢复', async (t) => {
  const s = rig(t, { stickers: { caption: false, externalCollectMinMinutes: 30, externalCollectMaxPerDay: 2 } })
  assert.equal((await s.store.collect(segment(1), 'group:900')).ok, true)
  s.clock.tick(29 * 60_000)
  const next = s.create()
  assert.equal((await next.collect(segment(2), 'group:901')).ok, false)
  assert.equal(s.downloads.length, 1)
  s.clock.tick(60_000)
  assert.equal((await next.collect(segment(2), 'group:901')).ok, true)
  s.clock.tick(HOUR)
  assert.equal((await next.collect(segment(3), 'group:902')).ok, false)
  assert.equal((await next.collect(segment(4), 'group:777')).ok, true)
  assert.equal((await next.collect(segment(5), 'private:10001')).ok, true)
  assert.equal(s.budget().externalCollected.length, 2)
  s.clock.tick(DAY)
  assert.equal((await s.create().collect(segment(6), 'group:902')).ok, true)
  assert.equal(s.budget().externalCollected.length, 1)
})

test('失败和重复只短退避，不占成功额度；同源/已知MD5重复在下载前跳过', async (t) => {
  const s = rig(t, { stickers: { caption: false }, read: async (seg) => {
    if (seg.data.id === 1) throw new Error('模拟下载失败')
    return image(seg.data.id)
  } })
  assert.equal((await s.store.collect(segment(1), 'group:900')).ok, false)
  for (let i = 0; i < 20; i++) await s.store.collect(segment(i + 2), 'group:900')
  assert.equal(s.downloads.length, 1)
  assert.equal(s.budget().externalCollected.length, 0)
  s.clock.tick(5 * 60_000)
  assert.equal((await s.store.collect(segment(1), 'group:900')).ok, false)
  assert.equal(s.downloads.length, 1, '失败来源的短缓存还在')
  const accepted = await s.store.collect(segment(2), 'group:900')
  assert.equal(accepted.ok, true)
  assert.equal((await s.store.collect(segment(2), 'group:900')).ok, false)
  assert.equal((await s.store.collect(segment(20, '', { file: accepted.item.md5 + '.png' }), 'group:900')).ok, false)
  assert.equal(s.downloads.length, 2)
  s.clock.tick(30 * 60_000)
  assert.equal((await s.store.collect(segment(2, '', { file: 'another-source.png' }), 'group:900')).ok, false)
  assert.equal(s.downloads.length, 3, '未知新来源下载一次后才知道内容相同')
  assert.equal(s.budget().externalCollected.length, 1, '重复内容没有占新图次数')
  assert.equal(s.calls.length, 0)
})

test('并发突发不能越过外群预占或原每小时限额，串行落库不丢图', async (t) => {
  const gate = deferred(), entered = deferred()
  const s = rig(t, { stickers: { caption: false, maxPerHour: 3 }, read: async (seg) => {
    if (seg.data.id === 1) { entered.resolve(); await gate.promise }
    return image(seg.data.id)
  } })
  const first = s.store.collect(segment(1), 'group:900')
  await entered.promise
  const flood = await Promise.all(Array.from({ length: 50 }, (_, i) => s.store.collect(segment(i + 2), 'group:901')))
  assert.ok(flood.every((r) => !r.ok))
  assert.equal(s.downloads.length, 1)
  gate.resolve()
  assert.equal((await first).ok, true)
  const family = await Promise.all(Array.from({ length: 20 }, (_, i) => s.store.collect(segment(i + 60), 'group:777')))
  assert.equal(family.filter((r) => r.ok).length, 2)
  assert.equal(s.store.library().items.length, 3)
  assert.equal(s.downloads.length, 3)
})

test('AI命名受共享小时/日预算限制，切模型或重建store不能重置，同一时刻只有一个视觉调用', async (t) => {
  const s = rig(t, { stickers: { captionMaxPerHour: 2, captionMaxPerDay: 3, captionQueueLimit: 8 } })
  await Promise.all(Array.from({ length: 6 }, (_, i) => s.store.collect(segment(i + 1), 'private:10001')))
  await settle(s.store)
  assert.equal(s.store.library().items.length, 6)
  assert.equal(s.calls.length, 2)
  assert.equal(s.maxActive(), 1)
  assert.equal(s.budget().captions.length, 2)
  s.clock.tick(HOUR + 1)
  s.cfg.stickers.captionModel = { provider: 'different', model: 'vision-b' }
  s.store.dispose()
  const next = s.create()
  await next.collect(segment(7), 'private:10001')
  await next.collect(segment(8), 'private:10001')
  await settle(next)
  assert.equal(s.calls.length, 3)
  assert.deepEqual(s.calls[2].model, { provider: 'different', model: 'vision-b' })
  assert.equal(s.budget().captions.length, 3)
  for (const call of s.calls) {
    assert.equal(call.maxTokens, 400)
    assert.equal(call.reasoningEffort, 'off')
    assert.equal(call.retryEmpty, false)
  }
  assert.equal((await next.collect(segment(7), 'private:10001')).ok, false)
  assert.equal(s.calls.length, 3)
})

test('自动收集、QQ导入和批量补名复用同一队列，不能各开并发或绕开预算', async (t) => {
  const entered = deferred(), gate = deferred()
  const s = rig(t, { imports: ['memory:2', 'memory:3'], stickers: { captionMaxPerHour: 2, captionMaxPerDay: 2 }, caption: async (_opts, nth) => {
    if (nth === 1) { entered.resolve(); await gate.promise }
    return '猫咪点头 #开心'
  } })
  await s.store.collect(segment(1), 'private:10001')
  await entered.promise
  assert.equal((await s.store.importFromQQ()).added, 2)
  const next = s.create()
  assert.equal((await next.captionLibrary()).ok, true)
  assert.equal(s.calls.length, 1)
  gate.resolve()
  await settle(s.store); await settle(next)
  assert.equal(s.store.library().items.length, 3)
  assert.equal(s.calls.length, 2)
  assert.equal(s.maxActive(), 1)
  assert.equal(s.budget().captions.length, 2)
  assert.deepEqual(s.qq, ['fetch_custom_face'])
})

test('空输出不扩token重试；失败计预算并短暂停后续命名，同图一天内不后台反复烧钱', async (t) => {
  const s = rig(t, { caption: async () => '' })
  await s.store.collect(segment(1), 'private:10001')
  await settle(s.store)
  await s.store.collect(segment(2), 'private:10001')
  await settle(s.store)
  assert.equal(s.calls.length, 1)
  assert.equal(s.budget().captions.length, 1)
  assert.equal(s.store.library().items[0].caption.state, 'failed')
  assert.equal(s.store.library().items[1].caption, undefined)
  const next = s.create()
  await next.captionLibrary()
  await settle(next)
  assert.equal(s.calls.length, 1)
  s.clock.tick(16 * 60_000)
  await next.captionLibrary()
  await settle(next)
  assert.equal(s.calls.length, 2, '只尝试此前未尝试过的第二张')
  assert.equal(s.store.library().items[0].caption.attemptedAt, 1_700_000_000_000)
})

test('有界排队只保留少量命名任务，额外图片保留本地，手动给名字不再二次识别', async (t) => {
  const entered = deferred(), gate = deferred()
  const s = rig(t, { stickers: { captionQueueLimit: 2, captionMaxPerHour: 10 }, caption: async (_opts, nth) => {
    if (nth === 1) { entered.resolve(); await gate.promise }
    return '猫咪歪头 #疑惑'
  } })
  await s.store.collect(segment(1), 'private:10001')
  await entered.promise
  await Promise.all(Array.from({ length: 5 }, (_, i) => s.store.collect(segment(i + 2), 'private:10001')))
  assert.equal(s.store.captionStatus().budget.queued, 2)
  assert.equal(s.store.library().items.length, 6)
  await s.store.addFromBuffer(image(8), { name: '主模型已经起好名字', caption: true, toQQ: false })
  gate.resolve(); await settle(s.store)
  assert.equal(s.calls.length, 2)
  assert.equal(s.store.library().items.filter((i) => i.nameSource === 'ai').length, 2)
  assert.equal(s.maxActive(), 1)
})

test('库满且都是手动图或外群预算为零时下载前停，明确手动添加仍可进行', async (t) => {
  const s = rig(t, { stickers: { caption: false, maxLibrary: 1, externalCollectMaxPerDay: 0 } })
  assert.equal((await s.store.collect(segment(1), 'group:900')).ok, false)
  await s.store.addFromBuffer(image(2), { name: '手动保留', toQQ: false })
  assert.equal((await s.store.collect(segment(3), 'private:10001')).ok, false)
  assert.equal(s.downloads.length + s.calls.length, 0)
  assert.equal((await s.store.addFromBuffer(image(4), { name: '明确添加', from: 'tool', toQQ: false })).ok, true)
})

test('卸载丢弃旧队列写回，新实例仍等在途调用结束并共用预算，不产生重叠视觉调用', async (t) => {
  const entered = deferred(), gate = deferred()
  const s = rig(t, { caption: async (_opts, nth) => { if (nth === 1) { entered.resolve(); await gate.promise }; return '新的名字 #开心' } })
  await s.store.collect(segment(1), 'private:10001')
  await entered.promise
  await s.store.collect(segment(2), 'private:10001')
  s.store.dispose()
  const next = s.create()
  await next.collect(segment(3), 'private:10001')
  assert.equal(s.calls.length, 1)
  gate.resolve(); await settle(next)
  assert.equal(s.calls.length, 2)
  assert.equal(s.maxActive(), 1)
  const items = next.library().items
  assert.equal(items[0].name, '')
  assert.equal(items[1].caption, undefined)
  assert.equal(items[2].name, '新的名字')
})
