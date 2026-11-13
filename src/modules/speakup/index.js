// 内置模块：主动搭话。AI 在到期联系人和家庭群中选择对象、话题与下次考虑时间。

import { createSpeakUp } from '../../features/companion.js'

export default {
  id: 'speakup',
  name: '主动搭话',
  version: '1.0.0',
  description: '按近况主动联系家人、白名单朋友或家庭群，成功送达才计次数',
  tab: 'speakup',
  files: ['features/companion.js', 'features/family-activity.js'],
  setup(api) {
    const { hub, mutes } = api.core
    const speakUp = createSpeakUp({ getConfig: api.config, hub, log: api.log, isMuted: (chatId) => mutes.muted(chatId), memory: () => api.use('memory') })
    api.on('activity', (a) => speakUp.observe(a))
    api.every(60_000, () => speakUp.tick(), '主动搭话')
    api.route('/speakup/preview', async () => {
      await hub.refreshPrivateReachability?.()
      return { ok: true, readOnly: true, candidates: speakUp.preview() }
    })
    api.route('/speakup/fire', async () => {
      if (!api.config().enabled) return { ok: false, message: '先打开总开关' }
      await speakUp.fire('手动')
      return { ok: true, message: '叫她去找你了' }
    })
    return speakUp
  },
}
