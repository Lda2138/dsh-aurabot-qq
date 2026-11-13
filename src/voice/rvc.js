// 语音条变声：用「翻唱」模块里导入的 RVC 音色模型，把 TTS 念出来的声音换成她的音色。
// 这样「说话」和「唱歌」是同一个声音；翻唱环境没装好 / 没导入音色 / 变声失败时，
// 由 tts.js 的兜底逻辑保留原声（不会让语音条发不出去）。

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig 插件配置
 * @param {() => object | null} deps.getSong 拿翻唱模块（api.use('song')）
 * @param {(sub: string) => string} deps.dataDir 插件数据目录
 * @param {object} [deps.log]
 * @returns {(file: string) => Promise<string>} TTS 后处理：输入音频文件，返回（可能变声后的）文件
 */
export function createSongVoice({ getConfig, getSong, dataDir, log } = {}) {
  return async function convertSpeech(file) {
    const c = (getConfig().voice) || {}
    if (!c.songVoice) return file // 没选音色：用 TTS 原声
    const song = getSong && getSong()
    if (!song || typeof song.convertSpeech !== 'function') {
      log?.debug?.('翻唱模块没在跑，语音条不变声')
      return file
    }
    try {
      const out = await song.convertSpeech(file, {
        voice: String(c.songVoice),
        pitch: Number(c.songPitch) || 0,
        outDir: dataDir('voice-rvc'),
      })
      return out || file
    } catch (error) {
      // 失败由调用方统一兜底（tts.js 会保留原声并记日志），这里补一句更容易懂的提示
      const why = String(error && error.message ? error.message : error)
      log?.warn?.('语音条变声失败，用 TTS 原声：', why)
      throw error
    }
  }
}
