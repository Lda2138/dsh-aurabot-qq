// 漏看补回：电脑待机、断网或网关收包卡住的时候，QQ 这段时间收到的消息不会再推给插件。
// 这里在电脑醒来、网关重连后，以及平时每隔一阵，去 QQ 历史里对一遍：
// 家庭群和主人私聊里她没收到的话，按「刚看到」交回给她（hub 那边负责怎么跟她说）。
import { dataDir, readJson, writeJson } from '../core/store.js'
import { ownerQQs } from './access.js'

export const CATCH_UP = {
  tickMs: 15_000, // 心跳：两次心跳隔太久说明电脑睡过一觉
  wakeGapMs: 90_000,
  periodicMs: 10 * 60_000, // 没睡也定期对一遍（网关收包卡住时连断线都不报）
  settleMs: 45_000, // 太新的先不算：可能还在路上，下一次再看
  maxAgeMs: 6 * 3600_000, // 太久以前的不补
  maxPerChat: 20,
  keepIds: 2000,
  historyCount: 120, // Larger bounded window; the gateway does not promise full history coverage.
  wakeDelays: [20_000, 75_000, 180_000], // 醒来后网络、QQ 同步离线消息都要一会儿，分几次看
  reconnectDelays: [5_000, 60_000],
}

const textOf = (m) => Array.isArray(m?.message)
  ? m.message.filter((s) => s?.type === 'text').map((s) => String(s.data?.text || '')).join('')
  : String(m?.raw_message ?? m?.message ?? '')

