// 插件配置：默认值 + 归一化 + 读写。配置文件 ~/.dsh/plugins-data/aurabot/config.json

import { dataDir, readJson, writeJson } from './store.js'
import { DEFAULT_GROUP_POLICY } from '../chat/group-policy.js'
import { LEVELS, PROFILE_PERM_KEYS, PROFILE_PERM_LEVELS, profilePermDefault } from '../chat/access.js'
import { normalizeChatModels } from '../chat/chat-model.js'
import { DIARY_AUDIENCES } from '../features/qzone-audience.js'
import { MINIMAX_MODELS } from '../voice/minimax.js'
import { DOUBAO_RESOURCES, DOUBAO_CLONE_MODELS } from '../voice/doubao.js'

export const DEFAULTS = {
  enabled: false, // 总开关：关着一句都不发
  dryRun: true, // 试运行：只记日志不真发
  setupDone: false, // 首次使用向导走完了没有
  communityMigrated: {}, // 搬到社区库的模块处理过没有（id → installed / skipped / kept），只处理一次
  botQQ: '', // 机器人 QQ 号（向导里填）
  ownerQQ: '', // 主人 QQ 号（向导里填）
  ownerName: '主人',
  ownerRole: '', // 家庭身份（如爸爸），与实际称呼分开。
  // 其他主人（比如第二位家长）：[{ qq, name }]。权限和 ownerQQ 完全一样；通知、主动搭话默认还是找 ownerQQ。
  coOwners: [],
  // 家庭群（群号）：只有家里人的群。只听主人们的，她在这里和主人私聊同一档权限、按主人视角看记忆；
  // 默认积极参与家庭聊天，会自动算进群白名单。
  familyGroups: [],
  ownerLevel: 'full', // full | social | chat
  approvalNotify: true, // DSH 要授权时把请求发到主人私聊
  qqApi: { enabled: true }, // 她能用 qq_api_call 调 QQ 接口：别人只能查当前群，写操作只听主人
  approvalViaQQ: true, // 主人私聊会话要授权时，在 QQ 回复「确认」直接批准这一次
  profilePerms: { qqNickname: 'owner', qqSignature: 'owner', qqAvatar: 'owner', biliSign: 'owner', biliAvatar: 'owner', biliComment: 'owner', qqFriendRequest: 'owner', whitelist: 'owner', douyinBrowse: 'owner', douyinLike: 'owner', douyinComment: 'owner', douyinShareOwner: 'owner', douyinDm: 'owner' }, // 改资料类操作（含抖音浏览 / 点赞 / 评论 / 分享）的权限：off 关 / owner 仅主人私聊 / all 所有人。抖音项默认仅主人，总开关默认关
  longTasks: true, // 长任务模式：主人私聊（完整权限）额外挂 dsh-tool-jobs + dsh-tool-schedule，会多一点工具定义、稍慢
  // 后台子智能体委派（默认关）：模块用 hub.runSubagentTurn 派子智能体时，正常要求「主人开口」的来源；
  // 定时任务这类没人应答的场合，只有打开这个开关才允许派活。关着 = 一律拒绝（一审 #177 的审批策略）。
  subagentBackground: false,
  allow: { private: [], groups: [] }, // 主人永远能私聊，不用写进白名单
  // 用什么接 QQ：snowluma = 插件帮你管 SnowLuma（Windows）；onebot = 接你已有的 OneBot v11 机器人（NapCat、LLOneBot、Lagrange、Docker 里的 SnowLuma……），
  // 这时只按下面 snowluma.httpUrl / wsUrl / token 去连，不启动、不注入任何东西
  gateway: 'snowluma',
  workspaceDir: '', // QQ 会话放在哪个文件夹（DSH 里的「Aurabot · QQ」工作区）；留空 = 默认（用户目录下 Aurabot\\qq-chats）
  // 发文件（#52）：默认开但限制很多——她只能把 QQ 工作区（workspaceDir）和 dirs 里列的目录中的文件当文件发出去；
  // 单个文件有大小上限；主人私聊里能触发，群里只在主人开口那一轮能触发（可以发给白名单里的人和群）。日志里会记下发了什么。
  // imageByPath（#169）：本地图片先按路径直发，被网关明确拒绝才改用 base64；网关和 NapCat 没共享挂载时会自动回退。
  files: { enabled: true, maxMB: 50, imageByPath: true, dirs: [] },
  // 想交新朋友 / 想进新群：网关不能主动加好友、申请加群，所以她用 qq_wish_contact 私聊问主人，由主人在机器人号 QQ 上手动加。
  // perDay = 每天最多问几次（好友和群合计）；主人说「算了」的不会再提。
  contactWish: { enabled: true, perDay: 3 },
  // 交友圈（默认关）：她自己在白名单群里邀请聊得来的群友加她，自动通过，活跃朋友维持在 min~max 个；
  // 每 reviewDays 天回顾一次要不要继续来往。minHits = 最近 14 天直接找她说话多少次才进候选名单（挑谁由她自己判断）；
  // groupCooldownDays = 同一个群多少天内最多邀请一次。
  // 自己管白名单（默认关）：新好友要不要私聊、群邀请去不去、进群旁听 observeHours 小时后要不要在群里说话，都由她自己决定；改动会告诉主人
  selfAllow: { enabled: false, observeHours: 24 },
  circle: { enabled: false, min: 5, max: 7, autoAccept: true, minHits: 2, groupCooldownDays: 7, reviewDays: 3 },
  // 危险命令确认（可选保护，默认关）：她在私聊里执行删根目录/格式化/关机/下载后直接执行等
  // 终端命令前，先发 QQ 私聊问主人，回复「确认」才执行；超时或「取消」就拦下。
  // panelRemoteAccess：允许远端（非回环）访问管理接口；默认 false = 只有本机能管。
  // trustedProxy：可信反向代理地址（逗号分隔）；只有请求确实从这些地址进来，才采信
  //   X-Forwarded-For 的最后一跳作为真实来源。留空 = 从不相信任何转发头（最安全）。
  // publicHostname：面板经反代对外时的域名（如 panel.example.com）；CSRF 同源校验把
  //   这个域名的 Origin 也算同源。留空 = 只有回环 Origin 算同源。
  security: { dangerConfirm: false, ssrfMode: 'strict', panelRemoteAccess: false, trustedProxy: '', publicHostname: '' },
  // DeepSeek 峰谷省钱模式（默认关，现有行为不变）：打开后只把「不着急的后台模型调用」尽量挪到谷时，
  // 聊天回复/工具/审批/定时任务本身不变。offPeakHolidays 是中国法定节假日（北京时间日期 'YYYY-MM-DD'）。
  cost: { offPeak: false, offPeakHolidays: [] },
  update: { unstable: null }, // 订阅不稳定版本（beta、rc）；null = 没选过，按正在用的版本定
  snowluma: {
    dir: 'C:\\Aurabot\\snowluma', // 主人自己下载解压到这里（EULA 不允许自动部署）
    autoStart: true, // 随 DSH 启动它（只启动主人已安装并同意过协议的副本）
    webuiPort: 5099,
    webuiPassword: '', // 插件自动生成并保存（第一次启动 SnowLuma 时）；用来调 /api/processes 只给机器人号注入
    passwordAuto: false,
    autoAttach: true, // 自动给机器人号所在的 QQ 进程注入（绝不碰别的号）
    httpUrl: '', // 留空 = 从 SnowLuma 配置里自动读
    wsUrl: '',
    httpToken: '',
    wsToken: '',
  },
  model: { provider: '', model: '', reasoningEffort: 'low', vision: 'auto' }, // 留空 = 跟随 DSH 默认；vision: auto/on/off
  // 按聊天选模型（主人在面板「模型」页设）：私聊 QQ 号 > 群号 > 所有私聊 / 所有群默认 > 上面的全局模型；没写的一级退到下一级
  chatModels: { privateDefault: { provider: '', model: '', reasoningEffort: '' }, groupDefault: { provider: '', model: '', reasoningEffort: '' }, privates: {}, groups: {} },
  merge: { enabled: true, waitSec: 5, maxSec: 8, groupWaitSec: 5, groupMaxSec: 15 }, // 连发合并：对方停顿 waitSec 秒再一起回，最多等 maxSec 秒；群里等得久一点，把一段话攒齐
  imageGen: {
    enabled: false,
    provider: 'openai', // openai / custom；codex = 实验性订阅接法（需单独登录）
    baseUrl: '',
    apiKey: '',
    model: '',
    size: '1024x1024',
    shape: 'her', // 工具可选构图；her 时未指定就沿用 size
    stylePrompt: '', // 每次生图自动加在前面的风格描述
    ownerOnly: true, // 只有主人能让她画
    seeOwn: true, // 「让她画完自己看一眼」：开着才把画好的图交给她看
    img2img: true, // 允许参考聊天图片 / 自己的画作来改画
    galleryShown: 20, // 面板「她的画作」显示最近几张（1~50；只影响显示，不删文件）
    // 自定义接法：url 里可以用 {prompt} {model} {size} {width} {height} {image}（参考图 base64）；params 是参数名/值（值里也能用这些占位符）
    custom: { method: 'GET', url: '', bodyType: 'json', responsePath: '', params: [] },
    // 实验性订阅接法；登录令牌独立保存在数据目录，不进入配置。
    codex: { model: 'gpt-image-2', quality: 'auto', background: 'auto' },
  },
  persona: { current: 'dafeiyu' },
  // 主人私聊里问起群里的事：把最近 24 小时的群聊流水补进这一轮（默认关，开启前先把群加进白名单）
  group: { ...DEFAULT_GROUP_POLICY, overrides: {}, ownerBrief: { enabled: false, lines: 12, groups: [] } },
  // 按群头衔不回：勾选的群里，专属头衔正好是 title 的成员（一般是别的机器人）说话、戳她都不理。没勾群就不起作用
  titleFilter: { enabled: true, groups: [], title: '大肥鱼' },
  voice: {
    enabled: true,
    // auto = 先 edge-tts，不行用 Windows；指定 Breeze 失败默认回文字，其他引擎维持原来的回退
    engine: 'auto',
    breezeFallback: 'text', // Breeze 失败时默认发文字，可选 edge；不自动切 Windows 音色
    cosyvoice: { url: 'http://127.0.0.1:50000', mode: 'sft', spkId: '中文女', instruct: '', sampleRate: 22050 },
    gptsovits: { url: 'http://127.0.0.1:9880', refAudio: '', promptText: '', promptLang: 'zh', textLang: 'zh' },
    // 通用 HTTP 引擎：GET 时地址里带 {text}；POST 时填接口地址，请求头一行一个，请求体里 {text} 自动替换（已做 JSON 转义）
    http: { urlTemplate: '', method: 'GET', headers: '', body: '', sampleRate: 24000 },
    // Breeze 云端语音（breezeblue.ai）：只会说话。apiKey 只存本机；voiceId 是公共音色或自己克隆的音色；
    // instructions = 念法提示（比如「语气俏皮、有点不耐烦」）；她发语音时还能写 [笑] [叹气] 这类音效标签
    breeze: { apiKey: '', voiceId: '', model: '', language: 'zh', instructions: '', speed: 1, guidance: 1 },
    // MiniMax 云端语音：情绪、语速、音调都是固定参数，比 Breeze 的文字念法说明稳。region：cn 国内 / intl 国际；
    // emotion：tone = 按她写的语气挑情绪档位，model = 交给模型自己判断
    // 豆包语音（火山引擎语音合成 2.0）：新版控制台一个 apiKey；老控制台填 appId + accessToken。speaker 是音色 ID；
    // resourceId：auto = 复刻音色用 seed-icl-2.0、其余 seed-tts-2.0；toneMode：context = 把她写的语气变成语音指令，off = 不加
    doubao: { apiKey: '', appId: '', accessToken: '', speaker: '', clonedSpeaker: '', resourceId: 'auto', cloneModel: 'seed-tts-2.0-expressive', speechRate: 0, loudnessRate: 0, toneMode: 'context' },
    minimax: { apiKey: '', region: 'cn', baseUrl: '', model: 'speech-2.8-hd', voiceId: '', speed: 1, vol: 1, pitch: 0, languageBoost: 'Chinese', emotion: 'tone' },
    voice: 'zh-CN-XiaoyiNeural',
    rate: '+0%',
    pitch: '+0Hz',
    autoChance: 0.15, // 短回复自动变语音的概率
    autoMaxChars: 80,
    asr: true, // 听语音
    emojiSeparate: true, // 语音条里的表情/emoji 不念出来，单独补一条文字发出去
    leadingSilenceMs: 500, // 合成后给语音条开头补静音，不靠模型念停顿标签
    minCharsPerSec: 4.4, // 语速下限（每秒几个字）：合成出来比这慢的语音不变调加速到这个速度，0 = 不处理
    maxSpeedup: 1.1, // 自动加速最多几倍（1 = 不加速）。原来是为 Breeze 忽快忽慢定的 1.35，用户反馈太夸张
    // 语音条变声：用翻唱里导入的 RVC 音色模型（先 TTS 念，再变声）。留空 = 不变声
    songVoice: '',
    songPitch: 0, // 变调半音：男声模型转女声一般 +12
  },
  stickers: {
    enabled: true,
    faces: true, // 回复里能夹 QQ 自带的小黄脸（<face:名字>）
    autoChance: 0.35, // 文字回复自动配一张表情的概率
    collect: true, // 偷表情
    // 怎么偷：auto = 看到就收（默认，保持原行为）；ask = 她挑（先记着，喜欢才凭编号收）；owner = 只听主人的（只有主人语境下才提示/允许收）
    collectMode: 'auto',
    fromGroups: true,
    fromPrivate: true,
    maxPerHour: 20,
    maxLibrary: 300, // 表情库最多存多少张（QQ 收藏表情有上限），超了就清掉最少用的
    caption: true, // 用视觉模型起备注
    externalCollectMinMinutes: 30, // 普通群自动收新表情的最短间隔；本地筛选，不逐条问模型
    externalCollectMaxPerDay: 8,
    captionMaxPerHour: 4,
    captionMaxPerDay: 16,
    captionQueueLimit: 8,
    captionPreferSummary: true,
    captionMaxTokens: 400,
    // 起名单独挑的模型：{ provider, model }；留空 = 跟随聊天用的模型
    captionModel: { provider: '', model: '' },
  },
  // 家庭日记自主选择分享时机；旧空间的次数/时段/配图配置保留兼容，不驱动家庭日记。
  diary: {
    enabled: true,
    timesPerDay: 2,
    windowStart: '10:00',
    windowEnd: '23:30',
    minGapMinutes: 180,
    attachImage: true, // 写日记时配一张图（优先今天她画的，其次今天收的表情包）
    // 可选图文日记：关着时沿用原来的聊天摘录和配图流程；本地目录必须由主人填写。
    rich: { enabled: false, stickers: false, browsing: false, local: false, folder: '', maxImages: 2 },
    archive: { enabled: false, folder: '' }, // 已有公开浏览图按浏览日期归档；必须由主人指定输出目录
    minChars: 60,
    maxChars: 140,
    visibility: 'all', // all | friends | selected | self | excluded，和 QQ 空间自身的可见范围一致
    audienceQQs: '', // selected / excluded 时可见（或不可见）的好友 QQ 号，换行或逗号分隔
  },
  // 本地接口：数据目录 local/ 里的脚本接管这几项（文件要在、开关要开）
  local: { tts: false, image: false, song: false, asr: false, video: false, videoTimeoutMin: 20 },
  bili: {
    enabled: false,
    sessdata: '', // B 站 Cookie 里的 SESSDATA（登录凭证）
    biliJct: '', // B 站 Cookie 里的 bili_jct（发评论要用）。两个都不填也能看视频，只是不能评论
    ownerName: '', // 主人的 B 站昵称：她写 @主人 时 @ 这个号
    cookie: '', // 由上面两个拼出来给接口用；老配置的整串会自动拆到上面两个里
    autoBrowse: true, // 定时自己去刷
    intervalHours: 4, // 多久刷一轮
    maxRunsPerDay: 3,
    perRun: 3, // 一轮看几个视频
    keywords: [], // 额外想让她搜的方向（另外还会参考她的兴趣和记忆里你喜欢的东西）
    minViews: 5000, // 播放量门槛
    maxAgeDays: 60, // 只看最近多少天发的
    comment: true, // 自己发评论
    maxCommentsPerDay: 3,
    reply: true, // 回别人回她的评论
    maxRepliesPerDay: 6,
    danmakuEnabled: false, // 主人主动打开后才允许发送弹幕
    autoDanmaku: false, // 刷完自己发弹幕，另行开启
    maxDanmakuPerDay: 3, // 手动和自动共用提交上限（失败也计数）
    shareToOwner: true, // 看到好玩的私聊分享给主人
    like: false, // 顺手点赞
    vision: false, // 可选：ffmpeg 抽帧交给视觉模型
    visionFrames: 6,
    ffmpegPath: '', // 留空从 PATH 查找
    shotChance: 0.35, // 刷完发截图给主人；0 = 不自动发
    shotLibrary: 300,
  },
  // 刷抖音：专用浏览器（独立登录资料，不碰你平时的浏览器），经 CDP 控制。浏览 / 点赞 / 评论 / 分享各项权限在 profilePerms.douyin*。
  douyin: {
    enabled: false, // 总开关：默认关，先在面板里扫码登录再打开
    autoBrowse: true, // 定时自己去刷
    intervalHours: 4,
    maxRunsPerDay: 3,
    perRun: 5, // 一轮看几个视频
    maxWatchPerDay: 30, // 每天最多看几个（手动让她刷也算；主人亲口让她找视频时不受这个限制）
    dwellMin: 8, // 每个视频停留的秒数（随机取一个）
    dwellMax: 40,
    browserPath: '', // 留空 = 自动找 Edge（找不到再找 Chrome / Chromium）；也可填完整路径
    shareBias: 'proactive', // stingy | normal | proactive：刷到好看的视频，分享给主人的积极程度
    ownerDm: true, // 主人在抖音上私信她时回（只认核对过的主人抖音号）
    dmPollMinutes: 3, // 隔几分钟看一次主人的抖音私信
    shareTo: 'douyin', // douyin = 在抖音里私信分享给主人（要先核对主人抖音号，没核对 / 发不出去就改发 QQ）| qq = QQ 私聊发链接 | both = 两边都发
    owner: { input: '', secUid: '', uid: '', nickname: '', confirmedInput: '' }, // 主人的抖音号：面板填抖音号 / 主页链接，「核对」后才写入 secUid（真·@主人只认它）
    caps: { like: 30, comment: 3, share: 5, atOwner: 3 }, // 每天上限（登录后前 newAccountDays 天减半）；atOwner = 评论里真·@主人
    gate: {
      maxWritesPerDay: 40, // 点赞 + 评论合计上限
      minWriteGapSec: 20, // 两次点赞 / 评论之间至少隔这么多秒
      newAccountDays: 3, // 首次登录起这么多天内，上限都减半
    },
  },
  // 刷小黑盒：用主人的账号逛游戏社区（读多写少）。点赞 / 评论 / 发帖各项权限在 profilePerms.heybox*。
  heybox: {
    enabled: false, // 总开关：默认关，先在面板里填 Cookie 再打开
    cookie: '', // 整串 Cookie（pkey 必须有；要写操作还得有 x_xhh_tokenid）
    autoBrowse: true, // 定时自己去逛（只读）
    intervalHours: 4, // 多久逛一圈
    maxRunsPerDay: 6, // 每天最多逛几轮
    perRun: 3, // 一圈看几条
    likeDaily: 10, // 每天最多点赞
    commentDaily: 3, // 每天最多评论
    maxPostsPerDay: 3, // 每天最多发帖（硬上限，多了容易被限）
    defaultTopic: 7214, // 发帖默认分区：7214 盒友杂谈 / 18745 数码硬件 / 806933 AI
    postStyle: 'mix', // 发帖风格：diary 大肥鱼日记 / news 热搜文 / mix 肥鱼热搜
    shareToOwner: true, // 逛到有意思的帖子，私聊分享给主人（和 B 站同一个思路）
    shareBias: 'normal', // stingy | normal | proactive：分享给主人的积极程度
    shareDaily: 3, // 每天最多分享几条（避免刷屏）
    // 谷时逛：只在非峰时跑自动逛，避开工作日 9-12 / 14-18 的高峰，省 token
    // 分区：manual = 总是用默认分区；auto = 按正文内容自动挑（挑不到回落默认）
    topicMode: 'manual',
    // 发帖字数范围：0 = 用风格自带的；填了就覆盖（对所有风格生效）
    postWordsMin: 0,
    postWordsMax: 0,
    // 每天每篇的排期：空数组 = 用全局设置；填几项就按几篇发，每篇用自己的配置
    dailyPosts: [],
    offPeakOnly: false, // 开关：默认关（行为不变）
    peakStartAM: 9, // 上午峰时开始（含）
    peakEndAM: 12, // 上午峰时结束（不含）
    peakStartPM: 14, // 下午峰时开始（含）
    peakEndPM: 18, // 下午峰时结束（不含）
    peakWeekend: false, // 周末是否也算峰时（默认不算，周末全天可逛）
  },
  qzoneSocial: {
    enabled: true,
    replyOwn: true, // 回复自己说说下别人的新评论
    commentFriends: true, // 逛好友动态，偶尔评论
    friendChance: 0.3, // 看到一条好友说说时互动（点赞 + 可能评论）的概率
    ownerChance: 0.7, // 主人的说说互动概率
    like: true, // 互动时顺手点赞
    maxPerDay: 8, // 每天最多评论几条（点赞不算）
    intervalMin: 30, // 多久逛一次空间
  },
  speakUp: {
    enabled: true, // 只在和主人的私聊里主动找你，群里不会
    idleMinutes: 40,
    minIntervalMinutes: 60,
    maxIntervalMinutes: 180,
    maxPerDay: 20, // 每个人每天最多几次；留空就是 20
    allow: [], // 主动搭话白名单：除主人外还会主动找谁（QQ 号）
    // 家庭群冷清时她主动在群里说点什么：群里安静了 idleMinutes 分钟（爸妈可能都在忙），醒着的时段里，每天最多 maxPerDay 次
    family: { enabled: true, idleMinutes: 75, maxPerDay: 5 },
    nudge: true, // 她问了你一句、你一直没回时，偶尔轻轻追一句
    awakeFrom: 8,
    awakeTo: 23,
  },
  mood: { enabled: true, halfLifeHours: 3, judge: false, base: 60 }, // base：心情基线（0~100 里算「平常」的那个值）；judge：每轮聊完用模型判一次心情（更准，每轮多一次很短的调用）；关着用关键词
  // stableContext：运行时上下文里少放每轮都变的东西（心情原因、相对时间），内容一变 DSH 就把整份快照再追加进历史一次
  chat: { seedHistory: false, seedHistoryCount: 20, stableContext: true }, // seedHistory：新会话第一次说话时先补最近几条历史（默认关）
  memory: {
    enabled: true, recallCount: 6, recallMode: 'always', recallTriggers: ['上次', '上回', '之前', '以前', '那天', '那次', '还记得', '记不记得', '说过', '提过', '答应', '约好', '那时候'],
    reminderTimeZone: 'Asia/Tokyo',
    dailyConsolidate: true, consolidateTimes: ['04:00', '16:00'], keepChatlogDays: 7, keepChatlogSet: false, mergeGroups: false, compress: true, compressAfterDays: 14, instantCommands: true, groupMemory: true, searchRrf: true, crossContext: true,
    profileFieldChars: 40, profilePeople: 2, profileChars: 240, chatImpression: true, selfStyle: true, chatImpressionChars: 120, dislikeSilence: 0.85,
    shortTerm: true, shortTermHours: 2, shortTermIdleMinutes: 3, shortTermChars: 150,
    gistEnabled: true, gistDays: 180, impressionDays: 365, gistDailyBatches: 6, tierDays: { 1: 7, 2: 30, 3: 90 },
    extractIdleMinutes: 30, extractMinLines: 20, extractDailyBatches: 24, capacity: { auto: 2000, event: 600, diary: 400 }, eventExpireDays: 90, vector: { enabled: false, baseUrl: '', model: '', apiKey: '' },
  }, // extractIdleMinutes 为 0 时关闭空闲提炼；手动记忆不受容量限制
  song: {
    enabled: false,
    root: '', // 翻唱环境目录，留空 = 自动（老安装 C:\Aurabot\rvc，新安装在用户目录下）
    voice: '', // 用哪个音色（models 目录里的 .pth 文件名），留空 = 第一个
    pitch: 0, // 默认变调（半音）；她点歌时会按原唱是男声还是女声自己定
    neteaseCookie: '', // 网易云 Cookie（MUSIC_U），下会员歌用
    separatorModel: 'model_bs_roformer_ep_317_sdr_12.9755.ckpt', // 人声分离模型
    maxVoiceSec: 120, // 语音条最长多少秒，歌更长就截一段
    clipStart: 'auto', // auto = 从副歌附近截；head = 从头截
    vocalVolume: 1,
    instVolume: 0.8,
    ownerOnly: true, // 只有主人能点歌
    keepWork: false, // 留着中间文件（调试用）
    pypiMirror: 'auto', // 安装时用的下载源：auto = 先测一下，官方源慢就用国内镜像；cn = 一直用国内镜像；off = 只用官方源
  },
  tabs: {}, // 面板记住的小偏好
  // 模块：内置的和数据目录 modules/ 里自己写的。{ 模块id: { enabled, useBuiltin } }，没写的算开着
  // useBuiltin：自己写了同名模块，但想先用回内置的
  modules: {},
  safeMode: false, // 安全模式：自己写的模块一个都不加载（排查问题用）
  ext: {}, // 自己写的模块的设置：{ 模块id: {...} }
  // 联动：让别的程序、DSH 里别的会话和插件也能用她
  bridge: {
    dshTools: false, // DSH 里别的会话（比如你平时写代码的会话）能用工具让她发 QQ、查记忆
    http: false, // 开放 HTTP 接口（要带密钥）
    token: '', // 第一次打开时自动生成
    allowTargets: 'whitelist', // 外部能发给谁：whitelist = 白名单里的人和群；owner = 只能发给主人
  },
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

function deepMerge(base, over) {
  if (!isObj(over)) return structuredClone(base)
  const out = structuredClone(base)
  for (const [k, v] of Object.entries(over)) {
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v)
    else if (v !== undefined) out[k] = v
  }
  return out
}

