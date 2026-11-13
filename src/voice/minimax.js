// MiniMax 语音（同步 T2A v2）：文字转语音、用一段录音克隆音色。只会说话，不会唱歌。
// 接口文档：https://platform.minimax.cn/docs/api-reference/speech-t2a-http ；鉴权 Authorization: Bearer <API Key>。
// 和 Breeze 不同，情绪、语速、音调都是固定参数（emotion 枚举 / speed / pitch），不靠一大段文字说明，结果更稳。

export const MINIMAX_BASES = { cn: 'https://api.minimax.cn', intl: 'https://api.minimax.io' }
export const MINIMAX_MODELS = ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo', 'speech-02-hd', 'speech-02-turbo']
export const MINIMAX_EMOTIONS = ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent', 'whisper']
export const MINIMAX_MAX_CHARS = 3000

/** 她写的音效标签（沿用 Breeze 的中文写法）→ MiniMax speech-2.8 的语气词标签；[停顿] 换成真停顿。 */
export const MINIMAX_TAGS = {
  笑: '(laughs)', 轻笑: '(chuckle)', 咯咯笑: '(laughs)', 叹气: '(sighs)', 咳嗽: '(coughs)', 清嗓: '(clear-throat)',
  吸气: '(inhale)', 呼气: '(exhale)', 喘息: '(pant)', 惊呼: '(gasps)', 吸鼻子: '(sniffs)', 抽泣: '(sniffs)',
  哼歌: '(humming)', 打喷嚏: '(sneezes)', 闷哼: '(groans)', 哼鼻子: '(snorts)', 冷笑: '(snorts)', 咂嘴: '(lip-smacking)', 啧嘴: '(lip-smacking)',
  停顿: '<#0.4#>',
}
const TAG_RE = /\[([^\[\]\s]{1,4})\]/g

const supportsInterjections = (model) => /^speech-2\.8-/.test(String(model || ''))

/**
 * 正文换成 MiniMax 能念的写法：认得的音效标签换成语气词（只有 speech-2.8 支持，其余模型去掉），
 * [停顿] 换成 <#0.4#>（不能连着用、不能放在开头结尾）；认不得的方括号标签一律去掉，免得念成字。
 */
