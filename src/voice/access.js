// Outgoing audio is restricted by destination, even when an owner requests it.
import { isOwnerSpace } from '../chat/access.js'

export const VOICE_SCOPE_MESSAGE = '语音仅限主人私聊和家庭群，这里请使用文字'
export const voiceTargetAllowed = (cfg, chatId) => isOwnerSpace(cfg, String(chatId || ''))
export function assertVoiceTarget(cfg, chatId) {
  if (!voiceTargetAllowed(cfg, chatId)) throw new Error(VOICE_SCOPE_MESSAGE)
}

const audioFile = /\.(?:wav|mp3|flac|ogg|opus|silk|amr|aac|m4a|wma|aiff?)(?:[?#]|$)/i
export function containsAudioPayload(value, depth = 0) {
  if (depth > 32) return true // An opaque deeply nested forward cannot be verified.
  if (typeof value === 'string') {
    if (/\[CQ:(?:record|voice|audio|forward)(?:,|\])/i.test(value)) return true
    const text = value.trim()
    if (/^[\[{]/.test(text)) { try { return containsAudioPayload(JSON.parse(text), depth + 1) } catch {} }
    return false
  }
  if (Array.isArray(value)) return value.some(v => containsAudioPayload(v, depth + 1))
  if (!value || typeof value !== 'object') return false
  const type = String(value.type || '').toLowerCase()
  if (['record', 'voice', 'audio', 'forward'].includes(type)) return true
  if (type === 'node' && value.data?.id != null && !value.data?.content) return true
  if (type === 'file' && [value.data?.file, value.data?.name, value.data?.url].some(v => audioFile.test(String(v || '')))) return true
  return Object.values(value).some(v => containsAudioPayload(v, depth + 1))
}

export function actionChatId(action, params = {}) {
  if (/private|friend/.test(action) || params.message_type === 'private') return params.user_id ? `private:${params.user_id}` : ''
  if (/group/.test(action) || params.message_type === 'group') return params.group_id ? `group:${params.group_id}` : ''
  return params.group_id ? `group:${params.group_id}` : params.user_id ? `private:${params.user_id}` : ''
}

export function assertVoiceAction(cfg, action, params = {}) {
  if (!/^(?:send_|forward_|upload_)/.test(action) && action !== 'get_ai_record') return
  const chatId = actionChatId(action, params)
  const audio = /^(?:send_group_ai_record|get_ai_record)$/.test(action) || containsAudioPayload(params.message) || containsAudioPayload(params.messages) ||
    (/^forward_(?:friend|group)_single_msg$/.test(action)) ||
    (/^upload_(?:private|group)_file$/.test(action) && [params.file, params.name].some(v => audioFile.test(String(v || ''))))
  if (audio) assertVoiceTarget(cfg, chatId)
}
