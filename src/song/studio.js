// 翻唱：点歌 → 下载（网易云）→ 分离人声和伴奏 → RVC 换成她的声音 → 混音 → 截成语音条发回去。
// 推理引擎用 Applio（MIT，固定版本），人声分离用 audio-separator，都装在一个独立的 Python 环境里，不碰系统环境。

import { spawn } from 'node:child_process'
import { voiceTargetAllowed, VOICE_SCOPE_MESSAGE } from '../voice/access.js'
import { existsSync, mkdirSync, readdirSync, statSync, statfsSync, writeFileSync, readFileSync, rmSync, copyFileSync, renameSync, openSync, readSync, closeSync } from 'node:fs'
import { join, basename, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { dataDir, readJson, writeJson } from '../core/store.js'
import { searchSongs, songUrl, songLyricTimes, account } from './netease.js'
import { readZip } from './zip.js'

export const APPLIO_REPO = 'https://github.com/IAHispano/Applio.git'
export const APPLIO_COMMIT = 'c817f1f83f689ef72e0dfeb1c17ae990b9248506'
const TORCH_INDEX = 'https://download.pytorch.org/whl/cu128'
// 国内镜像：PyPI 和 PyTorch 都用阿里云（PyTorch 那边是文件列表，用 --find-links；Applio 固定了 torch 版本，挑得到 cu128 的），Python 本体用 npmmirror
const CN_PYPI = 'https://mirrors.aliyun.com/pypi/simple'
const CN_TORCH = 'https://mirrors.aliyun.com/pytorch-wheels/cu128/'
const CN_PYTHON = 'https://registry.npmmirror.com/-/binary/python-build-standalone'

/** 自动模式下判断要不要用国内镜像：官方源 4 秒内连不上或者很慢就用。 */
export async function shouldUseCnMirror(mode, fetchImpl = fetch) {
  if (mode === 'cn' || mode === 'tuna') return true
  if (mode === 'off') return false
  const probe = async (url) => {
    const t = Date.now()
    try {
      const r = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(4000) })
      return r.status < 500 ? Date.now() - t : Infinity
    } catch (error) {
      return Infinity
    }
  }
  const times = await Promise.all([probe('https://pypi.org/simple/pip/'), probe(TORCH_INDEX + '/torch/'), probe('https://github.com/')])
  return times.some((t) => t > 2500)
}
const LEGACY_ROOT = 'C:\\Aurabot\\rvc'

// RVC 推理要的预训练文件（Applio 放在 HuggingFace 上）：[远端相对路径, 本地相对 Applio 的路径]
const PREREQS = [
  ['predictors/rmvpe.pt', 'rvc/models/predictors/rmvpe.pt'],
  ['embedders/contentvec/config.json', 'rvc/models/embedders/contentvec/config.json'],
  ['embedders/contentvec/pytorch_model.bin', 'rvc/models/embedders/contentvec/pytorch_model.bin'],
]
// 国内直连 HuggingFace 常常很慢：先试镜像，太慢或卡住再换官方
const HF_HOSTS = ['https://hf-mirror.com', 'https://huggingface.co']

const FETCH_SCRIPT = fileURLToPath(new URL('./fetch_file.py', import.meta.url))

/**
 * 下载一个预训练文件：已经有了就跳过。用翻唱环境里的 Python 下（会走系统代理），
 * 断了从断点接着下，卡住 30 秒就换下一个源，几轮都不行才算失败。
 */
async function downloadWithMirror(python, rel, dest, note, log, onProgress) {
  return fetchFile(python, dest, HF_HOSTS.map((host) => `${host}/IAHispano/Applio/resolve/main/Resources/${rel}`), note, log, onProgress, rel)
}

// uv 的下载源：PyPI 上的 uv 安装包（固定版本，里面带 uv.exe）走国内镜像，最后才试 GitHub。
const UV_WHEEL = 'packages/32/ea/771744a784b16aa21d195cb5d5d5a2878d72fa00fc26f11ea3f9646994fe/uv-0.13.5-py3-none-win_amd64.whl'
export const UV_SOURCES = [
  { url: `https://mirrors.aliyun.com/pypi/${UV_WHEEL}`, sha256: '1fb29fc46ba12033e2ef95a95ac79d649e71bbb1358419bbbcbd19d86026ef2f' },
  { url: `https://files.pythonhosted.org/${UV_WHEEL}`, sha256: '1fb29fc46ba12033e2ef95a95ac79d649e71bbb1358419bbbcbd19d86026ef2f' },
  { url: 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip' },
]

/** 在目录里（含子目录）找一个文件名。 */
function findFile(dir, name) {
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let names
    try { names = readdirSync(d, { withFileTypes: true }) } catch (error) { continue }
    for (const e of names) {
      const full = join(d, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.name.toLowerCase() === name) return full
    }
  }
  return ''
}

/** 默认分离模型的文件都在不在。 */
export function separatorReady(dir, model) {
  const files = SEPARATOR_FILES[model]
  if (!files) return existsSync(join(dir, model))
  return files.every(([name]) => existsSync(join(dir, name)) && statSync(join(dir, name)).size > 0)
}

/** 下载一个文件：已经有了就跳过；地址按顺序轮流试，断了接着下，走系统代理。 */
async function fetchFile(python, dest, urls, note, log, onProgress, label = basename(dest), sha256 = '') {
  const rel = label
  if (existsSync(dest) && statSync(dest).size > 0) return
  // 上次没下完的（.download）会接着下
  const part = dest + '.download'
  note?.(existsSync(part) ? `接着下 ${rel}（上次下到 ${Math.round(statSync(part).size / 1048576)} MB）` : `下载 ${rel}`)
  let lastPct = -1
  await run(python, [FETCH_SCRIPT, ...(sha256 ? ['--sha256', sha256] : []), dest, ...urls], {
    log,
    env: { PYTHONIOENCODING: 'utf-8' },
    timeoutMs: 2 * 3600_000,
    onLine: (line) => {
      const m = line.match(/^progress (\d+) (\d+)/)
      if (m && Number(m[2])) {
        onProgress?.(Number(m[1]), Number(m[2]))
        const pct = Math.floor((Number(m[1]) / Number(m[2])) * 10) * 10
        if (pct !== lastPct) { lastPct = pct; note?.(`  ${rel}：${pct}%`) }
      } else if (/^retry /.test(line)) note?.('  ' + line.replace(/^retry /, '断了，换个源接着下：'))
    },
  })
}

/** 模型文件能不能读：刚下完/导入的大文件常被杀毒软件锁住几秒，等一等再试，还不行就报出是哪个文件。 */
export async function ensureReadable(files, tries = 4, waitMs = 3000) {
  for (const f of files) {
    if (!existsSync(f)) continue
    for (let i = 1; ; i++) {
      try {
        const fd = openSync(f, 'r')
        try { readSync(fd, Buffer.alloc(16), 0, 16, 0) } finally { closeSync(fd) }
        break
      } catch (error) {
        if (i >= tries || !/EACCES|EPERM|EBUSY/.test(error.code || '')) throw new Error(`Permission denied: '${f}'（${error.code || error.message}）`)
        await new Promise((r) => setTimeout(r, waitMs))
      }
    }
  }
}

/** 一个目录（含子目录）有多大，字节。目录不存在算 0。 */
export function dirSize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let names
    try { names = readdirSync(d, { withFileTypes: true }) } catch (error) { continue }
    for (const e of names) {
      const full = join(d, e.name)
      if (e.isDirectory()) stack.push(full)
      else try { total += statSync(full).size } catch (error) {}
    }
  }
  return total
}

/** 翻唱环境的根目录：老安装沿用 C:\Aurabot\rvc，新安装放用户目录下。 */
export function defaultRoot() {
  return existsSync(LEGACY_ROOT) ? LEGACY_ROOT : join(homedir(), 'Aurabot', 'rvc')
}

/**
 * 检查安装位置：要绝对路径；中文、空格可能让一些工具出问题，提醒一下；顺便看看那个盘还剩多少空间（装完约 8 GB）。
 * @returns {{ok: boolean, path: string, message: string, warn: string, freeGB: number|null}}
 */
