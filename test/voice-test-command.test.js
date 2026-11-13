// QQ 里的 /语音测试：主人发指令后，用当前引擎（这里是豆包，假的接口）连发几条测试语音，每条前面一行说明。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001', BOT = '20000002', GUEST = '10000009'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 10000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(50) } throw new Error('等不到条件成立') }

let mock, fake, realFetch, dataDir, imgSrv, imgCalls = 0
const ttsCalls = []
before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-voicetest-'))
  dataDir = dir
  const http = await import('node:http')
  imgSrv = http.createServer(async (req, res) => { for await (const c of req) void c; imgCalls++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64') }] })) })
  await new Promise((r) => imgSrv.listen(0, '127.0.0.1', r))
  process.env.AURABOT_DATA_DIR = dir
  process.env.AURABOT_WORKSPACE = join(dir, 'ws')
  mkdirSync(join(dir, 'ws'), { recursive: true })
  mock = await startMockOneBot({ selfId: BOT })
  realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://openspeech.bytedance.com/')) {
      const body = JSON.parse(init.body)
      ttsCalls.push(body)
      if (body.req_params.text.includes('失败')) return new Response(JSON.stringify({ code: 45000000, message: 'denied' }))
      return new Response(JSON.stringify({ code: 0, data: Buffer.alloc(9600, 3).toString('base64') }) + '\n' + JSON.stringify({ code: 20000000, message: 'ok' }))
    }
    return realFetch(url, init)
  }
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    enabled: true, dryRun: false, setupDone: true, botQQ: BOT, ownerQQ: OWNER,
    allow: { private: [OWNER, GUEST], groups: [] },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dir, 'no-snowluma') },
    voice: { engine: 'doubao', autoChance: 0, leadingSilenceMs: 0, doubao: { apiKey: 'k', speaker: 'zh_female_test_uranus_bigtts' } },
    merge: { waitSec: 0.2, maxSec: 1 },
    imageGen: { enabled: true, baseUrl: `http://127.0.0.1:${imgSrv.address().port}/v1`, model: 'test-model', apiKey: 'mock-key' },
  }))
  fake = createFakeDsh({ brain: async () => '嗯' })
  const host = await import('../src/host.js')
  host.apply(fake.ctx)
  await fake.call('/onebot/reconnect')
  await until(() => mock.connected() > 0, 20000)
})
after(async () => { imgSrv?.close(); globalThis.fetch = realFetch; fake?.dispose(); await mock?.close(); setTimeout(() => process.exit(0), 200).unref() })

const priv = (uid, t) => ({ message_type: 'private', sub_type: 'friend', user_id: Number(uid), message_id: Math.floor(Math.random() * 1e6), sender: { user_id: Number(uid), nickname: 'x' }, message: [{ type: 'text', data: { text: t } }], raw_message: t, self_id: Number(BOT), time: Math.floor(Date.now() / 1000), post_type: 'message' })
const sentTo = (uid) => mock.calls.filter((c) => c.action === 'send_private_msg' && String(c.params.user_id) === uid)
const texts = (uid) => sentTo(uid).flatMap((c) => c.params.message.filter((s) => s.type === 'text').map((s) => s.data.text))
const logged = () => existsSync(join(dataDir, 'chatlog')) ? readdirSync(join(dataDir, 'chatlog')).map((f) => readFileSync(join(dataDir, 'chatlog', f), 'utf8')).join('\n') : ''
const images = (uid) => sentTo(uid).filter((c) => c.params.message.some((s) => s.type === 'image'))
const records = (uid) => sentTo(uid).filter((c) => c.params.message.some((s) => s.type === 'record'))

test('主人发 /语音测试：回一句口语，连发 5 条语音（不插说明行），最后一句说清各条语气；语气变成语音指令', async () => {
  mock.push(priv(OWNER, '/语音测试'))
  await until(() => texts(OWNER).some((t) => t.startsWith('这几条的语气依次是')), 20000)
  assert.equal(texts(OWNER)[0], '好，发几条语音给你听听')
  assert.equal(records(OWNER).length, 5)
  assert.equal(texts(OWNER).length, 2, '中间不插「1/5 …」这种说明')
  assert.equal(texts(OWNER).at(-1), '这几条的语气依次是：撒娇、无奈、兴奋、生气又心疼、委屈')
  assert.deepEqual(JSON.parse(ttsCalls[0].req_params.additions).context_texts, ['你能用笑着撒娇的语气来说话吗？'])
  assert.equal(fake.turns.length, 0, '测试指令不交给模型')
  const log = logged()
  for (const w of ['你怎么比妈妈还能念叨', '发几条语音给你听听', '这几条的语气依次是', '/语音测试']) assert.ok(!log.includes(w), `聊天流水里不该有：${w}`)
})

test('自定义一句：语气|文字；合成失败改发文字并说明', async () => {
  const before = records(OWNER).length
  mock.push(priv(OWNER, '/测语音 委屈|这句会失败'))
  await until(() => texts(OWNER).includes('这条没合成出来，改发了文字'), 15000)
  assert.equal(records(OWNER).length, before)
  assert.ok(texts(OWNER).includes('这句会失败'))
})

test('/图片测试：不带内容画固定日常图；带内容按你写的画；发出的图和话都不进聊天流水', async () => {
  const before = images(OWNER).length
  mock.push(priv(OWNER, '/图片测试'))
  await until(() => texts(OWNER).some((t) => /^画好了，用了 \d+ 秒$/.test(t)), 15000)
  assert.equal(images(OWNER).length, before + 1)
  assert.ok(texts(OWNER).includes('好，画一张给你看看'))
  mock.push(priv(OWNER, '/测图片 一碗冒热气的牛肉面'))
  await until(() => images(OWNER).length >= before + 2, 15000)
  assert.equal(imgCalls, 2)
  const log = logged()
  for (const w of ['图片测试', '画一张给你看看', '画好了', '牛肉面', '橘猫']) assert.ok(!log.includes(w), `聊天流水里不该有：${w}`)
  assert.equal(fake.turns.length, 0)
})

test('不是主人发的 /语音测试 不执行', async () => {
  const n = ttsCalls.length
  mock.push(priv(GUEST, '/语音测试'))
  await sleep(1500)
  assert.equal(ttsCalls.length, n)
  assert.ok(!texts(GUEST).some((t) => t.startsWith('开始语音测试')))
})
