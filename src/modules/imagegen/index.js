// 内置模块：生图。她能画图发到聊天里（OpenAI 兼容的生图服务，或「本地接口」里接的 SD WebUI / ComfyUI）。

import { readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createImageGen, drawResultBlocks, drawToolMessage, imageToolBlock, resolveDrawImage, selfFacePath, selfPhotoPrompt } from '../../features/imagegen.js'
import { listPaintings, metaOf, openPaintFolder, paintingPath, rememberPainting, removePainting, savePainting, resolvePainting } from '../../features/paintings.js'
import { PHOTO_SHARING_RULE, isSelfPhotoRequest, reviewImageRequest, recordPhotoSubject, selfPhotoPath, withSelfPhotoShare } from '../../features/photo-sharing.js'
import { defineTool, str } from '../../tools/tools.js'
import { dataDir } from '../../core/store.js'
import { mimeOf } from '../../chat/inbound.js'
import { createArtworkMemory } from '../../features/artwork-memory.js'
import { isOwnerSpaceChat } from '../../chat/access.js'
const ARTWORK_RECALL_RULE = '回顾具体旧画的内容、创作启发或家人互相画的作品，先调用qq_recall_artwork查记录，再结合具体内容回答；问旧画不是新生图指令。检索结果分人类原话、创作提示词及已发送状态，提示词不证明实际画面。需要确认候选原图时再用image参数核对；查不到说这次没查到，不声称图片没保存。'