/** 把安装时的报错翻译成人话，并告诉用户接下来怎么办。 */
export function explainInstallError(msg) {
  const m = String(msg || '')
  if (/ENOENT/.test(m)) return `找不到需要的程序（${(m.match(/spawn (\S+)/) || [])[1] || '?'}）。点「重新检查 / 修复安装」再试一次；还不行就把报错发给作者`
  if (/ENOSPC|No space|磁盘空间|not enough space/i.test(m)) return '磁盘空间不够了。换一个空间大的盘（上面「装到哪里」），保存后再装'
  if (/timed? ?out|超时|30 秒没进度|operation timed/i.test(m)) return '网络太慢、超时了。打开「用国内镜像下载」或者开着代理，再点安装（已下好的不会重下）'
  if (/connection|connect|reset|TLS|SSL|dns|resolve|Failed to fetch|Failed to download|error sending request|无法连接|网络/i.test(m)) return '网络连接断了。打开「用国内镜像下载」或者开着代理，再点安装（已下好的不会重下）'
  if (/CUDA|nvidia|GPU/i.test(m)) return '和显卡驱动有关，可能需要更新 NVIDIA 驱动。' + m.slice(0, 160)
  return m.slice(0, 300)
}

/** 安装的几步（面板按这个画步骤条）。 */
export const INSTALL_STEPS = ['创建 Python 环境', '下载 Applio（RVC 推理引擎）', '安装 PyTorch、RVC 和人声分离（最大的一步）', '准备 ffmpeg', '下载 RVC 需要的预训练文件（音高、音色特征）', '下载人声分离模型']

// 默认人声分离模型要的文件：[文件名, 下载地址（按顺序试）, sha256]。提前下好，免得第一次点歌时卡着不动。
// 模型 640 MB，GitHub 在国内经常下不动：先走 HuggingFace 镜像（有人转存了同一个文件，校验值一样），再试官方。
// 下完核对 sha256，哪个源给的文件不对就换下一个；配置文件很小，随插件带着（src/song/separator/）。
const GH_UVR = 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models'
const GH_AS = 'https://github.com/nomadkaraoke/python-audio-separator/releases/download/model-configs'
const HF_SEP = ['Politrees/UVR_resources/resolve/main/models/Roformer/BandSplit', 'datasets/SayanoAI/RVC-Studio/resolve/main/UVR']
const BS_ROFORMER = 'model_bs_roformer_ep_317_sdr_12.9755'
export const SEPARATOR_FILES = {
  [`${BS_ROFORMER}.ckpt`]: [
    [`${BS_ROFORMER}.ckpt`, [
      ...HF_SEP.map((p) => `https://hf-mirror.com/${p}/${BS_ROFORMER}.ckpt`),
      `${GH_UVR}/${BS_ROFORMER}.ckpt`,
      `https://huggingface.co/${HF_SEP[0]}/${BS_ROFORMER}.ckpt`,
      `${GH_AS}/${BS_ROFORMER}.ckpt`,
    ], '5b84f37e8d444c8cb30c79d77f613a41c05868ff9c9ac6c7049c00aefae115aa'],
    [`${BS_ROFORMER}.yaml`, [`${GH_AS}/${BS_ROFORMER}.yaml`], '2bfdd16c656bd9519aba757cc4f8834b7ede675eb1e00ec4772d74ae1c41af7f'],
  ],
}
const BUNDLED_SEP = fileURLToPath(new URL('./separator/', import.meta.url))

/** 手动下载用的地址（面板里给用户复制，用浏览器或下载工具下好再拖进来）。 */
export function separatorLinks(model) {
  return (SEPARATOR_FILES[model] || []).slice(0, 1).flatMap(([, urls]) => urls.slice(0, 3))
}

/**
 * 导入手动下好的分离模型：核对 sha256，对得上才放进去。
 * @returns {{ok:boolean, message:string}}
 */
export function importSeparator(dir, filename, buf) {
  const sha = createHash('sha256').update(buf).digest('hex')
  for (const files of Object.values(SEPARATOR_FILES)) {
    const hit = files.find(([, , want]) => want === sha)
    if (hit) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, hit[0]), buf)
      rmSync(join(dir, hit[0] + '.download'), { force: true })
      return { ok: true, message: `人声分离模型导入好了（${hit[0]}）` }
    }
  }
  return { ok: false, message: `「${filename}」不是插件要的人声分离模型（校验对不上），要下 ${BS_ROFORMER}.ckpt` }
}
// 分离工具每次运行都要的模型清单（缺了会去 raw.githubusercontent.com 拉，国内常常连不上）
const SEPARATOR_LIST = ['download_checks.json', ['https://raw.githubusercontent.com/TRvlvr/application_data/main/filelists/download_checks.json', 'https://cdn.jsdelivr.net/gh/TRvlvr/application_data@main/filelists/download_checks.json']]

/** 电脑上的盘和剩余空间，给面板「装到哪个盘」用：[{drive, root, freeGB, totalGB}] */
export function listDrives() {
  const out = []
  for (const L of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const d = `${L}:\\`
    try {
      if (!existsSync(d)) continue
      const s = statfsSync(d)
      const gb = (n) => Math.round((Number(n) * Number(s.bsize)) / 1024 ** 3 * 10) / 10
      if (!s.blocks) continue
      out.push({ drive: `${L}:`, root: `${L}:\\Aurabot\\rvc`, freeGB: gb(s.bavail), totalGB: gb(s.blocks) })
    } catch (error) {}
  }
  return out
}

