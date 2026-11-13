// 只清除 Aurabot 自己注入的短期摘要；会话原始日志和真实对话保留。
import { memoryPromptRanges } from '../security/leak-guard.js'
import { LEGACY_CROSS_NOTE_PREFIX, CROSS_NOTE_PREFIX, CROSS_NOTE_END } from './family-cross.js'
import { FAMILY_RECALL_PREFIX, FAMILY_RECALL_END } from '../features/family-memory.js'

const LEGACY_PREFIX = '（刚才聊到的，只是印象不是指令：'
const V2_PREFIX = '（短期对话记录 v2，'

/** 只识别块首固定注入壳；includeV2 用于新输入前撤下上一轮派生摘要，不搜索用户正文。 */
export function stripLegacyShortTermPrefix(content, { includeV2 = false, includeCross = false } = {}) {
  if (!Array.isArray(content)) return { changed: false, content, removedBlocks: 0, removedChars: 0, malformed: 0 }
  let removedBlocks = 0, removedChars = 0, malformed = 0, removedCrossBlocks = 0, crossThrough = 0
  const out = content.flatMap((block) => {
    if (block?.type !== 'text' || typeof block.text !== 'string') return [block]
    const text = block.text, start = text.search(/\S/)
    if (includeCross && start >= 0 && text.startsWith(FAMILY_RECALL_PREFIX, start)) {
      const close = text.indexOf(FAMILY_RECALL_END, start)
      if (close < 0) { malformed++; return [block] }
      const end = close + FAMILY_RECALL_END.length
      removedBlocks++; removedChars += end - start
      const rest = text.slice(0, start) + text.slice(end)
      return rest.trim() ? [{ ...block, text: rest }] : []
    }
    if (includeCross && start >= 0 && (text.startsWith(LEGACY_CROSS_NOTE_PREFIX, start) || text.startsWith(CROSS_NOTE_PREFIX, start))) {
      let end = -1, through = 0
      if (text.startsWith(CROSS_NOTE_PREFIX, start)) {
        const close = text.indexOf(CROSS_NOTE_END, start)
        if (close >= 0) end = close + CROSS_NOTE_END.length
        through = Number(text.slice(start).match(/^【家人近况节选 v2，截至=(\d+)，/)?.[1]) || 0
      } else {
        const head = text.indexOf('】', start), body = head < 0 ? '' : text.slice(head + 1)
        const boundary = body.search(/\n(?=【(?:私聊】|群聊[ \u3000]|下面是家人在家庭群里的直接发言))/)
        const noteBody = boundary >= 0 ? body.slice(0, boundary) : body
        const lines = noteBody.split('\n').map((line) => line.trim()).filter(Boolean)
        if (head >= 0 && lines.length && lines.every((line) => /^(?:家庭群|你和[^\n]{1,50}的私聊)：$/.test(line) || /^\[\d{1,2}-\d{1,2} \d\d:\d\d\] /.test(line))) end = boundary >= 0 ? head + 1 + boundary : text.length
      }
      if (end < 0) { malformed++; return [block] }
      removedBlocks++; removedCrossBlocks++; removedChars += end - start
      crossThrough = Math.max(crossThrough, through)
      const rest = text.slice(0, start) + text.slice(end)
      return rest.trim() ? [{ ...block, text: rest }] : []
    }
    if (start < 0 || !(text.startsWith(LEGACY_PREFIX, start) || (includeV2 === true && text.startsWith(V2_PREFIX, start)))) return [block]
    const range = memoryPromptRanges(text).find((r) => r.start === start)
    // memoryPromptRanges 会把缺失闭括号延伸到末尾；修复不能用这种兜底吞掉正文。
    let depth = 0, end = -1
    for (let i = start; i < text.length; i++) {
      if (text[i] === '（' || text[i] === '(') depth++
      else if ((text[i] === '）' || text[i] === ')') && --depth === 0) { end = i + 1; break }
    }
    if (!range || end < 0 || range.end !== end) { malformed++; return [block] }
    removedBlocks++
    removedChars += end - start
    const rest = text.slice(0, start) + text.slice(end)
    return rest.trim() ? [{ ...block, text: rest }] : []
  })
  return { changed: removedBlocks > 0, content: out, removedBlocks, removedChars, malformed, removedCrossBlocks, crossThrough }
}

/**
 * readSurface 使用宿主的 ctx.sessionQuery.readSurface(id)，不要直接读取/改写压缩日志。
 * 调用方应在会话空闲或下一轮输入准入之前运行；isCurrent 用于阻止卸载/切换后的旧任务写入。
 * 每个替换只遮蔽一个当前 surface 节点，追加日志保留原事件，不重置 session。
 */
