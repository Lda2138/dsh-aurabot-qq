import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'aurabot-family-diary-'))
process.env.AURABOT_DATA_DIR = root
after(() => rmSync(root, { recursive: true, force: true }))
const { createFamilyDiary, diaryEvidence } = await import('../src/modules/diary/family.js')
const { dataDir, writeJson, readJson } = await import('../src/core/store.js')
const { normalize } = await import('../src/core/config.js')

function fixture() {
  writeJson(dataDir('family-diary.json'), { history: [], considered: {}, nextAt: 0 })
  let cfg = normalize({ enabled: true, dryRun: false, ownerQQ: '10001', familyGroups: ['20001'], diary: { enabled: true, rich: { enabled: true }, timesPerDay: 0, windowStart: '23:59', windowEnd: '23:59' } })
  const now = Date.now(), events = [{ id: 'draw', at: now, source: 'event', tags: ['经历', '画画'], text: '给爸爸画了一条鱼' }]
  const lines = [{ t: now, chatId: 'private:10001', who: 'bot', text: '画完啦' }]
  const sent = [], added = [], prompts = []
  let reply = { text: '今天给爸爸画了一条鱼，还跟家人聊了一会儿。', nextMinutes: 5 }, review = { accept: true }, during, muted = false
  const api = {
    config: () => cfg, use: () => ({ list: () => events, add: (m) => added.push(m) }),
    log: { info() {}, warn() {} },
    core: {
      mutes: { muted: () => muted }, personas: { current: () => '小鱼，自然亲近' },
      hub: {
        chatLogOf: () => lines,
        async runSystemTurn(...args) {
          prompts.push(args); await during?.()
          if (args[3].key === 'family-life-review') return typeof review === 'string' ? review : JSON.stringify(review)
          const block = args[2].split('\n\n').find((s) => s.startsWith('新增资料（'))
          const fresh = JSON.parse(block.slice(block.indexOf('：') + 1))
          return typeof reply === 'string' ? reply : JSON.stringify({ evidenceIds: fresh.map((x) => x.id), ...reply })
        },
        async sendText(chatId, text, _r, _m, _u, opts) {
          if (!opts.isCurrent()) return null
          sent.push({ chatId, text })
          lines.push({ t: Date.now(), chatId, who: 'bot', text })
          return { message_id: '100' }
        },
      },
    },
  }
  return { diary: createFamilyDiary(api), api, events, lines, sent, added, prompts,
    cfg: () => cfg, update: (patch) => { cfg = normalize({ ...cfg, ...patch }) },
    reply: (r) => { reply = r }, review: (r) => { review = r }, during: (fn) => { during = fn }, mute: () => { muted = true } }
}

test('证据只取今天真实事件和家人聊天，视频多也不挤掉画图；排除旧日记和外群', () => {
  const f = fixture(), now = Date.now()
  f.events.push(...Array.from({ length: 100 }, (_, i) => ({ id: `b${i}`, at: now, source: 'event', tags: ['经历', 'B站'], text: `视频${i}` })),
    { id: 'old', at: now - 86400_000, source: 'event', text: '昨天的经历' },
    { id: 'updated', at: now, saidAt: now - 86400_000, source: 'event', text: '昨天发生今天更新' },
    { id: 'invalid', at: now, invalidAt: now, source: 'event', text: '已作废经历' },
    { id: 'diary', at: now, source: 'diary', text: '旧日记' },
    { id: 'forgot', at: now, source: 'event', forgottenAt: now, text: '忘掉的经历' },
    { id: 'guess', at: now, source: 'event', status: 'guess', text: '猜测经历' },
    { id: 'stranger', at: now, source: 'event', chatId: 'group:99999', text: '外群私事' })
  f.lines.push({ t: now, chatId: 'group:99999', who: '某人', text: '外群秘密' })
  const facts = diaryEvidence(f.cfg(), f.api.core.hub, f.api.use('memory'), now)
  assert.ok(facts.some((x) => x.text === '给爸爸画了一条鱼'))
  assert.ok(facts.some((x) => x.text === '画完啦' && x.contextOnly))
  assert.doesNotMatch(JSON.stringify(facts), /昨天的经历|旧日记|忘掉的经历|猜测经历|外群|昨天发生|已作废/)
})