export function checkRoot(path) {
  const p = String(path || '').trim()
  if (!p) return { ok: true, path: '', message: '', warn: '', freeGB: null }
  if (!isAbsolute(p) || !/^[A-Za-z]:\\/.test(p.replace(/\//g, '\\'))) return { ok: false, path: p, message: '要写完整路径，比如 D:\\Aurabot\\rvc', warn: '', freeGB: null }
  const warn = /[^\x21-\x7e]/.test(p) ? '路径里有中文或空格，个别工具可能出问题，最好换成全英文、不带空格的路径' : ''
  let freeGB = null
  try {
    // 往上找到第一个存在的目录来量剩余空间
    let probe = p
    while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe)
    const s = statfsSync(probe)
    freeGB = Math.round((Number(s.bavail) * Number(s.bsize)) / 1024 ** 3 * 10) / 10
  } catch (error) {}
  return { ok: true, path: p, message: '', warn: warn || (freeGB !== null && freeGB < 10 ? `这个盘只剩 ${freeGB} GB，装完要 8 GB 左右，安装时还要临时多占几 GB` : ''), freeGB }
}

export function pathsOf(root) {
  return {
    root,
    python: join(root, 'env', 'Scripts', 'python.exe'),
    separatorExe: join(root, 'env', 'Scripts', 'audio-separator.exe'),
    applio: join(root, 'Applio'),
    models: join(root, 'models'),
    separatorModels: join(root, 'separator-models'),
    bin: join(root, 'bin'),
    ffmpeg: join(root, 'bin', 'ffmpeg.exe'),
    rmvpe: join(root, 'Applio', 'rvc', 'models', 'predictors', 'rmvpe.pt'),
    contentvec: join(root, 'Applio', 'rvc', 'models', 'embedders', 'contentvec', 'pytorch_model.bin'),
  }
}

/** models 目录里的音色：[{id, pth, index}]，同名 .index 可选。 */
export function listVoices(modelsDir) {
  let names = []
  try { names = readdirSync(modelsDir) } catch (error) { return [] }
  return names.filter((n) => n.toLowerCase().endsWith('.pth')).sort().map((n) => {
    const id = n.slice(0, -4)
    const idx = names.find((m) => m.toLowerCase().endsWith('.index') && m.toLowerCase().includes(id.toLowerCase()))
    return { id, pth: join(modelsDir, n), index: idx ? join(modelsDir, idx) : '' }
  })
}

/** 像不像 RVC 模型：PyTorch 存的 .pth 要么是 zip 格式（PK 开头），要么是老的 pickle（0x80 开头）。 */
export function looksLikePth(buf) {
  return buf.length > 1024 * 1024 && ((buf[0] === 0x50 && buf[1] === 0x4b) || buf[0] === 0x80)
}

const safeName = (n) => basename(String(n).replace(/\\/g, '/')).replace(/[<>:"|?*\x00-\x1f]/g, '_').trim()

/**
 * 导入音色：.pth / .index，或者装着它们的 zip。存进 models 目录。
 * zip 里只有一个音色时，index 自动改名成「音色名.index」配上。
 * @returns {{ok: boolean, added: string[], indexes: number, message: string}}
 */
export function importModels(modelsDir, filename, buf) {
  const name = safeName(filename)
  const lower = name.toLowerCase()
  let files
  if (lower.endsWith('.zip')) {
    files = readZip(buf, (n) => /\.(pth|index)$/i.test(n) && !n.includes('__MACOSX')).map((f) => ({ name: safeName(f.name), data: f.data }))
  } else if (lower.endsWith('.pth') || lower.endsWith('.index')) {
    files = [{ name, data: buf }]
  } else {
    return { ok: false, added: [], indexes: 0, message: '只支持 .zip、.pth、.index 文件' }
  }
  const pths = files.filter((f) => f.name.toLowerCase().endsWith('.pth'))
  const idxs = files.filter((f) => f.name.toLowerCase().endsWith('.index'))
  if (!pths.length && !idxs.length) return { ok: false, added: [], indexes: 0, message: '里面没找到 .pth 模型' }
  const bad = pths.filter((f) => !looksLikePth(f.data))
  if (bad.length) return { ok: false, added: [], indexes: 0, message: `「${bad[0].name}」看起来不是 RVC 模型` }
  mkdirSync(modelsDir, { recursive: true })
  for (const f of pths) writeFileSync(join(modelsDir, f.name), f.data)
  const solo = pths.length === 1 ? pths[0].name.slice(0, -4) : ''
  for (const f of idxs) writeFileSync(join(modelsDir, solo && idxs.length === 1 ? `${solo}.index` : f.name), f.data)
  const added = pths.map((f) => f.name.slice(0, -4))
  return {
    ok: true,
    added,
    indexes: idxs.length,
    message: added.length ? `导入了 ${added.length} 个音色：${added.join('、')}${idxs.length ? `（带 ${idxs.length} 个 index）` : ''}` : `导入了 ${idxs.length} 个 index`,
  }
}

/** 删掉一个音色（连同配套的 index）。 */
export function deleteVoice(modelsDir, id) {
  const v = listVoices(modelsDir).find((x) => x.id === id)
  if (!v) return { ok: false, message: '没有这个音色' }
  rmSync(v.pth, { force: true })
  if (v.index) rmSync(v.index, { force: true })
  return { ok: true, message: `删掉了「${id}」` }
}

/** 缓存目录只留最新的 keep 个文件。 */
export function pruneCache(dir, keep) {
  let files = []
  try { files = readdirSync(dir).map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs })) } catch (error) { return 0 }
  const old = files.sort((a, b) => b.t - a.t).slice(keep)
  for (const f of old) rmSync(join(dir, f.n), { force: true })
  return old.length
}

/** 截一段：歌比上限长时从「大约副歌」的位置开始（全曲 30% 处），否则从头。 */
/** 分出来的人声轨平均音量低于这个就当没有人声。正常人声在 -15 ~ -30 dB，纯音乐分出来是 -80 以下。 */
export const VOCAL_MIN_DB = -50

/** 混音的 ffmpeg 参数。没有 inst 就是清唱，只留她的人声。 */
export function mixArgs({ vocals, inst, vol, iv, out }) {
  const head = ['-y', '-hide_banner', '-loglevel', 'error', '-i', vocals]
  const tail = ['-ac', '2', '-ar', '44100', '-b:a', '192k', out]
  if (!inst) return [...head, '-af', `volume=${vol},alimiter=limit=0.95`, ...tail]
  return [...head, '-i', inst, '-filter_complex', `[0:a]volume=${vol}[v];[1:a]volume=${iv}[i];[v][i]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95`, ...tail]
}

const INSTRUMENTAL = /纯音乐|伴奏|钢琴|吉他|八音盒|音乐盒|古筝|琵琶|二胡|笛子|葫芦丝|小提琴|大提琴|口琴|萨克斯|instrumental|off ?vocal|karaoke|\binst\b|\bbgm\b|music box|piano/i

/** 搜索结果排序：标题像纯音乐（钢琴版、伴奏……）的放到最后，除非点歌时本来就这么说。其余保持网易云的顺序。 */
export function rankCandidates(list, query = '') {
  const want = INSTRUMENTAL.test(query)
  const bad = (s) => !want && INSTRUMENTAL.test(`${s.name} ${s.alias || ''}`)
  return [...list.filter((s) => !bad(s)), ...list.filter(bad)]
}

export function clipWindow(durationSec, maxSec, start = 'auto', lyricStarts = []) {
  if (!(durationSec > maxSec)) return { start: 0, length: durationSec }
  if (start === 'head') return { start: 0, length: maxSec }
  const s = Math.max(0, Math.min(Math.round(durationSec * 0.3), Math.floor(durationSec - maxSec)))
  const starts = [...new Set(lyricStarts.filter((n) => Number.isFinite(n) && n >= 0 && n < durationSec))].sort((a, b) => a - b)
  if (starts.length >= 2) {
    // 歌词下一行隔得很远时，不把整段间奏算成人声；这是选段估计，不是人声检测。
    const intervals = starts.map((a, i) => [a, Math.min(durationSec, a + 8, starts[i + 1] ?? durationSec)])
    const candidates = [...new Set([s, ...starts.map((n) => Math.max(0, Math.min(n, durationSec - maxSec)))])]
    const coverage = (a) => intervals.reduce((sum, [lo, hi]) => sum + Math.max(0, Math.min(hi, a + maxSec) - Math.max(lo, a)), 0)
    candidates.sort((a, b) => coverage(b) - coverage(a) || Math.abs(a - s) - Math.abs(b - s))
    return { start: candidates[0], length: maxSec }
  }
  return { start: s, length: maxSec }
}

/** 混音或选段变化后不复用旧成品。 */
export function coverCacheKey({ song, voice, pitch, maxVoiceSec, clipStart, vocalVolume, instVolume, acapella }) {
  return createHash('md5').update(JSON.stringify(['v3-lyric-window', song, voice, pitch, maxVoiceSec, clipStart, vocalVolume, instVolume, Boolean(acapella)])).digest('hex').slice(0, 16)
}

/**
 * 翻唱任务账本：queue / 正在做的 / 做过的 / 做成但没发出去的，都落盘。
 * 热重载或重启之后新建的实例能读回来，不再出现「明明做好了，插件却说没在做」。
 * 只存普通数据（canSend 这类函数序列化时自然丢掉），恢复出来的一律算「待补发」，不自动发。
 */
export function createSongLedger({ file, log } = {}) {
  let savedAt = 0
  const read = () => {
    const raw = readJson(file, () => ({}))
    const list = (value) => (Array.isArray(value) ? value : [])
    return {
      queue: list(raw.queue),
      current: raw.current && typeof raw.current === 'object' ? raw.current : null,
      history: list(raw.history),
      pending: list(raw.pending),
    }
  }
  const save = (state, { force = false } = {}) => {
    const now = Date.now()
    if (!force && now - savedAt < 1000) return false // 阶段变化很密，一秒最多写一次
    savedAt = now
    try {
      writeJson(file, { v: 1, savedAt: now, ...state })
      return true
    } catch (error) {
      log?.debug?.(`翻唱任务账本写不进去：${error.message}`)
      return false
    }
  }
  return { file, read, save }
}

/** 做好了直接发语音；有实测就报实测，不再拍脑袋说「两三分钟」。 */
export function estimateNote(history = []) {
  const seconds = history
    .filter((h) => h?.ok && Number(h.seconds) > 0)
    .slice(0, 3)
    .map((h) => Number(h.seconds))
  if (!seconds.length) return '做好了直接发语音条，具体要多久看这台机器忙不忙'
  const avg = Math.round(seconds.reduce((sum, n) => sum + n, 0) / seconds.length)
  return avg < 90 ? '做好了直接发语音条，一般一两分钟' : `做好了直接发语音条（这台机器最近一首用了 ${Math.max(1, Math.round(avg / 60))} 分钟）`
}

function run(cmd, args, { cwd, env, log, onLine, timeoutMs = 30 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, windowsHide: true })
    let tail = ''
    const feed = (buf) => {
      const s = String(buf)
      tail = (tail + s).slice(-4000)
      for (const line of s.split(/\r?\n|\r/)) if (line.trim()) onLine?.(line.trim())
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    const timer = setTimeout(() => { try { child.kill() } catch (error) {} }, timeoutMs)
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(tail)
      else {
        log?.debug(`${basename(cmd)} 失败（code ${code}）：${tail.slice(-800)}`)
        reject(new Error(`${basename(cmd)} 退出码 ${code}：${tail.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 300)}`))
      }
    })
  })
}

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig
 * @param {object} deps.log
 * @param {(chatId: string, file: string, note: string) => Promise<any>} deps.sendVoiceFile  把做好的语音发到聊天
 * @param {(chatId: string, text: string) => Promise<any>} [deps.sendText]
 */
