// 语音条变声（用翻唱里导入的 RVC 音色）：配置归一化 + 组合逻辑（不跑真 RVC）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalize } from '../src/core/config.js'
import { createSongVoice } from '../src/voice/rvc.js'

test('语音变声配置：默认不变声；变调夹在 ±24 半音', () => {
  const d = normalize({})
  assert.equal(d.voice.songVoice, '')
  assert.equal(d.voice.songPitch, 0)
  assert.equal(normalize({ voice: { songPitch: 99 } }).voice.songPitch, 24)
  assert.equal(normalize({ voice: { songPitch: -99 } }).voice.songPitch, -24)
  assert.equal(normalize({ voice: { songPitch: 'abc' } }).voice.songPitch, 0)
  assert.equal(normalize({ voice: { songVoice: 'x'.repeat(300) } }).voice.songVoice.length, 120)
})

test('没选翻唱音色时，语音保持 TTS 原声', async () => {
  const conv = createSongVoice({ getConfig: () => ({ voice: { songVoice: '' } }), getSong: () => { throw new Error('不该调用') }, dataDir: () => '/tmp/x' })
  assert.equal(await conv('/tmp/a.wav'), '/tmp/a.wav')
})

test('翻唱模块没在跑时，语音保持 TTS 原声', async () => {
  const conv = createSongVoice({ getConfig: () => ({ voice: { songVoice: 'my-voice', songPitch: 12 } }), getSong: () => null, dataDir: () => '/tmp/x' })
  assert.equal(await conv('/tmp/a.wav'), '/tmp/a.wav')
})

test('选了翻唱音色时，用对应音色和变调调 RVC，返回变声后的文件', async () => {
  const calls = []
  const conv = createSongVoice({
    getConfig: () => ({ voice: { songVoice: 'my-voice', songPitch: 12 } }),
    getSong: () => ({ convertSpeech: async (file, opts) => { calls.push({ file, opts }); return '/tmp/out.wav' } }),
    dataDir: (sub) => '/tmp/data/' + sub,
  })
  assert.equal(await conv('/tmp/a.wav'), '/tmp/out.wav')
  assert.deepEqual(calls, [{ file: '/tmp/a.wav', opts: { voice: 'my-voice', pitch: 12, outDir: '/tmp/data/voice-rvc' } }])
})

test('变声出错会抛出（由 tts 层兜底用原声），不会静默返回错误文件', async () => {
  const conv = createSongVoice({
    getConfig: () => ({ voice: { songVoice: 'my-voice' } }),
    getSong: () => ({ convertSpeech: async () => { throw new Error('翻唱环境还没装好') } }),
    dataDir: () => '/tmp/data',
    log: { warn() {} },
  })
  await assert.rejects(conv('/tmp/a.wav'), /翻唱环境还没装好/)
})