test('即使图文模式开启，也从完整生活取材，只向家庭群发文字；成功才记忆', async () => {
  const f = fixture(), r = await f.diary.writeDiary()
  assert.equal(r.ok, true)
  assert.equal(f.sent[0].chatId, 'group:20001')
  assert.equal(f.added[0].source, 'diary')
  assert.match(f.added[0].text, /家庭群/)
  assert.match(f.prompts[0][2], /给爸爸画了一条鱼/)
  assert.equal(f.prompts[0][3].stateless, true)
  assert.equal(f.prompts[0][3].noTools, true)
})

test('预览无群发送、历史、记忆、排期写入；发送重新生成', async () => {
  const f = fixture(), before = readJson(dataDir('family-diary.json'))
  const p = await f.diary.writeDiary({ preview: true })
  assert.equal(p.preview, true)
  assert.equal(f.sent.length, 0); assert.equal(f.added.length, 0)
  assert.deepEqual(readJson(dataDir('family-diary.json')), before)
  await f.diary.writeDiary()
  assert.equal(f.prompts.length, 4)
})

test('没有家庭群、已关闭、静音时不生成、不回退空间或私聊', async () => {
  for (const patch of [{ familyGroups: [] }, { enabled: false }, { diary: { enabled: false } }]) {
    const f = fixture(); f.update(patch)
    assert.equal((await f.diary.writeDiary()).ok, false)
    assert.equal(f.prompts.length, 0); assert.equal(f.sent.length, 0)
  }
  const f = fixture(); f.mute()
  assert.equal((await f.diary.writeDiary()).ok, false)
})

test('写作期间撤销群授权、关闭、进入试运行或卸载均不实际发', async () => {
  for (const change of [(f) => f.update({ familyGroups: [] }), (f) => f.update({ enabled: false }), (f) => f.update({ dryRun: true }), (f) => f.diary.dispose()]) {
    const f = fixture(); f.during(() => change(f))
    await f.diary.writeDiary()
    assert.equal(f.sent.length, 0); assert.equal(f.added.length, 0)
  }
})

test('没有今日素材不编造；自动可以沉默；试运行不计成功', async () => {
  const f = fixture(); f.events.length = 0; f.lines.length = 0
  assert.equal((await f.diary.writeDiary()).skipped, true)
  assert.equal(f.prompts.length, 0)
  const g = fixture(); g.reply({ text: '', nextMinutes: 3 })
  assert.equal((await g.diary.writeDiary({ automatic: true })).skipped, true)
  assert.equal(g.added.length, 0)
  const h = fixture(); h.update({ dryRun: true })
  assert.equal((await h.diary.writeDiary()).dryRun, true)
  assert.equal(h.sent.length, 0); assert.equal(h.diary.history().length, 0)
})

test('自动发言不受旧的每天次数和时段限制；同一素材重启不重复，新增经历可再分享', async () => {
  const f = fixture()
  await f.diary.tick()
  assert.equal(f.sent.length, 1)
  const saved = readJson(dataDir('family-diary.json')); saved.nextAt = 0
  writeJson(dataDir('family-diary.json'), saved)
  await createFamilyDiary(f.api).tick()
  assert.equal(f.sent.length, 1)
  await new Promise((resolve) => setTimeout(resolve, 2))
  f.events.push({ id: 'song', source: 'event', at: Date.now(), tags: ['翻唱'], text: '唱完一首歌' })
  f.reply({ text: '刚刚唱完一首歌。' })
  await f.diary.tick()
  assert.equal(f.sent.length, 2)
})

