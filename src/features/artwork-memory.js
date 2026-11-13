// Durable generation/delivery facts plus scoped, read-only lookup of old artwork.
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { dataDir, readJson, writeJson } from '../core/store.js'
import { isOwnerSpace, ownerQQs } from '../chat/access.js'
import { listPaintings } from './paintings.js'

export function createArtworkMemory({ getConfig, hub }) {
  const file = () => dataDir('artwork-records.json')
  const load = () => { const v = readJson(file(), () => ([])); return Array.isArray(v) ? v : [] }
  const add = (record) => {
    const rows = load(), item = { id: randomUUID().slice(0, 12), at: Date.now(), ...record }
    rows.push(item); writeJson(file(), rows); return item
  }
  const update = (id, patch) => {
    const rows = load(), item = rows.find((x) => x.id === id)
    if (!item) return null
    Object.assign(item, patch, { updatedAt: Date.now() }); writeJson(file(), rows); return item
  }
  function search(chat, query = '', { shared = false } = {}) {
    const cfg = getConfig(), family = shared && isOwnerSpace(cfg, chat.chatId)
    const spaces = new Set([chat.chatId])
    if (family) {
      for (const qq of ownerQQs(cfg)) spaces.add('private:' + qq)
      for (const qq of cfg.familyGroups || []) spaces.add('group:' + qq)
    }
    const allLogs = (hub.chatLogDays?.() || []).slice(-180).flatMap((day) => hub.chatLogOf(day) || []).filter((r) => spaces.has(r.chatId))
    const forgotten = new Set(allLogs.filter((r) => r.forgottenAt && r.messageId).map((r) => r.chatId + ':' + r.messageId))
    const records = load().filter((r) => spaces.has(r.chatId) && !r.forgottenAt && (!r.messageId || !forgotten.has(r.chatId + ':' + r.messageId)))
    const logs = allLogs.filter((r) => !r.forgottenAt && r.kind !== 'seen' && r.who !== '系统' && !String(r.text || '').startsWith('【系统'))
    const paintings = listPaintings({ limit: 50 }).items
    // Nearby remarks can identify a received image, but are still quotes, not visual descriptions.
    const raw = logs.filter((r, i) => /画|插画|照片|图片|\[图/.test(String(r.text || '')) ||
      (logs[i - 1]?.chatId === r.chatId && /^\[图片\]/.test(String(logs[i - 1]?.text || ''))))
      .map((r) => {
        const quote = String(r.text || '').slice(0, 500)
        const matches = r.who === 'bot' && r.deliveryStatus === 'sent' ? paintings.filter((p) => Math.abs(p.at - r.t) < 120_000 && p.prompt.length >= 8 && quote.replace(/\s+/g, '-').includes(p.prompt)) : []
        return { at: r.t, chatId: r.chatId, speaker: r.who, messageId: r.messageId, quote, source: 'chatlog',
          ...(r.media?.file ? { file: basename(r.media.file) } : matches.length === 1 ? { file: matches[0].file } : {}) }
      })
    const q = String(query).replace(/[\s\p{P}]/gu, '').slice(0, 200)
    const grams = [...new Set(Array.from({ length: Math.max(0, q.length - 1) }, (_, i) => q.slice(i, i + 2)))]
    const ranked = [...records.map((r) => ({ ...r, source: 'generation-ledger' })), ...raw].map((r) => {
      const text = String(r.prompt || r.quote || '')
      // Actual artifacts outrank diary chatter mentioning that somebody likes drawing.
      const artifact = r.source === 'generation-ledger' || r.file || /画面提示词|^\[图片\]/.test(text)
      return { ...r, score: grams.filter((g) => text.includes(g)).length + (artifact ? 16 : 0) }
    }).sort((a, b) => b.score - a.score || b.at - a.at)
    return ranked.slice(0, 12).map(({ score, ...r }) => ({ ...r, ...(r.file ? { file: basename(r.file) } : {}) }))
  }
  return { add, update, search, list: load }
}
