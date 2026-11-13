import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { normalize } from '../src/core/config.js'
import { isOwner } from '../src/chat/access.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import imagegen from '../src/modules/imagegen/index.js'
import { createHub } from '../src/chat/hub.js'
import { PHOTO_SHARING_RULE, assertSelfPhotoShare, markSelfPhoto, selfPhotoPath, withSelfPhotoShare } from '../src/features/photo-sharing.js'
import { savePainting } from '../src/features/paintings.js'

const DAD = '10001', MOM = '10002', FRIEND = '10003'
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(90)])
const log = { debug() {}, info() {}, warn() {}, error() {} }
function rig(t, { userId = DAD, ownerOnly = true, kind = 'private' } = {}) {
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-photo-choice-'))
  t.after(() => { if (old === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = old })
  const cfg = normalize({ ownerQQ: DAD, coOwners: [{ qq: MOM, name: '妈妈' }], familyGroups: ['777'],
    voice: { enabled: false }, stickers: { enabled: false },
    imageGen: { enabled: true, baseUrl: 'https://example.com/v1', model: 'test', ownerOnly, seeOwn: false } })
  const chat = { kind, userId, chatId: kind === 'private' ? `private:${userId}` : 'group:777', ...(kind === 'group' ? { groupId: '777' } : {}) }
  const tools = new Map(), rules = [], calls = [], sent = []
  const hub = { turnSendersAllOwner: () => isOwner(cfg, userId), canSeeImages: async () => false,
    sendSegments: async (...a) => { sent.push(a); return { message_id: 1 } },
    sendImage: async (id, file) => { assertSelfPhotoShare(id, file); sent.push({ id, file }); return { message_id: 1 } } }
  const ask = async ({ text }) => {
    const request = JSON.parse(text)
    const subject = request.trustedSelf || ['自拍', '自己的普通照片'].includes(request.prompt) ? 'self' : 'none'
    return JSON.stringify({ subject, decision: 'allow', reason: '测试语义模型：日常非性化画面' })
  }
  imagegen.setup({ config: () => cfg, lazy: () => ({}), dsh: {}, log, route() {}, rule: (r) => rules.push(r()),
    tool: (builder) => { const tool = builder({ chat, sessionId: 's' }); tools.set(tool.name, tool) },
    core: { ask, hub, local: { active: () => true, call: async (_id, args) => { calls.push(args); return png } } } })
  return { cfg, chat, tools, rules, calls, sent }
}

for (const userId of [DAD, MOM]) for (const kind of ['private', 'group']) test(`双主人地位相同：${userId} 在 ${kind} 愿意分享才生成`, async (t) => {
  const s = rig(t, { userId, kind }), draw = s.tools.get('qq_draw_image')
  assert.match(s.rules[0], /两位主人地位和权限相同/)
  const undecided = await draw.execute({ prompt: '一个日常角色人像', intent: 'photo', self_photo: true })
  assert.equal(undecided.ok, false)
  const declined = await draw.execute({ prompt: '自拍', self_photo: true, share_self: false })
  assert.equal(declined.ok, false)
  assert.equal(s.calls.length, 0)
  const accepted = await draw.execute({ prompt: '一个日常角色人像', intent: 'photo', self_photo: true, share_self: true })
  assert.equal(accepted.ok, true, accepted.message)
  assert.equal(s.calls.length, 1)
  assert.ok(selfPhotoPath(accepted.path))
  assert.equal(s.calls[0].share_self, undefined, '个人意愿不是生图提示词')
})

test('仅主人权限保留；开放后朋友也要经过自主分享决定，普通画图不需要自拍同意', async (t) => {
  const closed = rig(t, { userId: FRIEND })
  assert.equal((await closed.tools.get('qq_draw_image').execute({ prompt: '自拍', share_self: true })).ok, false)
  assert.equal(closed.calls.length, 0)
  const open = rig(t, { userId: FRIEND, ownerOnly: false })
  const draw = open.tools.get('qq_draw_image')
  assert.equal((await draw.execute({ prompt: '自拍' })).ok, false)
  assert.equal((await draw.execute({ prompt: '自拍', share_self: false })).ok, false)
  assert.equal((await draw.execute({ prompt: '自拍', self_photo: true, share_self: true })).ok, true)
  assert.equal((await draw.execute({ prompt: '普通的山水画', self_photo: false })).ok, true)
  assert.match(PHOTO_SHARING_RULE, /白名单只决定工具权限/)
  assert.match(PHOTO_SHARING_RULE, /全群都能看到/)
})

test('旧照片重发重新判断，明确同意只对当前目标生效；普通图片不被误拦', async (t) => {
  const s = rig(t), draw = s.tools.get('qq_draw_image'), share = s.tools.get('qq_share_self_photo')
  const out = await draw.execute({ prompt: '自己的普通照片', self_photo: true, share_self: true, intent: 'photo' })
  assert.equal(out.ok, true)
  const n = s.sent.length
  assert.equal((await share.execute({ image: '#1', share_self: false })).ok, false)
  assert.equal(s.sent.length, n)
  assert.throws(() => assertSelfPhotoShare(s.chat.chatId, out.path), /qq_share_self_photo/)
  assert.equal((await share.execute({ image: '#1', share_self: true })).ok, true)
  assert.equal(s.sent.length, n + 1)
  withSelfPhotoShare(s.chat.chatId, out.path, () => {
    assert.doesNotThrow(() => assertSelfPhotoShare(s.chat.chatId, pathToFileURL(out.path).href))
    assert.throws(() => assertSelfPhotoShare(`private:${MOM}`, out.path), /qq_share_self_photo/)
  })
  assert.throws(() => assertSelfPhotoShare(s.chat.chatId, out.path), /qq_share_self_photo/)
  const plain = savePainting(png, '普通猫咪', { now: new Date(Date.now() + 1000) })
  assert.doesNotThrow(() => assertSelfPhotoShare(s.chat.chatId, plain))
  const legacy = savePainting(png, '手机前置自拍风格的照片', { now: new Date(Date.now() + 2000) })
  assert.throws(() => assertSelfPhotoShare(s.chat.chatId, legacy), /qq_share_self_photo/)
})

test('真实发送出口：旧自拍不能经 Markdown、直接图片段或文件绕过；明确分享仍可发出', async (t) => {
  const s = rig(t)
  const fake = createFakeDsh({ brain: async () => '' }), calls = []
  const hub = createHub({ dsh: fake.ctx, getConfig: () => s.cfg, log, onebot: { connected: true, call: async (...a) => { calls.push(a); return { message_id: 1 } } } })
  t.after(() => { hub.dispose(); fake.dispose() })
  const file = savePainting(png, '日常人像')
  markSelfPhoto(file)
  await assert.rejects(hub.sendImage(s.chat.chatId, file), /qq_share_self_photo/)
  await assert.rejects(hub.sendFile(s.chat.chatId, file), /qq_share_self_photo/)
  await assert.rejects(hub.sendSegments(s.chat.chatId, [{ type: 'image', data: { file: pathToFileURL(file).href } }], '旧照片'), /qq_share_self_photo/)
  await assert.rejects(hub.deliver(s.chat.chatId, `![照片](${file})`), /qq_share_self_photo/)
  assert.equal(calls.length, 0)
  const result = await withSelfPhotoShare(s.chat.chatId, file, () => hub.capture(() => hub.sendImage(s.chat.chatId, file)))
  assert.equal(result.sent.length, 1)
  assert.deepEqual(readFileSync(file), png)
})