/** 翻唱出错翻译成人话（给点歌的人看）。 */
export function explainSongError(message) {
  const m = String(message || '')
  if (/size mismatch|Error\(s\) in loading state_dict|unexpected key|Missing key|KeyError: '(weight|config|params)'/i.test(m)) return '这个音色模型和内置的 RVC 不兼容（可能是 so-vits-svc 之类训练的，或者不是完整的模型文件）。可以在面板「本地接口」里接你自己的推理'
  if (/CUDA out of memory|OutOfMemoryError|not enough memory/i.test(m)) return '显卡显存不够，关掉别的占显存的程序（游戏、别的 AI）再试'
  if (/No module named|ModuleNotFoundError/i.test(m)) return '翻唱环境不完整，在面板「翻唱」页点「重新检查 / 修复安装」'
  if (/Permission denied|Errno 13|EACCES|EPERM|EBUSY/i.test(m)) {
    const file = (m.match(/'([^']+\.(?:ckpt|pth|onnx|yaml|json))'/i) || [])[1]?.replace(/\\\\/g, '\\')
    return `${file ? `读不了「${file}」` : '有个模型文件读不了'}：多半是杀毒软件（360、火绒、Defender）正在扫描或拦住了它，或者文件是用管理员身份放进去的。把翻唱目录加进杀毒软件的信任区再试；还不行就删掉这个文件，在面板「翻唱」页重新下载`
  }
  return m
}

