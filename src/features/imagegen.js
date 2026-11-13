// 生图：OpenAI 兼容、自定义接口，以及实验性 Codex 订阅接法。
//   ① openai —— 兼容 OpenAI /v1/images/generations 的服务（硅基流动、通义万相兼容层、本地 ComfyUI / SD WebUI 的 OpenAI 代理……）
//   ② custom —— 自己填接口：GET / POST、URL 模板（{prompt} 占位）、自定义参数名、从返回 JSON 里按路径取图
// 地址和密钥由主人在面板里填；生成结果统一成 Buffer 交给 QQ 发出。

import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { dataDir } from '../core/store.js'
import { fetchImage } from '../core/net.js'
import { paintingPath } from './paintings.js'
import { createCodexAuth } from './codex-auth.js'
import { createCodexImage } from './codex-image.js'
import { mimeOf } from '../chat/inbound.js'
import { imageToolBlock } from '../core/img.js'
import { imageSizeFor } from './image-shape.js'
export { imageToolBlock }

/** 把模板里的 {占位符} 替换掉；不认识的占位符原样留着。 */
function fill (tpl, vars) {
  return String(tpl ?? '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])))
}

/** "1024x768" → { width, height }。 */
function dimsOf (size) {
  const m = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(String(size || ''))
  return m ? { width: m[1], height: m[2] } : { width: '', height: '' }
}

/** 按 "data.0.url" 这种路径取值。 */
function dotted (obj, path) {
  let cur = obj
  for (const k of String(path || '').split('.').map((s) => s.trim()).filter(Boolean)) {
    if (cur === null || cur === undefined) return null
    cur = cur[k]
  }
  return cur ?? null
}

/** 没配取值路径时，在返回的 JSON 里随便找个像图片的东西（http 地址 / data:image）。 */
function findImage (obj, depth = 0) {
  if (depth > 6 || obj === null || obj === undefined) return null
  if (typeof obj === 'string') {
    if (/^data:image\//i.test(obj)) return obj
    if (/^https?:\/\//i.test(obj) && /\.(png|jpe?g|webp|gif|bmp)(\?|$)/i.test(obj)) return obj
    return null
  }
  if (Array.isArray(obj)) {
    for (const it of obj) { const r = findImage(it, depth + 1); if (r) return r }
    return null
  }
  if (typeof obj === 'object') {
    for (const k of ['url', 'image', 'imageUrl', 'image_url', 'output', 'data', 'images', 'result']) {
      if (k in obj) { const r = findImage(obj[k], depth + 1); if (r) return r }
    }
    for (const v of Object.values(obj)) { const r = findImage(v, depth + 1); if (r) return r }
  }
  return null
}

/** 工具只接受聊天里的短期引用或图库文件名；绝不把模型给的路径 / URL 当图片读。 */
/** 她自己的样子（自拍参考图）：面板里从 AI 生成的候选里挑一张定下来。 */
export const selfFacePath = () => dataDir('imagegen-self', 'face.png')
export const SELF_REF_RE = /^(self|me|我|我自己|自己|自拍|本人)$/i

// 是否适合生成由 photo-sharing 的独立语义审查判断；不用孤立词语拦截生活场景。
// 安全说明放在最后、压成一句：放在开头一大段会挤掉画面描述，模型也会往「写真」方向画。
const SELF_CONTENT_GUARD = '她是 17 岁的原创女生，只画正常衣着、非性化的日常样子，不画性化、裸露内容，也不靠改年龄绕开。'
// 真实感：用户嫌以前的自拍「一股 AI 味」——磨皮美颜、网红脸、写真光。
const SELF_REALISM = '这是一张手机随手拍的真实照片，手机直出：不磨皮、不美颜、不加滤镜，保留皮肤纹理、毛孔和一点小瑕疵，室内光有轻微噪点和偏色，构图随意、可以有点歪，背景是普通人家里或街上本来的样子；不要网红脸、不要写真或广告感、不要二次元、不要插画感。'
// 空间关系：以前出过筷子从举手机那只袖子底下伸出来、手臂和手肘接不上。
const SELF_BODY = '手和身体必须符合真实：前置自拍时一只手在画面外举着手机，画面里最多只看到另一只手；手里没拿着的东西（筷子、勺子、杯子）就放在桌上或碗边，不能悬空；手指数量正确，手臂、手肘、手腕连贯。'
export const SELF_PROMPT_GUARD = '参考图里的女生就是本人，画出来必须是同一个人：五官、脸型、眼睛、肤色和年龄感都和参考图一致，不要换脸、不要美颜；发型、衣服、妆容、表情、动作、场景和角度可以按下面的描述变。' + SELF_REALISM + SELF_BODY + '画面内容：'
export const SELF_NO_REF_PROMPT_GUARD = '没有固定长相参考图，按人设外貌生成，不声称已有固定脸；默认真实手机生活照，明确要求自画像时遵循相应画风。' + SELF_REALISM + SELF_BODY + '画面内容：'

export function selfPhotoPrompt(prompt, { reference = false } = {}) {
  return (reference ? SELF_PROMPT_GUARD : SELF_NO_REF_PROMPT_GUARD) + String(prompt || '').trim().replace(/[。；;，,\s]*$/, '。') + SELF_CONTENT_GUARD
}

export async function resolveDrawImage(image, { hub, chat }) {
  if (image === undefined || image === null || image === '') return null
  if (typeof image !== 'string') throw new Error('参考图只接受 self、last、quote 或画作文件名')
  const ref = image.trim()
  let buf
  if (SELF_REF_RE.test(ref)) {
    const p = selfFacePath()
    if (!existsSync(p)) throw new Error('还没定你自己的样子：请主人先在面板「生图」页的「她的样子」里选一张')
    buf = readFileSync(p)
  } else if (/^(last|最近|最近一张|最近发的图|对方最近发的图)$/i.test(ref)) {
    buf = await hub.referenceImage(chat, 'last')
  } else if (/^(quote|引用|引用消息里的图)$/i.test(ref)) {
    buf = await hub.referenceImage(chat, 'quote')
  } else {
    if (!ref || /[\\/:\0]/.test(ref)) throw new Error('参考图只接受 last、quote 或画作文件名，不接受路径或网址')
    const path = paintingPath(ref)
    if (!path || !lstatSync(path).isFile()) throw new Error('找不到这张画作，请使用图库里的文件名')
    buf = readFileSync(path)
  }
  if (!Buffer.isBuffer(buf) || !String(mimeOf(buf)).startsWith('image/')) throw new Error('参考图不是可用的图片')
  return buf
}

const UNSUPPORTED_REFERENCE = '这个生图服务不支持参考图'
function serviceError(status, message, image) {
  const unsupported = [404, 405, 415, 501].includes(status)
    || ([400, 422].includes(status) && /(?:(?:unsupported|not support|does not support|not available|unknown|unrecognized).*(?:image|edit|model)|(?:image|edit|model).*(?:unsupported|not support|does not support|not available)|不支持.*(?:图|编辑|模型)|(?:图|编辑|模型).*不支持)/i.test(message))
  return new Error(image && unsupported ? UNSUPPORTED_REFERENCE : message)
}

/**
 * 自定义接口这一次要发什么（纯函数，方便单独测）。
 * 返回 { url, method, headers, body }。
 */
export function customRequest (imageGen, prompt, image) {
  const cp = imageGen.custom || {}
  const method = String(cp.method || 'GET').toUpperCase() === 'GET' ? 'GET' : 'POST'
  const { width, height } = dimsOf(imageGen.size)
  const raw = { prompt, model: imageGen.model || '', size: imageGen.size || '', width, height, image: image ? image.toString('base64') : '' }
  const enc = { ...raw, prompt: encodeURIComponent(prompt), image: encodeURIComponent(raw.image) }
  const params = (Array.isArray(cp.params) ? cp.params : [])
    .map((p) => ({ key: String(p && p.key != null ? p.key : '').trim(), value: p ? p.value : '' }))
    .filter((p) => p.key)

  // URL 的 fragment 不会发给服务端；重复参数按最终实际发送的值判断。
  const sentParams = method === 'POST' ? Object.values(Object.fromEntries(params.map((p) => [p.key, p.value]))) : params.map((p) => p.value)
  if (image && ![String(cp.url || '').split('#')[0], ...sentParams].some((v) => String(v || '').includes('{image}'))) throw new Error(UNSUPPORTED_REFERENCE)
  let url = fill(cp.url, enc)
  if (method === 'GET' && params.length) {
    const q = params.map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(fill(p.value, raw))}`).join('&')
    url += (url.includes('?') ? '&' : '?') + q
  }

  const headers = {}
  if (imageGen.apiKey) headers.authorization = `Bearer ${imageGen.apiKey}`

  let body
  if (method === 'POST') {
    const obj = {}
    for (const p of params) obj[p.key] = fill(p.value, raw)
    if (cp.bodyType === 'form') {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      body = new URLSearchParams(obj).toString()
    } else {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(obj)
    }
  }
  return { url, method, headers, body }
}

/** 接口返回的「图片地址 / base64」变成 Buffer。 */
async function valueToBuffer (v) {
  if (typeof v !== 'string' || !v) throw new Error('生图接口没有返回图片')
  const b64 = /^data:image\/[^;]+;base64,(.+)$/i.exec(v)
  if (b64) return Buffer.from(b64[1], 'base64')
  if (/^https?:\/\//i.test(v)) return fetchImage(v, { maxBytes: 20 * 1024 * 1024, allowLocal: false, timeoutMs: 120000 })
  throw new Error('生图接口返回的既不是图片地址也不是图片')
}

export function createImageGen({ getConfig, log, local, fetchImpl, codexAuth }) {
  const fetch = fetchImpl || ((...args) => globalThis.fetch(...args))
  const auth = codexAuth || createCodexAuth({ log, fetchImpl: fetch })
  const viaCodex = createCodexImage({ auth, fetchImpl: fetch, log })
  async function generate(prompt, { shape, image } = {}) {
    const config = getConfig().imageGen
    const c = { ...config, size: imageSizeFor(shape, config) }
    if (image != null && (!Buffer.isBuffer(image) || !String(mimeOf(image)).startsWith('image/'))) throw new Error('参考图不是可用的图片')
    if (image && c.img2img === false) throw new Error('参考图功能已关闭')
    // 本地接口接管：用用户自己电脑上的画图服务
    if (local?.active('image')) {
      const { toImageBuffer } = await import('../local/local.js')
      const t = Date.now()
      const buf = await toImageBuffer(await local.call('image', { prompt: [c.stylePrompt, prompt].filter(Boolean).join('，'), size: c.size, ...(image ? { image: image.toString('base64') } : {}) }))
      log.info(`本地画好了一张图（${Math.round(buf.length / 1024)}KB，${Math.round((Date.now() - t) / 1000)}s）：${prompt.slice(0, 40)}`)
      return buf
    }
    if (!c.enabled) throw new Error('生图还没开启')
    const full = [c.stylePrompt, prompt].filter(Boolean).join('，')
    const t = Date.now()
    const buf = c.provider === 'codex' ? await viaCodex(c, full, { shape, image }) : c.provider === 'custom' ? await viaCustom(c, full, image) : await viaOpenAI(c, full, image)
    if (!buf || !buf.length) throw new Error('生图接口没有返回图片')
    if (!String(mimeOf(buf)).startsWith('image/')) throw new Error('生图接口返回的不是图片')
    log.info(`画好了一张图（${Math.round(buf.length / 1024)}KB，${Math.round((Date.now() - t) / 1000)}s）：${prompt.slice(0, 40)}`)
    return buf
  }

  /** OpenAI 兼容接口。 */
  async function viaOpenAI (c, prompt, image) {
    const base = String(c.baseUrl || '').replace(/\/+$/, '')
    if (!base || !c.model) throw new Error('还没填生图服务地址或模型')
    const headers = image ? {} : { 'content-type': 'application/json' }
    if (c.apiKey) headers.authorization = `Bearer ${c.apiKey}`
    // response_format、image_size 不是每家都认（官方 OpenAI 就不认）：被拒了去掉再发。被拒的请求没出图，重发不会多画
    const body = { model: c.model, prompt, size: c.size, n: 1, response_format: 'b64_json', image_size: c.size }
    let requestBody
    if (image) {
      requestBody = new FormData()
      requestBody.append('image', new Blob([image], { type: mimeOf(image) }), 'reference.' + mimeOf(image).split('/')[1])
      for (const [key, value] of Object.entries({ prompt, model: c.model, size: c.size })) requestBody.append(key, value)
    }
    let r, j
    for (;;) {
      r = await fetch(`${base}/images/${image ? 'edits' : 'generations'}`, { method: 'POST', headers, body: requestBody || JSON.stringify(body), signal: AbortSignal.timeout(180000) })
      j = await r.json().catch(() => ({}))
      if (r.ok) break
      const message = j?.error?.message || j?.message || `HTTP ${r.status}`
      const bad = !image && r.status === 400 && ['response_format', 'image_size'].find((k) => k in body && message.includes(k))
      if (!bad) throw serviceError(r.status, message, image)
      delete body[bad]
    }
    const item = (j.data || j.images || [])[0] || {}
    let buf
    if (item.b64_json) buf = Buffer.from(item.b64_json, 'base64')
    // 有的服务返回 CDN 链接，下载可能要几十秒（实测 22 秒），默认 20 秒会误判成失败
    else if (item.url) buf = await fetchImage(item.url, { maxBytes: 20 * 1024 * 1024, allowLocal: false, timeoutMs: 120000 })
    else throw new Error('生图服务没有返回图片')
    return buf
  }

  /** 自定义接口：GET 直接把参数拼在地址上，POST 放进 JSON / 表单。 */
  async function viaCustom (c, prompt, image) {
    const cp = c.custom || {}
    if (!cp.url) throw new Error('还没填自定义生图接口地址')
    const req = customRequest(c, prompt, image)
    log.info(`生图请求：${req.method} ${image ? '（含参考图）' : req.url.slice(0, 160)}`)
    const r = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(180000),
    })
    const type = String(r.headers.get('content-type') || '')
    // 直接返回图片字节（pollinations 这类）
    if (type.startsWith('image/')) {
      if (!r.ok) throw serviceError(r.status, `HTTP ${r.status}`, image)
      return Buffer.from(await r.arrayBuffer())
    }
    const j = await r.json().catch(() => null)
    if (!r.ok) throw serviceError(r.status, (j && (j.error?.message || j.message)) || `HTTP ${r.status}`, image)
    if (!j) throw new Error('生图接口没有返回图片')
    const v = (cp.responsePath ? dotted(j, cp.responsePath) : null) || findImage(j)
    if (!v) throw new Error('生图接口没有返回图片地址')
    return valueToBuffer(v)
  }

  const enabled = () => {
    if (local?.active('image')) return true
    const c = getConfig().imageGen
    if (!c.enabled) return false
    if (c.provider === 'codex') return auth.status().loggedIn
    return c.provider === 'custom' ? Boolean(c.custom && c.custom.url) : Boolean(c.baseUrl && c.model)
  }

  return { generate, enabled, codexAuth: auth, dispose: () => auth.dispose?.() }
}

/**
 * qq_draw_image 工具结果里那句话。
 * 看不了图、或者「让她画完自己看一眼」关着时，都要如实说，否则她会照着提示词编画面细节。
 * 这里只回一句话，不带文件路径；能不能把「已保存到本机：路径」告诉她，由调用方按
 * 「这张图有没有真的交出去」决定（能看图 + 开关开着 + 附件登记成功才给）。
 */
export function drawToolMessage ({ visual = false, seeOwn = true, intent = 'drawing' } = {}) {
  const done = intent === 'photo' ? '照片已生成并发出去了' : intent === 'edit' ? '图片改好发出去了' : '画好发出去了'
  if (!visual) return done + '，但这次没能把图片交给你看；别描述画面里有什么'
  if (!seeOwn) return done + '。这次没把图给你看，别描述画面里有什么'
  return done
}

/**
 * qq_draw_image 的工具结果怎么渲染：一行文字 +（有图时）image 块。
 * image 一般是 DSH 附件块（imageToolBlock() 登记过的），原样透传；没图就只回文字。
 */
export function drawResultBlocks (_args, value) {
  const text = value && value.ok === false ? '✗ ' + (value.message || '没成功') : (value && value.message) || '✓'
  const blocks = [{ type: 'text', text }]
  const img = value && value.image
  if (img && img.attachment) blocks.push({ ...img, type: 'image' })
  return blocks
}
