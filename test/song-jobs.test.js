// 翻唱任务账本：做成没发出去的成品要留住、热重载后能查能补发、补发走白名单、不再硬报「两三分钟」。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let studio
let normalize
const log = { info() {}, warn() {}, debug() {} }

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-songjobs-'))
  studio = await import('../src/song/studio.js')
  ;({ normalize } = await import('../src/core/config.js'))
})

/** 每个用例一个独立数据目录：账本就在 AURABOT_DATA_DIR/song-jobs.json */
function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-sj-'))
  process.env.AURABOT_DATA_DIR = dir
  return dir
}
const jobsFile = (dir) => join(dir, 'song-jobs.json')
const seed = (dir, state) => writeFileSync(jobsFile(dir), JSON.stringify({ v: 1, savedAt: Date.now(), pending: [], history: [], queue: [], current: null, ...state }))
const readJobs = (dir) => JSON.parse(readFileSync(jobsFile(dir), 'utf8'))
const fakeMp3 = (dir, name = 'cover.mp3') => {
  const file = join(dir, name)
  writeFileSync(file, Buffer.alloc(4096, 3))
  return file
}

function makeStudio({ reply = async () => ({ message_id: 'm-1' }), cfg } = {}) {
  const calls = []
  const config = cfg || normalize({ ownerQQ:'10000001', familyGroups:['90000001'], song: { enabled: true, root: mkdtempSync(join(tmpdir(), 'rvc-')) } })
  const s = studio.createSongStudio({
    getConfig: () => config,
    log,
    sendVoiceFile: async (...args) => { calls.push(args); return reply(...args) },
  })
  return { s, calls, config }
}

test('时长说法：没有实测就不承诺分钟，有实测按实测说', () => {
  assert.doesNotMatch(studio.estimateNote([]), /两三分钟|\d+\s*分钟/)
  assert.match(studio.estimateNote([{ ok: true, seconds: 1178 }]), /20 分钟/)
  assert.match(studio.estimateNote([{ ok: true, seconds: 40 }]), /一两分钟/)
  assert.match(studio.estimateNote([{ ok: false, seconds: 900 }]), /不承诺|忙不忙/, '失败的记录不算实测')
  // 只有成功且有秒数的才算
  assert.doesNotMatch(studio.estimateNote([{ ok: true }]), /分钟/)
})

test('账本：写得进、读得回；一秒内的密集写盘会合并，terminate 时强制写', () => {
  const dir = freshDir()
  const ledger = studio.createSongLedger({ file: jobsFile(dir), log })
  assert.equal(ledger.save({ queue: [{ query: 'a' }], current: null, history: [], pending: [] }), true)
  assert.equal(ledger.save({ queue: [{ query: 'b' }], current: null, history: [], pending: [] }), false, '一秒内合并')
  assert.equal(readJobs(dir).queue[0].query, 'a')
  assert.equal(ledger.save({ queue: [{ query: 'c' }], current: null, history: [], pending: [] }, { force: true }), true)
  assert.deepEqual(ledger.read().queue, [{ query: 'c' }])
  assert.deepEqual(studio.createSongLedger({ file: join(dir, 'nope.json'), log }).read(), { queue: [], current: null, history: [], pending: [] })
})

test('热重载后读回账本：正在做的、排队的都进待补发，但绝不自动发', () => {
  const dir = freshDir()
  const file = fakeMp3(dir)
  seed(dir, {
    current: { query: '小幸运 田馥甄', title: '小幸运', chatId: 'group:90000001', stage: '发送', startedAt: Date.now() - 60_000, file, cacheKey: 'k1', pitch: 0, acapella: false },
    queue: [{ query: '晴天', chatId: 'private:1', pitch: 12, acapella: false, at: Date.now() - 30_000 }],
  })
  const { s, calls } = makeStudio()
  assert.equal(calls.length, 0, '启动不能自动补发')
  const list = s.pending()
  assert.equal(list.length, 2)
  const made = list.find((p) => p.chatId === 'group:90000001')
  assert.equal(made.made, true)
  assert.equal(made.file, file)
  assert.match(made.reason, /重载/)
  const queued = list.find((p) => p.chatId === 'private:1')
  assert.equal(queued.made, false)
  assert.match(queued.reason, /队里/)
  // 账本自己也更新了：再重载一次还在
  const again = studio.createSongStudio({ getConfig: () => normalize({ song: { enabled: true, root: dir } }), log, sendVoiceFile: async () => ({ message_id: 'x' }) })
  assert.equal(again.pending().length, 2, '重载两次不会丢也不会翻倍')
})

test('补发：有成品直接发到原来的目标，成功后从待补发里消失并记下回执', async () => {
  const dir = freshDir()
  const file = fakeMp3(dir)
  seed(dir, { pending: [{ id: 'p1', at: Date.now(), query: '小幸运 田馥甄', title: '小幸运 田馥甄', chatId: 'group:90000001', file, made: true, pitch: 0, acapella: false }] })
  const { s, calls } = makeStudio({ reply: async () => ({ message_id: 'm-42' }) })
  const r = await s.resend('p1', { canSend: () => '' })
  assert.equal(r.ok, true, r.message)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'group:90000001')
  assert.equal(calls[0][1], file)
  assert.match(calls[0][2], /翻唱/)
  assert.equal(s.pending().length, 0)
  const history = s.status().history
  assert.equal(history[0].messageId, 'm-42')
  assert.equal(history[0].ok, true)
  assert.deepEqual(readJobs(dir).pending, [], '补发成功后账本里也删掉')
})

