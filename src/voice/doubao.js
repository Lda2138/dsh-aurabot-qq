// 豆包语音（火山引擎 · 语音合成大模型 2.0）：文字转语音、用一段录音复刻音色。只会说话，不会唱歌。
// 文档：https://docs.volcengine.com/docs/doubao-voice/unidirectional-streaming-text-to-speech-http
// 新版控制台只要一个 API Key（请求头 X-Api-Key）；老控制台用 APP ID + Access Token（X-Api-App-Id / X-Api-Access-Key）。
// 语气：2.0 音色（含 2.0 复刻音色）支持「语音指令」（context_texts，只取第一句、不计费），把她写的语气换成一句口头指令。

import { randomUUID } from 'node:crypto'

export const DOUBAO_BASE = 'https://openspeech.bytedance.com'
export const DOUBAO_RESOURCES = ['seed-tts-2.0', 'seed-icl-2.0', 'seed-tts-1.0', 'seed-icl-1.0']
export const DOUBAO_MAX_CHARS = 1000
/** 复刻音色用 2.0 合成时必须写明模型，不写会按 1.0 找音色、报「资源和音色不配套」。expressive 表现力更强。 */
export const DOUBAO_CLONE_MODELS = ['seed-tts-2.0-expressive', 'seed-tts-2.0-standard']

/** 资源 ID：auto 时按音色判断——复刻音色（S_ 开头、icl_ 开头或自定义复刻 ID）用 seed-icl-2.0，其余用 seed-tts-2.0。 */
export function doubaoResource(c = {}) {
  if (DOUBAO_RESOURCES.includes(c.resourceId)) return c.resourceId
  const s = String(c.speaker || '')
  return /^(S_|icl_)/i.test(s) || (c.clonedSpeaker && s === c.clonedSpeaker) ? 'seed-icl-2.0' : 'seed-tts-2.0'
}

/** 2.0 不支持 SSML 和音效标签：方括号标签（[笑] [停顿]…）一律去掉，免得念成字。 */
export function doubaoText(text) {
  return String(text || '').replace(/\[[^\[\]\s]{1,6}\]/g, ' ').replace(/[ \t]{2,}/g, ' ').trim()
}

/** 她写的语气 → 一句语音指令（官方示例的说法：「你能用骄傲的语气来说话吗？」）。没写语气就不加。 */
export function toneInstruction(tone) {
  const t = String(tone || '').replace(/[「」"'<>\n]/g, '').trim().slice(0, 30)
  return t ? `你能用${t}的语气来说话吗？` : ''
}

/** 能用的凭证：新版 API Key 在前，老控制台 APP ID + Access Token 在后（两样都填了时，Key 被拒会换老凭证再试）。 */
function credentialModes(c) {
  const modes = []
  if (String(c.apiKey || '').trim()) modes.push('key')
  if (String(c.appId || '').trim() && String(c.accessToken || '').trim()) modes.push('old')
  if (!modes.length) throw new Error('豆包语音还没填 API Key')
  return modes
}

function authHeaders(c, resource, mode = credentialModes(c)[0]) {
  return {
    'content-type': 'application/json',
    ...(mode === 'key' ? { 'x-api-key': String(c.apiKey).trim() } : { 'x-api-app-id': String(c.appId).trim(), 'x-api-access-key': String(c.accessToken).trim() }),
    ...(resource ? { 'x-api-resource-id': resource } : {}),
    'x-api-request-id': randomUUID(),
  }
}

const NOT_GRANTED = '（这份凭证没开通对应的语音资源：官方音色要在火山引擎控制台开通「语音合成大模型 2.0」，S_ 开头的复刻音色要开通「声音复刻 2.0」；音色如果是在老版控制台某个应用下买的，要填那个应用的 APP ID 和 Access Token）'
const HINTS = { 40402003: '（文字太长）', 45000000: '（这个音色没开通、没授权，或者资源 ID 和音色不配套）', 45000030: NOT_GRANTED, 55000000: '（豆包服务端出错）', 45001109: '（录音和参考文字对不上）' }
/** 豆包有两种返回：{code, message} 和 {header: {code, message}}。 */
const codeOf = (o) => Number(o?.code ?? o?.header?.code ?? 0)
const msgOf = (o) => String(o?.message ?? o?.header?.message ?? '')
const isFail = (o) => codeOf(o) !== 0 && codeOf(o) !== 20000000
const notGranted = (status, objs) => objs.some((o) => codeOf(o) === 45000030) || (status === 403 && !objs.some(isFail))

/** 流式返回是一个接一个的 JSON 对象（可能换行分隔，也可能直接连着）：逐个切出来。 */
export function splitJsonObjects(raw) {
  const out = []
  let depth = 0, start = -1, inStr = false, esc = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue }
    if (ch === '"') inStr = true
    else if (ch === '{') { if (depth++ === 0) start = i }
    else if (ch === '}' && depth > 0 && --depth === 0) {
      try { out.push(JSON.parse(raw.slice(start, i + 1))) } catch (error) { /* 半截的不要 */ }
    }
  }
  return out
}