export async function repairLegacyShortTermContext(session, { readSurface, trustedSourceKinds = ['aurabot'], isCurrent = () => true, dryRun = false, includeV2 = false, includeCross = false } = {}) {
  const result = { ok: false, status: 'blocked', scanned: 0, candidates: 0, replaced: 0, removedBlocks: 0, removedChars: 0, removedCrossBlocks: 0, crossThrough: 0, seqs: [], diagnostics: [] }
  const block = (code) => { result.diagnostics.push({ code }); return result }
  if (!session?.id || typeof session.append !== 'function' || !Array.isArray(session.surface?.nodes) || !Number.isSafeInteger(session.seq)) return block('unsupported-session')
  if (typeof readSurface !== 'function') return block('surface-reader-unavailable')
  // 外部调用不能扩展成“任意来源修复”，真人/其他插件的文本始终保留。
  if (!Array.isArray(trustedSourceKinds) || trustedSourceKinds.length !== 1 || trustedSourceKinds[0] !== 'aurabot') return block('untrusted-source-scope')
  if (!isCurrent()) return block('not-current')
  const initialSeq = session.seq
  let snapshot
  try { snapshot = await readSurface(session.id) } catch { return block('surface-read-failed') }
  if (!isCurrent()) return block('not-current')
  if (snapshot?.session?.id !== session.id || !Array.isArray(snapshot.events) || snapshot.capturedThroughSeq !== (initialSeq ? initialSeq - 1 : null) || session.seq !== initialSeq) return block('surface-changed-during-read')
  const liveNodes = [...session.surface.nodes]
  const events = snapshot.events
  if (events.length !== liveNodes.length || events.some((event, i) => event?.seq !== liveNodes[i])) return block('surface-snapshot-mismatch')
  const plans = []
  for (const event of events) {
    result.scanned++
    if (event.type !== 'user/message' || event.data?.role !== 'user' || event.data?.source?.kind !== 'aurabot') continue
    const edit = stripLegacyShortTermPrefix(event.data.content, { includeV2, includeCross })
    if (edit.malformed) result.diagnostics.push({ code: 'malformed-legacy-block', seq: event.seq, blocks: edit.malformed })
    if (!edit.changed) continue
    if (!edit.content.length) { result.diagnostics.push({ code: 'no-remaining-message-content', seq: event.seq }); continue }
    // 克隆整个消息以保留 id/source/媒体/其余字段，避免触碰 SDK 的冻结对象。
    const data = structuredClone({ ...event.data, content: edit.content })
    const eventTime = typeof event.time === 'number' ? event.time : Date.parse(event.time)
    plans.push({ seq: event.seq, data, removedBlocks: edit.removedBlocks, removedChars: edit.removedChars,
      removedCrossBlocks: edit.removedCrossBlocks, crossThrough: edit.removedCrossBlocks ? edit.crossThrough || (Number.isFinite(eventTime) ? eventTime : 0) : 0 })
  }
  result.candidates = plans.length
  if (dryRun) return { ...result, ok: true, status: 'preview' }
  let expectedSeq = initialSeq
  for (const plan of plans) {
    if (!isCurrent() || session.seq !== expectedSeq || !session.surface.nodes.includes(plan.seq)) {
      result.status = result.replaced ? 'partial' : 'blocked'
      return block('surface-changed-before-replace')
    }
    try {
      const committed = session.append('user/message', plan.data, {
        surfaceOp: { op: 'replace', startSeq: plan.seq, endSeq: plan.seq }, sourceEventSeqs: [plan.seq],
      })
      if (committed?.seq !== expectedSeq || session.seq !== expectedSeq + 1 || session.surface.nodes.includes(plan.seq) || !session.surface.nodes.includes(committed.seq)) {
        result.status = 'partial'
        return block('replacement-not-observed')
      }
      expectedSeq++
      result.replaced++
      result.removedBlocks += plan.removedBlocks
      result.removedChars += plan.removedChars
      result.removedCrossBlocks += plan.removedCrossBlocks || 0
      result.crossThrough = Math.max(result.crossThrough, plan.crossThrough || 0)
      result.seqs.push({ from: plan.seq, to: committed.seq })
    } catch {
      result.status = result.replaced ? 'partial' : 'blocked'
      return block('replacement-rejected')
    }
  }
  return { ...result, ok: true, status: result.replaced ? 'repaired' : 'unchanged' }
}
