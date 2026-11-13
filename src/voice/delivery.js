// 语音条的发送前处理：给真实音频补前导静音，不让模型读一个「停顿」词。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { parseWav } from './wav.js'
import { findFfmpeg } from '../core/img.js'
import { dataDir } from '../core/store.js'

export function prependWavSilence(buf, milliseconds = 500) {
  const { rate, channels } = parseWav(buf)
  const frames = Math.round(rate * Math.max(0, milliseconds) / 1000)
  const silence = Buffer.alloc(frames * channels * 2)
  let off = 12
  while (off + 8 <= buf.length) {
    const size = buf.readUInt32LE(off + 4)
    if (buf.toString('ascii', off, off + 4) === 'data') {
      const start = off + 8
      if (start + size > buf.length || size % (channels * 2)) throw new Error('WAV 音频块不完整')
      const out = Buffer.concat([buf.subarray(0, start), silence, buf.subarray(start)])
      out.writeUInt32LE(out.length - 8, 4)
      out.writeUInt32LE(size + silence.length, off + 4)
      return out
    }
    off += 8 + size + (size & 1)
  }
  throw new Error('WAV 缺 data')
}

/** 这条语音要念多少字：不算标点和空白；音效标签（[叹气] [停顿]…）每个按两个字的时间算。 */
export function spokenCharCount(text) {
  const raw = String(text ?? '')
  const tags = raw.match(/\[[^\[\]\s]{1,4}\]/g) || []
  return raw.replace(/\[[^\[\]\s]{1,4}\]/g, '').replace(/[^\p{L}\p{N}]/gu, '').length + tags.length * 2
}

/**
 * 说话引擎（Breeze 等）唱不了歌：语气写着「唱」或正文带 [唱歌]，又超过 maxChars 个字，就当成「硬唱一整段」。
 * 这种合成出来是 10 多秒、两字一秒的拖腔（11-11 20:25 那条 14.9 秒），改发文字更自然。哼一两句（短的）照常发语音。
 */
export function isLongSinging(text, tone = '', maxChars = 12) {
  const singing = /\[唱歌\]/.test(String(text)) || /唱/.test(String(tone))
  if (!singing || !(Number(maxChars) > 0)) return false
  return String(text).replace(/\[[^\[\]\s]{1,4}\]/g, '').replace(/[^\p{L}\p{N}]/gu, '').length > Number(maxChars)
}

/**
 * 这条语音该加速多少倍（1 = 不动）。
 * Breeze 的语速参数和念法提示都压不住它的随机快慢：同一句 31 个字，实测 5.4 ~ 10.3 秒都出现过（用户反馈：长语音说话很慢）。
 * 所以合成完量一下「每秒几个字」，比 target 慢的才补到 target，最多加速 max 倍；短句、唱歌、本来就该慢的语气不动或少动。
 */
export function paceFactor(text, seconds, { tone = '', target = 4.4, minChars = 15, max = 1.1 } = {}) {
  const goal = Number(target) || 0
  const secs = Number(seconds) || 0
  if (goal <= 0 || secs <= 0) return 1
  if (/\[(唱歌|哼歌)\]/.test(String(text)) || /唱|哼/.test(String(tone))) return 1
  const n = spokenCharCount(text)
  if (n < minChars) return 1
  // 困、哭、委屈、小声这类语气本来就慢：目标放低，只救特别拖的
  const want = /困|慢|拖|懒|哭|抽泣|难过|低落|委屈|虚弱|小声|耳语|叹/.test(String(tone)) ? goal * 0.85 : goal
  const factor = Math.min(max, want / (n / secs))
  return factor < 1.05 ? 1 : Math.round(factor * 100) / 100
}

/** 偏慢的语音用 ffmpeg 不变调加速（atempo）。量不出时长、没有 ffmpeg 或处理失败都原样返回。 */
export async function paceVoice(file, text, { tone = '', target = 4.4, max = 1.1, ffmpegPath = '', log } = {}) {
  let seconds = 0
  try {
    const { rate, channels, data } = parseWav(readFileSync(file))
    seconds = data.length / (rate * channels * 2)
  } catch (error) { return { file, factor: 1, seconds: 0 } }
  const factor = paceFactor(text, seconds, { tone, target, max })
  if (factor === 1) return { file, factor, seconds }
  const ffmpeg = findFfmpeg(ffmpegPath)
  if (!ffmpeg) return { file, factor: 1, seconds }
  const out = join(dataDir('voice-cache'), `${randomUUID()}-pace.wav`)
  mkdirSync(dirname(out), { recursive: true })
  try {
    await new Promise((resolve, reject) => {
      const p = spawn(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', file, '-filter:a', `atempo=${factor}`, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', out], { windowsHide: true })
      let err = ''
      const timer = setTimeout(() => { p.kill(); reject(new Error('超时')) }, 30000)
      p.stderr.on('data', (d) => { err = (err + d).slice(-600) })
      p.on('error', (e) => { clearTimeout(timer); reject(e) })
      p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(err || `ffmpeg 退出码 ${code}`)) })
    })
    return { file: out, factor, seconds }
  } catch (error) {
    log?.debug?.('语音加速没成功，用原速：', error.message)
    return { file, factor: 1, seconds }
  }
}

export async function prependVoiceSilence(file, milliseconds = 500, { ffmpegPath = '' } = {}) {
  const ms = Math.max(0, Math.min(2000, Math.round(Number(milliseconds) || 0)))
  if (!ms) return file
  const out = join(dataDir('voice-cache'), `${randomUUID()}-lead.wav`)
  mkdirSync(dirname(out), { recursive: true })
  const buf = readFileSync(file)
  try {
    writeFileSync(out, prependWavSilence(buf, ms))
    return out
  } catch (error) {
    const ffmpeg = findFfmpeg(ffmpegPath)
    if (!ffmpeg) throw new Error('语音开头补静音需要 PCM16 WAV 或 ffmpeg：' + error.message)
    await new Promise((resolve, reject) => {
      const p = spawn(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', file, '-af', `adelay=${ms}:all=1`, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', out], { windowsHide: true })
      let err = ''
      const timer = setTimeout(() => { p.kill(); reject(new Error('补静音超时')) }, 30000)
      p.stderr.on('data', (d) => { err = (err + d).slice(-600) })
      p.on('error', (e) => { clearTimeout(timer); reject(e) })
      p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('补静音失败：' + err)) })
    })
    return out
  }
}
