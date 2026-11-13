// 「只是笑一下」不再接 + 小黄脸限量：假 DSH 宿主 + 假 QQ 网关跑真实链路。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { memoryPromptRanges } from '../src/security/leak-guard.js'

const OWNER = '10000001'
const MOM = '10000003'
const BOT = '20000002'
const FAMILY = '600'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 8000) {
  const t = Date.now()
  while (Date.now() - t < ms) {
    const v = await fn()
    if (v) return v
    await sleep(50)
  }
  throw new Error('等不到条件成立')
}

async function brain({ text }) {
  for (const range of memoryPromptRanges(text).sort((a, b) => b.start - a.start)) text = text.slice(0, range.start) + text.slice(range.end)
  // 群聊提示里带着「之前在聊」，只看新说的那一段
  if (text.includes('刚才新说的')) text = text.slice(text.indexOf('刚才新说的'))
  if (text.includes('讲个笑话')) return '从前有条鱼 它游着游着就胖了'
  if (text.includes('周末干嘛')) return '还没想好 你想去哪'
  if (text.includes('带脸')) return '第' + (text.match(/带脸(\d)/)?.[1] || '') + '句<face:呲牙> 后半句<face:微笑>'
  return '收到'
}

let mock, fake, dataDir
before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-laugh-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  mock = await startMockOneBot({ selfId: BOT })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: false,
    setupDone: true,
    botQQ: BOT,
    ownerQQ: OWNER,
    coOwners: [{ qq: MOM, name: '妈妈' }],
    familyGroups: [FAMILY],
    allow: { private: [OWNER, MOM], groups: [FAMILY] },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dataDir, 'no-snowluma') },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
    group: { interjectChance: 0, burstMax: 50 },
    merge: { waitSec: 0.3, maxSec: 2, groupWaitSec: 0.3, groupMaxSec: 2 },
  }))
  fake = createFakeDsh({ brain })
  const host = await import('../src/host.js')
  host.apply(fake.ctx)
  await fake.call('/onebot/reconnect')
  await until(() => mock.connected() > 0, 20000)
})

after(async () => {
  fake?.dispose()
  await mock?.close()
  setTimeout(() => process.exit(0), 200).unref()
})

const base = (t) => ({ message_id: Math.floor(Math.random() * 1e6), raw_message: t, self_id: Number(BOT), time: Math.floor(Date.now() / 1000), post_type: 'message' })
const priv = (user_id, t) => ({ ...base(t), message_type: 'private', sub_type: 'friend', user_id: Number(user_id), sender: { user_id: Number(user_id), nickname: '爸爸' }, message: [{ type: 'text', data: { text: t } }] })
const grp = (user_id, t, nick) => ({ ...base(t), message_type: 'group', sub_type: 'normal', group_id: Number(FAMILY), user_id: Number(user_id), sender: { user_id: Number(user_id), nickname: nick, card: nick }, message: [{ type: 'text', data: { text: t } }] })
const sentGroup = () => mock.calls.filter((c) => c.action === 'send_group_msg' && String(c.params.group_id) === FAMILY)
const sentPrivate = () => mock.calls.filter((c) => c.action === 'send_private_msg' && String(c.params.user_id) === OWNER)
const faceCount = (call) => (Array.isArray(call.params.message) ? call.params.message : []).filter((seg) => seg.type === 'face').length

test('家庭群：她刚说完，爸爸只回「哈哈哈」「666」：不再调模型；有内容的话照常回', async () => {
  mock.push(grp(OWNER, '讲个笑话', '爸爸'))
  await until(() => sentGroup().some((c) => JSON.stringify(c.params.message).includes('胖了')))
  await sleep(300)
  const before = fake.turns.length
  mock.push(grp(OWNER, '哈哈哈', '爸爸'))
  mock.push(grp(OWNER, '666', '爸爸'))
  await sleep(1800)
  assert.equal(fake.turns.length, before, '只是笑一下不再开一轮')
  mock.push(grp(MOM, '。', '妈妈'))
  await until(() => fake.turns.length > before)
  assert.match(fake.turns.at(-1).userText, /哈哈哈/, '没回的那两句下一轮还能看到')
})

test('她上一轮在提问时，「好」「哈哈」照常交给她', async () => {
  mock.push(grp(OWNER, '周末干嘛', '爸爸'))
  await until(() => sentGroup().some((c) => JSON.stringify(c.params.message).includes('你想去哪')))
  await sleep(300)
  const before = fake.turns.length
  mock.push(grp(OWNER, '哈哈', '爸爸'))
  await until(() => fake.turns.length > before)
})

test('小黄脸：她写了就照发；连着三轮都带，下一轮轻轻提醒一句', async () => {
  const start = sentPrivate().length
  for (const n of [1, 2, 3]) {
    mock.push(priv(OWNER, '带脸' + n))
    await until(() => sentPrivate().slice(start).some((c) => JSON.stringify(c.params.message).includes('第' + n + '句')))
    await sleep(300)
  }
  const sent = sentPrivate().slice(start)
  const of = (n) => sent.filter((c) => JSON.stringify(c.params.message).includes('第' + n + '句'))
  for (const n of [1, 2, 3]) assert.equal(of(n).reduce((sum, c) => sum + faceCount(c), 0), 2, `第${n}轮写了两个就发两个，不删`)
  const before = fake.turns.length
  mock.push(priv(OWNER, '你周末干嘛'))
  await until(() => fake.turns.length > before)
  assert.match(fake.turns.at(-1).userText, /你最近几条回复都带了小黄脸，这次可以不带/)
})