test('失败或无回执不记成功记忆；部分成功逐群记录，不盲重发', async () => {
  const f = fixture(); f.update({ familyGroups: ['20001', '20002'] })
  const send = f.api.core.hub.sendText
  f.api.core.hub.sendText = (...args) => args[0] === 'group:20002' ? null : send(...args)
  const r = await f.diary.writeDiary()
  assert.equal(r.ok, false)
  assert.equal(f.added.length, 1)
  assert.equal(f.diary.history().filter((x) => x.ok).length, 1)
  const saved = readJson(dataDir('family-diary.json')); saved.nextAt = 0
  writeJson(dataDir('family-diary.json'), saved)
  await f.diary.tick()
  assert.equal(f.sent.length, 1)
})

test('并发只写一次，坏 JSON 不发并为自动判断退避', async () => {
  const f = fixture()
  const first = f.diary.writeDiary(), second = await f.diary.writeDiary()
  assert.equal(second.ok, false); await first
  assert.equal(f.sent.length, 1)
  const g = fixture(); g.reply('invalid')
  assert.equal((await g.diary.writeDiary()).ok, false)
  assert.equal(g.sent.length, 0)
  assert.ok(readJson(dataDir('family-diary.json')).nextAt > Date.now())
})


test('预览失败也不改排期；素材满额时刚分享的日记不会挤出旧证据触发重发', async () => {
  const f = fixture(), before = readJson(dataDir('family-diary.json'))
  f.reply('bad-json')
  assert.equal((await f.diary.writeDiary({ preview: true })).ok, false)
  assert.deepEqual(readJson(dataDir('family-diary.json')), before)
  const g = fixture(), now = Date.now()
  g.lines.push(...Array.from({ length: 100 }, (_, i) => ({ t: now - i, chatId: 'private:10001', who: 'bot', text: `画图细节${i}` })))
  await g.diary.tick()
  const saved = readJson(dataDir('family-diary.json')); saved.nextAt = 0
  writeJson(dataDir('family-diary.json'), saved)
  await createFamilyDiary(g.api).tick()
  assert.equal(g.sent.length, 1)
})

test('兼容旧日记历史：自己又表态或旧事件更新，都不能触发全天重写', async () => {
  const f = fixture(), now = Date.now()
  writeJson(dataDir('family-diary.json'), { history: [{ at: now, ok: true, groupId: '20001', text: '已经写过画鱼了' }], considered: {}, nextAt: 0 })
  f.lines.push({ t: now, chatId: 'group:20001', who: 'bot', text: '我不催她 等她缓过来' })
  f.events[0].saidAt = now - 1000; f.events[0].at = now
  assert.equal((await f.diary.writeDiary({ automatic: true })).skipped, true)
  assert.equal((await f.diary.writeDiary()).skipped, true)
  assert.equal(f.prompts.length, 0); assert.equal(f.sent.length, 0)
})

test('新事实和旧背景分开，只有新增事实可作正文引用，发送中出现的新事留给下次', async () => {
  const f = fixture(), cutoff = Date.now() - 100
  f.events[0].at = cutoff - 100
  writeJson(dataDir('family-diary.json'), { history: [{ at: cutoff, ok: true, groupId: '20001', text: '画完了' }], considered: {}, nextAt: 0 })
  f.lines.push({ t: cutoff + 1, chatId: 'private:10001', who: '爸爸', text: '那不是赶你，她在开玩笑' })
  f.reply({ text: '爸爸说妈妈刚才是在开玩笑，是我会错意了。' })
  let arrived = false
  f.during(async () => {
    if (arrived) return
    arrived = true
    await new Promise((resolve) => setTimeout(resolve, 2))
    f.events.push({ id: 'later', source: 'event', at: Date.now(), text: '看完一个新视频' })
  })
  await f.diary.writeDiary()
  const entry = f.diary.history()[0]
  assert.equal(entry.evidenceIds.length, 1)
  assert.ok(entry.evidenceIds[0].startsWith('chat:'))
  assert.ok(entry.evidenceThrough < f.events.at(-1).at)
  f.reply({ text: '刚看了个新视频。' })
  await f.diary.writeDiary()
  assert.deepEqual(f.diary.history()[0].evidenceIds, ['event:later'])
  assert.equal(f.sent.length, 2)
})

