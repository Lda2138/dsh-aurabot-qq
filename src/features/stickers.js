// 表情库：偷表情（严格判定 + 尺寸兜底 + MD5 去重 + 每小时限额）→ 收藏到 QQ → 视觉模型起备注；
// 发送时按备注 / 标签模糊匹配。本地库：~/.dsh/plugins-data/aurabot/stickers/

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir, readJson, writeJson } from '../core/store.js'
import { imageSize, mimeOf, stickerSizeOk } from '../chat/inbound.js'
import { segmentBytes, fetchImage } from '../core/net.js'
import { askModel, canSeeImages } from '../core/llm.js'

const dir = () => dataDir('stickers')
const indexFile = () => join(dir(), 'index.json')
const ext = (mime) => ({ 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' })[mime] || 'jpg'
const DAY = 86400_000
const HOUR = 3600_000
const DOWNLOAD_LIMIT = 5 * 1024 * 1024
// 同一个数据目录共用队列，自动收集、导入、批量命名和切换模型都不能另开并发。
const runtimes = new Map()
const bounded = (value, fallback, max) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(max, Math.floor(Number(value)))) : fallback
function runtimeOf(directory) {
  if (!runtimes.has(directory)) runtimes.set(directory, { collecting: new Set(), collectTail: Promise.resolve(), failedSources: new Map(), captioning: new Map(), captionTail: Promise.resolve() })
  return runtimes.get(directory)
}

/** QQ 的具体描述可以直接当名字；“图片/动画表情”仅是媒体类型，不是语义识别结果。 */
function usefulSummary(summary) {
  const text = String(summary || '').replace(/[\[\]\u0000-\u001f]/g, '').trim()
  return text && !/^(?:图片|表情|表情包|动画表情|动态表情|image|sticker)$/i.test(text) ? text.slice(0, 12) : ''
}

export const DEFAULT_TAGS = ['开心', '卖萌', '生气', '委屈', '无语', '嘲讽', '疑惑', '早晚安']

export function loadLibrary() {
  return readJson(indexFile(), () => ({ items: [] }))
}

function saveLibrary(lib) {
  writeJson(indexFile(), lib)
}

export function stickerPath(item) {
  return join(dir(), item.file)
}

/** 模糊匹配：备注 / 标签里包含关键词得分高；完全找不到返回 null。 */
export function matchSticker(items, query) {
  const q = String(query || '').trim()
  if (!q || !items.length) return null
  let best = null
  let bestScore = 0
  for (const it of items) {
    const hay = [it.name || '', ...(it.tags || [])]
    let s = 0
    for (const h of hay) {
      if (!h) continue
      if (h === q) s = Math.max(s, 10)
      else if (h.includes(q) || q.includes(h)) s = Math.max(s, 6)
      else {
        const common = [...q].filter((c) => h.includes(c)).length
        if (common >= 2) s = Math.max(s, common / Math.max(q.length, 1) * 4)
      }
    }
    if (s > bestScore || (s === bestScore && s > 0 && Math.random() < 0.5)) {
      best = it
      bestScore = s
    }
  }
  return bestScore >= 1.5 ? best : null
}

/** 打了这个标签的表情不参与自动配（太吓人、容易误会的梗图靠手动发）。 */
export const NEVER_RANDOM = '不随机'

/** 自动配表情：先按回复里的词匹配，匹配不到随机挑一张；带「不随机」标签的不参与。 */
export function pickForReply(items, replyText) {
  if (!items.length) return null
  const pool = items.filter((i) => !(i.tags || []).includes(NEVER_RANDOM))
  if (!pool.length) return null // 全被打上标签时，这一轮就不自动配
  const words = DEFAULT_TAGS.concat(pool.flatMap((i) => i.tags || []))
  for (const w of words) {
    if (w && String(replyText).includes(w)) {
      const m = matchSticker(pool, w)
      if (m) return m
    }
  }
  return pool[Math.floor(Math.random() * pool.length)]
}

/** 超过上限时该清掉哪张：只看偷来的，最少被发过的里最老的那张。 */
export function pickEvict(items) {
  // 主人加的、从 QQ 收藏导进来的不清（那些本来就在机器人号的收藏里）
  const pool = items.filter((i) => !['manual', 'panel', 'qq', 'tool'].includes(i.from))
  if (!pool.length) return null
  return pool.slice().sort((a, b) => (a.uses || 0) - (b.uses || 0) || (a.lastUsed || a.at || 0) - (b.lastUsed || b.at || 0))[0]
}

export function createStickerStore({ dsh, getConfig, onebot, log, ask = askModel, see = canSeeImages, readSegment = segmentBytes, download = fetchImage, now = Date.now }) {
  // 固定实例的数据目录，后台任务不会因测试环境或实例切换写进别处。
  const directory = dataDir('stickers')
  const dir = () => directory
  const loadLibrary = () => readJson(join(directory, 'index.json'), () => ({ items: [] }))
  const saveLibrary = (lib) => writeJson(join(directory, 'index.json'), lib)
  const ledgerFile = join(directory, 'budget.json')
  const runtime = runtimeOf(directory)
  const ledger = () => {
    const value = readJson(ledgerFile, {})
    const active = (entries, window) => (Array.isArray(entries) ? entries : []).filter((t) => Number.isFinite(t) && now() - t < window)
    return { ...value, collected: active(value.collected, HOUR), externalCollected: active(value.externalCollected, DAY), captions: active(value.captions, DAY) }
  }
  const saveLedger = (value) => writeJson(ledgerFile, value)
  let disposed = false

  /** 面板里给起名单独挑的模型；没挑（或者只填了一半）就返回 null = 跟随聊天用的模型。 */
  function captionModelOf(cfg = getConfig()) {
    const m = cfg && cfg.stickers && cfg.stickers.captionModel
    return m && m.provider && m.model ? { provider: m.provider, model: m.model } : null
  }

  async function writeQQRemark(item) {
    if (disposed || getConfig().dryRun || !item?.emojiId || !item.name) return
    try { await onebot.call('modify_custom_face', { emoji_id: item.emojiId, desc: item.name.slice(0, 20) }) } catch (error) { log.warn('写回 QQ 备注失败：', error.message) }
  }

  async function caption(buf, mime, hint) {
    try {
      const cfg = getConfig()
      const target = captionModelOf(cfg)
      // 模型看不了图就别硬发：会报错，名字也起不出来
      if ((await see(dsh, cfg, target)) === false) {
        log.debug('模型不支持看图，跳过表情起名')
        return { name: '', tags: [], noVision: true }
      }
      const text = await ask(dsh, {
        cfg,
        ...(target ? { model: target } : {}),
        system: '你给表情包起名字。只输出一行：不超过 12 个字的中文备注，描述这个表情表达的情绪或内容（例如「委屈巴巴的小猫」「得意地叉腰」）。然后空格，再写 1~3 个标签，从这些里挑：' + DEFAULT_TAGS.join('、') + '。格式：备注 #标签1 #标签2',
        text: hint ? `QQ 给的描述是「${hint}」。请看图起名。` : '请看图起名。',
        images: [{ data: buf.toString('base64'), mediaType: mime }],
        maxTokens: Math.max(100, bounded(cfg.stickers.captionMaxTokens, 400, 1200)),
        reasoningEffort: 'off',
        retryEmpty: false,
        temperature: 0.2,
      })
      if (!text) log.warn('看图起名：这次没有返回名字，保留本地描述，不自动重试')
      const line = String(text || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || ''
      const tags = [...line.matchAll(/#\s*([^\s#]+)/g)].map((m) => m[1]).filter((t) => t.length <= 6).slice(0, 3)
      const name = line.replace(/#\s*[^\s#]+/g, '').replace(/[「」"'“”]/g, '').trim().slice(0, 12)
      return { name, tags }
    } catch (error) {
      log.warn('看图起名失败：', error.message)
      return { name: '', tags: [] }
    }
  }

  function captionBudget() {
    const state = ledger(), cfg = getConfig().stickers
    return { usedHour: state.captions.filter((t) => now() - t < HOUR).length, usedDay: state.captions.length,
      maxPerHour: bounded(cfg.captionMaxPerHour, 4, 100), maxPerDay: bounded(cfg.captionMaxPerDay, 16, 1000), queued: runtime.captioning.size, retryAfter: state.captionRetryAfter || 0 }
  }

  function queueCaption(md5, { automatic = true, force = false, canceled = () => false } = {}) {
    if (disposed || canceled()) return Promise.resolve({ skipped: true, reason: 'canceled' })
    const cfg = getConfig().stickers, item = loadLibrary().items.find((i) => i.md5 === md5)
    if (!item) return Promise.resolve({ skipped: true, reason: 'removed' })
    if (automatic && !cfg.caption) return Promise.resolve({ skipped: true, reason: 'disabled' })
    if (automatic && String(item.name || '').trim()) return Promise.resolve({ skipped: true, reason: 'named' })
    const summary = usefulSummary(item.summary)
    if (automatic && cfg.captionPreferSummary !== false && summary) {
      item.name = summary
      item.nameSource = 'qq-summary'
      if (DEFAULT_TAGS.includes(summary)) item.tags = [summary]
      const lib = loadLibrary(), current = lib.items.find((i) => i.md5 === md5)
      if (current && !current.name) { Object.assign(current, item); saveLibrary(lib) }
      return writeQQRemark(current).then(() => ({ name: summary, tags: item.tags, summary: true }))
    }
    if (!force && item.caption?.attemptedAt != null && now() - item.caption.attemptedAt < DAY) return Promise.resolve({ skipped: true, reason: 'already-attempted' })
    if (runtime.captioning.has(md5)) return runtime.captioning.get(md5)
    if (runtime.captioning.size >= bounded(cfg.captionQueueLimit, 8, 100)) return Promise.resolve({ skipped: true, reason: 'queue-full' })
    const initialName = item.name || '', initialTags = JSON.stringify(item.tags || [])
    const task = runtime.captionTail.catch(() => {}).then(async () => {
      if (disposed || canceled() || (automatic && !getConfig().stickers.caption)) return { skipped: true, reason: 'canceled' }
      const lib = loadLibrary(), current = lib.items.find((i) => i.md5 === md5)
      if (!current || (current.name || '') !== initialName || JSON.stringify(current.tags || []) !== initialTags) return { skipped: true, reason: 'changed' }
      if (!force && current.caption?.attemptedAt != null && now() - current.caption.attemptedAt < DAY) return { skipped: true, reason: 'already-attempted' }
      const budget = captionBudget()
      if (budget.usedHour >= budget.maxPerHour || budget.usedDay >= budget.maxPerDay) return { skipped: true, reason: 'budget' }
      if (budget.retryAfter > now()) return { skipped: true, reason: 'retry-backoff' }
      let buf
      try { buf = readFileSync(join(directory, current.file)) } catch { return { skipped: true, reason: 'missing-file' } }
      // 在调用前记账；失败、空输出、切换模型、重载都不会返还或重置额度。
      const state = ledger(), attemptedAt = now()
      state.captions.push(attemptedAt)
      saveLedger(state)
      current.caption = { state: 'running', attemptedAt }
      saveLibrary(lib)
      const result = await caption(buf, mimeOf(buf), current.summary || '')
      if (disposed || canceled()) return { skipped: true, reason: 'canceled' }
      if (!result.name) { const state = ledger(); state.captionRetryAfter = now() + 15 * 60_000; saveLedger(state) }
      const fresh = loadLibrary(), it = fresh.items.find((i) => i.md5 === md5)
      if (!it || (it.name || '') !== initialName || JSON.stringify(it.tags || []) !== initialTags) return { skipped: true, reason: 'changed' }
      it.caption = { state: result.name ? 'done' : 'failed', attemptedAt }
      if (result.name) { it.name = result.name; it.nameSource = 'ai'; if (result.tags.length) it.tags = result.tags }
      saveLibrary(fresh)
      if (result.name) await writeQQRemark(it)
      return result
    }).catch((error) => { log.warn('表情起名队列失败：', error.message); return { name: '', tags: [] } }).finally(() => { runtime.captioning.delete(md5) })
    runtime.captioning.set(md5, task)
    runtime.captionTail = task
    return task
  }

  /** 收一张表情。seg 必须已经过 isStickerSegment 严格判定。 */
  async function collect(seg, from) {
    const config = getConfig(), cfg = config.stickers
    if (disposed) return { ok: false, reason: '表情模块已关闭' }
    if (!cfg.enabled || !cfg.collect) return { ok: false, reason: '偷表情关着' }
    const at = now(), state = ledger(), lib = loadLibrary()
    if (state.collected.length + runtime.collecting.size >= cfg.maxPerHour) return { ok: false, reason: '这小时收够了' }
    if (lib.items.length >= cfg.maxLibrary && !pickEvict(lib.items)) return { ok: false, reason: '表情库已满，保留手动收藏，不再自动收新图' }
    const d = seg.data || {}
    const sourceKey = createHash('sha256').update(JSON.stringify([d.emoji_id || d.emojiId || '', d.file || '', d.url || '', d.path || ''])).digest('hex')
    const knownHash = /(?:^|[/\\])([a-f\d]{32})(?:\.[a-z\d]+)?$/i.exec(String(d.file || ''))?.[1]?.toLowerCase()
    if (lib.items.some((i) => i.sourceKey === sourceKey || (knownHash && i.md5 === knownHash))) return { ok: false, reason: '已经有了' }
    if (runtime.collecting.has(sourceKey) || (runtime.failedSources.get(sourceKey) || 0) > at) return { ok: false, reason: '刚处理过这张，先不重复下载' }
    const group = /^group:(.+)$/.exec(String(from || ''))?.[1]
    const external = Boolean(group && !(config.familyGroups || []).map(String).includes(group))
    if (external) {
      const max = bounded(cfg.externalCollectMaxPerDay, 8, 1000)
      if (state.externalCollected.length >= max || (state.externalNextAttemptAt || 0) > at) return { ok: false, reason: '普通群偷表情先歇一会儿' }
      // 下载前预占一个短退避，失败或重复也不会在高流量群里连续下载；成功后延长到配置间隔。
      state.externalNextAttemptAt = at + 5 * 60_000
      saveLedger(state)
    }
    runtime.collecting.add(sourceKey)
    const task = runtime.collectTail.catch(() => {}).then(() => collectOne(seg, from, { external, sourceKey, previousExternalAt: state.externalCollected.at(-1) }))
    runtime.collectTail = task
    try {
      const result = await task
      if (!result.ok) runtime.failedSources.set(sourceKey, now() + 15 * 60_000)
      while (runtime.failedSources.size > 500) runtime.failedSources.delete(runtime.failedSources.keys().next().value)
      return result
    } finally { runtime.collecting.delete(sourceKey) }
  }

  async function collectOne(seg, from, { external, sourceKey, previousExternalAt }) {
    if (disposed || !getConfig().stickers.enabled || !getConfig().stickers.collect) return { ok: false, reason: '偷表情已停' }
    const state = ledger(), cfg = getConfig().stickers
    if (state.collected.length >= cfg.maxPerHour) return { ok: false, reason: '这小时收够了' }
    if (external && (state.externalCollected.length >= bounded(cfg.externalCollectMaxPerDay, 8, 1000) || state.externalCollected.at(-1) !== previousExternalAt)) return { ok: false, reason: '普通群刚收过新图，先歇一会儿' }
    const d = seg.data || {}
    let buf
    try {
      buf = await readSegment(seg, onebot, { maxBytes: DOWNLOAD_LIMIT })
    } catch (error) {
      return { ok: false, reason: '下载失败：' + error.message }
    }
    if (disposed) return { ok: false, reason: '表情模块已关闭' }
    const { width, height } = imageSize(buf)
    if (!stickerSizeOk({ width, height, bytes: buf.length })) return { ok: false, reason: `尺寸不像表情（${width}x${height}，${Math.round(buf.length / 1024)}KB）` }
    const md5 = createHash('md5').update(buf).digest('hex')
    const lib = loadLibrary()
    if (lib.items.some((i) => i.md5 === md5)) return { ok: false, reason: '已经有了' }
    const mime = mimeOf(buf)
    if (!mime.startsWith('image/')) return { ok: false, reason: '不是图片' }
    if (lib.items.length >= cfg.maxLibrary && !pickEvict(lib.items)) return { ok: false, reason: '表情库已满' }
    mkdirSync(dir(), { recursive: true })
    const file = `collected-${md5}.${ext(mime)}`
    writeFileSync(join(dir(), file), buf)
    const summary = String(d.summary || '').replace(/[[\]]/g, '').trim()
    const summaryName = cfg.captionPreferSummary !== false ? usefulSummary(summary) : ''
    const item = { md5, file, name: summaryName, tags: DEFAULT_TAGS.includes(summaryName) ? [summaryName] : [], from, at: now(), width, height, bytes: buf.length, emojiId: '', summary, sourceKey,
      ...(summaryName ? { nameSource: 'qq-summary' } : {}) }
    // 商城表情（QQ 表情商店里的）：存下来的只是一张预览图，原样发回去才会按商城表情播放动画（#31）
    const marketId = String(d.emoji_id ?? d.emojiId ?? '').trim()
    if (marketId) item.market = { emojiId: marketId, packageId: Number(d.emoji_package_id ?? d.emojiPackageId ?? 0) || 0, key: String(d.key ?? '') }
    lib.items.push(item)
    saveLibrary(lib)
    const freshState = ledger(), savedAt = now()
    freshState.collected.push(savedAt)
    if (external) {
      freshState.externalCollected.push(savedAt)
      freshState.externalNextAttemptAt = savedAt + bounded(cfg.externalCollectMinMinutes, 30, 1440) * 60_000
    }
    saveLedger(freshState)
    // 收藏到 QQ
    if (!getConfig().dryRun) {
      try {
        const r = await onebot.call('add_custom_face', { file: 'base64://' + buf.toString('base64') })
        if (disposed) return { ok: true, item }
        item.emojiId = String(r?.emoji_id || '')
        const latest = loadLibrary(), current = latest.items.find((i) => i.md5 === md5)
        if (current) { current.emojiId = item.emojiId; saveLibrary(latest) }
        if (summaryName) await writeQQRemark(current)
      } catch (error) {
        log.warn('收藏到 QQ 失败（本地已留档）：', error.message)
      }
    }
    log.info(`收了一张表情 ${md5.slice(0, 8)}（${width}x${height}）`)
    await trim()
    if (getConfig().stickers.caption) void queueCaption(md5)
    return { ok: true, item }
  }

  /** 手动添加（工具 / 面板上传）。 */
  async function addFromBuffer(buf, { name = '', tags = [], from = 'manual', toQQ = true, caption: wantCaption = false } = {}) {
    if (disposed) return { ok: false, reason: '表情模块已关闭' }
    const md5 = createHash('md5').update(buf).digest('hex')
    const lib = loadLibrary()
    const exist = lib.items.find((i) => i.md5 === md5)
    if (exist) return { ok: true, item: exist, existed: true }
    const mime = mimeOf(buf)
    if (!mime.startsWith('image/')) return { ok: false, reason: '不是图片' }
    mkdirSync(dir(), { recursive: true })
    const file = `manual-${md5}.${ext(mime)}`
    writeFileSync(join(dir(), file), buf)
    const { width, height } = imageSize(buf)
    const item = { md5, file, name: String(name).slice(0, 12), tags, from, at: now(), width, height, bytes: buf.length, emojiId: '' }
    lib.items.push(item)
    saveLibrary(lib)
    if (toQQ && !getConfig().dryRun) {
      try {
        const r = await onebot.call('add_custom_face', { file: 'base64://' + buf.toString('base64') })
        if (disposed) return { ok: true, item }
        item.emojiId = String(r?.emoji_id || '')
        if (item.emojiId && item.name) await onebot.call('modify_custom_face', { emoji_id: item.emojiId, desc: item.name })
        const latest = loadLibrary(), current = latest.items.find((i) => i.md5 === md5)
        if (current) { current.emojiId = item.emojiId; saveLibrary(latest) }
      } catch (error) {
        log.warn('收藏到 QQ 失败（本地已留档）：', error.message)
      }
    }
    if (wantCaption && !item.name && getConfig().stickers.caption) void queueCaption(md5)
    return { ok: true, item }
  }

  /** 表情库超过上限就清掉最少用的（QQ 收藏表情有数量上限，满了就收不进去了）。 */
  async function trim() {
    const max = getConfig().stickers.maxLibrary
    for (let guard = 0; guard < 20; guard++) {
      if (disposed) return
      const items = loadLibrary().items
      if (items.length <= max) return
      const out = pickEvict(items)
      if (!out) return
      log.info(`表情库满了（上限 ${max}），清掉一张不常用的：${out.name || out.md5.slice(0, 8)}`)
      await remove(out.md5)
    }
  }

  /** 发出去一次：记下来，常用的不会被清掉。 */
  function markUsed(md5) {
    const lib = loadLibrary()
    const it = lib.items.find((i) => i.md5 === md5)
    if (!it) return
    it.uses = (it.uses || 0) + 1
    it.lastUsed = now()
    saveLibrary(lib)
  }

  async function remove(md5, { fromQQ = true } = {}) {
    const lib = loadLibrary()
    const it = lib.items.find((i) => i.md5 === md5)
    if (!it) return { ok: false, reason: '没有这张' }
    if (fromQQ && it.emojiId) {
      try { await onebot.call('delete_custom_face', { emoji_id: it.emojiId }) } catch (error) { log.warn('从 QQ 收藏里删除失败：', error.message) }
    }
    try { unlinkSync(join(dir(), it.file)) } catch (error) {}
    const fresh = loadLibrary()
    fresh.items = fresh.items.filter((i) => i.md5 !== md5)
    saveLibrary(fresh)
    return { ok: true }
  }

  /** 一次删一批：面板多选后一键删掉。fromQQ = 连 QQ 收藏里的那张一起删。 */
  async function removeMany(md5s, { fromQQ = true } = {}) {
    const list = [...new Set((Array.isArray(md5s) ? md5s : []).map((x) => String(x || '').trim()).filter(Boolean))]
    if (!list.length) return { ok: false, removed: 0, message: '没选表情' }
    const found = loadLibrary().items.filter((i) => list.includes(i.md5))
    if (!found.length) return { ok: false, removed: 0, message: '这些表情已经不在库里了' }
    let qqFailed = 0
    if (fromQQ && !getConfig().dryRun) {
      for (const it of found) {
        if (!it.emojiId) continue
        try { await onebot.call('delete_custom_face', { emoji_id: it.emojiId }) } catch (error) { qqFailed++; log.warn('从 QQ 收藏里删除失败：', error.message) }
      }
    }
    for (const it of found) { try { unlinkSync(join(dir(), it.file)) } catch (error) {} }
    const gone = new Set(found.map((i) => i.md5))
    // 重新读一遍再写：后台可能刚给别的表情起完名，别把那些改动冲掉
    const fresh = loadLibrary()
    fresh.items = fresh.items.filter((i) => !gone.has(i.md5))
    saveLibrary(fresh)
    log.info(`批量删掉 ${found.length} 张表情${fromQQ ? '' : '（QQ 收藏保留）'}`)
    return { ok: true, removed: found.length, qqFailed, message: `删掉了 ${found.length} 张${qqFailed ? `（${qqFailed} 张没从 QQ 收藏删掉）` : ''}` }
  }

  function rename(md5, name, tags) {
    const lib = loadLibrary()
    const it = lib.items.find((i) => i.md5 === md5)
    if (!it) return { ok: false }
    if (name !== undefined) it.name = String(name).trim().slice(0, 12)
    if (tags !== undefined) it.tags = [...new Set((Array.isArray(tags) ? tags : []).map((t) => String(t).replace(/^#/, '').trim().slice(0, 8)).filter(Boolean))].slice(0, 5)
    saveLibrary(lib)
    if (it.emojiId && !getConfig().dryRun) onebot.call('modify_custom_face', { emoji_id: it.emojiId, desc: it.name }).catch(() => {})
    return { ok: true, item: it }
  }

  /** 发表情用的消息段：商城表情按商城表情原样发（带 emoji_id，网关会认回成 mface）；其余本地图片按表情（sub_type=1）发。 */
  function segmentFor(item) {
    if (item.market?.emojiId) return { type: 'image', data: { emoji_id: item.market.emojiId, emoji_package_id: item.market.packageId, key: item.market.key, summary: `[${item.name || '表情'}]` } }
    const p = join(directory, item.file)
    if (!existsSync(p)) return null
    return { type: 'image', data: { file: 'base64://' + readFileSync(p).toString('base64'), sub_type: 1, summary: `[${item.name || '表情'}]` } }
  }

  /**
   * 把机器人号 QQ「我喜欢的」里已有的表情导进表情库（fetch_custom_face）。已经有的跳过；
   * 不再往 QQ 收藏里加一遍。开了「看图起名」就在后台一张张起名。
   */
  let importing = null
  async function importFromQQ({ limit = getConfig().stickers.maxLibrary } = {}) {
    if (disposed) return { ok: false, message: '表情模块已关闭' }
    if (importing) return importing
    importing = (async () => {
      let urls
      try {
        const r = await onebot.call('fetch_custom_face', { count: Math.max(1, Math.min(500, Number(limit) || 300)) }, { timeoutMs: 30000 })
        urls = (Array.isArray(r) ? r : r?.data || []).map((x) => (typeof x === 'string' ? x : x?.url || '')).filter(Boolean)
      } catch (error) {
        return { ok: false, message: '读不到机器人号的 QQ 收藏表情：' + error.message }
      }
      let added = 0
      let existed = 0
      let failed = 0
      const named = []
      for (const url of urls) {
        let buf
        if (disposed) break
        try { buf = await download(url, { maxBytes: DOWNLOAD_LIMIT }) } catch (error) { failed++; continue }
        const md5 = createHash('md5').update(buf).digest('hex')
        if (loadLibrary().items.some((i) => i.md5 === md5)) { existed++; continue }
        const r = await addFromBuffer(buf, { from: 'qq', toQQ: false })
        if (r.ok && !r.existed) { added++; named.push(md5) } else if (r.existed) existed++; else failed++
      }
      log.info(`从 QQ 收藏导入表情：新加 ${added} 张，已有 ${existed} 张${failed ? `，${failed} 张下不来` : ''}`)
      // 与自动收集、面板批量任务共用有界队列；不会一次导入就另开一批模型调用。
      if (named.length && getConfig().stickers.caption) {
        for (const md5 of named) void queueCaption(md5)
      }
      return { ok: true, added, existed, failed, total: urls.length, message: urls.length ? `QQ 收藏里有 ${urls.length} 张：新导入 ${added} 张，已经有 ${existed} 张${failed ? `，${failed} 张下载失败` : ''}${added && getConfig().stickers.caption ? '。名字在后台慢慢起' : ''}` : 'QQ 收藏里没有表情' }
    })().finally(() => { importing = null })
    return importing
  }

  // ---------- 批量补名字 / 标签 ----------
  // 整理整个表情库：一张张交给模型看图起名（复用 caption，和偷表情同一套提示词），后台跑、面板轮询进度。
  // 任务状态留在闭包里，关掉面板也照跑；模块卸载 / 重载时 dispose 负责叫停 —— 不然旧实例会接着调模型、写库，
  // 和新实例互相覆盖。
  let captionJob = null

  function captionStatus() {
    const t = captionModelOf(getConfig())
    const model = t ? t.provider + '/' + t.model : ''
    if (!captionJob) return { running: false, total: 0, done: 0, ok: 0, failed: 0, skipped: 0, message: '', model, budget: captionBudget() }
    return {
      running: captionJob.running, total: captionJob.total, done: captionJob.done,
      ok: captionJob.ok, failed: captionJob.failed, skipped: captionJob.skipped,
      startedAt: captionJob.startedAt, current: captionJob.current, last: captionJob.last,
      canceled: Boolean(captionJob.cancel), message: captionJob.message, model, budget: captionBudget(),
    }
  }

  function captionCancel() {
    if (!captionJob || !captionJob.running) return { running: false, message: '没有在跑的任务' }
    captionJob.cancel = true
    return { running: true, message: '这一张跑完就停' }
  }

  /** 模块卸载 / 重载：叫停后台任务（循环里每张之前也会看 cancel）。 */
  function dispose() {
    disposed = true
    if (captionJob && captionJob.running) {
      captionJob.cancel = true
      captionJob.message = '模块重载，这一轮先停了'
      log.info('表情库批量起名：模块卸载，停止后台任务')
    }
  }

  /** 哪些要补：默认只补名字或标签空着的（文件丢了的跳过）；all = 全库重做。 */
  function captionTargets({ all = false } = {}) {
    const items = loadLibrary().items.filter((i) => existsSync(join(dir(), i.file)))
    return all ? items : items.filter((i) => !String(i.name || '').trim() || !(i.tags || []).length)
  }

  /** 开始批量起名：立刻返回，真正干活在后台。 */
  async function captionLibrary({ all = false, limit = 0 } = {}) {
    if (disposed) return { ok: false, message: '模块重载了，重新打开面板再试' }
    if (captionJob && captionJob.running) return { ok: false, message: '上一轮还在跑，等它跑完（或者点「停」）', status: captionStatus() }
    const target = captionModelOf(getConfig())
    if ((await see(dsh, getConfig(), target)) === false) {
      return {
        ok: false,
        message: target
          ? '「起名用的模型」' + target.provider + '/' + target.model + ' 看不了图，起不了名字：换一个能看图的模型，或者把它清空、改用聊天模型'
          : '当前模型看不了图，起不了名字：面板「模型」里把「视觉能力」改成「支持」，或者换一个能看图的模型',
      }
    }
    let queue = captionTargets({ all })
    const cap = Math.max(0, Number(limit) || 0)
    if (cap) queue = queue.slice(0, cap)
    if (!queue.length) return { ok: true, total: 0, message: all ? '表情库里还没有表情' : '每张都有名字和标签了（想全部重做就勾「全部重做」）' }
    const job = { running: true, total: queue.length, done: 0, ok: 0, failed: 0, skipped: 0, startedAt: now(), current: '', last: '', cancel: false, all, message: '' }
    captionJob = job
    log.info(`开始给 ${queue.length} 张表情补名字（${all ? '全部重做' : '只补空缺'}${target ? '，模型 ' + target.provider + '/' + target.model : ''}）`)
    ;(async () => {
      let streak = 0 // 连续失败几张就收手，别在额度用光 / 网络断了的时候还一路烧下去
      for (const want of queue) {
        if (streak >= 5) { job.message = `连续失败 ${streak} 张，先停了（模型或网络有问题）`; break }
        if (job.cancel) break
        // 每张都读一遍最新的库：跑到一半用户改过名字、或者删了这张，就跳过
        const it = loadLibrary().items.find((i) => i.md5 === want.md5)
        if (!it || (!all && String(it.name || '').trim() && (it.tags || []).length)) { job.skipped++; job.done++; continue }
        job.current = it.name || it.md5.slice(0, 8)
        const { name, noVision, skipped, reason } = await queueCaption(it.md5, { automatic: false, force: all, canceled: () => job.cancel })
        if (skipped) {
          job.skipped++; job.done++
          if (reason === 'budget') { job.message = 'AI 起名额度已用完，本地表情已保留，之后可再手动整理'; break }
          if (reason === 'retry-backoff') { job.message = '刚才起名没有成功，先保留图片休息一会儿，不连续重试模型'; break }
          continue
        }
        if (!name) {
          job.failed++
          job.done++
          // 跑到一半模型换成看不了图的（或者元数据变了）：再跑下去只会一路失败，直接收手
          if (noVision) { job.message = '模型看不了图，先停了：换一个能看图的模型再试'; break }
          streak++
          continue
        }
        streak = 0
        job.ok++
        job.last = name
        job.done++
      }
      job.running = false
      job.current = ''
      if (!job.message) job.message = (job.cancel ? '停下来了：这轮' : '整理完了：') + `起了 ${job.ok} 张名字，跳过 ${job.skipped} 张，失败 ${job.failed} 张`
      log.info(job.message)
    })().catch((error) => {
      job.running = false
      job.message = '出错了：' + error.message
      log.warn('批量起名出错：', error.message)
    })
    return { ok: true, total: queue.length, started: true, status: captionStatus(), message: `开始给 ${queue.length} 张表情起名字（后台跑，可以关掉面板）` }
  }

  return { importFromQQ, collect, addFromBuffer, remove, removeMany, rename, segmentFor, markUsed, trim, captionLibrary, captionStatus, captionCancel, captionTargets, dispose,
    waitForCaptions: () => runtime.captionTail, library: loadLibrary, match: (q) => matchSticker(loadLibrary().items, q), pickForReply: (t) => pickForReply(loadLibrary().items, t) }
}
