// 漏看补回：电脑待机 / 网关收包卡住期间家里人说的话，事后从 QQ 历史里对出来，按「刚看到」交给她。
// 假 DSH 宿主 + 假 QQ 网关跑真实链路。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const DAD = '10000001'
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

let mock, fake, dataDir
before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-catchup-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  mock = await startMockOneBot({ selfId: BOT })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: false,
    setupDone: true,
    botQQ: BOT,
    ownerQQ: DAD,
    coOwners: [{ qq: MOM, name: '妈妈' }],
    familyGroups: [FAMILY],
    allow: { private: [DAD, MOM], groups: [FAMILY] },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dataDir, 'no-snowluma') },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
    group: { interjectChance: 0, burstMax: 50 },
    merge: { waitSec: 0.3, maxSec: 2, groupWaitSec: 0.3, groupMaxSec: 2 },
  }))
  // 一小时前就开始记录了（只是这段时间什么也没实时收到）
  const since = Date.now() - 3600_000
  writeFileSync(join(dataDir, 'catchup-state.json'), JSON.stringify({ chats: { [`group:${FAMILY}`]: { since, ids: [] }, [`private:${DAD}`]: { since, ids: [] }, [`private:${MOM}`]: { since, ids: [] } } }))
  fake = createFakeDsh({ brain: async () => '看到啦' })
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

let seq = 50000
const sec = (msAgo) => Math.floor((Date.now() - msAgo) / 1000)
const grp = (uid, nick, segs, msAgo, extra = {}) => ({ message_type: 'group', sub_type: 'normal', group_id: Number(FAMILY), user_id: Number(uid), message_id: ++seq, sender: { user_id: Number(uid), nickname: nick, card: nick }, message: segs, raw_message: '', self_id: Number(BOT), time: sec(msAgo), post_type: 'message', ...extra })
const priv = (uid, text, msAgo) => ({ message_type: 'private', sub_type: 'friend', user_id: Number(uid), message_id: ++seq, sender: { user_id: Number(uid), nickname: '爸爸' }, message: [{ type: 'text', data: { text } }], raw_message: text, self_id: Number(BOT), time: sec(msAgo), post_type: 'message' })
const txt = (text) => ({ type: 'text', data: { text } })
const groupSends = () => mock.calls.filter((c) => c.action === 'send_group_msg' && String(c.params.group_id) === FAMILY)
const catchUp = async () => (await fake.call('/chat/catch-up', {})).json()

test('待机期间家里人在群里说的话：按原时间补齐历史及后续对话，不冒充新发言；她可以补答', async () => {
  // 掉线前实时收到过一条
  const live = grp(DAD, '爸爸', [{ type: 'at', data: { qq: BOT } }, txt(' 早上好')], 0)
  mock.push(live)
  await until(() => fake.turns.some((t) => t.userText.includes('早上好')))
  await until(() => groupSends().length >= 1)
  const turnsBefore = fake.turns.length
  const sendsBefore = groupSends().length

  mock.state.history = [
    { ...live },
    grp(DAD, '爸爸', [txt('下课了')], 25 * 60_000),
    grp(DAD, '爸爸', [{ type: 'at', data: { qq: BOT } }, txt(' 还活着吗')], 24 * 60_000),
    grp(BOT, '大肥鱼', [txt('我自己说的话')], 23 * 60_000),
    grp(MOM, '妈妈', [txt('我嘞个妈妈')], 5 * 60_000),
    grp(DAD, '爸爸', [txt('/状态')], 4 * 60_000),
    grp(DAD, '爸爸', [txt('开始记录以前的老消息')], 2 * 3600_000),
    grp(MOM, '妈妈', [txt('刚刚才发的')], 5_000),
  ]
  const r = await catchUp()
  assert.equal(r.status, 'caught_up')
  assert.deepEqual(r.chats, [{ chatId: `group:${FAMILY}`, count: 3 }])

  await until(() => fake.turns.length > turnsBefore && fake.turns.slice(turnsBefore).some((t) => t.userText.includes('我嘞个妈妈')))
  const turn = fake.turns.slice(turnsBefore).find((t) => t.userText.includes('我嘞个妈妈'))
  assert.match(turn.userText, /补齐历史，按原时间排列/)
  assert.match(turn.userText, /下课了[\s\S]*还活着吗[\s\S]*我嘞个妈妈/, '按原来的先后')
  assert.match(turn.userText, /\d\d:\d\d，补齐的原消息\] 爸爸\(10000001\)：下课了/, '带原本发出的时间')
  const recovered = turn.userText.split('补齐历史，按原时间排列】')[1].split('【历史补齐结束】')[0]
  assert.ok(recovered.indexOf('我嘞个妈妈') < recovered.indexOf('早上好'), '补收以后已发生的真人对话照常带上')
  assert.doesNotMatch(recovered, /我自己说的话|\/状态|开始记录以前的老消息|刚刚才发的/)
  assert.doesNotMatch(turn.userText, /刚才新说的|其他家里话也顺着回应一下|都要回/)
  await until(() => groupSends().length > sendsBefore)

  // 流水里按原本的时间记
  const day = readdirSync(join(dataDir, 'chatlog')).sort().at(-1)
  const rows = readFileSync(join(dataDir, 'chatlog', day), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const mom = rows.find((x) => x.text === '我嘞个妈妈')
  assert.ok(mom && Math.abs(mom.t - Date.now() + 5 * 60_000) < 120_000, '妈妈那条按 5 分钟前记')
})