const BIG = 1e6 // 没有天然上限的数值：只防手滑填出离谱值，不当真限制
const num = (v, d, lo, hi) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
}
const bool = (v, d) => (typeof v === 'boolean' ? v : d)
const qq = (v) => String(v ?? '').replace(/\D/g, '')
const qqList = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\s,，;；]+/)).map(qq).filter(Boolean))]
const hhmm = (v, d) => (/^\d{1,2}:\d{2}$/.test(String(v)) ? String(v) : d)
// 严格校验 'YYYY-MM-DD'（面板手填/配置文件手改都可能乱），非法日期当没填。
const dateKey = (v) => {
  const s = String(v ?? '').trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return ''
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? s : ''
}
// 请求头：正常是字符串（一行一个）；手写成对象 / 数组时展开成同样的多行文本，
// 免得下游按行解析时认不出来，静默把头全丢掉。
const headerLines = (v) => {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map((x) => String(x ?? '')).join('\n')
  if (isObj(v)) return Object.entries(v).map(([k, x]) => `${k}: ${x ?? ''}`).join('\n')
  return v == null ? '' : String(v)
}
// 请求体：正常是字符串；手写成对象 / 数组时序列化回去（占位符 {text} / {reqid} 照样能替换）
const bodyText = (v) => {
  if (typeof v === 'string') return v
  if (isObj(v) || Array.isArray(v)) return JSON.stringify(v, null, 2)
  return v == null ? '' : String(v)
}