export function createSongStudio({ getConfig, log, sendVoiceFile, sendText, onSung, local }) {
  const cfg = () => getConfig().song
  const P = () => pathsOf(cfg().root || defaultRoot())
  const work = () => dataDir('songs')
  // 确认过没有人声的歌（网易云 id），下次直接跳过，不用再花几分钟分离一遍
  const noVocalFile = () => join(work(), 'no-vocals.json')
  const noVocals = () => readJson(noVocalFile(), () => [])
  const markNoVocals = (id) => { if (id && !noVocals().includes(String(id))) writeJson(noVocalFile(), [...noVocals(), String(id)].slice(-500)) }
  const queue = []
  let current = null // 正在做的翻唱
  let history = [] // 最近做过的 [{at, title, voice, ok, message, file, seconds}]
  let pending = [] // 做成但没确认发出去的 [{id, title, chatId, file, reason, tries}]
  let install = { running: false, step: '', log: [], ok: null, message: '' }
  const ledger = createSongLedger({ file: dataDir('song-jobs.json'), log })

  const pendingId = () => randomUUID().slice(0, 8)
  const slim = (job) => {
    if (!job || typeof job !== 'object') return job
    const { canSend, ...rest } = job
    return rest
  }
  const persist = (force = false) => ledger.save({
    queue: queue.map(slim),
    current: current ? slim(current) : null,
    history: history.slice(0, 20),
    pending: pending.slice(-10),
  }, { force })

  /** 换阶段：面板能看到做到哪一步，重载后也知道断在哪。写盘一秒最多一次。 */
  function stage(name) {
    if (!current) return
    current.stage = name
    current.stageAt = Date.now()
    persist()
  }

  /** 待补发条目：成品还在才算「有得补」，不在就只留个记录，补发时照原样重做。 */
  function normalizePending(item, reason) {
    const file = typeof item?.file === 'string' && item.file && existsSync(item.file) ? item.file : ''
    return {
      id: item?.id || pendingId(),
      at: Number(item?.at) || Number(item?.startedAt) || Date.now(),
      query: String(item?.query || item?.title || ''),
      title: String(item?.title || item?.query || ''),
      songId: item?.songId === undefined || item?.songId === null ? '' : String(item.songId),
      pitch: Number.isFinite(Number(item?.pitch)) ? Number(item.pitch) : 0,
      voice: String(item?.voice || ''),
      acapella: Boolean(item?.acapella),
      chatId: String(item?.chatId || ''),
      file,
      made: Boolean(file),
      cacheKey: String(item?.cacheKey || ''),
      reason: String(reason || item?.reason || ''),
      tries: Number(item?.tries) || 0,
    }
  }

  function addPending(item, { force = false } = {}) {
    const entry = normalizePending(item, item?.reason)
    if (!entry.chatId) return null
    const same = pending.find((p) => (entry.file && p.file === entry.file && p.chatId === entry.chatId) ||
      (!entry.file && !p.file && p.chatId === entry.chatId && String(p.songId) === String(entry.songId) && p.query === entry.query))
    if (same) {
      Object.assign(same, entry, { id: same.id, at: same.at, tries: Math.max(same.tries, entry.tries) })
      persist(force)
      return same
    }
    pending.push(entry)
    pending = pending.slice(-10)
    persist(force)
    return entry
  }

  // 上次没走完的：正在做的、排队里的，都转为「待补发」；有成品就能直接补发，没成品就重做。
  // 这里不自动发——发送前要重新核对开关、授权和目标，由主人显式说一声。
  {
    const boot = ledger.read()
    history = boot.history.slice(0, 20)
    for (const item of boot.pending) pending.push(normalizePending(item))
    pending = pending.slice(-10)
    const leftovers = []
    if (boot.current) leftovers.push({ ...boot.current, reason: '上次没做完就重载了' })
    for (const job of boot.queue) leftovers.push({ ...job, reason: '上次排在队里没轮到' })
    for (const item of leftovers) addPending(item)
    if (leftovers.length) {
      persist(true) // 立刻落盘：下次再重载也不能丢
      log?.info?.(`翻唱账本：接着上次的 ${leftovers.length} 条（都不会自动发，等主人说补发）`)
    }
  }

  function status() {
    const p = P()
    const voices = listVoices(p.models)
    const parts = {
      python: existsSync(p.python),
      applio: existsSync(join(p.applio, 'core.py')),
      separator: existsSync(p.separatorExe),
      ffmpeg: existsSync(p.ffmpeg),
      weights: existsSync(p.rmvpe) && existsSync(p.contentvec),
      separatorModel: separatorReady(p.separatorModels, cfg().separatorModel),
    }
    // 换声交给本地脚本时，不需要内置的 Applio / 预训练文件 / 音色模型（下载、分离、混音还是插件做）
    const localSong = Boolean(local?.active('song'))
    if (localSong && cfg().voice && !voices.some((v) => v.id === cfg().voice)) voices.unshift({ id: cfg().voice, index: '', local: true })
    const ready = localSong ? ['python', 'separator', 'ffmpeg', 'separatorModel'].every((k) => parts[k]) : Object.values(parts).every(Boolean) && voices.length > 0
    return {
      enabled: cfg().enabled,
      ready,
      root: p.root,
      defaultRoot: defaultRoot(),
      rootCheck: checkRoot(p.root),
      pypiMirror: cfg().pypiMirror || 'auto',
      parts,
      voices: voices.map((v) => ({ id: v.id, hasIndex: Boolean(v.index), ...(v.local ? { local: true } : {}) })),
      separatorLinks: parts.separatorModel ? [] : separatorLinks(cfg().separatorModel),
      voice: cfg().voice,
      install: { ...install, log: install.log.slice(-30) },
      current: current ? { ...current } : null,
      queue: queue.map((q) => ({ query: q.query, chatId: q.chatId })),
      history: history.slice(0, 10).map((h) => ({ at: h.at, title: h.title, voice: h.voice, pitch: h.pitch, ok: h.ok, seconds: h.seconds, messageId: h.messageId, message: h.message })),
      pending: pending.slice(-10).map(({ id, at, title, chatId, made, reason, tries }) => ({ id, at, title, chatId, made, reason, tries })),
      message: !voices.length ? '还没有音色：在下面「音色模型」里导入你有权使用的 RVC 模型（.pth 或 zip）' : ready ? (cfg().enabled ? '可以点歌了' : '准备好了，打开开关就能用') : '还差一些组件，点「一键安装」',
    }
  }

  // ---------- 一键安装（几个 GB，要十几分钟）----------
  async function runInstall() {
    if (install.running) return { ok: false, message: '已经在装了' }
    const p = P()
    install = { running: true, step: '', stepIndex: -1, steps: INSTALL_STEPS, stepHint: '', stepAt: 0, startedAt: Date.now(), progress: null, log: [], ok: null, message: '' }
    const note = (s) => { install.log.push(s); if (install.log.length > 200) install.log.shift() }
    const step = async (name, hint, fn) => {
      Object.assign(install, { step: name, stepIndex: INSTALL_STEPS.indexOf(name), stepHint: hint, stepAt: Date.now(), progress: null })
      note('▶ ' + name)
      log.info('翻唱安装：' + name)
      await fn()
    }
    // 这次安装的下载缓存放在安装目录里：一来能统计下载了多少（给面板看进度），二来装完删掉不占地方
    const cacheDir = join(p.root, 'uv-cache')
    const cn = await shouldUseCnMirror(cfg().pypiMirror)
    if (cn) note(cfg().pypiMirror === 'cn' ? '用国内镜像下载' : '官方源连得慢，自动改用国内镜像下载')
    const uvEnv = {
      UV_CACHE_DIR: cacheDir,
      UV_HTTP_TIMEOUT: '300',
      UV_HTTP_RETRIES: '6',
      UV_PYTHON_INSTALL_DIR: join(p.root, 'python'), // Python 也装在选的位置里，不偷偷占 C 盘
      ...(cn ? { UV_PYTHON_INSTALL_MIRROR: CN_PYTHON } : {}),
    }
    const mirror = cn ? ['--default-index', CN_PYPI] : []
    let uv = 'uv'
    try {
      mkdirSync(p.root, { recursive: true })
      mkdirSync(p.models, { recursive: true })
      await step('创建 Python 环境', '第一次要下载 Python 3.12（约 30 MB）和安装工具，一般 1~3 分钟', async () => {
        uv = await ensureUv(note)
        if (existsSync(p.python)) return note('  已经有了，跳过')
        const stop = watchDownload(join(p.root, 'python'))
        try {
          await run(uv, ['venv', '-q', join(p.root, 'env'), '--python', '3.12'], { log, onLine: note, env: uvEnv, timeoutMs: 30 * 60_000 })
        } finally {
          stop()
        }
      })
      await step('下载 Applio（RVC 推理引擎）', '要下载几十 MB，一般 1~3 分钟', async () => {
        if (existsSync(join(p.applio, 'core.py'))) return note('  已经有了，跳过')
        // 直接下代码压缩包（固定版本），不需要电脑上装 git
        const zip = join(p.root, 'downloads', 'applio.zip')
        // 用环境里的 Python 下（断了能接着下、走系统代理）；万一不行再用 PowerShell 下
        try {
          await fetchFile(p.python, zip, [`https://github.com/IAHispano/Applio/archive/${APPLIO_COMMIT}.zip`, `https://codeload.github.com/IAHispano/Applio/zip/${APPLIO_COMMIT}`], note, log, (done, total) => {
            install.progress = { kind: 'file', name: 'Applio', done, total }
          })
        } catch (error) {
          note('  换个方式再下一次')
          await fetchWithProgress(`https://github.com/IAHispano/Applio/archive/${APPLIO_COMMIT}.zip`, zip)
        }
        const tmp = join(p.root, 'downloads', 'applio-src')
        rmSync(tmp, { recursive: true, force: true })
        await expandZip(zip, tmp)
        const inner = readdirSync(tmp).find((n) => existsSync(join(tmp, n, 'core.py')))
        if (!inner) throw new Error('下载的 Applio 压缩包不完整')
        rmSync(p.applio, { recursive: true, force: true })
        renameSync(join(tmp, inner), p.applio)
        rmSync(join(p.root, 'downloads'), { recursive: true, force: true })
      })
      await step('安装 PyTorch、RVC 和人声分离（最大的一步）', '要下载约 3~4 GB，看网速一般 10~40 分钟；下面的「已下载」在涨就说明没卡住', async () => {
        const stop = watchDownload(cacheDir)
        try {
          await run(uv, ['pip', 'install', '--python', p.python, '-r', join(p.applio, 'requirements-engine.txt'), 'audio-separator[gpu]', 'imageio-ffmpeg',
            ...mirror, ...(cn ? ['--find-links', CN_TORCH] : ['--extra-index-url', TORCH_INDEX]), '--index-strategy', 'unsafe-best-match'], { log, onLine: note, env: uvEnv, timeoutMs: 120 * 60_000 })
        } finally {
          stop()
        }
      })
      await step('准备 ffmpeg', '几秒钟', async () => setupFfmpeg())
      await step('下载 RVC 需要的预训练文件（音高、音色特征）', '约 560 MB，看网速几分钟', async () => {
        for (const [rel, dest] of PREREQS) {
          await downloadWithMirror(p.python, rel, join(p.applio, dest), note, log, (done, total) => {
            install.progress = { kind: 'file', name: rel.split('/').pop(), done, total }
          })
        }
      })
      await step('下载人声分离模型', '约 640 MB，看网速几分钟；下好以后第一次点歌就不用再等', async () => {
        // 配置文件插件自带，先放进去
        mkdirSync(p.separatorModels, { recursive: true })
        for (const n of readdirSync(BUNDLED_SEP)) if (!existsSync(join(p.separatorModels, n))) copyFileSync(join(BUNDLED_SEP, n), join(p.separatorModels, n))
        const files = [...(SEPARATOR_FILES[cfg().separatorModel] || []), SEPARATOR_LIST]
        for (const [name, urls, sha] of files) {
          await fetchFile(p.python, join(p.separatorModels, name), urls, note, log, (done, total) => {
            install.progress = { kind: 'file', name, done, total }
          }, name, sha || '')
        }
      })
      // 下载缓存用完删掉（几个 GB）；环境里的文件是硬链接 / 复制过去的，删缓存不影响
      try { rmSync(cacheDir, { recursive: true, force: true }) } catch (error) {}
      install = { ...install, running: false, ok: true, step: '', progress: null, message: `装好了，用时 ${Math.round((Date.now() - install.startedAt) / 60000)} 分钟` }
      log.info('翻唱环境装好了')
    } catch (error) {
      install = { ...install, running: false, ok: false, progress: null, message: `「${install.step}」这步失败了：${explainInstallError(error.message)}`, error: String(error.message).slice(0, 2000) }
      log.warn('翻唱安装失败：', install.message)
    }
    return { ok: install.ok, message: install.message }
  }

  /**
   * 用 PowerShell 下载一个文件（会走系统代理，不依赖电脑上装了别的工具），下载中显示已下载多少、网速。
   */
  async function fetchWithProgress(url, dest, timeoutSec = 600) {
    mkdirSync(dirname(dest), { recursive: true })
    rmSync(dest, { force: true })
    const stop = watchDownload(dirname(dest))
    try {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri $env:AB_URL -OutFile $env:AB_OUT -UseBasicParsing -TimeoutSec $env:AB_TIMEOUT"],
      { log, env: { AB_URL: url, AB_OUT: dest, AB_TIMEOUT: String(timeoutSec) }, timeoutMs: (timeoutSec + 60) * 1000 })
    } finally {
      stop()
    }
    if (!existsSync(dest) || !statSync(dest).size) throw new Error('下载失败：' + url)
  }

  /** 解压 zip（用 Windows 自带的 Expand-Archive）。 */
  async function expandZip(zip, dir) {
    mkdirSync(dir, { recursive: true })
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:AB_ZIP -DestinationPath $env:AB_DIR -Force'],
      { log, env: { AB_ZIP: zip, AB_DIR: dir }, timeoutMs: 10 * 60_000 })
  }

  /** 准备 uv（装 Python 和各种包的工具）：电脑上有就用，没有就下一个放进安装目录。 */
  async function ensureUv(note) {
    if (process.env.AURABOT_UV) return process.env.AURABOT_UV
    const p = P()
    const local = join(p.bin, 'uv.exe')
    if (existsSync(local)) return local
    try {
      await run('uv', ['--version'], { log, timeoutMs: 15_000 })
      return 'uv'
    } catch (error) {}
    note('  电脑上没有 uv，下载一个放进安装目录')
    const zip = join(p.root, 'downloads', 'uv.zip')
    const tmp = join(p.root, 'downloads', 'uv')
    let lastError = null
    for (const src of UV_SOURCES) {
      try {
        await fetchWithProgress(src.url, zip, 5 * 60)
        if (src.sha256 && createHash('sha256').update(readFileSync(zip)).digest('hex') !== src.sha256) throw new Error('下载的文件校验对不上')
        rmSync(tmp, { recursive: true, force: true })
        await expandZip(zip, tmp)
        const exe = findFile(tmp, 'uv.exe')
        if (!exe) throw new Error('里面没找到 uv.exe')
        mkdirSync(p.bin, { recursive: true })
        copyFileSync(exe, local)
        rmSync(join(p.root, 'downloads'), { recursive: true, force: true })
        return local
      } catch (error) {
        lastError = error
        note(`  从 ${new URL(src.url).host} 下 uv 没成功（${error.message.slice(0, 80)}），换一个源`)
      }
    }
    throw new Error('uv 下载失败：' + (lastError?.message || ''))
  }

  /** 每 4 秒统计一次下载缓存有多大，算出已下载多少、网速多少，给面板看。返回停止函数。 */
  function watchDownload(dir) {
    let last = { at: Date.now(), bytes: dirSize(dir) }
    const base = last.bytes
    const t = setInterval(() => {
      const bytes = dirSize(dir)
      const now = Date.now()
      const speed = Math.max(0, (bytes - last.bytes) / ((now - last.at) / 1000))
      install.progress = { kind: 'download', done: bytes - base, speed }
      last = { at: now, bytes }
    }, 4000)
    t.unref?.()
    return () => clearInterval(t)
  }

  /** 把 imageio-ffmpeg 带的 ffmpeg 复制成 bin\ffmpeg.exe（人声分离要在 PATH 里找到 ffmpeg）。 */
  async function setupFfmpeg() {
    const p = P()
    if (existsSync(p.ffmpeg)) return
    const out = await run(p.python, ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { log })
    const src = out.trim().split(/\r?\n/).pop()
    mkdirSync(p.bin, { recursive: true })
    copyFileSync(src, p.ffmpeg)
  }

  // ---------- 做一首 ----------
  const pyEnv = () => {
    const p = P()
    return { PATH: p.bin + ';' + process.env.PATH, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
  }

  async function ffprobeDuration(file) {
    // ffmpeg -i 会把时长打在 stderr 里，退出码是 1，这里自己接
    return new Promise((resolve) => {
      const c = spawn(P().ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true })
      let s = ''
      c.stderr.on('data', (b) => { s += b })
      c.on('exit', () => {
        const m = s.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
        resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0)
      })
      c.on('error', () => resolve(0))
    })
  }

  /** 人声轨的平均音量（dB）；纯音乐分出来的人声几乎是静音。 */
  async function meanVolume(file) {
    return new Promise((resolve) => {
      const c = spawn(P().ffmpeg, ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { windowsHide: true })
      let s = ''
      c.stderr.on('data', (b) => { s += b })
      c.on('exit', () => { const m = s.match(/mean_volume:\s*(-?[\d.]+|-inf)/); resolve(m ? (m[1] === '-inf' ? -200 : Number(m[1])) : 0) })
      c.on('error', () => resolve(0))
    })
  }

  async function download(job, dir) {
    const c = cfg()
    if (job.songId && noVocals().includes(String(job.songId))) throw new Error('这首没有人声（像是纯音乐或伴奏版），换一首吧')
    let pick = job.songId ? { id: job.songId, name: job.query, artists: '' } : null
    if (!pick) {
      const found = await searchSongs(job.query, { cookie: c.neteaseCookie, limit: 10 })
      if (!found.length) throw new Error(`网易云上没搜到「${job.query}」`)
      // 试过、确认没人声的跳过；看着像纯音乐的排到最后
      const known = noVocals()
      const list = rankCandidates(found, job.query).filter((s) => !(job.skip || []).includes(String(s.id)) && !known.includes(String(s.id)))
      if (!list.length) throw new Error(`搜到的「${job.query}」都是没有人声的版本`)
      // 按顺序找第一首拿得到完整音频的
      for (const s of list) {
        const u = await songUrl(s.id, { cookie: c.neteaseCookie })
        if (u.url && !u.trial) { pick = { ...s, url: u.url }; break }
      }
      if (!pick) throw new Error(`「${job.query}」要会员或者有版权限制，下载不了${c.neteaseCookie ? '' : '（在面板里填网易云 Cookie 后可以下会员歌）'}`)
    } else {
      const u = await songUrl(pick.id, { cookie: c.neteaseCookie })
      if (!u.url || u.trial) throw new Error('这首歌下载不了（要会员或者有版权限制）')
      pick.url = u.url
    }
    job.title = pick.artists ? `${pick.name} - ${pick.artists}` : pick.name
    job.songKey = String(pick.id)
    const r = await fetch(pick.url, { signal: AbortSignal.timeout(120_000) })
    if (!r.ok) throw new Error(`下载失败（HTTP ${r.status}）`)
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length > 60 * 1024 * 1024) throw new Error('歌太大了')
    const file = join(dir, 'song.mp3')
    writeFileSync(file, buf)
    return file
  }

  async function separate(input, dir) {
    const p = P()
    mkdirSync(p.separatorModels, { recursive: true })
    const model = cfg().separatorModel
    await ensureReadable((SEPARATOR_FILES[model] || [[model]]).map(([n]) => join(p.separatorModels, n)))
    await run(p.separatorExe, [input, '--model_filename', model, '--model_file_dir', p.separatorModels, '--output_dir', dir, '--output_format', 'WAV'], { log, env: pyEnv(), timeoutMs: 20 * 60_000 })
    const files = readdirSync(dir)
    const vocals = files.find((f) => /\(vocals\)/i.test(f))
    const inst = files.find((f) => /\(instrumental\)/i.test(f) || /\(other\)/i.test(f))
    if (!vocals || !inst) throw new Error('人声分离没产出文件')
    return { vocals: join(dir, vocals), inst: join(dir, inst) }
  }

  async function convert(vocals, dir, voice, pitch) {
    const p = P()
    const out = join(dir, 'vocals_rvc.wav')
    if (local?.active('song')) {
      const { fileOf } = await import('../local/local.js')
      const r = await local.call('song', { input: vocals, output: out, pitch, voice: voice?.id || '', voiceFile: voice?.pth || '', indexFile: voice?.index || '' })
      const file = fileOf(r) || out
      if (!existsSync(file)) throw new Error('本地换声脚本没写出文件：' + file)
      return file
    }
    await run(p.python, ['core.py', 'infer', '--input-path', vocals, '--output-path', out, '--pth-path', voice.pth, '--index-path', voice.index || '',
      '--pitch', String(pitch), '--index-rate', voice.index ? '0.5' : '0', '--protect', '0.33', '--f0-method', 'rmvpe', '--export-format', 'WAV'],
    { cwd: p.applio, log, env: pyEnv(), timeoutMs: 20 * 60_000 })
    if (!existsSync(out)) throw new Error('变声没产出文件')
    return out
  }

  /**
   * 语音条变声（给「语音」模块用）：把一段 TTS 音频用翻唱里导入的 RVC 音色模型换成她的声音。
   * 内置 RVC 模式会先用 ffmpeg 把 TTS 输出（常见是 mp3）转成 44.1k 单声道 wav 再换声。
   * @param {string} input 输入音频文件
   * @param {{voice?: string, pitch?: number, outDir?: string}} [opts] voice = models 里的音色 id；pitch = 变调半音
   * @returns {Promise<string>} 变声后的 wav 文件
   */
  async function convertSpeech(input, { voice = '', pitch = 0, outDir = '' } = {}) {
    if (!existsSync(input)) throw new Error('要变声的音频不存在')
    const p = P()
    const voices = listVoices(p.models)
    if (!voices.length) throw new Error('翻唱里还没有导入音色模型：面板「翻唱」页导入 .pth / zip')
    const v = (voice ? voices.find((x) => x.id === voice) : voices.find((x) => x.id === cfg().voice)) || voices[0]
    // 私聊和家庭群可能同时说话；每条语音独立输入/输出，避免同名文件互相覆盖。
    const dir = join(outDir || join(work(), 'speech-rvc'), randomUUID())
    mkdirSync(dir, { recursive: true })
    let source = input
    if (!local?.active('song')) {
      if (!existsSync(p.python) || !existsSync(join(p.applio, 'core.py')) || !existsSync(p.rmvpe) || !existsSync(p.contentvec)) {
        throw new Error('翻唱环境还没装好：面板「翻唱」页点「一键安装」，装好后再给语音条变声')
      }
      if (existsSync(p.ffmpeg)) {
        const wav = join(dir, 'speech-in.wav')
        await run(p.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-ar', '44100', '-ac', '1', wav], { log })
        if (existsSync(wav)) source = wav
      }
    }
    const n = Math.max(-24, Math.min(24, Math.round(Number(pitch) || 0)))
    return convert(source, dir, v, n)
  }

  async function mix(vocals, inst, dir) {
    const c = cfg()
    const full = join(dir, 'cover.mp3')
    const vol = Math.max(0.2, Math.min(2, Number(c.vocalVolume) || 1))
    const iv = Math.max(0.1, Math.min(2, Number(c.instVolume) || 0.8))
    await run(P().ffmpeg, mixArgs({ vocals, inst, vol, iv, out: full }), { log })
    return full
  }

  /** 先截出要发的那一段再处理：分离和换声都只算这一段，快一倍多。返回 {file, cut, length}。 */
  async function cutFirst(song, dir, songId) {
    const c = cfg()
    const dur = await ffprobeDuration(song)
    let times = []
    if (c.clipStart !== 'head' && dur > (Number(c.maxVoiceSec) || 120) && songId) {
      try { times = await songLyricTimes(songId) } catch (error) { log.info('歌词时间不可用，沿用普通截段：', error.message) }
    }
    const w = clipWindow(dur, Number(c.maxVoiceSec) || 120, c.clipStart, times)
    log.info(`翻唱选段：${w.start.toFixed(2)} 秒起，${w.length.toFixed(2)} 秒${times.length ? '（参考歌词时间，优先连续演唱）' : ''}`)
    if (!dur || (w.start === 0 && w.length >= dur)) return { file: song, cut: false, length: dur }
    const out = join(dir, 'part.wav')
    await run(P().ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(w.start), '-t', String(w.length), '-i', song, '-ar', '44100', out], { log })
    return { file: out, cut: true, length: w.length }
  }

  /** 截过的段落首尾加淡入淡出，听起来不突兀。 */
  async function fade(mixed, dir, length) {
    const out = join(dir, 'voice.mp3')
    await run(P().ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', mixed,
      '-af', `afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, length - 3)}:d=3`, '-b:a', '128k', out], { log })
    return out
  }

  async function process1(job) {
    const c = cfg()
    const localSong = Boolean(local?.active('song'))
    const voice = localSong ? { id: job.voice || c.voice || 'local', pth: '', index: '' }
      : listVoices(P().models).find((v) => v.id === (job.voice || c.voice)) || listVoices(P().models)[0]
    if (!voice && !local?.active('song')) throw new Error('还没有可用的音色模型')
    const pitch = Number.isFinite(Number(job.pitch)) ? Math.max(-24, Math.min(24, Math.round(Number(job.pitch)))) : Number(c.pitch) || 0
    const dir = join(work(), Date.now().toString(36))
    mkdirSync(dir, { recursive: true })
    stage('下载歌曲')
    const song = job.file || (await download(job, dir))
    // 同一首歌、同一个音色、音高和截取方式做过的，直接复用
    // v3：歌词时间选段与人声/伴奏增益都进入缓存键，避免调整后仍发旧成品。
    const key = coverCacheKey({ ...c, song: job.songKey || song, voice: localSong ? 'local:' + voice.id : voice.id, pitch, acapella: job.acapella })
    const cached = join(work(), 'cache', key + '.mp3')
    if (existsSync(cached)) {
      log.info(`翻唱：「${job.title}」做过了，直接用缓存`)
      return { file: cached, voice: voice.id, pitch, dir, key }
    }
    stage('截取要唱的那一段')
    const part = await cutFirst(song, dir, job.songKey)
    stage('分离人声和伴奏')
    const { vocals, inst } = await separate(part.file, dir)
    // 纯音乐 / 伴奏版分不出人声：换下一首候选重做，不然发出去只有伴奏
    const vol = await meanVolume(vocals)
    if (vol < VOCAL_MIN_DB) {
      log.info(`翻唱：「${job.title}」几乎没有人声（${vol.toFixed(0)} dB），像是纯音乐`)
      try { rmSync(dir, { recursive: true, force: true }) } catch (error) {}
      if (!job.file) markNoVocals(job.songKey)
      if (job.file || job.songId) throw new Error('这首没有人声（像是纯音乐或伴奏版），换一首吧')
      job.skip = [...(job.skip || []), job.songKey]
      if (job.skip.length >= 3) throw new Error(`搜到的几版「${job.query}」都没有人声，换个说法试试（比如带上歌手名）`)
      stage('换一版重下')
      return process1(job)
    }
    stage('换成她的声音')
    const converted = await convert(vocals, dir, voice, pitch)
    stage('混音')
    const mixed = await mix(converted, job.acapella ? null : inst, dir)
    const out = part.cut ? await fade(mixed, dir, part.length) : mixed
    mkdirSync(join(work(), 'cache'), { recursive: true })
    copyFileSync(out, cached)
    pruneCache(join(work(), 'cache'), 40)
    return { file: cached, voice: voice.id, pitch, dir, key }
  }

  async function pump() {
    if (current || !queue.length) return
    const job = queue.shift()
    current = { query: job.query, title: job.query, chatId: job.chatId, songId: job.songId || '', voice: job.voice || '', pitch: job.pitch, acapella: Boolean(job.acapella), stage: '排队', startedAt: Date.now() }
    persist(true)
    log.info(`翻唱开始：「${job.query}」→ ${job.chatId}`)
    const note = `[${job.acapella ? '清唱' : '翻唱'}] ${job.title || job.query}`
    try {
      if (job.canSend && !job.canSend()) return
      const r = await process1(job)
      // 成品先记账：从这里开始就算热重载，下次也能找到这首歌
      current.file = r.file
      current.cacheKey = r.key || ''
      current.voice = r.voice
      current.title = job.title || job.query
      stage('发送')
      if (job.canSend && !job.canSend()) return
      let sent = null
      try {
        sent = await sendVoiceFile(job.chatId, r.file, note, { isCurrent: job.canSend || null })
      } catch (error) {
        // 做好了但这一下没发出去：成品不能丢，记成待补发
        addPending({ ...job, file: r.file, cacheKey: r.key, title: job.title, reason: error.message }, { force: true })
        history.unshift({ at: Date.now(), title: job.title || job.query, voice: r.voice, pitch: r.pitch, ok: false, chatId: job.chatId, message: `做好了，但没发出去（${error.message}）；可以让我补发` })
        log.warn(`翻唱做好了但没发出去：「${job.title || job.query}」：${error.message}（已记成待补发）`)
        return
      }
      if (!sent || String(sent.message_id || '').startsWith('sim-')) {
        addPending({ ...job, file: r.file, cacheKey: r.key, title: job.title, reason: sent ? '未确认送达' : '网关没接受这条语音' }, { force: true })
        history.unshift({ at: Date.now(), title: job.title || job.query, voice: r.voice, pitch: r.pitch, ok: false, simulated: Boolean(sent), chatId: job.chatId, message: '做好了，但没确认发出去；可以让我补发' })
        log.warn(`翻唱做好了但没确认送达：「${job.title || job.query}」（已记成待补发）`)
        return
      }
      const seconds = Math.round((Date.now() - current.startedAt) / 1000)
      history.unshift({ at: Date.now(), title: job.title || job.query, voice: r.voice, pitch: r.pitch, ok: true, chatId: job.chatId, messageId: sent.message_id, seconds, message: `用时 ${seconds} 秒` })
      log.info(`翻唱完成：「${job.title || job.query}」（${seconds} 秒）`)
      onSung?.(job.title || job.query, job.chatId)
      if (!cfg().keepWork) try { rmSync(r.dir, { recursive: true, force: true }) } catch (error) {}
    } catch (error) {
      const why = explainSongError(error.message)
      history.unshift({ at: Date.now(), title: job.title || job.query, ok: false, chatId: job.chatId, message: why })
      log.warn(`翻唱失败：「${job.query}」：`, error.message)
      if (!job.canSend || job.canSend()) sendText?.(job.chatId, `唱不了「${job.title || job.query}」：${why}`).catch(() => {})
    } finally {
      history = history.slice(0, 20)
      current = null
      persist(true)
      pump()
    }
  }

  /** 点一首：马上返回，做好了自己发到聊天里。 */
  function request({ song, songId, file, pitch, voice, chatId, acapella, canSend }) {
    if (!voiceTargetAllowed(getConfig(), chatId)) return { ok: false, message: VOICE_SCOPE_MESSAGE }
    const c = cfg()
    if (!c.enabled) return { ok: false, message: '翻唱还没打开（面板「翻唱」标签里开）' }
    const st = status()
    if (!st.ready) return { ok: false, message: '翻唱环境还没装好：' + st.message }
    if (!song && !songId && !file) return { ok: false, message: '要说唱哪首歌' }
    if (queue.length >= 5) return { ok: false, message: '排队的歌太多了，等会儿再点' }
    queue.push({ query: song || basename(file || ''), songId, file, pitch, voice: voice || c.voice || '', chatId, acapella: Boolean(acapella), canSend, at: Date.now() })
    persist(true)
    const ahead = queue.length - 1 + (current ? 1 : 0)
    pump()
    return { ok: true, message: `开始准备「${song || basename(file || '')}」${ahead ? `（前面还有 ${ahead} 首）` : ''}，${estimateNote(history)}` }
  }

  /** 待补发：做成但没确认发出的成品（以及热重载打断、没走完的）。 */
  function listPending() {
    return pending.slice().reverse().map((p) => ({ ...p }))
  }

  /** 点歌时正好有这首的待补发成品：直接补发，不重做。太久以前的不算，免得把几天前的旧成品当新歌发。 */
  function findPendingFor({ song, songId, pitch, acapella, maxAgeMs = 6 * 60 * 60_000 } = {}) {
    const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase()
    const want = norm(song)
    const wantPitch = Number.isFinite(Number(pitch)) ? Number(pitch) : Number(cfg().pitch) || 0
    return pending.find((p) => {
      if (!p.file || !existsSync(p.file)) return false
      if (p.voice && p.voice !== cfg().voice || local?.active('song') && !p.voice) return false
      if (Date.now() - (Number(p.at) || 0) > maxAgeMs) return false
      if (songId && p.songId && String(p.songId) === String(songId)) return true
      if (!want) return false
      if (!norm(p.title).includes(want) && !norm(p.query).includes(want)) return false
      return Number(p.pitch || 0) === wantPitch && Boolean(p.acapella) === Boolean(acapella)
    }) || null
  }

  /**
   * 补发一条待补发：有成品就发（发前复查开关、授权、目标），没成品就照原样重做。
   * 不带 id 就补最近一条。canSend(target) 返回空串/true 表示可以发，返回别的字符串表示不能发的理由。
   */
  async function resend(id, { chatId, canSend } = {}) {
    const item = id ? pending.find((p) => p.id === String(id)) : pending[pending.length - 1]
    if (!item) return { ok: false, message: '没有待补发的翻唱' }
    const target = String(chatId || item.chatId || '')
    if (!voiceTargetAllowed(getConfig(), target)) return { ok: false, message: VOICE_SCOPE_MESSAGE }
    if (!target) return { ok: false, message: '这条翻唱没记着要发给谁，不能瞎发' }
    if (!cfg().enabled) return { ok: false, message: '翻唱开关关着，先打开再补发' }
    if (typeof canSend === 'function') {
      const verdict = canSend(target)
      if (verdict !== true && verdict !== '') return { ok: false, message: String(verdict || '现在不能往这个聊天发') }
    }
    if (!item.file || !existsSync(item.file)) {
      const r = request({ song: item.query, songId: item.songId, pitch: item.pitch, voice: item.voice, acapella: item.acapella, chatId: target })
      if (r.ok) { pending = pending.filter((p) => p !== item); persist(true) }
      return { ...r, remade: Boolean(r.ok) }
    }
    const note = `[${item.acapella ? '清唱' : '翻唱'}] ${item.title || item.query}`
    try {
      const sent = await sendVoiceFile(target, item.file, note, {})
      if (!sent || String(sent.message_id || '').startsWith('sim-')) {
        item.tries += 1
        item.reason = sent ? '未确认送达' : '网关没接受这条语音'
        persist(true)
        return { ok: false, message: '还是没确认发出去，成品留着，等网关好了再补' }
      }
      pending = pending.filter((p) => p !== item)
      history.unshift({ at: Date.now(), title: item.title || item.query, ok: true, chatId: target, messageId: sent.message_id, seconds: 0, message: '补发成功' })
      history = history.slice(0, 20)
      persist(true)
      log.info(`翻唱补发：「${item.title || item.query}」→ ${target}`)
      return { ok: true, message: `补发出去了：「${item.title || item.query}」`, messageId: sent.message_id, file: item.file }
    } catch (error) {
      item.tries += 1
      item.reason = error.message
      persist(true)
      return { ok: false, message: `没发出去：${error.message}` }
    }
  }

  return {
    status,
    convertSpeech,
    install: () => { runInstall(); return { ok: true, message: '开始安装，要下载好几个 GB，可能要十几分钟' } },
    request,
    /** 待补发清单（做成没发出去的、被重载打断的）。 */
    pending: listPending,
    listPending,
    findPendingFor,
    /** 补发一条：有成品直接发，没成品重做。 */
    resend,
    search: (q) => searchSongs(q, { cookie: cfg().neteaseCookie, limit: 8 }),
    account: () => account(cfg().neteaseCookie),
    voices: () => status().voices.map((v) => v.id),
    // .ckpt 是手动下好的人声分离模型，其余是音色
    importModels: (filename, buf) => (/\.ckpt$/i.test(filename) ? importSeparator(P().separatorModels, filename, buf) : importModels(P().models, filename, buf)),
    separatorLinks: () => separatorLinks(cfg().separatorModel),
    deleteVoice: (id) => deleteVoice(P().models, id),
  }
}
