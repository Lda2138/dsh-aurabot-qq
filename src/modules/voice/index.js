// 内置模块：语音。把她的话念出来发语音条（edge-tts / Windows 语音 / CosyVoice / GPT-SoVITS / 本地接口），
// 面板里的试听、语音识别自检也在这里。
// 导出 speak(text) → { file, engine }：聊天中枢发语音时找它。替换这个模块就能换成任何你想要的念法。

import { existsSync, readFileSync } from 'node:fs'
import { textToSpeech, edgeInstalled, installEdge, voiceConverters } from '../../voice/tts.js'
import { breezeVoices, breezeClone, BREEZE_ZH_TAGS } from '../../voice/breeze.js'
import { minimaxClone, minimaxSpeech, cloneVoiceId, MINIMAX_TAGS } from '../../voice/minimax.js'
import { doubaoClone, doubaoCloneStatus, doubaoSpeech } from '../../voice/doubao.js'
import { createSongVoice } from '../../voice/rvc.js'
import { toMono16k, buildWav } from '../../voice/wav.js'
import { prependVoiceSilence, paceVoice } from '../../voice/delivery.js'
import { fileOf } from '../../local/local.js'
import { assertVoiceTarget, voiceTargetAllowed, VOICE_SCOPE_MESSAGE } from '../../voice/access.js'