export function createCatchUp({ onebot, getConfig, log, replay, isReady = () => true, selfId = () => '', now = () => Date.now(), file = () => dataDir('catchup-state.json'), opts = {} }) {
  const o = { ...CATCH_UP, ...opts }
  let state = null
  let saveTimer = null
  let disposed = false
  let running = null
  const timers = new Set()
  const replayed = new Set() // 补看时交给她的消息 id：之后网关再推同一条就跳过

  function load() {
    if (!state) {
      const raw = readJson(file(), () => ({ chats: {} }))
      state = raw && typeof raw === 'object' && raw.chats && typeof raw.chats === 'object' ? raw : { chats: {} }
    }
    return state
  }
  function saveNow() {
    clearTimeout(saveTimer)
    saveTimer = null
    if (state) { try { writeJson(file(), state) } catch (error) {} }
  }
  function save() {
    if (saveTimer) return
    saveTimer = setTimeout(saveNow, 2000)
    saveTimer.unref?.()
  }

  function targets(cfg) {
    const out = []
    for (const g of cfg.familyGroups || []) out.push({ chatId: `group:${g}`, kind: 'group', id: String(g) })
    for (const q of ownerQQs(cfg)) out.push({ chatId: `private:${q}`, kind: 'private', id: String(q) })
    return out
  }
  const isTarget = (cfg, chatId) => targets(cfg).some((t) => t.chatId === chatId)

  function mark(chatId, messageId, at) {
    const c = load().chats[chatId] || (load().chats[chatId] = { since: now(), t: 0, ids: [] })
    const id = String(messageId || '')
    if (id && id !== '0' && !c.ids.includes(id)) {
      c.ids.push(id)
      if (c.ids.length > o.keepIds) c.ids.splice(0, c.ids.length - o.keepIds)
    }
    if (Number(at) > (c.t || 0)) c.t = Number(at)
    save()
  }

  /** 实时收到的消息：记下 id 和发送时间，补看时据此判断哪些是漏掉的。 */
  function seen(chatId, messageId, at) {
    if (disposed || !isTarget(getConfig(), chatId)) return
    mark(chatId, messageId, Number(at) > 0 ? Number(at) : now())
  }

  /** 这条刚才补看时已经交给她了（网关后来又推了一遍）。 */
  const wasReplayed = (messageId) => Boolean(messageId) && replayed.has(String(messageId))

  async function history(t) {
    const r = t.kind === 'group'
      ? await onebot.call('get_group_msg_history', { group_id: Number(t.id), count: o.historyCount }, { timeoutMs: 15000 })
      : await onebot.call('get_friend_msg_history', { user_id: Number(t.id), count: o.historyCount }, { timeoutMs: 15000 })
    return Array.isArray(r) ? r : (r?.messages || [])
  }

  async function runOnce(reason) {
    const cfg = getConfig()
    if (disposed || !cfg.enabled || cfg.dryRun || !isReady()) return { ok: false, status: 'not_ready', chats: [] }
    const me = String(selfId() || cfg.botQQ || '')
    const t0 = now()
    const report = []
    for (const t of targets(cfg)) {
      const st = load().chats[t.chatId]
      // 第一次见到这个聊天：只立个起点，不把以前的记录当成漏看
      if (!st) { load().chats[t.chatId] = { since: t0, t: 0, ids: [] }; save(); continue }
      let list
      try {
        list = await history(t)
      } catch (error) {
        log.debug?.(`补看 ${t.chatId} 时取历史失败（${reason}）：${error.message}`)
        continue
      }
      if (disposed) break
      // 只按消息 id 判断收没收到：实时收到的每条都记了 id。下限是开始记录的时间（再早的不知道收没收到），
      // 不能用「最后收到的时间」——醒来后先实时进来一条，就会把待机那段全挡在外面。
      const floor = Math.max(Number(st.since) || 0, t0 - o.maxAgeMs)
      const missed = list.filter((m) => {
        const uid = String(m?.user_id ?? m?.sender?.user_id ?? '')
        const mid = String(m?.message_id ?? '')
        const at = Number(m?.time) * 1000
        if (!uid || uid === me || !mid || mid === '0') return false
        if (t.kind === 'group' && (m.message_type === 'private' || (m.group_id != null && String(m.group_id) !== t.id))) return false
        if (t.kind === 'private' && (uid !== t.id || m.message_type === 'group' || m.group_id != null)) return false
        if (st.ids.includes(mid) || replayed.has(mid)) return false
        if (!(at > floor) || at > t0 - o.settleMs) return false
        // 过时的主人指令不补执行
        if (/^\s*[/／]/.test(textOf(m))) { mark(t.chatId, mid, at); return false }
        return true
      }).sort((a, b) => Number(a.time) - Number(b.time)).slice(0, o.maxPerChat)
      if (!missed.length) continue
      log.info(`${t.chatId}：补看到 ${missed.length} 条当时没收到的消息（${reason}）`)
      let accepted = 0
      for (const m of missed) {
        if (disposed) break
        const uid = String(m.user_id ?? m.sender?.user_id ?? '')
        const ev = {
          ...m,
          post_type: 'message',
          message_type: t.kind,
          sub_type: m.sub_type || (t.kind === 'group' ? 'normal' : 'friend'),
          user_id: Number(uid),
          self_id: Number(me) || m.self_id,
          ...(t.kind === 'group' ? { group_id: Number(t.id) } : {}),
          __late: { at: Number(m.time) * 1000 },
        }
        // Suppress a concurrent realtime duplicate, but only persist success
        // after the receiver accepted it. Failure stays retryable next scan.
        const mid = String(m.message_id)
        replayed.add(mid)
        try {
          await replay(ev)
          mark(t.chatId, mid, Number(m.time) * 1000)
          accepted++
        } catch (error) {
          replayed.delete(mid)
          log.warn('补看的消息处理出错，下次重试：', error.message)
        }
        if (replayed.size > o.keepIds) replayed.delete(replayed.values().next().value)
      }
      if (accepted) report.push({ chatId: t.chatId, count: accepted })
    }
    saveNow()
    return { ok: true, status: report.length ? 'caught_up' : 'nothing_missed', chats: report }
  }

  /** 去 QQ 历史里对一遍；同一时间只跑一次。 */
  function run(reason = 'manual') {
    if (running) return running
    running = runOnce(reason).catch((error) => {
      log.warn('补看漏掉的消息出错：', error.message)
      return { ok: false, status: 'error', chats: [] }
    }).finally(() => { running = null })
    return running
  }

  function later(delays, reason) {
    for (const d of delays) {
      const h = setTimeout(() => { timers.delete(h); if (!disposed) run(reason) }, d)
      h.unref?.()
      timers.add(h)
    }
  }

  let lastTick = now()
  let lastPeriodic = now()
  const tick = setInterval(() => {
    const t = now()
    const gap = t - lastTick
    lastTick = t
    if (gap > o.wakeGapMs) {
      log.info(`电脑刚从待机 / 休眠里醒来（停了约 ${Math.round(gap / 60_000)} 分钟），稍后去对一遍漏掉的消息`)
      lastPeriodic = t
      later(o.wakeDelays, '电脑醒来')
    } else if (t - lastPeriodic >= o.periodicMs) {
      lastPeriodic = t
      run('定期')
    }
  }, o.tickMs)
  tick.unref?.()

  return {
    seen,
    wasReplayed,
    run,
    /** 网关（重新）连上、核对过机器人号之后调用。 */
    onConnected: () => later(o.reconnectDelays, '网关重连'),
    dispose() {
      disposed = true
      clearInterval(tick)
      for (const h of timers) clearTimeout(h)
      timers.clear()
      if (state) saveNow()
    },
  }
}
