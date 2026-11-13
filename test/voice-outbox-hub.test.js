import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { normalize } from '../src/core/config.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { createHub } from '../src/chat/hub.js'
import { OneBotError } from '../src/onebot/client.js'

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate) }
const logs = (hub) => hub.chatLogDays().flatMap((day) => hub.chatLogOf(day))
function rig(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-voice-outbox-hub-'))
  process.env.AURABOT_DATA_DIR = dir
  const file = join(dir, 'audio.wav'); writeFileSync(file, 'test-audio')
  const cfg = normalize({ enabled: true, dryRun: false, botQQ: '30001', ownerQQ: '10001', familyGroups: ['20001'], voice: { enabled: true }, stickers: { faces: false } })
  const calls = [], warnings = [], hubs = []
  t.after(() => { for (const h of hubs) h.dispose(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) })
  const hub = (patch = {}) => {
    const fake = createFakeDsh({ brain: async () => '' }); t.after(() => fake.dispose())
    const h = createHub({ dsh: fake.ctx, getConfig: () => cfg,
      log: { info() {}, debug() {}, error() {}, warn: (...s) => warnings.push(s.join(' ')) },
      tts: { speak: async () => ({ file, engine: 'test' }) },
      onebot: { state: 'connected', async call(action, params) { calls.push({ action, params }); return { message_id: String(calls.length) } } }, ...patch })
    hubs.push(h); return h
  }
  return { dir, file, cfg, calls, warnings, hub }
}

test('真实hub：合成中卸载，下一实例从暂存音频发送并记一次回执', async (t) => {
  const r = rig(t), audio = deferred(), entered = deferred()
  const old = r.hub({ tts: { async speak() { entered.resolve(); return audio.promise } } })
  const work = old.sendVoice('group:20001', '你好呀'); await entered.promise; old.dispose()
  const fresh = r.hub(); await fresh.recoverVoice()
  audio.resolve({ file: r.file, engine: 'test' }); assert.equal(await work, false)
  await fresh.recoverVoice(); await fresh.recoverVoice()
  assert.equal(r.calls.length, 1); assert.equal(r.calls[0].params.message[0].type, 'record')
  assert.equal(fresh.voiceOutboxStatus()[0].status, 'sent')
  assert.equal(fresh.voiceOutboxStatus()[0].recorded, true)
  assert.equal(logs(fresh).filter((x) => x.who === 'bot' && x.text === '你好呀').length, 1)
})

test('真实hub：等待发送钩子时卸载，明确未提交的语音由新实例接续', async (t) => {
  const r = rig(t), hold = deferred(), entered = deferred()
  const old = r.hub({ hooks: { send: async (segments) => { entered.resolve(); await hold.promise; return segments } } })
  const work = old.sendVoice('group:20001', '我在这里'); await entered.promise; old.dispose()
  const fresh = r.hub(); hold.resolve(); await work; await fresh.recoverVoice()
  assert.equal(r.calls.length, 1); assert.equal(fresh.voiceOutboxStatus()[0].status, 'sent')
})

test('真实hub：提交后卸载仍保存迟到回执，接续只补记、不再提交', async (t) => {
  const r = rig(t), response = deferred(), entered = deferred()
  const old = r.hub({ onebot: { state: 'connected', async call() { entered.resolve(); return response.promise } } })
  const work = old.sendVoice('group:20001', '迟到的回执'); await entered.promise; old.dispose()
  const fresh = r.hub(); response.resolve({ message_id: 'late' }); await work
  await fresh.recoverVoice(); await fresh.recoverVoice()
  assert.equal(r.calls.length, 0)
  assert.equal(logs(fresh).filter((x) => x.messageId === 'late').length, 1)
  assert.equal(fresh.voiceOutboxStatus()[0].status, 'sent')
})

test('真实hub：没有回执不记成功也不重发；明确失败才转文字', async (t) => {
  for (const mode of ['empty', 'timeout', 'refused']) {
    const r = rig(t)
    const h = r.hub({ onebot: { state: 'connected', async call(action, params) {
      r.calls.push({ action, params })
      if (params.message[0].type === 'text') return { message_id: 'text-fallback' }
      if (mode === 'empty') return {}
      throw new OneBotError(action, { status: 'failed', retcode: 1, message: mode === 'timeout' ? '超时' : '拒绝' }, { uncertain: mode === 'timeout' })
    } } })
    assert.equal(await h.sendVoice('group:20001', '试一下'), false)
    await h.recoverVoice()
    assert.equal(r.calls.filter((x) => x.params.message[0].type === 'record').length, 1)
    assert.equal(r.calls.length, mode === 'refused' ? 2 : 1)
    assert.equal(h.voiceOutboxStatus()[0].status, mode === 'refused' ? 'failed' : 'uncertain')
    assert.equal(logs(h).some((x) => x.who === 'bot' && x.text === '试一下'), mode === 'refused')
  }
})

test('真实hub：撤销家庭群、关语音、关模块或静音后不补发', async (t) => {
  for (const change of ['group', 'voice', 'module', 'mute']) {
    const r = rig(t), audio = deferred(), entered = deferred()
    let available = true, muted = false
    const old = r.hub({ tts: { available: () => available, async speak() { entered.resolve(); return audio.promise } }, isMuted: () => muted })
    const work = old.sendVoice('group:20001', '给家里的话'); await entered.promise
    if (change === 'group') r.cfg.familyGroups = []
    if (change === 'voice') r.cfg.voice.enabled = false
    if (change === 'module') available = false
    if (change === 'mute') muted = true
    audio.resolve({ file: r.file, engine: 'test' }); await work; await old.recoverVoice()
    assert.equal(r.calls.length, 0); assert.equal(old.voiceOutboxStatus()[0].status, 'cancelled')
  }
})

test('真实hub：capture和语音测试不进入可自动续发的账本', async (t) => {
  const r = rig(t), h = r.hub()
  const preview = await h.capture(() => h.sendVoice('group:20001', '这是预览'))
  assert.equal(preview.sent.length, 1)
  assert.equal(existsSync(join(r.dir, 'voice-outbox.json')), false)
  await h.withoutRecord(() => h.sendVoice('group:20001', '这是测试'))
  assert.equal(existsSync(join(r.dir, 'voice-outbox.json')), false)
})

test('真实hub：明确群限速只重试被拒绝的语音，提交状态允许这一次重试', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const r = rig(t), h = r.hub({ onebot: { state: 'connected', async call(action, params) {
    r.calls.push({ action, params })
    if (r.calls.length === 1) throw new OneBotError(action, { status: 'failed', retcode: 1, message: '每分钟只能发 1 条' })
    return { message_id: 'retry-ack' }
  } } })
  const work = h.sendVoice('group:20001', '限速之后再发')
  await settle(); assert.equal(r.calls.length, 1)
  t.mock.timers.tick(61001); await settle()
  assert.equal(await work, true); assert.equal(r.calls.length, 2)
  await h.recoverVoice(); assert.equal(r.calls.length, 2)
})