export function normalize(raw) {
  const c = deepMerge(DEFAULTS, raw)
  c.enabled = bool(c.enabled, false)
  c.dryRun = bool(c.dryRun, true)
  c.botQQ = qq(c.botQQ)
  c.ownerQQ = qq(c.ownerQQ)
  {
    const seen = new Set([c.ownerQQ, c.botQQ].filter(Boolean))
    c.coOwners = (Array.isArray(c.coOwners) ? c.coOwners : [])
      .map((o) => ({ qq: qq(o?.qq).slice(0, 12), name: String(o?.name ?? '').trim().slice(0, 20), ...(String(o?.role || '').trim() ? { role: String(o.role).trim().slice(0, 20) } : {}) }))
      .filter((o) => {
        // 号码空着也留下（面板里先写好称呼、等拿到号码再填）；重复的、和主人 / 机器人号相同的去掉
        if (!o.qq) return Boolean(o.name || o.role)
        if (o.qq.length < 5 || seen.has(o.qq)) return false
        seen.add(o.qq)
        return true
      })
      .slice(0, 4)
  }
  c.approvalNotify = bool(c.approvalNotify, true)
  c.ownerRole = String(c.ownerRole || '').trim().slice(0, 20)
  c.approvalViaQQ = bool(c.approvalViaQQ, true)
  c.qqApi.enabled = bool(c.qqApi.enabled, true)
  c.gateway = c.gateway === 'onebot' ? 'onebot' : 'snowluma'
  // 只认绝对路径（Windows 的 D:\\… 或 Linux 的 /…），别的当没填
  c.workspaceDir = String(c.workspaceDir || '').trim()
  if (c.workspaceDir && !/^([a-zA-Z]:[\\/]|\/)/.test(c.workspaceDir)) c.workspaceDir = ''
  // 视觉能力：auto = 问 DSH 的模型元数据；on / off = 主人手动声明（覆盖元数据）
  c.model.vision = c.model.vision === 'on' || c.model.vision === 'off' ? c.model.vision : 'auto'
  c.setupDone = bool(c.setupDone, false)
  c.ownerLevel = LEVELS.includes(c.ownerLevel) ? c.ownerLevel : 'full'
  c.longTasks = bool(c.longTasks, true)
  c.subagentBackground = bool(c.subagentBackground, false)
  c.chatModels = normalizeChatModels(c.chatModels)
  c.profilePerms = Object.fromEntries(PROFILE_PERM_KEYS.map((k) => [k, PROFILE_PERM_LEVELS.includes(c.profilePerms?.[k]) ? c.profilePerms[k] : profilePermDefault(k)]))
  // 旧版 douyinDm 是「回别人私信」的权限，含义已不同（现在是主动发私信），老配置一律回到默认「仅主人」
  if (isObj(raw?.profilePerms) && 'douyinDm' in raw.profilePerms) c.profilePerms.douyinDm = profilePermDefault('douyinDm')
  c.familyGroups = qqList(c.familyGroups).slice(0, 10)
  c.allow = { private: qqList(c.allow.private), groups: [...new Set([...qqList(c.allow.groups), ...c.familyGroups])] }
  // 乱码自愈：以前有过存成「�」的称呼 / 唤醒词（编码出错），留着她就叫不对、叫她名字也叫不醒
  if (/�/.test(String(c.ownerName || ''))) c.ownerName = DEFAULTS.ownerName
  // 发文件：开关、大小上限、额外允许的目录（只认绝对路径；空行忽略）
  if (!isObj(c.files)) c.files = {}
  if (!isObj(c.security)) c.security = {}
  c.security.dangerConfirm = bool(c.security.dangerConfirm, false)
  c.security.ssrfMode = c.security.ssrfMode === 'loose' ? 'loose' : 'strict'
  // 远端管理开关与可信反代：放 security 段（顶层对象，不会被下面「ext 只留对象」的规则删掉）
  c.security.panelRemoteAccess = bool(c.security.panelRemoteAccess, false)
  c.security.trustedProxy = String(c.security.trustedProxy || '').trim()
  c.security.publicHostname = String(c.security.publicHostname || '').trim().toLowerCase()
  // DeepSeek 峰谷省钱模式：默认关；节假日列表去重、只留合法的 'YYYY-MM-DD'（北京时间日期）
  if (!isObj(c.cost)) c.cost = {}
  c.cost.offPeak = bool(c.cost.offPeak, false)
  const rawHolidays = Array.isArray(c.cost.offPeakHolidays) ? c.cost.offPeakHolidays : String(c.cost.offPeakHolidays || '').split(/[\n,，;；\s]+/)
  c.cost.offPeakHolidays = [...new Set(rawHolidays.map(dateKey).filter(Boolean))].sort().slice(0, 60)
  c.update = { unstable: typeof c.update?.unstable === 'boolean' ? c.update.unstable : null }
  if (!isObj(c.contactWish)) c.contactWish = {}
  c.contactWish = { enabled: bool(c.contactWish.enabled, true), perDay: Math.round(num(c.contactWish.perDay, 3, 0, 20)) }
  if (!isObj(c.selfAllow)) c.selfAllow = {}
  c.selfAllow = { enabled: bool(c.selfAllow.enabled, false), observeHours: num(c.selfAllow.observeHours, 24, 1, 24 * 30) }
  if (!isObj(c.circle)) c.circle = {}
  {
    const ci = c.circle
    const min = Math.round(num(ci.min, 5, 0, 50))
    c.circle = {
      enabled: bool(ci.enabled, false),
      min,
      max: Math.max(min, Math.round(num(ci.max, 7, 0, 50))),
      autoAccept: bool(ci.autoAccept, true),
      minHits: Math.round(num(ci.minHits, 2, 1, 100)),
      groupCooldownDays: num(ci.groupCooldownDays, 7, 0, 365),
      reviewDays: num(ci.reviewDays, 3, 1, 365),
    }
  }
  c.files.enabled = bool(c.files.enabled, true)
  c.files.maxMB = num(c.files.maxMB, 50, 1, BIG)
  c.files.imageByPath = bool(c.files.imageByPath, true)
  c.files.dirs = (Array.isArray(c.files.dirs) ? c.files.dirs : String(c.files.dirs || '').split(/[\n,，;；]+/))
    .map((s) => String(s).trim()).filter((s) => /^([a-zA-Z]:[\\/]|\/)/.test(s)).slice(0, 20)
  const g = c.group
  g.wakeWords = (Array.isArray(g.wakeWords) ? g.wakeWords : String(g.wakeWords || '').split(/[\s,，]+/)).map((s) => String(s).trim()).filter(Boolean)
  {
    // 乱码的唤醒词丢掉；全丢光了就回到默认（大肥鱼 / 肥鱼）
    const hadAny = g.wakeWords.length > 0
    g.wakeWords = g.wakeWords.filter((w) => !/�/.test(w))
    if (hadAny && !g.wakeWords.length) g.wakeWords = [...DEFAULT_GROUP_POLICY.wakeWords]
  }
  g.interjectChance = num(g.interjectChance, 0.15, 0, 1)
  g.addressedOnly = bool(g.addressedOnly, false)
  g.cooldownSec = num(g.cooldownSec, 90, 0, BIG)
  g.maxPerHour = num(g.maxPerHour, 6, 0, BIG)
  g.minRecentMessages = num(g.minRecentMessages, 3, 0, BIG)
  g.activeWindowSec = num(g.activeWindowSec, 300, 1, BIG)
  if (!Array.isArray(g.quietHours) || g.quietHours.length !== 2) g.quietHours = DEFAULT_GROUP_POLICY.quietHours
  g.quietHours = g.quietHours.map((h) => num(h, 0, 0, 23))
  if (!isObj(g.overrides)) g.overrides = {}
  if (!isObj(g.ownerBrief)) g.ownerBrief = { enabled: false, lines: 12, groups: [] }
  g.ownerBrief.enabled = bool(g.ownerBrief.enabled, false)
  g.ownerBrief.lines = num(g.ownerBrief.lines, 12, 1, BIG)
  g.ownerBrief.groups = qqList(g.ownerBrief.groups)
  c.voice.autoChance = num(c.voice.autoChance, 0.15, 0, 1)
  c.voice.autoMaxChars = num(c.voice.autoMaxChars, 80, 1, BIG)
  c.voice.emojiSeparate = c.voice.emojiSeparate !== false
  c.voice.leadingSilenceMs = Math.round(num(c.voice.leadingSilenceMs, 500, 0, 2000))
  c.voice.minCharsPerSec = num(c.voice.minCharsPerSec, 4.4, 0, 8)
  c.voice.maxSpeedup = Math.round(num(c.voice.maxSpeedup, 1.1, 1, 1.35) * 100) / 100
  // 通用 HTTP 引擎（接火山 / 阿里 / 讯飞这类云 TTS）：method 只认 GET / POST，其余当 GET；
  // 地址、请求头、请求体一律转成字符串——手改 config.json 写成对象、数组或数字时，也按原意
  // 拼得出去，不会变成 "[object Object]" 或者带着填错的空格。
  if (!isObj(c.voice.http)) c.voice.http = structuredClone(DEFAULTS.voice.http)
  c.voice.http.urlTemplate = String(c.voice.http.urlTemplate ?? '').trim()
  c.voice.http.method = String(c.voice.http.method ?? '').trim().toUpperCase() === 'POST' ? 'POST' : 'GET'
  c.voice.http.headers = headerLines(c.voice.http.headers)
  c.voice.http.body = bodyText(c.voice.http.body)
  c.voice.http.sampleRate = num(c.voice.http.sampleRate, 24000, 8000, 48000)
  c.stickers.autoChance = num(c.stickers.autoChance, 0.35, 0, 1)
  c.stickers.faces = c.stickers.faces !== false
  c.stickers.collectMode = ['ask', 'auto', 'owner'].includes(c.stickers.collectMode) ? c.stickers.collectMode : 'auto'
  c.stickers.maxPerHour = num(c.stickers.maxPerHour, 20, 0, BIG)
  c.stickers.maxLibrary = num(c.stickers.maxLibrary, 300, 1, BIG)
  c.stickers.externalCollectMinMinutes = num(c.stickers.externalCollectMinMinutes, 30, 0, 24 * 60)
  c.stickers.externalCollectMaxPerDay = Math.round(num(c.stickers.externalCollectMaxPerDay, 8, 0, 100))
  c.stickers.captionMaxPerHour = Math.round(num(c.stickers.captionMaxPerHour, 4, 0, 100))
  c.stickers.captionMaxPerDay = Math.round(num(c.stickers.captionMaxPerDay, 16, 0, 1000))
  c.stickers.captionQueueLimit = Math.round(num(c.stickers.captionQueueLimit, 8, 1, 100))
  c.stickers.captionPreferSummary = bool(c.stickers.captionPreferSummary, true)
  c.stickers.captionMaxTokens = Math.round(num(c.stickers.captionMaxTokens, 400, 100, 2000))
  // 起名单独挑的模型：两半都填了才认；填一半 / 脏数据都当没填（回落到聊天模型）
  c.stickers.captionModel = (() => {
    const m = isObj(c.stickers.captionModel) ? c.stickers.captionModel : {}
    const provider = String(m.provider || '').trim()
    const model = String(m.model || '').trim()
    return provider && model ? { provider, model } : { provider: '', model: '' }
  })()
  c.diary.timesPerDay = num(c.diary.timesPerDay, 2, 0, 48)
  c.diary.windowStart = hhmm(c.diary.windowStart, '10:00')
  c.diary.windowEnd = hhmm(c.diary.windowEnd, '23:30')
  c.diary.minGapMinutes = num(c.diary.minGapMinutes, 180, 0, BIG)
  c.diary.attachImage = bool(c.diary.attachImage, true)
  if (!isObj(c.diary.rich)) c.diary.rich = { ...DEFAULTS.diary.rich }
  for (const key of ['enabled', 'stickers', 'browsing', 'local']) c.diary.rich[key] = bool(c.diary.rich[key], DEFAULTS.diary.rich[key])
  c.diary.rich.folder = typeof c.diary.rich.folder === 'string' ? c.diary.rich.folder.trim() : ''
  if (c.diary.rich.folder && !/^([a-zA-Z]:[\\/]|\/)/.test(c.diary.rich.folder)) c.diary.rich.folder = ''
  delete c.diary.rich.cards
  c.diary.rich.maxImages = Math.round(num(c.diary.rich.maxImages, 2, 1, 9))
  if (!isObj(c.diary.archive)) c.diary.archive = { ...DEFAULTS.diary.archive }
  c.diary.archive.enabled = bool(c.diary.archive.enabled, false)
  c.diary.archive.folder = typeof c.diary.archive.folder === 'string' ? c.diary.archive.folder.trim() : ''
  if (c.diary.archive.folder && !/^([a-zA-Z]:[\\/]|\/)/.test(c.diary.archive.folder)) c.diary.archive.folder = ''
  c.diary.minChars = num(c.diary.minChars, 60, 1, BIG)
  c.diary.maxChars = num(c.diary.maxChars, 140, 1, BIG)
  c.diary.visibility = DIARY_AUDIENCES.includes(c.diary.visibility) ? c.diary.visibility : 'all'
  c.diary.audienceQQs = qqList(c.diary.audienceQQs).slice(0, 200).join('\n')
  c.speakUp.idleMinutes = num(c.speakUp.idleMinutes, 40, 1, BIG)
  c.speakUp.nudge = bool(c.speakUp.nudge, true)
  c.speakUp.minIntervalMinutes = num(c.speakUp.minIntervalMinutes, 90, 1, BIG)
  c.speakUp.maxIntervalMinutes = Math.max(c.speakUp.minIntervalMinutes, num(c.speakUp.maxIntervalMinutes, 240, 1, BIG))
  // 留空就是 20，上限不封顶
  c.speakUp.maxPerDay = c.speakUp.maxPerDay === '' || c.speakUp.maxPerDay == null ? 20 : num(c.speakUp.maxPerDay, 20, 0, BIG)
  if (!isObj(c.speakUp.family)) c.speakUp.family = {}
  c.speakUp.family = { enabled: bool(c.speakUp.family.enabled, true), idleMinutes: num(c.speakUp.family.idleMinutes, 75, 20, 24 * 60), maxPerDay: Math.round(num(c.speakUp.family.maxPerDay, 5, 0, 20)) }
  c.speakUp.allow = [...new Set((Array.isArray(c.speakUp.allow) ? c.speakUp.allow : []).map((q) => String(q).trim()).filter((q) => /^\d{5,}$/.test(q)))]
  const q = c.qzoneSocial
  q.enabled = bool(q.enabled, true)
  q.replyOwn = bool(q.replyOwn, true)
  q.commentFriends = bool(q.commentFriends, true)
  q.like = bool(q.like, true)
  q.friendChance = num(q.friendChance, 0.3, 0, 1)
  q.ownerChance = num(q.ownerChance, 0.7, 0, 1)
  q.maxPerDay = num(q.maxPerDay, 8, 0, BIG)
  q.intervalMin = num(q.intervalMin, 30, 1, BIG)
  c.mood.halfLifeHours = num(c.mood.halfLifeHours, 3, 0.1, BIG)
  c.mood.base = num(c.mood.base, 60, 0, 100)
  c.mood.judge = bool(c.mood.judge, false)
  for (const k of ['tts', 'image', 'song', 'asr', 'video']) c.local[k] = bool(c.local[k], false)
  c.local.videoTimeoutMin = num(c.local.videoTimeoutMin, 20, 1, BIG)
  const b = c.bili
  Object.assign(b, splitBiliCookie(b))
  for (const k of ['enabled', 'autoBrowse', 'comment', 'reply', 'shareToOwner', 'like', 'vision', 'danmakuEnabled', 'autoDanmaku']) b[k] = bool(b[k], DEFAULTS.bili[k])
  b.visionFrames = Math.round(num(b.visionFrames, 6, 1, 100))
  b.ffmpegPath = String(b.ffmpegPath || '').trim()
  b.shotChance = num(b.shotChance, 0.35, 0, 1)
  b.shotLibrary = Math.round(num(b.shotLibrary, 300, 1, BIG))
  b.intervalHours = num(b.intervalHours, 4, 0.1, BIG)
  b.maxRunsPerDay = num(b.maxRunsPerDay, 3, 0, BIG)
  b.perRun = num(b.perRun, 3, 1, BIG)
  b.minViews = num(b.minViews, 5000, 0, BIG * 1e6)
  b.maxAgeDays = num(b.maxAgeDays, 60, 0, BIG)
  b.maxCommentsPerDay = num(b.maxCommentsPerDay, 3, 0, BIG)
  b.maxRepliesPerDay = num(b.maxRepliesPerDay, 6, 0, BIG)
  b.maxDanmakuPerDay = Math.round(num(b.maxDanmakuPerDay, 3, 1, 20))
  b.keywords = (Array.isArray(b.keywords) ? b.keywords : String(b.keywords || '').split(/[\n,，]+/)).map((x) => String(x).trim()).filter(Boolean).slice(0, 30)
  const hb = c.heybox
  hb.shareToOwner = bool(hb.shareToOwner, true)
  hb.shareBias = ['stingy', 'normal', 'proactive'].includes(hb.shareBias) ? hb.shareBias : 'normal'
  hb.shareDaily = Math.round(num(hb.shareDaily, 3, 0, BIG))
  hb.cookie = String(hb.cookie || '').trim()
  hb.topicMode = hb.topicMode === 'auto' ? 'auto' : 'manual'
  hb.postWordsMin = Math.round(num(hb.postWordsMin, 0, 0, 2000))
  hb.postWordsMax = Math.round(num(hb.postWordsMax, 0, 0, 3000))
  if (hb.postWordsMax && hb.postWordsMin && hb.postWordsMax < hb.postWordsMin) [hb.postWordsMin, hb.postWordsMax] = [hb.postWordsMax, hb.postWordsMin]
  // 每天每篇的排期：最多 5 篇；hashtags 和 hashtagsText 都保留（面板靠 Text 回显，模块靠数组发帖）
  hb.dailyPosts = Array.isArray(hb.dailyPosts) ? hb.dailyPosts.slice(0, 5).map((p) => {
    const o = p && typeof p === 'object' ? p : {}
    const splitH = (v) => String(v ?? '').split(/[\s,，、]+/).map((x) => String(x).trim()).filter(Boolean)
    const hash = (Array.isArray(o.hashtags) ? o.hashtags : splitH(o.hashtagsText)).map((x) => String(x).trim()).filter(Boolean).slice(0, 4)
    return {
      style: ['diary', 'news', 'mix', 'deal'].includes(o.style) ? o.style : '',
      topic: /^\d{3,7}$/.test(String(o.topic ?? '')) ? String(o.topic) : '',
      hashtags: hash,
      hashtagsText: hash.join(','),
      wordsMin: Math.round(num(o.wordsMin, 0, 0, 2000)),
      wordsMax: Math.round(num(o.wordsMax, 0, 0, 3000)),
      hint: String(o.hint || '').trim().slice(0, 120),
    }
  }) : []   // ⚠ 不能在这里过滤全空项：排期是按下标取的（module 侧 currentPostPlan 用 postsToday() 索引），
             //    过滤掉「第 1 篇留空跟全局、第 2 篇单独配」里的空项，会让第 2 篇的配置被当成第 1 篇用。
             //    空项就代表「这一篇走全局设置」，原样保留位置。
  hb.offPeakOnly = bool(hb.offPeakOnly, false)
  hb.peakStartAM = num(hb.peakStartAM, 9, 0, 23)
  hb.peakEndAM = num(hb.peakEndAM, 12, 0, 24)
  hb.peakStartPM = num(hb.peakStartPM, 14, 0, 23)
  hb.peakEndPM = num(hb.peakEndPM, 18, 0, 24)
  hb.peakWeekend = bool(hb.peakWeekend, false)
  const d = c.douyin
  d.enabled = bool(d.enabled, false)
  d.autoBrowse = bool(d.autoBrowse, true)
  d.intervalHours = num(d.intervalHours, 4, 0.1, BIG)
  d.maxRunsPerDay = num(d.maxRunsPerDay, 3, 0, BIG)
  d.perRun = num(d.perRun, 5, 1, BIG)
  d.maxWatchPerDay = num(d.maxWatchPerDay, 30, 0, BIG)
  d.dwellMin = num(d.dwellMin, 8, 1, BIG)
  d.dwellMax = Math.max(d.dwellMin, num(d.dwellMax, 40, 1, BIG))
  d.browserPath = String(d.browserPath || '').trim()
  d.shareTo = ['douyin', 'qq', 'both'].includes(d.shareTo) ? d.shareTo : 'douyin'
  d.ownerDm = bool(d.ownerDm, true)
  d.dmPollMinutes = num(d.dmPollMinutes, 3, 1, BIG)
  d.shareBias = ['stingy', 'normal', 'proactive'].includes(d.shareBias) ? d.shareBias : d.shareBias === 'off' ? 'stingy' : 'proactive'
  if (!isObj(d.caps)) d.caps = {}
  if (raw?.douyin?.caps?.share == null && raw?.douyin?.caps?.shareOwner != null) d.caps.share = raw.douyin.caps.shareOwner // 1.0.x 叫 shareOwner
  d.caps = { like: num(d.caps.like, 30, 0, BIG), comment: num(d.caps.comment, 3, 0, BIG), share: num(d.caps.share, 5, 0, BIG), atOwner: num(d.caps.atOwner, 3, 0, 30) }
  if (!isObj(d.owner)) d.owner = {}
  d.owner = Object.fromEntries(['input', 'secUid', 'uid', 'nickname', 'confirmedInput'].map((k) => [k, String(d.owner[k] ?? '').trim().slice(0, 400)]))
  if (!isObj(d.gate)) d.gate = {}
  d.gate = { maxWritesPerDay: num(d.gate.maxWritesPerDay, 40, 1, BIG), minWriteGapSec: num(d.gate.minWriteGapSec, 20, 0, BIG), newAccountDays: num(d.gate.newAccountDays, 3, 0, 30) }
  // 1.0.x 的 douyin-im / 私信相关设置都不用了
  for (const k of ['atOwnerOnLikeChance', 'minimize', 'socialInterruptBrowse', 'replyPollMinutes']) delete d[k]

  delete c.mood.maxInjectPerDay // 旧版的「每天最多提醒几次」，现在心情明显时每轮都会带上
  c.snowluma.webuiPort = num(c.snowluma.webuiPort, 5099, 1, 65535)
  // 老配置只有一个 consolidateAt：换成两个时间点（它 + 12 小时后）
  if (!Array.isArray(raw?.memory?.consolidateTimes) && raw?.memory?.consolidateAt) {
    const [hh, mm] = hhmm(raw.memory.consolidateAt, '04:00').split(':').map(Number)
    c.memory.consolidateTimes = [`${hh}:${String(mm).padStart(2, '0')}`, `${(hh + 12) % 24}:${String(mm).padStart(2, '0')}`]
  }
  delete c.memory.consolidateAt
  c.memory.consolidateTimes = [...new Set((Array.isArray(c.memory.consolidateTimes) ? c.memory.consolidateTimes : String(c.memory.consolidateTimes || '').split(/[\s,，]+/)).map((t) => hhmm(t, '')).filter(Boolean).map((t) => t.padStart(5, '0')))].sort().slice(0, 4)
  if (!c.memory.consolidateTimes.length) c.memory.consolidateTimes = ['04:00', '16:00']
  c.chat = c.chat || {}
  c.chat.seedHistory = bool(c.chat.seedHistory, false)
  c.chat.stableContext = bool(c.chat.stableContext, true)
  // 连发几条时中间按打字速度停一下；关掉就写好了连着发（家里人觉得这样更跟得上）
  c.chat.typingDelay = bool(c.chat.typingDelay, true)
  c.chat.seedHistoryCount = num(c.chat.seedHistoryCount, 20, 1, BIG)
  c.memory.recallCount = num(c.memory.recallCount, 6, 0, BIG)
  c.memory.recallMode = c.memory.recallMode === 'trigger' ? 'trigger' : 'always'
  c.memory.recallTriggers = [...new Set((Array.isArray(c.memory.recallTriggers) ? c.memory.recallTriggers : String(c.memory.recallTriggers || '').split(/[\n,，;；]+/)).filter((x) => typeof x === 'string').map((x) => x.trim().slice(0, 40)).filter(Boolean))].slice(0, 100)
  for (const k of ['chatImpression', 'gistEnabled', 'shortTerm']) c.memory[k] = bool(c.memory[k], true)
  c.memory.dislikeSilence = num(c.memory.dislikeSilence, 0.85, 0, 1)
  c.memory.shortTermHours = num(c.memory.shortTermHours, 2, 0.1, BIG)
  c.memory.shortTermIdleMinutes = num(c.memory.shortTermIdleMinutes, 3, 0, BIG)
  c.memory.shortTermChars = Math.round(num(c.memory.shortTermChars, 150, 1, BIG))
  for (const k of ['profileFieldChars', 'profilePeople', 'profileChars', 'chatImpressionChars', 'gistDays', 'impressionDays', 'gistDailyBatches']) c.memory[k] = Math.round(num(c.memory[k], DEFAULTS.memory[k], 0, BIG))
  if (!isObj(c.memory.tierDays)) c.memory.tierDays = {}
  for (const k of ['1', '2', '3']) c.memory.tierDays[k] = Math.round(num(c.memory.tierDays[k], DEFAULTS.memory.tierDays[k], 0, BIG))
  // 老版本的 0 是当时的默认值，不是谁选的：升级后改成留 7 天，以后面板里再选 0 才算数
  const keepUnset = raw?.memory?.keepChatlogDays === 0 && !raw.memory.keepChatlogSet
  c.memory.keepChatlogDays = keepUnset ? 7 : num(c.memory.keepChatlogDays, 7, -1, 3650)
  c.memory.keepChatlogSet = true
  c.memory.mergeGroups = bool(c.memory.mergeGroups, false)
  for (const k of ['instantCommands', 'groupMemory', 'searchRrf']) c.memory[k] = bool(c.memory[k], true)
  c.memory.crossContext = bool(c.memory.crossContext, true)
  try { new Intl.DateTimeFormat('en', { timeZone: c.memory.reminderTimeZone }).format(0) }
  catch { c.memory.reminderTimeZone = 'Asia/Tokyo' }
  c.memory.extractIdleMinutes = num(c.memory.extractIdleMinutes, 30, 0, BIG)
  c.memory.extractMinLines = Math.round(num(c.memory.extractMinLines, 20, 1, BIG))
  c.memory.extractDailyBatches = Math.round(num(c.memory.extractDailyBatches, 24, 0, BIG))
  for (const [key, fallback] of Object.entries({ familyExtractDailyBatches: 24, familyGistDailyBatches: 8, familyBackfillDailyBatches: 24 })) c.memory[key] = Math.round(num(c.memory[key], fallback, 0, BIG))
  if (!isObj(c.memory.capacity)) c.memory.capacity = {}
  for (const k of ['auto', 'event', 'diary']) c.memory.capacity[k] = Math.round(num(c.memory.capacity[k], DEFAULTS.memory.capacity[k], 0, BIG))
  c.memory.eventExpireDays = num(c.memory.eventExpireDays, 90, -1, BIG)
  // 记忆压缩：具体的事慢慢淡忘、概括成长期印象（默认开；可以关；多少天以前的细节才参与概括）
  c.memory.compress = bool(c.memory.compress, true)
  c.memory.compressAfterDays = Math.round(num(c.memory.compressAfterDays, 14, 1, 365))
  if (!isObj(c.memory.vector)) c.memory.vector = { ...DEFAULTS.memory.vector }
  c.memory.vector.enabled = bool(c.memory.vector.enabled, false)
  for (const k of ['baseUrl', 'model', 'apiKey']) c.memory.vector[k] = String(c.memory.vector[k] || '').trim()
  g.interests = (Array.isArray(g.interests) ? g.interests : String(g.interests || '').split(/[\s,，]+/)).map((s) => String(s).trim()).filter(Boolean)
  g.minRelevance = num(g.minRelevance, 0.25, 0, 1)
  // @ 了别人时不算叫她（只挡必回，仍然可以插话）；默认关，保持原行为
  g.ignoreAtOthers = bool(g.ignoreAtOthers, false)
  // 看白名单里别的群：off 关 / private 主人和私聊里的群成员（默认）/ group 群里的成员也行
  g.crossRead = ['off', 'group'].includes(g.crossRead) ? g.crossRead : 'private'
  c.merge.enabled = bool(c.merge.enabled, true)
  c.merge.waitSec = num(c.merge.waitSec, 5, 0, BIG)
  c.merge.maxSec = Math.max(c.merge.waitSec, num(c.merge.maxSec, 8, 0, BIG))
  c.merge.groupWaitSec = num(c.merge.groupWaitSec, 5, 0, BIG)
  c.merge.groupMaxSec = Math.max(c.merge.groupWaitSec, num(c.merge.groupMaxSec, 15, 0, BIG))
  c.titleFilter.enabled = bool(c.titleFilter.enabled, true)
  c.titleFilter.groups = qqList(c.titleFilter.groups) // 和群白名单同一套规则
  c.titleFilter.title = String(c.titleFilter.title ?? '').replace(/[​-‍﻿]/g, '').trim().slice(0, 30) || '大肥鱼'
  g.burstMax = num(g.burstMax, 8, 1, BIG)
  g.engagedMax = num(g.engagedMax, 6, 0, BIG)
  g.burstWindowSec = num(g.burstWindowSec, 120, 1, BIG)
  if (!['auto', 'edge', 'windows', 'cosyvoice', 'gptsovits', 'http', 'breeze', 'minimax', 'doubao'].includes(c.voice.engine)) c.voice.engine = 'auto'
  if (!['text', 'edge'].includes(c.voice.breezeFallback)) c.voice.breezeFallback = 'text'
  if (!isObj(c.voice.breeze)) c.voice.breeze = structuredClone(DEFAULTS.voice.breeze)
  {
    const b = c.voice.breeze
    c.voice.breeze = {
      apiKey: String(b.apiKey ?? '').trim(),
      voiceId: String(b.voiceId ?? '').trim().slice(0, 80),
      model: String(b.model ?? '').trim().slice(0, 120),
      language: /^[a-z]{2}$/i.test(String(b.language || '')) ? String(b.language).toLowerCase() : 'zh',
      instructions: String(b.instructions ?? '').slice(0, 1000),
      speed: num(b.speed, 1, 0.5, 2),
      guidance: num(b.guidance, 1, 1, 10),
    }
  }
  if (!isObj(c.voice.doubao)) c.voice.doubao = structuredClone(DEFAULTS.voice.doubao)
  {
    const d = c.voice.doubao
    const id = (v, n) => String(v ?? '').trim().slice(0, n)
    c.voice.doubao = {
      apiKey: id(d.apiKey, 400), appId: id(d.appId, 80), accessToken: id(d.accessToken, 400),
      speaker: id(d.speaker, 256), clonedSpeaker: id(d.clonedSpeaker, 256),
      resourceId: ['auto', ...DOUBAO_RESOURCES].includes(d.resourceId) ? d.resourceId : 'auto',
      cloneModel: DOUBAO_CLONE_MODELS.includes(d.cloneModel) ? d.cloneModel : 'seed-tts-2.0-expressive',
      speechRate: Math.round(num(d.speechRate, 0, -50, 100)), loudnessRate: Math.round(num(d.loudnessRate, 0, -50, 100)),
      toneMode: ['context', 'off'].includes(d.toneMode) ? d.toneMode : 'context',
    }
  }
  if (!isObj(c.voice.minimax)) c.voice.minimax = structuredClone(DEFAULTS.voice.minimax)
  {
    const m = c.voice.minimax
    c.voice.minimax = {
      apiKey: String(m.apiKey ?? '').trim(),
      region: ['cn', 'intl'].includes(m.region) ? m.region : 'cn',
      baseUrl: /^https:\/\/[\w.-]+(:\d+)?(\/[\w./-]*)?$/.test(String(m.baseUrl || '').trim()) ? String(m.baseUrl).trim().replace(/\/+$/, '') : '',
      model: MINIMAX_MODELS.includes(m.model) ? m.model : 'speech-2.8-hd',
      voiceId: String(m.voiceId ?? '').trim().slice(0, 256),
      speed: num(m.speed, 1, 0.5, 2),
      vol: num(m.vol, 1, 0.1, 10),
      pitch: Math.max(-12, Math.min(12, Math.round(Number(m.pitch) || 0))),
      languageBoost: ['Chinese', 'auto', ''].includes(m.languageBoost) ? m.languageBoost : 'Chinese',
      emotion: ['tone', 'model'].includes(m.emotion) ? m.emotion : 'tone',
    }
  }
  c.voice.songVoice = String(c.voice.songVoice || '').slice(0, 120)
  c.voice.songPitch = Math.max(-24, Math.min(24, Math.round(Number(c.voice.songPitch) || 0)))
  c.voice.cosyvoice.sampleRate = num(c.voice.cosyvoice.sampleRate, 22050, 8000, 48000)
  if (!['sft', 'instruct'].includes(c.voice.cosyvoice.mode)) c.voice.cosyvoice.mode = 'sft'
  // edge-tts 的语速 / 音调：只认 ±N% 和 ±NHz，写着玩的回落默认值，超范围的夹回来。
  // ⚠ 0 也必须带符号：面板的选项是 '+0%' / '+0Hz'，少了正号既对不上下拉框，
  //   又会让 `rate !== '+0%'` 成立、把 --rate=0% 传给 edge-tts（它会直接报错）。
  const signed = (n, unit) => (n < 0 ? '-' : '+') + Math.abs(n) + unit
  const pct = /^([+-]?\d{1,3})\s*%$/.exec(String(c.voice.rate || '').trim())
  c.voice.rate = signed(pct ? Math.max(-50, Math.min(50, Number(pct[1]))) : 0, '%')
  const hz = /^([+-]?\d{1,3})\s*Hz$/i.exec(String(c.voice.pitch || '').trim())
  c.voice.pitch = signed(hz ? Math.max(-80, Math.min(80, Number(hz[1]))) : 0, 'Hz')
  c.imageGen.enabled = bool(c.imageGen.enabled, false)
  c.imageGen.ownerOnly = bool(c.imageGen.ownerOnly, true)
  c.imageGen.seeOwn = bool(c.imageGen.seeOwn, true)
  c.imageGen.img2img = bool(c.imageGen.img2img, true)
  if (!/^\d{3,4}x\d{3,4}$/.test(String(c.imageGen.size))) c.imageGen.size = '1024x1024'
  c.imageGen.galleryShown = Math.min(50, Math.max(1, Math.round(Number(c.imageGen.galleryShown) || 20)))
  c.imageGen.shape = ['her', 'square', 'portrait', 'landscape', 'wide'].includes(c.imageGen.shape) ? c.imageGen.shape : 'her'

  // provider：custom = 自己填接口（GET/POST + 自定义参数），其它按 OpenAI 兼容
  c.imageGen.provider = ['custom', 'codex'].includes(c.imageGen.provider) ? c.imageGen.provider : 'openai'
  if (!isObj(c.imageGen.codex)) c.imageGen.codex = { ...DEFAULTS.imageGen.codex }
  const igx = c.imageGen.codex
  igx.model = ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'].includes(igx.model) ? igx.model : 'gpt-image-2'
  igx.quality = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(igx.quality) ? igx.quality : 'auto'
  igx.background = ['auto', 'transparent', 'opaque'].includes(igx.background) ? igx.background : 'auto'
  if (!c.imageGen.custom || typeof c.imageGen.custom !== 'object') c.imageGen.custom = { ...DEFAULTS.imageGen.custom }
  const igc = c.imageGen.custom
  igc.method = String(igc.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET'
  igc.bodyType = igc.bodyType === 'form' ? 'form' : 'json'
  igc.url = String(igc.url || '').trim().slice(0, 2000)
  igc.responsePath = String(igc.responsePath || '').trim().slice(0, 200)
  igc.params = (Array.isArray(igc.params) ? igc.params : [])
    .map((p) => ({ key: String((p && p.key) || '').trim().slice(0, 60), value: String(p && p.value != null ? p.value : '').slice(0, 500) }))
    .filter((p) => p.key)
    .slice(0, 30)

  c.song.enabled = bool(c.song.enabled, false)
  c.song.ownerOnly = bool(c.song.ownerOnly, true)
  c.song.pitch = num(c.song.pitch, 0, -24, 24)
  c.song.maxVoiceSec = num(c.song.maxVoiceSec, 120, 1, BIG)
  c.song.vocalVolume = num(c.song.vocalVolume, 1, 0, 10)
  c.song.instVolume = num(c.song.instVolume, 0.8, 0, 10)
  if (!['auto', 'head'].includes(c.song.clipStart)) c.song.clipStart = 'auto'
  // 老配置：'' 是以前的默认（没开），改成自动；tuna 是以前的「用镜像」
  c.song.pypiMirror = { '': 'auto', tuna: 'cn' }[c.song.pypiMirror] ?? c.song.pypiMirror
  if (!['auto', 'cn', 'off'].includes(c.song.pypiMirror)) c.song.pypiMirror = 'auto'
  c.song.root = String(c.song.root || '').trim()
  if (!isObj(c.modules)) c.modules = {}
  for (const [id, m] of Object.entries(c.modules)) {
    if (!isObj(m)) { delete c.modules[id]; continue }
    m.enabled = bool(m.enabled, true)
    m.useBuiltin = bool(m.useBuiltin, false)
  }
  if (!isObj(c.ext)) c.ext = {}
  for (const k of Object.keys(c.ext)) if (!isObj(c.ext[k])) delete c.ext[k] // 传 null = 删掉这个模块的设置
  c.safeMode = bool(c.safeMode, false)
  c.bridge.dshTools = bool(c.bridge.dshTools, false)
  c.bridge.http = bool(c.bridge.http, false)
  c.bridge.token = String(c.bridge.token || '')
  if (!['whitelist', 'owner'].includes(c.bridge.allowTargets)) c.bridge.allowTargets = 'whitelist'
  return c
}

// 面板里不回传原文的字段：路径（几层都行）
const SECRETS = [['voice', 'breeze', 'apiKey'], ['voice', 'minimax', 'apiKey'], ['voice', 'doubao', 'apiKey'], ['voice', 'doubao', 'accessToken'], ['snowluma', 'webuiPassword'], ['snowluma', 'httpToken'], ['snowluma', 'wsToken'], ['imageGen', 'apiKey'], ['memory', 'vector', 'apiKey'], ['song', 'neteaseCookie'], ['bili', 'cookie'], ['bili', 'sessdata'], ['bili', 'biliJct'], ['heybox', 'cookie'], ['bridge', 'token']]
// 扩展模块设置里的密码类字段（模块加载时登记）：['ext', 模块id, 字段]
const extraSecrets = new Map()
export function registerSecretField(path) { extraSecrets.set(path.join('\u0000'), path) }
const allSecrets = () => [...SECRETS, ...extraSecrets.values()]
const parentOf = (obj, path, create) => {
  let cur = obj
  for (const k of path.slice(0, -1)) {
    if (!isObj(cur[k])) { if (!create) return null; cur[k] = {} }
    cur = cur[k]
  }
  return cur
}
const getAt = (obj, path) => { const p = parentOf(obj, path, false); return p ? p[path.at(-1)] : undefined }
// 这些密钥在面板里显示结尾几位（「已保存（结尾 …a1b2）」），方便认出存的是哪一份；完整值不回传
const HINTED = [['bili', 'sessdata'], ['bili', 'biliJct']]

/** 从一串 Cookie 里取某个值（「SESSDATA=xxx; bili_jct=yyy」）。 */
export function cookieValue(raw, key) {
  for (const part of String(raw || '').split(/;\s*/)) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === key) return part.slice(i + 1).trim()
  }
  return ''
}

