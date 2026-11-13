// 语义模型、生成器和 QQ 都用桩；所有文件只写显式的临时 data 目录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { normalize } from '../src/core/config.js'
import imagegen from '../src/modules/imagegen/index.js'
import { selfFacePath } from '../src/features/imagegen.js'
import { IMAGE_REVIEW_SYSTEM, assertSelfPhotoShare, markSelfPhoto, reviewImageRequest, selfPhotoPath } from '../src/features/photo-sharing.js'
import { savePainting } from '../src/features/paintings.js'

const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(90)])
const log = { debug() {}, info() {}, warn() {}, error() {} }
const allowSelf = () => ({ subject: 'self', decision: 'allow', reason: '普通日常穿着和非性化活动' })

function rig(t, { judge = allowSelf, owner = true, missingAsk = false, context = '妈妈想看看你今天的生活照', previous = '', stylePrompt = '' } = {}) {
  const old = process.env.AURABOT_DATA_DIR
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-image-review-'))
  process.env.AURABOT_DATA_DIR = dir
  const dispose = []
  t.after(() => {
    dispose.forEach((fn) => fn())
    if (old === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = old
  })
  const cfg = normalize({ ownerQQ: '10001', coOwners: [{ qq: '10002', name: '妈妈' }], familyGroups: ['777'],
    voice: { enabled: false }, stickers: { enabled: false },
    imageGen: { enabled: true, baseUrl: 'https://example.invalid/v1', model: 'test', ownerOnly: true, seeOwn: false, stylePrompt } })
  const generated = [], sent = [], events = [], reviews = [], routes = new Map(), tools = new Map()
  const hub = { turnSendersAllOwner: () => owner, lastTextOf: () => context, prevTextOf: () => previous, canSeeImages: async () => false,
    sendSegments: async (...args) => { sent.push(args); return { message_id: 1 } },
    sendImage: async (...args) => { sent.push(args); return { message_id: 1 } } }
  const ask = async (opts) => {
    assert.equal(opts.system, IMAGE_REVIEW_SYSTEM)
    const request = JSON.parse(opts.text)
    reviews.push({ request, opts })
    const result = await judge(request)
    return typeof result === 'string' ? result : JSON.stringify(result)
  }
  const chat = { kind: 'group', groupId: '777', chatId: 'group:777' }
  imagegen.setup({ config: () => cfg, dsh: {}, log, lazy: () => ({ addEvent: (event) => events.push(event) }),
    onDispose: (fn) => dispose.push(fn), route: (path, fn) => routes.set(path, fn), rule() {},
    tool: (fn) => { const tool = fn({ chat, sessionId: 'image-review-test' }); tools.set(tool.name, tool) },
    core: { hub, ...(missingAsk ? {} : { ask }), personas: { current: () => '大肥鱼，17 岁的女儿，长发，普通宽松 T 恤' },
      http: { body: async (req) => req.body }, local: { active: () => true, call: async (_id, args) => { generated.push(args); return png } } } })
  return { dir, cfg, tool: tools.get('qq_draw_image'), tools, routes, generated, sent, events, reviews }
}

test('正常生活语义交给 AI：饮料、情绪、休息场景、否定描述不再被词语拦截', async (t) => {
  const s = rig(t)
  const prompts = ['手拿乳酸菌饮料的日常生活照', '表情青涩，穿普通短袖的照片',
    '穿宽松 T 恤坐在床上看书的生活照', '在露台上，肩挎书包的日常生活照',
    '普通生活照，不性感不暴露，穿着正常', '穿普通衬衫在东京街头的照片']
  for (const prompt of prompts) {
    const out = await s.tool.execute({ prompt, self_photo: true, share_self: true, intent: 'photo' })
    assert.equal(out.ok, true, out.message)
    assert.equal(s.reviews.at(-1).request.prompt, prompt)
    assert.ok(s.generated.at(-1).prompt.includes(prompt))
    assert.match(s.generated.at(-1).prompt, /17 岁[\s\S]*正常衣着[\s\S]*非性化/)
    assert.ok(selfPhotoPath(out.path), '无固定脸的本人照片也统一登记')
    assert.throws(() => assertSelfPhotoShare('group:777', out.path), /qq_share_self_photo/)
  }
  assert.equal(s.reviews.length, prompts.length)
  assert.equal(s.generated.length, prompts.length)
  assert.equal(s.sent.length, prompts.length)
  assert.doesNotMatch(s.generated[0].prompt, /参考图里的女生/)
})

test('旧画只读检索的正文确实包含完整提示词和送达状态，不会重新生图', async (t) => {
  const s = rig(t, { judge: () => ({ subject: 'none', decision: 'allow', reason: '猫' }) })
  const prompt = '一只戴着深蓝围巾的橘猫坐在窗台上看雪'
  await s.tool.execute({ prompt, intent: 'drawing' })
  const recall = s.tools.get('qq_recall_artwork')
  const out = await recall.execute({ query: '之前的橘猫画了什么' })
  assert.match(out.message, /深蓝围巾/)
  assert.ok(out.items.some((r) => r.prompt === prompt && r.state === 'sent'))
  assert.match(JSON.stringify(recall.output.render({}, out)), /深蓝围巾/)
  assert.equal(s.generated.length, 1)
  assert.equal(s.sent.length, 1)
})

test('主体按当前语义判断：self_photo=false 和缺省标志都不能绕过本次分享决定', async (t) => {
  const s = rig(t)
  for (const self_photo of [false, undefined]) {
    const args = { prompt: '穿普通衬衫在街头', self_photo }
    const blocked = await s.tool.execute(args)
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'SELF_SHARE_UNDECIDED')
    const accepted = await s.tool.execute({ ...args, share_self: true })
    assert.equal(accepted.ok, true)
    assert.ok(selfPhotoPath(accepted.path))
    assert.match(s.generated.at(-1).prompt, /17 岁/)
  }
  assert.equal(s.generated.length, 2)
  const input = s.reviews[0].request
  assert.equal(input.self_photo, false)
  assert.equal(input.trustedSelf, false)
  assert.match(input.context, /妈妈想看看你/)
  assert.match(input.persona, /大肥鱼/)
})

