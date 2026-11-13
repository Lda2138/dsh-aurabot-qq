// 惦记标签真实链路：假 DSH 宿主 + 假 QQ 网关。标签不发出去、记进清单；主动轮叮嘱只留一句、最多两条。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

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
  if (text.includes('【主动联系')) return '在干嘛呢|||记得吃饭|||别忘了吃早饭|||多穿点'
  if (text.includes('去上课')) return '好 去吧<惦记 分钟后="90">问问课上得怎么样</惦记>'
  return '收到'
}

let mock, fake, dataDir
before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-care-e2e-'))
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

const priv = (user_id, t) => ({ message_id: Math.floor(Math.random() * 1e6), raw_message: t, self_id: Number(BOT), time: Math.floor(Date.now() / 1000), post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: Number(user_id), sender: { user_id: Number(user_id), nickname: '爸爸' }, message: [{ type: 'text', data: { text: t } }] })
const sentPrivate = () => mock.calls.filter((c) => c.action === 'send_private_msg' && String(c.params.user_id) === OWNER)
const body = (c) => JSON.stringify(c.params.message)

test('回复里的惦记标签不发出去，记进惦记清单', async () => {
  mock.push(priv(OWNER, '我去上课了'))
  await until(() => sentPrivate().some((c) => body(c).includes('去吧')))
  await sleep(300)
  assert.doesNotMatch(sentPrivate().map(body).join(''), /惦记|问问课上/)
  const file = join(dataDir, 'care-notes.json')
  assert.ok(existsSync(file))
  const notes = JSON.parse(readFileSync(file, 'utf8')).notes
  assert.equal(notes.length, 1)
  assert.equal(notes[0].text, '问问课上得怎么样')
  assert.equal(notes[0].chatId, `private:${OWNER}`)
  assert.ok(notes[0].dueAt - notes[0].at >= 89 * 60_000 && notes[0].dueAt - notes[0].at <= 91 * 60_000)
})

test('主动轮：不裁剪她写的话，叮嘱只在提示里引导「最多一句」', async () => {
  const before = sentPrivate().length
  const turns = fake.turns.length
  await fake.call('/speakup/fire', { method: 'POST' })
  await until(() => sentPrivate().slice(before).some((c) => body(c).includes('多穿点')), 20000)
  const said = sentPrivate().slice(before).map(body).join('\n')
  assert.match(said, /在干嘛呢[\s\S]*记得吃饭[\s\S]*别忘了吃早饭[\s\S]*多穿点/, '写了几条就发几条，不硬删')
  const prompt = fake.turns.slice(turns).find((t) => t.userText.includes('【主动联系'))
  assert.match(prompt.userText, /一两句[\s\S]*叮嘱[^。]*最多一句/)
})
