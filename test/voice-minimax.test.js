// MiniMax 语音：请求格式、情绪映射、音效标签、错误提示、重试、克隆流程、配置归一化与失败改文字。全部用假的 fetch，不花钱。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-minimax-'))
const { minimaxSpeech, minimaxClone, minimaxText, emotionOf, minimaxBase, cloneVoiceId } = await import('../src/voice/minimax.js')
const { normalize, publicConfig, mergeFromPanel } = await import('../src/core/config.js')
const { textToSpeech } = await import('../src/voice/tts.js')
const { parseWav } = await import('../src/voice/wav.js')

const pcmHex = Buffer.alloc(4800, 7).toString('hex')
const ok = (extra = {}) => new Response(JSON.stringify({ data: { audio: pcmHex, status: 2 }, extra_info: { audio_sample_rate: 24000, usage_characters: 20 }, base_resp: { status_code: 0, status_msg: 'success' }, ...extra }))
const fail = (code, msg = 'x') => new Response(JSON.stringify({ base_resp: { status_code: code, status_msg: msg } }))
const C = { apiKey: 'mm-key', voiceId: 'dafeiyu123', model: 'speech-2.8-hd', region: 'cn', speed: 1, pitch: 0, languageBoost: 'Chinese', emotion: 'tone', retryDelayMs: 1 }

test('请求：国内地址、Bearer 鉴权、PCM 24k 单声道、语气换成情绪档位', async () => {
  const calls = []
  const r = await minimaxSpeech('好啦好啦 知道啦', C, { tone: '笑着撒娇' }, async (url, init) => { calls.push({ url, init }); return ok() })
  assert.equal(calls[0].url, 'https://api.minimax.cn/v1/t2a_v2')
  assert.equal(calls[0].init.headers.authorization, 'Bearer mm-key')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.model, 'speech-2.8-hd')
  assert.equal(body.stream, false)
  assert.deepEqual(body.audio_setting, { sample_rate: 24000, format: 'pcm', channel: 1 })
  assert.equal(body.voice_setting.voice_id, 'dafeiyu123')
  assert.equal(body.voice_setting.emotion, 'happy')
  assert.equal(body.language_boost, 'Chinese')
  assert.equal(r.buf.length, 4800)
  assert.equal(r.buf.byteOffset % 2, 0)
})

test('情绪：强烈情绪优先；认不出就不传，交给模型', async () => {
  assert.equal(emotionOf('有点生气又心疼'), 'angry')
  assert.equal(emotionOf('委屈巴巴'), 'sad')
  assert.equal(emotionOf('笑着认命'), 'happy')
  assert.equal(emotionOf('懒洋洋'), 'calm')
  assert.equal(emotionOf('小声嘀咕', 'speech-2.8-hd'), 'calm')
  assert.equal(emotionOf('小声嘀咕', 'speech-2.6-hd'), 'whisper')
  assert.equal(emotionOf(''), '')
  assert.equal(emotionOf('嘴硬'), '')
  const calls = []
  await minimaxSpeech('嗯', { ...C, emotion: 'model' }, { tone: '开心' }, async (u, i) => { calls.push(JSON.parse(i.body)); return ok() })
  assert.equal(calls[0].voice_setting.emotion, undefined)
})

test('音效标签：2.8 换成语气词，其他模型去掉；停顿换真停顿且不放在开头结尾', () => {
  assert.equal(minimaxText('[笑] 你又来了[叹气]'), '(laughs) 你又来了(sighs)')
  assert.equal(minimaxText('[笑] 你又来了[叹气]', 'speech-02-hd'), '你又来了')
  assert.equal(minimaxText('[停顿]好吧[停顿][停顿]那就这样[停顿]'), '好吧<#0.4#>那就这样')
  assert.equal(minimaxText('[唱歌]啦啦啦[不认识]'), '啦啦啦')
})