export function minimaxText(text, model = 'speech-2.8-hd') {
  const tags = supportsInterjections(model)
  let s = String(text || '').replace(TAG_RE, (all, name) => {
    const mapped = MINIMAX_TAGS[name]
    if (!mapped) return ''
    if (mapped.startsWith('<#')) return mapped
    return tags ? mapped : ''
  })
  s = s.replace(/(<#[\d.]+#>\s*){2,}/g, '<#0.4#>').replace(/^(\s*<#[\d.]+#>)+/, '').replace(/(<#[\d.]+#>\s*)+$/, '')
  return s.replace(/[ \t]{2,}/g, ' ').trim()
}

/**
 * 她给这条语音写的中文语气 → MiniMax 的 emotion 枚举。认不出来就返回 ''（不传，让模型自己按正文判断）。
 * 先判断强烈、具体的情绪，再判断开心，最后才是平静。
 */
export function emotionOf(tone, model = 'speech-2.8-hd') {
  const t = String(tone || '')
  if (!t.trim()) return ''
  if (/小声|耳语|悄悄|轻轻说/.test(t)) return /^speech-2\.6-/.test(model) ? 'whisper' : 'calm'
  if (/生气|凶|恼|火大|不耐烦|吼|气呼呼|发火/.test(t)) return 'angry'
  if (/难过|伤心|委屈|哭|低落|失落|心疼|难受|沮丧|想念|舍不得/.test(t)) return 'sad'
  if (/害怕|紧张|担心|慌|发抖/.test(t)) return 'fearful'
  if (/惊讶|吃惊|震惊|意外|不敢相信/.test(t)) return 'surprised'
  if (/嫌弃|恶心|鄙视|反感/.test(t)) return 'disgusted'
  if (/开心|高兴|兴奋|笑|撒娇|得意|欢快|轻快|俏皮|调皮|雀跃|激动|好玩/.test(t)) return 'happy'
  if (/平静|认真|温柔|困|懒|淡定|轻声|安慰|哄|无奈|随口|平淡/.test(t)) return 'calm'
  return ''
}

/** 接口地址：自定义地址优先（只认 https），否则按区域选国内 / 国际。 */
export function minimaxBase(c = {}) {
  const custom = String(c.baseUrl || '').trim().replace(/\/+$/, '')
  if (/^https:\/\/[\w.-]+(:\d+)?(\/[\w./-]*)?$/.test(custom)) return custom
  return MINIMAX_BASES[c.region] || MINIMAX_BASES.cn
}

const HINTS = {
  1002: '（太忙了，等会儿再试）', 1039: '（太忙了，等会儿再试）', 1041: '（同时请求太多了）', 1045: '（同时请求太多了）', 2062: '（套餐限流了）',
  1004: '（API Key 不对）', 2049: '（API Key 不对）', 1008: '（余额不足）', 2053: '（余额不足）', 2067: '（套餐额度用完了）',
  1026: '（内容被判定敏感）', 1027: '（内容被判定敏感）', 2013: '（参数不对）', 2022: '（模型不存在或没开通）', 2061: '（当前套餐不能用这个模型）', 2069: '（模型已下线）',
  2037: '（录音时长不对：要 10 秒到 5 分钟）', 2038: '（账号要先在 MiniMax 官网做实名认证才能克隆）', 2039: '（音色 ID 重复了）', 2042: '（这个音色 ID 用不了）',
  2043: '（这个模型不支持这个音色）', 2051: '（录音质量不过关：换一段更清楚、只有一个人说话的）', 2052: '（音色数量满了）', 2054: '（音色 ID 不存在，克隆的音色 7 天没用会被删）',
}
const BUSY = new Set([1002, 1039, 1041, 1045])

function headers(apiKey, json = true) {
  const key = String(apiKey || '').trim()
  if (!key) throw new Error('MiniMax 还没填 API Key')
  return { authorization: `Bearer ${key}`, ...(json ? { 'content-type': 'application/json' } : {}) }
}

function respError(where, status, base, raw = '') {
  const code = Number(base?.status_code)
  const msg = String(base?.status_msg || raw || '').slice(0, 200)
  return new Error(`MiniMax ${where}失败（${Number.isFinite(code) ? code : 'HTTP ' + status}）${HINTS[code] || ''}：${msg}`)
}

async function readJson(r) {
  const raw = await r.text().catch(() => '')
  try { return { json: JSON.parse(raw), raw } } catch (error) { return { json: null, raw } }
}

/**
 * 文字转语音，返回 { buf, sampleRate, usage }：buf 是 16 位单声道 PCM（或接口直接给的 WAV）。
 * c = { apiKey, region, baseUrl, model, voiceId, speed, vol, pitch, languageBoost, emotion }；emotion = 'tone' 按语气挑，'model' 交给模型。
 */
export async function minimaxSpeech(text, c = {}, { tone = '' } = {}, fetchImpl = fetch) {
  const model = MINIMAX_MODELS.includes(c.model) ? c.model : MINIMAX_MODELS[0]
  const voiceId = String(c.voiceId || '').trim()
  if (!voiceId) throw new Error('MiniMax 还没选音色（音色 ID）')
  const t = minimaxText(text, model).slice(0, MINIMAX_MAX_CHARS)
  if (!t.replace(/<#[\d.]+#>|\([a-z-]+\)/g, '').trim()) throw new Error('没有要念的文字')
  const sampleRate = 24000
  const voice = { voice_id: voiceId, speed: Math.min(2, Math.max(0.5, Number(c.speed) || 1)), vol: Math.min(10, Math.max(0.1, Number(c.vol) || 1)), pitch: Math.max(-12, Math.min(12, Math.round(Number(c.pitch) || 0))) }
  const emotion = c.emotion === 'model' ? '' : emotionOf(tone, model)
  if (emotion) voice.emotion = emotion
  const body = { model, text: t, stream: false, output_format: 'hex', voice_setting: voice, audio_setting: { sample_rate: sampleRate, format: 'pcm', channel: 1 } }
  if (c.languageBoost) body.language_boost = String(c.languageBoost)
  const post = () => fetchImpl(`${minimaxBase(c)}/v1/t2a_v2`, { method: 'POST', headers: headers(c.apiKey), body: JSON.stringify(body), signal: AbortSignal.timeout(120000) })
  let r, json, raw
  for (let i = 0; i < 3; i++) {
    r = await post();
    ({ json, raw } = await readJson(r))
    const busy = r.status === 429 || BUSY.has(Number(json?.base_resp?.status_code))
    if (!busy || i === 2) break
    await new Promise((resolve) => setTimeout(resolve, (c.retryDelayMs ?? 1500) * (i + 1)))
  }
  if (!r.ok || !json || Number(json.base_resp?.status_code) !== 0) throw respError('语音合成', r.status, json?.base_resp, raw)
  const hex = String(json.data?.audio || '')
  if (!/^[0-9a-f]+$/i.test(hex)) throw new Error('MiniMax 没返回音频')
  // 不用 Buffer 池里的内存：偏移是奇数时没法当 16 位 PCM 读
  const buf = Buffer.alloc(hex.length / 2)
  buf.write(hex, 'hex')
  if (buf.length < 400) throw new Error('MiniMax 返回的音频太短')
  return { buf, sampleRate: Number(json.extra_info?.audio_sample_rate) || sampleRate, usage: json.extra_info || null, emotion: emotion || null, model }
}

/** 克隆音色要的 voice_id：8~256 位，英文字母开头，只含字母数字 - _，不能以 - _ 结尾。 */
export function cloneVoiceId(prefix = 'dafeiyu', now = Date.now()) {
  return `${String(prefix).replace(/[^A-Za-z0-9]/g, '') || 'voice'}${now.toString(36)}`.replace(/^[^A-Za-z]+/, 'v').slice(0, 64)
}

/**
 * 用一段录音克隆音色：先上传（purpose=voice_clone），再克隆。录音要 10 秒到 5 分钟、20MB 以内、mp3/m4a/wav。
 * 克隆好的音色 7 天内没正式用过会被 MiniMax 删除，所以调用方克隆完应该马上合成一句。
 */
export async function minimaxClone(c = {}, { filename = 'voice.wav', buf, voiceId = cloneVoiceId() } = {}, fetchImpl = fetch) {
  if (!buf?.length) throw new Error('录音是空的')
  if (buf.length > 20 * 1024 * 1024) throw new Error('录音太大了：MiniMax 最多 20MB')
  if (!/\.(mp3|m4a|wav)$/i.test(String(filename))) throw new Error('录音要是 mp3、m4a 或 wav')
  const form = new FormData()
  form.set('purpose', 'voice_clone')
  form.set('file', new Blob([buf]), String(filename))
  const up = await fetchImpl(`${minimaxBase(c)}/v1/files/upload`, { method: 'POST', headers: headers(c.apiKey, false), body: form, signal: AbortSignal.timeout(180000) })
  const u = await readJson(up)
  const fileId = u.json?.file?.file_id
  if (!up.ok || Number(u.json?.base_resp?.status_code) !== 0 || !fileId) throw respError('上传录音', up.status, u.json?.base_resp, u.raw)
  const r = await fetchImpl(`${minimaxBase(c)}/v1/voice_clone`, {
    method: 'POST', headers: headers(c.apiKey), signal: AbortSignal.timeout(180000),
    body: JSON.stringify({ file_id: fileId, voice_id: voiceId, need_noise_reduction: true, need_volume_normalization: true }),
  })
  const j = await readJson(r)
  if (!r.ok || Number(j.json?.base_resp?.status_code) !== 0) throw respError('克隆音色', r.status, j.json?.base_resp, j.raw)
  return { voiceId }
}