function errorFrom(status, objs, raw) {
  const bad = objs.find(isFail)
  const code = bad ? codeOf(bad) : null
  const msg = String((bad && msgOf(bad)) || raw || '').slice(0, 200)
  const auth = status === 401 || status === 403 ? '（API Key 不对或没开通语音合成）' : ''
  const busy = /concurren|quota exceeded|rate/i.test(msg) ? '（同时请求太多或额度不够）' : ''
  const mismatch = /mismatch/i.test(msg) ? '（资源 ID 和这个音色不配套）' : ''
  return new Error(`豆包语音合成失败（${code ?? 'HTTP ' + status}）${HINTS[code] || mismatch || auth || busy}：${msg}`)
}

/**
 * 文字转语音，返回 { buf, sampleRate }：buf 是 24k 16 位单声道 PCM。
 * c = { apiKey | appId+accessToken, speaker, resourceId, speechRate, loudnessRate, toneMode }；toneMode = 'context' 时把语气变成语音指令。
 */
export async function doubaoSpeech(text, c = {}, { tone = '' } = {}, fetchImpl = fetch) {
  const speaker = String(c.speaker || '').trim()
  if (!speaker) throw new Error('豆包语音还没选音色（音色 ID）')
  const t = doubaoText(text).slice(0, DOUBAO_MAX_CHARS)
  if (!t) throw new Error('没有要念的文字')
  const resource = doubaoResource(c)
  const sampleRate = 24000
  const additions = { disable_markdown_filter: false }
  const instruction = c.toneMode === 'off' ? '' : toneInstruction(tone)
  if (instruction && /^seed-(tts|icl)-2/.test(resource)) additions.context_texts = [instruction]
  const body = {
    user: { uid: 'aurabot' },
    req_params: {
      text: t, speaker,
      ...(resource === 'seed-icl-2.0' ? { model: DOUBAO_CLONE_MODELS.includes(c.cloneModel) ? c.cloneModel : DOUBAO_CLONE_MODELS[0] } : {}),
      audio_params: { format: 'pcm', sample_rate: sampleRate, speech_rate: Math.round(Math.max(-50, Math.min(100, Number(c.speechRate) || 0))), loudness_rate: Math.round(Math.max(-50, Math.min(100, Number(c.loudnessRate) || 0))) },
      additions: JSON.stringify(additions),
    },
  }
  let r, raw, objs
  const modes = credentialModes(c)
  for (const [m, mode] of modes.entries()) {
    for (let i = 0; i < 3; i++) {
      r = await fetchImpl(`${DOUBAO_BASE}/api/v3/tts/unidirectional`, { method: 'POST', headers: authHeaders(c, resource, mode), body: JSON.stringify(body), signal: AbortSignal.timeout(120000) })
      raw = await r.text().catch(() => '')
      objs = splitJsonObjects(raw)
      const busy = r.status === 429 || objs.some((o) => /concurren/i.test(msgOf(o)))
      if (!busy || i === 2) break
      await new Promise((resolve) => setTimeout(resolve, (c.retryDelayMs ?? 1500) * (i + 1)))
    }
    // 新版 Key 没开通这项资源、又填了老控制台凭证：换老凭证再试一次
    if (!(m < modes.length - 1 && notGranted(r.status, objs))) break
  }
  if (!r.ok || objs.some(isFail)) throw errorFrom(r.status, objs, raw)
  const parts = objs.filter((o) => typeof o.data === 'string' && o.data).map((o) => Buffer.from(o.data, 'base64'))
  const total = parts.reduce((n, p) => n + p.length, 0)
  if (total < 400) throw new Error('豆包没返回音频' + (objs.length ? '' : '：' + String(raw).slice(0, 120)))
  // 拼成一块不在 Buffer 池里的内存：偏移是奇数时没法当 16 位 PCM 读
  const buf = Buffer.alloc(total)
  let off = 0
  for (const p of parts) { p.copy(buf, off); off += p.length }
  return { buf, sampleRate, resource, instruction: additions.context_texts?.[0] || null }
}

