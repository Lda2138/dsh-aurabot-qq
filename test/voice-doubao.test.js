// 豆包语音：请求头与请求体、语气变语音指令、流式 JSON 拼音频、错误提示、复刻流程、配置与失败改文字。全部用假的 fetch，不花钱。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-doubao-'))
const { doubaoSpeech, doubaoClone, doubaoCloneStatus, doubaoResource, doubaoText, toneInstruction, splitJsonObjects, customSpeakerId } = await import('../src/voice/doubao.js')
const { normalize, publicConfig, mergeFromPanel } = await import('../src/core/config.js')
const { textToSpeech } = await import('../src/voice/tts.js')
const { parseWav } = await import('../src/voice/wav.js')

const chunk = (n, fill) => JSON.stringify({ code: 0, message: '', data: Buffer.alloc(n, fill).toString('base64') })
const streamOk = () => new Response(chunk(2400, 1) + '\n' + chunk(2401, 2) + JSON.stringify({ code: 0, message: '', data: null, sentence: { text: '好呀' } }) + '\n' + JSON.stringify({ code: 20000000, message: 'ok', data: null }))
const C = { apiKey: 'db-key', speaker: 'zh_female_xiaohe_uranus_bigtts', resourceId: 'auto', speechRate: 0, loudnessRate: 0, toneMode: 'context', retryDelayMs: 1 }

test('请求：新版 API Key 鉴权、2.0 资源、PCM 24k、语气变一句语音指令', async () => {
  const calls = []
  const r = await doubaoSpeech('[笑] 好啦好啦 知道啦', C, { tone: '笑着撒娇' }, async (url, init) => { calls.push({ url, init }); return streamOk() })
  assert.equal(calls[0].url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional')
  const hd = calls[0].init.headers
  assert.equal(hd['x-api-key'], 'db-key')
  assert.equal(hd['x-api-resource-id'], 'seed-tts-2.0')
  assert.match(hd['x-api-request-id'], /^[0-9a-f-]{36}$/)
  assert.equal(hd['x-api-app-id'], undefined)
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.req_params.text, '好啦好啦 知道啦')
  assert.equal(body.req_params.speaker, C.speaker)
  assert.equal(body.req_params.model, undefined, '官方音色不写模型')
  assert.deepEqual(body.req_params.audio_params, { format: 'pcm', sample_rate: 24000, speech_rate: 0, loudness_rate: 0 })
  assert.deepEqual(JSON.parse(body.req_params.additions).context_texts, ['你能用笑着撒娇的语气来说话吗？'])
  assert.equal(r.buf.length, 4801, '两段音频按顺序拼起来，文字块不算音频')
  assert.equal(r.buf.byteOffset % 2, 0)
})

test('老控制台：APP ID + Access Token；复刻音色自动用 seed-icl-2.0，写明 2.0 模型，也带语音指令', async () => {
  const calls = []
  await doubaoSpeech('嗯', { ...C, apiKey: '', appId: '123', accessToken: 'tok', speaker: 'S_abc123' }, { tone: '开心' }, async (u, i) => { calls.push(i); return streamOk() })
  assert.equal(calls[0].headers['x-api-app-id'], '123')
  assert.equal(calls[0].headers['x-api-access-key'], 'tok')
  assert.equal(calls[0].headers['x-api-resource-id'], 'seed-icl-2.0')
  const sent = JSON.parse(calls[0].body).req_params
  assert.equal(sent.model, 'seed-tts-2.0-expressive')
  assert.deepEqual(JSON.parse(sent.additions).context_texts, ['你能用开心的语气来说话吗？'])
  await doubaoSpeech('嗯', { ...C, speaker: 'S_abc123', cloneModel: 'seed-tts-2.0-standard' }, {}, async (u, i) => { calls.push(i); return streamOk() })
  assert.equal(JSON.parse(calls[1].body).req_params.model, 'seed-tts-2.0-standard')
  assert.equal(JSON.parse(JSON.parse(calls[0].body).req_params.additions).context_texts.length, 1)
  assert.equal(doubaoResource({ speaker: 'dafeiyuabc', clonedSpeaker: 'dafeiyuabc' }), 'seed-icl-2.0')
  assert.equal(doubaoResource({ speaker: 'zh_female_vv_uranus_bigtts' }), 'seed-tts-2.0')
  assert.equal(doubaoResource({ speaker: 'x', resourceId: 'seed-tts-1.0' }), 'seed-tts-1.0')
})

test('文字与语气：方括号音效去掉；没写语气或关掉就不加指令', async () => {
  assert.equal(doubaoText('[叹气] 好吧[停顿]那就这样'), '好吧 那就这样')
  assert.equal(toneInstruction(''), '')
  assert.equal(toneInstruction('有点生气又心疼'), '你能用有点生气又心疼的语气来说话吗？')
  const calls = []
  await doubaoSpeech('嗯', { ...C, toneMode: 'off' }, { tone: '开心' }, async (u, i) => { calls.push(JSON.parse(i.body)); return streamOk() })
  assert.equal(JSON.parse(calls[0].req_params.additions).context_texts, undefined)
})