test('地址：国际区域、自定义 https 地址；非 https 不认', () => {
  assert.equal(minimaxBase({ region: 'intl' }), 'https://api.minimax.io')
  assert.equal(minimaxBase({ baseUrl: 'https://api.minimaxi.com/' }), 'https://api.minimaxi.com')
  assert.equal(minimaxBase({ baseUrl: 'http://evil.example', region: 'cn' }), 'https://api.minimax.cn')
})

test('错误：限流会重试；Key 不对、余额不足给人话提示', async () => {
  let n = 0
  const r = await minimaxSpeech('嗯', C, {}, async () => (++n < 2 ? fail(1002, 'rate limit') : ok()))
  assert.equal(n, 2)
  assert.ok(r.buf.length)
  await assert.rejects(minimaxSpeech('嗯', C, {}, async () => fail(1004, 'auth')), /API Key 不对/)
  await assert.rejects(minimaxSpeech('嗯', C, {}, async () => fail(1008, 'balance')), /余额不足/)
  await assert.rejects(minimaxSpeech('嗯', { ...C, voiceId: '' }, {}, async () => ok()), /还没选音色/)
  await assert.rejects(minimaxSpeech('嗯', { ...C, apiKey: '' }, {}, async () => ok()), /还没填 API Key/)
})

test('克隆：先上传（purpose=voice_clone）再克隆，voice_id 合规', async () => {
  const id = cloneVoiceId('dafeiyu', 1794413349527)
  assert.match(id, /^[A-Za-z][A-Za-z0-9]{7,}$/)
  const calls = []
  const f = async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/v1/files/upload')) return new Response(JSON.stringify({ file: { file_id: 123456 }, base_resp: { status_code: 0 } }))
    return new Response(JSON.stringify({ base_resp: { status_code: 0, status_msg: 'success' } }))
  }
  const r = await minimaxClone(C, { filename: 'me.wav', buf: Buffer.alloc(1000), voiceId: id }, f)
  assert.equal(r.voiceId, id)
  assert.equal(calls[0].init.body.get('purpose'), 'voice_clone')
  assert.deepEqual(JSON.parse(calls[1].init.body).file_id, 123456)
  await assert.rejects(minimaxClone(C, { filename: 'me.ogg', buf: Buffer.alloc(10) }, f), /mp3、m4a 或 wav/)
  await assert.rejects(minimaxClone(C, { filename: 'me.wav', buf: Buffer.alloc(10) }, async (url) => url.endsWith('/upload') ? new Response(JSON.stringify({ file: { file_id: 1 }, base_resp: { status_code: 0 } })) : fail(2038, 'verify')), /实名认证/)
})

test('配置：引擎可选 minimax；Key 不回传面板、空串保存时保留原值', () => {
  const c = normalize({ voice: { engine: 'minimax', minimax: { apiKey: 'secret', model: 'nope', pitch: 99 } } })
  assert.equal(c.voice.engine, 'minimax')
  assert.equal(c.voice.minimax.model, 'speech-2.8-hd')
  assert.equal(c.voice.minimax.pitch, 12)
  const pub = publicConfig(c)
  assert.equal(pub.voice.minimax.apiKey, '')
  assert.equal(pub.voice.minimax.apiKeySet, true)
  const merged = mergeFromPanel(c, { voice: { minimax: { apiKey: '', voiceId: 'abc12345' } } })
  assert.equal(merged.voice.minimax.apiKey, 'secret')
})

test('合成链路：MiniMax 成功出 WAV；失败默认改发文字，不换 Windows 机械音', async () => {
  const real = globalThis.fetch
  try {
    globalThis.fetch = async () => ok()
    const r = await textToSpeech('好呀', { engine: 'minimax', minimax: C, tone: '开心' })
    assert.equal(r.engine, 'minimax')
    const wav = parseWav(readFileSync(r.file))
    assert.equal(wav.rate, 24000)
    globalThis.fetch = async () => fail(1008, 'balance')
    await assert.rejects(textToSpeech('好呀', { engine: 'minimax', minimax: C, breezeFallback: 'text' }), /MiniMax 暂时不可用，改发文字/)
  } finally { globalThis.fetch = real }
})
