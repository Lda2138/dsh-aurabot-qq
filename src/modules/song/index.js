// 内置模块：翻唱。点歌 → 网易云下载 → 分离人声 → RVC 换成她的音色 → 混音 → 发语音条。
// 换声这一步可以在「本地接口」里接你自己的推理（so-vits-svc、自己训练的 RVC……）；整个模块也可以替换掉。

import { createSongStudio, checkRoot, listDrives } from '../../song/studio.js'
import { defineTool, str, int, bool } from '../../tools/tools.js'
import { isOwner, ownerNameOf, isOwnerSpace } from '../../chat/access.js'

export default {
  id: 'song',
  name: '翻唱',
  version: '1.0.0',
  description: '用她的声音翻唱一首歌，做好发语音条（qq_song_cover、/sing）',
  tab: 'song',
  files: ['song/studio.js'],
  setup(api) {
    const { hub, local, http } = api.core
    const mood = api.lazy('mood')
    const memory = api.lazy('memory')
    const song = createSongStudio({
      local,
      getConfig: api.config,
      log: api.log,
      sendVoiceFile: (chatId, file, note, opts) => hub.sendVoiceFile(chatId, file, note, opts),
      sendText: (chatId, text) => hub.sendText(chatId, text),
      onSung: (title, chatId) => {
        const cfg = api.config()
        mood.nudge?.(8, `唱完了「${title}」`)
        // 唱过的歌记成她的经历：私聊记到对方头上
        const uid = String(chatId).startsWith('private:') ? String(chatId).slice(8) : ''
        const who = isOwner(cfg, uid) ? ownerNameOf(cfg, uid) : uid ? '对方' : '群里'
        memory.addEvent?.({ text: `给${who}唱了《${title}》`, about: uid, tags: ['唱歌'], importance: 0.5 })
        api.emit('song/sung', { title, chatId })
      },
    })

    // Audio never leaves owner private chats and configured family groups.
    const canSendTo = (chatId) => isOwnerSpace(api.config(), chatId) ? '' : '翻唱语音仅限主人私聊和家庭群'

    // 面板里打开了才给她（没开就别让她答应唱歌）
    api.tool(({ chat, sessionId }) => (api.config().song.enabled && isOwnerSpace(api.config(), chat.chatId) ? defineTool({
      name: 'qq_song_cover',
      description: '用你自己的声音翻唱一首歌，做好后自动以语音条发到当前聊天（做好要一会儿，调用后先简单回一句「等我一下」就好）。song 写歌名，最好带上歌手，比如「小幸运 田馥甄」。pitch 是变调半音：你是女声，原唱是男声时一般 +12，原唱是女声时 0。别人说清唱、不要伴奏时 acapella 填 true。',
      properties: { song: str('歌名（可以带歌手）'), pitch: int('变调半音：原唱男声 +12，女声 0'), acapella: bool('清唱：只留人声，不要伴奏') },
      required: ['song'],
      slow: '好，我这就去弄，稍等一会儿（做好了发你）。',
      execute: async ({ song: name, pitch, acapella }) => {
        if (api.config().song.ownerOnly && !hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '只有主人能点歌' }
        // 之前做好了却没发出去（比如插件重载过）：同一首歌直接补发，不重做一遍
        const waiting = song.findPendingFor({ song: name, pitch, acapella })
        if (waiting) {
          const sent = await song.resend(waiting.id, { chatId: chat.chatId, canSend: canSendTo })
          if (sent.ok) return { ok: true, message: `${sent.message}（这首之前已经做好了，直接补发，没重做）` }
        }
        return song.request({ song: name, pitch, acapella, chatId: chat.chatId })
      },
    }) : []))

    // 做成了却没发出去（热重载、网关抽风）时补发：不填 id 就是看清单
    api.tool(({ chat, sessionId }) => (api.config().song.enabled && isOwnerSpace(api.config(), chat.chatId) ? defineTool({
      name: 'qq_song_resend',
      description: '翻唱做好了却没发出去时用它补发（插件重载、网关出问题之后）。不填 id 先列出待补发的清单；填 id 就补发那一条：有成品直接发语音条，没成品就照原样重做。',
      properties: { id: str('待补发的编号；不填就是看清单') },
      execute: async ({ id }) => {
        if (api.config().song.ownerOnly && !hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '只有主人能补发' }
        if (!id) {
          const list = song.pending()
          if (!list.length) return { ok: true, message: '没有做成没发出去的翻唱' }
          return {
            ok: true,
            message: list.map((p) => `${p.id}｜${p.title || p.query}｜→ ${p.chatId}｜${p.made ? '有成品，能直接补发' : '没有成品，要重做'}${p.reason ? `｜${p.reason}` : ''}`).join('\n'),
            list: list.map(({ id: each, title, chatId, made, reason, tries }) => ({ id: each, title, chatId, made, reason, tries })),
          }
        }
        return song.resend(String(id), { canSend: canSendTo })
      },
    }) : []))

    api.route('/song/status', async () => ({ ok: true, ...song.status() }))
    api.route('/song/pending', async () => ({ ok: true, list: song.pending().map(({ id, at, title, chatId, made, reason, tries }) => ({ id, at, title, chatId, made, reason, tries })) }))
    api.route('/song/resend', async (req) => {
      const b = await http.body(req)
      return song.resend(b.id ? String(b.id) : '', { chatId: b.chatId ? String(b.chatId) : undefined, canSend: canSendTo })
    })
    api.route('/song/install', async () => song.install())
    api.route('/song/root/check', async (req) => ({ ok: true, ...checkRoot(http.query(req).path || '') }))
    api.route('/song/drives', async () => ({ ok: true, list: listDrives() }))
    api.route('/song/search', async (req) => {
      try { return { ok: true, list: await song.search(http.query(req).q || '') } } catch (error) { return { ok: false, message: error.message, list: [] } }
    })
    api.route('/song/account', async () => song.account())
    // 导入音色：面板把文件原样传上来（.zip / .pth / .index），文件名放在 ?name= 里
    api.route('/song/import', async (req) => {
      const name = http.query(req).name || ''
      try {
        const buf = await http.raw(req, 1024 * 1024 * 1024)
        if (!buf.length) return { ok: false, message: '文件是空的' }
        const r = song.importModels(name, buf)
        if (r.ok) api.log.info('导入音色：' + r.message)
        return r
      } catch (error) {
        return { ok: false, message: '导入失败：' + error.message }
      }
    })
    api.route('/song/voice/delete', async (req) => song.deleteVoice(String((await http.body(req)).id || '')))
    // 面板里试唱：发到主人私聊
    api.route('/song/request', async (req) => {
      const b = await http.body(req)
      return song.request({ song: b.song, songId: b.songId, pitch: b.pitch, voice: b.voice, chatId: b.chatId || `private:${api.config().ownerQQ}` })
    })
    return song
  },
}
