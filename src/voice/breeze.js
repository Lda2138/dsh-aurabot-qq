// Breeze（breezeblue.ai）语音：文字转语音、列音色、克隆音色。只说话，不会唱歌（它没有唱歌接口）。
// 接口文档：https://docs.breezeblue.ai/ ；鉴权用请求头 xi-api-key: brz_...；返回原始音频。
// 唱歌另走「翻唱」（RVC）：可以用这里生成的说话录音训练一个同样声音的翻唱音色（见 song/trainer.js）。

export const BREEZE_BASE = 'https://api.breeze.blue/v1'
export const BREEZE_MAX_CHARS = 1000

/** Breeze 的中文音效标签（写在要念的文字里，用方括号）。她发语音时可以用。 */
export const BREEZE_ZH_TAGS = ['笑', '轻笑', '咯咯笑', '哭声', '抽泣', '叹气', '惊呼', '吸气', '呼气', '喘息', '耳语', '喊叫', '唱歌', '哼歌', '结巴', '停顿', '清嗓', '咳嗽', '吸鼻子', '咂嘴', '啧嘴', '打哈欠', '打喷嚏', '打嗝', '吞咽', '闷哼', '冷笑', '哼鼻子']
const TAG_RE = new RegExp(`\\[(${BREEZE_ZH_TAGS.join('|')})\\]`, 'g')

/** 每条都带上的分寸：有情绪、生动，但别演过头。 */
export const BREEZE_STYLE_GUARD = '像年轻女生当面说话，表达这句话真实的情绪：开心就轻快，撒娇就亲近柔软，不耐烦就有点嘴硬，委屈、兴奋或生气都要听得出来。语速、重音和停连随情境变化，不要一律平静或念稿；音效配合语境。本句明确的语气优先于长期风格。'

/**
 * 给 Breeze 的念法提示：面板里固定的（人设音色、整体风格）+ 她给这一条定的语气 + 分寸。
 * 都是中文（Breeze 要求念法提示和正文同一种语言）。
 */
export function breezeInstructions(base = '', tone = '', context = '') {
  const parts = []
  const b = String(base || '').trim().slice(0, 300)
  const t = String(tone || '').trim().slice(0, 80)
  if (b) parts.push(b.replace(/[。.]?$/, '。'))
  if (context) parts.push(String(context).slice(0, 400) + '。')
  if (t) parts.push(`这一句的语气：${t}。`)
  else parts.push('没有单独标语气时，根据正文、称呼和语气词自主判断这句的情绪，不默认用平静语气。')
  parts.push(BREEZE_STYLE_GUARD)
  return parts.join('').slice(0, 1000)
}

/** 别的引擎念不了这些标签：念之前去掉，免得把「[笑]」读出来。 */
export function stripBreezeTags(text) {
  return String(text || '').replace(TAG_RE, '').replace(/[ \t]{2,}/g, ' ').trim()
}

/** 错误信息里挑一句人话。 */
async function errorOf(r) {
  const raw = await r.text().catch(() => '')
  let msg = raw.slice(0, 200)
  try {
    const j = JSON.parse(raw)
    msg = j?.detail?.message || j?.error?.message || j?.message || (typeof j?.detail === 'string' ? j.detail : '') || j?.code || msg
  } catch (error) { /* 不是 JSON */ }
  const hint = r.status === 401 || r.status === 403 ? '（API Key 不对或没权限）'
    : r.status === 402 ? '（额度用完了）'
      : r.status === 404 ? '（音色 ID 不对）'
        : r.status === 429 || r.status === 503 ? '（太忙了，等会儿再试）' : ''
  return `Breeze 返回 ${r.status}${hint}：${msg}`
}

function headers(apiKey, json = true) {
  const key = String(apiKey || '').trim()
  if (!key) throw new Error('Breeze 还没填 API Key')
  return { 'xi-api-key': key, ...(json ? { 'content-type': 'application/json' } : {}) }
}

/**
 * 文字转语音，返回音频 Buffer（WAV，24kHz 单声道）。
 * c = { apiKey, voiceId, model, language, instructions, speed, guidance }；over 里的同名字段覆盖 c（训练录音用）。
 */
