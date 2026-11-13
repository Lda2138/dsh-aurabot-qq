// DSH 要授权时，在主人 QQ 私聊里问一句，回复「确认」就批准这一次（#162）。
// 只处理主人私聊会话发起的请求（任意一位主人，在发起的那位主人私聊里问）：别的会话照旧交给 DSH 界面。网页也同时能点，谁先答算谁。

const APPROVE_RE = /^(确认|批准|同意|允许)$/
const REJECT_RE = /^(取消|拒绝)$/

import { isOwnerChat } from '../chat/access.js'

/**
 * @param {object} o
 * @param {() => object} o.getConfig
 * @param {(chatId:string, text:string) => Promise<any>} o.deliver 发 QQ 消息
 * @param {(sessionId:string) => string} o.chatOfSession DSH session → QQ chatId
 * @param {number} [o.timeoutMs] 等主人回复多久（默认 5 分钟）
 * @param {object} [o.log]
 */
export function createApprovalRelay({ getConfig, deliver, chatOfSession, timeoutMs = 5 * 60_000, log } = {}) {
  const queue = [] // 排队的请求：一次只问一条，「确认」只对正在问的这条生效
  let disposed = false
  let lastAsked = 0

  const send = (chatId, text) => Promise.resolve().then(() => deliver(chatId, text)).catch((error) => log?.warn?.('审批消息没发出去：', error.message))
  // 每位主人各排各的队：只问队里属于自己私聊的第一条
  const headOf = (chatId) => queue.find((x) => x.chatId === chatId)

  /** 这个会话的授权请求归 QQ 问：通知那边就不用再发一条。 */
  function handles(sessionId) {
    const cfg = getConfig()
    return !disposed && cfg.enabled && !cfg.dryRun && cfg.approvalViaQQ === true && Boolean(cfg.ownerQQ) && isOwnerChat(cfg, chatOfSession(sessionId))
  }

  function ask(item) {
    const left = queue.filter((x) => x.chatId === item.chatId).length - 1
    const lines = ['【要授权】' + (item.toolName || '未知工具')]
    if (item.reason) lines.push('原因：' + String(item.reason).slice(0, 300))
    lines.push(`回复「确认」批准这一次，回复「取消」拒绝；${Math.round(timeoutMs / 60_000)} 分钟没回就不批。` + (left ? `后面还有 ${left} 条。` : ''))
    item.timer = setTimeout(() => {
      settle(item, 'unavailable')
      send(item.chatId, `「${item.toolName}」的授权超时了，没有批准。`)
    }, timeoutMs)
    send(item.chatId, lines.join('\n'))
  }

  function settle(item, outcome) {
    const i = queue.indexOf(item)
    if (i < 0) return false
    const wasHead = headOf(item.chatId) === item
    queue.splice(i, 1)
    clearTimeout(item.timer)
    item.signal?.removeEventListener?.('abort', item.onAbort)
    item.resolve(outcome)
    const next = wasHead ? headOf(item.chatId) : null
    if (next) ask(next)
    return true
  }

  /** QQ 不问的会话（开关关着、群聊、别人的私聊）：网页开着没人点时 DSH 会一直等，回合结束不了，后面的消息全堵死（#162）。 */
  function withDeadline(request, next) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        log?.warn?.(`「${request.toolName}」的授权一直没人答，按没批准处理`)
        resolve('unavailable')
      }, timeoutMs)
      Promise.resolve().then(next).then(resolve, reject).finally(() => clearTimeout(timer))
    })
  }

  function onRequest(request, next) {
    const sessionId = request?.agent?.session?.id
    if (!handles(sessionId)) return !disposed && chatOfSession(sessionId) ? withDeadline(request, next) : next()
    lastAsked = Date.now()
    return new Promise((resolve) => {
      const item = { chatId: chatOfSession(sessionId), toolName: request.toolName, reason: request.reason, signal: request.signal, resolve, timer: null }
      item.onAbort = () => settle(item, 'cancelled')
      request.signal?.addEventListener?.('abort', item.onAbort, { once: true })
      queue.push(item)
      if (headOf(item.chatId) === item) ask(item)
      // 网页那边也能答：有结果就收掉 QQ 这边的问题；没人答（unavailable）就继续等主人回 QQ
      Promise.resolve().then(next).then((outcome) => {
        if (outcome !== 'unavailable' && settle(item, outcome)) send(item.chatId, `「${item.toolName}」已经在 DSH 里处理了。`)
      }, () => {})
    })
  }

  /** 主人的私聊回复。是对审批的回答就返回 true，不再交给她。 */
  function handleReply(chatId, userId, text) {
    const item = headOf(String(chatId || ''))
    if (!item || String(chatId) !== `private:${userId}` || !isOwnerChat(getConfig(), chatId)) return false
    const word = String(text || '').trim()
    const outcome = APPROVE_RE.test(word) ? 'allowed-once' : REJECT_RE.test(word) ? 'rejected' : ''
    if (!outcome) return false
    settle(item, outcome)
    send(item.chatId, outcome === 'allowed-once' ? `批准了这一次：${item.toolName}` : `拒绝了：${item.toolName}`)
    return true
  }

  function dispose() {
    disposed = true
    for (const item of [...queue]) settle(item, 'unavailable')
  }

  return { onRequest, handleReply, handles, dispose, pending: () => queue.length, askedRecently: () => Date.now() - lastAsked < 10_000 }
}
