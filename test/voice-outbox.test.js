import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVoiceOutbox } from '../src/voice/outbox.js'
import { OneBotError } from '../src/onebot/client.js'

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
function rig(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-voice-outbox-')), file = join(dir, 'voice-outbox.json'), source = join(dir, 'voice.wav')
  writeFileSync(source, 'audio-fixture')
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  let allowed = true, online = true, at = 1000, synthCount = 0
  const sent = [], recorded = [], workers = []
  const worker = (patch = {}) => {
    const w = createVoiceOutbox({ file, now: () => at, authorized: () => allowed, connected: () => online,
      synthesize: async () => { synthCount++; return { file: source, engine: 'test' } },
      send: async (job, audio, c) => {
        if (!c.beforeSubmit()) return null
        sent.push({ id: job.id, audio: readFileSync(audio, 'utf8') })
        const receipt = { message_id: String(sent.length) }
        c.onReceipt(receipt); c.onRecorded()
        return receipt
      },
      record: (j) => recorded.push(j.messageId), log: { warn() {}, debug() {} }, ...patch })
    workers.push(w); t.after(() => w.dispose()); return w
  }
  return { dir, file, source, worker, sent, recorded, synthCount: () => synthCount,
    allow: (v) => { allowed = v }, online: (v) => { online = v }, advance: (n) => { at += n },
    input: { chatId: 'group:20001', text: '你好', spoken: '你好', tone: '', botQQ: '30001' },
    disk: () => JSON.parse(readFileSync(file, 'utf8')), save: (v) => writeFileSync(file, JSON.stringify(v)) }
}

test('合成中热重载，新实例等旧合成完成后接续成品一次，不重复合成', async (t) => {
  const r = rig(t), audio = deferred(), entered = deferred()
  const old = r.worker({ synthesize: async () => { entered.resolve(); return audio.promise } })
  const job = old.enqueue(r.input), writing = old.run(job.id)
  await entered.promise
  assert.equal(r.disk().jobs[0].status, 'synthesizing')
  old.dispose()
  const fresh = r.worker()
  await fresh.recover()
  assert.equal(r.synthCount(), 0); assert.equal(r.sent.length, 0)
  audio.resolve({ file: r.source, engine: 'test' }); await writing
  assert.equal(r.disk().jobs[0].status, 'ready')
  unlinkSync(r.source)
  await fresh.recover(); await fresh.recover()
  assert.equal(r.sent.length, 1); assert.equal(r.sent[0].audio, 'audio-fixture')
  assert.equal(r.synthCount(), 0)
  assert.equal(r.disk().jobs[0].status, 'sent')
})

test('提交后重载，迟到成功回执仍保存；新实例仅补记一次，不再发', async (t) => {
  const r = rig(t), response = deferred(), submitted = deferred()
  const old = r.worker({ send: async (_j, _file, c) => {
    assert.equal(c.beforeSubmit(), true); submitted.resolve()
    const receipt = await response.promise; c.onReceipt(receipt); return receipt
  } })
  const job = old.enqueue(r.input), sending = old.run(job.id)
  await submitted.promise; old.dispose()
  const fresh = r.worker(); await fresh.recover()
  assert.equal(r.disk().jobs[0].status, 'submitting')
  response.resolve({ message_id: 'late-ack' }); await sending
  await fresh.recover(); await fresh.recover()
  assert.equal(r.sent.length, 0); assert.deepEqual(r.recorded, ['late-ack'])
  assert.equal(r.disk().jobs[0].status, 'sent'); assert.equal(r.disk().jobs[0].recorded, true)
})