test('补发：撤销授权、关掉开关、白名单外都不许发，成品留着', async () => {
  const dir = freshDir()
  const file = fakeMp3(dir)
  seed(dir, { pending: [{ id: 'p1', at: Date.now(), query: '小幸运', title: '小幸运', chatId: 'group:999', file, made: true, pitch: 0, acapella: false }] })
  const off = makeStudio({ cfg: normalize({ familyGroups:['999'], song: { enabled: false, root: dir } }) })
  assert.equal((await off.s.resend('p1', { canSend: () => '' })).ok, false)
  assert.match((await off.s.resend('p1', { canSend: () => '' })).message, /开关/)
  const on = makeStudio()
  const denied = await on.s.resend('p1', { canSend: () => '这个群不在白名单里，不能发' })
  assert.equal(denied.ok, false)
  assert.match(denied.message, /语音仅限|白名单/)
  assert.equal(on.calls.length, 0)
  assert.equal(on.s.pending().length, 1, '发不出去也不能把成品记录删掉')
})

test('补发：网关没给回执不算送达，保留并计数；抛错也不能丢成品', async () => {
  const dir = freshDir()
  const file = fakeMp3(dir)
  const entry = { id: 'p1', at: Date.now(), query: '小幸运', title: '小幸运', chatId: 'group:90000001', file, made: true, pitch: 0, acapella: false }
  seed(dir, { pending: [entry] })
  const silent = makeStudio({ reply: async () => null })
  const r1 = await silent.s.resend('p1', { canSend: () => '' })
  assert.equal(r1.ok, false)
  assert.match(r1.message, /没确认/)
  assert.equal(silent.s.pending()[0].tries, 1)

  const dir2 = freshDir()
  const file2 = fakeMp3(dir2)
  seed(dir2, { pending: [{ ...entry, id: 'p2', file: file2 }] })
  const boom = makeStudio({ reply: async () => { throw new Error('网关超时') } })
  const r2 = await boom.s.resend('p2', { canSend: () => '' })
  assert.equal(r2.ok, false)
  assert.match(r2.message, /网关超时/)
  assert.equal(boom.s.pending().length, 1)
  assert.equal(boom.s.pending()[0].reason, '网关超时')
})

test('补发：条目没有成品就照原样重做，环境没好时如实说没做成、不删记录', async () => {
  const dir = freshDir()
  seed(dir, { pending: [{ id: 'p1', at: Date.now(), query: '晴天', songId: '186016', chatId: 'private:10000001', made: false, pitch: 12, acapella: false }] })
  const { s } = makeStudio()
  const r = await s.resend('p1', { canSend: () => '' })
  assert.equal(r.ok, false)
  assert.match(r.message, /还没装好/)
  assert.equal(s.pending().length, 1)
  assert.equal((await s.resend('nope', { canSend: () => '' })).ok, false)
  assert.match((await s.resend('nope', { canSend: () => '' })).message, /没有待补发/)
})

test('点歌时正好有同曲的待补发成品：只补发、不重做；太旧或参数不同就不算', async () => {
  const dir = freshDir()
  const file = fakeMp3(dir)
  const at = Date.now() - 60_000
  seed(dir, {
    pending: [
      { id: 'p1', at, query: '小幸运 田馥甄', title: '小幸运 田馥甄', songId: '3343236872', chatId: 'group:90000001', file, made: true, pitch: 0, acapella: false },
      { id: 'p2', at: Date.now() - 7 * 60 * 60_000, query: '晴天', title: '晴天', chatId: 'group:90000001', file, made: true, pitch: 0, acapella: false },
    ],
  })
  const { s } = makeStudio()
  assert.equal(s.findPendingFor({ song: '小幸运', pitch: 0 })?.id, 'p1')
  assert.equal(s.findPendingFor({ songId: '3343236872' })?.id, 'p1')
  assert.equal(s.findPendingFor({ song: '小幸运', pitch: 12 }), null, '变调不同不是同一首')
  assert.equal(s.findPendingFor({ song: '晴天' }), null, '七小时前的旧成品不拿来当新歌发')
  assert.equal(s.findPendingFor({ song: '稻香' }), null)
})

test('面板接口：补发接口在，白名单外的群拒绝、名单内的群放行', async () => {
  const dir = freshDir()
  const file = fakeMp3(dir)
  seed(dir, {
    pending: [
      { id: 'bad', at: Date.now(), query: '小幸运', title: '小幸运', chatId: 'group:999', file, made: true, pitch: 0, acapella: false },
      { id: 'ok', at: Date.now(), query: '小幸运', title: '小幸运', chatId: 'group:90000001', file, made: true, pitch: 0, acapella: false },
    ],
  })
  const definition = (await import('../src/modules/song/index.js')).default
  const routes = new Map()
  const sent = []
  const cfg = normalize({ song: { enabled: true, root: dir }, familyGroups: ['90000001'], ownerQQ: '10000001' })
  definition.setup({
    config: () => cfg, log, lazy: () => ({}), onDispose() {}, every() {}, rule() {}, emit() {}, tool() {},
    route: (path, run) => routes.set(path, run),
    core: {
      hub: { turnSendersAllOwner: () => true, sendVoiceFile: async (...args) => { sent.push(args); return { message_id: 'm-9' } } },
      local: { active: () => false },
      http: { body: async () => body, query: () => ({}) },
    },
  })
  assert.ok(routes.has('/song/pending') && routes.has('/song/resend'))
  let body = { id: 'bad' }
  const denied = await routes.get('/song/resend')({})
  assert.equal(denied.ok, false)
  assert.match(denied.message, /语音仅限|白名单/)
  assert.equal(sent.length, 0)
  body = { id: 'ok' }
  const allowed = await routes.get('/song/resend')({})
  assert.equal(allowed.ok, true, allowed.message)
  assert.equal(sent[0][0], 'group:90000001')
  assert.equal(existsSync(file), true)
})