test('挂旧编号或没有新增依据的日记不发送，也不进入事实核对', async () => {
  for (const evidenceIds of [[], ['event:not-present'], ['event:draw', 'event:not-present']]) {
    const f = fixture(); f.reply({ text: '爸爸刚给我装了日记本。', evidenceIds })
    const r = await f.diary.writeDiary({ preview: true })
    assert.equal(r.skipped, true); assert.equal(f.prompts.length, 1)
    assert.equal(f.sent.length, 0); assert.equal(f.added.length, 0)
  }
})

test('发送前语义核对拦住借新寒暄复述旧事、添情节的草稿；相同资料不自动反复生成', async () => {
  const f = fixture()
  f.review({ accept: false, reason: '新增依据只是寒暄，主体重复旧事，还编了练歌' })
  const r = await f.diary.writeDiary({ automatic: true })
  assert.equal(r.skipped, true); assert.equal(f.sent.length, 0); assert.equal(f.added.length, 0)
  assert.equal(f.diary.history().length, 0)
  assert.match(f.prompts[1][2], /自己的历史发言只证明说过|家人更正/)
  const saved = readJson(dataDir('family-diary.json')); saved.nextAt = 0; writeJson(dataDir('family-diary.json'), saved)
  f.lines.push(...Array.from({ length: 100 }, (_, i) => ({ t: Date.now(), chatId: 'group:20001', who: 'bot', text: `我又说了一句${i}` })))
  await createFamilyDiary(f.api).tick()
  assert.equal(f.prompts.length, 2)
  f.review({ accept: true }); await f.diary.writeDiary()
  assert.equal(f.sent.length, 1)
})

test('核对失败或预览拒绝都不发群、不记成功，预览不修改排期', async () => {
  for (const review of ['not-json', { accept: false, reason: '重复' }, { accept: 'true' }]) {
    const f = fixture(), before = readJson(dataDir('family-diary.json'))
    f.review(review)
    await f.diary.writeDiary({ preview: true })
    assert.equal(f.sent.length, 0); assert.equal(f.added.length, 0)
    assert.deepEqual(readJson(dataDir('family-diary.json')), before)
  }
})

test('仅改变标点的重复草稿直接跳过；短日记不为凑字数被拒绝', async () => {
  const f = fixture(), cutoff = Date.now() - 100
  writeJson(dataDir('family-diary.json'), { history: [{ at: cutoff, ok: true, groupId: '20001', text: '画了一条鱼。' }], considered: {}, nextAt: 0 })
  f.reply({ text: '画了 一条鱼！' })
  assert.equal((await f.diary.writeDiary()).skipped, true)
  assert.equal(f.sent.length, 0); assert.equal(f.prompts.length, 1)
  const g = fixture(); g.reply({ text: '画了条鱼，挺喜欢。' })
  assert.equal((await g.diary.writeDiary()).ok, true)
  assert.equal(g.sent.length, 1)
})

test('当前日记状态从真实成功记录派生，失败不冒充已写，重载后仍可查', async () => {
  const f = fixture()
  assert.match(f.diary.contextNote(), /今天已经向家庭群成功分享 0 篇/)
  await f.diary.writeDiary()
  assert.match(createFamilyDiary(f.api).contextNote(), /今天已经向家庭群成功分享 1 篇/)
  const saved = readJson(dataDir('family-diary.json'))
  saved.history.unshift({ at: Date.now(), ok: false, groupId: '20001', text: '未送达' })
  writeJson(dataDir('family-diary.json'), saved)
  assert.match(f.diary.contextNote(), /今天已经向家庭群成功分享 1 篇/)
})