/**
 * B 站 Cookie 整理成两个值：粘了整串 / 带了「SESSDATA=」前缀的都认得；老配置只有整串的拆开。
 * 返回 {sessdata, biliJct, cookie}，cookie 是拼好给接口用的。
 */
export function splitBiliCookie({ sessdata = '', biliJct = '', cookie = '' } = {}) {
  const a = String(sessdata || '').trim()
  const b = String(biliJct || '').trim()
  // 框里粘的是「xxx=…」这种整串或带前缀的：从里面取；纯值原样用
  const isRaw = (v) => /(^|;\s*)(SESSDATA|bili_jct)=/.test(v)
  let s = isRaw(a) ? '' : a
  let j = isRaw(b) ? '' : b
  for (const v of [a, b]) {
    if (!isRaw(v)) continue
    s = cookieValue(v, 'SESSDATA') || s
    j = cookieValue(v, 'bili_jct') || j
  }
  if (!s && !j && cookie) {
    s = cookieValue(cookie, 'SESSDATA')
    j = cookieValue(cookie, 'bili_jct')
  }
  return { sessdata: s, biliJct: j, cookie: [s && `SESSDATA=${s}`, j && `bili_jct=${j}`].filter(Boolean).join('; ') }
}

const FILE = () => dataDir('config.json')

