import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-pace-'))
const { spokenCharCount, paceFactor, paceVoice } = await import('../src/voice/delivery.js')
const { breezeSpeech } = await import('../src/voice/breeze.js')
const { buildWav, parseWav } = await import('../src/voice/wav.js')
const { findFfmpeg } = await import('../src/core/img.js')

const LONG = '行，这活我接了，不过哄人这本事我可没练过，我先试试，哄不动你可别怪我哈' // 31 个字

test('语速：字数不算标点，音效标签按两个字算', () => {
  assert.equal(spokenCharCount(LONG), 31)
  assert.equal(spokenCharCount('[叹气]爸爸 行了吧'), 7)
})

test('语速：长句偏慢才加速，默认最多 1.1 倍（1.35 太夸张）；上限可调', () => {
  assert.equal(paceFactor(LONG, 10.3), 1.1) // 实测最慢的一次：3 字/秒
  assert.equal(paceFactor(LONG, 8), 1.1)
  assert.equal(paceFactor(LONG, 10.3, { max: 1.35 }), 1.35)
  assert.equal(paceFactor(LONG, 8, { max: 1.35 }), 1.14)
  assert.equal(paceFactor(LONG, 10.3, { max: 1 }), 1) // 设成 1 就不加速
  assert.equal(paceFactor(LONG, 6.2), 1) // 5 字/秒，本来就不慢
  assert.equal(paceFactor('好好好，爸爸，爸爸，这样够不够', 5), 1) // 短句不动
  assert.equal(paceFactor(LONG, 10.3, { target: 0 }), 1) // 关掉
})

test('语速：唱歌不动，困 / 委屈这类慢语气少动', () => {
  assert.equal(paceFactor('[唱歌]世上只有爸爸好，有爸的孩子像块宝，投进爸爸的怀抱', 12), 1)
  assert.equal(paceFactor(LONG, 10.3, { tone: '有点不好意思，认真唱' }), 1)
  assert.equal(paceFactor(LONG, 8, { tone: '困得拖长音' }), 1)
  assert.equal(paceFactor(LONG, 10.3, { tone: '困得拖长音', max: 1.35 }), 1.24)
})

test('语速：偏慢的 WAV 真的变短，量不出时长的原样返回', async (t) => {
  const junk = join(process.env.AURABOT_DATA_DIR, 'junk.mp3')
  writeFileSync(junk, Buffer.alloc(2000, 1))
  assert.deepEqual(await paceVoice(junk, LONG), { file: junk, factor: 1, seconds: 0 })
  if (!findFfmpeg()) return t.skip('这台机器没有 ffmpeg')
  const samples = new Int16Array(24000 * 10)
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(8000 * Math.sin(i / 20))
  const slow = join(process.env.AURABOT_DATA_DIR, 'slow.wav')
  writeFileSync(slow, buildWav(samples, 24000))
  const r = await paceVoice(slow, LONG, { max: 1.35 })
  assert.equal(r.factor, 1.35)
  assert.notEqual(r.file, slow)
  const w = parseWav(readFileSync(r.file))
  const secs = w.data.length / (w.rate * w.channels * 2)
  assert.ok(Math.abs(secs - 10 / 1.35) < 0.2, `加速后 ${secs}s`)
})

test('Breeze 撞并发上限（429）会等一下重试，不直接放弃', async () => {
  let calls = 0
  const f = async () => {
    calls++
    return calls < 3
      ? new Response(JSON.stringify({ message: 'concurrent limit' }), { status: 429 })
      : new Response(Buffer.alloc(800, 1), { status: 200 })
  }
  const buf = await breezeSpeech('嗯', { apiKey: 'k', voiceId: 'v', retryDelayMs: 1 }, {}, f)
  assert.equal(buf.length, 800)
  assert.equal(calls, 3)
  calls = -10
  await assert.rejects(breezeSpeech('嗯', { apiKey: 'k', voiceId: 'v', retryDelayMs: 1 }, {}, f), /429/)
})

test('要语音的判断：否定句、说别人的不算', async () => {
  const { wantsVoice } = await import('../src/chat/reply.js')
  for (const s of ['发条语音试试', '用语音叫爸爸', '给我发个语音', '你用语音说']) assert.equal(wantsVoice(s), true, s)
  for (const s of ['可惜她不怎么发语音', '她很少发语音的', '妈妈说她不想发语音', '我没发语音啊', '不用发语音了', '别发语音']) assert.equal(wantsVoice(s), false, s)
})

test('固定钟点：今天只写时分，昨天和更早带上日期', async () => {
  const { clockText } = await import('../src/features/memory.js')
  const now = new Date(2026, 10, 11, 20, 30).getTime()
  assert.equal(clockText(new Date(2026, 10, 11, 18, 59).getTime(), now), '18:59')
  assert.equal(clockText(new Date(2026, 10, 10, 23, 5).getTime(), now), '昨天 23:05')
  assert.equal(clockText(new Date(2026, 10, 9, 8, 0).getTime(), now), '11-09 08:00')
})
