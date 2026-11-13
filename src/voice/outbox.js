// Persistent ordinary-speech delivery. Only work known not to have been submitted may resume.
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { writeJson } from '../core/store.js'
import { isDefiniteFailure } from '../onebot/client.js'
import { groupRateLimit } from '../chat/outbound.js'

const liveKey = Symbol.for('aurabot.voice-outbox.running.v1')
const live = globalThis[liveKey] ||= new Map()
const resumable = new Set(['queued', 'synthesizing', 'ready'])
const terminal = new Set(['sent', 'failed', 'cancelled', 'uncertain'])
const validReceipt = (r) => r?.message_id != null && !['', '0'].includes(String(r.message_id)) && !String(r.message_id).startsWith('sim-')
const validId = (id) => /^[a-f0-9-]{36}$/.test(String(id || ''))

export function createVoiceOutbox({ file, synthesize, send, record, authorized, connected = () => true, log, now = Date.now, ttlMs = 10 * 60_000 }) {
  file = resolve(file)
  const audioDir = join(dirname(file), 'voice-outbox-audio')
  let disposed = false, draining = false
  function load() {
    if (!existsSync(file)) return { version: 1, jobs: [] }
    const state = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    if (state.version !== 1 || !Array.isArray(state.jobs) || state.jobs.some((j) => !validId(j.id))) throw new Error('语音待发账本格式错误，停止自动接续')
    return state
  }
  function audio(job) {
    if (!job?.audio || !validId(job.id) || !new RegExp('^' + job.id + '\\.(?:wav|mp3|ogg|silk|amr)$').test(job.audio)) throw new Error('语音成品路径无效')
    return join(audioDir, job.audio)
  }
  function update(id, change) {
    const state = load(), job = state.jobs.find((j) => j.id === id)
    if (!job) return null
    change(job); job.updatedAt = now()
    writeJson(file, state)
    return job
  }
  function releaseAudio(job) {
    if (!job.audio) return
    try { unlinkSync(audio(job)) } catch (error) { if (error.code !== 'ENOENT') log?.debug?.('语音暂存清理稍后再试：', error.message) }
  }
  function enqueue(input) {
    const state = load()
    // Terminal records are bounded; pending and uncertain results are never evicted by new jobs.
    const done = state.jobs.filter((j) => terminal.has(j.status) && j.status !== 'uncertain').sort((a, b) => b.updatedAt - a.updatedAt)
    const keep = new Set(done.slice(0, 100).map((j) => j.id))
    for (const job of done.slice(100)) releaseAudio(job)
    state.jobs = state.jobs.filter((j) => !terminal.has(j.status) || j.status === 'uncertain' || keep.has(j.id))
    const job = { ...input, id: randomUUID(), at: now(), updatedAt: now(), status: 'queued', recorded: false }
    state.jobs.push(job); writeJson(file, state)
    return job
  }
  const get = (id) => load().jobs.find((j) => j.id === id)
  function maySend(job) { return !disposed && now() - job.at < ttlMs && authorized(job) }
  function controls(id) {
    return {
      beforeSubmit() {
        const job = get(id)
        if (!job || job.status !== 'ready' || !maySend(job) || !connected()) return false
        update(id, (j) => { j.status = 'submitting'; j.submittedAt = now(); j.error = '' })
        return true
      },
      onReceipt(receipt) {
        // Persist even if this hub was disposed while awaiting the response.
        update(id, (j) => {
          if (validReceipt(receipt)) { j.status = 'sent'; j.messageId = String(receipt.message_id); j.sentAt = now() }
          else { j.status = 'uncertain'; j.error = '网关未返回有效消息回执，不能自动重发' }
        })
        return validReceipt(receipt)
      },
      onSubmitError(error) {
        update(id, (j) => {
          if (j.status === 'sent') return
          j.status = groupRateLimit(error) ? 'ready' : isDefiniteFailure(error) ? 'failed' : 'uncertain'
          j.error = String(error.message || error).slice(0, 300)
        })
      },
      onRecorded() {
        const job = update(id, (j) => { if (j.status === 'sent') j.recorded = true })
        if (job?.recorded) releaseAudio(job)
      },
    }
  }
  async function run(id) {
    const key = file + ':' + id
    if (disposed || live.has(key)) return { status: 'deferred' }
    const initial = get(id)
    if (!initial || !resumable.has(initial.status)) return initial || { status: 'cancelled' }
    live.set(key, true)
    let phase = initial.status === 'ready' ? 'delivery' : 'synthesis'
    try {
      if (now() - initial.at >= ttlMs || !authorized(initial)) return update(id, (j) => { j.status = 'cancelled'; j.error = '语音已过期或发送权限已撤销' })
      let job = initial
      if (job.status !== 'ready') {
        update(id, (j) => { j.status = 'synthesizing' })
        const voice = await synthesize(job)
        const suffix = extname(voice.file).toLowerCase()
        if (!['.wav', '.mp3', '.ogg', '.silk', '.amr'].includes(suffix)) throw new Error('语音成品格式不支持暂存')
        mkdirSync(audioDir, { recursive: true })
        const name = id + suffix
        copyFileSync(voice.file, join(audioDir, name))
        // Reload during synthesis must not discard the completed artifact or resurrect a cancellation.
        job = update(id, (j) => { if (j.status === 'synthesizing') { j.audio = name; j.engine = voice.engine; j.status = 'ready' } })
        if (job?.status !== 'ready') { releaseAudio({ id, audio: name }); return job }
      }
      phase = 'delivery'
      if (!maySend(job)) return disposed ? { ...job, deferred: true } : update(id, (j) => { j.status = 'cancelled'; j.error = '发送权限已撤销' })
      if (!connected()) return { ...job, deferred: true }
      if (!existsSync(audio(job))) throw new Error('待发语音成品不存在')
      const receipt = await send(job, audio(job), controls(id))
      job = get(id)
      if (job.status === 'sent' || job.status === 'uncertain' || job.status === 'failed' || job.status === 'cancelled') return job
      if (job.status === 'submitting') return update(id, (j) => { j.status = 'uncertain'; j.error = '已提交，发送结果不确定，不能自动重发' })
      // A pre-submission reload/disconnection is safe to resume. An active send hook declining is not.
      if (disposed || !connected()) return { ...job, deferred: true }
      return update(id, (j) => { j.status = 'cancelled'; j.error = receipt ? '未取得可确认的回执' : '发送前被过滤或权限已变化' })
    } catch (error) {
      const job = get(id)
      if (job?.status === 'sent') return job
      if (job && !terminal.has(job.status)) update(id, (j) => { j.status = j.status === 'submitting' ? 'uncertain' : 'failed'; j.error = String(error.message || error).slice(0, 300) })
      return { ...get(id), phase, error, definite: job?.status !== 'submitting' || isDefiniteFailure(error) }
    } finally { live.delete(key) }
  }
  async function recover() {
    if (disposed || draining) return
    draining = true
    try {
      const waiting = new Set()
      for (const job of load().jobs) {
        if (disposed) break
        if (waiting.has(job.chatId)) continue
        if (live.has(file + ':' + job.id)) { waiting.add(job.chatId); continue }
        if (job.status === 'submitting') { update(job.id, (j) => { j.status = 'uncertain'; j.error = '上次在提交后中断，不能自动重发' }); continue }
        if (job.status === 'sent' && !job.recorded) {
          await record?.(job)
          controls(job.id).onRecorded()
        } else if (resumable.has(job.status)) await run(job.id)
      }
    } catch (error) { log?.warn?.('语音接续失败：', error.message) }
    finally { draining = false }
  }
  return { enqueue, run, recover, get,
    cancel(id) { return update(id, (j) => { if (resumable.has(j.status)) { j.status = 'cancelled'; j.error = '已取消' } }) },
    status() { return load().jobs.map(({ audio: _audio, ...j }) => j) },
    dispose() { disposed = true },
  }
}