/** 在某次更新里新增、会替她公开发东西的功能。以后再加这类功能，把配置键名加到这里。 */
export const OPT_IN_ON_UPDATE = ['qzoneSocial', 'bili', 'douyin']

export function loadConfig() {
  const raw = readJson(FILE(), {})
  // 老配置（向导上线前就填好了两个号）直接算向导已完成
  if (raw && raw.setupDone === undefined && raw.botQQ && raw.ownerQQ) raw.setupDone = true
  // 更新插件后新增的、会公开发东西的功能：老用户先关着，等他们自己在面板里打开（新安装照常默认开）
  if (raw && raw.setupDone) for (const k of OPT_IN_ON_UPDATE) if (raw[k] === undefined) raw[k] = { enabled: false }
  return normalize(raw)
}

export function saveConfig(cfg) {
  const c = normalize(cfg)
  writeJson(FILE(), c)
  return c
}

/** 给面板看的版本：密码 / token 不回传原文，只告诉有没有填。 */
export function publicConfig(cfg) {
  const c = structuredClone(cfg)
  for (const [g, k] of HINTED) c[g][`${k}Hint`] = c[g][k] ? '…' + String(c[g][k]).slice(-4) : ''
  for (const path of allSecrets()) {
    const p = parentOf(c, path, false)
    if (!p) continue
    const k = path.at(-1)
    p[`${k}Set`] = Boolean(p[k])
    p[k] = ''
  }
  return c
}