/** 自定义复刻音色名：8~256 位，字母开头，只含字母数字 - _，不能用官方前缀。 */
export function customSpeakerId(prefix = 'dafeiyu', now = Date.now()) {
  return `${String(prefix).replace(/[^A-Za-z0-9]/g, '') || 'voice'}${now.toString(36)}`.replace(/^(S_|ICL_|MIX_|DiT_|BV)/i, 'v').slice(0, 64)
}

const CLONE_STATUS = { 0: '没找到', 1: '训练中', 2: '训练好了', 3: '训练失败', 4: '可以用了' }

/**
 * 用录音复刻音色（2.0）。speakerId 是控制台买的 S_ 开头音色位；没有就用自定义名字（后付费，第一次合成时「转正」计费）。
 * 返回 { speaker, status }；status 2 或 4 才能合成，调用方可以用 doubaoCloneStatus 轮询。
 */
export async function doubaoClone(c = {}, { buf, format = 'wav', speakerId = '', text = '' } = {}, fetchImpl = fetch) {
  if (!buf?.length) throw new Error('录音是空的')
  if (buf.length > 10 * 1024 * 1024) throw new Error('录音太大了：豆包最多 10MB')
  const fmt = String(format).toLowerCase()
  if (!['wav', 'mp3', 'ogg', 'm4a', 'aac', 'pcm'].includes(fmt)) throw new Error('录音要是 wav、mp3、ogg、m4a 或 aac')
  const bought = /^S_/.test(String(speakerId || ''))
  const custom = bought ? '' : customSpeakerId()
  const body = { speaker_id: bought ? speakerId : 'custom_speaker_id', ...(custom ? { custom_speaker_id: custom } : {}), audio: { data: buf.toString('base64'), format: fmt }, language: 0, extra_params: { enable_audio_denoise: true } }
  if (text) body.text = String(text).slice(0, 300)
  const r = await fetchImpl(`${DOUBAO_BASE}/api/v3/tts/voice_clone`, { method: 'POST', headers: authHeaders(c, ''), body: JSON.stringify(body), signal: AbortSignal.timeout(180000) })
  const raw = await r.text().catch(() => '')
  let j = null
  try { j = JSON.parse(raw) } catch (error) {}
  if (!r.ok || !j || (j.code !== undefined && Number(j.code) !== 0 && Number(j.code) !== 20000000)) throw errorFrom(r.status, j ? [j] : [], raw)
  return { speaker: String(j.speaker_id || (bought ? speakerId : custom)), custom: Boolean(custom), status: Number(j.status ?? 1), statusText: CLONE_STATUS[Number(j.status ?? 1)] || '未知' }
}

/** 查复刻音色状态：2 或 4 表示能用了。 */
export async function doubaoCloneStatus(c = {}, speaker, { custom = false } = {}, fetchImpl = fetch) {
  const body = custom ? { speaker_id: 'custom_speaker_id', custom_speaker_id: speaker } : { speaker_id: speaker }
  const r = await fetchImpl(`${DOUBAO_BASE}/api/v3/tts/get_voice`, { method: 'POST', headers: authHeaders(c, ''), body: JSON.stringify(body), signal: AbortSignal.timeout(30000) })
  const raw = await r.text().catch(() => '')
  let j = null
  try { j = JSON.parse(raw) } catch (error) {}
  if (!r.ok || !j) throw errorFrom(r.status, j ? [j] : [], raw)
  const status = Number(j.status ?? 0)
  return { status, statusText: CLONE_STATUS[status] || '未知', ready: status === 2 || status === 4 }
}
