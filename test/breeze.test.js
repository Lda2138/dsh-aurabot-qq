// Breeze 云端语音：请求怎么拼、错误怎么报、标签怎么处理、配置怎么归一。用假 fetch，不连外网。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { breezeSpeech, breezeVoices, breezeClone, stripBreezeTags, BREEZE_MAX_CHARS } = await import('../src/voice/breeze.js')
const { normalize, publicConfig, mergeFromPanel } = await import('../src/core/config.js')

const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(1000)])
function fakeFetch(respond) {
  const calls = []
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return respond(String(url), init)
  }
  f.calls = calls
  return f
}
const ok = (buf) => new Response(buf, { status: 200, headers: { 'content-type': 'audio/wav' } })
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })

test('说话：POST 到音色地址，带 xi-api-key，WAV 输出，带语言、念法、语速；音效标签原样交给 Breeze', async () => {
  const f = fakeFetch(() => ok(WAV))
  const buf = await breezeSpeech('哼 [叹气] 知道了', { apiKey: 'brz_k', voiceId: 'voc_1', language: 'zh', instructions: '俏皮', speed: 1.2, guidance: 1 }, {}, f)
  assert.equal(buf.length, WAV.length)
  const { url, init } = f.calls[0]
  assert.equal(url, 'https://api.breeze.blue/v1/text-to-speech/voc_1?output_format=wav')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers['xi-api-key'], 'brz_k')
  assert.deepEqual(JSON.parse(init.body), { text: '哼 [叹气] 知道了', language_code: 'zh', instructions: '俏皮', voice_settings: { speed: 1.2 } })
})

test('说话：太长的截到 1000 字；没 Key / 没音色 / 没文字直接报错，不发请求', async () => {
  const f = fakeFetch(() => ok(WAV))
  await breezeSpeech('啊'.repeat(1500), { apiKey: 'k', voiceId: 'v' }, {}, f)
  assert.equal(JSON.parse(f.calls[0].init.body).text.length, BREEZE_MAX_CHARS)
  await assert.rejects(breezeSpeech('hi', { voiceId: 'v' }, {}, f), /API Key/)
  await assert.rejects(breezeSpeech('hi', { apiKey: 'k' }, {}, f), /音色/)
  await assert.rejects(breezeSpeech('  ', { apiKey: 'k', voiceId: 'v' }, {}, f), /没有要念/)
  assert.equal(f.calls.length, 1)
})

test('说话：错误码翻成人话（Key 不对、额度没了、音色不对）', async () => {
  await assert.rejects(breezeSpeech('x', { apiKey: 'k', voiceId: 'v' }, {}, fakeFetch(() => json(401, { detail: { message: 'bad key' } }))), /401（API Key 不对或没权限）：bad key/)
  await assert.rejects(breezeSpeech('x', { apiKey: 'k', voiceId: 'v' }, {}, fakeFetch(() => json(402, { message: 'no credit' }))), /额度用完/)
  await assert.rejects(breezeSpeech('x', { apiKey: 'k', voiceId: 'v' }, {}, fakeFetch(() => json(404, {}))), /音色 ID 不对/)
  await assert.rejects(breezeSpeech('x', { apiKey: 'k', voiceId: 'v' }, {}, fakeFetch(() => ok(Buffer.alloc(10)))), /太短/)
})

test('列音色：我的 = personal；公共 = default + 中文；字段整理好', async () => {
  const f = fakeFetch(() => json(200, { voices: [{ voice_id: 'voc_a', name: '小鱼', gender: 'female', age: 'young' }, { name: '没id' }] }))
  const list = await breezeVoices('k', { mine: true }, f)
  assert.deepEqual(list, [{ id: 'voc_a', name: '小鱼', desc: 'female · young' }])
  assert.match(f.calls[0].url, /voice_type=personal/)
  await breezeVoices('k', { mine: false, search: '少女' }, f)
  assert.match(f.calls[1].url, /voice_type=default&language_code=zh&search=/)
})

test('克隆：上传 → 保存 → 拿到音色 ID；太大不传；要验证时如实说', async () => {
  const f = fakeFetch((url) => (url.endsWith('/voice-previews/clone') ? json(200, { generated_voice_id: 'gen_1' }) : json(200, { voice_id: 'voc_new' })))
  const r = await breezeClone('k', { filename: 'a.wav', buf: Buffer.alloc(5000), name: '大肥鱼' }, f)
  assert.equal(r.voiceId, 'voc_new')
  assert.match(f.calls[1].url, /voice-previews\/gen_1\/save$/)
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { voice_name: '大肥鱼', language_code: 'zh' })
  await assert.rejects(breezeClone('k', { buf: Buffer.alloc(6 * 1024 * 1024) }, f), /5MB/)
  await assert.rejects(breezeClone('k', { buf: Buffer.alloc(10) }, fakeFetch(() => json(200, { generated_voice_id: 'g', requires_verification: true }))), /验证/)
})

test('别的引擎念之前去掉 Breeze 标签；不是标签的方括号不动', () => {
  assert.equal(stripBreezeTags('[叹气]又来了[轻笑]'), '又来了')
  assert.equal(stripBreezeTags('看 [图片] 了吗 [笑]'), '看 [图片] 了吗')
})

test('配置：breeze 引擎可选；数值夹在范围内；API Key 不回传面板，没改时保留', () => {
  const c = normalize({ voice: { engine: 'breeze', breeze: { apiKey: ' brz_secret ', voiceId: 'voc_1', speed: 9, guidance: 0, language: 'chinese' } } })
  assert.equal(c.voice.engine, 'breeze')
  assert.deepEqual({ ...c.voice.breeze, apiKey: 'x' }, { apiKey: 'x', voiceId: 'voc_1', model: '', language: 'zh', instructions: '', speed: 2, guidance: 1 })
  assert.equal(c.voice.breeze.apiKey, 'brz_secret')
  const pub = publicConfig(c)
  assert.equal(pub.voice.breeze.apiKey, '')
  assert.equal(pub.voice.breeze.apiKeySet, true)
  const merged = normalize(mergeFromPanel(c, { voice: { breeze: { apiKey: '', voiceId: 'voc_2' } } }))
  assert.equal(merged.voice.breeze.apiKey, 'brz_secret')
  assert.equal(merged.voice.breeze.voiceId, 'voc_2')
  assert.equal(normalize({ voice: { engine: 'nope' } }).voice.engine, 'auto')
})