export default {
  id: 'imagegen',
  name: '生图',
  version: '1.0.0',
  description: '画一张图发到聊天里（qq_draw_image）',
  tab: 'imagegen',
  files: ['features/imagegen.js', 'features/image-shape.js', 'features/paintings.js', 'features/photo-sharing.js', 'features/artwork-memory.js', 'features/codex-auth.js', 'features/codex-image.js'],
  setup(api) {
    const { hub, local } = api.core
    const memory = api.lazy('memory')
    const gen = createImageGen({ getConfig: api.config, log: api.log, local })
    const artwork = createArtworkMemory({ getConfig: api.config, hub })
    api.route('/image/jobs', async () => ({ ok: true, items: artwork.list().slice(-30).map(({ prompt, ...r }) => r) }))
    const artworkLookup = (chat, query, sessionId) => artwork.search(chat, query, { shared: isOwnerSpaceChat(api.config(), chat) && Boolean(hub.turnSendersAllOwner?.(sessionId)) })
    api.tool(({ chat, sessionId }) => chat.kind === 'system' ? [] : defineTool({
      name: 'qq_recall_artwork',
      description: '只读查以前画过或聊过的作品、照片及家人互相送的画，返回时间、说话人、原话、创作提示词和真实送达状态。先查再谈画面或启发，不生成、不重发。image可选返回的图库文件名，用于核对一张候选原图。',
      properties: { query: str('作品内容、人物、时间或想回顾的问题'), image: str('可选：本次检索返回的确切图库文件名；不接受路径或网址') },
      required: ['query'], render: drawResultBlocks,
      execute: async ({ query, image }) => {
        const items = artworkLookup(chat, String(query || ''), sessionId)
        const out = { ok: true, items, message: items.length ? '这是原记录候选，先核对指代；人类描述不当作独立核实的画面，提示词只是创作意图。\n' + JSON.stringify(items) : '本次没查到匹配记录；这不证明旧图不存在，可用recall_memory或qq_chat_history继续核对。' }
        if (image) {
          const match = items.find((r) => r.file === image)
          const path = match && paintingPath(image)
          if (!path) return { ok: false, message: '该图不在本次可查记录中；不能凭文件名跨聊天读取。' }
          if (api.config().imageGen.seeOwn === false || !(await hub.canSeeImages(chat))) return { ...out, message: out.message + ' 当前不提供原图视觉，不能把文字当已看过。' }
          out.image = await imageToolBlock(api.dsh, readFileSync(path), { ffmpegPath: api.config().bili?.ffmpegPath })
          if (out.image) out.message += ' 已提供这一张候选原图，描述须以实际看到的画面为准。'
        }
        return out
      },
    }))
    const review = (args, { sessionId } = {}) => {
      const file = args.image ? paintingPath(String(args.image)) : ''
      const referenceSelf = isSelfPhotoRequest({ image: args.image, referenceSelf: Boolean(file && selfPhotoPath(file)) })
      return reviewImageRequest({ ...args,
        ask: api.core.ask, referenceSelf,
        referencePrompt: file ? metaOf(String(args.image)).prompt : '',
        context: args.context ?? (sessionId ? [hub.prevTextOf?.(sessionId), hub.lastTextOf?.(sessionId)].filter(Boolean).join('\n') : ''),
        persona: api.core.personas?.current?.() || '', stylePrompt: api.config().imageGen.stylePrompt,
      }).then((result) => ({ ...result, referenceSelf }))
    }
    const denied = (result) => result.ok && result.decision === 'deny'
      ? { ok: false, code: 'IMAGE_CONTENT_REJECTED', message: '这次画面不符合未成年角色正常衣着、非性化的内容边界，未生成图片；按本次请求自然回应，不延续为以后都不分享', reason: result.reason }
      : result
    const auth = gen.codexAuth
    api.onDispose?.(() => gen.dispose())
    const accountAction = (fn) => async (req) => {
      if (req?.method !== 'POST' || !/^application\/json(?:\s*;|$)/i.test(String(req.headers?.['content-type'] || ''))) return { ok: false, message: '账号操作需要 POST JSON 请求' }
      return fn(req)
    }
    api.route('/image/codex/status', async () => ({ ok: true, ...auth.status(), login: auth.loginStatus() }))
    api.route('/image/codex/login', accountAction(async () => ({ ok: true, ...(await auth.startLogin()), ...auth.loginStatus() })))
    api.route('/image/codex/login/status', async () => ({ ok: true, ...auth.loginStatus(), ...auth.status() }))
    api.route('/image/codex/complete', accountAction(async (req) => {
      const body = await api.core.http.body(req)
      const credential = await auth.completeLogin(String(body?.input || ''))
      return { ok: true, email: credential.email || '', accountId: credential.accountId || '' }
    }))
    api.route('/image/codex/cancel', accountAction(async () => ({ ok: true, ...auth.cancelLogin('已取消') })))
    api.route('/image/codex/logout', accountAction(async () => ({ ok: true, ...auth.logout() })))

    // 她的画作：面板底下的图库（直接读存图目录，可以单张删、开文件夹）
    api.route('/image/gallery', async (req) => {
      const q = api.core.http.query(req)
      const limit = q && q.limit ? Number(q.limit) : api.config().imageGen.galleryShown
      return { ok: true, ...listPaintings({ limit }), dir: dataDir('imagegen') }
    })
    api.route('/image/gallery/image', async (req, res) => {
      const p = paintingPath(api.core.http.query(req).file)
      if (!p) return api.core.http.send(res, 404, '')
      const buf = readFileSync(p)
      api.core.http.send(res, 200, buf, String(mimeOf(buf) || 'image/png'))
    })
    api.route('/image/gallery/delete', async (req) => {
      const b = await api.core.http.body(req).catch(() => ({}))
      return removePainting(String((b && b.file) || ''))
    })
    api.route('/image/open-folder', async () => openPaintFolder())
    // 管理面只读预检：真实询问语义模型，不生图、不发送、不记忆。
    api.route('/image/review', async (req) => {
      if (req?.method !== 'POST' || !/^application\/json(?:\s*;|$)/i.test(String(req.headers?.['content-type'] || ''))) return { ok: false, message: '图片预检需要 POST JSON 请求' }
      const body = await api.core.http.body(req)
      return review({ prompt: body?.prompt, context: body?.context, self_photo: body?.self_photo, image: body?.image })
    })

    // ---- 她的样子（自拍参考图）：用 AI 生成原创的脸，挑一张定下来；以后画她自己都照这张 ----
    const candDir = () => dataDir('imagegen-self', 'candidates')
    const candPath = (name) => (/^[\w.-]+\.png$/.test(String(name || '')) ? join(candDir(), String(name)) : '')
    const SELF_DEFAULT_PROMPT = '一张真实的手机自拍照：17 岁的中国女生，原创长相（不要像任何明星或真实存在的人），黑茶色微卷长发、空气刘海，圆脸，皮肤白，眼睛大而圆，素颜淡妆，有点俏皮地嘟着嘴；穿浅灰色宽松短袖 T 恤，坐在车里，自然光，竖构图，真实摄影质感，不要二次元、不要过度美颜。'
    api.route('/image/self', async () => {
      const p = selfFacePath()
      const list = existsSync(candDir()) ? readdirSync(candDir()).filter((n) => n.endsWith('.png')).map((n) => ({ name: n, at: statSync(join(candDir(), n)).mtimeMs })).sort((a, b) => b.at - a.at).slice(0, 12) : []
      return { ok: true, has: existsSync(p), at: existsSync(p) ? statSync(p).mtimeMs : 0, candidates: list, defaultPrompt: SELF_DEFAULT_PROMPT }
    })
    api.route('/image/self/image', async (req, res) => {
      const q = api.core.http.query(req)
      const p = q.name ? candPath(q.name) : selfFacePath()
      if (!p || !existsSync(p)) return api.core.http.send(res, 404, '')
      api.core.http.send(res, 200, readFileSync(p), 'image/png')
    })
    api.route('/image/self/generate', async (req) => {
      if (!gen.enabled()) return { ok: false, message: '生图还没配好' }
      const b = await api.core.http.body(req).catch(() => ({}))
      const prompt = String((b && b.prompt) || SELF_DEFAULT_PROMPT).slice(0, 800)
      try {
        const result = denied(await review({ prompt, self_photo: true, context: '管理面生成原创角色长相候选，不分享到聊天' }))
        if (!result.ok) return result
        const buf = await gen.generate(selfPhotoPrompt(prompt), { shape: 'portrait' })
        mkdirSync(candDir(), { recursive: true })
        const name = `cand-${Date.now()}.png`
        writeFileSync(join(candDir(), name), buf)
        return { ok: true, name }
      } catch (error) {
        return { ok: false, message: '生成失败：' + error.message }
      }
    })
    api.route('/image/self/pick', async (req) => {
      const b = await api.core.http.body(req).catch(() => ({}))
      const p = candPath(b && b.name)
      if (!p || !existsSync(p)) return { ok: false, message: '没有这张候选图' }
      mkdirSync(join(selfFacePath(), '..'), { recursive: true })
      copyFileSync(p, selfFacePath())
      api.log.info(`她的样子定为 ${b.name}`)
      return { ok: true, message: '定好了，以后她画自己都照这张脸' }
    })
    // 自拍画面怎么写：两只手不够用时模型会让筷子悬空、手臂错位
    const SELFIE_WRITING = '写本人照片的 prompt 时，一张只安排一个主要动作：前置自拍一只手要举手机，另一只手最多做一件事（托腮、比个手势、拿杯奶茶）；吃饭、写作业这种两只手都在忙的场景，写成手机架在桌上拍、别人帮拍，或者只拍桌上的东西。写具体场景和随手拍的样子，不要写「皮肤白、眼睛大、画面干净」这类美颜词。'
    api.rule?.(() => PHOTO_SHARING_RULE + ARTWORK_RECALL_RULE + (gen.enabled() && existsSync(selfFacePath())
      ? '本人照片的 image 填 self，脸照着固定参考长相；衣服、发型、场景、表情由你按本次情境选择，prompt 里不用再描写长相。' + SELFIE_WRITING
      : '固定长相参考图未设置时，不要编造已有固定脸；愿意分享时可以按人设外貌生成，不能保证每次同一张脸。' + SELFIE_WRITING))

    // ---- QQ 里的图片测试：主人发 /图片测试，按现在的生图设置画一张发过来，看通不通、要多久、画得怎样 ----
    // 不带内容画一张固定的日常照片（没有人物）；/图片测试 画面描述 按你写的画；以「自拍」开头照她定好的脸拍。
    // 测试指令直接请求已配置的生图服务，不调用插件语义审查；不记成她的经历、不进图库、不进聊天流水，只在插件日志里留一行。
    const TEST_IMAGE_PROMPT = '真实的手机随手拍：傍晚放学路上，小卖部门口蹲着一只圆滚滚的橘猫，暖黄色路灯，地上有点湿，生活感，不要人物'
    let imageTesting = false
    api.command?.({
      name: 'imagetest',
      aliases: ['图片测试', '测图片', '测试图片', '画图测试'],
      desc: '用现在的生图设置画一张发过来（/图片测试 画面描述 按你写的画；以「自拍」开头照她的脸拍）',
      run: (arg, msg) => {
        if (!gen.enabled()) return '生图还没配好，先在面板「生图」页设置'
        if (imageTesting) return '上一张还在画，等一下'
        const custom = String(arg || '').trim()
        const selfie = /^自拍/.test(custom)
        const prompt = (selfie ? custom.replace(/^自拍[\s，,：:]*/, '') || '在房间里随手拍一张日常自拍' : custom || TEST_IMAGE_PROMPT).slice(0, 800)
        imageTesting = true
        const quiet = (fn) => (hub.withoutRecord ? hub.withoutRecord(fn) : fn())
        const say = (text) => hub.sendText(msg.chatId, text)
        setTimeout(() => quiet(async () => {
          const t0 = Date.now()
          try {
            const reference = selfie && existsSync(selfFacePath()) ? await resolveDrawImage('self', { hub, chat: msg }) : null
            const buf = await gen.generate(selfie ? selfPhotoPrompt(prompt, { reference: Boolean(reference) }) : prompt, { shape: selfie ? 'portrait' : undefined, image: reference })
            const sent = await hub.sendSegments(msg.chatId, [{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }], '[图片测试]', { rememberText: `（图片测试）发送了一张测试图：${prompt.slice(0, 80)}` })
            const secs = Math.round((Date.now() - t0) / 1000)
            api.log.info(`图片测试：${sent ? '发出' : '没发出'}，${secs}s，${Math.round(buf.length / 1024)}KB${selfie ? '，自拍' + (reference ? '（照参考脸）' : '（没有参考脸）') : ''}`)
            await say(sent ? `画好了，用了 ${secs} 秒${selfie && !reference ? '（还没定她的样子，这张是按人设现编的脸）' : ''}` : '画好了但没发出去，看看网关和试运行')
          } catch (error) {
            api.log.warn('图片测试出错：', error.message)
            await say('没画成：' + String(error.message || error).slice(0, 120)).catch(() => {})
          } finally { imageTesting = false }
        }), 500)
        return { text: selfie ? '好，拍一张给你看看' : '好，画一张给你看看', record: false }
      },
    })

    api.tool(({ chat, sessionId }) => (gen.enabled() && chat.kind !== 'system' ? defineTool({
      name: 'qq_draw_image',
      description: '生成照片、绘画或修改图片，直接发到当前 QQ 聊天。自己的照片填 self_photo=true，并用 share_self 表达本次分享决定；普通画图和其他主体不需要自拍分享标志。照片/自拍 intent=photo，画画 drawing，改图 edit。等待时想说的话自己写进 waiting_message，不填就不先说。prompt 描述本次画面；已设置长相参考时本人照片 image=self，未设置可按人设生成并省略 image。image 也可用 last、quote 或图库文件名。主体及内容会结合上下文作语义检查，self_photo=false 不能覆盖本人判断。完成后的回复由你决定，不照抄工具状态，不声称调用真实摄像头。',
      properties: {
        prompt: str('画面描述'),
        waiting_message: str('等待时想先说的话，由你按当前情境自主措辞，简短口语；不想说可不填或留空。不是画面提示词，不会送给生图服务'),
        self_photo: { type: 'boolean', description: '是不是你自己的照片/自画像；自己的填 true，其他人的照片或普通绘画填 false' },
        share_self: { type: 'boolean', description: '你自主选择本次愿意把自己的照片分享到当前聊天时填 true；仅适用于本人照片' },
        intent: { type: 'string', enum: ['photo', 'drawing', 'edit'], description: '照片/自拍 photo；绘画 drawing；改图 edit' },
        image: str('可选参考图：已设置自己长相参考图时，自拍用 self；未设置可省略。last = 当前聊天最近收到的一张图；quote = 引用消息里的图；或图库文件名。禁止本地路径、网址'),
        shape: { type: 'string', enum: ['square', 'portrait', 'landscape', 'wide'], description: 'square 方图 1:1；portrait 竖图 2:3；landscape 横图 3:2；wide 宽幅 16:9。可不填' },
      },
      required: ['prompt'],
      slow: ({ waiting_message }) => String(waiting_message || '').trim(),
      // 能看图时把原图放进工具结果（image 块），她当轮就能看见自己画了什么
      render: drawResultBlocks,
      execute: async ({ prompt, shape, image, intent, self_photo, share_self }) => {
        if (api.config().imageGen.ownerOnly && !hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '画图只给主人画哦' }
        if (image && api.config().imageGen.img2img === false) return { ok: false, message: '参考图功能已关闭' }
        const startedAt = Date.now()
        const result = denied(await review({ prompt, image, self_photo }, { sessionId }))
        if (!result.ok) return result
        const ownPhoto = result.ownPhoto
        if (ownPhoto && share_self !== true) return { ok: false, code: 'SELF_SHARE_UNDECIDED', message: share_self === false ? '这次没有选择分享本人照片，尚未生成；按当前情境自然回应，下次重新判断' : '这是本人照片，需要你的本次分享决定；愿意时填 self_photo=true、share_self=true 再调用，场景和衣着由你选择' }
        const reference = await resolveDrawImage(image, { hub, chat })
        const purpose = intent || (ownPhoto || /照片|摄影|手机.{0,6}拍/.test(String(prompt || '')) ? 'photo' : reference ? 'edit' : 'drawing')
        const job = artwork.add({ chatId: chat.chatId, prompt: String(prompt || ''), intent: purpose, state: 'generating' })
        let buf
        try { buf = await gen.generate(ownPhoto ? selfPhotoPrompt(prompt, { reference: Boolean(reference) && result.referenceSelf }) : String(prompt || ''), { shape, image: reference }) }
        catch (error) { artwork.update(job.id, { state: 'failed', stage: 'generation' }); throw error }
        const saved = savePainting(buf, String(prompt || ''))
        if (saved) recordPhotoSubject(saved, ownPhoto)
        artwork.update(job.id, { state: 'generated', ...(saved ? { file: saved } : {}) })
        let sent
        try {
          artwork.update(job.id, { state: 'submitting' })
          sent = await hub.sendSegments(chat.chatId, [{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }], '[生图]', { rememberText: `生成并发送了${ownPhoto ? '自己的角色照片' : purpose === 'photo' ? '一张照片风格图片' : '一张图片'}，画面提示词：${String(prompt).slice(0, 260)}（提示词不等于已经看清实际画面）`, media: saved ? { artworkId: job.id, file: saved, prompt: String(prompt), intent: purpose } : undefined })
        } catch (error) { artwork.update(job.id, { state: 'uncertain', stage: 'delivery' }); throw error }
        if (!sent || !sent.message_id || String(sent.message_id).startsWith('sim-')) {
          artwork.update(job.id, { state: 'unconfirmed', stage: 'delivery' })
          return { ok: false, artworkId: job.id, saved: Boolean(saved), message: `图片已生成${saved ? '并保留' : '，但本机保存也未成功'}，没有确认送到QQ；不能说已经发出。先查实际送达状态，不要重新生成。` }
        }
        artwork.update(job.id, { state: 'sent', messageId: String(sent.message_id) })
        if (saved) api.log.debug(`生图已存盘：${saved}`)
        try { memory.addEvent?.({ text: `${purpose === 'photo' ? '生成并发送了一张角色照片' : purpose === 'edit' ? '修改并发送了一张图片' : '画了一张图'}（按提示词生成，不等于真实拍摄或已看清画面）：${String(prompt).slice(0, 110)}`, about: chat.kind === 'private' ? chat.userId : '', tags: [purpose === 'photo' ? '照片' : purpose === 'edit' ? '改图' : '画画'], importance: 0.4 }) }
        catch (error) { api.log.warn('生图已发送，但经历没记下来：', error.message) }
        let visual = (await hub.canSeeImages(chat)) === true
        // 「让她画完自己看一眼」是总开关：关掉就当没视觉能力处理 —— 不给图、也不给路径。
        const seeOwn = api.config().imageGen.seeOwn !== false
        // 只有明确能看图的模型才把图交给它；纯文本模型只拿文字，不会崩。
        // 图要先缩、再登记成 DSH 附件块 —— 直接塞 base64 会让下一轮请求整轮失败（实测）
        let img = null
        if (visual && seeOwn) {
          img = await imageToolBlock(api.dsh, buf, { ffmpegPath: api.config().bili && api.config().bili.ffmpegPath })
          if (!img) {
            // 图没给成：如实说看不了，别让她照着提示词编画面细节
            visual = false
            api.log.debug('这次生图没把图交给模型（缩图/登记失败），只给文字')
          }
        }
        const shown = Boolean(img)
        let message
        if (!visual) message = drawToolMessage({ visual: false, intent: purpose })
        else if (!seeOwn) message = drawToolMessage({ visual: true, seeOwn: false, intent: purpose })
        else if (!shown) message = drawToolMessage({ visual: false, intent: purpose })
        else message = drawToolMessage({ visual: true, seeOwn: true, intent: purpose })
        // 画作编号：换头像 / 收表情时用编号，别用路径（路径只在图真的交出去时才附带）
        const index = saved ? rememberPainting(chat.chatId, saved) : 0
        const out = {
          ok: true,
          message,
          prompt: String(prompt || ''),
          bytes: buf.length,
          elapsedMs: Date.now() - startedAt,
          ...(saved ? { path: saved } : {}),
        }
        if (img) out.image = img
        if (index && saved) out.message += `\n${purpose === 'drawing' ? '画作' : '图片'}编号 #${index}（想换头像、收成表情时用这个编号）`
        // 只有**图真的交给模型了**才把本地路径告诉她（#59）：收录表情包 / 存素材 / qq_add_sticker 用；
        // 看不了图或开关关着时不给路径，免得她知道路径就去读图，绕开「不给看」的判断。
        if (shown && saved) out.message += `\n已保存到本机：${saved}（要收录表情包、存素材时可以用这个路径）`
        return out
      },
    }) : []))

    api.tool(({ chat, sessionId }) => (chat.kind !== 'system' ? defineTool({
      name: 'qq_share_self_photo',
      description: '重发一张你自己的旧照片，用 share_self 表达本次愿意分享到当前聊天的决定；只能发到当前聊天，不用图片 Markdown 或发文件绕过。',
      properties: { image: str('已有自己照片的图片编号（如 #1）、最新，或图库文件名；不接受路径和网址'), share_self: { type: 'boolean', description: '这一次明确愿意分享给当前聊天里的人才填 true' } },
      required: ['image', 'share_self'],
      execute: async ({ image, share_self }) => {
        if (api.config().imageGen.ownerOnly && !hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '当前只允许两位主人请求分享照片' }
        if (share_self !== true) return { ok: false, message: '这次不发自己的照片，用你自己的口气回应即可' }
        const picked = resolvePainting(chat.chatId, image)
        if (!picked || !selfPhotoPath(picked.path)) return { ok: false, message: '没有找到这张已有的自拍；不要把其他图片当成自己的照片' }
        const sent = await withSelfPhotoShare(chat.chatId, picked.path, () => hub.sendImage(chat.chatId, picked.path, undefined, undefined, { strict: true }))
        return sent ? { ok: true, message: '你选择分享的旧照片已发出，接下来是否说话及措辞由你决定' } : { ok: false, message: '这张照片没有发出去' }
      },
    }) : []))
    gen.recallArtwork = (chat, query, options) => artwork.search(chat, query, options)
    return gen
  },
}