export async function breezeSpeech(text, c = {}, over = {}, fetchImpl = fetch) {
  const o = { ...c, ...over }
  const voiceId = String(o.voiceId || '').trim()
  if (!voiceId) throw new Error('Breeze 还没选音色（音色 ID）')
  const t = String(text || '').trim().slice(0, BREEZE_MAX_CHARS)
  if (!t) throw new Error('没有要念的文字')
  const body = { text: t }
  if (o.model) body.model_id = String(o.model)
  if (o.language) body.language_code = String(o.language)
  if (o.instructions) body.instructions = String(o.instructions).slice(0, 1000)
  const vs = {}
  if (Number(o.speed) && Number(o.speed) !== 1) vs.speed = Math.min(2, Math.max(0.5, Number(o.speed)))
  if (Number(o.guidance) && Number(o.guidance) !== 1) vs.guidance_scale = Math.min(10, Math.max(1, Number(o.guidance)))
  if (Object.keys(vs).length) body.voice_settings = vs
  const post = () => fetchImpl(`${BREEZE_BASE}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=wav`, {
    method: 'POST', headers: headers(o.apiKey), body: JSON.stringify(body), signal: AbortSignal.timeout(120000),
  })
  let r = await post()
  // 两条语音同时合成会撞上套餐的并发上限（429）：等一下再试，最多两次，不然这条语音会直接变成文字
  for (let i = 0; i < 2 && r.status === 429; i++) {
    await new Promise((resolve) => setTimeout(resolve, (o.retryDelayMs ?? 1500) * (i + 1)))
    r = await post()
  }
  if (!r.ok) throw new Error(await errorOf(r))
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length < 400) throw new Error('Breeze 返回的音频太短')
  return buf
}

/** 列音色：mine = 自己克隆 / 保存的；否则搜公共音色库（中文）。返回 [{id, name, desc}] */
export async function breezeVoices(apiKey, { mine = true, search = '' } = {}, fetchImpl = fetch) {
  const q = new URLSearchParams()
  q.set('voice_type', mine ? 'personal' : 'default')
  if (!mine) q.set('language_code', 'zh')
  if (search) q.set('search', search)
  const r = await fetchImpl(`${BREEZE_BASE}/voices?${q}`, { headers: headers(apiKey, false), signal: AbortSignal.timeout(20000) })
  if (!r.ok) throw new Error(await errorOf(r))
  const j = await r.json()
  const list = Array.isArray(j) ? j : j.voices || j.items || j.data || []
  return list.map((v) => ({
    id: String(v.voice_id || v.id || ''),
    name: String(v.name || v.voice_name || v.voice_id || ''),
    desc: String(v.description || [v.gender, v.age, v.tone, v.accent].filter(Boolean).join(' · ') || ''),
  })).filter((v) => v.id).slice(0, 60)
}

/**
 * 克隆音色：上传一段录音（≥3 秒、≤5MB、单人、没背景音乐）→ 生成预览 → 保存成自己的音色。返回 { voiceId }。
 * 要有说话人的同意（Breeze 的规定）。
 */
export async function breezeClone(apiKey, { filename, buf, name }, fetchImpl = fetch) {
  if (!buf?.length) throw new Error('录音是空的')
  if (buf.length > 5 * 1024 * 1024) throw new Error('录音太大了：Breeze 最多 5MB')
  const form = new FormData()
  form.set('name', String(name || '大肥鱼').slice(0, 80))
  form.set('reference_language_code', 'zh')
  form.set('remove_background_noise', 'true')
  form.set('files', new Blob([buf]), String(filename || 'voice.wav'))
  const r = await fetchImpl(`${BREEZE_BASE}/voice-previews/clone`, { method: 'POST', headers: headers(apiKey, false), body: form, signal: AbortSignal.timeout(180000) })
  if (!r.ok) throw new Error(await errorOf(r))
  const j = await r.json()
  const gid = j.generated_voice_id
  if (!gid) throw new Error('Breeze 没返回预览音色')
  if (j.requires_verification) throw new Error('Breeze 要求先在网站上做声音授权验证，验证后再来')
  const s = await fetchImpl(`${BREEZE_BASE}/voice-previews/${encodeURIComponent(gid)}/save`, {
    method: 'POST', headers: headers(apiKey), body: JSON.stringify({ voice_name: String(name || '大肥鱼').slice(0, 80), language_code: 'zh' }), signal: AbortSignal.timeout(60000),
  })
  if (!s.ok) throw new Error(await errorOf(s))
  const saved = await s.json()
  const voiceId = String(saved.voice_id || saved.id || '')
  if (!voiceId) throw new Error('Breeze 保存音色后没返回音色 ID')
  return { voiceId }
}
