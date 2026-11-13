// 「只听主人的」偷表情模式：别人发的表情不提示她、她也不能自己收；主人发话才收
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-owner-sticker-'))
process.env.AURABOT_DATA_DIR = dataDir
process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
mkdirSync(dataDir, { recursive: true })

const OWNER = '10000001'
const BOT = '20000002'
const GROUP = 999999
const MEMBER = '10000002'
const LIB = join(dataDir, 'stickers', 'index.json')

writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
  enabled: true, dryRun: true, setupDone: true, botQQ: BOT, ownerQQ: OWNER,
  allow: { private: [], groups: [String(GROUP)] },
  snowluma: { autoStart: false, autoAttach: false, dir: join(dataDir, 'none') },
  voice: { enabled: false }, merge: { enabled: false },
  stickers: { enabled: true, collect: true, collectMode: 'owner', caption: false, autoChance: 0, maxSide: 1600 },
}))

const png = (salt) => {
  const b = Buffer.alloc(96)
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47; b[7] = 0x0a
  b.writeUInt32BE(200, 16); b.writeUInt32BE(200, 20)
  b[40] = salt
  return b
}

const { createFakeDsh } = await import(`file:///${REPO}/test/helpers/fake-dsh.js`)
// 只要有人说「收下」，她就尝试收第 1 张（用来验证 owner 模式的拦截）
const fake = createFakeDsh({
  brain: async ({ text, callTool }) => {
    if (String(text).includes('收下')) {
      const r = await callTool('qq_collect_sticker', { index: 1, name: '试试' })
      return '结果：' + (r && (r.message || r.ok))
    }
    return '嗯'
  },
})
const host = await import(`file:///${REPO}/src/host.js`)
const api = host.apply(fake.ctx)
await api.ready
await new Promise((r) => setTimeout(r, 400))

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const library = () => (existsSync(LIB) ? JSON.parse(readFileSync(LIB, 'utf8')).items || [] : [])

const send = async ({ from, member = false, salt, text = '看看这张' }) => {
  await api.hub.onMessage({
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    self_id: Number(BOT), group_id: GROUP, user_id: Number(from),
    time: Math.floor(Date.now() / 1000), message_id: Math.floor(Math.random() * 1e6),
    message: [
      { type: 'at', data: { qq: String(BOT) } },
      { type: 'text', data: { text } },
      { type: 'image', data: { sub_type: 1, file: 'base64://' + png(salt).toString('base64') } },
    ],
    sender: { user_id: Number(from), nickname: member ? '群友' : '主人', card: member ? '群友' : '主人', role: member ? 'member' : 'owner' },
  })
  await wait(2500)
}

test('别人发的表情：不提示她可以收', async () => {
  const before = fake.turns.length
  await send({ from: MEMBER, member: true, salt: 11 })
  const t = fake.turns.slice(before).at(-1)
  assert.ok(t, '群里被 @ 应该走一轮')
  assert.doesNotMatch(String(t.userText), /qq_collect_sticker/, '只听主人的模式，别人发的表情不给提示')
})

test('别人在场时她不能自己收（工具被拦）', async () => {
  const before = fake.turns.length
  await send({ from: MEMBER, member: true, salt: 12, text: '收下这张' })
  const t = fake.turns.slice(before).at(-1)
  const call = t.toolCalls.find((c) => c.name === 'qq_collect_sticker')
  assert.ok(call, '她确实尝试收了')
  assert.equal(call.result.ok, false, '应该被拦下来')
  assert.match(String(call.result.message), /只听主人的/)
  assert.equal(library().length, 0, '库里不该多东西')
})

test('主人发话就能收，而且会给她提示', async () => {
  const before = fake.turns.length
  await send({ from: OWNER, salt: 13, text: '收下这张' })
  const t = fake.turns.slice(before).at(-1)
  assert.match(String(t.userText), /qq_collect_sticker/, '主人发的表情要提示她')
  const call = t.toolCalls.find((c) => c.name === 'qq_collect_sticker')
  assert.ok(call)
  assert.equal(call.result.ok, true, JSON.stringify(call.result))
  assert.equal(library().length, 1, '应该收进库里了')
})

test('切回「她挑」后又不拦了（owner 模式才有这道闸）', async () => {
  api.setConfig({ ...api.getConfig(), stickers: { ...api.getConfig().stickers, collectMode: 'ask' } })
  const before = fake.turns.length
  await send({ from: MEMBER, member: true, salt: 14, text: '收下这张' })
  const t = fake.turns.slice(before).at(-1)
  const call = t.toolCalls.find((c) => c.name === 'qq_collect_sticker')
  assert.equal(call.result.ok, true, '「她挑」模式下别人发的也能收')
  assert.equal(library().length, 2)
})

test('配置归一化：owner 是合法值，乱写回落 auto（保持原行为）', async () => {
  const { normalize } = await import('../src/core/config.js')
  assert.equal(normalize({ stickers: { collectMode: 'owner' } }).stickers.collectMode, 'owner')
  assert.equal(normalize({ stickers: { collectMode: 'ask' } }).stickers.collectMode, 'ask')
  assert.equal(normalize({ stickers: { collectMode: 'auto' } }).stickers.collectMode, 'auto')
  assert.equal(normalize({ stickers: { collectMode: '乱写' } }).stickers.collectMode, 'auto')
})

after(() => fake.dispose())
