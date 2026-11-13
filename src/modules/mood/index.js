// 内置模块：心情。聊天让她开心或低落，心情影响她发表情、发语音的频率和回复快慢，也会写进她的上下文。
// 导出 createMood 的返回值：nudge(变化, 原因)、label()、state()、effects()、contextLine()、observe()、judge()。

import { createMood } from '../../features/companion.js'
import { isOwnerChat, isOwnerSpace, ownerNameOf } from '../../chat/access.js'

export default {
  id: 'mood',
  name: '心情',
  version: '1.0.0',
  description: '她的心情：会随聊天起伏，影响表情 / 语音频率和回复快慢',
  tab: 'mood',
  files: ['features/companion.js'],
  setup(api) {
    const mood = createMood({ getConfig: api.config, dsh: api.dsh, log: api.log })
    api.context(({ chat }) => {
      if (chat.kind === 'system') return ''
      const chatId = chat.chatId || (chat.kind === 'group' ? `group:${chat.groupId}` : `private:${chat.userId}`)
      return mood.contextLine({ chatId, family: isOwnerSpace(api.config(), chatId) })
    })
    api.on('activity', (a) => {
      const cfg = api.config()
      if (a.kind === 'in' && a.text) mood.observe(a.text, a.nickname, { direct: a.direct, owner: a.owner })
      if (a.kind === 'silent' && a.text && cfg.mood.judge) mood.observe(a.text, a.nickname, { silent: true })
      // 完整互动与成功送达是不同事件；主动搭话意图由发起方显式声明。
      if (a.kind === 'out' && a.source === 'interaction' && a.reply && a.turnId && !String(a.chatId).startsWith('system:')) {
        return mood.judge({ ...a, input: { ...a.input, family: a.input?.family ?? isOwnerSpace(cfg, a.chatId) }, who: a.who || (String(a.chatId).startsWith('group:') ? '群里的人' : isOwnerChat(cfg, a.chatId) ? ownerNameOf(cfg, String(a.chatId).slice(8)) : '对方'), origin: a.origin || 'user' }).catch((error) => api.log?.warn?.('心情事件处理失败：', error.message))
      }
    })
    return mood
  },
}