test('进程重启时提交状态未知，标记不确定；合成阶段可重新生成', async (t) => {
  const r = rig(t), old = r.worker(), j = old.enqueue(r.input)
  const disk = r.disk(); disk.jobs[0].status = 'submitting'; r.save(disk); old.dispose()
  const fresh = r.worker(); await fresh.recover(); await fresh.recover()
  assert.equal(fresh.get(j.id).status, 'uncertain'); assert.equal(r.sent.length, 0)
  const k = fresh.enqueue(r.input), disk2 = r.disk()
  disk2.jobs.find((x) => x.id === k.id).status = 'synthesizing'; r.save(disk2)
  await fresh.recover()
  assert.equal(fresh.get(k.id).status, 'sent'); assert.equal(r.synthCount(), 1); assert.equal(r.sent.length, 1)
})

for (const receipt of [null, {}, { message_id: '' }, { message_id: 0 }, { message_id: 'sim-1' }]) test('无有效回执不当成功也不自动重发：' + JSON.stringify(receipt), async (t) => {
  const r = rig(t)
  let calls = 0
  const w = r.worker({ send: async (_j, _f, c) => { c.beforeSubmit(); calls++; c.onReceipt(receipt); return receipt } })
  const j = w.enqueue(r.input); await w.run(j.id); await w.recover()
  assert.equal(w.get(j.id).status, 'uncertain'); assert.equal(calls, 1); assert.equal(r.recorded.length, 0)
})

test('提交超时不重发；明确拒绝保留失败而不自动重复', async (t) => {
  for (const uncertain of [true, false]) {
    const r = rig(t), error = new OneBotError('send_group_msg', { status: 'failed', retcode: 1, message: uncertain ? '超时' : '明确拒绝' }, { uncertain })
    const w = r.worker({ send: async (_j, _f, c) => { c.beforeSubmit(); c.onSubmitError(error); throw error } })
    const j = w.enqueue(r.input); await w.run(j.id); await w.recover()
    assert.equal(w.get(j.id).status, uncertain ? 'uncertain' : 'failed')
    assert.equal(r.sent.length, 0)
  }
})

test('关闭或撤权、取消、过期时不能接续；合成后再次复查权限', async (t) => {
  for (const mode of ['revoke', 'cancel', 'expire']) {
    const r = rig(t), audio = deferred(), entered = deferred()
    const w = r.worker({ synthesize: async () => { entered.resolve(); return audio.promise } })
    const j = w.enqueue(r.input), pending = w.run(j.id); await entered.promise
    if (mode === 'revoke') r.allow(false)
    if (mode === 'cancel') w.cancel(j.id)
    if (mode === 'expire') r.advance(600001)
    audio.resolve({ file: r.source, engine: 'test' }); await pending; await w.recover()
    assert.equal(w.get(j.id).status, 'cancelled'); assert.equal(r.sent.length, 0)
  }
})

test('网关尚未恢复时保留成品，恢复后只发一次', async (t) => {
  const r = rig(t), w = r.worker(); r.online(false)
  const j = w.enqueue(r.input); await w.run(j.id)
  assert.equal(w.get(j.id).status, 'ready'); assert.equal(r.synthCount(), 1)
  await w.recover(); r.online(true); await w.recover(); await w.recover()
  assert.equal(r.sent.length, 1); assert.equal(r.synthCount(), 1)
})

test('坏账本和越界音频路径停止发送，不读取候选外文件', async (t) => {
  const r = rig(t), w = r.worker(), j = w.enqueue(r.input)
  const disk = r.disk(); disk.jobs[0].status = 'ready'; disk.jobs[0].audio = '../voice.wav'; r.save(disk)
  await w.recover(); assert.equal(w.get(j.id).status, 'failed'); assert.equal(r.sent.length, 0)
  writeFileSync(r.file, '{broken')
  assert.throws(() => w.enqueue(r.input)); await w.recover()
  assert.equal(r.sent.length, 0)
})

test('记录成功后清理暂存音频，原缓存不动', async (t) => {
  const r = rig(t), w = r.worker(), j = w.enqueue(r.input)
  await w.run(j.id)
  assert.equal(existsSync(r.source), true)
  assert.equal(existsSync(join(r.dir, 'voice-outbox-audio', j.id + '.wav')), false)
})
