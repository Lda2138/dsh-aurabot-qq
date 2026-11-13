// Explicit text-only model replay. No agent, session, tool executor or QQ hub is
// passed here; generated tags/tool-like text are returned as data, never acted on.
import { randomUUID } from 'node:crypto'
import { defaultModel, pickReasoningEffort } from '../core/llm.js'

export async function replayConversation(dsh, cfg, input) {
  if (typeof input?.system !== 'string' || !Array.isArray(input.messages) || !input.messages.length || input.messages.length > 512) throw new Error('回放需要系统提示和 1–512 条文字消息')
  const messages = input.messages.map((m) => {
    if (!['user', 'assistant'].includes(m?.role) || !Array.isArray(m.content) || !m.content.length || m.content.some((b) => b?.type !== 'text' || typeof b.text !== 'string')) throw new Error('回放只接受 user/assistant 的文字块，不执行工具或附件')
    return { id: randomUUID(), role: m.role, content: m.content.map((b) => ({ type: 'text', text: b.text })) }
  })
  if (messages.at(-1).role !== 'user') throw new Error('回放最后一条必须是待回复的用户消息')
  if (Buffer.byteLength(input.system) + Buffer.byteLength(JSON.stringify(messages)) > 2 * 1024 * 1024) throw new Error('回放输入不能超过 2MiB')
  const requestedEffort = input.reasoningEffort === undefined ? 'low' : input.reasoningEffort
  if (typeof requestedEffort !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(requestedEffort)) throw new Error('回放推理档位必须是有效的档位名称')
  const maxTokens = input.maxTokens === undefined ? 2000 : input.maxTokens
  if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 8192) throw new Error('回放输出预算必须是 256–8192 的整数')
  if (input.model !== undefined && (typeof input.model?.provider !== 'string' || !input.model.provider.trim() || input.model.provider.length > 160 || typeof input.model?.model !== 'string' || !input.model.model.trim() || input.model.model.length > 160)) throw new Error('回放模型需要有效的 provider 和 model')
  const model = defaultModel(dsh, input.model === undefined ? cfg : { model: input.model })
  if (!model) throw new Error('拿不到默认模型')
  const llm = dsh.llm || dsh.get('llm')
  if (input.model !== undefined && (typeof llm?.resolveModelInfo !== 'function' || !await llm.resolveModelInfo(model.provider, model.model))) throw new Error('无法确认指定的回放模型已配置')
  const effort = await pickReasoningEffort(dsh, model.provider, model.model, requestedEffort)
  // 显式指定档位用于对照实验，不允许宿主退到默认档后仍把它算作目标档位。
  if (input.reasoningEffort !== undefined && effort !== requestedEffort) throw new Error(`当前模型不支持或无法确认回放推理档位 ${requestedEffort}`)
  const sourced = messages.map((message) => ({ ...message, source: message.role === 'assistant'
    ? { kind: 'model', provider: model.provider, model: model.model }
    : { kind: 'plugin', plugin: 'aurabot' } }))
  const params = { ...model, system: input.system, messages: sourced, maxTokens, temperature: 0.6, signal: AbortSignal.timeout(90_000), ...(effort ? { reasoningEffort: effort } : {}) }
  let reply = '', usage = null, toolRequests = 0, completed = false, reasoningChars = 0, finishReason = null
  for await (const chunk of llm.stream(params)) {
    if (chunk?.type === 'text-delta') reply += chunk.text || ''
    if (chunk?.type === 'reasoning-delta') reasoningChars += (chunk.text || '').length
    if (chunk?.type === 'tool-call' || chunk?.type === 'tool-use') toolRequests++
    if (chunk?.usage) usage = chunk.usage
    if (chunk?.type === 'finish') {
      if (chunk.reason?.kind === 'error') throw new Error(chunk.reason.failure?.message || '回放模型请求失败')
      finishReason = chunk.reason?.kind || null
      completed = chunk.reason?.kind === 'completed' || chunk.reason?.kind === 'stop'
    }
  }
  return { ok: Boolean(reply.trim()) && completed, reply: reply.trim(), completed, finishReason, usage, toolRequests, reasoningChars,
    model, requestedReasoningEffort: requestedEffort, reasoningEffort: effort || null, maxTokens: params.maxTokens, temperature: params.temperature,
    replayOnly: true, textOnly: true, sent: [], modelRequests: 1 }
}