test('流式 JSON：换行分隔或直接连着都能切开，字符串里的大括号不干扰', () => {
  const objs = splitJsonObjects('{"a":"{x}"}{"b":1}\n{"c":"\\"}"}\n{"broken":')
  assert.deepEqual(objs, [{ a: '{x}' }, { b: 1 }, { c: '"}' }])
})

test('错误：音色没开通、Key 不对给人话提示；没选音色、没填 Key 先拦下', async () => {
  await assert.rejects(doubaoSpeech('嗯', C, {}, async () => new Response(JSON.stringify({ code: 45000000, message: 'speaker permission denied' }))), /音色没开通/)
  await assert.rejects(doubaoSpeech('嗯', C, {}, async () => new Response('unauthorized', { status: 401 })), /API Key 不对/)
  await assert.rejects(doubaoSpeech('嗯', { ...C, speaker: '' }, {}, async () => streamOk()), /还没选音色/)
  await assert.rejects(doubaoSpeech('嗯', { ...C, apiKey: '' }, {}, async () => streamOk()), /还没填 API Key/)
  let n = 0
  await doubaoSpeech('嗯', C, {}, async () => (++n < 2 ? new Response(JSON.stringify({ code: 45000292, message: 'quota exceeded for types: concurrency' })) : streamOk()))
  assert.equal(n, 2, '并发超限会等一下重试')
})

test('资源没开通（真实返回 header 格式）：给出开通提示；填了老控制台凭证就自动换过去再试', async () => {
  const denied = () => new Response(JSON.stringify({ header: { reqid: 'r', code: 45000030, message: '[resource_id=volc.seedtts.default] requested resource not granted' } }), { status: 403 })
  await assert.rejects(doubaoSpeech('嗯', C, {}, async () => denied()), /45000030）（这份凭证没开通对应的语音资源/)
  const used = []
  const r = await doubaoSpeech('嗯', { ...C, appId: '123', accessToken: 'tok' }, {}, async (u, i) => { used.push(i.headers['x-api-key'] ? 'key' : 'old'); return used.length === 1 ? denied() : streamOk() })
  assert.deepEqual(used, ['key', 'old'])
  assert.ok(r.buf.length)
})

test('复刻：没买音色位时用自定义 ID；买了 S_ 就用它；查状态 2/4 才算好了', async () => {
  const calls = []
  const f = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify(url.endsWith('/get_voice') ? { status: 4 } : { speaker_id: '', status: 1 })) }
  const a = await doubaoClone(C, { buf: Buffer.alloc(100), format: 'wav' }, f)
  assert.equal(calls[0].url, 'https://openspeech.bytedance.com/api/v3/tts/voice_clone')
  assert.equal(calls[0].body.speaker_id, 'custom_speaker_id')
  assert.match(calls[0].body.custom_speaker_id, /^[A-Za-z][A-Za-z0-9]{7,}$/)
  assert.equal(calls[0].body.audio.format, 'wav')
  assert.equal(a.custom, true)
  const b = await doubaoClone(C, { buf: Buffer.alloc(100), format: 'mp3', speakerId: 'S_bought1' }, f)
  assert.equal(calls[1].body.speaker_id, 'S_bought1')
  assert.equal(b.speaker, 'S_bought1')
  const st = await doubaoCloneStatus(C, a.speaker, { custom: true }, f)
  assert.equal(st.ready, true)
  assert.equal(calls[2].body.custom_speaker_id, a.speaker)
  assert.doesNotMatch(customSpeakerId('S_x'), /^S_/)
  await assert.rejects(doubaoClone(C, { buf: Buffer.alloc(10), format: 'flac' }, f), /wav、mp3/)
})

test('配置：引擎可选豆包；Key 和 Token 不回传面板、空串保存时保留原值', () => {
  const c = normalize({ voice: { engine: 'doubao', doubao: { apiKey: 'secret', accessToken: 'tok', resourceId: 'nope', speechRate: 300 } } })
  assert.equal(c.voice.engine, 'doubao')
  assert.equal(c.voice.doubao.resourceId, 'auto')
  assert.equal(c.voice.doubao.speechRate, 100)
  const pub = publicConfig(c)
  assert.equal(pub.voice.doubao.apiKey, '')
  assert.equal(pub.voice.doubao.apiKeySet, true)
  assert.equal(pub.voice.doubao.accessToken, '')
  const merged = mergeFromPanel(c, { voice: { doubao: { apiKey: '', accessToken: '', speaker: 'zh_female_x' } } })
  assert.equal(merged.voice.doubao.apiKey, 'secret')
  assert.equal(merged.voice.doubao.accessToken, 'tok')
})

test('合成链路：豆包成功出 WAV；失败默认改发文字', async () => {
  const real = globalThis.fetch
  try {
    globalThis.fetch = async () => streamOk()
    const r = await textToSpeech('好呀', { engine: 'doubao', doubao: C, tone: '开心' })
    assert.equal(r.engine, 'doubao')
    assert.equal(parseWav(readFileSync(r.file)).rate, 24000)
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 45000000, message: 'denied' }))
    await assert.rejects(textToSpeech('好呀', { engine: 'doubao', doubao: C, breezeFallback: 'text' }), /豆包语音 暂时不可用，改发文字/)
  } finally { globalThis.fetch = real }
})