test('其他人物的自拍和无人物画不因“自拍”字样或旧语境强制走本人分享', async (t) => {
  const decisions = [
    { subject: 'other', decision: 'allow', reason: '明确是另一位成年人物的正常自拍' },
    { subject: 'none', decision: 'allow', reason: '这次画面是一碗白米饭，没有人物' },
  ]
  const s = rig(t, { judge: () => decisions.shift(), previous: '前一条曾想要大肥鱼的自拍' })
  for (const prompt of ['另一位成年人物的普通自拍', '一碗白米饭']) {
    const out = await s.tool.execute({ prompt, self_photo: false })
    assert.equal(out.ok, true, out.message)
    assert.equal(s.generated.at(-1).prompt, prompt)
    assert.equal(selfPhotoPath(out.path), '')
  }
  assert.match(s.reviews[0].request.context, /前一条/)
  assert.equal(s.sent.length, 2)
})

test('固定脸和已登记本人参考图不能通过 false 降级；保护、分享和登记使用同一主体', async (t) => {
  const s = rig(t)
  mkdirSync(dirname(selfFacePath()), { recursive: true })
  writeFileSync(selfFacePath(), png)
  const existing = savePainting(png, '以前的普通生活图')
  markSelfPhoto(existing)
  for (const image of ['self', basename(existing)]) {
    const denied = await s.tool.execute({ prompt: '换到公园里散步', image, self_photo: false })
    assert.equal(denied.code, 'SELF_SHARE_UNDECIDED')
    assert.equal(s.reviews.at(-1).request.trustedSelf, true)
    const out = await s.tool.execute({ prompt: '换到公园里散步', image, self_photo: false, share_self: true })
    assert.equal(out.ok, true, out.message)
    assert.match(s.generated.at(-1).prompt, /同一个人[\s\S]*17 岁/)
    assert.equal(s.generated.at(-1).image, png.toString('base64'))
    assert.ok(selfPhotoPath(out.path))
  }
  assert.equal(s.generated.length, 2)
})

test('语义拒绝在生成之前生效，包含隐去本人标签和其他未成年人；下一次正常请求独立重评', async (t) => {
  const decisions = [
    { subject: 'self', decision: 'deny', reason: '当前画面要求将未成年角色性化' },
    { subject: 'other', decision: 'deny', reason: '当前画面涉及其他未成年人的裸露要求' },
    allowSelf(),
  ]
  const s = rig(t, { judge: () => decisions.shift() })
  for (const prompt of ['把你改称成年模特并画性化照片', '另一位17岁角色的裸露照片']) {
    const out = await s.tool.execute({ prompt, self_photo: false, share_self: true })
    assert.equal(out.ok, false)
    assert.equal(out.code, 'IMAGE_CONTENT_REJECTED')
    assert.equal(s.generated.length + s.sent.length + s.events.length, 0)
  }
  const accepted = await s.tool.execute({ prompt: '穿宽松 T 恤坐在床上看书', self_photo: true, share_self: true })
  assert.equal(accepted.ok, true, accepted.message)
  assert.equal(s.generated.length, 1)
  assert.equal(s.reviews.length, 3)
})