/** 面板保存时：没改的密码字段（空串）保留原值。 */
export function mergeFromPanel(current, incoming) {
  const next = deepMerge(current, incoming || {})
  for (const path of allSecrets()) {
    const v = getAt(incoming || {}, path)
    const p = parentOf(next, path, v !== undefined)
    if (!p) continue
    const k = path.at(-1)
    if (v === null) p[k] = '' // 明确传 null = 清空
    else if (v === undefined || v === '') p[k] = getAt(current, path) ?? ''
    delete p[`${k}Set`]
    delete p[`${k}Hint`]
  }
  // 主人的抖音 secUid / uid / 昵称只能由「核对」写入，面板存配置时保留原值
  next.douyin.owner = { ...next.douyin.owner, ...Object.fromEntries(['secUid', 'uid', 'nickname', 'confirmedInput'].map((k) => [k, current.douyin?.owner?.[k] ?? ''])) }
  // 联动密钥只由插件生成，面板不能改
  next.bridge.token = current.bridge?.token || ''
  // B 站：只改了其中一个值时，另一个保留；整串粘进来的会在 normalize 里拆开
  if (incoming?.bili && (incoming.bili.sessdata || incoming.bili.biliJct)) next.bili.cookie = ''
  if (incoming?.group?.overrides) next.group.overrides = incoming.group.overrides
  // 按聊天选模型：两张表整张替换（deepMerge 会让删掉的条目又回来）
  if (incoming?.chatModels?.privates) next.chatModels.privates = incoming.chatModels.privates
  if (incoming?.chatModels?.groups) next.chatModels.groups = incoming.chatModels.groups
  if (incoming?.allow) next.allow = { ...current.allow, ...incoming.allow }
  return normalize(next)
}
