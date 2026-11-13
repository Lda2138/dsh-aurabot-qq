// 「她挑」模式：只把表情递给她，喜欢才收；「全都偷」模式仍然看到就收。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-pick-'))
process.env.AURABOT_DATA_DIR = dataDir
process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
mkdirSync(dataDir, { recursive: true })

const OWNER = '10000001'
const BOT = '20000002'
const LIB = join(dataDir, 'stickers', 'index.json')
writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
  enabled: true, dryRun: true, setupDone: true, botQQ: BOT, ownerQQ: OWNER,
  allow: { private: [], groups: [] },
  snowluma: { autoStart: false, autoAttach: false, dir: join(dataDir, 'none') },
  voice: { enabled: false }, merge: { enabled: false },
  stickers: { enabled: true, collect: true, collectMode: 'ask', caption: false, autoChance: 0, maxSide: 1600 },
}))

// 两张不同的「表情」（PNG 头 + 不同内容，保证 md5 不同）
const png = (salt, w = 200, h = 200) => {
  const b = Buffer.alloc(96)
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47; b[7] = 0x0a
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20)
  b[40] = salt
  return b
}

const { createFakeDsh } = await import(`file:///${REPO}/test/helpers/fake-dsh.js`)
// 只有消息里写了「收下吧收下」她才去收 —— 模拟"喜欢才收"
const fake = createFakeDsh({
  brain: async ({ text, callTool }) => {
    if (text.includes('收下吧收下')) {
      const r = await callTool('qq_collect_sticker', { index: 1, name: '偷偷笑' })
      return '收好了：' + (r && r.message)
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
const send = async (text, buf) => {
  await api.hub.onMessage({
    post_type: 'message', message_type: 'private', sub_type: 'friend',
    self_id: Number(BOT), user_id: Number(OWNER), time: Math.floor(Date.now() / 1000),
    message_id: Math.floor(Math.random() * 1e6),
    message: [
      { type: 'text', data: { text } },
      { type: 'image', data: { sub_type: 1, file: 'base64://' + buf.toString('base64') } },
    ],
    sender: { user_id: Number(OWNER), nickname: '主人' },
  })
  await wait(1500)
}

test('她挑：没让她收就不收，但会收到提示', async () => {
  await send('随便聊聊', png(1))
  const t = fake.turns.at(-1)
  assert.match(String(t.userText), /qq_collect_sticker/, '应该给她一句"喜欢就收"的提示')
  assert.equal(library().length, 0, '她没说要收，库里应该还是空的')
  // 表情暂存要落盘：只在内存里的话，DSH 一重启她就收不了了（真实踩过）
  const stashFile = join(dataDir, 'sticker-stash.json')
  assert.ok(existsSync(stashFile), 'sticker-stash.json 应该写出来')
  const stash = JSON.parse(readFileSync(stashFile, 'utf8'))
  assert.ok(stash['private:10000001']?.segs?.length, '暂存里应该有这个聊天的表情')
})

test('她挑：她调了工具才真的收下，而且名字是她给的', async () => {
  await send('收下吧收下', png(2))
  const t = fake.turns.at(-1)
  const call = t.toolCalls.find((c) => c.name === 'qq_collect_sticker')
  assert.ok(call, '应该调用了 qq_collect_sticker')
  assert.equal(call.result.ok, true, JSON.stringify(call.result))
  const items = library()
  assert.equal(items.length, 1, '库里应该多了一张')
  assert.equal(items[0].name, '偷偷笑', '名字应该是她给的')
})

test('全都偷：不用她同意，看到就收（也不给她提示）', async () => {
  api.setConfig({ ...api.getConfig(), stickers: { ...api.getConfig().stickers, collectMode: 'auto' } })
  await send('这张图好好笑', png(3))
  await wait(600)
  assert.equal(library().length, 2, 'auto 模式应该自动收下')
  assert.doesNotMatch(String(fake.turns.at(-1).userText), /qq_collect_sticker/, 'auto 模式不该再给提示')
})

test('拿不到了：没这张编号时给个说法，不报错', async () => {
  const r = await api.hub.stickerOf !== undefined
  assert.ok(typeof api.hub.stickerOf === 'function', 'hub 应该导出 stickerOf')
  assert.equal(api.hub.stickerOf('private:10000001', 9), null, '没有第 9 张')
})

test('群里也收得到「她挑」的提示（以前群聊那条路会把它丢掉）', async () => {
  // 上一条用例把模式切成了 auto，这里切回「她挑」
  const cur = api.getConfig()
  api.setConfig({ ...cur, allow: { ...cur.allow, groups: ['999999'] }, stickers: { ...cur.stickers, collectMode: 'ask' } })
  const before = fake.turns.length
  await api.hub.onMessage({
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    self_id: Number(BOT), group_id: 999999, user_id: 10000002, time: Math.floor(Date.now() / 1000),
    message_id: Math.floor(Math.random() * 1e6),
    message: [
      { type: 'at', data: { qq: String(BOT) } },
      { type: 'text', data: { text: '看这张' } },
      { type: 'image', data: { sub_type: 1, file: 'base64://' + png(4).toString('base64') } },
    ],
    sender: { user_id: 10000002, nickname: '群友', card: '群友', role: 'member' },
  })
  await wait(2500)
  const fresh = fake.turns.slice(before)
  assert.ok(fresh.length >= 1, '群里 @ 她应该走一轮')
  const t = fresh.at(-1)
  assert.match(String(t.userText), /qq_collect_sticker/, '群里也该告诉她可以收表情')
  assert.match(String(t.userText), /你自己的小爱好/, '措辞要是她自己的念头，不是发图的人在提醒')
  assert.equal(library().length, 2, '只是提示，她没说要收，库里不该多')
})

test('4:3 的表情收得下（以前会被「尺寸不像表情」误拦）', async () => {
  await send('收下吧收下', png(5, 310, 224))
  const t = fake.turns.at(-1)
  const call = t.toolCalls.find((c) => c.name === 'qq_collect_sticker')
  assert.ok(call, '应该调用了 qq_collect_sticker')
  assert.equal(call.result.ok, true, '310x224 是 QQ 最常见的一档，不能挡：' + JSON.stringify(call.result))
  assert.ok(!/尺寸不像表情/.test(String(call.result.message || '')), '不该再报尺寸问题')
})

after(() => fake.dispose())