test('同一段不会补两次；网关事后再推同一条也跳过', async () => {
  await sleep(500)
  const before = fake.turns.length
  const again = await catchUp()
  assert.equal(again.status, 'nothing_missed')
  const dup = mock.state.history.find((m) => m.message[0]?.data?.text === '我嘞个妈妈')
  mock.push({ ...dup, time: Math.floor(Date.now() / 1000) })
  await sleep(1200)
  assert.equal(fake.turns.length, before)
})

test('主人私聊里漏掉的：带时间补齐历史，按后续对话判断是否需要补答', async () => {
  const before = fake.turns.length
  mock.state.history = [
    grp(DAD, '爸爸', [txt('群里的话不算私聊')], 3 * 60_000),
    priv(DAD, '在吗 问你个事', 3 * 60_000),
  ]
  const r = await catchUp()
  assert.deepEqual(r.chats, [{ chatId: `group:${FAMILY}`, count: 1 }, { chatId: `private:${DAD}`, count: 1 }], '群里那条归群聊，私聊只补私聊的')
  await until(() => fake.turns.slice(before).some((t) => t.userText.includes('【私聊】') && t.userText.includes('在吗 问你个事')))
  const turn = fake.turns.slice(before).find((t) => t.userText.includes('【私聊】') && t.userText.includes('在吗 问你个事'))
  assert.match(turn.userText, /（\d\d:\d\d 发的）：在吗 问你个事/)
  assert.match(turn.userText, /补齐的历史背景/)
  assert.doesNotMatch(turn.userText.split('【私聊】')[1], /群里的话不算私聊/, '群里那条不混进私聊')
})

test('家庭群更积极：她刚说完，家里人没 @ 也接着说，算在回她（必须接）', async () => {
  mock.state.history = []
  const before = fake.turns.length
  const sends = groupSends().length
  mock.push(grp(DAD, '爸爸', [{ type: 'at', data: { qq: BOT } }, txt(' 今天吃什么')], 0))
  await until(() => groupSends().length > sends)
  await sleep(500)
  mock.push(grp(MOM, '妈妈', [txt('你自己选呗')], 0))
  await until(() => fake.turns.slice(before).some((t) => t.userText.includes('你自己选呗')))
  const turn = fake.turns.slice(before).find((t) => t.userText.includes('你自己选呗'))
  assert.match(turn.userText, /家里人在叫你/)
  assert.doesNotMatch(turn.userText, /接不接你自己看着办/)
})

test('第一次见到的聊天只立起点：以前的记录不当成漏看', async () => {
  const { createCatchUp } = await import('../src/chat/catch-up.js')
  const calls = []
  const replayed = []
  const file = join(dataDir, 'catchup-unit.json')
  const c = createCatchUp({
    onebot: { call: async (action) => { calls.push(action); return { messages: [grp(DAD, '爸爸', [txt('很早的话')], 10 * 60_000)] } } },
    getConfig: () => ({ enabled: true, familyGroups: [FAMILY], ownerQQ: DAD, coOwners: [] }),
    log: { info() {}, debug() {}, warn() {} },
    replay: async (ev) => replayed.push(ev),
    selfId: () => BOT,
    file: () => file,
  })
  try {
    assert.equal((await c.run('t')).status, 'nothing_missed')
    assert.equal(calls.length, 0, '没起点时不去取历史')
    assert.equal((await c.run('t')).status, 'nothing_missed', '起点之后才算')
    assert.equal(replayed.length, 0)
    // 醒来后先实时进来一条新的，待机那段照样补得到
    c.seen(`group:${FAMILY}`, 'live-1', Date.now())
  } finally { c.dispose() }
  // 假装一小时前就开始记录了
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  saved.chats[`group:${FAMILY}`].since = Date.now() - 3600_000
  writeFileSync(file, JSON.stringify(saved))
  const c2 = createCatchUp({
    onebot: { call: async (action) => ({ messages: action === 'get_group_msg_history' ? [grp(MOM, '妈妈', [txt('待机时说的')], 10 * 60_000), { ...grp(DAD, '爸爸', [txt('醒来后实时收到的')], 0), message_id: 'live-1' }] : [] }) },
    getConfig: () => ({ enabled: true, familyGroups: [FAMILY], ownerQQ: DAD, coOwners: [] }),
    log: { info() {}, debug() {}, warn() {} },
    replay: async (ev) => replayed.push(ev),
    selfId: () => BOT,
    file: () => file,
    opts: { settleMs: 0 },
  })
  try {
    const r = await c2.run('t')
    assert.deepEqual(r.chats, [{ chatId: `group:${FAMILY}`, count: 1 }])
    assert.equal(replayed[0].message[0].data.text, '待机时说的')
    assert.ok(replayed[0].__late.at > 0)
  } finally { c2.dispose() }
})