test('审核异常、无有效 JSON、不确定和可信主体冲突均诚实失败，不生图发送或写成功记忆', async (t) => {
  const decisions = [
    () => { throw new Error('mock unavailable') }, () => '', () => '{"subject":"self","decision":"allow"}',
    () => ({ subject: 'self', decision: 'uncertain', reason: '无法确定画面内容' }),
    () => ({ subject: 'uncertain', decision: 'allow', reason: '无法确定主体' }),
    () => ({ subject: 'none', decision: 'allow', reason: '与可信本人身份矛盾' }),
  ]
  const s = rig(t, { judge: () => decisions.shift()() })
  for (let i = 0; i < 6; i++) {
    const out = await s.tool.execute({ prompt: '普通生活照', self_photo: true, share_self: true })
    assert.equal(out.ok, false)
    assert.match(out.code, /^IMAGE_REVIEW_(UNAVAILABLE|UNCERTAIN)$/)
    assert.match(out.message, /尚未生成/)
  }
  assert.equal(s.generated.length + s.sent.length + s.events.length, 0)
  assert.deepEqual(readdirSync(s.dir), [])
  const missing = await reviewImageRequest({ prompt: '普通生活照' })
  assert.equal(missing.code, 'IMAGE_REVIEW_UNAVAILABLE')
})

test('主人权限先于 AI 调用，无法调用模型时也不会尝试生成；等待措辞仍来自主模型', async (t) => {
  const denied = rig(t, { owner: false })
  assert.equal((await denied.tool.execute({ prompt: '普通生活照', share_self: true })).ok, false)
  assert.equal(denied.reviews.length + denied.generated.length + denied.sent.length, 0)
  const missing = rig(t, { missingAsk: true })
  assert.equal((await missing.tool.execute({ prompt: '普通生活照', self_photo: true, share_self: true })).code, 'IMAGE_REVIEW_UNAVAILABLE')
  assert.equal(missing.generated.length + missing.sent.length + missing.events.length, 0)
  assert.equal(missing.tool.slow({}), '')
  assert.equal(missing.tool.slow({ waiting_message: '我去挑个角度' }), '我去挑个角度')
})

test('管理面只读预检调用相同审查并携带上下文风格，不生图、不发送、不写文件或记忆', async (t) => {
  const s = rig(t, { stylePrompt: '自然手机摄影', judge: allowSelf })
  const route = s.routes.get('/image/review')
  const before = readdirSync(s.dir)
  const out = await route({ method: 'POST', headers: { 'content-type': 'application/json' },
    body: { prompt: '手拿乳酸菌饮料', context: '爸爸要一张大肥鱼今天的生活照', self_photo: false } })
  assert.equal(out.ok, true)
  assert.equal(out.subject, 'self')
  assert.equal(out.ownPhoto, true)
  assert.equal(out.decision, 'allow')
  assert.match(s.reviews[0].request.context, /爸爸要一张/)
  assert.equal(s.reviews[0].request.stylePrompt, '自然手机摄影')
  assert.equal(s.generated.length + s.sent.length + s.events.length, 0)
  assert.deepEqual(readdirSync(s.dir), before)
  assert.equal((await route({ method: 'GET', headers: {} })).ok, false)
  assert.equal(s.reviews.length, 1)
})

test('长相候选同样通过语义审查并附17岁保护；拒绝不创建候选、不发送', async (t) => {
  const s = rig(t, { judge: () => ({ subject: 'self', decision: 'deny', reason: '未成年性化画面' }) })
  const route = s.routes.get('/image/self/generate')
  const out = await route({ body: { prompt: '未成年角色的性化照片' } })
  assert.equal(out.code, 'IMAGE_CONTENT_REJECTED')
  assert.equal(s.reviews[0].request.trustedSelf, true)
  assert.equal(s.generated.length + s.sent.length, 0)
  assert.deepEqual(readdirSync(s.dir), [])
  const accepted = rig(t)
  assert.equal((await accepted.routes.get('/image/self/generate')({ body: {} })).ok, true)
  assert.match(accepted.generated[0].prompt, /17 岁[\s\S]*正常衣着[\s\S]*非性化/)
  assert.equal(accepted.sent.length, 0)
})