export default {
  id: 'voice',
  name: '语音',
  version: '1.0.0',
  description: '发语音条：把她的话念出来（关掉后想发语音时改发文字）',
  tab: 'voice',
  files: ['voice/tts.js', 'voice/rvc.js', 'voice/breeze.js', 'voice/minimax.js', 'voice/doubao.js', 'voice/delivery.js'],
  setup(api) {
    const { hub, onebot, local, http } = api.core
    api.context?.(({ chat }) => chat?.chatId && !voiceTargetAllowed(api.config(), chat.chatId) ? `【当前语音权限】${VOICE_SCOPE_MESSAGE}；收到语音仍可理解，回复使用文字。` : '')

    /** opts.tone：她给这条语音定的语气（只有 Breeze 用得上） */
    async function speak(text, opts = {}) {
      const cfg = api.config()
      if (opts.chatId) assertVoiceTarget(cfg, opts.chatId)
      const tone = String(opts.tone || '').slice(0, 80)
      const preferences = api.use('memory')?.interactionPreferences?.(opts.chatId) || []
      const mood = api.use('mood')?.label?.() || ''
      const speechContext = [preferences.length ? '家人确认的表达偏好：' + preferences.map((m) => m.text).join('；') : '', mood ? `长期心情背景：${mood}；具体念法仍按这句话的情境` : ''].filter(Boolean).join('。')
      let voice
      // 本地接口接管语音合成；出错退回内置
      if (local.active('tts')) {
        try {
          const file = fileOf(await local.call('tts', { text, tone, instructions: speechContext }))
          if (file && existsSync(file)) voice = { file, engine: 'local' }
        } catch (error) {}
      }
      voice ||= await textToSpeech(text, { ...cfg.voice, tone, speechContext }, api.log)
      // 合成出来偏慢的（长句尤其明显）不变调加速到正常聊天语速
      const paced = await paceVoice(voice.file, text, { tone, target: cfg.voice.minCharsPerSec ?? 4.4, max: cfg.voice.maxSpeedup ?? 1.1, ffmpegPath: cfg.bili?.ffmpegPath, log: api.log })
      voice.file = paced.file
      voice.file = await prependVoiceSilence(voice.file, cfg.voice.leadingSilenceMs ?? 500, { ffmpegPath: cfg.bili?.ffmpegPath })
      api.log.debug?.(`语音：${voice.engine}，语气 ${tone || '按正文与情境判断'}，${paced.seconds ? `原长 ${paced.seconds.toFixed(1)}s，${paced.factor === 1 ? '语速没动' : `加速 ${paced.factor} 倍`}，` : ''}前导静音 ${cfg.voice.leadingSilenceMs ?? 500}ms`)
      return voice
    }

    // 语音条变声：如果面板里选了「翻唱里导入的音色」，TTS 后再用 RVC 换成她的声音。
    // 挂在 tts.js 的 voiceConverters 上（卸载时摘掉）；变声失败会保留 TTS 原声。
    const songVoice = createSongVoice({ getConfig: api.config, getSong: () => api.use('song'), dataDir: api.dataDir, log: api.log })
    voiceConverters.push(songVoice)
    api.onDispose?.(() => {
      const i = voiceConverters.indexOf(songVoice)
      if (i >= 0) voiceConverters.splice(i, 1)
    })

    // 面板「语音」页用：翻唱模块现成的音色列表 + 是否可用（只读，不触发任何转换）
    api.route('/voice/song-voices', async () => {
      const song = api.use('song')
      if (!song || typeof song.status !== 'function') return { ok: true, available: false, voices: [], message: '翻唱模块没在跑' }
      try {
        const st = song.status()
        return { ok: true, available: Boolean(st.ready), ready: Boolean(st.ready), voices: st.voices || [], selected: api.config().voice.songVoice || '', message: st.message || '' }
      } catch (error) {
        return { ok: false, available: false, voices: [], message: String(error.message || error) }
      }
    })

    api.route('/voice/outbox', async () => ({ ok: true, jobs: hub.voiceOutboxStatus(), delivery: hub.deliveryStatus() }))
    api.route('/voice/outbox/cancel', async (req) => {
      if (req.method !== 'POST' || !/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] || '')) return { ok: false, message: '请通过本机面板取消语音任务' }
      const { id } = await http.body(req)
      const job = hub.cancelVoice(String(id || ''))
      return { ok: Boolean(job), status: job?.status, message: job ? '已处理语音任务' : '没有找到这条语音' }
    })

    api.route('/voice/test', async (req) => {
      const b = await http.body(req)
      const { file, engine } = await speak(String(b.text || '你好呀，我是大肥鱼'), { tone: String(b.tone || ''), chatId: String(b.chatId || `private:${api.config().ownerQQ}`) })
      const buf = readFileSync(file)
      return { ok: true, engine, mime: file.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg', data: buf.toString('base64') }
    })
    api.route('/voice/install', async () => installEdge(api.log))

    // ---- Breeze 云端语音：列音色、用一段录音克隆音色（克隆好了自动选上） ----
    const breezeCfg = () => api.config().voice.breeze || {}
    api.route('/voice/breeze/voices', async (req) => {
      const q = http.query(req)
      try {
        return { ok: true, list: await breezeVoices(breezeCfg().apiKey, { mine: q.mine !== '0', search: String(q.q || '').slice(0, 40) }) }
      } catch (error) {
        return { ok: false, message: error.message, list: [] }
      }
    })
    api.route('/voice/breeze/clone', async (req) => {
      const q = http.query(req)
      try {
        const buf = await http.raw(req, 6 * 1024 * 1024)
        const { voiceId } = await breezeClone(breezeCfg().apiKey, { filename: String(q.name || 'voice.wav'), buf, name: String(q.voiceName || '大肥鱼') })
        api.setConfig((cur) => ({ ...cur, voice: { ...cur.voice, breeze: { ...cur.voice.breeze, voiceId } } }))
        api.log.info(`Breeze 克隆好了音色 ${voiceId}，已选上`)
        return { ok: true, voiceId, message: `克隆好了，已经选上这个音色（${voiceId}）` }
      } catch (error) {
        return { ok: false, message: '克隆失败：' + error.message }
      }
    })
    // ---- MiniMax 云端语音：用一段录音克隆音色（克隆好了自动选上，并马上合成一句，免得 7 天没用被删） ----
    api.route('/voice/minimax/clone', async (req) => {
      const q = http.query(req)
      const c = api.config().voice.minimax || {}
      try {
        const buf = await http.raw(req, 20 * 1024 * 1024)
        const { voiceId } = await minimaxClone(c, { filename: String(q.name || 'voice.wav'), buf, voiceId: cloneVoiceId('dafeiyu') })
        api.setConfig((cur) => ({ ...cur, voice: { ...cur.voice, minimax: { ...cur.voice.minimax, voiceId } } }))
        api.log.info(`MiniMax 克隆好了音色 ${voiceId}，已选上`)
        let data = ''
        try {
          const { buf: pcm, sampleRate } = await minimaxSpeech('你好呀，我是大肥鱼，以后就用这个声音跟你说话啦。', { ...c, voiceId }, { tone: '开心' })
          data = (pcm.toString('ascii', 0, 4) === 'RIFF' ? pcm : buildWav(new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2)), sampleRate)).toString('base64')
        } catch (error) { api.log.warn('MiniMax 克隆后试合成没成功：', error.message) }
        return { ok: true, voiceId, mime: 'audio/wav', data, message: `克隆好了，已经选上这个音色（${voiceId}）。第一次用它合成时 MiniMax 会扣一次音色费` }
      } catch (error) {
        return { ok: false, message: '克隆失败：' + error.message }
      }
    })

    // ---- QQ 里的语音测试：主人发 /语音测试，用当前引擎连发几条固定的测试语音，直接在 QQ 里听效果 ----
    // 也可以测一句自己的：/语音测试 委屈|我都等你半天了（竖线前是语气，可省略）
    const TEST_LINES = [
      // 文案按她平时随口发语音的样子写：口语、有语气词，不工整
      { label: '撒娇', text: '哎呀知道啦知道啦 你怎么比妈妈还能念叨', tone: '笑着撒娇' },
      { label: '无奈', text: '行吧行吧 你说得都对 我认输还不行嘛', tone: '无奈又好笑' },
      { label: '兴奋', text: '我跟你说 今天放学门口有只超胖的橘猫 怎么赶都不走 笑死我了', tone: '兴奋' },
      { label: '生气又心疼', text: '都几点了还不睡 明天又喊头疼 我可不管你了啊', tone: '有点生气又心疼' },
      { label: '委屈', text: '我等你回我等了好久 结果你就回了个嗯', tone: '委屈' },
    ]
    let testing = false
    api.command?.({
      name: 'voicetest',
      aliases: ['语音测试', '测语音', '测试语音'],
      desc: '用现在的语音设置连发几条测试语音（/语音测试 语气|一句话 只测这一句）',
      run: (arg, msg) => {
        const cfg = api.config()
        if (!voiceTargetAllowed(cfg, msg.chatId)) return VOICE_SCOPE_MESSAGE
        if (cfg.voice?.enabled === false) return '语音现在是关着的，先在面板「表达 → 语音」打开'
        if (testing) return '上一轮语音测试还没发完，等一下'
        const custom = String(arg || '').trim()
        const lines = custom
          ? [(([tone, ...rest]) => rest.length ? { label: '自定义', text: rest.join('|').trim(), tone: tone.trim() } : { label: '自定义', text: tone.trim(), tone: '' })(custom.split('|'))]
          : TEST_LINES
        const engine = cfg.voice.engine
        const voiceName = { doubao: cfg.voice.doubao?.speaker, minimax: cfg.voice.minimax?.voiceId, breeze: cfg.voice.breeze?.voiceId }[engine] || ''
        testing = true
        // 测试发的语音和说明都不记进聊天流水：免得她以为测试句是自己说过的话
        const quiet = (fn) => (hub.withoutRecord ? hub.withoutRecord(fn) : fn())
        setTimeout(() => quiet(async () => {
          let voiced = 0
          try {
            for (const [i, line] of lines.entries()) {
              const t0 = Date.now()
              const ok = await hub.sendVoice(msg.chatId, line.text, '', '', line.tone)
              if (ok) voiced++
              api.log.info(`语音测试 ${i + 1}/${lines.length}：${ok ? '发了语音' : '改发了文字'}，${((Date.now() - t0) / 1000).toFixed(1)}s，${engine}`)
            }
            const tones = lines.map((l) => l.tone ? l.label === '自定义' ? l.tone : l.label : '没指定语气').join('、')
            const summary = lines.length > 1 ? `这几条的语气依次是：${tones}${voiced < lines.length ? `（有 ${lines.length - voiced} 条没合成出来，改发了文字）` : ''}` : voiced ? '' : '这条没合成出来，改发了文字'
            if (summary) await hub.sendText(msg.chatId, summary)
          } catch (error) {
            api.log.warn('语音测试出错：', error.message)
          } finally { testing = false }
        }), 1000)
        api.log.info(`语音测试：引擎 ${engine}${voiceName ? `，音色 ${voiceName}` : ''}，共 ${lines.length} 条`)
        return { text: lines.length > 1 ? '好，发几条语音给你听听' : '好', record: false }
      },
    })

    // ---- 豆包语音：用一段录音复刻音色。等训练好（最多约 3 分钟）就选上，并合成一句试听 ----
    api.route('/voice/doubao/clone', async (req) => {
      const q = http.query(req)
      const c = api.config().voice.doubao || {}
      try {
        const buf = await http.raw(req, 10 * 1024 * 1024)
        const format = (String(q.name || 'voice.wav').match(/\.([a-z0-9]+)$/i)?.[1] || 'wav').toLowerCase()
        const made = await doubaoClone(c, { buf, format, speakerId: String(q.speakerId || '').trim() })
        let ready = made.status === 2 || made.status === 4
        for (let i = 0; i < 36 && !ready; i++) {
          if (made.status === 3) break
          await new Promise((resolve) => setTimeout(resolve, 5000))
          const st = await doubaoCloneStatus(c, made.speaker, { custom: made.custom })
          made.status = st.status
          ready = st.ready
        }
        if (made.status === 3) throw new Error('豆包说训练失败了：换一段更清楚、只有一个人说话、没有背景音乐的录音再试')
        if (!ready) return { ok: false, message: `已提交复刻（${made.speaker}），还在训练中，过几分钟把这个 ID 填进「音色 ID」再试听` }
        api.setConfig((cur) => ({ ...cur, voice: { ...cur.voice, doubao: { ...cur.voice.doubao, speaker: made.speaker, clonedSpeaker: made.speaker } } }))
        api.log.info(`豆包复刻好了音色 ${made.speaker}，已选上`)
        let data = ''
        try {
          const { buf: pcm, sampleRate } = await doubaoSpeech('你好呀，我是大肥鱼，以后就用这个声音跟你说话啦。', { ...c, speaker: made.speaker, clonedSpeaker: made.speaker })
          data = buildWav(new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2)), sampleRate).toString('base64')
        } catch (error) { api.log.warn('豆包复刻后试合成没成功：', error.message) }
        return { ok: true, speaker: made.speaker, mime: 'audio/wav', data, message: `复刻好了，已经选上这个音色（${made.speaker}）` }
      } catch (error) {
        return { ok: false, message: '复刻失败：' + error.message }
      }
    })

    // 用 Breeze 时告诉她能写音效标签（别的引擎会把标签去掉，不教她）
    api.rule((kind, cfg) => (cfg.voice?.enabled !== false && cfg.voice?.engine === 'breeze'
      ? `每条语音都根据正在聊的事、你和对方的关系、家人明确确认的偏好，自主选择这一句的语气，写成 <voice 语气="嘴硬但在撒娇">…</voice>（属性名用中文「语气」）。开心、兴奋、嫌弃、委屈、困倦、生气都可以听得出来，别一律平静；长期心情只是背景，不代替本句情绪。称呼爸爸时通常在正文里连着写「爸爸」，不拆成「爸 爸」、不只叫一个「爸」；只有真的很生气才可以单叫「爸」，平时不用每句都带称呼。音效标签放在声音发生的位置：${BREEZE_ZH_TAGS.slice(0, 16).map((t) => `[${t}]`).join(' ')} 等，按语境用。你的语音只能说话、不会唱歌：想唱就用 [哼歌] 哼一两句（12 个字以内）；要唱一整段，就直接打字发歌词或用翻唱，超过 12 个字的「唱」会被改成文字发。语音开头的半秒静音由程序添加，不用特意写 [停顿]。`
      : ''))

    // 豆包：语气照样写（程序换成一句语音指令），不支持音效标签
    api.rule((kind, cfg) => (cfg.voice?.enabled !== false && cfg.voice?.engine === 'doubao'
      ? '每条语音都根据正在聊的事和你们的关系，自主选择这一句的语气，写成 <voice 语气="笑着撒娇">…</voice>（属性名用中文「语气」，几个字说清情绪就好，比如开心、委屈、有点生气、懒洋洋）。称呼爸爸时在正文里连着写「爸爸」。语音里不要写 [笑] [叹气] 这类方括号音效，会被去掉；想表现笑或叹气就用「哈哈」「唉」这样的字。你的语音只能说话、不会唱歌：想唱就只哼一两句（12 个字以内）；要唱一整段，就直接打字发歌词或用翻唱，超过 12 个字的「唱」会被改成文字发。语音开头的半秒静音由程序添加。'
      : ''))
    // MiniMax：语气照样写（程序换成情绪档位），音效标签只给 speech-2.8 认得的那几个
    api.rule((kind, cfg) => {
      if (cfg.voice?.enabled === false || cfg.voice?.engine !== 'minimax') return ''
      const tags = /^speech-2\.8-/.test(cfg.voice?.minimax?.model || 'speech-2.8-hd') ? Object.keys(MINIMAX_TAGS).filter((t) => !['咯咯笑', '抽泣', '冷笑', '啧嘴'].includes(t)).map((t) => `[${t}]`).join(' ') : '[停顿]'
      return `每条语音都根据正在聊的事和你们的关系，自主选择这一句的语气，写成 <voice 语气="笑着撒娇">…</voice>（属性名用中文「语气」，用开心、难过、生气、惊讶、平静这类词说清情绪）。称呼爸爸时在正文里连着写「爸爸」。需要时可以在声音发生的位置加音效：${tags}，别的方括号会被去掉。你的语音只能说话、不会唱歌：想唱就用 [哼歌] 哼一两句（12 个字以内）；要唱一整段，就直接打字发歌词或用翻唱，超过 12 个字的「唱」会被改成文字发。语音开头的半秒静音由程序添加。`
    })

    // DSH 自带语音识别：看状态 / 下载模型
    const stt = () => api.dsh.get('speechToText')
    api.route('/voice/asr-status', async () => {
      const s0 = stt()
      if (!s0 || typeof s0.snapshot !== 'function') return { ok: false, enabled: false, message: 'DSH 里没有开启「语音输入」插件' }
      const s = s0.snapshot()
      const p = s.providers.find((x) => x.id === s.selection.providerId) || s.providers[0]
      return { ok: true, enabled: true, provider: p?.id, phase: p?.preparation?.phase || 'ready', detail: p?.preparation }
    })
    api.route('/voice/asr-prepare', async () => {
      const s0 = stt()
      if (!s0 || typeof s0.snapshot !== 'function') return { ok: false, message: 'DSH 里没有开启「语音输入」插件' }
      s0.prepare(s0.snapshot().selection.providerId)
      return { ok: true, message: '开始下载识别模型（约 200MB，下好后常驻本机）' }
    })
    // 自检「听语音」（真 QQ）：拿和某人私聊里最近一条语音，走一遍 get_record → 16k → DSH 识别
    api.route('/voice/asr-last', async (req) => {
      const b = await http.body(req)
      const uid = Number(b.userId || api.config().ownerQQ)
      const h = await onebot.call('get_friend_msg_history', { user_id: uid, count: 30 })
      const recs = (h?.messages || []).filter((m) => String(m.user_id) === String(uid)).flatMap((m) => (m.message || []).filter((s) => s.type === 'record').map((s) => ({ seg: s, time: m.time })))
      const last = recs.at(-1)
      if (!last) return { ok: false, message: '最近的聊天里没有对方发的语音' }
      const t = Date.now()
      const text = await hub.localTranscribe(last.seg)
      return { ok: Boolean(text), heard: text, at: new Date(last.time * 1000).toLocaleString(), ms: Date.now() - t }
    })
    // 自检「听语音」：Windows 语音念一句 → 转 16k 单声道 → DSH 自带识别 → 看能不能认回来
    api.route('/voice/asr-test', async (req) => {
      const b = await http.body(req)
      const s0 = stt()
      if (!s0 || typeof s0.resolve !== 'function') return { ok: false, message: 'DSH 里没有开启语音识别（设置 → 插件 → 语音输入）' }
      const text = String(b.text || '今天想喝奶茶')
      const { file } = await textToSpeech(text, { engine: 'windows' })
      const t = Date.now()
      const spec = s0.resolve({ audio: new Uint8Array(toMono16k(readFileSync(file))) })
      const r = await s0.transcribe(spec, AbortSignal.timeout(120000))
      const heard = typeof r === 'string' ? r : r?.text || r?.transcript || JSON.stringify(r)
      return { ok: Boolean(heard), said: text, heard, ms: Date.now() - t }
    })

    return { speak, edgeInstalled }
  },
}
